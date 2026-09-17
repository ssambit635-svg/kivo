import { SignalCollector, mean, median, sd, robustZ, slopePerDay, daysBetween, round2, round3 } from './signalSeries.js';

/**
 * Personal Baseline Engine (intelligence ADD-ON, capability #1).
 *
 * Learns what is typical for THIS person from verified history — personal
 * mean/median/spread plus a recent vs long-term split — instead of judging
 * everything against generic population ranges.
 *
 * SAFETY: a difference from the personal baseline is reported as a
 * "personal deviation" / "historical shift" / "change from personal
 * baseline" — NEVER as medically abnormal, and never as a diagnosis.
 */

export const BASELINE_DISCLAIMER =
  'Personal baselines describe what has been typical in this person\'s own recorded history. ' +
  'A change from a personal baseline is an observed historical shift, not a medical finding — ' +
  'it does not mean a value is healthy or unhealthy. Discuss persistent concerns with a ' +
  'qualified healthcare professional.';

const RECENT_WINDOW_POINTS = 3;

export class PersonalBaselineService {
  constructor({ labResultRepository, observationRepository }) {
    this.collector = new SignalCollector({ labResultRepository, observationRepository });
  }

  /** Baselines for every signal with at least one verified point. */
  baselinesFor(member) {
    const { signals, context } = this.collector.collect(member);
    const items = signals.map((s) => this.describeSignal(s));
    return {
      memberId: member.id,
      generatedAt: new Date().toISOString(),
      signalCount: items.length,
      dataContext: context,
      baselines: items,
      overallConfidence: this.overallConfidence(items),
      disclaimer: BASELINE_DISCLAIMER,
    };
  }

  /** Baseline for a single signal id (e.g. 'lab:hba1c'), or null. */
  baselineForSignal(member, signalId) {
    const { signals } = this.collector.collect(member);
    const found = signals.find((s) => s.signal === signalId);
    return found ? this.describeSignal(found) : null;
  }

  /** Exposed for the anomaly/graph engines so all three share one baseline truth. */
  describeSignal(series) {
    const values = series.points.map((p) => p.v);
    const n = values.length;
    const firstAt = series.points[0].t;
    const lastAt = series.points[n - 1].t;
    const spanDays = Math.max(0, daysBetween(firstAt, lastAt));
    const latest = series.points[n - 1];

    const avg = mean(values);
    const med = median(values);
    const spread = sd(values);

    // Recent window = the most recent up-to-3 points.
    const recentPoints = series.points.slice(-RECENT_WINDOW_POINTS);
    const recentBaseline = mean(recentPoints.map((p) => p.v));
    // Long-term = everything before the recent window when history allows,
    // otherwise the full-history mean (flagged in `method`).
    const older = series.points.slice(0, -RECENT_WINDOW_POINTS);
    const longTermBaseline = older.length >= 2 ? mean(older.map((p) => p.v)) : avg;
    const longTermMethod =
      older.length >= 2
        ? 'mean of points before the recent window'
        : 'mean of all points (history too short to split recent from long-term)';

    const deviationFromMean = round3(latest.v - avg);
    const deviationZ = spread > 0 ? round3((latest.v - avg) / spread) : null;
    const percentFromMean = avg !== 0 ? round2(((latest.v - avg) / Math.abs(avg)) * 100) : null;

    const history = values.slice(0, -1);
    const latestRobustZ = robustZ(latest.v, history);
    const slope = slopePerDay(series.points);

    const status = this.classify({ n, values, spread, latest, avg, latestRobustZ, slope, spanDays, recentBaseline, longTermBaseline });
    const confidence = this.confidenceFor(series, { n, spanDays });

    return {
      signal: series.signal,
      label: series.label,
      unit: series.unit,
      kind: series.kind,
      observationCount: n,
      spanDays: round2(spanDays),
      firstAt,
      lastAt,
      mean: round3(avg),
      median: round3(med),
      sd: round3(spread),
      min: Math.min(...values),
      max: Math.max(...values),
      recentBaseline: {
        value: round3(recentBaseline),
        windowPoints: recentPoints.length,
        windowStart: recentPoints[0].t,
        method: `mean of the most recent ${recentPoints.length} point(s)`,
      },
      longTermBaseline: { value: round3(longTermBaseline), method: longTermMethod },
      latest: {
        value: latest.v,
        at: latest.t,
        deviationFromMean,
        deviationZ,
        robustZ: latestRobustZ == null ? null : round3(latestRobustZ),
        percentFromMean,
        slopePerDay: slope == null ? null : round3(slope),
      },
      confidence,
      status: status.key,
      statusDetail: status.detail,
      summary: this.summarize(series, { n, status, deviationZ, percentFromMean, latest }),
    };
  }

