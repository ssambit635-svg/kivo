import { LAB_DICTIONARY } from './labs/labDictionary.js';

/**
 * Longitudinal Trend Engine (Layer 3 of the AI architecture).
 *
 * Input: verified lab values only (repository enforces). For each marker:
 * points over time, first→last deltas, per-point range status, direction
 * (with a *better-direction* interpretation only where the dictionary
 * declares one), least-squares slope for 3+ points, and "meaningful change"
 * detection (% change beyond threshold OR range-status crossing).
 */
export class TrendService {
  constructor(labResultRepository) {
    this.labs = labResultRepository;
    this.MEANINGFUL_PCT = 10; // % change considered meaningful (prototype heuristic)
    this.STABLE_PCT = 5; // below this, treat as stable
  }

  analyze(code, points) {
    const def = LAB_DICTIONARY[code] || {};
    // Never trust caller ordering — the engine owns chronological order.
    const series = points
      .map((r) => ({
        id: r.id,
        reportId: r.report_id,
        value: r.value,
        unit: r.unit,
        refLow: r.ref_low,
        refHigh: r.ref_high,
        measuredAt: r.measured_at,
      }))
      .sort((a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime());

    if (series.length === 0) {
      return { code, points: [], message: 'No verified data for this marker yet' };
    }

    const range = this.effectiveRange(series, def);
    const enriched = series.map((p) => ({ ...p, status: this.pointStatus(p, range) }));

    const first = enriched[0];
    const last = enriched[enriched.length - 1];
    const deltaAbs = round2(last.value - first.value);
    const deltaPct = first.value !== 0 ? round1((deltaAbs / first.value) * 100) : null;

    let direction = 'stable';
    if (deltaPct != null) {
      if (Math.abs(deltaPct) < this.STABLE_PCT) direction = 'stable';
      else direction = deltaPct > 0 ? 'increasing' : 'decreasing';
    }

    const interpretation = this.interpret(direction, def.betterDirection);
    const statusTransitions = this.transitions(enriched);
    const meaningfulChange =
      (deltaPct != null && Math.abs(deltaPct) >= this.MEANINGFUL_PCT) || statusTransitions.length > 0;

    const slope = series.length >= 3 ? this.leastSquaresSlope(enriched) : null;

    return {
      code,
      markerName: def.name || code,
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
  }

  /** Trends across all markers with >= minPoints verified points, for a member. */
  analyzeMember(memberId, { minPoints = 2 } = {}) {
    const codes = this.labs.codesWithVerifiedData(memberId, minPoints);
    return codes.map((code) => {
      const points = this.labs.seriesForMember(memberId, code);
      return this.analyze(code, points);
    });
  }

  analyzeCode(memberId, code) {
    if (!LAB_DICTIONARY[code]) return null;
    return this.analyze(code, this.labs.seriesForMember(memberId, code));
  }

  // ---------------------------------------------------------------- internals
  effectiveRange(series, def) {
    // The most recent point's own stored range wins (report source of truth).
    const latestWithRange = [...series].reverse().find((p) => p.refLow != null || p.refHigh != null);
    if (latestWithRange) {
      return {
        low: latestWithRange.refLow,
        high: latestWithRange.refHigh,
        source: 'report',
      };
    }
    const t = def.typicalRange || {};
    return { low: t.low ?? null, high: t.high ?? null, source: 'typical-default' };
  }

  pointStatus(p, range) {
    if (range.high != null && p.value > range.high) return 'high';
    if (range.low != null && p.value < range.low) return 'low';
    if (range.high != null || range.low != null) return 'normal';
    return 'unknown';
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
    for (let i = 1; i < enriched.length; i += 1) {
      if (enriched[i].status !== enriched[i - 1].status) {
        out.push({
          from: enriched[i - 1].status,
          to: enriched[i].status,
          at: enriched[i].measuredAt,
        });
      }
    }
    return out;
  }

  leastSquaresSlope(enriched) {
    const t0 = new Date(enriched[0].measuredAt).getTime();
    const xs = enriched.map((p) => (new Date(p.measuredAt).getTime() - t0) / (24 * 3600 * 1000));
    const ys = enriched.map((p) => p.value);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    if (den === 0) return null;
    return round4(num / den); // units per day
  }
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
