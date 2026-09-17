import { aliasEntries, LAB_DICTIONARY } from './labDictionary.js';
import { checkPlausibility, loadClinicalKnowledge } from '../../knowledge/clinicalKnowledge.js';
import { normalizeOcrText } from '../../knowledge/textNormalizer.js';
import { calibrateExtraction } from '../../knowledge/calibration.js';

const EMPTY_SET = new Set();

/** Canonical spelling for a unit token ("mmol/l" → "mmol/L", "k/ul" → "10^3/µL"). */
function canonicalUnit(unit) {
  try {
    if (!unit || typeof unit !== 'string') return unit;
    const map = loadClinicalKnowledge().unitEquivalences || {};
    return map[unit.toLowerCase()] || map[unit.toLowerCase().replace(/^\//, '')] || unit;
  } catch {
    return unit;
  }
}

/** True when a trailing fragment looks like a unit ("ng/mL", "k/uL", "%"). */
function isUnitLikeSuffix(text) {
  const t = text.replace(/^\//, '').trim();
  if (!t) return false;
  if (/^[a-zµμ%][a-z0-9µμ^.]*\/[a-z0-9µμ^.]{1,5}$/i.test(t)) return true;
  return /^(%|fl|pg|mg|g|kg|ml|l|dl|ul|ng|ug|µg|µl|mmol|nmol|umol|µmol|pmol|meq|mol|iu|miu|uiu|k|m)$/i.test(t);
}

/** "(4.0 - 5.6)", "<200", "70-100" — a reference range, never a result. */
function isNumericRangeToken(token) {
  const cleaned = token.replace(/[[\]():,;]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/\d/.test(cleaned)) return false;
  return /^[<>]?\s*[-+]?\d+(?:\.\d+)?(?:\s*[-–—]\s*[<>]?\s*[-+]?\d+(?:\.\d+)?)?$/.test(cleaned)
    || /^[-+]?\d+(?:\.\d+)?\s*[-–—]\s*[-+]?\d+(?:\.\d+)?$/.test(cleaned);
}

/** "25-OH", "1,25-dihydroxy", "25(oh)d": a number glued into the TEST NAME. */
function isNameNumberToken(token) {
  if (!/\d/.test(token)) return false;
  const m = token.match(/^[-+]?[\d.,]+(.*)$/);
  if (!m) return false;
  const rest = m[1];
  if (!rest) return false;
  if (/^[-–—(]/.test(rest)) return true;                       // 25-OH, 25(oh)d, 1,25-dihydroxy
  if (/^[a-z]{2,}/i.test(rest)) return !isUnitLikeSuffix(rest); // 25hydroxy vs 18ng/mL
  return false;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NUMBER_RE = /[-+]?\d{1,5}(?:[.,]\d{1,3})?(?:\.\d+)?/g;

/**
 * Pattern index — the dictionary's aliases, precompiled once per process.
 *
 * 1,160+ markers × aliases is far too many regexes to test against every line
 * of a report, so candidates are selected by a 3-gram prefilter of the alias's
 * own leading characters. That is exactly equivalent to testing every pattern
 * (a literal alias can only match if its first three characters appear), just
 * ~50× cheaper. Verified by the extraction test suite, which asserts identical
 * behaviour on the demo report and on adversarial lines.
 */
/**
 * Builds the separator-flexible matcher for an alias: alphanumeric runs stay
 * literal, separators between them become "one to three non-alphanumerics".
 * So "bilirubin total" matches "Bilirubin, Total", "24 hr calcium urine"
 * matches "24 Hr Calcium (Urine)", while short tokens like "hdl" stay exact.
 */
function aliasSeparatorPattern(alias) {
  const runs = alias.split(/[^a-z0-9]+/).filter(Boolean).map(escapeRegex);
  if (runs.length === 0) return '$^';
  return `(^|[^a-z0-9])(${runs.join('[^a-z0-9]{1,3}')})($|[^a-z0-9])`;
}

let PATTERN_INDEX = null;

function patternIndex() {
  if (PATTERN_INDEX) return PATTERN_INDEX;
  let entries = [];
  try {
    entries = aliasEntries(); // longest alias first
  } catch {
    entries = [];
  }
  const patterns = [];
  for (const entry of entries) {
    try {
      if (!entry || typeof entry.alias !== 'string' || !entry.alias) continue;
      // Separators are flexible: a report prints "Bilirubin, Total" or
      // "Albumin, Body Fluid (Other Body Fluid)" while the alias stores word
      // runs separated by single spaces. The literal path is tried first (fast);
      // this regex is the fallback that keeps those labels matchable.
      patterns.push({
        id: patterns.length,
        code: entry.code,
        alias: entry.alias,
        def: entry.def,
        len: entry.alias.length,
        re: new RegExp(aliasSeparatorPattern(entry.alias), 'i'),
      });
    } catch {
      continue; // one bad alias never blocks the whole index
    }
  }
  const byPrefix = new Map();
  const shortAliases = [];
  for (const p of patterns) {
    const prefix = p.alias.slice(0, 3).toLowerCase();
    if (prefix.length < 3) shortAliases.push(p);
    else {
      let bucket = byPrefix.get(prefix);
      if (!bucket) byPrefix.set(prefix, (bucket = []));
      bucket.push(p);
    }
  }
  PATTERN_INDEX = {
    patterns,
    byPrefix,
    shortAliases,
    seen: new Int32Array(patterns.length), // epoch marks, so candidate collection allocates nothing
    candidates: new Array(patterns.length),
    gen: 0,
  };
  return PATTERN_INDEX;
}

/** Test seam: rebuild the index (used after a knowledge rebuild). */
export function resetPatternIndex() {
  PATTERN_INDEX = null;
}

const isWordChar = (c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');

/**
 * Literal first-match with the same word-boundary rule the regex used to
 * enforce — `(^|[^a-z0-9])alias($|[^a-z0-9])` on an already-lowercased line.
 * `indexOf` over a literal alias is several times faster than a regex test,
 * which matters once the dictionary carries ~2,700 aliases.
 */
/**
 * Unit spellings the extractor recognises after a value. Boundary-anchored on
 * the left so "g/dl" can never match inside "ug/dl".
 */
/**
 * Same alternation, anchored: does a unit spelling START this text (modulo
 * leading blanks)? Used by the glued-value check.
 */
export const UNIT_AT_START_RE =
  /^\s*(mg\/dl|mmol\/l|ug\/dl|µg\/dl|g\/dl|g\/l|u\/l|iu\/l|uiu\/ml|µiu\/ml|miu\/l|miu\/ml|ng\/ml|pg\/ml|pmol\/l|nmol\/l|umol\/l|µmol\/l|mmol\/mol|10\^3\/ul|10\^3\/µl|x10\^3\/ul|x10\^3\/µl|10\^6\/ul|10\^6\/µl|10\^9\/l|k\/ul|m\/ul|ml\/min\/1\.73m2|ml\/min|mm\/hr|meq\/l|fl|pg|%)/i;

export const UNIT_TOKEN_RE =
  /(?:^|[^a-z0-9])(mg\/dl|mmol\/l|ug\/dl|µg\/dl|g\/dl|g\/l|u\/l|iu\/l|uiu\/ml|µiu\/ml|miu\/l|miu\/ml|ng\/ml|pg\/ml|pmol\/l|nmol\/l|umol\/l|µmol\/l|mmol\/mol|10\^3\/ul|10\^3\/µl|x10\^3\/ul|x10\^3\/µl|10\^6\/ul|10\^6\/µl|10\^9\/l|k\/ul|m\/ul|ml\/min\/1\.73m2|ml\/min|mm\/hr|meq\/l|fl|pg|%)/i;

/**
 * OCR often glues a value to its label ("HbA1c5.7 %", "Sodium139 mmol/L").
 * A label immediately followed by a number is only accepted when that number is
 * followed by a unit within a short window — otherwise "CD45" would be read as
 * CD4, or "Vitamin D3" as vitamin D.
 */
function gluedValueBoundary(line, aliasEnd) {
  const ahead = line.slice(aliasEnd, aliasEnd + 24);
  const m = ahead.match(/^(\d+(?:\.\d+)?)/);
  if (!m) return false;
  // The unit must follow the glued number directly: "HbA1c5.7 %" and
  // "Sodium139 mmol/L" pass; "Vitamin D3 40 ng/mL" does not (3 is part of the
  // test name, 40 is the value).
  return UNIT_AT_START_RE.test(ahead.slice(m[1].length));
}

function boundaryMatch(line, alias) {
  let from = 0;
  for (;;) {
    const idx = line.indexOf(alias, from);
    if (idx < 0) return -1;
    const before = idx === 0 ? '' : line[idx - 1];
    const after = idx + alias.length >= line.length ? '' : line[idx + alias.length];
    if ((before === '' || !isWordChar(before)) && (after === '' || !isWordChar(after))) return idx;
    from = idx + 1;
  }
}

/** Every alias in `line`, using a 3-gram prefilter to avoid testing all of them. */
function findHits(lowerLine, index) {
  try {
    if (typeof lowerLine !== 'string' || !index || !index.byPrefix || !index.seen || !index.candidates) return [];
    if (lowerLine.length === 0) return [];
    index.gen += 1;
  const { seen, candidates } = index;
  const gen = index.gen;
  let n = 0;
  const push = (p) => {
    if (seen[p.id] !== gen) {
      seen[p.id] = gen;
      candidates[n++] = p;
    }
  };
  for (const p of index.shortAliases) push(p);
  const max = lowerLine.length - 2;
  for (let i = 0; i < max; i += 1) {
    const bucket = index.byPrefix.get(lowerLine.slice(i, i + 3));
    if (bucket) for (const p of bucket) push(p);
  }
  const hits = [];
  for (let i = 0; i < n; i += 1) {
    const p = candidates[i];
    if (!p || typeof p.alias !== 'string' || !p.re) continue;
    let at = -1;
    try {
      at = boundaryMatch(lowerLine, p.alias);
    } catch {
      at = -1;
    }
    if (at >= 0) {
      hits.push({ code: p.code, alias: p.alias, def: p.def, index: at, endIndex: at + p.len });
      continue;
    }
    // Trailing-boundary failure only (a label glued to its value): retry it.
    const glued = lowerLine.indexOf(p.alias);
    if (glued >= 0) {
      const before = glued === 0 ? '' : lowerLine[glued - 1];
      const after = glued + p.len >= lowerLine.length ? '' : lowerLine[glued + p.len];
      if ((before === '' || !isWordChar(before)) && after && /[0-9]/.test(after)
        && gluedValueBoundary(lowerLine, glued + p.len)) {
        hits.push({ code: p.code, alias: p.alias, def: p.def, index: glued, endIndex: glued + p.len });
        continue;
      }
    }
    let m = null;
    try {
      m = lowerLine.match(p.re);
    } catch {
      m = null;
    }
    if (m) {
      hits.push({ code: p.code, alias: p.alias, def: p.def, index: m.index + m[1].length, endIndex: m.index + m[1].length + m[2].length });
    }
  }
    return hits;
  } catch {
    return [];
  }
}

/**
 * Rule-based extraction of lab values from OCR/plain text.
 *
 * Safety design (per product spec): extraction is a DRAFT. Everything it emits
 * carries a confidence score and the raw line it came from, and all rows enter
 * the database with verified=0. Only explicit user verification promotes values
 * into trend/risk computation.
 *
 * Knowledge layer (see knowledge/README.md):
 *   - the OCR text is normalized first (glyph confusions, unit spellings) and
 *     every change is reported back in `normalization`
 *   - a value outside the analyte's PHYSICAL plausibility bounds is flagged
 *     `suspicious` with a reason, and its confidence is halved — it is never
 *     silently stored as a normal reading
 *   - `confidence` is the calibrated probability that the row is correct
 *     (trained offline from a documented OCR-noise model; see
 *     scripts/knowledge/train.js). `heuristicConfidence` keeps the original
 *     transparent rule score for auditability.
 *   - qualitative markers (morphology findings, screens) are never matched here
 */
export class LabExtractionService {
  constructor() {
    this.aliasEntries = aliasEntries();
  }

  /**
   * @param {string} text raw report text
   * @param {{normalize?: boolean}} [opts]
   * @returns {{ extracted: Array, detectedReportDate: string|null, lineCount: number, normalization: object }}
   */
  extract(text, { normalize = true } = {}) {
    // Total function: hostile input (null bytes, huge blobs, non-strings)
    // degrades to "nothing extracted", never throws.
    let raw = '';
    try {
      raw = typeof text === 'string' ? text : String(text ?? '');
    } catch {
      raw = '';
    }
    // Hard caps: a single report's worth of text; beyond this we truncate
    // rather than burn CPU on a pathological upload.
    if (raw.length > 200_000) raw = raw.slice(0, 200_000);
    raw = raw.replace(/\0/g, '');
    let normalization;
    try {
      normalization = normalize
        ? normalizeOcrText(raw)
        : { text: raw, corrections: [], flags: [], changedLines: 0 };
    } catch {
      normalization = { text: raw, corrections: [], flags: [], changedLines: 0 };
    }

    const lines = String(normalization.text || '')
      .split(/\r?\n/)
      .map((l) => l.trim().slice(0, 2000))
      .filter(Boolean)
      .slice(0, 2000);

    const extracted = [];
    let detectedReportDate = null;
    try {
      detectedReportDate = this.detectDate(lines);
    } catch {
      detectedReportDate = null;
    }
    let index;
    try {
      index = patternIndex();
    } catch {
      return { extracted, detectedReportDate, lineCount: lines.length, normalization: safeNormalization(normalization) };
    }

    // Which repairs were needed on which line — evidence about reading quality
    // that the calibration model uses (see calibration.js).
    const repairsByLine = new Map();
    try {
      for (const c of normalization.corrections || []) {
        if (!c || typeof c.line !== 'string') continue;
        const set = repairsByLine.get(c.line) ?? new Set();
        set.add(c.type);
        repairsByLine.set(c.line, set);
      }
    } catch {
      /* repairs are advisory */
    }
    const repairsFor = (line) => repairsByLine.get(line) || EMPTY_SET;

    for (const line of lines) {
      try {
        const lower = line.toLowerCase();
        // Skip lines that are obviously headers/footers (no digits at all).
        if (!/\d/.test(lower)) continue;

        const hits = findHits(lower, index);
        if (hits.length === 0) continue;

        // If several aliases match the same line, keep the FIRST positional,
        // longest-alias hit (dictionary is pre-sorted longest-first). When two
        // markers match at the same position with the same alias length, prefer
        // the curated marker, then the more common one — a tie must never be
        // resolved by object key order.
        hits.sort(
          (a, b) =>
            a.index - b.index ||
            b.alias.length - a.alias.length ||
            Number(!!b.def?.typicalRange) - Number(!!a.def?.typicalRange) ||
            (b.def?.prevalence || 0) - (a.def?.prevalence || 0),
        );
        const hit = hits[0];
        if (!hit || !hit.def) continue;

        let parsed;
        try {
          parsed = this.parseLineAfter(line, hit);
        } catch {
          continue;
        }
        if (!parsed || parsed.value == null || !Number.isFinite(parsed.value)) continue;

        const unit = parsed.unit
          ? (hit.def.units || []).includes(parsed.unit)
            ? hit.def.defaultUnit // canonical casing from the dictionary
            : parsed.unit
          : hit.def.defaultUnit;

        let plausibility = { plausible: true, reason: null };
        try {
          plausibility = checkPlausibility(hit.code, parsed.value) || plausibility;
        } catch {
          /* plausibility is advisory — a bad bounds table never blocks a draft */
        }
        const heuristicConfidence = parsed.confidence;
        const repairs = repairsFor(line);
        const calibrated = calibrateExtraction({
          code: hit.code,
          heuristicConfidence,
          hasUnit: Boolean(unit),
          hasReferenceRange: parsed.refLow != null || parsed.refHigh != null,
          aliasLength: hit.alias.length,
          aliasAtLineStart: hit.index === 0,
          suspicious: !plausibility.plausible,
          glyphRepaired: repairs.has('digit-glyph') || repairs.has('value-unit-split'),
          decimalRepaired: repairs.has('decimal-comma') || repairs.has('decimal-glyph'),
          marker: hit.def,
        });
        const confidence = !plausibility.plausible
          ? Math.max(0.05, Math.round(calibrated * 0.5 * 100) / 100)
          : calibrated;

        extracted.push({
          code: hit.code,
          testName: hit.def.name,
          value: parsed.value,
          unit,
          refLow: parsed.refLow,
          refHigh: parsed.refHigh,
          confidence,
          heuristicConfidence,
          rawLine: line,
          // Knowledge-layer context (surfaced in the review UI):
          loinc: hit.def.loinc ?? null,
          panel: hit.def.panel ?? null,
          specimen: hit.def.specimen ?? null,
          rangeSource: parsed.refLow != null || parsed.refHigh != null ? 'report' : hit.def.typicalRange ? 'typical-default' : 'none',
          suspicious: !plausibility.plausible,
          suspiciousReason: plausibility.reason ?? null,
          matchedAlias: hit.alias,
        });
      } catch {
        continue; // one hostile line never kills the whole extraction
      }
    }

    return {
      extracted,
      detectedReportDate,
      lineCount: lines.length,
      normalization: safeNormalization(normalization),
    };
  }

  /**
   * Parse the value / unit / reference range that follow a matched alias
   * on a single report line.
   */
  parseLineAfter(line, hit) {
    const EMPTY = { value: null, unit: null, refLow: null, refHigh: null, confidence: 0 };
    try {
      if (typeof line !== 'string' || !hit || !Number.isFinite(hit.endIndex)) return EMPTY;
      const rest = line.slice(hit.endIndex);
    const cleaned = rest.replace(/[:=]/g, ' ');
    const tokens = cleaned.split(/\s+/).filter(Boolean);

    let value = null;
    let unit = null;
    let refLow = null;
    let refHigh = null;

    // 1) value: first standalone number. Parenthesized/range-looking tokens
    //    END the value scan — a line that starts with "(4.0 - 5.6)" carries
    //    only a range, and the range top must never be misread as the value.
    for (let i = 0; i < tokens.length && value == null; i += 1) {
      const t = tokens[i];
      if (t.startsWith('(') || t.startsWith('[')) {
        // "(SGPT)" / "(Urine)" / "(25-OH)" are part of the test NAME: skipped.
        // A parenthesised RANGE ends the scan — the top of a range must never
        // be misread as the result.
        const inner = t.replace(/^[(\[]+/, '').replace(/[)\]]:?,?$/, '');
        if (isNumericRangeToken(inner)) break;
        continue;
      }
      if (t.endsWith(')')) continue;
      // A number glued to a name-like suffix is part of the TEST NAME, not the
      // result: "25-OH Vitamin D 18 ng/mL" must read 18, not 25.
      if (isNameNumberToken(t)) continue;
      const m = t.match(/^([-+]?(?:\d+(?:\.\d+)?|\.\d+))\/?([A-Za-zµ%/^]*)/);
      if (m) {
        const num = Number(m[1]);
        if (Number.isFinite(num)) {
          value = num;
          const attached = m[2] || '';
          if (attached.length > 1) unit = attached.replace(/^\//, '');
        }
      }
    }
    if (value == null) return { value: null, unit: null, refLow: null, refHigh: null, confidence: 0 };

    // 2) unit: search tokens near the value for a known unit spelling.
    const unitMatch = rest.match(UNIT_TOKEN_RE);
    if (unitMatch) unit = unitMatch[1];

    unit = canonicalUnit(unit);

    // 3) reference range patterns, in priority order:
    const rangePatterns = [
      /(?:ref(?:erence)?\s*(?:range|interval)?[:\s]*)\s*\(?\s*([-+]?\d+(?:\.\d+)?)\s*[-–—to]+\s*([-+]?\d+(?:\.\d+)?)\s*\)?/i,
      /\(\s*([-+]?\d+(?:\.\d+)?)\s*[-–—]\s*([-+]?\d+(?:\.\d+)?)\s*\)/,                     // (70 - 100)
      /\b([-+]?\d+(?:\.\d+)?)\s*[-–—]\s*([-+]?\d+(?:\.\d+)?)\b/,                           // 70 - 100
    ];
    for (const re of rangePatterns) {
      const m = rest.match(re);
      if (m) {
        const lo = Number(m[1]);
        const hi = Number(m[2]);
        if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
          refLow = lo;
          refHigh = hi;
          break;
        }
      }
    }
    // one-sided bounds: "<200", "upto 150", ">40"
    if (refHigh == null) {
      const mLess = rest.match(/(?:<|less than|upto|up to|below)\s*([-+]?\d+(?:\.\d+)?)/i);
      if (mLess) refHigh = Number(mLess[1]);
    }
    if (refLow == null) {
      const mMore = rest.match(/(?:>|greater than|above)\s*([-+]?\d+(?:\.\d+)?)/i);
      if (mMore) refLow = Number(mMore[1]);
    }
    // tabular fallback: two stray numbers AFTER the value, e.g. "| 30 | 150".
    if (refLow == null && refHigh == null) {
      const restNoUnit = unit ? rest.replace(new RegExp(escapeRegex(unit), 'i'), ' ') : rest;
      const nums = (restNoUnit.match(/[-+]?\d+(?:\.\d+)?/g) || []).map(Number);
      const after = nums.filter((n, idx) => !(idx === 0 && n === value)); // drop the value itself
      if (after.length >= 2 && after[1] > after[0]) {
        refLow = after[0];
        refHigh = after[1];
      }
    }

      // Heuristic confidence model — deliberately transparent and still the base
      // of the calibrated score (calibration only remaps it monotonically):
      let confidence = 0.5;
      if (unit) confidence += 0.1;
      if (refLow != null || refHigh != null) confidence += 0.15;
      if ((hit.alias || '').length >= 5) confidence += 0.1; // longer alias == fewer false matches
      confidence = Math.min(confidence, 0.98);

      return { value, unit, refLow, refHigh, confidence };
    } catch {
      return EMPTY;
    }
  }

  /** Best-effort report date detection from common header formats. */
  detectDate(lines) {
    try {
      const list = Array.isArray(lines) ? lines : [];
      const head = list.slice(0, 12).join('\n');
      const patterns = [
        /(?:date|report date|sample date|collection date|printed on)[:\-\s]*(\d{4}-\d{2}-\d{2})/i,
        /(?:date|report date|sample date|collection date|printed on)[:\-\s]*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/i,
        /\b(\d{4}-\d{2}-\d{2})\b/,
      ];
      const validIsoDay = (y, m, d) => {
        if (![y, m, d].every((n) => Number.isInteger(n))) return null;
        if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
        const dt = new Date(Date.UTC(y, m - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
        return dt.toISOString();
      };
      const p1 = head.match(patterns[0]);
      if (p1) {
        const [y, m, d] = p1[1].split('-').map(Number);
        const valid = validIsoDay(y, m, d);
        if (valid) return valid;
      }
      const p2 = head.match(patterns[1]);
      if (p2) {
        let day = Number(p2[1]);
        let mon = Number(p2[2]);
        const year = Number(p2[3]);
        if ([day, mon, year].every((n) => Number.isInteger(n))) {
          if (mon > 12 && day <= 12) [day, mon] = [mon, day]; // only mm/dd when dd/mm impossible
          const valid = validIsoDay(year, mon, day);
          if (valid) return valid;
        }
      }
      const p3 = head.match(patterns[2]);
      if (p3) {
        const [y, m, d] = p3[1].split('-').map(Number);
        const valid = validIsoDay(y, m, d);
        if (valid) return valid;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * The dictionary clients may render — now sourced from the knowledge base.
   * @param {{tier?: 'core'|'all'}} [opts] core (default) keeps the response
   *   small enough for a phone; 'all' exposes every catalogued marker.
   */
  dictionary({ tier = 'core' } = {}) {
    const out = {};
    const dict = LAB_DICTIONARY && typeof LAB_DICTIONARY === 'object' ? LAB_DICTIONARY : {};
    for (const [code, def] of Object.entries(dict)) {
      if (!def) continue;
      if (tier !== 'all' && def.tier && def.tier !== 'core') continue;
      out[code] = {
        name: def.name,
        defaultUnit: def.defaultUnit,
        typicalRange: def.typicalRange ?? null,
        betterDirection: def.betterDirection ?? null,
        loinc: def.loinc ?? null,
        panel: def.panel ?? null,
        specimen: def.specimen ?? null,
        tier: def.tier ?? 'core',
        valueKind: def.valueKind ?? 'numeric',
        rangeSource: def.rangeSource ?? (def.typicalRange ? 'typical-default' : 'report-only'),
        narrative: def.narrative ?? null,
        narrativeStatus: def.narrativeStatus ?? null,
        plausibilityBounds: def.plausibilityBounds ?? null,
      };
    }
    return out;
  }
}

/** Normalization block for API consumers — structurally guaranteed, never throws. */
function safeNormalization(normalization) {
  try {
    const n = normalization && typeof normalization === 'object' ? normalization : {};
    return {
      changedLines: Number.isFinite(Number(n.changedLines)) ? Number(n.changedLines) : 0,
      corrections: Array.isArray(n.corrections) ? n.corrections.slice(0, 500) : [],
      flags: Array.isArray(n.flags) ? n.flags.slice(0, 50) : [],
    };
  } catch {
    return { changedLines: 0, corrections: [], flags: [] };
  }
}
