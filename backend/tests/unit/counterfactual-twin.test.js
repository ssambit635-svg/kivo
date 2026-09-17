import { describe, it, expect } from 'vitest';
import { CounterfactualTwinService, SCENARIO_LABELS, COUNTERFACTUAL_DISCLAIMER } from '../../src/services/intelligence/CounterfactualTwinService.js';
import { RiskModelService } from '../../src/services/RiskModelService.js';

function makeSvc({ labRows = [], obsByKind = {}, memberOverrides = {} } = {}) {
  const labResultRepository = {
    verifiedValuesForMember: () => labRows,
    latestForMember: (memberId, code) => {
      const rows = labRows.filter((r) => r.code === code).sort((a, b) => (a.measured_at < b.measured_at ? 1 : -1));
      return rows[0] || null;
    },
  };
  const observationRepository = {
    listForMember: (memberId, { kind, pageSize }) => {
      const items = (obsByKind[kind] || []).map((o, i) => ({ id: `ob-${kind}-${i}`, ...o }));
      return { items: items.slice(0, pageSize), total: items.length, page: 1, pageSize };
    },
    latestOfKind: (memberId, kind) => {
      const items = (obsByKind[kind] || []).map((o, i) => ({ id: `ob-${kind}-${i}`, ...o }));
      return items.sort((a, b) => (a.observed_at < b.observed_at ? 1 : -1))[0] || null;
    },
  };
  const riskModelService = new RiskModelService({ labResultRepository, observationRepository });
  const svc = new CounterfactualTwinService({ labResultRepository, observationRepository, riskModelService });
  const member = { id: 'm1', name: 'T', dob: '1980-01-01', height_cm: 170, updated_at: '2026-01-01', familyHistory: {}, ...memberOverrides };
  return { svc, member, labResultRepository, observationRepository };
}

const lab = (code, value, measured_at = '2026-01-01') => ({
  id: `lr-${code}-${measured_at}`, code, test_name: code, value, unit: 'x', confidence: 0.9, measured_at,
});

describe('CounterfactualTwinService — simulation', () => {
  it('snapshots the real state and applies hypothetical changes to the copy', () => {
    const { svc, member } = makeSvc({
      labRows: [lab('fasting_glucose', 120), lab('hba1c', 6.0)],
      obsByKind: { weight: [{ observed_at: '2026-01-01', data: { weightKg: 90 } }] },
    });
    const out = svc.simulate(member, { weightKg: 80 });
    expect(out.baseline.weightKg).toBe(90);
    expect(out.scenario.weightKg).toBe(80);
    expect(out.baseline.bmi).toBeCloseTo(31.1, 1);
    expect(out.scenario.bmi).toBeCloseTo(27.7, 1);
    const bmiFactor = out.changedFactors.find((f) => f.field === 'weightKg');
    expect(bmiFactor.modelEffect).toBe('via_bmi');
    expect(bmiFactor.derivedBmi).toBeCloseTo(27.7, 1);
  });

  it('re-runs the EXISTING model: lower hypothetical BMI lowers the model score', () => {
    const { svc, member } = makeSvc({
      labRows: [lab('fasting_glucose', 120)],
      obsByKind: { weight: [{ observed_at: '2026-01-01', data: { weightKg: 90 } }] },
    });
    const out = svc.simulate(member, { weightKg: 75 });
    expect(out.modelAfter.result.probability).toBeLessThan(out.modelBefore.result.probability);
    expect(out.modelAfter.result.scenarioApplied).toBe(true);
    const bmiDelta = out.contributionChanges.find((c) => c.feature === 'bmi');
    expect(bmiDelta.delta).toBeLessThan(0);
  });

  it('real data is NEVER modified by simulation', () => {
    const ctx = makeSvc({
      labRows: [lab('fasting_glucose', 120)],
      obsByKind: { weight: [{ observed_at: '2026-01-01', data: { weightKg: 90 } }] },
    });
    const before = JSON.stringify(ctx.svc.snapshot(ctx.member));
    ctx.svc.simulate(ctx.member, { weightKg: 60, fastingGlucose: 80 });
    ctx.svc.explore(ctx.member);
    expect(JSON.stringify(ctx.svc.snapshot(ctx.member))).toBe(before);
    // and the fake repos expose no write methods at all — any write attempt would throw
  });

  it('context-only fields are recorded with NO invented model effect', () => {
    const { svc, member } = makeSvc({
      labRows: [lab('fasting_glucose', 120)],
      obsByKind: { sleep: [{ observed_at: '2026-01-01', data: { hours: 5 } }] },
    });
    const out = svc.simulate(member, { sleepHours: 8 });
    const f = out.changedFactors.find((x) => x.field === 'sleepHours');
    expect(f.modelEffect).toBe('context_only');
    expect(out.modelAfter.result.probability).toBe(out.modelBefore.result.probability);
    expect(out.contributionChanges.every((c) => c.delta === 0)).toBe(true);
  });

  it('weight scenarios without recorded height are not_computable (no guessing)', () => {
    const { svc, member } = makeSvc({
      obsByKind: { weight: [{ observed_at: '2026-01-01', data: { weightKg: 90 } }] },
      memberOverrides: { height_cm: null },
    });
    const out = svc.simulate(member, { weightKg: 80 });
    expect(out.changedFactors[0].modelEffect).toBe('not_computable');
  });
});

