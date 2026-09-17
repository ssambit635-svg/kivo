import { LAB_DICTIONARY } from '../labs/labDictionary.js';

/**
 * Signal collection for the Personal Health Intelligence Engine (ADD-ON).
 *
 * Collects numeric time series ONLY from verified lab results and from
 * user-recorded observations. Unverified OCR drafts are never included —
 * the same safety gate as trends/risk, enforced by reading through the
 * repositories' verified-only queries.
 *
 * A "signal" is one measurable stream, e.g. lab:hba1c, obs:weight_kg,
 * obs:systolic_bp, derived:bmi. Points are always ascending by time.
 */

// Observation payload fields mapped to numeric signals.
export const OBS_SIGNAL_DEFS = {
  weight_kg: { kind: 'weight', field: 'weightKg', label: 'Weight', unit: 'kg' },
  systolic_bp: { kind: 'bp', field: 'systolic', label: 'Systolic blood pressure', unit: 'mmHg' },
  diastolic_bp: { kind: 'bp', field: 'diastolic', label: 'Diastolic blood pressure', unit: 'mmHg' },
  activity_min_week: { kind: 'activity', field: 'minutesPerWeek', label: 'Physical activity', unit: 'min/week' },
  sleep_hours: { kind: 'sleep', field: 'hours', label: 'Sleep duration', unit: 'hours' },
};

export class SignalCollector {
  constructor({ labResultRepository, observationRepository }) {
    this.labs = labResultRepository;
    this.observations = observationRepository;
  }

  /**
   * @returns {{ signals: Array, context: object }}
   * signals: [{ signal, label, unit, kind, points: [{ t, v, confidence, id }] }]
   */
  collect(member) {
    const signals = [];

    // --- verified labs, grouped by marker code ---
    const verified = this.labs.verifiedValuesForMember(member.id);
    const byCode = new Map();
    for (const row of verified) {
      if (!byCode.has(row.code)) byCode.set(row.code, []);
      byCode.get(row.code).push(row);
    }
    for (const [code, rows] of [...byCode.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const def = LAB_DICTIONARY[code] || null;
      const points = rows
        .filter((r) => Number.isFinite(r.value))
        .map((r) => ({
          t: r.measured_at,
          v: r.value,
          confidence: Number.isFinite(r.confidence) ? r.confidence : null,
          id: r.id,
        }))
        .sort((a, b) => timeOf(a.t) - timeOf(b.t));
      if (points.length === 0) continue;
      signals.push({
        signal: `lab:${code}`,
        label: def?.name || rows[0].test_name || code,
        unit: rows[rows.length - 1].unit || def?.defaultUnit || null,
        kind: 'lab',
        points,
      });
    }

    // --- numeric observation streams (user-recorded, treated as reported facts) ---
    for (const [signalId, def] of Object.entries(OBS_SIGNAL_DEFS)) {
      const { items } = this.observations.listForMember(member.id, { kind: def.kind, page: 1, pageSize: 5000 });
      const points = [];
      for (const obs of items) {
        const v = obs.data?.[def.field];
        if (typeof v === 'number' && Number.isFinite(v)) {
          points.push({ t: obs.observed_at, v, confidence: null, id: obs.id });
        }
      }
      points.sort((a, b) => timeOf(a.t) - timeOf(b.t));
      if (points.length === 0) continue;
      signals.push({ signal: `obs:${signalId}`, label: def.label, unit: def.unit, kind: 'observation', points });
    }

    // --- derived BMI stream (weight series + recorded height) ---
    if (member.height_cm) {
      const weight = signals.find((s) => s.signal === 'obs:weight_kg');
      if (weight) {
        const h = member.height_cm / 100;
        signals.push({
          signal: 'derived:bmi',
          label: 'Body-mass index (derived)',
          unit: 'kg/m²',
          kind: 'derived',
          points: weight.points.map((p) => ({
            t: p.t,
            v: Number((p.v / h ** 2).toFixed(1)),
            confidence: null,
            id: p.id,
          })),
        });
      }
    }

    // --- non-numeric context (counts only — never fabricated into numbers) ---
    const countKind = (kind) => this.observations.listForMember(member.id, { kind, page: 1, pageSize: 1 }).total;
    const context = {
      verifiedLabCount: verified.length,
      observationCount:
        countKind('weight') + countKind('bp') + countKind('activity') + countKind('sleep') +
        countKind('symptom') + countKind('note') + countKind('medication'),
      symptomCount: countKind('symptom'),
      medicationCount: countKind('medication'),
      noteCount: countKind('note'),
    };

    return { signals, context };
  }
}

// ---------------------------------------------------------------------------
// Small deterministic statistics helpers shared by the intelligence services.
// ---------------------------------------------------------------------------

export function timeOf(iso) {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function daysBetween(a, b) {
  return (timeOf(b) - timeOf(a)) / (24 * 3600 * 1000);
}

export function mean(xs) {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Sample standard deviation (n-1); 0 when n < 2. */
export function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function mad(xs) {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Robust z-score of `value` against history via median/MAD
 * (0.6745 makes MAD consistent with sd for normal data).
 */
export function robustZ(value, history) {
  if (history.length === 0) return null;
  const med = median(history);
  const m = mad(history);
  if (m === 0) return value === med ? 0 : null; // no spread — magnitude handled by callers
  return (0.6745 * (value - med)) / m;
}

/** Least-squares slope per day of points [{t, v}]. Null when degenerate. */
export function slopePerDay(points) {
  if (points.length < 2) return null;
  const t0 = timeOf(points[0].t);
  const xs = points.map((p) => (timeOf(p.t) - t0) / (24 * 3600 * 1000));
  const ys = points.map((p) => p.v);
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

/** Pearson correlation of paired values [[x, y], ...]. Null when degenerate. */
export function pearson(pairs) {
  if (pairs.length < 3) return null;
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < pairs.length; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export function round2(x) {
  return Math.round(x * 100) / 100;
}

export function round3(x) {
  return Math.round(x * 1000) / 1000;
}
