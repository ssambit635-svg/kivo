import { loadClinicalKnowledge, ocrLexicon } from './clinicalKnowledge.js';

/**
 * OCR text normalization for laboratory reports.
 *
 * WHY: a photographed report is read by a character recognizer, and the glyphs
 * that a laboratory-report recognizer must handle are exactly the ones it
 * confuses — the vendored upstream recognizer ships its full character
 * inventory (`recognition/keys.py`), which is where the confusion classes in
 * the knowledge artifact come from. Repairing the *unambiguous* cases before
 * value extraction measurably improves what gets read.
 *
 * WHY IT IS DELIBERATELY CONSERVATIVE: a silently "corrected" number is worse
 * than an unread number, because the user may verify it without noticing. So
 * this module only rewrites a token when the reading is not in doubt:
 *
 *   - units are matched against the known unit vocabulary (with a 'rn'→'m'
 *     ligature fix and a 1-edit fuzzy fallback) — units come from a closed set
 *   - a numeric token is repaired only if EVERY character is a known glyph
 *     confusion (l→1, O→0, S→5 …), it contains at least one real digit, it is
 *     not a known marker token ("B12", "T4", "HDL"), and it sits in a value
 *     context (next to a unit, or containing a decimal separator)
 *   - arrows/flags (↑ ↓ H L) are extracted as *flags*, never folded into values
 *   - a decimal separator is repaired only when it is unambiguous (single ','
 *     or '·' with 1–2 trailing digits)
 *
 * Everything it changes is returned in `corrections` so the pipeline can show
 * its work, and the raw OCR text stays stored on the report untouched.
 */

/** Characters that are indistinguishable from digits in typical report fonts. */
const LETTER_TO_DIGIT = {
  O: '0', o: '0', D: '0', Q: '0',
  l: '1', I: '1', i: '1', '|': '1', '!': '1', ']': '1',
  Z: '2', z: '2',
  S: '5', s: '5',
  G: '6',
  B: '8',
  g: '9', q: '9',
};

/** Test-name shapes where a letter+digit token must never be "repaired". */
const LETTER_NUMBER_NAME = /^(b|d|t|ca|cd|il|ige|iga|igg|igm|ige|hba|hb|tsh|ft|b12|b6|b5|b9|d3|d2|ca125|ca199|ca153|psa|inr|pt|aptt|hco3|tco2|pco2|po2|vit)\d+$/i;

const FULLWIDTH = [
  [/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)],
  [/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)],
  [/\uFF0C/g, ','], [/\uFF0E/g, '.'], [/\uFF1A/g, ':'], [/\uFF1B/g, ';'],
  [/\uFF08/g, '('], [/\uFF09/g, ')'], [/\uFF0F/g, '/'], [/\uFF05/g, '%'],
  [/\uFF5C/g, '|'], [/\u2013|\u2014|\u2212/g, '-'],
  [/\u03BC/g, '\u00B5'], // GREEK mu → MICRO SIGN
];

const FLAG_RE = /(\u2191\u2191|\u2193\u2193|\u2191|\u2193|\bHH\b|\bLL\b)/;

let VOCAB_CACHE = null;

/** Single-word tokens from every marker alias — the "this is a name, not a number" set. */
function markerVocabulary() {
  if (VOCAB_CACHE) return VOCAB_CACHE;
  const vocab = new Set();
  for (const m of Object.values(loadClinicalKnowledge().markers)) {
    for (const alias of m.aliases || []) {
      for (const tok of alias.split(/[^a-z0-9]+/i)) {
        if (tok.length >= 2) vocab.add(tok.toLowerCase());
      }
    }
  }
  VOCAB_CACHE = vocab;
  return vocab;
}

/** Test seam. */
export function resetVocabularyCache() {
  VOCAB_CACHE = null;
}

function unitVocabulary() {
  const k = loadClinicalKnowledge();
  const units = new Set();
  for (const key of Object.keys(k.unitEquivalences || {})) {
    units.add(key);
    units.add(k.unitEquivalences[key]);
  }
  for (const m of Object.values(k.markers)) {
    if (m.defaultUnit) units.add(m.defaultUnit);
    for (const u of m.units || []) units.add(u);
  }
  // Only tokens that look like units are worth fuzzy-matching against.
  return new Set([...units].map((u) => u.toLowerCase()).filter((u) => u.length >= 1));
}

/**
 * Unit vocabulary, bucketed by length. Fuzzy unit repair is a 1-edit match, so
 * only units within one character of the token's length can be candidates —
 * bucketing turns an O(vocabulary) scan per token into a handful of compares.
 */