describe('CounterfactualTwinService — impossible scenarios rejected', () => {
  it('rejects out-of-range values with field-level detail', () => {
    const { svc, member } = makeSvc();
    try {
      svc.simulate(member, { weightKg: 999, hba1c: 99 });
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(err.details)).toMatch(/outside the plausible prototype range/);
      expect(err.details).toHaveLength(2);
      return;
    }
    throw new Error('should have thrown');
  });

  it('rejects unknown fields, empty changes, and non-numbers', () => {
    const { svc, member } = makeSvc();
    try {
      svc.simulate(member, { evilFeature: 1 });
    } catch (err) {
      expect(err.status).toBe(400);
      expect(JSON.stringify(err.details)).toMatch(/Unsupported scenario field/);
    }
    expect(() => svc.simulate(member, {})).toThrow(/at least one/i);
    try {
      svc.simulate(member, { weightKg: 'a lot' });
    } catch (err) {
      expect(JSON.stringify(err.details)).toMatch(/finite number/);
    }
    expect(() => svc.simulate(member, null)).toThrow(/must be an object/);
  });
});

describe('CounterfactualTwinService — scenario explorer', () => {
  it('generates preset scenarios ranked ONLY by mathematical model effect', () => {
    const { svc, member } = makeSvc({
      labRows: [lab('fasting_glucose', 120)],
      obsByKind: {
        weight: [{ observed_at: '2026-01-01', data: { weightKg: 90 } }],
        activity: [{ observed_at: '2026-01-01', data: { minutesPerWeek: 30 } }],
      },
    });
    const out = svc.explore(member);
    expect(out.kind).toBe('model_scenario_explorer');
    expect(out.scenarios.length).toBeGreaterThanOrEqual(4);
    const deltas = out.scenarios.map((s) => s.deltaProbability);
    expect(deltas).toEqual([...deltas].sort((a, b) => a - b)); // largest decrease first
    expect(out.scenarios[0].rank).toBe(1);
    expect(out.rankingNote).toMatch(/ranked ONLY by mathematical effect/i);
    expect(out.rankingNote).toMatch(/not advice/i);
  });

  it('skips infeasible presets with reasons instead of fabricating', () => {
    const { svc, member } = makeSvc(); // no weight/activity recorded
    const out = svc.explore(member);
    expect(out.scenarios).toHaveLength(0);
    expect(out.skipped.length).toBeGreaterThan(0);
    expect(out.skipped[0].reason).toMatch(/No recorded/);
  });

  it('respects maxScenarios and factor filters', () => {
    const { svc, member } = makeSvc({
      obsByKind: {
        weight: [{ observed_at: '2026-01-01', data: { weightKg: 90 } }],
        activity: [{ observed_at: '2026-01-01', data: { minutesPerWeek: 30 } }],
      },
    });
    expect(svc.explore(member, { maxScenarios: 2 }).scenarios).toHaveLength(2);
    const activityOnly = svc.explore(member, { factors: ['activity'] });
    expect(activityOnly.scenarios.every((s) => !('weightKg' in s.changes))).toBe(true);
  });
});

describe('CounterfactualTwinService — labels + safety', () => {
  it('every output carries the four scenario labels and disclaimer', () => {
    const { svc, member } = makeSvc({
      obsByKind: { weight: [{ observed_at: '2026-01-01', data: { weightKg: 90 } }] },
    });
    const sim = svc.simulate(member, { weightKg: 85 });
    expect(sim.labels).toEqual(SCENARIO_LABELS);
    expect(sim.disclaimer).toBe(COUNTERFACTUAL_DISCLAIMER);
    const exp = svc.explore(member);
    expect(exp.labels).toEqual(SCENARIO_LABELS);
    const text = JSON.stringify({ sim, exp });
    expect(text).not.toMatch(/you should/i);
    expect(text).not.toMatch(/you have/i);
  });
});
