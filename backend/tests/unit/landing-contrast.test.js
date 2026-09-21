import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Landing-page contrast contract.
 *
 * The marketing page tells its story by swapping the stage underneath the
 * copy: a light #f7f7f7 section, then a black iris that blooms over it while
 * WHITE type fades in. That only works if the two are ever on screen at the
 * same time — and they were not. On a tall window the iris (130vw) stopped
 * short of the corners, so the two bottom feature blocks ("built around you",
 * "yours to keep") rendered white-on-#f7f7f7: a contrast ratio of 1.07:1,
 * i.e. invisible. Reduced-motion visitors and visitors with scripting off got
 * the same white-on-light stage with no animation to rescue it, and on phones
 * the "kivo measures…" headline was painted #000 on a #000 section.
 *
 * These tests pin the invariants that keep every word on the page readable:
 *
 *   • the black iris is sized in vmax, so it outruns the viewport diagonal on
 *     ANY aspect ratio (√2 · vmax ≈ 141vmax < 160vmax);
 *   • white feature copy always has a dark wash behind it as a safety net;
 *   • with no animation engine the feature copy flips dark-on-light instead;
 *   • the scrub timeline finishes the iris before the first white feature;
 *   • feature headlines shrink/wrap instead of being clipped off the section;
 *   • the JS breakpoints match the stylesheet's mobile recomposition;
 *   • the specific greys that failed WCAG stay fixed.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const landing = path.resolve(here, '../../..', 'frontend/landing');
const read = (p) => readFileSync(path.join(landing, p), 'utf8');

const css = read('styles.css');
const html = read('index.html');
const js = read('js/main.js');

/* ---------- WCAG 2.x relative luminance + contrast ratio ---------- */
function luminance(hex) {
  const c = hex.replace('#', '');
  const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};
/** Composites `rgba(fg, alpha)` over `bg` and returns the resulting hex. */
function blend(fg, alpha, bg) {
  const parts = (h) => {
    const c = h.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  };
  const [f, b] = [parts(fg), parts(bg)];
  return '#' + f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
};

/** Comments out: a prose `}` inside one (this stylesheet explains itself a
 *  lot) would otherwise truncate the declaration block we are reading. */
const noComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every declaration block opened by `selector` (base rule + media overrides). */
function ruleBodies(source, selector) {
  source = noComments(source);
  const out = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(selector + '{', from);
    if (at === -1) return out;
    const end = source.indexOf('}', at);
    out.push(source.slice(at + selector.length + 1, end));
    from = end + 1;
  }
}
const declares = (source, selector, needle) =>
  ruleBodies(source, selector).some((body) => body.includes(needle));