let UNIT_VOCAB_CACHE = null;
export function unitVocabIndex() {
  if (UNIT_VOCAB_CACHE) return UNIT_VOCAB_CACHE;
  const set = new Set();
  for (const u of unitVocabulary()) {
    if (u.length >= 1 && u.length <= 14) set.add(u);
  }
  const byLength = new Map();
  for (const u of set) {
    const len = u.length;
    if (!byLength.has(len)) byLength.set(len, []);
    byLength.get(len).push(u);
  }
  UNIT_VOCAB_CACHE = { set, byLength };
  return UNIT_VOCAB_CACHE;
}

export function resetUnitVocabCache() {
  UNIT_VOCAB_CACHE = null;
}

function levenshtein(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    if (Math.min(...cur) > max) return max + 1;
    prev.splice(0, prev.length, ...cur);
  }
  return prev[b.length];
}

function repairUnitToken(token, corrections) {
  const bare = token.replace(/^[([{]+|[)\]}.,;:]+$/g, '');
  if (!bare) return token;
  const lower = bare.toLowerCase().replace(/\s+/g, '');
  const ligature = lower.replace(/rn/g, 'm'); // classic 'm' misread as 'rn'
  const known = unitVocabIndex().set;
  if (known.has(lower) || known.has(ligature)) {
    if (ligature !== lower && known.has(ligature)) {
      corrections.push({ type: 'unit-ligature', from: bare, to: ligature });
      return token.replace(bare, ligature);
    }
    return token;
  }
  // Only attempt a fuzzy match for tokens that carry a unit-ish signal
  // (a separator, a digit, or the micro sign). A plain word is never "repaired"
  // into a unit: "rng" alone could be anything, but "rng/dL" cannot.
  const unitish = bare.includes('/') || /[%^]/.test(bare) || /[0-9µμ]/.test(bare);
  if (!unitish) return token;
  let best = null;
  let bestDist = 3;
  const buckets = unitVocabIndex().byLength;
  const canonical = new Set(Object.values(loadClinicalKnowledge().unitEquivalences || {}).map((u) => u.toLowerCase()));
  const betterThanBest = (cand, d) =>
    d < bestDist ||
    // Equal edit distance: prefer a substitution over an insertion/deletion,
    // then a canonical spelling — 'ulU/mL' should repair to 'uiu/ml'
    // (→ µIU/mL) rather than to the shorter 'uu/ml'.
    (d === bestDist && best != null && (cand.length === ligature.length) !== (best.length === ligature.length)
      ? cand.length === ligature.length
      : d === bestDist && canonical.has(cand) && !canonical.has(best));
  for (let len = ligature.length - 2; len <= ligature.length + 2; len += 1) {
    const bucket = buckets.get(len);
    if (!bucket) continue;
    for (const cand of bucket) {
      const d = levenshtein(ligature, cand, 2);
      if (betterThanBest(cand, d)) {
        best = cand;
        bestDist = d;
      }
    }
  }
  if (best && bestDist <= 1 && ligature !== best) {
    corrections.push({ type: 'unit-repair', from: bare, to: best });
    return token.replace(bare, best);
  }
  return token;
}

function digitLookalikeCount(token) {
  return [...token].filter((c) => /[0-9]/.test(c) || LETTER_TO_DIGIT[c]).length;
}

/**
 * Attempts to read a numeric value out of a token where some glyphs were
 * misrecognized as letters. Returns null when the token is not unambiguous.
 */
