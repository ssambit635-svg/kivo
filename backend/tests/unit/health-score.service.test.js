import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestContext } from '../helpers.js';
import { bandFor } from '../../src/services/HealthScoreService.js';

/**
 * Health Score Timeline unit tests — built straight through repositories on
 * a real in-memory DB (same SQL the API uses), with trained focus on:
 * verified-only safety gate, deterministic per-marker points, snapshot
 * math, labels, deltas, "last known value carries forward" twin rule.
 */

let ctx, svc, labs, reports, members, memberId, userId;

function addVerifiedReport({ reportDate, values }) {
  const report = reports.create({ memberId, uploadedBy: userId, reportDate, originalName: `r-${reportDate}.txt` });
  for (const v of values) {
    labs.create({
      reportId: report.id,
      memberId,
      code: v.code,
      testName: v.testName || v.code,
      value: v.value,
      unit: v.unit ?? null,
      refLow: v.refLow ?? null,
      refHigh: v.refHigh ?? null,
      measuredAt: reportDate,
      verified: 1,
    });
  }
  reports.markVerified(report.id);
  return report;
}

beforeAll(() => {
  ctx = makeTestContext();
  const c = ctx.container;
  svc = c.healthScoreService;
  labs = c.labResultRepository;
  reports = c.reportRepository;
  members = c.memberRepository;
  const user = c.userRepository.create({ email: 'score@mt.test', displayName: 'Score', passwordHash: c.passwordService.hash('T3st!Passw0rd#xx') });
  userId = user.id;
  memberId = members.create({ userId, name: 'Score', relationship: 'self' }).id;
});
afterAll(() => ctx.container.close());

describe('HealthScoreService — empty twin', () => {
  it('no verified reports → empty timeline with guidance message + disclaimer', () => {
    const out = svc.timelineFor(memberId);
    expect(out.current).toBeNull();
    expect(out.timeline).toEqual([]);
    expect(out.message).toMatch(/no verified reports/i);
    expect(out.disclaimer).toMatch(/not a clinical score/i);
    expect(out.methodology.rules.length).toBeGreaterThan(0);
  });
});

