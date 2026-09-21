/* kivo landing — "the weave" (live glowing health-signal threads)
 *
 * Vanilla port of the React Bits <WebThreads /> component (ogl renderer,
 * MIT). This repo is zero-build, so the React wrapper is gone and the
 * WebGL program lives here, driven by plain DOM + GSAP from main.js.
 *
 * API (window.KivoThreads):
 *   KivoThreads.init(stageEl)      → Promise<handle|null>   (null = degraded)
 *   KivoThreads.get()              → handle|null
 *   handle.setScroll(progress)     → 0..1, morphs the weave as the section scrubs
 *   handle.setMood(name)           → 'weave' | 'hba1c' | 'tsh' | 'ldl'
 *   handle.destroy()
 *
 * Degradation contract: any failure (no WebGL2, blocked vendor, shader
 * compile error) leaves a .weave--fallback class on the stage and resolves
 * with null — the page never traps behind it.
 */
(() => {
  'use strict';

  /* ---------- marker "rhythms" -----------------------------------------
   * Each mood is a poetic tempo for one of the twin's core markers:
   *   weave — the full picture: kivo's jade→gold, everything woven together
   *   hba1c — three-month average: slow, broad, unbroken
   *   tsh   — the thyroid paces everything: fast, tight, bright
   *   ldl   — the creeping lipids: warm amber drifting toward coral
   * Nothing here is a medical claim; the reference ranges shown in the UI
   * come from the live lab dictionary (see main.js), never from here.
   */
  const MOODS = {
    weave: { color1: '#16C795', color2: '#E3A93C', color3: '#FFFFFF', speed: 0.22, count: 7, frequency: 5.0, spread: 0.18, position: 0.55, brightness: 0.66 },
    hba1c: { color1: '#0FBF8F', color2: '#8FE8C8', color3: '#FFFFFF', speed: 0.10, count: 5, frequency: 3.2, spread: 0.24, position: 0.52, brightness: 0.60 },
    tsh:   { color1: '#2F7DE1', color2: '#6FE3FF', color3: '#FFFFFF', speed: 0.46, count: 9, frequency: 8.0, spread: 0.11, position: 0.47, brightness: 0.72 },
    ldl:   { color1: '#E08A1E', color2: '#FF7A59', color3: '#FFFFFF', speed: 0.28, count: 6, frequency: 5.0, spread: 0.16, position: 0.52, brightness: 0.66 },
  };

  const FIXED = {
    glow: 0.02,
    falloff: 0.6,
    thickness: 1.1,
    taper: 1.0,
    fanMode: 0, // center
    mirror: 1.0,
    shimmer: 1.0,
    grain: 1.0,
    grainIntensity: 0.05,
    mouseStrength: 0.35,
  };

  const hexToRgb = (hex) => {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return [1, 1, 1];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /* ---------- shaders (from React Bits WebThreads, dark mode) ----------- */
  const vertex = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

  const fragment = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float uTime;
uniform float uGrainTime;
uniform float uThreadCount;
uniform float uFrequency;
uniform float uSpread;
uniform float uTaper;
uniform float uPosition;
uniform float uFanMode;
uniform float uGlow;
uniform float uFalloff;
uniform float uThickness;
uniform float uBrightness;
uniform float uOpacity;
uniform float uMirror;
uniform float uShimmer;
uniform float uGrain;
uniform float uGrainIntensity;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform vec2 uMouse;
uniform float uMouseStrength;
uniform float uEnableMouse;
uniform float uMouseActive;
out vec4 fragColor;

#define TAU 6.28318530718
#define MAX_THREADS 10

float glow(float x, float str, float dist) {
  return dist / pow(max(x, 1e-4), str);
}

void main() {
  vec2 uv = gl_FragCoord.xy / iResolution.xy;
  float n = max(uThreadCount, 1.0);

  float pinchX = uFanMode < 0.5 ? 0.5 : (uFanMode < 1.5 ? 0.0 : 1.0);
  if (uEnableMouse > 0.5) {
    pinchX = mix(pinchX, uMouse.x, clamp(uMouseStrength, 0.0, 1.0) * uMouseActive);
  }

  float spreadDx = uSpread * abs(uv.x - pinchX);
  float baseT = uTime;
  float tauOverN = TAU / n;
  float mirror = uMirror > 0.5 ? sign(pinchX - uv.x) : 1.0;
  bool doShimmer = uShimmer > 0.5;
  float shimmerT = uTime * 1.7;
  float invThickness = 1.0 / max(uThickness, 0.01);
  float xFreq = uv.x * uFrequency;
  float yOff = uv.y - uPosition;
  float ciScale = n > 1.0 ? 1.0 / (n - 1.0) : 0.0;

  vec3 col = vec3(0.0);
  float gsum = 0.0;

  for (int idx = 0; idx < MAX_THREADS; idx++) {
    float i = float(idx);
    if (i >= n) break;

    float amplitude = spreadDx * (1.0 + i * uTaper);
    float shimmer = doShimmer ? sin(shimmerT + i * 1.3) * 0.35 : 0.0;
    float phase = (baseT + i * tauOverN) * mirror + shimmer;

    float sdf = abs(yOff + sin(xFreq + phase) * amplitude) * invThickness;

    float g = glow(sdf, uFalloff, uGlow);
    float ci = i * ciScale;
    vec3 threadCol = mix(uColor1, uColor2, ci);

    col += g * threadCol;
    gsum += g;
  }

  float coreAmt = smoothstep(0.5, 2.2, gsum);
  col = mix(col, uColor3 * gsum, coreAmt * 0.5);

  float bright = uBrightness;
  if (uEnableMouse > 0.5) {
    vec2 md = uv - uMouse;
    float d2 = dot(md, md);
    bright += clamp(uMouseStrength, 0.0, 1.0) * uMouseActive * exp(-d2 * 6.0) * 0.6;
  }
  col *= bright;

  float alpha = clamp(gsum, 0.0, 1.0) * uOpacity;

  vec3 outRgb = col * alpha;

  if (uGrain > 0.5) {
    float gv = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uGrainTime) * 43758.5453) - 0.5) * uGrainIntensity;
    outRgb = clamp(outRgb + gv, 0.0, 1.0);
    alpha = clamp(alpha + gv, 0.0, 1.0);
  }

  fragColor = vec4(outRgb, alpha);
}
`;

  /* ---------- stage ------------------------------------------------------ */
  let handle = null;
  let initPromise = null;

  function fail(stage, err) {
    if (err) console.warn('[kivo:weave] degraded —', err);
    if (stage) stage.classList.add('weave--fallback');
    return null;
  }

  function createStage(stage, OGL) {
    const test = document.createElement('canvas');
    if (!test.getContext('webgl2')) return fail(stage, 'WebGL2 unavailable');

    let renderer;
    try {
      renderer = new OGL.Renderer({
        webgl: 2,
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
      });
    } catch (err) {
      return fail(stage, err);
    }
    const gl = renderer.gl;
    if (!gl) return fail(stage, 'WebGL2 context refused');
    gl.clearColor(0, 0, 0, 0);

    const canvas = gl.canvas;
    canvas.className = 'weave-canvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    stage.appendChild(canvas);

    const geometry = new OGL.Triangle(gl);
    const program = new OGL.Program(gl, {
      vertex,
      fragment,
      uniforms: {
        iResolution: { value: new Float32Array([1, 1]) },
        uTime: { value: 0 },
        uGrainTime: { value: 0 },
        uThreadCount: { value: 7 },
        uFrequency: { value: 5.0 },
        uSpread: { value: 0.18 },
        uTaper: { value: FIXED.taper },
        uPosition: { value: 0.55 },
        uFanMode: { value: FIXED.fanMode },
        uGlow: { value: FIXED.glow },
        uFalloff: { value: FIXED.falloff },
        uThickness: { value: FIXED.thickness },
        uBrightness: { value: 0.66 },
        uOpacity: { value: 1.0 },
        uMirror: { value: FIXED.mirror },
        uShimmer: { value: FIXED.shimmer },
        uGrain: { value: FIXED.grain },
        uGrainIntensity: { value: FIXED.grainIntensity },
        uColor1: { value: new Float32Array([1, 1, 1]) },
        uColor2: { value: new Float32Array([1, 1, 1]) },
        uColor3: { value: new Float32Array([1, 1, 1]) },
        uMouse: { value: new Float32Array([0.5, 0.5]) },
        uMouseStrength: { value: FIXED.mouseStrength },
        uEnableMouse: { value: 1.0 },
        uMouseActive: { value: 0 },
      },
    });
    // ogl only console.warn()s on shader/link failure — verify ourselves so
    // a broken GPU/driver lands in the .weave--fallback path, not a black void.
    const compiled =
      gl.getShaderParameter(program.vertexShader, gl.COMPILE_STATUS) &&
      gl.getShaderParameter(program.fragmentShader, gl.COMPILE_STATUS) &&
      gl.getProgramParameter(program.program, gl.LINK_STATUS);
    if (!compiled) {
      try {
        stage.removeChild(canvas);
      } catch {}
      return fail(stage, 'shader compile/link failed');
    }

    const mesh = new OGL.Mesh(gl, { geometry, program });
    const u = program.uniforms;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* mood state — `cur` is what the GPU sees, `target` what it is tweening to */
    const snap = (m) => ({
      color1: hexToRgb(m.color1),
      color2: hexToRgb(m.color2),
      color3: hexToRgb(m.color3),
      speed: m.speed,
      count: m.count,
      frequency: m.frequency,
      spread: m.spread,
      position: m.position,
      brightness: m.brightness,
    });
    const moodFrom = snap(MOODS.weave);
    const moodCur = snap(MOODS.weave);
    let moodTo = snap(MOODS.weave);
    let moodT = 1;
    const MOOD_TWEEN = 0.7;

    let scrollTarget = 0;
    let scroll = 0;

    const mouse = { cur: [0.5, 0.5], target: [0.5, 0.5], active: 0, activeTarget: 0 };

    const writeMood = () => {
      const c1 = u.uColor1.value;
      c1[0] = moodCur.color1[0]; c1[1] = moodCur.color1[1]; c1[2] = moodCur.color1[2];
      const c2 = u.uColor2.value;
      c2[0] = moodCur.color2[0]; c2[1] = moodCur.color2[1]; c2[2] = moodCur.color2[2];
      const c3 = u.uColor3.value;
      c3[0] = moodCur.color3[0]; c3[1] = moodCur.color3[1]; c3[2] = moodCur.color3[2];
      // Scroll morphs the weave: strands rise, multiply and tighten while pinned.
      u.uSpread.value = moodCur.spread + scroll * 0.06;
      u.uThreadCount.value = Math.min(10, moodCur.count + scroll * 3);
      u.uFrequency.value = moodCur.frequency + scroll * 1.8;
      u.uPosition.value = moodCur.position - scroll * 0.2;
      u.uBrightness.value = moodCur.brightness + scroll * 0.25;
      u.uTaper.value = FIXED.taper;
      u.uGlow.value = FIXED.glow;
      u.uFalloff.value = FIXED.falloff;
      u.uThickness.value = FIXED.thickness;
      u.uFanMode.value = FIXED.fanMode;
      u.uMirror.value = FIXED.mirror;
      u.uShimmer.value = FIXED.shimmer;
      u.uGrain.value = FIXED.grain;
      u.uGrainIntensity.value = FIXED.grainIntensity;
    };

    /* wave time is INTEGRATED (not iTime*speed) so mood speed changes never
       jump the phase of the weave. */
    let waveTime = 0;
    let grainTime = 0;
    let lastNow = performance.now();

    const pushUniforms = () => {
      u.uTime.value = waveTime;
      u.uGrainTime.value = grainTime;
      u.uMouse.value[0] = mouse.cur[0];
      u.uMouse.value[1] = mouse.cur[1];
      u.uMouseActive.value = mouse.active;
      writeMood();
    };

    const setSize = () => {
      const rect = stage.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      renderer.setSize(w, h);
      const res = u.iResolution.value;
      res[0] = gl.drawingBufferWidth;
      res[1] = gl.drawingBufferHeight;
      renderer.render({ scene: mesh });
    };
    const ro = new ResizeObserver(setSize);
    ro.observe(stage);
    setSize();

    /* pointer: mouse steers the pinch point; on touch the finger does */
    const onPointerMove = (e) => {
      const rect = stage.getBoundingClientRect();
      mouse.target[0] = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      mouse.target[1] = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height));
      mouse.activeTarget = 1;
    };
    const onPointerDown = (e) => {
      onPointerMove(e);
      mouse.activeTarget = 1;
    };
    const onPointerUp = (e) => {
      if (e.pointerType === 'touch') mouse.activeTarget = 0;
    };
    const onPointerLeave = () => {
      mouse.activeTarget = 0;
    };
    stage.addEventListener('pointermove', onPointerMove, { passive: true });
    stage.addEventListener('pointerdown', onPointerDown, { passive: true });
    stage.addEventListener('pointerup', onPointerUp, { passive: true });
    stage.addEventListener('pointerleave', onPointerLeave);

    /* run only while visible */
    let raf = 0;
    let inView = true;
    let pageVisible = !document.hidden;

    const step = (dt) => {
      grainTime += dt;
      waveTime += dt * moodCur.speed;

      if (moodT < 1) {
        moodT = Math.min(1, moodT + dt / MOOD_TWEEN);
        const k = easeInOut(moodT);
        for (const key of ['speed', 'count', 'frequency', 'spread', 'position', 'brightness']) {
          moodCur[key] = lerp(moodFrom[key], moodTo[key], k);
        }
        for (const col of ['color1', 'color2', 'color3']) {
          for (let i = 0; i < 3; i++) moodCur[col][i] = lerp(moodFrom[col][i], moodTo[col][i], k);
        }
      }

      scroll += 0.08 * (scrollTarget - scroll);
      mouse.cur[0] += 0.05 * (mouse.target[0] - mouse.cur[0]);
      mouse.cur[1] += 0.05 * (mouse.target[1] - mouse.cur[1]);
      mouse.active += 0.05 * (mouse.activeTarget - mouse.active);
    };

    const renderOnce = () => {
      pushUniforms();
      renderer.render({ scene: mesh });
    };

    if (reduced) {
      /* still life: one woven frame, no motion */
      waveTime = 3.2;
      grainTime = 1.0;
      renderOnce();
      return {
        reduced: true,
        setScroll: (p) => { scroll = scrollTarget = Math.min(1, Math.max(0, p)); renderOnce(); },
        setMood: (name) => {
          const mood = MOODS[name] || MOODS.weave;
          Object.assign(moodCur, snap(mood));
          renderOnce();
        },
        destroy,
      };
    }

    const loop = (t) => {
      const dt = Math.min(0.05, (t - lastNow) * 0.001);
      lastNow = t;
      step(dt);
      pushUniforms();
      renderer.render({ scene: mesh });
      raf = requestAnimationFrame(loop);
    };
    const tryStart = () => {
      if (inView && pageVisible && raf === 0) {
        lastNow = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };
    const tryStop = () => {
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const io = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      if (inView) tryStart();
      else tryStop();
    }, { threshold: 0 });
    io.observe(stage);
    const onVisibility = () => {
      pageVisible = !document.hidden;
      if (pageVisible) tryStart();
      else tryStop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    tryStart();

    function destroy() {
      tryStop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerdown', onPointerDown);
      stage.removeEventListener('pointerup', onPointerUp);
      stage.removeEventListener('pointerleave', onPointerLeave);
      try {
        stage.removeChild(canvas);
      } catch {}
      try {
        gl.getExtension('WEBGL_lose_context').loseContext();
      } catch {}
    }

    return {
      reduced: false,
      setScroll: (p) => {
        scrollTarget = Math.min(1, Math.max(0, p));
      },
      setMood: (name) => {
        const mood = MOODS[name] || MOODS.weave;
        for (const key of ['speed', 'count', 'frequency', 'spread', 'position', 'brightness']) {
          moodFrom[key] = moodCur[key];
        }
        for (const col of ['color1', 'color2', 'color3']) {
          moodFrom[col] = moodCur[col].slice();
        }
        moodTo = snap(mood);
        moodT = 0;
      },
      destroy,
    };
  }

  /* ---------- public ---------------------------------------------------- */
  const KivoThreads = {
    MOODS,
    /** @returns {Promise<object|null>} */
    init(stage) {
      if (!stage) return Promise.resolve(null);
      if (initPromise) return initPromise;
      initPromise = import('/vendor/ogl/index.js')
        .then((OGL) => {
          handle = createStage(stage, OGL);
          return handle;
        })
        .catch((err) => fail(stage, err));
      return initPromise;
    },
    get() {
      return handle;
    },
  };

  window.KivoThreads = KivoThreads;

  /* Self-init: the weave is alive even if main.js' gsap path degrades
     (vendor blocked, js error, …) — the page never loses the section. */
  const selfInit = () => {
    const stage = document.getElementById('weaveStage');
    if (stage) KivoThreads.init(stage);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', selfInit);
  } else {
    selfInit();
  }
})();
