import { LAB_DICTIONARY } from './labs/labDictionary.js';

/**
 * Longitudinal Trend Engine (Layer 3 of the AI architecture).
 *
 * Input: verified lab values only (repository enforces). For each marker:
 * points over time, first→last deltas, per-point range status, direction
 * (with a *better-direction* interpretation only where the dictionary
 * declares one), least-squares slope for 3+ points, and "meaningful change"
 * detection (% change beyond threshold OR range-status crossing).
 *
 * Robustness contract: analyze() is total over dirty input — null rows,
 * NaN values, invalid dates and unknown codes degrade to an empty analysis,
 * never throw. One corrupt lab row must never take down a trends response.
 */
export class TrendService {
  constructor(labResultRepository) {
    this.labs = labResultRepository;
    this.MEANINGFUL_PCT = 10; // % change considered meaningful (prototype heuristic)
    this.STABLE_PCT = 5; // below this, treat as stable
  }

  analyze(code, points) {
    const safeCode = typeof code === 'string' && code ? code : 'unknown';
    try {
      const def = (LAB_DICTIONARY && LAB_DICTIONARY[safeCode]) || {};
      const rows = Array.isArray(points) ? points : [];
      // Never trust caller ordering — the engine owns chronological order.
      // Rows without a finite value carry no trend information and are
      // dropped (a null/NaN value must never produce NaN deltas).
      const series = rows
        .filter((r) => r && Number.isFinite(Number(r.value)))
        .map((r) => ({
          id: r.id,
          reportId: r.report_id,
          value: Number(r.value),
          unit: r.unit,
          refLow: finiteOrNull(r.ref_low),
          refHigh: finiteOrNull(r.ref_high),
          measuredAt: r.measured_at,
        }))
        .sort((a, b) => timeOf(a.measuredAt) - timeOf(b.measuredAt));

      if (series.length === 0) {
        return { code: safeCode, points: [], message: 'No verified data for this marker yet' };
      }

      const range = this.effectiveRange(series, def);
      const enriched = series.map((p) => ({ ...p, status: this.pointStatus(p, range) }));

      const first = enriched[0];
      const last = enriched[enriched.length - 1];
      const rawDelta = last.value - first.value;
      const deltaAbs = Number.isFinite(rawDelta) ? round2(rawDelta) : null;
      const deltaPct = first.value !== 0 && deltaAbs != null && Number.isFinite(deltaAbs / first.value)
        ? round1((deltaAbs / first.value) * 100)
        : null;

      let direction = 'stable';
      if (deltaPct != null && Number.isFinite(deltaPct)) {
        if (Math.abs(deltaPct) < this.STABLE_PCT) direction = 'stable';
        else direction = deltaPct > 0 ? 'increasing' : 'decreasing';
      }

      const interpretation = this.interpret(direction, def.betterDirection);
      const statusTransitions = this.transitions(enriched);
      const meaningfulChange =
        (deltaPct != null && Math.abs(deltaPct) >= this.MEANINGFUL_PCT) || statusTransitions.length > 0;

      const slope = series.length >= 3 ? this.leastSquaresSlope(enriched) : null;

      return {
        code: safeCode,
        markerName: def.name || safeCode,
        pointCount: enriched.length,
        firstAt: first.measuredAt,
        latestAt: last.measuredAt,
        latestValue: last.value,
        unit: last.unit || def.defaultUnit || null,
        referenceRange: range,
        latestStatus: last.status,
        direction,
        interpretation,
        deltaAbs,
        deltaPct,
        meaningfulChange,
        slopePerDay: slope,
        statusTransitions,
        points: enriched,
        notes: [
          'Only user-verified values are included in this analysis.',
          'Reference ranges come from the lab reports themselves when available; otherwise typical adult defaults (see dictionary) are used.',
        ],
      };
    } catch {
      return { code: safeCode, points: [], message: 'This marker could not be analyzed from the stored data' };
    }
  }

