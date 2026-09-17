/**
 * OCR corruption model + synthetic report corpus.
 *
 * WHY THIS EXISTS: the extraction pipeline needs a *measured* probability that
 * a drafted value is correct — and no public dataset pairs photographed lab
 * reports with ground truth that this project may ship. So the corpus is built
 * from things that ARE available and documented:
 *
 *   - the ground truth side is the committed knowledge catalogue (real marker
 *     names, real units, plausible values) — see knowledge/generated/
 *   - the noise side is a documented model of how a character recognizer fails
 *     on this document class, built from the glyph inventory vendored from
 *     xuewenyuan/OCR-for-Medical-Laboratory-Reports (MIT): the same glyphs a
 *     report recognizer is trained to read are the ones it confuses
 *
 * Nobody should mistake this for clinical validation: it measures OCR-reading
 * reliability on synthetic data, nothing else. That limitation is printed in
 * the model card that ships with the trained parameters.
 *
 * Everything is seeded: the same corpus is produced on every run.
 */

/** mulberry32 — small, fast, deterministic PRNG. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

export const CORRUPTION_TYPES = [
  'digit-glyph',
  'letter-glyph',
  'unit-mangle',
  'unit-case',
  'decimal-comma',
  'decimal-drop',
  'column-merge',
  'space-noise',
  'whitespace-collapse',
  'flag-glyph',
  'range-dash',
  'case-noise',
  'punct-noise',
  'thousand-sep',
  'sign-noise',
  'digit-repeat',
  'digit-drop',
  'header-noise',
];

/** Applies one corruption of the given type to a line. */
export function corrupt(line, type, rng) {
  const swapChar = (s, from, to, limit = 1) => {
    let out = '';
    let done = 0;
    for (const ch of s) {
      if (done < limit && ch === from) {
        out += to;
        done += 1;
      } else out += ch;
    }
    return done > 0 ? out : null;
  };

  switch (type) {
    case 'digit-glyph': {
      const pairs = [['0', 'O'], ['1', 'l'], ['5', 'S'], ['8', 'B'], ['2', 'Z'], ['6', 'G'], ['9', 'g'], ['0', 'o'], ['1', 'I']];
      for (let tries = 0; tries < 6; tries += 1) {
        const [from, to] = pick(rng, pairs);
        const out = swapChar(line, from, to);
        if (out && /\d/.test(out)) return out;
      }
      return line;
    }
    case 'letter-glyph': {
      const pairs = [['o', '0'], ['l', '1'], ['S', '5'], ['B', '8'], ['g', '9'], ['z', '2'], ['O', '0'], ['I', '1']];
      for (let tries = 0; tries < 6; tries += 1) {
        const [from, to] = pick(rng, pairs);
        const out = swapChar(line, from, to);
        if (out) return out;
      }
      return line;
    }
    case 'unit-mangle': {
      const variants = [
        [/mg\/dL/i, 'rng/dL'],
        [/mg\/dL/i, 'mg|dL'],
        [/g\/dL/i, 'g|dL'],
        [/µIU\/mL/, 'uIU/mL'],
        [/µ/i, 'u'],
        [/\//, '|'],
        [/U\/L/, 'U/1'],
        [/mg\/dL/i, 'mg / dl'],
        [/K\/uL/i, 'K/u1'],
        [/ng\/mL/i, 'ng/rnL'],
      ];
      for (let tries = 0; tries < 8; tries += 1) {
        const [re, to] = pick(rng, variants);
        if (re.test(line)) return line.replace(re, to);
      }
      return line;
    }
    case 'unit-case': {
      // Report scanners preserve letters but mangle case: MG/DL, Mg/Dl, G/dl.
      const m = line.match(/[A-Za-z]+(?:\/[A-Za-z]+|\^3\/[A-Za-z]+|%)/);
      if (!m) return line;
      const variants = [m[0].toUpperCase(), m[0].toLowerCase()];
      const to = pick(rng, variants);
      if (to === m[0]) return line;
      return line.replace(m[0], to);
    }
    case 'decimal-comma':
      return line.replace(/(\d)\.(\d)/, '$1,$2');
    case 'decimal-drop':
      return line.replace(/(\d)\.(\d)/, '$1$2');
    case 'column-merge':
      return line.replace(/\s{1,3}(\d)/, '$1');
    case 'space-noise':
      return line.replace(/\s{1,2}/, '   ');
    case 'flag-glyph': {
      const flags = ['\u2191', '\u2193', 'H', 'L', '*'];
      return `${line} ${pick(rng, flags)}`;
    }
    case 'range-dash':
      return line.replace(/(\d)\s*-\s*(\d)/, '$1 ~ $2');
    case 'case-noise': {
      // Random case flips inside the label (camera OCR on small caps).
      const idx = Math.floor(rng() * line.length);
      const ch = line[idx];
      if (!ch || !/[A-Za-z]/.test(ch)) return line;
      const flipped = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
      return `${line.slice(0, idx)}${flipped}${line.slice(idx + 1)}`;
    }
    case 'punct-noise': {
      // Stray punctuation a recognizer hallucinates, or a dropped separator.
      const ops = [
        (s) => s.replace(/\s/, '. '),
        (s) => s.replace(/\s/, ', '),
        (s) => s.replace(/:/, ';'),
        (s) => s.replace(/:\s*/, ' '),
        (s) => `${s}.`,
      ];
      return pick(rng, ops)(line);
    }
    case 'thousand-sep':
      // 1000 → 1,000: thousands separators some labs print, OCR keeps.
      return line.replace(/\b(\d)(\d{3})\b/, '$1,$2');
    case 'sign-noise': {
      // Stray '+' before the value, or a lost '-' on a negative delta.
      if (rng() < 0.5) return line.replace(/(\s)(\d)/, '$1+$2');
      return line.replace('-', '');
    }
    case 'digit-repeat':
      // Doubled digit from a shaky scan: 12.5 → 122.5.
      return line.replace(/(\d)/, '$1$1');
    case 'digit-drop': {
      // Dropped digit: 12.5 → 1.5 (only when 2+ digits survive).
      const digits = (line.match(/\d/g) || []).length;
      if (digits < 3) return line;
      return line.replace(/(\d)\d/, '$1');
    }
    case 'whitespace-collapse': {
      // All spacing lost: label, value and unit glued into one token run.
      const collapsed = line.replace(/\s+/g, '');
      return collapsed.length >= 8 ? collapsed : line;
    }
    case 'header-noise': {
      // Lab letterhead / footer junk a full-page OCR prepends to the line.
      const junk = pick(rng, ['LAB REPORT ', 'Page 1 ', 'CITY LABS ', 'Acc: 88213 ', 'Ref: DR. SHAH ']);
      return `${junk}${line}`;
    }
    default:
      return line;
  }
}

/** How many corruptions a line receives, by intensity 0–4 (4 = severe photo damage). */
function corruptionsFor(intensity, rng, types = CORRUPTION_TYPES) {
  if (intensity <= 0) return [];
  const base = intensity === 1 ? 1 : intensity === 2 ? 2 : intensity === 3 ? 3 : 4;
  const count = rng() < 0.25 ? base + 1 : base;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(pick(rng, types));
  return out;
}

/** Realistic report line layouts (a lab report prints rows, not one shape). */
/**
 * The text a report would actually print for this marker: a real label from the
 * marker's alias list (preferring multi-word forms, which are what report
 * layouts use) rather than the internal display name.
 */
export function labelFor(marker, rng) {
  const m = marker && typeof marker === 'object' ? marker : {};
  const aliases = (Array.isArray(m.aliases) ? m.aliases : []).filter((a) => typeof a === 'string' && a.length >= 3);
  // A printed report uses a short label ("Fasting Glucose", "SGPT"), not a
  // LOINC long name (".../100 leukocytes in blood by automated count"). Sample
  // the short forms most of the time, but keep the long form sometimes: some
  // laboratory systems do print it, and the extractor should survive both.
  const longForm = (a) => /\bby\b|\bin (blood|serum|plasma|urine)\b|\bper 100\b|\//.test(a) && a.split(' ').length >= 5;
  const short = aliases.filter((a) => !longForm(a));
  const pool = short.length && rng() < 0.9 ? short : aliases;
  const multiWord = pool.filter((a) => /[^a-z0-9]/.test(a) && a.split(/[^a-z0-9]+/).filter(Boolean).length >= 2);
  const chosen = multiWord.length ? multiWord : pool;
  return chosen.length ? pick(rng, chosen) : (typeof m.name === 'string' && m.name ? m.name : 'Test');
}

export function formatLine(marker, value, rng) {
  const m = marker && typeof marker === 'object' ? marker : {};
  const safeValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  const unit = typeof m.defaultUnit === 'string' ? m.defaultUnit : '';
  const v = formatValue(safeValue);
  const spread = referenceSpreadFor(m, safeValue, rng);
  const label = labelFor(m, rng);
  const flag = pick(rng, ['H', 'L', '']);
  const flagged = flag ? ` ${flag}` : '';
  const layouts = [
    `${label} ${v} ${unit} ${spread}`,
    `${label}: ${v} ${unit}`,
    `${label}  ${v}  ${unit}  Reference: <${spread.split(' - ')[1] ?? v}`,
    `${label} | ${v} | ${unit} | ${spread.replace(' - ', ' | ')}`,
    `${label} ${v} ${unit} (${spread})`,
    `${label.toUpperCase()} ${v} ${unit}`,
    `${label}\t${v}\t${unit}\t${spread}`,
    `${label} ${v}${unit}`,
    // Real-world variants: flags, missing range/unit, lowercase, method notes.
    `${label} ${v} ${unit} ${spread}${flagged}`,
    `${label.toLowerCase()} ${v} ${unit}`,
    `${label} ${v}`,
    `${label}: ${v}${flagged}`,
    `${label} - Result: ${v} ${unit}`,
    `${label} ${v} ${unit}; Ref ${spread}`,
    `Test: ${label} Value: ${v} ${unit} Range: ${spread}`,
    `${label} (${unit}) ${v} [${spread}]`,
  ];
  return pick(rng, layouts);
}

function referenceSpreadFor(marker, value, rng) {
  const m = marker && typeof marker === 'object' ? marker : {};
  const val = Number.isFinite(Number(value)) ? Number(value) : 1;
  const t = m.typicalRange && typeof m.typicalRange === 'object' ? m.typicalRange : null;
  if (t && (t.low != null || t.high != null)) {
    let low = Number(t.low ?? Math.round(val * 0.6));
    let high = Number(t.high ?? Math.round(val * 1.4));
    if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
      low = Math.round(val * 0.6);
      high = Math.round(val * 1.4);
      if (!(high > low)) {
        low = 0;
        high = 1;
      }
    }
    return `${low} - ${high}`;
  }
  const low = Math.max(0, Math.round(val * (0.6 + rng() * 0.1) * 100) / 100);
  const high = Math.round(val * (1.3 + rng() * 0.3) * 100) / 100;
  return `${low} - ${high > low ? high : low + 1}`;
}

function formatValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  const abs = Math.abs(n);
  if (abs < 1) return n.toFixed(2);
  if (abs < 20) return n.toFixed(1);
  return String(Math.round(v));
}

/** Samples a plausible value for a marker (inside its range, sometimes outside). */
export function sampleValue(marker, rng) {
  const m = marker && typeof marker === 'object' ? marker : {};
  const t = m.typicalRange && typeof m.typicalRange === 'object' ? m.typicalRange : null;
  if (t && (t.low != null || t.high != null)) {
    let low = Number(t.low ?? (t.high != null ? Number(t.high) * 0.5 : 1));
    let high = Number(t.high ?? low * 2);
    if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
      low = 1;
      high = 2;
    }
    const inside = rng() < 0.75;
    const v = inside
      ? low + (high - low) * (0.15 + rng() * 0.7)
      : rng() < 0.5
        ? low * (0.5 + rng() * 0.4)
        : high * (1.05 + rng() * 0.6);
    return round(v);
  }
  const b = m.plausibilityBounds && typeof m.plausibilityBounds === 'object' ? m.plausibilityBounds : null;
  const fmin = b ? Number(b.min ?? b.low) : NaN;
  const fmax = b ? Number(b.max ?? b.high) : NaN;
  if (b && Number.isFinite(fmin) && Number.isFinite(fmax) && fmax > fmin) {
    const u = rng() ** 1.7; // bias toward the lower/mid part of the physiologic span
    return round(fmin + (fmax - fmin) * u);
  }
  if (b && Number.isFinite(fmax) && fmax > 0) return round(fmax * (0.1 + rng() * 0.6));
  if (b && Number.isFinite(fmin)) return round(fmin * (1 + rng() * 3));
  return round(1 + rng() * 100);
}

