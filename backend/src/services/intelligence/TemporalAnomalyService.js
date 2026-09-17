import { SignalCollector, mean, sd, robustZ, pearson, daysBetween, timeOf, round2, round3 } from './signalSeries.js';
import { PersonalBaselineService } from './PersonalBaselineService.js';

/**
 * Multivariate Temporal Anomaly Engine (intelligence ADD-ON, capability #2).
 *
 * Reads multiple verified health signals together across time and flags
 * statistically notable patterns: sudden shifts, gradual drift, persistent
 * deviation, change points, coordinated multi-signal movement, divergent
 * measurements within a signal group, data gaps, and combinations that are
 * unusual relative to the person's own history.
 *
 * Transparent scoring: every finding names its method, score and threshold.
 * Severity is deliberately capped at informational|watch — this engine
 * describes observed data patterns; it never diagnoses and never claims
 * one signal caused another.
 */

export const ANOMALY_DISCLAIMER =
  'These findings describe statistical patterns in recorded values — sudden shifts, drift, or ' +
  'co-movement across signals. They are observations about data, not medical conclusions, and an ' +
  'association between signals is not evidence that one caused the other. Discuss persistent ' +
  'concerns with a qualified healthcare professional.';

// Signals grouped ONLY for "divergent movement" detection (same-group signals
// are often compared together by people reviewing their own data).
const SIGNAL_GROUPS = {
  glucose: ['lab:hba1c', 'lab:fasting_glucose', 'lab:random_glucose'],
  lipids: ['lab:total_cholesterol', 'lab:hdl', 'lab:ldl', 'lab:triglycerides'],
  pressure: ['obs:systolic_bp', 'obs:diastolic_bp'],
  body: ['obs:weight_kg', 'derived:bmi'],
};

const GAP_DAYS = 180;

export class TemporalAnomalyService {
  constructor({ labResultRepository, observationRepository }) {
    this.collector = new SignalCollector({ labResultRepository, observationRepository });
    this.baselines = new PersonalBaselineService({ labResultRepository, observationRepository });
  }

  analyze(member) {
    const { signals } = this.collector.collect(member);
    const baselineBySignal = new Map();
    for (const s of signals) baselineBySignal.set(s.signal, this.baselines.describeSignal(s));

    const findings = [];
    for (const s of signals) {
      const b = baselineBySignal.get(s.signal);
      findings.push(...this.singleSignalFindings(s, b));
      const cp = this.changePointFinding(s);
      if (cp) findings.push(cp);
      findings.push(...this.gapFindings(s));
    }

    const multivariate = this.multivariateFindings(signals, baselineBySignal);
    findings.push(...multivariate);

    const conflicting = this.conflictingFindings(signals, baselineBySignal);
    findings.push(...conflicting);

    const unusual = this.unusualCombinationFinding(signals, baselineBySignal);
    if (unusual) findings.push(unusual);

    findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (a.type < b.type ? -1 : 1));

