import { describe, it, expect } from 'vitest';
import { PersonalBaselineService, BASELINE_DISCLAIMER } from '../../src/services/intelligence/PersonalBaselineService.js';

/** Fake repos: labs expose ONLY the verified query — any other read would throw. */
function makeSvc(labRows = [], obsByKind = {}) {
  const labResultRepository = {
    verifiedValuesForMember: () => labRows,
  };
  const observationRepository = {
    listForMember: (memberId, { kind, pageSize }) => {
      const items = (obsByKind[kind] || []).map((o, i) => ({ id: `ob-${kind}-${i}`, ...o }));
      return { items: items.slice(0, pageSize), total: items.length, page: 1, pageSize };
    },
  };
  return new PersonalBaselineService({ labResultRepository, observationRepository });
}

const member = { id: 'm1', name: 'T', dob: '1980-01-01', height_cm: 170, updated_at: '2026-01-01', familyHistory: {} };

const lab = (code, value, measured_at, confidence = 0.9) => ({
  id: `lr-${code}-${measured_at}`, code, test_name: code, value, unit: '%', confidence, measured_at,
});

describe('PersonalBaselineService — status classification', () => {
  it('insufficient_data with < 3 points, low confidence', () => {
    const svc = makeSvc([lab('hba1c', 5.4, '2026-01-01'), lab('hba1c', 5.6, '2026-02-01')]);
    const b = svc.baselineForSignal(member, 'lab:hba1c');
    expect(b.status).toBe('insufficient_data');
    expect(b.confidence.level).toBe('low');
    expect(b.observationCount).toBe(2);
  });

  it('stable when the latest value sits near the personal mean', () => {
    const svc = makeSvc([
      lab('hba1c', 5.4, '2026-01-01'), lab('hba1c', 5.5, '2026-02-01'), lab('hba1c', 5.4, '2026-03-01'),
    ]);
    const b = svc.baselineForSignal(member, 'lab:hba1c');
    expect(b.status).toBe('stable');
    expect(b.mean).toBeCloseTo(5.433, 2);
    expect(b.confidence.level).toBe('moderate');
  });

  it('sudden_deviation for a latest point far from its own history', () => {
    const svc = makeSvc([
      lab('hba1c', 5.4, '2026-01-01'), lab('hba1c', 5.5, '2026-02-01'),
      lab('hba1c', 5.4, '2026-03-01'), lab('hba1c', 5.5, '2026-04-01'),
      lab('hba1c', 9.8, '2026-05-01'),
    ]);
    const b = svc.baselineForSignal(member, 'lab:hba1c');
    expect(b.status).toBe('sudden_deviation');
    expect(Math.abs(b.latest.robustZ)).toBeGreaterThanOrEqual(3);
  });

  it('persistent_deviation when the last 3 sit clearly off-mean on one side', () => {
    const rows = [100, 100, 100, 100, 100, 100, 122, 122, 122].map((v, i) =>
      lab('x', v, `2026-0${Math.min(i + 1, 9)}-15`),
    );
    const svc = makeSvc(rows);
    const b = svc.baselineForSignal(member, 'lab:x');
    expect(b.status).toBe('persistent_deviation');
  });

  it('gradual_drift for steady movement across the span', () => {
    const rows = [100, 105, 110, 115, 120, 125].map((v, i) =>
      lab('x', v, `2026-0${i + 1}-01`),
    );
    const svc = makeSvc(rows);
    const b = svc.baselineForSignal(member, 'lab:x');
    expect(b.status).toBe('gradual_drift');
    expect(b.latest.slopePerDay).toBeGreaterThan(0);
  });

  it('splits recent vs long-term baselines with a documented method', () => {
    const rows = [100, 102, 101, 130, 132, 131].map((v, i) => lab('x', v, `2026-0${i + 1}-01`));
    const svc = makeSvc(rows);
    const b = svc.baselineForSignal(member, 'lab:x');
    expect(b.recentBaseline.value).toBeCloseTo(131, 5);
    expect(b.longTermBaseline.value).toBeCloseTo(101, 5);
    expect(b.recentBaseline.method).toMatch(/most recent 3/);
    expect(b.longTermBaseline.method).toMatch(/before the recent window/);
  });

  it('high confidence needs repeated observations over a long span', () => {
    const rows = [5.4, 5.5, 5.4, 5.5, 5.4, 5.5].map((v, i) => lab('hba1c', v, `2026-0${i + 1}-01`));
    const svc = makeSvc(rows);
    const b = svc.baselineForSignal(member, 'lab:hba1c');
    expect(b.observationCount).toBe(6);
    expect(b.spanDays).toBeGreaterThan(60);
    expect(b.confidence.level).toBe('high');
  });

  it('low extraction confidence downgrades baseline confidence with a reason', () => {
    const rows = [5.4, 5.5, 5.4, 5.5, 5.4, 5.5].map((v, i) => lab('hba1c', v, `2026-0${i + 1}-01`, 0.3));
    const svc = makeSvc(rows);
    const b = svc.baselineForSignal(member, 'lab:hba1c');
    expect(b.confidence.level).toBe('low');
    expect(b.confidence.reasons.join(' ')).toMatch(/extraction confidence/i);
  });
});

describe('PersonalBaselineService — signals, safety, verified-only', () => {
  it('builds observation + derived-BMI signals alongside labs', () => {
    const svc = makeSvc(
      [lab('hba1c', 5.4, '2026-01-01'), lab('hba1c', 5.5, '2026-02-01'), lab('hba1c', 5.4, '2026-03-01')],
      {
        weight: [
          { observed_at: '2026-01-01', data: { weightKg: 80 } },
          { observed_at: '2026-02-01', data: { weightKg: 81 } },
          { observed_at: '2026-03-01', data: { weightKg: 80 } },
        ],
      },
    );
    const all = svc.baselinesFor(member);
    const ids = all.baselines.map((b) => b.signal);
    expect(ids).toContain('lab:hba1c');
    expect(ids).toContain('obs:weight_kg');
    expect(ids).toContain('derived:bmi');
    const bmi = all.baselines.find((b) => b.signal === 'derived:bmi');
    expect(bmi.mean).toBeCloseTo(80.33 / 1.7 ** 2, 1);
  });

  it('returns null for unknown signals', () => {
    const svc = makeSvc([]);
    expect(svc.baselineForSignal(member, 'lab:nope')).toBeNull();
  });

  it('reads ONLY through the verified query (unverified drafts unreachable)', () => {
    const calls = [];
    const svc = new PersonalBaselineService({
      labResultRepository: {
        verifiedValuesForMember: (id) => {
          calls.push(id);
          return [];
        },
      },
      observationRepository: { listForMember: () => ({ items: [], total: 0 }) },
    });
    svc.baselinesFor(member);
    expect(calls).toEqual(['m1']); // the ONLY lab read; no unverified-capable method exists on the fake
  });

  it('SAFETY: never uses abnormal/diagnostic language; always carries the disclaimer', () => {
    const svc = makeSvc([
      lab('hba1c', 5.4, '2026-01-01'), lab('hba1c', 5.5, '2026-02-01'),
      lab('hba1c', 5.4, '2026-03-01'), lab('hba1c', 9.8, '2026-04-01'),
    ]);
    const all = svc.baselinesFor(member);
    expect(all.disclaimer).toBe(BASELINE_DISCLAIMER);
    const text = JSON.stringify(all);
    expect(text).not.toMatch(/abnormal/i);
    expect(text).not.toMatch(/diagnos/i);
    expect(text).not.toMatch(/you have/i);
    expect(text).toMatch(/personal baseline/i);
  });
});
