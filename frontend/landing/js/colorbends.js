/* kivo landing — "the weave" (color bends: silky WebGL light ribbons)
 *
 * Vanilla port of the React Bits <ColorBends /> component. This repo
 * is zero-build, so the React wrapper is gone and the WebGL program lives
 * here on the vendored OGL renderer (same convention as the old threads
 * port), driven by plain DOM + GSAP from main.js.
 *
 * Source: https://reactbits.dev/backgrounds/color-bends
 * Copyright (c) 2026 David Haz — MIT + Commons Clause.
 * See /vendor/REACT-BITS-LICENSE.md.
 *
 * API (window.KivoBends):
 *   KivoBends.init(stageEl, options) → Promise<handle|null>   (null = degraded)
 *   KivoBends.get()                  → handle|null
 *   handle.setScroll(progress)       → 0..1, morphs the bends while pinned
 *   handle.destroy()
 *
 * Degradation contract: any failure (no WebGL2, blocked vendor, shader
 * compile error) leaves a .weave--fallback class on the stage and resolves
 * with null — the page never traps behind it.
 */
(() => {
  'use strict';

  const MAX_COLORS = 8;

  /* The kivo palette for the interlude: jade → gold → blue, the same three
     accents the health-signal threads used before the swap. */
  const DEFAULTS = {
    rotation: 90,
    autoRotate: 0,
    speed: 0.2,
    colors: ['#16C795', '#E3A93C', '#2F7DE1'],
    transparent: true,
    scale: 1,
    frequency: 1,
    warpStrength: 1,
    mouseInfluence: 1,
    parallax: 0.5,
    noise: 0.05,
    iterations: 2,
    intensity: 0.95, // retain jade/blue color instead of blowing bands out on paper
    bandWidth: 6,
  };

  /* ---------- shaders (React Bits ColorBends, ported to GLSL ES 3.0) ------ */
  const vert = `#version 300 es
in vec2 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

  const frag = `#version 300 es
precision highp float;
#define MAX_COLORS ${MAX_COLORS}
uniform vec2 uCanvas;
uniform float uTime;
uniform float uSpeed;
uniform vec2 uRot;
uniform int uColorCount;
uniform vec3 uColors[MAX_COLORS];
uniform int uTransparent;
uniform float uScale;
uniform float uFrequency;
uniform float uWarpStrength;
uniform vec2 uPointer; // in NDC [-1,1]
uniform float uMouseInfluence;
uniform float uParallax;
uniform float uNoise;
uniform int uIterations;
uniform float uIntensity;
uniform float uBandWidth;
in vec2 vUv;
out vec4 fragColor;

void main() {
  float t = uTime * uSpeed;
  vec2 p = vUv * 2.0 - 1.0;
  p += uPointer * uParallax * 0.1;
  vec2 rp = vec2(p.x * uRot.x - p.y * uRot.y, p.x * uRot.y + p.y * uRot.x);
  vec2 q = vec2(rp.x * (uCanvas.x / uCanvas.y), rp.y);
  q /= max(uScale, 0.0001);
  q /= 0.5 + 0.2 * dot(q, q);
  q += 0.2 * cos(t) - 7.56;
  vec2 toward = (uPointer - rp);
  q += toward * uMouseInfluence * 0.2;

    for (int j = 0; j < 5; j++) {
      if (j >= uIterations - 1) break;
      vec2 rr = sin(1.5 * (q.yx * uFrequency) + 2.0 * cos(q * uFrequency));
      q += (rr - q) * 0.15;
    }

    vec3 col = vec3(0.0);
    float a = 1.0;

    if (uColorCount > 0) {
      vec2 s = q;
      vec3 sumCol = vec3(0.0);
      float cover = 0.0;
      for (int i = 0; i < MAX_COLORS; ++i) {
            if (i >= uColorCount) break;
            s -= 0.01;
            vec2 r = sin(1.5 * (s.yx * uFrequency) + 2.0 * cos(s * uFrequency));
            float m0 = length(r + sin(5.0 * r.y * uFrequency - 3.0 * t + float(i)) / 4.0);
            float kBelow = clamp(uWarpStrength, 0.0, 1.0);
            float kMix = pow(kBelow, 0.3); // strong response across 0..1
            float gain = 1.0 + max(uWarpStrength - 1.0, 0.0); // allow >1 to amplify displacement
            vec2 disp = (r - s) * kBelow;
            vec2 warped = s + disp * gain;
            float m1 = length(warped + sin(5.0 * warped.y * uFrequency - 3.0 * t + float(i)) / 4.0);
            float m = mix(m0, m1, kMix);
            float w = 1.0 - exp(-uBandWidth / exp(uBandWidth * m));
            sumCol += uColors[i] * w;
            cover = max(cover, w);
      }
      col = clamp(sumCol, 0.0, 1.0);
      a = uTransparent > 0 ? cover : 1.0;
    } else {
        vec2 s = q;
        for (int k = 0; k < 3; ++k) {
            s -= 0.01;
            vec2 r = sin(1.5 * (s.yx * uFrequency) + 2.0 * cos(s * uFrequency));
            float m0 = length(r + sin(5.0 * r.y * uFrequency - 3.0 * t + float(k)) / 4.0);
            float kBelow = clamp(uWarpStrength, 0.0, 1.0);
            float kMix = pow(kBelow, 0.3);
            float gain = 1.0 + max(uWarpStrength - 1.0, 0.0);
            vec2 disp = (r - s) * kBelow;
            vec2 warped = s + disp * gain;
            float m1 = length(warped + sin(5.0 * warped.y * uFrequency - 3.0 * t + float(k)) / 4.0);
            float m = mix(m0, m1, kMix);
            col[k] = 1.0 - exp(-uBandWidth / exp(uBandWidth * m));
        }
        a = uTransparent > 0 ? max(max(col.r, col.g), col.b) : 1.0;
    }

    col *= uIntensity;

    if (uNoise > 0.0001) {
      float n = fract(sin(dot(gl_FragCoord.xy + vec2(uTime), vec2(12.9898, 78.233))) * 43758.5453123);
      col += (n - 0.5) * uNoise;
      col = clamp(col, 0.0, 1.0);
    }

    vec3 rgb = (uTransparent > 0) ? col * a : col;
    fragColor = vec4(rgb, a);
}
`;

  const hexToRgb = (hex) => {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
    if (!m) return [0, 0, 0];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
  };

  /* ---------- stage ------------------------------------------------------ */
  let handle = null;
  let initPromise = null;

  function fail(stage, err) {
    if (err) console.warn('[kivo:weave] degraded —', err);
    if (stage) stage.classList.add('weave--fallback');
    return null;
  }

  function createStage(stage, OGL, opts) {
    const test = document.createElement('canvas');
    const probe = test.getContext('webgl2');
    if (!probe) return fail(stage, 'WebGL2 unavailable');
    probe.getExtension('WEBGL_lose_context')?.loseContext();

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

    const colors = (opts.colors || []).filter(Boolean).slice(0, MAX_COLORS).map(hexToRgb);
    const colorsFlat = [];
    for (let i = 0; i < MAX_COLORS; i++) colorsFlat.push(colors[i] || [0, 0, 0]);

    const rad = (opts.rotation * Math.PI) / 180;
    const program = new OGL.Program(gl, {
      vertex: vert,
      fragment: frag,
      transparent: true,
      // The component renders premultiplied RGB (three.js premultipliedAlpha),
      // so composite with ONE / ONE_MINUS_SRC_ALPHA.
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCanvas: { value: [1, 1] },
        uTime: { value: 0 },
        uSpeed: { value: opts.speed },
        uRot: { value: [Math.cos(rad), Math.sin(rad)] },
        uColorCount: { value: colors.length },
        uColors: { value: colorsFlat },
        uTransparent: { value: opts.transparent ? 1 : 0 },
        uScale: { value: opts.scale },
        uFrequency: { value: opts.frequency },
        uWarpStrength: { value: opts.warpStrength },
        uPointer: { value: [0, 0] },
        uMouseInfluence: { value: opts.mouseInfluence },
        uParallax: { value: opts.parallax },
        uNoise: { value: opts.noise },
        uIterations: { value: Math.max(1, Math.min(5, Math.round(opts.iterations))) },
        uIntensity: { value: opts.intensity },
        uBandWidth: { value: opts.bandWidth },
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
      program.remove();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return fail(stage, 'shader compile/link failed');
    }

    const geometry = new OGL.Triangle(gl);
    const mesh = new OGL.Mesh(gl, { geometry, program });
    const u = program.uniforms;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* pointer in NDC, smoothed like the original component (rate 8/s) */
    const pointerTarget = [0, 0];
    const pointerCur = [0, 0];
    let pointerActive = 0; // fades the influence out once the pointer leaves

    /* scroll morph: bands rotate further, tighten and brighten while pinned */
    let scrollTarget = 0;
    let scroll = 0;

    let rotation = opts.rotation; // base; autoRotate keeps adding degrees/s

    const applyScroll = () => {
      const deg = rotation + autoRotateDeg + scroll * 140;
      const r = (deg * Math.PI) / 180;
      u.uRot.value[0] = Math.cos(r);
      u.uRot.value[1] = Math.sin(r);
      u.uWarpStrength.value = opts.warpStrength + scroll * 0.45;
      u.uFrequency.value = opts.frequency + scroll * 0.6;
      u.uIntensity.value = opts.intensity + scroll * 0.1;
      u.uScale.value = opts.scale + scroll * 0.15;
    };

    const setSize = () => {
      const rect = stage.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      renderer.setSize(w, h);
      u.uCanvas.value[0] = gl.drawingBufferWidth;
      u.uCanvas.value[1] = gl.drawingBufferHeight;
      renderer.render({ scene: mesh });
    };
    const ro = new ResizeObserver(setSize);
    ro.observe(stage);
    setSize();

    const onPointerMove = (e) => {
      const rect = stage.getBoundingClientRect();
      pointerTarget[0] = ((e.clientX - rect.left) / (rect.width || 1)) * 2 - 1;
      pointerTarget[1] = -(((e.clientY - rect.top) / (rect.height || 1)) * 2 - 1);
      pointerActive = 1;
    };
    const onPointerLeave = () => {
      pointerActive = 0;
    };
    stage.addEventListener('pointermove', onPointerMove, { passive: true });
    stage.addEventListener('pointerdown', onPointerMove, { passive: true });
    stage.addEventListener('pointerleave', onPointerLeave);

    let waveTime = 8.0; // start mid-motion so the first frame is never a blank wash
    let autoRotateDeg = 0;
    let lastNow = performance.now();

    const pushUniforms = () => {
      u.uTime.value = waveTime;
      u.uPointer.value[0] = pointerCur[0];
      u.uPointer.value[1] = pointerCur[1];
      applyScroll();
    };

    const renderOnce = () => {
      pushUniforms();
      renderer.render({ scene: mesh });
    };

    // Reduced motion shares the same initialized cleanup path; render a
    // still frame, but never schedule animation or pointer/scroll motion.
    renderOnce();

    let raf = 0;
    let contextLost = false;
    let inView = true;
    let pageVisible = !document.hidden;

    const loop = (t) => {
      const dt = Math.min(0.05, (t - lastNow) * 0.001);
      lastNow = t;

      waveTime += dt;
      autoRotateDeg += opts.autoRotate * dt;
      scroll += 0.08 * (scrollTarget - scroll);

      const amt = Math.min(1, dt * 8);
      const tx = pointerTarget[0] * pointerActive;
      const ty = pointerTarget[1] * pointerActive;
      pointerCur[0] += (tx - pointerCur[0]) * amt;
      pointerCur[1] += (ty - pointerCur[1]) * amt;

      pushUniforms();
      renderer.render({ scene: mesh });
      raf = requestAnimationFrame(loop);
    };
    const tryStart = () => {
      if (!reduced && !contextLost && inView && pageVisible && raf === 0) {
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
    const onContextLost = (event) => {
      event.preventDefault();
      tryStop();
      contextLost = true;
      inView = false;
      canvas.style.display = 'none';
      fail(stage, 'WebGL context lost');
    };
    canvas.addEventListener('webglcontextlost', onContextLost);

    function destroy() {
      tryStop();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerdown', onPointerMove);
      stage.removeEventListener('pointerleave', onPointerLeave);
      try {
        stage.removeChild(canvas);
      } catch {}
      geometry.remove();
      program.remove();
      try {
        gl.getExtension('WEBGL_lose_context').loseContext();
      } catch {}
    }

    return {
      reduced,
      setScroll: (p) => {
        if (reduced) return;
        scrollTarget = Math.min(1, Math.max(0, p));
      },
      destroy,
    };
  }

  /* ---------- public ---------------------------------------------------- */
  const KivoBends = {
    /** @returns {Promise<object|null>} */
    init(stage, options) {
      if (!stage) return Promise.resolve(null);
      if (initPromise) return initPromise;
      const opts = Object.assign({}, DEFAULTS, options || {});
      initPromise = import('/vendor/ogl/index.js')
        .then((OGL) => {
          handle = createStage(stage, OGL, opts);
          return handle;
        })
        .catch((err) => fail(stage, err));
      return initPromise;
    },
    get() {
      return handle;
    },
  };

  window.KivoBends = KivoBends;

  /* Self-init: the weave is alive even if main.js' gsap path degrades
     (vendor blocked, js error, …) — the page never loses the section. */
  const selfInit = () => {
    const stage = document.getElementById('weaveStage');
    if (stage) KivoBends.init(stage);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', selfInit);
  } else {
    selfInit();
  }
})();
