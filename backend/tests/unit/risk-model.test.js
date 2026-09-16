import { describe, it, expect } from 'vitest';
import { RiskModelService, bandFor, RISK_DISCLAIMER } from '../../src/services/RiskModelService.js';

const svc = new RiskModelService({ labResultRepository: null, observationRepository: null });

const src = (values) => {
  const out = {};
  const all = ['age', 'bmi', 'fastingGlucose', 'hba1c', 'systolicBp', 'hdl', 'triglycerides', 'familyDiabetes', 'activityLevel'];
  for (const k of all) out[k] = { value: values[k] ?? null, overridden: false };
  return out;
};

describe('RiskModelService — probability sanity', () => {
  it('probability is always in (0, 1)', () => {
    for (const v of [
      { age: 25, bmi: 22, fastingGlucose: 85, hba1c: 5.0 },
      { age: 70, bmi: 38, fastingGlucose: 180, hba1c: 8.4, familyDiabetes: 1 },
      { age: 45 },
      {},
    ]) {
      const r = svc.compute(src(v));
      expect(r.probability).toBeGreaterThan(0);
      expect(r.probability).toBeLessThan(1);
    }
  });

  it('is deterministic — identical inputs give identical outputs', () => {
    const s = src({ age: 50, bmi: 29, fastingGlucose: 120 });
    const a = svc.compute(s);
    const b = svc.compute(s);
    expect(a.probability).toBe(b.probability);
    expect(a.contributingFactors.length).toBe(b.contributingFactors.length);
  });

  it('higher fasting glucose ⇒ strictly higher probability (monotonic)', () => {
    const low = svc.compute(src({ age: 45, bmi: 26, fastingGlucose: 90 }));
    const high = svc.compute(src({ age: 45, bmi: 26, fastingGlucose: 150 }));
    expect(high.probability).toBeGreaterThan(low.probability);
  });

  it('protective inputs (high HDL, active) lower the probability', () => {
    const base = svc.compute(src({ age: 50, bmi: 28, fastingGlucose: 115 }));
    const protected_ = svc.compute(src({ age: 50, bmi: 28, fastingGlucose: 115, hdl: 75, activityLevel: 2 }));
    expect(protected_.probability).toBeLessThan(base.probability);
  });

  it('bandOf() thresholds partition [0,1] without gaps', () => {
    expect(bandFor(0)).toBe('low');
    expect(bandFor(0.149)).toBe('low');
    expect(bandFor(0.15)).toBe('moderate');
    expect(bandFor(0.3499)).toBe('moderate');
    expect(bandFor(0.35)).toBe('elevated');
    expect(bandFor(0.5999)).toBe('elevated');
    expect(bandFor(0.6)).toBe('high');
    expect(bandFor(1)).toBe('high');
  });
});

describe('RiskModelService — explainability & safety', () => {
  it('computes logit = intercept + Σ(weight × z) exactly (model transparency)', () => {
    // age=45 -> z=(45-45)/16=0; glucose 96+2*22=140 -> z=2; w=1.10 => contribution 2.2
    const r = svc.compute(src({ age: 45, fastingGlucose: 140 }));
    const expectedLogit = -2.35 + 0.3 * 0 + 1.1 * 2;
    const expectedProb = 1 / (1 + Math.exp(-expectedLogit));
    expect(r.probability).toBeCloseTo(expectedProb, 3); // response rounds to 4 decimals
  });

  it('contributions are signed correctly: risk drivers raise, protective inputs lower', () => {
    const r = svc.compute(src({ fastingGlucose: 150, hdl: 90, activityLevel: 2 }));
    const glucose = r.contributingFactors.find((f) => f.feature === 'fastingGlucose');
    const hdl = r.contributingFactors.find((f) => f.feature === 'hdl');
    expect(glucose.effectOnEstimate).toBe('raises');
    expect(hdl.effectOnEstimate).toBe('lowers');
  });

  it('factors are sorted by absolute contribution (biggest driver first)', () => {
    const r = svc.compute(src({ age: 45, bmi: 27, fastingGlucose: 170, hba1c: 6.8, familyDiabetes: 1 }));
    const contrib = r.contributingFactors.map((f) => Math.abs(f.contribution));
    const sorted = [...contrib].sort((a, b) => b - a);
    expect(contrib).toEqual(sorted);
    expect(r.contributingFactors[0].feature).toBe('fastingGlucose');
  });

  it('reports missing inputs explicitly (uncertainty communication)', () => {
    const r = svc.compute(src({ age: 45, bmi: 28 }));
    expect(r.completeness).toBe(0.22); // rounded to 2 decimals in the response
    expect(r.missingInputs.map((m) => m.feature)).toContain('fastingGlucose');
    expect(r.confidenceNote).toMatch(/uncertain/i);
  });

  it('every response carries the not-a-diagnosis disclaimer', () => {
    const r = svc.compute(src({}));
    expect(r.disclaimer).toBe(RISK_DISCLAIMER);
    expect(r.disclaimer).toMatch(/NOT a medical diagnosis/i);
    expect(r.disclaimer).toMatch(/clinically validated/i);
  });

  it('flags overridden inputs as a what-if scenario, with a scenario note', () => {
    const s = src({ age: 50, fastingGlucose: 140 });
    s.fastingGlucose.overridden = true;
    const r = svc.compute(s);
    expect(r.scenarioApplied).toBe(true);
    expect(r.scenarioNote).toMatch(/scenario/i);
    const gf = r.contributingFactors.find((f) => f.feature === 'fastingGlucose');
    expect(gf.overridden).toBe(true);
  });

  it('never crashes on non-numeric / NaN junk — it gets ignored', () => {
    const r = svc.compute(src({ age: 'not-a-number', fastingGlucose: NaN }));
    expect(r.contributingFactors).toHaveLength(0);
    expect(r.completeness).toBe(0);
  });
});

describe('RiskModelService — input assembly from member data', () => {
  it('computes BMI from height + latest weight observation', () => {
    const fake = new RiskModelService({
      labResultRepository: { latestForMember: () => null },
      observationRepository: {
        latestOfKind: (id, kind) =>
          kind === 'weight' ? { data: { weightKg: 84 } } : null,
      },
    });
    const member = { id: 'm1', dob: '1980-01-01', height_cm: 170, familyHistory: {} };
    const assembled = fake.assembleInputs(member);
    expect(assembled.bmi.value).toBeCloseTo(29.1, 1);
    expect(assembled.age.value).toBe(46);
  });

  it('maps activity minutes/week into sedentary/moderate/active levels', () => {
    for (const [minutes, level] of [[30, 0], [100, 1], [200, 2]]) {
      const fake = new RiskModelService({
        labResultRepository: { latestForMember: () => null },
        observationRepository: {
          latestOfKind: (id, kind) => (kind === 'activity' ? { data: { minutesPerWeek: minutes } } : null),
        },
      });
      const assembled = fake.assembleInputs({ id: 'm1', familyHistory: {} });
      expect(assembled.activityLevel.value).toBe(level);
    }
  });

  it('overrides flow through and are flagged', () => {
    const fake = new RiskModelService({
      labResultRepository: { latestForMember: () => ({ value: 140 }) },
      observationRepository: { latestOfKind: () => null },
    });
    const assembled = fake.assembleInputs({ id: 'm1', familyHistory: {} }, { fastingGlucose: 95, hackAttempt: 999 });
    expect(assembled.fastingGlucose).toEqual({ value: 95, overridden: true });
    expect(assembled.hackAttempt).toBeUndefined(); // unknown features never enter the model
  });
});
