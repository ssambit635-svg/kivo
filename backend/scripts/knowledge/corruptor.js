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
  'decimal-comma',
  'decimal-drop',
  'column-merge',
  'space-noise',
  'flag-glyph',
  'range-dash',
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
    default:
      return line;
  }
}

/** How many corruptions a line receives, by intensity 0–3. */
function corruptionsFor(intensity, rng, types = CORRUPTION_TYPES) {
  if (intensity <= 0) return [];
  const base = intensity === 1 ? 1 : intensity === 2 ? 2 : 3;
  const count = rng() < 0.25 ? base + 1 : base;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(pick(rng, types));
  return out;
}

/** Realistic report line layouts (a lab report prints rows, not one shape). */
export function formatLine(marker, value, rng) {
  const unit = marker.defaultUnit || '';
  const v = formatValue(value);
  const spread = referenceSpreadFor(marker, value, rng);
  const layouts = [
    `${marker.name} ${v} ${unit} ${spread}`,
    `${marker.name}: ${v} ${unit}`,
    `${marker.name}  ${v}  ${unit}  Reference: <${spread.split(' - ')[1] ?? v}`,
    `${marker.name} | ${v} | ${unit} | ${spread.replace(' - ', ' | ')}`,
    `${marker.name} ${v} ${unit} (${spread})`,
    `${marker.name.toUpperCase()} ${v} ${unit}`,
    `${marker.name}\t${v}\t${unit}\t${spread}`,
    `${marker.name} ${v}${unit}`,
  ];
  return pick(rng, layouts);
}

function referenceSpreadFor(marker, value, rng) {
  const t = marker.typicalRange;
  if (t && (t.low != null || t.high != null)) {
    const low = t.low ?? Math.round(value * 0.6);
    const high = t.high ?? Math.round(value * 1.4);
    return `${low} - ${high}`;
  }
  const low = Math.max(0, Math.round(value * (0.6 + rng() * 0.1) * 100) / 100);
  const high = Math.round(value * (1.3 + rng() * 0.3) * 100) / 100;
  return `${low} - ${high}`;
}

function formatValue(v) {
  if (Number.isInteger(v)) return String(v);
  const abs = Math.abs(v);
  if (abs < 1) return v.toFixed(2);
  if (abs < 20) return v.toFixed(1);
  return String(Math.round(v));
}

/** Samples a plausible value for a marker (inside its range, sometimes outside). */
export function sampleValue(marker, rng) {
  const t = marker.typicalRange;
  if (t && (t.low != null || t.high != null)) {
    const low = t.low ?? (t.high != null ? t.high * 0.5 : 1);
    const high = t.high ?? low * 2;
    const inside = rng() < 0.75;
    const v = inside
      ? low + (high - low) * (0.15 + rng() * 0.7)
      : rng() < 0.5
        ? low * (0.5 + rng() * 0.4)
        : high * (1.05 + rng() * 0.6);
    return round(v);
  }
  const b = marker.plausibilityBounds;
  if (b && b.min != null && b.max != null) {
    const u = rng() ** 1.7; // bias toward the lower/mid part of the physiologic span
    return round(b.min + (b.max - b.min) * u);
  }
  if (b && b.max != null) return round(b.max * (0.1 + rng() * 0.6));
  if (b && b.min != null) return round(b.min * (1 + rng() * 3));
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
  const rng = makeRng(seed);
  const examples = [];
  for (const marker of markers) {
    for (const intensity of intensities) {
      for (let i = 0; i < perMarker; i += 1) {
        const value = sampleValue(marker, rng);
        const cleanLine = formatLine(marker, value, rng);
        const types = corruptionsFor(intensity, rng);
        let line = cleanLine;
        for (const t of types) line = corrupt(line, t, rng);
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
  const byMarker = new Map();
  for (const ex of examples) {
    if (!byMarker.has(ex.code)) byMarker.set(ex.code, []);
    byMarker.get(ex.code).push(ex);
  }
  const train = [];
  const test = [];
  for (const [code, list] of [...byMarker.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const h = hashString(`${code}:${seed}`);
    (h % 100 < testFraction * 100 ? test : train).push(...list);
  }
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