  classify({ n, values, spread, latest, avg, latestRobustZ, slope, spanDays, recentBaseline, longTermBaseline }) {
    if (n < 3) {
      return {
        key: 'insufficient_data',
        detail: `Only ${n} recorded value(s) — a personal baseline needs at least 3 points before shifts can be described.`,
      };
    }
    // Sudden deviation: the latest point stands far apart from its own history.
    if (n >= 4 && latestRobustZ != null && Math.abs(latestRobustZ) >= 3) {
      return {
        key: 'sudden_deviation',
        detail:
          `The latest value (${latest.v}) differs markedly from the preceding personal history ` +
          `(robust z-score ${round2(latestRobustZ)}). This is a personal deviation — an observed ` +
          `historical shift, not a medical judgement.`,
      };
    }
    // Zero-spread history with a changed latest value: any move is notable.
    if (spread === 0 && latest.v !== avg) {
      return {
        key: n >= 4 ? 'sudden_deviation' : 'normal_variation',
        detail:
          `All earlier values were identical (${avg}); the latest value (${latest.v}) is the first ` +
          `change from that flat personal history.`,
      };
    }
    // Persistent deviation: last 3 points all on the same side, each clearly off-mean.
    if (n >= 4 && spread > 0) {
      const last3 = values.slice(-3);
      const side = Math.sign(last3[0] - avg);
      if (side !== 0 && last3.every((v) => Math.sign(v - avg) === side && Math.abs(v - avg) >= 1.25 * spread)) {
        const dir = side > 0 ? 'above' : 'below';
        return {
          key: 'persistent_deviation',
          detail:
            `The last 3 recorded values have all sat ${dir} the personal mean by a clear margin — ` +
            `a persistent change from personal baseline, not a one-off fluctuation.`,
        };
      }
    }
    // Gradual drift: fitted movement across the span exceeds one personal standard
    // deviation. Allowed from 3 points (a slope is well-defined there) because the
    // effect-size gate (a full personal spread of fitted movement) keeps it honest;
    // short histories carry moderate-at-best confidence downstream.
    if (n >= 3 && spread > 0 && slope != null && Math.abs(slope) * spanDays >= spread) {
      const dir = slope > 0 ? 'upward' : 'downward';
      return {
        key: 'gradual_drift',
        detail:
          `Values show a steady ${dir} drift across the recorded span (fitted movement ` +
          `≈ ${round3(Math.abs(slope) * spanDays)} vs personal spread ${round3(spread)}).`,
      };
    }
    if (spread > 0 && Math.abs((latest.v - avg) / spread) <= 1) {
      return { key: 'stable', detail: 'The latest value sits within one personal standard deviation of the personal mean.' };
    }
    return {
      key: 'normal_variation',
      detail:
        'The latest value differs somewhat from the personal mean but remains within the wider ' +
        'range of this person\'s own recorded variation.',
    };
  }

  confidenceFor(series, { n, spanDays }) {
    const reasons = [];
    let level;
    if (n >= 5 && spanDays >= 60) {
      level = 'high';
      reasons.push(`${n} verified observations spanning ${Math.round(spanDays)} days.`);
    } else if (n >= 3) {
      level = 'moderate';
      reasons.push(`Only ${n} verified observations spanning ${Math.round(spanDays)} days — usable, but a longer history would be firmer.`);
    } else {
      level = 'low';
      reasons.push(`Only ${n} recorded value(s) — not enough history for a reliable personal baseline.`);
    }
    if (series.kind === 'lab') {
      const confs = series.points.map((p) => p.confidence).filter((c) => typeof c === 'number');
      if (confs.length > 0) {
        const avgConf = mean(confs);
        reasons.push(`Average extraction confidence of the underlying values: ${round2(avgConf)}.`);
        if (avgConf < 0.5 && level !== 'low') {
          level = 'low';
          reasons.push('Downgraded: low average extraction confidence in the underlying values.');
        }
      } else {
        reasons.push('Underlying values carry no extraction-confidence scores.');
      }
      reasons.push('All values are user-verified; unverified drafts are excluded.');
    } else if (series.kind === 'observation') {
      reasons.push('Values are user-recorded observations (no extraction confidence applies).');
    } else {
      reasons.push('Derived from user-recorded weight and profile height.');
    }
    return { level, reasons };
  }

  overallConfidence(items) {
    if (items.length === 0) {
      return { level: 'low', reasons: ['No verified health signals are available yet.'] };
    }
    const levels = items.map((i) => i.confidence.level);
    const level = levels.every((l) => l === 'high') ? 'high' : levels.some((l) => l !== 'low') ? 'moderate' : 'low';
    return {
      level,
      reasons: [
        `${items.length} signal(s) with recorded history.`,
        level === 'low'
          ? 'Most signals have short histories — baseline statements carry meaningful uncertainty.'
          : 'Baseline statements rest on repeated verified observations.',
      ],
    };
  }

  summarize(series, { n, status, deviationZ, percentFromMean, latest }) {
    if (n < 3) {
      return `${series.label}: not enough history yet for a personal baseline (${n} recorded value${n === 1 ? '' : 's'}).`;
    }
    const dir = deviationZ == null ? 'changed' : deviationZ > 0 ? 'above' : deviationZ < 0 ? 'below' : 'at';
    const pct = percentFromMean == null ? '' : ` (${Math.abs(percentFromMean)}% ${dir === 'at' ? 'from' : dir} the personal mean)`;
    const heads = {
      stable: `${series.label}: latest value sits near your personal baseline${pct}.`,
      normal_variation: `${series.label}: latest value differs somewhat from your personal baseline${pct} — within your wider recorded variation.`,
      gradual_drift: `${series.label}: showing a gradual historical shift over the recorded span${pct}.`,
      sudden_deviation: `${series.label}: latest value (${latest.v}${series.unit ? ` ${series.unit}` : ''}) is a marked change from your personal baseline.`,
      persistent_deviation: `${series.label}: recent values persistently sit ${dir} your personal baseline.`,
      insufficient_data: `${series.label}: not enough history yet for a personal baseline.`,
    };
    return heads[status.key] || `${series.label}: personal baseline computed from ${n} values.`;
  }
}