    return {
      memberId: member.id,
      generatedAt: new Date().toISOString(),
      findingCount: findings.length,
      findings,
      methods: [
        'rolling robust z-score (median/MAD) for sudden shifts',
        'least-squares slope across the recorded span for gradual drift',
        'last-3-points same-side rule for persistent deviation',
        'split-mean scan for change points',
        'overlapping shift windows for coordinated multi-signal movement',
        'personal typical-state distance for unusual combinations',
      ],
      disclaimer: ANOMALY_DISCLAIMER,
    };
  }

  // ------------------------------------------------------------- single-signal
  singleSignalFindings(series, b) {
    const out = [];
    const label = series.label;
    if (b.status === 'sudden_deviation') {
      const z = b.latest.robustZ ?? b.latest.deviationZ ?? 0;
      out.push(this.finding({
        type: 'sudden_shift',
        severity: Math.abs(z) >= 3.5 ? 'watch' : 'informational',
        signals: [series.signal],
        labels: [label],
        startDate: b.lastAt,
        endDate: b.lastAt,
        method: 'robust z-score of the latest point vs preceding personal history',
        score: round3(Math.abs(z)),
        threshold: 3,
        confidence: confidenceFromBaseline(b, b.observationCount >= 5 ? 0.15 : 0),
        evidence: [
          `Latest ${label} ${b.latest.value}${unitSuffix(series)} recorded ${shortDate(b.lastAt)}.`,
          `Personal mean ${b.mean} (spread ${b.sd}) across ${b.observationCount} verified values.`,
        ],
        interpretation:
          `The most recent ${label} value is a marked change from this person's own recorded history. ` +
          `A single shifted measurement has many possible explanations (timing, device, laboratory ` +
          `variation, real change) — it is a personal deviation, not a medical finding.`,
      }));
    }
    if (b.status === 'persistent_deviation') {
      out.push(this.finding({
        type: 'persistent_deviation',
        severity: 'watch',
        signals: [series.signal],
        labels: [label],
        startDate: series.points[series.points.length - 3].t,
        endDate: b.lastAt,
        method: 'last-3-points same-side beyond 1.25 personal spreads',
        score: round3(Math.abs(b.latest.deviationZ ?? 0)),
        threshold: 1.25,
        confidence: confidenceFromBaseline(b, 0.1),
        evidence: [
          `Last 3 ${label} values all sit on the same side of the personal mean (${b.mean}).`,
          `Latest deviation: ${b.latest.deviationZ} personal spreads.`,
        ],
        interpretation:
          `Recent ${label} values persistently sit away from the personal baseline rather than ` +
          `fluctuating around it. Persistence makes timing noise a less likely full explanation, ` +
          `but this remains an observed data pattern, not a medical conclusion.`,
      }));
    }
    if (b.status === 'gradual_drift') {
      out.push(this.finding({
        type: 'gradual_drift',
        severity: 'informational',
        signals: [series.signal],
        labels: [label],
        startDate: b.firstAt,
        endDate: b.lastAt,
        method: 'least-squares slope; fitted span movement vs personal spread',
        score: b.latest.slopePerDay == null ? null : round3(Math.abs(b.latest.slopePerDay) * b.spanDays),
        threshold: b.sd,
        confidence: confidenceFromBaseline(b, 0),
        evidence: [
          `Fitted slope ${b.latest.slopePerDay} ${series.unit || 'units'}/day across ${Math.round(b.spanDays)} days.`,
          `Recent baseline ${b.recentBaseline.value} vs long-term baseline ${b.longTermBaseline.value}.`,
        ],
        interpretation:
          `${label} shows a gradual historical shift across the recorded span. Slow drift is ` +
          `common in longitudinal data and is reported here so it is not missed — it is not, by ` +
          `itself, a medical statement.`,
      }));
    }
    return out;
  }

  changePointFinding(series) {
    const pts = series.points;
    if (pts.length < 5) return null;
    const values = pts.map((p) => p.v);
    const fullSd = sd(values);
    if (fullSd === 0) return null;
    let best = null;
    for (let k = 2; k <= pts.length - 2; k += 1) {
      const left = values.slice(0, k);
      const right = values.slice(k);
      const shift = Math.abs(mean(left) - mean(right)) / fullSd;
      if (!best || shift > best.shift) best = { k, shift };
    }
    if (!best || best.shift < 1.5) return null;
    const at = pts[best.k].t;
    return this.finding({
      type: 'change_point',
      severity: 'informational',
      signals: [series.signal],
      labels: [series.label],
      startDate: at,
      endDate: at,
      method: 'split-mean scan (max standardized mean shift across all splits)',
      score: round3(best.shift),
      threshold: 1.5,
      confidence: { level: pts.length >= 6 ? 'moderate' : 'low', score: null, reasons: [`Split-mean shift ${round2(best.shift)} from ${pts.length} points.`] },
      evidence: [
        `Mean before ${shortDate(at)}: ${round2(mean(values.slice(0, best.k)))}; mean after: ${round2(mean(values.slice(best.k)))}.`,
      ],
      interpretation:
        `The ${series.label} history looks different before and after ${shortDate(at)} — a ` +
        `candidate change point in the recorded data. What, if anything, changed around then ` +
        `(routine, device, laboratory) is outside what the data alone can say.`,
    });
  }

  gapFindings(series) {
    const out = [];
    const pts = series.points;
    for (let i = 1; i < pts.length; i += 1) {
      const gap = daysBetween(pts[i - 1].t, pts[i].t);
      if (gap > GAP_DAYS) {
        out.push(this.finding({
          type: 'data_gap',
          severity: 'informational',
          signals: [series.signal],
          labels: [series.label],
          startDate: pts[i - 1].t,
          endDate: pts[i].t,
          method: `consecutive-measurement gap exceeding ${GAP_DAYS} days`,
          score: Math.round(gap),
          threshold: GAP_DAYS,
          confidence: { level: 'high', score: 1, reasons: ['Gap length is computed directly from recorded dates.'] },
          evidence: [`No ${series.label} values recorded between ${shortDate(pts[i - 1].t)} and ${shortDate(pts[i].t)} (${Math.round(gap)} days).`],
          interpretation:
            `A long interval without ${series.label} measurements limits what can be said about ` +
            `that period — trends drawn across the gap carry extra uncertainty.`,
        }));
      }
    }
    // Stale history: nothing recent despite a longer past.
    const span = daysBetween(pts[0].t, pts[pts.length - 1].t);
    const ageDays = (Date.now() - timeOf(pts[pts.length - 1].t)) / (24 * 3600 * 1000);
    if (span >= 90 && ageDays > GAP_DAYS) {
      out.push(this.finding({
        type: 'data_gap',
        severity: 'informational',
        signals: [series.signal],
        labels: [series.label],
        startDate: pts[pts.length - 1].t,
        endDate: new Date().toISOString(),
        method: `latest measurement older than ${GAP_DAYS} days with ≥90 days of earlier history`,
        score: Math.round(ageDays),
        threshold: GAP_DAYS,
        confidence: { level: 'high', score: 1, reasons: ['Recency is computed directly from the latest recorded date.'] },
        evidence: [`Latest ${series.label} value is from ${shortDate(pts[pts.length - 1].t)} (${Math.round(ageDays)} days ago).`],
        interpretation:
          `The ${series.label} history has gone quiet — statements about the *current* personal ` +
          `state rest on older data and should be treated as stale.`,
      }));
    }
    return out;
  }

  // -------------------------------------------------------------- multivariate
  multivariateFindings(signals, baselineBySignal) {
    // A "shift window" per signal: the recent window, when it differs
    // clearly from the long-term baseline — or, for short histories where
    // no long-term split exists yet, the latest value vs the prior mean.
    const shifted = [];
    for (const s of signals) {
      const b = baselineBySignal.get(s.signal);
      const shift = shiftFromBaseline(s, b);
      if (!shift || Math.abs(shift.z) < 1.0) continue;
      shifted.push({
        signal: s.signal,
        label: s.label,
        z: round3(shift.z),
        start: shift.start,
        end: shift.end,
        unit: s.unit,
      });
    }
    if (shifted.length < 2) return [];
    // Group signals whose shift windows overlap in time.
    const groups = [];
    for (const c of [...shifted].sort((a, b) => timeOf(a.start) - timeOf(b.start))) {
      const g = groups.find(
        (grp) => timeOf(c.start) <= timeOf(grp.end) && timeOf(grp.start) <= timeOf(c.end),
      );
      if (g) {
        g.members.push(c);
        if (timeOf(c.start) < timeOf(g.start)) g.start = c.start;
        if (timeOf(c.end) > timeOf(g.end)) g.end = c.end;
      } else {
        groups.push({ members: [c], start: c.start, end: c.end });
      }
    }
    const out = [];
    for (const g of groups) {
      if (g.members.length < 2) continue;
      const signs = new Set(g.members.map((m) => Math.sign(m.z)));
      const coordinated = signs.size === 1;
      const labels = g.members.map((m) => m.label);
      out.push(this.finding({
        type: 'multivariate_shift',
        severity: g.members.length >= 3 ? 'watch' : 'informational',
        signals: g.members.map((m) => m.signal),
        labels,
        startDate: g.start,
        endDate: g.end,
        method: 'overlapping shift windows: recent-vs-long-term (histories of 5+ points) or latest-vs-prior-mean (3–4 points); |standardized shift| ≥ 1.0',
        score: round3(mean(g.members.map((m) => Math.abs(m.z)))),
        threshold: 1.0,
        confidence: {
          level: g.members.length >= 3 ? 'moderate' : 'low',
          score: null,
          reasons: [
            `${g.members.length} signals shifted during ${shortDate(g.start)} → ${shortDate(g.end)}.`,
            'Co-movement in time is noted as a temporal association only.',
          ],
        },
        evidence: g.members.map(
          (m) => `${m.label}: recent-vs-long-term standardized shift ${m.z > 0 ? '+' : ''}${m.z}.`,
        ),
        interpretation: coordinated
          ? `${labels.join(', ')} moved in the same standardized direction during the same period — ` +
            `a coordinated movement in the recorded data. Moving together in time does not show ` +
            `that any one of them drove the others.`
          : `${labels.join(', ')} each shifted from its own baseline during the same period, in ` +
            `different standardized directions. Concurrent change is noted here as shared timing, ` +
            `not as a shared cause.`,
      }));
    }
    return out;
  }

  conflictingFindings(signals, baselineBySignal) {
    const bySignal = new Map(signals.map((s) => [s.signal, s]));
    const out = [];
    for (const [group, ids] of Object.entries(SIGNAL_GROUPS)) {
      const present = ids.filter((id) => bySignal.has(id));
      for (let i = 0; i < present.length; i += 1) {
        for (let j = i + 1; j < present.length; j += 1) {
          const a = baselineBySignal.get(present[i]);
          const b = baselineBySignal.get(present[j]);
          if (!a || !b) continue;
          const shiftA = shiftFromBaseline(bySignal.get(present[i]), a);
          const shiftB = shiftFromBaseline(bySignal.get(present[j]), b);
          if (!shiftA || !shiftB) continue;
          const za = shiftA.z;
          const zb = shiftB.z;
          // Windows must overlap for the comparison to be about the same period.
          const overlap = timeOf(shiftA.start) <= timeOf(shiftB.end) &&
            timeOf(shiftB.start) <= timeOf(shiftA.end);
          if (!overlap) continue;
          if (Math.abs(za) >= 1 && Math.abs(zb) >= 1 && Math.sign(za) !== Math.sign(zb)) {
            const sa = bySignal.get(present[i]);
            const sb = bySignal.get(present[j]);
            out.push(this.finding({
              type: 'conflicting_measurements',
              severity: 'informational',
              signals: [present[i], present[j]],
              labels: [sa.label, sb.label],
              startDate: shiftA.start < shiftB.start ? shiftA.start : shiftB.start,
              endDate: shiftA.end > shiftB.end ? shiftA.end : shiftB.end,
              method: 'opposite standardized recent shifts within one signal group over overlapping windows',
              score: round3(Math.abs(za) + Math.abs(zb)),
              threshold: 2.0,
              confidence: { level: 'low', score: null, reasons: ['Divergence is common when signals reflect different time windows or measurement contexts.'] },
              evidence: [
                `${sa.label}: standardized recent shift ${za > 0 ? '+' : ''}${round2(za)}.`,
                `${sb.label}: standardized recent shift ${zb > 0 ? '+' : ''}${round2(zb)}.`,
              ],
              interpretation:
                `${sa.label} and ${sb.label} moved in opposite standardized directions over the ` +
                `same period. Signals in the "${group}" group often reflect different measurement ` +
                `moments or averaging windows, so divergence frequently reflects timing or ` +
                `measurement variation rather than error — flagged here so it is not overlooked.`,
            }));
          }
        }
      }
    }
    return out;
  }

  unusualCombinationFinding(signals, baselineBySignal) {
    const zs = [];
    for (const s of signals) {
      const b = baselineBySignal.get(s.signal);
      if (b.observationCount < 3 || b.sd === 0 || b.latest.deviationZ == null) continue;
      zs.push({ signal: s.signal, label: s.label, z: b.latest.deviationZ });
    }
    if (zs.length < 2) return null;
    const distance = Math.sqrt(mean(zs.map((e) => e.z ** 2)));
    if (distance < 2.0) return null;
    const top = [...zs].sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 4);
    return this.finding({
      type: 'unusual_combination',
      severity: distance >= 3 ? 'watch' : 'informational',
      signals: top.map((e) => e.signal),
      labels: top.map((e) => e.label),
      startDate: null,
      endDate: null,
      method: 'root-mean-square of latest standardized deviations from personal means (diagonal personal typical-state distance)',
      score: round3(distance),
      threshold: 2.0,
      confidence: {
        level: zs.length >= 4 ? 'moderate' : 'low',
        score: null,
        reasons: [
          `Distance ${round2(distance)} computed across ${zs.length} signals with sufficient history.`,
          'A single per-signal view can look ordinary while the combination stands out.',
        ],
      },
      evidence: top.map((e) => `${e.label}: latest value ${e.z > 0 ? '+' : ''}${e.z} personal spreads from its personal mean.`),
      interpretation:
        `Taken together, the latest values sit unusually far from this person's typical combined ` +
        `state — an unusual combination relative to personal history. This compares the present ` +
        `snapshot against the person's own past, not against any medical standard.`,
    });
  }

  // ------------------------------------------------------------------ shaping
  finding({ type, severity, signals, labels, startDate, endDate, method, score, threshold, confidence, evidence, interpretation }) {
    return {
      type,
      severity,
      markers: labels,
      signals,
      startDate,
      endDate,
      method,
      score,
      threshold,
      evidence,
      confidence,
      interpretation,
    };
  }
}