function round(v) {
  const abs = Math.abs(v);
  if (abs < 1) return Math.round(v * 100) / 100;
  if (abs < 20) return Math.round(v * 10) / 10;
  return Math.round(v);
}

/**
 * Builds a labeled synthetic corpus.
 *
 * @param {object} opts
 * @param {Array} opts.markers        numeric markers from the knowledge base
 * @param {number} opts.perMarker     examples per marker per intensity
 * @param {number[]} opts.intensities 0 = clean, 3 = badly degraded
 * @param {number} opts.seed
 * @returns {Array<{code, trueValue, line, cleanLine, corrupted, corruptionTypes, intensity, markerName, unit}>}
 */
export function buildCorpus({ markers, perMarker = 2, intensities = [0, 1, 2, 3], seed = 20260917 }) {
  const list = Array.isArray(markers) ? markers.filter((m) => m && m.code) : [];
  if (list.length === 0) throw new Error('buildCorpus: no markers provided — the knowledge base must be built first');
  const per = Number.isInteger(perMarker) && perMarker > 0 ? Math.min(perMarker, 20) : 2;
  const levels = Array.isArray(intensities) && intensities.length ? intensities.filter((i) => Number.isInteger(i) && i >= 0 && i <= 4) : [0];
  if (levels.length === 0) throw new Error('buildCorpus: no valid intensity levels provided');
  const rng = makeRng(Number.isFinite(seed) ? seed : 20260917);
  const examples = [];
  for (const marker of list) {
    for (const intensity of levels) {
      for (let i = 0; i < per; i += 1) {
        let value;
        try {
          value = sampleValue(marker, rng);
        } catch {
          continue;
        }
        if (!Number.isFinite(value)) continue;
        let cleanLine;
        try {
          cleanLine = formatLine(marker, value, rng);
        } catch {
          continue;
        }
        let types;
        try {
          types = corruptionsFor(intensity, rng);
        } catch {
          types = [];
        }
        let line = cleanLine;
        for (const t of types) {
          try {
            line = corrupt(line, t, rng);
          } catch {
            /* keep the line as-is on a corruptor bug */
          }
        }
        if (typeof line !== 'string' || !line) continue;
        examples.push({
          code: marker.code,
          markerName: marker.name,
          unit: marker.defaultUnit,
          trueValue: value,
          cleanLine,
          line,
          corruptionTypes: types,
          intensity,
          corrupted: line !== cleanLine,
        });
      }
    }
  }
  return examples;
}

/** Deterministic split by marker so test markers never appear in training. */
export function splitByMarker(examples, testFraction = 0.3, seed = 7) {
  const list = Array.isArray(examples) ? examples : [];
  if (list.length === 0) return { train: [], test: [] };
  const frac = Number.isFinite(Number(testFraction)) ? Math.min(0.9, Math.max(0.05, Number(testFraction))) : 0.3;
  const byMarker = new Map();
  for (const ex of list) {
    if (!ex || typeof ex.code !== 'string') continue;
    if (!byMarker.has(ex.code)) byMarker.set(ex.code, []);
    byMarker.get(ex.code).push(ex);
  }
  const train = [];
  const test = [];
  for (const [code, items] of [...byMarker.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))) {
    const h = hashString(`${code}:${seed}`);
    (h % 100 < frac * 100 ? test : train).push(...items);
  }
  // Guarantee non-empty splits: a degenerate seed must not produce an
  // unmeasurable run (a single-marker corpus splits round-robin instead).
  if (train.length === 0 && test.length > 1) train.push(...test.splice(0, Math.floor(test.length / 2)));
  if (test.length === 0 && train.length > 1) test.push(...train.splice(0, Math.floor(train.length / 2)));
  return { train, test };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
