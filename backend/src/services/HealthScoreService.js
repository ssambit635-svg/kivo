import { LAB_DICTIONARY } from './labs/labDictionary.js';

/**
 * Health Score Timeline (product widget: "Jan → 68 | Mar → 72 | Jun → 76").
 *
 * A transparent, deterministic composite computed ONLY from user-verified
 * lab values — the same safety gate as trends/risk (the repositories'
 * verified-only WHERE clauses do the enforcing).
 *
 * How a snapshot score is built (nothing magical, fully explainable):
 *   1. At each verified report date, take every marker's LATEST verified
 *      value known up to that moment (the twin remembers your last known
 *      state even if a later panel omitted a marker).
 *   2. Each marker earns points from its status against the reference
 *      range — the range stored on the report wins, dictionary typical
 *      adult defaults fill in otherwise (same rule as TrendService):
 *        in range .............. 100
 *        no range context ........ 70 (neutral — we refuse to penalize for unknowns)
 *        out of range by ≤ 10% ... 60
 *        out of range by ≤ 25% ... 45
 *        out of range by > 25% ... 25
 *      (overshoot is measured against the crossed bound.)
 *   3. Snapshot score = rounded mean of marker points (0–100).
 *
 * Every snapshot ships its full per-marker breakdown so the "why" is always
 * one click away — the same explainability principle as the risk model.
 *
 * MEDICAL SAFETY: this is a prototype "share of markers in range" wellness
 * indicator for motivation and orientation. It is NOT a clinical score,
 * NOT validated, and must never be presented as one — the disclaimer is
 * part of the response object.
 */

const POINTS = { IN_RANGE: 100, UNKNOWN: 70, OUT_MILD: 60, OUT_MODERATE: 45, OUT_FAR: 25 };
const MILD_MAX_FRACTION = 0.1;
const MODERATE_MAX_FRACTION = 0.25;

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DISCLAIMER =
  'The Health Score is a prototype composite of how many of your verified markers sit inside their ' +
  'reference ranges at each point in time. It is not a clinical score, has not been medically ' +
  'validated, and a higher or lower number does not by itself mean you are healthier or unhealthier. ' +
  'Discuss your results with a qualified healthcare professional.';

export class HealthScoreService {
  constructor({ labResultRepository, reportRepository }) {
    this.labs = labResultRepository;
    this.reports = reportRepository;
  }

  /**
   * Build the score timeline for a member.
   * @returns {{memberId: string, current: object|null, timeline: Array, methodology: object, disclaimer: string}}
   */
  timelineFor(memberId) {
    try {
      if (!memberId) return this.emptyTimeline(memberId);
      // One snapshot per verified report that actually carries verified values.
      const reports = this.reports.verifiedWithValuesForMember(memberId) || [];
      if (reports.length === 0) return this.emptyTimeline(memberId);

      const allVerified = this.labs.verifiedValuesForMember(memberId) || []; // ASC by measured_at
      const byCode = new Map();
      for (const row of allVerified) {
        if (!row || !row.code) continue;
        if (!byCode.has(row.code)) byCode.set(row.code, []);
        byCode.get(row.code).push(row);
      }

      // Collapse reports sharing a calendar day into one snapshot (end-of-day state).
      const snapshots = [];
      const byDay = new Map();
      for (const r of reports) {
        const at = r.report_date || r.created_at;
        const day = asDay(at);
        if (!day) continue; // corrupt date — skip the snapshot, keep the timeline
        byDay.set(day, { day, reportId: r.id, at });
      }
      const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));

      let previousScore = null;
      for (const snap of days) {
        let entry;
        try {
          entry = this.snapshotScore(snap, byCode);
        } catch {
          continue;
        }
        entry.delta = previousScore == null || entry.score == null || previousScore == null
          ? null
          : entry.score - previousScore;
        if (entry.score != null) previousScore = entry.score;
        snapshots.push(entry);
      }

