import { aliasEntries, LAB_DICTIONARY } from './labDictionary.js';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NUMBER_RE = /[-+]?\d{1,5}(?:[.,]\d{1,3})?(?:\.\d+)?/g;

/**
 * Rule-based extraction of lab values from OCR/plain text.
 *
 * Safety design (per product spec): extraction is a DRAFT. Everything it
 * emits carries a confidence score and the raw line it came from, and all
 * rows enter the database with verified=0. Only explicit user verification
 * promotes values into trend/risk computation.
 */
export class LabExtractionService {
  constructor() {
    this.aliasEntries = aliasEntries();
    this.aliasPatterns = this.aliasEntries.map(({ code, alias, def }) => ({
      code,
      alias,
      def,
      re: new RegExp(`(^|[^a-z0-9])(${escapeRegex(alias)})($|[^a-z0-9])`, 'i'),
    }));
  }

  /**
   * @param {string} text raw report text
   * @returns {{ extracted: Array, detectedReportDate: string|null, lineCount: number }}
   */
  extract(text) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const extracted = [];
    const detectedReportDate = this.detectDate(lines);

    for (const line of lines) {
      const lower = line.toLowerCase();
      // Skip lines that are obviously headers/footers (no digits at all).
      if (!/\d/.test(lower)) continue;

      const hits = [];
      for (const pat of this.aliasPatterns) {
        const m = lower.match(pat.re);
        if (m && m.index !== undefined) {
          hits.push({ ...pat, index: m.index + m[1].length, endIndex: m.index + m[1].length + m[2].length });
        }
      }
      if (hits.length === 0) continue;

      // If several aliases match the same line, keep the FIRST positional,
      // longest-alias hit (dictionary is pre-sorted longest-first).
      hits.sort((a, b) => a.index - b.index || b.alias.length - a.alias.length);
      const hit = hits[0];

      const parsed = this.parseLineAfter(line, hit);
      if (parsed.value == null) continue;

      const unit = parsed.unit
        ? hit.def.units.includes(parsed.unit)
          ? hit.def.defaultUnit // canonical casing from the dictionary
          : parsed.unit
        : hit.def.defaultUnit;

      extracted.push({
        code: hit.code,
        testName: hit.def.name,
        value: parsed.value,
        unit,
        refLow: parsed.refLow,
        refHigh: parsed.refHigh,
        confidence: parsed.confidence,
        rawLine: line,
      });
    }

    return { extracted, detectedReportDate, lineCount: lines.length };
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
      /(mg\/dl|mmol\/l|g\/dl|g\/l|u\/l|iu\/l|uiu\/ml|µiu\/ml|miu\/l|ng\/ml|pg\/ml|pmol\/l|umol\/l|10\^3\/ul|k\/ul|ml\/min\/1\.73m2|ml\/min|mmol\/mol|%)/i,
    );
    if (unitMatch) unit = unitMatch[1].toLowerCase();

    // 3) reference range patterns, in priority order:
    const rangePatterns = [
      /(?:ref(?:erence)?\s*(?:range|interval)?[:\s]*)\(?\s*([-+]?\d+(?:\.\d+)?)\s*[-–—to]+\s*([-+]?\d+(?:\.\d+)?)\s*\)?/i,
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

    // Confidence model — deliberately transparent:
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

  dictionary() {
    return Object.fromEntries(
      Object.entries(LAB_DICTIONARY)
        .filter(([, def]) => def)
        .map(([code, def]) => [code, { name: def.name, defaultUnit: def.defaultUnit, typicalRange: def.typicalRange, betterDirection: def.betterDirection }]),
    );
  }
}