  /** Trends across all markers with >= minPoints verified points, for a member. */
  analyzeMember(memberId, { minPoints = 2 } = {}) {
    try {
      if (!memberId) return [];
      const min = Number.isFinite(Number(minPoints)) ? Math.max(1, Number(minPoints)) : 2;
      const codes = this.labs.codesWithVerifiedData(memberId, min) || [];
      const out = [];
      for (const code of codes) {
        try {
          const pts = this.labs.seriesForMember(memberId, code) || [];
          out.push(this.analyze(code, pts));
        } catch {
          continue; // one bad marker series never kills the member analysis
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  analyzeCode(memberId, code) {
    if (!memberId || !code || !LAB_DICTIONARY || !LAB_DICTIONARY[code]) return null;
    try {
      return this.analyze(code, this.labs.seriesForMember(memberId, code) || []);
    } catch {
      return { code, points: [], message: 'This marker could not be analyzed from the stored data' };
    }
  }

  // ---------------------------------------------------------------- internals
  effectiveRange(series, def) {
    try {
      // The most recent point's own stored range wins (report source of truth).
      const latestWithRange = [...series].reverse().find((p) => p.refLow != null || p.refHigh != null);
      if (latestWithRange) {
        return {
          low: latestWithRange.refLow,
          high: latestWithRange.refHigh,
          source: 'report',
        };
      }
      const t = (def && def.typicalRange) || {};
      return { low: finiteOrNull(t.low), high: finiteOrNull(t.high), source: 'typical-default' };
    } catch {
      return { low: null, high: null, source: 'typical-default' };
    }
  }

  pointStatus(p, range) {
    try {
      const v = Number(p?.value);
      if (!Number.isFinite(v)) return 'unknown';
      const r = range || {};
      const hi = r.high != null ? Number(r.high) : null;
      const lo = r.low != null ? Number(r.low) : null;
      if (hi != null && Number.isFinite(hi) && v > hi) return 'high';
      if (lo != null && Number.isFinite(lo) && v < lo) return 'low';
      if ((hi != null && Number.isFinite(hi)) || (lo != null && Number.isFinite(lo))) return 'normal';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  interpret(direction, betterDirection) {
    if (direction === 'stable') return 'stable';
    if (!betterDirection) return 'changed';
    const improved =
      (direction === 'decreasing' && betterDirection === 'lower') ||
      (direction === 'increasing' && betterDirection === 'higher');
    return improved ? 'moving_toward_typical_direction' : 'moving_away_from_typical_direction';
  }

  transitions(enriched) {
    const out = [];
    try {
      const list = Array.isArray(enriched) ? enriched : [];
      for (let i = 1; i < list.length; i += 1) {
        if (list[i]?.status !== list[i - 1]?.status) {
          out.push({
            from: list[i - 1]?.status ?? 'unknown',
            to: list[i]?.status ?? 'unknown',
            at: list[i]?.measuredAt ?? null,
          });
        }
      }
    } catch {
      /* transitions are advisory */
    }
    return out;
  }

  leastSquaresSlope(enriched) {
    try {
      const list = Array.isArray(enriched) ? enriched : [];
      if (list.length < 2) return null;
      const t0 = timeOf(list[0]?.measuredAt);
      const xs = list.map((p) => (timeOf(p?.measuredAt) - t0) / (24 * 3600 * 1000));
      const ys = list.map((p) => Number(p?.value));
      if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return null;
      const n = xs.length;
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i += 1) {
        num += (xs[i] - mx) * (ys[i] - my);
        den += (xs[i] - mx) ** 2;
      }
      if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
      const slope = num / den;
      return Number.isFinite(slope) ? round4(slope) : null; // units per day
    } catch {
      return null;
    }
  }
}

/** Epoch millis, or 0 for anything unparseable (stable sort, never NaN). */
function timeOf(iso) {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

function finiteOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
function round1(x) {
  return Math.round(x * 10) / 10;
}
function round4(x) {
  return Math.round(x * 10000) / 10000;
}