const colorOf = (source, selector) => {
  for (const body of ruleBodies(source, selector)) {
    const m = body.match(/(?<![-\w])color:\s*(#[0-9a-fA-F]{3,6})/);
    if (m) return m[1];
  }
  return null;
};

/** First capture group of `re` in `source`, failing loudly if it is gone. */
function capture(re, source) {
  const m = source.match(re);
  expect(m, `expected ${re} to still be in the source`).not.toBeNull();
  return m[1];
}

/** The stylesheet's phone recomposition, sliced out of the rest of the file. */
const mobileCss = css.slice(
  css.indexOf('@media only screen and (max-width:767px)'),
  css.indexOf('@media only screen and (max-height:520px)'),
);

describe('landing · the pinned twin keeps its white copy on a black stage', () => {
  it('sizes the iris in vmax so it covers the corners of ANY viewport', () => {
    // 130vw only: on 1000x1000 the radius is 650px but the corner is 707px
    // away — the lower corners stayed light and hid the bottom two features.
    expect(declares(css, '.twin-circleBackground', 'vmax')).toBe(true);
    expect(declares(css, '.waterStick-circleBackground', 'vmax')).toBe(true);
    const radius = Number(capture(/\.twin-circleBackground\{[\s\S]*?width:(\d+(?:\.\d+)?)vmax/, css)) / 2;
    for (const [w, h] of [[1920, 1080], [1440, 900], [1280, 800], [1100, 950], [1000, 1000], [820, 1180]]) {
      const vmax = Math.max(w, h);
      expect(radius * vmax, `${w}x${h} corner`).toBeGreaterThanOrEqual(Math.hypot(w / 2, h / 2));
    }
  });

  it('puts a dark wash behind every feature block as a contrast safety net', () => {
    expect(declares(css, '.twin-featureElements::before', 'radial-gradient')).toBe(true);
    // white on the wash's darkest stop, over the light stage, must clear 7:1
    expect(contrast('#ffffff', blend('#000000', 0.82, '#f7f7f7'))).toBeGreaterThan(7);
  });

  it('never clips a feature headline off the section', () => {
    // fixed 52px + nowrap overflowed the grid cell below ~1300px and the
    // right-hand blocks were cut in half by .twin{overflow:hidden}
    const bodies = ruleBodies(css, '.twin-featureElements h2');
    expect(bodies[0]).toMatch(/font-size:clamp\(/);
    expect(bodies[0]).toContain('white-space:normal');
    expect(bodies.some((b) => b.includes('white-space:nowrap'))).toBe(false);
  });

  it('finishes the iris bloom before the first white feature appears', () => {
    const beat = (key) => {
      const m = js.match(new RegExp(`${key}:\\s*\\[([\\d.]+),\\s*([\\d.]+)\\]`));
      return m ? [Number(m[1]), Number(m[2])] : null;
    };
    const iris = beat('iris');
    const paras = [beat('paraIn'), beat('paraOut')];
    const firstFeat = Number(capture(/firstFeat:\s*([\d.]+)/, js));
    expect(iris).not.toBeNull();
    expect(firstFeat, 'white copy must wait for the black stage').toBeGreaterThanOrEqual(iris[1]);
    // …and the light-stage paragraphs must be gone before the iris grows into
    // them (it is still a centre-only disc for the first 40% of its bloom)
    for (const p of paras) expect(p[1]).toBeLessThanOrEqual(iris[0] + (iris[1] - iris[0]) * 0.4);
    // the timeline must also rest on the finished state, not release the pin
    // on the very frame the last feature becomes readable
    const hold = Number(capture(/hold:\s*([\d.]+)/, js));
    expect(hold).toBeGreaterThan(firstFeat + 3 * Number(capture(/featStep:\s*([\d.]+)/, js)) + 0.6);
  });
});

describe('landing · every copy colour clears WCAG on the stage it actually sits on', () => {
  it('reads the light-stage paragraphs as dark grey, not #a0a0a0', () => {
    const fg = colorOf(css, '.twin-para');
    expect(contrast(fg, '#f7f7f7')).toBeGreaterThanOrEqual(4.5);
  });

  it('reads the giant twinStory watermark (2.6:1 was invisible at #dedede)', () => {
    const fg = colorOf(css, '.twinStory-titleHolder h2');
    expect(contrast(fg, '#f7f7f7')).toBeGreaterThanOrEqual(3); // display size
  });

  it('keeps the marker-card meta legible in BOTH card states', () => {
    // a hardcoded grey can only ever work on one of them, so the card's own
    // colour is inherited instead
    expect(declares(css, '.markerCard-cta p', 'color:inherit')).toBe(true);
    expect(contrast(blend('#000000', 0.72, '#ffffff'), '#ffffff')).toBeGreaterThan(4.5);
    expect(contrast(blend('#f7f7f7', 0.72, '#121212'), '#121212')).toBeGreaterThan(4.5);
  });

  it('paints the phone waterStick headline light on its black section', () => {
    expect(mobileCss).toContain('.waterStick-titleLead');
    const fg = colorOf(mobileCss, '.waterStick-titleLead');
    expect(contrast(fg, '#000000')).toBeGreaterThanOrEqual(4.5);
    // …and the disc behind it is no longer a solid light plate that would
    // swallow that same light copy (and hide the canvas waves)
    const shape = ruleBodies(mobileCss, '.waterStick-shape')[0];
    expect(shape).not.toMatch(/background:\s*#f7f7f7/);
  });

  it('gives the phone mockup meta copy real contrast', () => {
    for (const sel of ['.ph-date', '.ph-greetingSub', '.ph-cardDelta', '.ph-note']) {
      expect(contrast(colorOf(css, sel), '#f7f7f7'), sel).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('landing · the no-animation paths stay readable', () => {
  const noscript = capture(/<noscript><style>([\s\S]*?)<\/style><\/noscript>/, html);

  it('flips the twin copy dark when scripting is off', () => {
    expect(noscript).toMatch(/\.twin-featureElements h2\{color:#000\}/);
    expect(noscript).toMatch(/\.twin-featureElements p\{color:#3d3d3d\}/);
    expect(noscript).toMatch(/\.twin-circleBackground\{display:none\}/);
    // dark-on-light only applies where the stage IS light — below 768px the
    // section is a solid black column, so the flip has to stay scoped
    expect(noscript).toMatch(/@media \(min-width:768px\)\{[\s\S]*\.twin-featureElements h2\{color:#000\}/);
  });

  it('flips the twin copy dark for reduced motion / a failed vendor load too', () => {
    expect(js).toMatch(/if \(reduced\) document\.documentElement\.classList\.add\('no-motion'\)/);
    const fallback = css.slice(css.indexOf('.no-js .twin-circleBackground'));
    expect(fallback).toMatch(/\.no-motion \.twin-featureElements h2\{color:#000\}/);
    expect(fallback).toMatch(/\.no-motion \.twin-iconHolder\{color:#121212\}/);
    expect(fallback).toMatch(/\.no-motion \.twin-featureElements::before\{display:none\}/);
    expect(css.indexOf('@media (min-width:768px){\n  .no-js .twin-circleBackground')).toBeGreaterThan(-1);
  });

  it('runs the JS breakpoints at the width the stylesheet recomposes', () => {
    expect(css).toContain('@media only screen and (max-width:767px)');
    expect(js).toContain('"(min-width: 768px)"');
    expect(js).toContain('"(max-width: 767px)"');
    expect(js).not.toContain('"(min-width: 600px)"');
    expect(js).not.toContain('"(max-width: 599px)"');
  });

  it('keeps the feature blocks clear of the fixed nav bars', () => {
    expect(declares(css, '.twin-features', 'padding-block:clamp(')).toBe(true);
  });
});
