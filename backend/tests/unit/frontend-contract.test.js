import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Frontend contract guards.
 *
 * The two frontends are hand-written vanilla JS with no build step, so a typo
 * in an element id or an icon name only shows up at runtime — on stage. These
 * tests read the real files and assert the contracts that a bundler would
 * otherwise catch:
 *
 *   • every id a module looks up (and queries with .querySelector) exists in
 *     ITS OWN html file;
 *   • every asset the html links exists on disk;
 *   • every icon key the modules pass to the registry is actually drawn;
 *   • the patient shell's cross-module bridge exposes what care.js consumes;
 *   • the doctor console stays role-separated (own entry file + own tokens).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '../../..', 'frontend');
const read = (p) => readFileSync(path.join(frontend, p), 'utf8');

const APPS = [
  {
    name: 'patient app',
    html: 'index.html',
    modules: ['app.js', 'care.js'],
    styles: ['styles.css', 'care.css'],
  },
  {
    name: 'doctor console',
    html: 'doctor/index.html',
    modules: ['doctor/doctor.js'],
    styles: ['doctor/doctor.css'],
    sharedStyles: ['styles.css'],
  },
];

/** ids looked up through the shell helper `$('id')` or the raw DOM API. */
function referencedIds(source) {
  const ids = new Set();
  for (const m of source.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1]);
  for (const m of source.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1]);
  return ids;
}

/** ids used only through querySelector, e.g. $('nav-studio').querySelector('.nav-ic') */
function queriedSelectors(source) {
  const out = new Set();
  for (const m of source.matchAll(/querySelector\('\.([A-Za-z0-9_-]+)'\)/g)) out.add(m[1]);
  return out;
}

