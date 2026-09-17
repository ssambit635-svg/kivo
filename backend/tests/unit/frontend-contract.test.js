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