function repairNumericToken(token, { followedByUnit, hasDecimalSeparator, vocab }) {
  const bare = token.replace(/[()[\],;:]+$/g, '').replace(/^[([{]+/, '');
  if (!bare || bare.length < 2 || bare.length > 10) return null;
  if (!/[0-9OolIi|!SZzDsBGgqQ.]/.test(bare)) return null;
  const stripped = bare.replace(/%$/, '');
  if (!/\d/.test(stripped)) return null; // never invent a number out of pure letters
  if (![...stripped].every((c) => /[0-9.]/.test(c) || LETTER_TO_DIGIT[c])) return null;
  if (LETTER_NUMBER_NAME.test(stripped)) return null; // "B12", "T4", "CA125"
  if (vocab.has(stripped.toLowerCase())) return null; // a known marker token
  const mapped = [...stripped].map((c) => LETTER_TO_DIGIT[c] ?? c).join('');
  if (!/^\d+(\.\d+)?$/.test(mapped)) return null;
  if (mapped.replace(/\D/g, '').length > 6) return null;
  // (The earlier every-character check already guarantees that only digits,
  // separators and known digit-lookalikes survive to this point.)
  const hadLetter = [...stripped].some((c) => LETTER_TO_DIGIT[c]);
  if (!hadLetter) return null;
  // Context requirement: a repaired value must be anchored by a unit, a
  // decimal separator, or a long run of digit-lookalikes.
  const strong = followedByUnit || hasDecimalSeparator || stripped.replace(/\D/g, '').length >= 3;
  if (!strong) return null;
  return mapped;
}

function repairDecimalSeparator(token, corrections) {
  const m = token.match(/^(\d{1,4}),(\d{1,2})$/);
  if (m && !token.includes('.')) {
    // A single comma with 1–2 trailing digits is a decimal comma, not a
    // thousands separator (lab values are not reported in thousands here).
    corrections.push({ type: 'decimal-comma', from: token, to: `${m[1]}.${m[2]}` });
    return `${m[1]}.${m[2]}`;
  }
  const mid = token.match(/^(\d{1,4})[·•](\d{1,2})$/);
  if (mid) {
    corrections.push({ type: 'decimal-glyph', from: token, to: `${mid[1]}.${mid[2]}` });
    return `${mid[1]}.${mid[2]}`;
  }
  return token;
}

/**
 * Normalizes one OCR line.
 * @returns {{ line: string, corrections: Array, flags: string[] }}
 */
export function normalizeOcrLine(line, { vocab = markerVocabulary() } = {}) {
  let working = String(line ?? '');
  const corrections = [];
  for (const [re, rep] of FULLWIDTH) working = working.replace(re, rep);

  const flags = [];
  const flagMatch = working.match(FLAG_RE);
  if (flagMatch) flags.push(flagMatch[1]);

  // Casing mangles inside known units ("MG/DL") are repaired by the unit pass.
  const rawTokens = working.split(/(\s+)/); // keep separators so spacing survives
  const tokens = rawTokens;
  const out = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (/^\s+$/.test(tok) || tok === '') {
      out.push(tok);
      continue;
    }
    const next = tokens[i + 2] ?? '';
    const followedByUnit = /[/%^]|[A-Za-z]/.test(next) && /^[([{]?[A-Za-zµμ\u00B5^0-9%/.]{1,10}[)\]}.,;:]?$/.test(next) && /[/%]|^[A-Za-z]{1,3}$/.test(next);

    // 1) unit repair (closed vocabulary)
    if (/[A-Za-z%]/.test(tok) && !/^\d+$/.test(tok) && (/[/%^]/.test(tok) || followedByUnit || tok.length <= 8)) {
      const repairedUnit = repairUnitToken(tok, corrections);
      if (repairedUnit !== tok) {
        out.push(repairedUnit);
        continue;
      }
    }

    // 2) numeric glyph repair
    const numeric = repairNumericToken(tok, {
      followedByUnit,
      hasDecimalSeparator: /[.,·•]/.test(tok),
      vocab,
    });
    if (numeric != null && numeric !== tok) {
      corrections.push({ type: 'digit-glyph', from: tok, to: numeric });
      out.push(tok.replace(tok.replace(/[()[\],;:]+$/g, '').replace(/^[([{]+/, ''), numeric));
      continue;
    }

    // 3) decimal separator repair
    const dec = repairDecimalSeparator(tok, corrections);
    out.push(dec);
  }

  // 4) collapse runs of spaces created by column alignment (report tables).
  const normalized = out.join('').replace(/[ \t]{2,}/g, '  ').replace(/\s+$/, '');
  return { line: normalized, corrections, flags };
}

/**
 * Normalizes a whole report text.
 * @returns {{ text: string, corrections: Array, flags: string[], changedLines: number }}
 */
export function normalizeOcrText(text) {
  const vocab = markerVocabulary();
  const lines = String(text ?? '').split(/\r?\n/);
  const corrections = [];
  const flags = [];
  let changedLines = 0;
  const outLines = lines.map((line) => {
    const res = normalizeOcrLine(line, { vocab });
    if (res.corrections.length > 0) {
      changedLines += 1;
      corrections.push(...res.corrections.map((c) => ({ ...c, line: res.line })));
    }
    flags.push(...res.flags);
    return res.line;
  });
  return { text: outLines.join('\n'), corrections, flags, changedLines };
}

/** Exposes the vendored glyph knowledge for callers that want to show their work. */
export function glyphClasses() {
  return ocrLexicon().confusionClasses;
}