describe('frontend contract', () => {
  for (const app of APPS) {
    describe(app.name, () => {
      const html = read(app.html);
      const sources = app.modules.map((m) => [m, read(m)]);

      it('ships every asset the html references', () => {
        const refs = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1]);
        expect(refs.length).toBeGreaterThan(0);
        for (const ref of refs) {
          expect(existsSync(path.join(frontend, app.html.includes('/') ? app.html.replace(/\/[^/]+$/, '') + '/' + ref : ref)), `${ref} is missing`).toBe(true);
        }
      });

      it('every element id the modules look up exists in its html', () => {
        const missing = new Set();
        for (const [file, source] of sources) {
          for (const id of referencedIds(source)) {
            // ids owned by a *sibling* app are allowed to live elsewhere only
            // when the module guards for them (coverage below).
            if (!html.includes(`id="${id}"`)) missing.add(`${file} → #${id}`);
          }
        }
        expect([...missing]).toEqual([]);
      });

      it('uses a guard when it reaches for ids from the other app', () => {
        // care.js runs inside the patient app; doctor.js inside the console.
        // Both must survive a missing node from a partial page.
        for (const [, source] of sources) {
          for (const m of source.matchAll(/document\.querySelectorAll\('\.([A-Za-z0-9_-]+)'\)/g)) {
            expect(html).toContain(m[1]);
          }
        }
      });

      it('querySelector class hooks exist in the html or the stylesheet', () => {
        const css = [...(app.styles || []), ...(app.sharedStyles || [])].map((f) => read(f)).join('\n');
        const missing = new Set();
        for (const [file, source] of sources) {
          for (const cls of queriedSelectors(source)) {
            if (!html.includes(cls) && !css.includes(`.${cls}`)) missing.add(`${file} → .${cls}`);
          }
        }
        expect([...missing]).toEqual([]);
      });

      it('only asks the icon registry for icons that exist', () => {
        const icons = read('icons.js');
        const used = new Set();
        for (const [, source] of sources) {
          for (const m of source.matchAll(/Icons\.set\([^,]+,\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
          for (const m of source.matchAll(/icon\('([a-z0-9-]+)'/g)) used.add(m[1]);
        }
        expect(used.size).toBeGreaterThan(3);
        const missing = [...used].filter((name) => !new RegExp(`['"]?${name}['"]?:`).test(icons));
        expect(missing).toEqual([]);
      });
    });
  }

  it('patient shell exposes the bridge care.js consumes at evaluation time', () => {
    const app = read('app.js');
    const care = read('care.js');
    // Hoisted to module scope: care.js captures it before DOMContentLoaded.
    const bridgeIndex = app.indexOf('window.MtApp = {');
    expect(bridgeIndex).toBeGreaterThan(-1);
    expect(app.indexOf('if (document.readyState')).toBeGreaterThan(bridgeIndex);

    for (const key of ['el', 'icon', 'toast', 'api', '$', 'showView', 'member', 'onSession', 'onMember', 'ready']) {
      expect(app, `bridge is missing ${key}`).toContain(`${key}:`);
      expect(care, `care.js does not consume ${key}`).toMatch(new RegExp(`App\\.${key.replace('$', '\\$')}`));
    }
    // The Care tab must not be reachable while signed out.
    expect(app).toMatch(/function showView\(name\)[\s\S]*showCare\(\)/);
    expect(care).toMatch(/App\.onSession\(/);
  });

  it('care.js talks only to routes that exist in the api router', () => {
    const care = read('care.js');
    const routes = readFileSync(path.resolve(here, '../../src/routes/api.js'), 'utf8');
    const used = new Set();
    for (const m of care.matchAll(/api\('(\/care\/[^'?]+)/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(6);
    const missing = [...used].filter((p) => !routes.includes(`'${p}`) && !routes.includes(`'${p}'`));
    expect(missing).toEqual([]);
  });

  it('doctor console keeps its own token namespace and never reuses the patient key', () => {
    const doctor = read('doctor/doctor.js');
    expect(doctor).toContain("'mt.doctor.tokens'");
    expect(read('app.js')).not.toContain('mt.doctor.tokens');
  });

  it('no inline event handlers (CSP: script-src \'self\', script-src-attr \'none\')', () => {
    for (const app of APPS) {
      const html = read(app.html);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      for (const mod of app.modules) {
        expect(read(mod)).not.toMatch(/\.on(click|change|submit|input)\s*=/);
      }
    }
  });
});

/**
 * Landing page (`/`, frontend/landing). It is animation-driven: gsap and
 * ScrollTrigger are handed dozens of selector strings, and a selector that no
 * longer matches anything (a section that was removed, a class that was
 * renamed) fails silently — the tween just never plays. These tests parse the
 * selectors out of main.js and assert every one of them still resolves.
 */
describe('landing page', () => {
  const html = read('landing/index.html');
  const css = read('landing/styles.css');
  const js = read('landing/js/main.js');

  /** every single-quoted string in main.js that looks like a css selector list */
  function selectorLiterals(source) {
    const out = new Set();
    for (const m of source.matchAll(/'([^'\n]*)'/g)) {
      const s = m[1].trim();
      if (/^[.#][A-Za-z_-]/.test(s)) out.add(s);
    }
    return out;
  }

  it('ships every root-relative asset the html references', () => {
    const refs = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)]
      .map((m) => m[1].split('?')[0])
      .filter((p) => !['/', '/app/', '/doctor/'].includes(p));
    expect(refs.length).toBeGreaterThan(3);
    for (const ref of refs) {
      expect(existsSync(path.join(frontend, 'landing', ref)), `${ref} is missing`).toBe(true);
    }
    // the stylesheet's self-hosted fonts must be shipped too
    for (const m of css.matchAll(/url\((\/fonts\/[^)]+)\)/g)) {
      expect(existsSync(path.join(frontend, 'landing', m[1])), `${m[1]} is missing`).toBe(true);
    }
  });

  it('every element id main.js looks up exists in the landing html', () => {
    const missing = [...referencedIds(js)].filter((id) => !html.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  it('every gsap / ScrollTrigger selector still resolves to markup or a style rule', () => {
    const literals = selectorLiterals(js);
    expect(literals.size).toBeGreaterThan(30);
    const missing = new Set();
    for (const list of literals) {
      for (const compound of list.split(',')) {
        for (const token of compound.trim().split(/\s+/)) {
          const bare = token.replace(/:[a-z-]+(\([^)]*\))?/g, ''); // drop pseudo-classes
          if (bare.startsWith('#')) {
            if (!html.includes(`id="${bare.slice(1)}"`)) missing.add(`${list} → ${bare}`);
          } else if (bare.startsWith('.')) {
            const cls = bare.slice(1);
            if (!html.includes(cls) && !css.includes(`.${cls}`)) missing.add(`${list} → ${bare}`);
          }
        }
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('every class the noscript / no-motion fallbacks target exists', () => {
    const noscript = html.match(/<noscript><style>([\s\S]*?)<\/style><\/noscript>/);
    expect(noscript).not.toBeNull();
    const fallback = noscript[1] + '\n' + (css.match(/\.no-motion[^\n]*/g) || []).join('\n');
    const classes = new Set([...fallback.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]));
    classes.delete('no-motion');
    const missing = [...classes].filter((cls) => !html.includes(`class="${cls}`) && !html.includes(` ${cls}`) && !html.includes(`${cls} `) && !html.includes(`${cls}"`));
    expect(missing).toEqual([]);
  });

  it('keeps the section layout the page was tuned for (one app phone, no dark interlude before the footer)', () => {
    // the application section shows a single (light) phone with copy either side
    const app = html.slice(html.indexOf('id="appSection"'), html.indexOf('id="learnSection"'));
    expect((app.match(/class="phone"/g) || []).length).toBe(1);
    expect(app).not.toContain('phone--dark');
    expect(app).toContain('class="appScreen-cta"');
    expect(app).toContain('class="appSection-text appSection-text--two"');
    // the community section hands straight over to the footer
    expect(html).not.toContain('imageBreak');
    expect(html.indexOf('id="community"')).toBeLessThan(html.indexOf('<footer'));
    expect(html.slice(html.indexOf('id="community"'), html.indexOf('<footer'))).not.toMatch(/<section/);
    // the two testimonials containers are distinct so the reveal tween targets one node
    expect(html).toContain('class="community-quoteList" id="quoteList"');
  });

  it('the preloader mask fits its widest word — the words share one grid cell', () => {
    // Regression guard for the reported bug: the second word ("verify") used to
    // be absolutely positioned, so the overflow:hidden mask was sized by the
    // FIRST word and sliced the longer ones in half.
    const holder = css.slice(css.indexOf('.loader-textHolder{'), css.indexOf('.loader-textHolder p{'));
    expect(holder).toMatch(/display:grid/);
    expect(holder).toMatch(/place-items:center/);
    expect(css, 'positioned word variants came back').not.toMatch(/\.loader-word--[23]/);
    expect(holder).not.toMatch(/position:absolute/);
    // the words stack in ONE cell, so the mask is as wide as the longest word
    expect(css).toMatch(/\.loader-textHolder p\{[\s\S]*?grid-area:1 \/ 1/);
    // and the mask breathes with the type size, so ascenders/descenders survive
    expect(holder).toMatch(/padding-block:\s*\.?\d+(\.\d+)?em/);
    expect(css).toMatch(/\.loader\{[\s\S]*?--loader-type:/);
    // the index the timeline counts lives in the markup it counts into
    expect(html).toContain('id="loaderCount"');
    expect(js).toContain("getElementById('loaderCount')");
  });

  it('the intro is paced in seconds, not blinks, and its fail-safe waits for it', () => {
    // Each word gets a written-to-be-read rest; the fail-safe is derived from
    // the real timeline length so slowing the intro down cannot cut it short.
    expect(js).toMatch(/const FIRST = 2\.1|const STEP = 2/);
    expect(js).toMatch(/return tl\.duration\(\)/);
    expect(js).toMatch(/loaderDuration \+ 2/);
  });

  it('every figure the "numbers" section prints is a placeholder filled from the api', () => {
    const stats = html.slice(html.indexOf('id="statsSection"'), html.indexOf('id="community"'));
    const text = stats.replace(/<[^>]+>/g, ' ');
    // nothing typed in by hand: no percentages, no big counts, no decimals
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/\b\d{3,}\b/);
    expect(text).not.toMatch(/\b\d+\.\d+\b/);
    const slots = [...stats.matchAll(/data-kivo="([a-z]+)"/g)].map((m) => m[1]);
    expect(slots.length).toBeGreaterThanOrEqual(5);
    for (const key of ['markers', 'panels', 'aliases', 'loinc', 'calibration', 'core']) {
      expect(slots, `missing a data-kivo="${key}" slot`).toContain(key);
      expect(js, `main.js never patches ${key}`).toContain(`patch('${key}'`);
    }
  });

  it('marker cards and the twin strip are dictionary placeholders, not typed-in values', () => {
    for (const key of ['hba1c', 'tsh', 'ldl']) expect(html).toContain(`data-marker="${key}"`);
    expect(html).toContain('data-strip="hemoglobin"');
    expect(html, 'stale hand-written range came back').not.toMatch(/target state:/);
    expect(js).toContain("'/api/meta/lab-dictionary'");
    for (const attr of ['data-marker-name', 'data-marker-range', 'data-strip-name', 'data-strip-range']) {
      expect(js, `main.js never fills ${attr}`).toContain(attr);
    }
    // the single mock phone screen (app section — the hero now uses the SoFi-
    // style hand cut-out instead of a phone) prints the SAME dictionary
    // entries — no invented patient values may be typed into it
    const values = [...html.matchAll(/<span class="ph-cardValue"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
    const notes = [...html.matchAll(/<span class="ph-cardDelta"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(values.length, 'the phone mock keeps three cards').toBe(3);
    expect(notes.length).toBe(3);
    for (const t of [...values, ...notes]) expect(t, `hand-typed phone value: ${t}`).toBe('—');
    expect(js).toContain('data-ph-value');
    expect(js).toContain('data-ph-note');
  });

  it('no inline event handlers and vendor scripts are self-hosted (CSP: script-src \'self\')', () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    for (const m of html.matchAll(/<script[^>]*src="([^"]+)"/g)) {
      expect(m[1].startsWith('/'), `${m[1]} is not self-hosted`).toBe(true);
    }
    expect(html).not.toMatch(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/);
  });
});
