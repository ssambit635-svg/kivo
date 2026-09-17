import { aliasEntries, LAB_DICTIONARY } from './labDictionary.js';
import { checkPlausibility } from '../../knowledge/clinicalKnowledge.js';
import { normalizeOcrText } from '../../knowledge/textNormalizer.js';
import { calibrateExtraction } from '../../knowledge/calibration.js';

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
let PATTERN_INDEX = null;

function patternIndex() {
  if (PATTERN_INDEX) return PATTERN_INDEX;
  const entries = aliasEntries(); // longest alias first
  const patterns = entries.map((entry, id) => ({
    id,
    code: entry.code,
    alias: entry.alias,
    def: entry.def,
    len: entry.alias.length,
  }));
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
    const at = boundaryMatch(lowerLine, p.alias);
    if (at >= 0) hits.push({ code: p.code, alias: p.alias, def: p.def, index: at, endIndex: at + p.len });
  }
  return hits;
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
    const raw = String(text || '');
    const normalization = normalize
      ? normalizeOcrText(raw)
      : { text: raw, corrections: [], flags: [], changedLines: 0 };

    const lines = normalization.text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const extracted = [];
    const detectedReportDate = this.detectDate(lines);
    const index = patternIndex();

    for (const line of lines) {
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
          Number(!!b.def.typicalRange) - Number(!!a.def.typicalRange) ||
          (b.def.prevalence || 0) - (a.def.prevalence || 0),
      );
      const hit = hits[0];

      const parsed = this.parseLineAfter(line, hit);
      if (parsed.value == null) continue;

      const unit = parsed.unit
        ? hit.def.units.includes(parsed.unit)
          ? hit.def.defaultUnit // canonical casing from the dictionary
          : parsed.unit
        : hit.def.defaultUnit;

      const plausibility = checkPlausibility(hit.code, parsed.value);
      const heuristicConfidence = parsed.confidence;
      const calibrated = calibrateExtraction({
        code: hit.code,
        heuristicConfidence,
        hasUnit: Boolean(unit),
        hasReferenceRange: parsed.refLow != null || parsed.refHigh != null,
        aliasLength: hit.alias.length,
        aliasAtLineStart: hit.index === 0,
        suspicious: !plausibility.plausible,
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
        suspiciousReason: plausibility.reason,
        matchedAlias: hit.alias,
      });
    }

    return {
      extracted,
      detectedReportDate,
      lineCount: lines.length,
      normalization: {
        changedLines: normalization.changedLines,
        corrections: normalization.corrections,
        flags: normalization.flags,
      },
    };
  }

  /**
   * Parse the value / unit / reference range that follow a matched alias
   * on a single report line.
   */
  parseLineAfter(line, hit) {
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
      if (t.startsWith('(') || /^\d+(?:\.\d+)?[-–—]\d+(?:\.\d+)?$/.test(t)) break;
      if (t.endsWith(')')) continue;
      // A number glued to a name-like suffix is part of the TEST NAME, not the
      // result: "25-OH Vitamin D 18 ng/mL" must read 18, not 25.
      if (/^\d+(?:\.\d+)?\s*[-–—]\s*[a-z]{1,6}$/i.test(t)) continue;
      const m = t.match(/^([-+]?\d+(?:\.\d+)?)\/?([A-Za-zµ%/^]*)/);
      if (m) {
        const num = Number(m[1]);
        if (Number.isFinite(num)) {
          value = num;
          const attached = (m[2] || '').toLowerCase();
          if (attached && attached.length > 1) unit = attached.replace(/^\//, '');
        }
      }
    }
    if (value == null) return { value: null, unit: null, refLow: null, refHigh: null, confidence: 0 };

    // 2) unit: search tokens near the value for a known unit spelling.
    const unitMatch = rest.match(
      /(?:^|[^a-z0-9])(mg\/dl|mmol\/l|ug\/dl|µg\/dl|g\/dl|g\/l|u\/l|iu\/l|uiu\/ml|µiu\/ml|miu\/l|miu\/ml|ng\/ml|pg\/ml|pmol\/l|nmol\/l|umol\/l|µmol\/l|mmol\/mol|10\^3\/ul|x10\^3\/ul|k\/ul|m\/ul|ml\/min\/1\.73m2|ml\/min|mm\/hr|meq\/l|fl|pg|%)/i,
    );
    if (unitMatch) unit = unitMatch[1].toLowerCase();

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
    if (hit.alias.length >= 5) confidence += 0.1; // longer alias == fewer false matches
    confidence = Math.min(confidence, 0.98);

    return { value, unit, refLow, refHigh, confidence };
  }

  /** Best-effort report date detection from common header formats. */
  detectDate(lines) {
    const head = lines.slice(0, 12).join('\n');
    const patterns = [
      /(?:date|report date|sample date|collection date|printed on)[:\-\s]*(\d{4}-\d{2}-\d{2})/i,
      /(?:date|report date|sample date|collection date|printed on)[:\-\s]*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/i,
      /\b(\d{4}-\d{2}-\d{2})\b/,
    ];
    const p1 = head.match(patterns[0]);
    if (p1) return `${p1[1]}T00:00:00.000Z`;
    const p2 = head.match(patterns[1]);
    if (p2) {
      let [, day, mon] = p2.map(Number);
      const year = Number(p2[3]);
      if (mon > 12 && day <= 12) [day, mon] = [mon, day]; // only mm/dd when dd/mm impossible
      return new Date(Date.UTC(year, mon - 1, day)).toISOString();
    }
    const p3 = head.match(patterns[2]);
    if (p3) return `${p3[1]}T00:00:00.000Z`;
    return null;
  }

  /**
   * The dictionary clients may render — now sourced from the knowledge base.
   * @param {{tier?: 'core'|'all'}} [opts] core (default) keeps the response
   *   small enough for a phone; 'all' exposes every catalogued marker.
   */
  dictionary({ tier = 'core' } = {}) {
    const out = {};
    for (const [code, def] of Object.entries(LAB_DICTIONARY)) {
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
