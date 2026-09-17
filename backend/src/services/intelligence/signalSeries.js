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
    const memberId = member?.id ?? null;

    // --- verified labs, grouped by marker code ---
    let verified = [];
    try {
      verified = memberId ? this.labs.verifiedValuesForMember(memberId) || [] : [];
    } catch {
      verified = [];
    }
    const byCode = new Map();
    for (const row of verified) {
      if (!row || !row.code) continue;
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
      let items = [];
      try {
        items = memberId ? this.observations.listForMember(memberId, { kind: def.kind, page: 1, pageSize: 5000 }).items || [] : [];
      } catch {
        items = [];
      }
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
    try {
      const heightCm = Number(member?.height_cm ?? member?.heightCm);
      if (Number.isFinite(heightCm) && heightCm >= 30 && heightCm <= 280) {
        const weight = signals.find((s) => s.signal === 'obs:weight_kg');
        if (weight) {
          const h = heightCm / 100;
          const pts = weight.points
            .map((p) => {
              const v = Number((p.v / h ** 2).toFixed(1));
              return Number.isFinite(v) ? { t: p.t, v, confidence: null, id: p.id } : null;
            })
            .filter(Boolean);
          if (pts.length > 0) {
            signals.push({ signal: 'derived:bmi', label: 'Body-mass index (derived)', unit: 'kg/m²', kind: 'derived', points: pts });
          }
        }
      }
    } catch {
      /* derived BMI is optional */
    }

    // --- non-numeric context (counts only — never fabricated into numbers) ---
    const countKind = (kind) => {
      try {
        if (!memberId) return 0;
        const n = this.observations.listForMember(memberId, { kind, page: 1, pageSize: 1 }).total;
        return Number.isFinite(Number(n)) ? Number(n) : 0;
      } catch {
        return 0;
      }
    };
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

/** Finite numbers only — statistics must never emit NaN into API payloads. */
function finiteList(xs) {
  if (!Array.isArray(xs)) return [];
  return xs.map(Number).filter(Number.isFinite);
}

export function mean(xs) {
  const clean = finiteList(xs);
  if (clean.length === 0) return null;
  const out = clean.reduce((s, x) => s + x, 0) / clean.length;
  return Number.isFinite(out) ? out : null;
}

export function median(xs) {
  const clean = finiteList(xs);
  if (clean.length === 0) return null;
  const s = [...clean].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const out = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Number.isFinite(out) ? out : null;
}

/** Sample standard deviation (n-1); 0 when n < 2. */
export function sd(xs) {
  const clean = finiteList(xs);
  if (clean.length < 2) return 0;
  const m = mean(clean);
  if (m == null) return 0;
  const variance = clean.reduce((s, x) => s + (x - m) ** 2, 0) / (clean.length - 1);
  const out = Math.sqrt(variance);
  return Number.isFinite(out) ? out : 0;
}

export function mad(xs) {
  const clean = finiteList(xs);
  if (clean.length === 0) return 0;
  const m = median(clean);
  if (m == null) return 0;
  return median(clean.map((x) => Math.abs(x - m))) ?? 0;
}

/**
 * Robust z-score of `value` against history via median/MAD
 * (0.6745 makes MAD consistent with sd for normal data).
 */
export function robustZ(value, history) {
  const v = Number(value);
  const clean = finiteList(history);
  if (!Number.isFinite(v) || clean.length === 0) return null;
  const med = median(clean);
  const m = mad(clean);
  if (med == null || !Number.isFinite(m)) return null;
  if (m === 0) return v === med ? 0 : null; // no spread — magnitude handled by callers
  const out = (0.6745 * (v - med)) / m;
  return Number.isFinite(out) ? out : null;
}

/** Least-squares slope per day of points [{t, v}]. Null when degenerate. */
export function slopePerDay(points) {
  try {
    const list = (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(Number(p.v)));
    if (list.length < 2) return null;
    const t0 = timeOf(list[0].t);
    const xs = list.map((p) => (timeOf(p.t) - t0) / (24 * 3600 * 1000));
    const ys = list.map((p) => Number(p.v));
    if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return null;
    const n = xs.length;
    const mx = mean(xs);
    const my = mean(ys);
    if (mx == null || my == null) return null;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    const out = num / den;
    return Number.isFinite(out) ? out : null;
  } catch {
    return null;
  }
}

/** Pearson correlation of paired values [[x, y], ...]. Null when degenerate. */
export function pearson(pairs) {
  try {
    const clean = (Array.isArray(pairs) ? pairs : []).filter(
      (p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])),
    );
    if (clean.length < 3) return null;
    const xs = clean.map((p) => Number(p[0]));
    const ys = clean.map((p) => Number(p[1]));
    const mx = mean(xs);
    const my = mean(ys);
    if (mx == null || my == null) return null;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < clean.length; i += 1) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    if (!Number.isFinite(num) || !Number.isFinite(dx) || !Number.isFinite(dy) || dx === 0 || dy === 0) return null;
    const out = num / Math.sqrt(dx * dy);
    return Number.isFinite(out) ? Math.min(1, Math.max(-1, out)) : null;
  } catch {
    return null;
  }
}

export function round2(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function round3(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}