function severityRank(s) {
  return s === 'watch' ? 1 : 0;
}

/**
 * Standardized recent shift of one signal for co-movement analysis.
 * Long histories (5+ points): recent-window mean vs long-term mean, scaled
 * by the personal spread; window = the recent window. Short histories
 * (3–4 points): latest value vs prior mean, scaled by the prior spread;
 * window = the last interval. Returns null when not computable.
 */
function shiftFromBaseline(series, b) {
  if (!b || b.observationCount < 3) return null;
  if (b.observationCount >= 5 && b.sd !== 0) {
    return {
      z: (b.recentBaseline.value - b.longTermBaseline.value) / b.sd,
      start: b.recentBaseline.windowStart,
      end: b.lastAt,
    };
  }
  const pts = series.points;
  const prior = pts.slice(0, -1).map((p) => p.v);
  const priorSd = sd(prior);
  if (priorSd === 0) return null;
  return {
    z: (pts[pts.length - 1].v - mean(prior)) / priorSd,
    start: pts[pts.length - 2].t,
    end: pts[pts.length - 1].t,
  };
}

function confidenceFromBaseline(b, bonus) {
  const base = b.confidence.level === 'high' ? 0.7 : b.confidence.level === 'moderate' ? 0.55 : 0.4;
  const score = Math.min(0.9, round2(base + bonus));
  // Low-confidence findings report reasons but no precise score.
  if (b.confidence.level === 'low') {
    return { level: 'low', score: null, reasons: [...b.confidence.reasons, 'Short history — reported as a pattern to watch, not a firm statement.'] };
  }
  return { level: b.confidence.level, score, reasons: b.confidence.reasons };
}

function unitSuffix(series) {
  return series.unit ? ` ${series.unit}` : '';
}

function shortDate(iso) {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : String(iso);
}

// Re-exported for the graph service's aligned-series correlation.
export { pearson };