describe('HealthScoreService — deterministic snapshot math', () => {
  it('all markers in range → 100 / strong, delta null on first snapshot', () => {
    addVerifiedReport({
      reportDate: '2026-01-10',
      values: [
        { code: 'hba1c', value: 5.2, unit: '%', refLow: 4.0, refHigh: 5.6 },
        { code: 'fasting_glucose', value: 90, unit: 'mg/dL', refLow: 70, refHigh: 100 },
      ],
    });
    const out = svc.timelineFor(memberId);
    expect(out.timeline).toHaveLength(1);
    const s = out.timeline[0];
    expect(s.score).toBe(100);
    expect(s.band).toBe('strong');
    expect(s.label).toBe('Jan 2026');
    expect(s.delta).toBeNull();
    expect(s.outOfRangeCount).toBe(0);
    expect(s.breakdown.every((b) => b.points === 100 && b.status === 'normal')).toBe(true);
    expect(out.current.score).toBe(100);
  });

  it('graded overshoot penalties: mild 60 / moderate 45 / far 25', () => {
    // hba1c 6.1 vs high 5.6 → 8.9% over → mild (60)
    // glucose 115 vs high 100 → 15% over → moderate (45)
    // ldl 180 vs high 100 → 80% over → far (25)
    const mild = svc.scorePoint('hba1c', { value: 6.1, unit: '%', ref_low: 4.0, ref_high: 5.6, measured_at: '2026-02-01' });
    const moderate = svc.scorePoint('fasting_glucose', { value: 115, unit: 'mg/dL', ref_low: 70, ref_high: 100, measured_at: '2026-02-01' });
    const far = svc.scorePoint('ldl', { value: 180, unit: 'mg/dL', ref_low: null, ref_high: 100, measured_at: '2026-02-01' });
    expect([mild.points, moderate.points, far.points]).toEqual([60, 45, 25]);
    expect(mild.overshootPct).toBeCloseTo(8.9, 1);
    expect(moderate.status).toBe('high');
    expect(far.status).toBe('high');
  });

  it('low-side violations score symmetrically (penalty vs the low bound)', () => {
    const p = svc.scorePoint('hdl', { value: 32, unit: 'mg/dL', ref_low: 40, ref_high: null, measured_at: '2026-02-01' });
    expect(p.status).toBe('low');
    expect(p.overshootPct).toBeCloseTo(20, 0); // (40-32)/40
    expect(p.points).toBe(45); // 20% → moderate band
  });

  it('marker with NO range context (unknown code, no refs) → neutral 70, status unknown', () => {
    const p = svc.scorePoint('novel_marker_x', { value: 42, ref_low: null, ref_high: null, measured_at: '2026-02-01', test_name: 'Novel X' });
    expect(p.points).toBe(70);
    expect(p.status).toBe('unknown');
    expect(p.markerName).toBe('Novel X');
  });

  it('missing row range falls back to dictionary typical range, flagged as typical-default', () => {
    const p = svc.scorePoint('hba1c', { value: 7.0, ref_low: null, ref_high: null, measured_at: '2026-02-01' });
    expect(p.referenceRange.source).toBe('typical-default');
    expect(p.referenceRange.high).toBe(5.6);
    expect(p.points).toBe(45); // (7-5.6)/5.6 = 25% over
  });

  it('a later snapshot: improving markers lift the score; delta is computed against the previous snapshot', () => {
    // Jan state: 100 + 100 → 100. Mar: hba1c far out (25) + glucose improved to 90 (100) → mean 62.5 → 63. Wait, glucose stays 90 from Jan? No — Mar adds new values:
    addVerifiedReport({
      reportDate: '2026-03-12',
      values: [
        { code: 'hba1c', value: 7.5, unit: '%', refLow: 4.0, refHigh: 5.6 }, // 33.9% over → far → 25
        { code: 'fasting_glucose', value: 95, unit: 'mg/dL', refLow: 70, refHigh: 100 }, // in range → 100
      ],
    });
    const out = svc.timelineFor(memberId);
    expect(out.timeline).toHaveLength(2);
    const [jan, mar] = out.timeline;
    expect(jan.score).toBe(100);
    expect(mar.score).toBe(63); // (25 + 100) / 2 = 62.5 → round → 63
    expect(mar.delta).toBe(63 - 100);
    expect(mar.label).toBe('Mar 2026');
    expect(out.current.score).toBe(63);
    expect(out.current.outOfRangeCount).toBe(1);
  });

  it('“living twin” rule: a marker dropped from the latest panel keeps its last known verified value', () => {
    // Jun panel only re-measures hba1c (back in range). Glucose was last
    // measured in Mar at 95 (in range) — it must still count at the Jun snapshot.
    addVerifiedReport({
      reportDate: '2026-06-10',
      values: [{ code: 'hba1c', value: 5.4, unit: '%', refLow: 4.0, refHigh: 5.6 }],
    });
    const out = svc.timelineFor(memberId);
    const jun = out.timeline[2];
    expect(jun.markerCount).toBe(2); // hba1c + carried-forward glucose
    expect(jun.score).toBe(100); // both in range
    expect(jun.delta).toBe(100 - 63); // rebound visible in the timeline
    const glucose = jun.breakdown.find((b) => b.code === 'fasting_glucose');
    expect(glucose.value).toBe(95);
    expect(glucose.measuredAt).toBe('2026-03-12');
  });
});

describe('HealthScoreService — verified-only safety gate', () => {
  it('an UNVERIFIED terrible value never moves the score (repository-level gate)', () => {
    const report = reports.create({ memberId, uploadedBy: userId, reportDate: '2026-06-20' });
    labs.create({
      reportId: report.id, memberId, code: 'hba1c', testName: 'HbA1c', value: 99,
      unit: '%', refLow: 4, refHigh: 5.6, measuredAt: '2026-06-20', verified: 0,
    });
    const out = svc.timelineFor(memberId);
    expect(out.timeline).toHaveLength(3); // unverified report adds no snapshot
    expect(out.current.score).toBe(100);
    expect(out.timeline[2].breakdown.find((b) => b.code === 'hba1c').value).toBe(5.4);
  });
});

describe('bandFor', () => {
  it('maps score to the documented bands', () => {
    expect(bandFor(95)).toBe('strong');
    expect(bandFor(90)).toBe('strong');
    expect(bandFor(75)).toBe('good');
    expect(bandFor(60)).toBe('watch');
    expect(bandFor(59)).toBe('attention');
  });
});
