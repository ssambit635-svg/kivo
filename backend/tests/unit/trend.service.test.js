import { describe, it, expect, beforeEach } from 'vitest';
import { TrendService } from '../../src/services/TrendService.js';

/** Stub repository returning scripted series. */
function stubRepo(seriesMap = {}) {
  return {
    seriesForMember: (memberId, code) => seriesMap[`${memberId}:${code}`] || [],
    codesWithVerifiedData: (memberId, min) =>
      Object.keys(seriesMap)
        .filter((k) => k.startsWith(`${memberId}:`) && seriesMap[k].length >= min)
        .map((k) => k.split(':')[1]),
  };
}

let seq = 0;
const BASE_DATE = Date.UTC(2026, 8, 16); // today (2026-09-16), the "now" of the demo
function point(value, daysBack, opts = {}) {
  seq += 1;
  return {
    id: `p${seq}`,
    report_id: `r${seq}`,
    value,
    unit: opts.unit || 'mg/dL',
    ref_low: opts.refLow ?? null,
    ref_high: opts.refHigh ?? null,
    measured_at: new Date(BASE_DATE - daysBack * 24 * 3600 * 1000).toISOString(),
  };
}

describe('TrendService.analyze — math & interpretation', () => {
  let trends;
  beforeEach(() => {
    trends = new TrendService(stubRepo());
  });

  it('empty series yields a friendly message, not a crash', () => {
    const r = trends.analyze('hba1c', []);
    expect(r.points).toEqual([]);
    expect(r.message).toMatch(/no verified data/i);
  });

  it('computes absolute + % change correctly', () => {
    const r = trends.analyze('fasting_glucose', [point(100, 300), point(125, 0)]);
    expect(r.deltaAbs).toBe(25);
    expect(r.deltaPct).toBe(25.0);
    expect(r.direction).toBe('increasing'); // >= 5% threshold
  });

  it('below 5% movement is stable', () => {
    const r = trends.analyze('fasting_glucose', [point(100, 300), point(103, 0)]);
    expect(r.direction).toBe('stable');
    expect(r.meaningfulChange).toBe(false);
  });

  it('decreasing series reports decreasing', () => {
    const r = trends.analyze('triglycerides', [point(200, 100), point(160, 0)]);
    expect(r.direction).toBe('decreasing');
    expect(r.interpretation).toBe('moving_toward_typical_direction'); // lower is better
  });

  it('improving markers (lower is better) are flagged as moving away when rising', () => {
    const r = trends.analyze('hba1c', [point(5.2, 100), point(6.1, 0)]);
    expect(r.interpretation).toBe('moving_away_from_typical_direction');
  });

  it('HDL rising is "moving toward" (higher is better)', () => {
    const r = trends.analyze('hdl', [point(40, 100), point(48, 0)]);
    expect(r.interpretation).toBe('moving_toward_typical_direction');
  });

  it('neutral markers never claim good/bad direction', () => {
    const r = trends.analyze('hemoglobin', [point(13, 100), point(15, 0)]);
    expect(r.interpretation).toBe('changed');
  });

  it('detects range-status crossings normal→high and marks change meaningful', () => {
    const r = trends.analyze('hba1c', [point(5.4, 100, { unit: '%', refLow: 4, refHigh: 5.6 }), point(5.9, 0, { unit: '%', refLow: 4, refHigh: 5.6 })]);
    expect(r.latestStatus).toBe('high');
    expect(r.statusTransitions).toEqual([{ from: 'normal', to: 'high', at: r.points[1].measuredAt }]);
    expect(r.meaningfulChange).toBe(true);
  });

  it('uses the latest report-supplied range as the effective range (source: report)', () => {
    const r = trends.analyze('fasting_glucose', [
      point(90, 100, { refLow: 70, refHigh: 99 }),
      point(101, 0, { refLow: 70, refHigh: 100 }),
    ]);
    expect(r.referenceRange).toEqual({ low: 70, high: 100, source: 'report' });
  });

  it('falls back to typical defaults with an explicit source label when reports lack ranges', () => {
    const r = trends.analyze('fasting_glucose', [point(90, 100), point(95, 0)]);
    expect(r.referenceRange.source).toBe('typical-default');
    expect(r.referenceRange.high).toBe(99);
  });

    it("never lets a typical-default range override the report's own range", () => {
    const r = trends.analyze('total_cholesterol', [point(195, 100, { refHigh: 240 }), point(210, 0, { refHigh: 240 })]);
    expect(r.referenceRange.high).toBe(240); // report range wins over the <200 typical default
    expect(r.latestStatus).toBe('normal'); // 210 < 240 by the report's range
  });

  it('least-squares slope sign matches the series for >=3 points; null below', () => {
    const up = trends.analyze('fasting_glucose', [point(90, 90), point(95, 45), point(104, 0)]);
    expect(up.slopePerDay).toBeGreaterThan(0);
    const two = trends.analyze('fasting_glucose', [point(90, 10), point(95, 0)]);
    expect(two.slopePerDay).toBeNull();
  });

  it('slope with identical timestamps is null (no division by zero)', () => {
    const r = trends.analyze('fasting_glucose', [point(90, 0), point(91, 0), point(92, 0)]);
    expect(r.slopePerDay).toBeNull();
  });

  it('first==last value (zero denominator) keeps deltaPct null instead of NaN/Infinity', () => {
    const r = trends.analyze('fasting_glucose', [point(0, 10), point(0.5, 0)]);
    expect(r.deltaPct).toBeNull();
    expect(Number.isNaN(r.deltaPct)).toBe(false);
  });
});

describe('TrendService.analyzeMember', () => {
  it('analyzes every code with >=2 verified points and skips sparse ones', () => {
    const repo = stubRepo({
      'm1:hba1c': [point(5.2, 100, { unit: '%' }), point(5.8, 0, { unit: '%' })],
      'm1:tsh': [point(2.0, 100, { unit: 'uIU/mL' })],
    });
    const trends = new TrendService(repo);
    const out = trends.analyzeMember('m1');
    expect(out.map((t) => t.code)).toEqual(['hba1c']);
    expect(out[0].notes.join(' ')).toMatch(/user-verified/i);
  });
});