      if (snapshots.length === 0) return this.emptyTimeline(memberId);
      const last = snapshots[snapshots.length - 1];
      return {
        memberId,
        current: {
          score: last.score,
          band: last.band,
          at: last.at,
          label: last.label,
          delta: last.delta,
          markerCount: last.markerCount,
          outOfRangeCount: last.outOfRangeCount,
        },
        timeline: snapshots,
        methodology: this.methodology(),
        disclaimer: DISCLAIMER,
      };
    } catch {
      return this.emptyTimeline(memberId);
    }
  }

  emptyTimeline(memberId) {
    return {
      memberId,
      current: null,
      timeline: [],
      methodology: this.methodology(),
      message: 'No verified reports yet — upload and verify a report to start your health score timeline.',
      disclaimer: DISCLAIMER,
    };
  }

  /** Score the member's state at one snapshot day. */
  snapshotScore(snap, byCode) {
    if (!snap || typeof snap !== 'object') {
      return {
        at: null, day: null, label: 'Unknown', reportId: null, score: null,
        band: null, markerCount: 0, outOfRangeCount: 0, delta: null, drivers: [], breakdown: [],
      };
    }
    const cutoffMs = endOfDayMs(snap?.day);
    const breakdown = [];
    const codes = byCode instanceof Map ? byCode.entries() : [];

    for (const [code, points] of codes) {
      let latest = null;
      for (const p of points || []) {
        const t = new Date(p?.measured_at).getTime();
        if (Number.isFinite(t) && t <= cutoffMs) latest = p;
        else if (Number.isFinite(t)) break; // rows are ASC — first point beyond cutoff ends the scan for this code
      }
      if (!latest) continue; // marker not known yet at this snapshot
      try {
        breakdown.push(this.scorePoint(code, latest));
      } catch {
        continue;
      }
    }

    breakdown.sort((a, b) => a.points - b.points || a.code.localeCompare(b.code));
    const score =
      breakdown.length === 0
        ? null
        : Math.round(breakdown.reduce((sum, b) => sum + b.points, 0) / breakdown.length);
    const outOfRangeCount = breakdown.filter((b) => b.status === 'low' || b.status === 'high').length;

    return {
      at: snap.at,
      day: snap.day,
      label: dayLabel(snap.day),
      reportId: snap.reportId,
      score,
      band: score == null ? null : bandFor(score),
      markerCount: breakdown.length,
      outOfRangeCount,
      delta: null, // filled by timelineFor
      drivers: breakdown.slice(0, 3).map((b) => `${b.markerName} ${b.status} (${b.points} pts)`),
      breakdown,
    };
  }

  /** Points for one marker's value at the snapshot. */
  scorePoint(code, point) {
    const safeCode = typeof code === 'string' && code ? code : 'unknown';
    try {
      const def = (LAB_DICTIONARY && LAB_DICTIONARY[safeCode]) || {};
      const p = point && typeof point === 'object' ? point : {};
      const value = p.value == null ? null : Number(p.value);
      const finiteValue = value != null && Number.isFinite(value) ? value : null;
      const refLow = finiteOrNull(p.ref_low ?? def.typicalRange?.low ?? null);
      const refHigh = finiteOrNull(p.ref_high ?? def.typicalRange?.high ?? null);
      const rangeSource = p.ref_low != null || p.ref_high != null ? 'report' : 'typical-default';

      let status = 'unknown';
      let points = POINTS.UNKNOWN;
      let overshootPct = null;

      if (finiteValue != null && (refLow != null || refHigh != null)) {
        if (refHigh != null && finiteValue > refHigh) {
          status = 'high';
          overshootPct = round1(((finiteValue - refHigh) / scale(refHigh)) * 100);
        } else if (refLow != null && finiteValue < refLow) {
          status = 'low';
          overshootPct = round1(((refLow - finiteValue) / scale(refLow)) * 100);
        } else {
          status = 'normal';
        }
        if (!Number.isFinite(overshootPct)) overshootPct = null;
        if (status === 'normal') {
          points = POINTS.IN_RANGE;
        } else if (status !== 'unknown') {
          const fraction = (overshootPct ?? 0) / 100;
          points =
            fraction <= MILD_MAX_FRACTION
              ? POINTS.OUT_MILD
              : fraction <= MODERATE_MAX_FRACTION
                ? POINTS.OUT_MODERATE
                : POINTS.OUT_FAR;
        }
      }

      return {
        code: safeCode,
        markerName: def.name || p.test_name || safeCode,
        value: finiteValue,
        unit: p.unit || def.defaultUnit || null,
        status,
        points,
        overshootPct,
        referenceRange: { low: refLow, high: refHigh, source: rangeSource },
        measuredAt: p.measured_at ?? null,
      };
    } catch {
      return {
        code: safeCode, markerName: safeCode, value: null, unit: null,
        status: 'unknown', points: POINTS.UNKNOWN, overshootPct: null,
        referenceRange: { low: null, high: null, source: 'typical-default' },
        measuredAt: null,
      };
    }
  }

  methodology() {
    return {
      kind: 'in-range-share composite (transparent, deterministic, prototype)',
      pointsPerMarker: {
        inRange: POINTS.IN_RANGE,
        outWithin10Percent: POINTS.OUT_MILD,
        outWithin25Percent: POINTS.OUT_MODERATE,
        outBeyond25Percent: POINTS.OUT_FAR,
        noRangeContext: POINTS.UNKNOWN,
      },
      rules: [
        'Only user-verified values participate — unverified OCR drafts never move the score.',
        'Each snapshot uses every marker’s latest verified value known at that date.',
        'The reference range stored on the report wins; typical adult defaults fill in otherwise.',
        'Snapshot score is the average of per-marker points (0–100).',
      ],
      bands: [
        { min: 90, band: 'strong', label: 'Strong — nearly all markers in range' },
        { min: 75, band: 'good', label: 'Good — most markers in range' },
        { min: 60, band: 'watch', label: 'Watch — several markers outside range' },
        { min: 0, band: 'attention', label: 'Attention — many markers outside range' },
      ],
    };
  }
}

export function bandFor(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 'watch'; // fail toward the middle band, never throw
  if (s >= 90) return 'strong';
  if (s >= 75) return 'good';
  if (s >= 60) return 'watch';
  return 'attention';
}

function finiteOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Overshoot denominator; guards against a 0 bound (never divides by zero). */
function scale(bound) {
  return Math.max(Math.abs(bound), 1e-6);
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function asDay(iso) {
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function endOfDayMs(day) {
  try {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 0;
    const t = new Date(`${day}T23:59:59.999Z`).getTime();
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

function dayLabel(day) {
  try {
    const d = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return 'Unknown';
    return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  } catch {
    return 'Unknown';
  }
}
