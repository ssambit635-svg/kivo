import { describe, it, expect } from 'vitest';
import { LabExtractionService } from '../../src/services/labs/LabExtractionService.js';
import { calibrateExtraction, featurize } from '../../src/knowledge/calibration.js';
import { normalizeOcrText, normalizeOcrLine } from '../../src/knowledge/textNormalizer.js';
import { checkPlausibility } from '../../src/knowledge/clinicalKnowledge.js';
import { TrendService } from '../../src/services/TrendService.js';
import { RiskModelService, bandFor as riskBand } from '../../src/services/RiskModelService.js';
import { HealthScoreService, bandFor as scoreBand } from '../../src/services/HealthScoreService.js';
import { DoctorSummaryService } from '../../src/services/DoctorSummaryService.js';
import { MilestoneService } from '../../src/services/MilestoneService.js';
import { GroundedLocalProvider } from '../../src/services/llm/GroundedLocalProvider.js';
import { ageFromDob, daysBetween } from '../../src/utils/time.js';
import { IntelligenceOrchestratorService } from '../../src/services/intelligence/IntelligenceOrchestratorService.js';
import { CounterfactualTwinService } from '../../src/services/intelligence/CounterfactualTwinService.js';
import { SignalCollector, mean, median, sd, mad, robustZ, slopePerDay, pearson, round2, round3 } from '../../src/services/intelligence/signalSeries.js';

const HOSTILE_TEXTS = [
  null, undefined, 0, 12345, {}, [], true,
  '', '   ', '\n\n', '\x00\x00\x00',
  'Glucose NaN mg/dL', 'Glucose Infinity mg/dL', 'Glucose -Infinity mg/dL',
  'Glucose 1e99999 mg/dL', 'A'.repeat(500_000),
  'Glucose\x00126\x00mg/dL', '💉'.repeat(1000),
  '<script>alert(1)</script>', "'; DROP TABLE lab_results; --",
  'Glucose 126 mg/dL\n'.repeat(10000),
  '\u202e\u200b\ufeff Gluco\u0301se 12\u00a06',
];

const nullRepos = {
  labResultRepository: { latestForMember: () => null, seriesForMember: () => [], codesWithVerifiedData: () => [], verifiedValuesForMember: () => [], verifiedMeasuredDates: () => [] },
  observationRepository: { latestOfKind: () => null, listForMember: () => ({ items: [], total: 0 }) },
};

describe('never-crash robustness: hostile inputs degrade, never throw', () => {
  const extractor = new LabExtractionService();

  it('extraction survives every hostile text', () => {
    for (const input of HOSTILE_TEXTS) {
      let out;
      expect(() => { out = extractor.extract(input); }, `extract(${JSON.stringify(String(input).slice(0, 40))}) threw`).not.toThrow();
      expect(Array.isArray(out.extracted)).toBe(true);
      for (const row of out.extracted) {
        expect(Number.isFinite(row.confidence)).toBe(true);
        expect(row.confidence).toBeGreaterThanOrEqual(0);
        expect(row.confidence).toBeLessThanOrEqual(1);
        if (row.value != null) expect(Number.isFinite(row.value)).toBe(true);
      }
      expect(out.normalization).toHaveProperty('corrections');
    }
  });

  it('normalizer survives every hostile text and line', () => {
    for (const input of HOSTILE_TEXTS) {
      let out;
      expect(() => { out = normalizeOcrText(input); }).not.toThrow();
      expect(typeof out.text).toBe('string');
      expect(Array.isArray(out.corrections)).toBe(true);
    }
    for (const input of HOSTILE_TEXTS) {
      expect(() => normalizeOcrLine(input)).not.toThrow();
    }
  });

  it('calibration survives hostile feature sets', () => {
    const hostileInputs = [
      null, undefined, 0, 'x', [],
      {}, { heuristicConfidence: NaN }, { heuristicConfidence: Infinity },
      { heuristicConfidence: -5 }, { heuristicConfidence: 'high' },
      { heuristicConfidence: 0.9, suspicious: 'yes' },
      { aliasLength: NaN }, { aliasLength: 'long' },
      { heuristicConfidence: 0.8, hasUnit: 1, aliasAtLineStart: 'y' },
    ];
    for (const input of hostileInputs) {
      let c;
      expect(() => { c = calibrateExtraction(input); }, `calibrate(${JSON.stringify(input)}) threw`).not.toThrow();
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(1);
    }
    // featurize is always finite, always the right length
    for (const input of hostileInputs) {
      const x = featurize(input);
      expect(x.length).toBe(9);
      expect(x.every(Number.isFinite)).toBe(true);
    }
  });

  it('plausibility check never throws', () => {
    for (const code of [null, undefined, 0, {}, 'hba1c', 'nope']) {
      for (const value of [null, undefined, NaN, Infinity, 'x', {}, [], 5.4, 1e308]) {
        let out;
        expect(() => { out = checkPlausibility(code, value); }).not.toThrow();
        expect(typeof out.plausible).toBe('boolean');
      }
    }
  });

  it('trend engine survives hostile series', () => {
    const trends = new TrendService(nullRepos.labResultRepository);
    const hostileSeries = [
      null, undefined, {}, 'x', 42,
      [], [null, undefined, {}],
      [{ value: null }, { value: NaN }, { value: Infinity }],
      [{ value: 5, measured_at: 'not-a-date' }, { value: 6, measured_at: null }],
      [{ value: 0, measured_at: '2026-01-01' }, { value: 0, measured_at: '2026-02-01' }],
      [{ value: 1e308, measured_at: '2026-01-01' }, { value: -1e308, measured_at: '2026-02-01' }],
    ];
    for (const series of hostileSeries) {
      let out;
      expect(() => { out = trends.analyze('hba1c', series); }).not.toThrow();
      expect(typeof out).toBe('object');
    }
    expect(() => trends.analyze(null, null)).not.toThrow();
    expect(() => trends.analyzeMember(null)).not.toThrow();
    expect(() => trends.analyzeMember('x', { minPoints: NaN })).not.toThrow();
    expect(trends.analyzeCode('x', 'definitely-not-a-marker')).toBeNull();
    expect(() => trends.leastSquaresSlope(null)).not.toThrow();
    expect(trends.leastSquaresSlope(null)).toBeNull();
  });

  it('risk model survives hostile members and overrides', () => {
    const risk = new RiskModelService(nullRepos);
    const hostileMembers = [null, undefined, {}, { id: null }, { id: 'x', dob: 'garbage', height_cm: 0, familyHistory: 'x' }, { id: 'x', dob: '2050-01-01', height_cm: -5 }];
    const hostileOverrides = [null, undefined, 0, 'x', [], { bmi: NaN }, { bmi: Infinity }, { age: 'old' }, { nope: 1 }];
    for (const member of hostileMembers) {
      for (const overrides of hostileOverrides) {
        let out;
        expect(() => { out = risk.assess(member, overrides); }, `assess threw`).not.toThrow();
        expect(Number.isFinite(out.result.probability)).toBe(true);
        expect(out.result.probability).toBeGreaterThanOrEqual(0);
        expect(out.result.probability).toBeLessThanOrEqual(1);
        expect(out.result.disclaimer).toBeTruthy();
      }
    }
    expect(() => risk.compute(null)).not.toThrow();
    expect(() => risk.compute({ bmi: { value: NaN } })).not.toThrow();
    // band helpers are total
    for (const p of [null, undefined, NaN, Infinity, -1, 'x', {}, 0, 0.5, 1, 2]) {
      expect(() => riskBand(p)).not.toThrow();
      expect(() => scoreBand(p)).not.toThrow();
    }
  });

  it('health score survives hostile members and rows', () => {
    const throwingLabs = { verifiedValuesForMember: () => { throw new Error('db down'); } };
    const throwingReports = { verifiedWithValuesForMember: () => { throw new Error('db down'); } };
    const svc = new HealthScoreService({ labResultRepository: throwingLabs, reportRepository: throwingReports });
    let out;
    expect(() => { out = svc.timelineFor('x'); }).not.toThrow();
    expect(out.timeline).toEqual([]);

    const svc2 = new HealthScoreService({
      labResultRepository: {
        verifiedValuesForMember: () => [
          { code: 'hba1c', value: NaN, measured_at: 'garbage', test_name: 'HbA1c' },
          { code: null, value: 5, measured_at: '2026-01-01' },
          null,
        ],
      },
      reportRepository: { verifiedWithValuesForMember: () => [{ id: 'r1', report_date: 'not-a-date', created_at: 'also-bad' }] },
    });
    expect(() => svc2.timelineFor('x')).not.toThrow();
    expect(() => svc2.scorePoint(null, null)).not.toThrow();
    expect(() => svc2.scorePoint('hba1c', { value: Infinity, ref_low: 'x' })).not.toThrow();
    expect(() => svc2.snapshotScore(null, null)).not.toThrow();
  });

  it('doctor summary survives hostile members and failing engines', async () => {
    const failing = {
      reportRepository: { listByMember: () => { throw new Error('down'); } },
      labResultRepository: nullRepos.labResultRepository,
      observationRepository: { listForMember: () => { throw new Error('down'); } },
      trendService: { analyzeMember: () => { throw new Error('down'); } },
      riskModelService: { assess: () => { throw new Error('down'); } },
      llmGateway: { narrate: async () => { throw new Error('down'); } },
    };
    const svc = new DoctorSummaryService(failing);
    for (const member of [null, undefined, {}, { id: 'x' }]) {
      let out;
      await expect((async () => { out = await svc.build(member); })()).resolves.not.toThrow();
      expect(Array.isArray(out.sections)).toBe(true);
      expect(out.disclaimers.length).toBeGreaterThan(0);
    }
  });

  it('milestones survive failing repositories', () => {
    const failing = {
      reportRepository: { earliestForMember: () => { throw new Error('down'); }, firstVerifiedForMember: () => { throw new Error('down'); } },
      labResultRepository: { codesWithVerifiedData: () => { throw new Error('down'); }, seriesForMember: () => [], verifiedMeasuredDates: () => { throw new Error('down'); } },
      auditLogRepository: { firstForAction: () => { throw new Error('down'); } },
    };
    const svc = new MilestoneService(failing);
    let out;
    expect(() => { out = svc.evaluate('x'); }).not.toThrow();
    expect(out.earned).toBe(0);
    expect(() => svc.evaluate(null)).not.toThrow();
  });

  it('grounded narrator survives hostile tasks and data', async () => {
    const llm = new GroundedLocalProvider();
    const hostile = [null, undefined, {}, { task: null }, { task: 'explain_report' }, { task: 'explain_report', data: null }, { task: 'nope', data: { x: 1 } }, { task: 'summarize_trends', data: { trends: [null, {}] } }, { task: 'doctor_summary', data: { sections: 'x' } }, { task: 'explain_intelligence', data: {} }];
    for (const req of hostile) {
      let out;
      await expect((async () => { out = await llm.generate(req); })()).resolves.not.toThrow();
      expect(typeof out.text).toBe('string');
    }
  });

  it('intelligence statistics never emit NaN', () => {
    const hostileLists = [null, undefined, 0, 'x', {}, [], [NaN], [Infinity], ['x'], [1, NaN, 3], [1e308, 1e308]];
    for (const xs of hostileLists) {
      for (const fn of [mean, median, sd, mad]) {
        let out;
        expect(() => { out = fn(xs); }).not.toThrow();
        expect(out === null || Number.isFinite(out)).toBe(true);
      }
    }
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3])).toBe(2);
    expect(sd([1, 2, 3])).toBeCloseTo(1, 5);
    expect(robustZ(NaN, [1, 2, 3])).toBeNull();
    expect(robustZ(2, null)).toBeNull();
    const z = robustZ(2, [1, 2, 3]);
    expect(z === null || Number.isFinite(z)).toBe(true);
    expect(slopePerDay(null)).toBeNull();
    expect(slopePerDay([{ t: 'x', v: NaN }])).toBeNull();
    expect(pearson(null)).toBeNull();
    expect(pearson([[1, 1], [NaN, 2]])).toBeNull();
    const slope = slopePerDay([{ t: '2026-01-01', v: 1 }, { t: '2026-01-03', v: 3 }]);
    expect(slope === null || Number.isFinite(slope)).toBe(true);
    expect(Number.isFinite(round2(NaN))).toBe(true);
    expect(Number.isFinite(round3('x'))).toBe(true);
  });

  it('signal collector survives null members and failing repositories', () => {
    const failing = {
      labResultRepository: { verifiedValuesForMember: () => { throw new Error('down'); } },
      observationRepository: { listForMember: () => { throw new Error('down'); } },
    };
    const coll = new SignalCollector(failing);
    expect(() => coll.collect(null)).not.toThrow();
    let out;
    expect(() => { out = coll.collect({ id: 'x', height_cm: 0 }); }).not.toThrow();
    expect(Array.isArray(out.signals)).toBe(true);
    expect(() => coll.collect({ id: 'x', height_cm: 'tall' })).not.toThrow();

    const withData = new SignalCollector({
      labResultRepository: {
        verifiedValuesForMember: () => [
          { id: 'r1', code: 'hba1c', value: NaN, measured_at: 'garbage', test_name: 'HbA1c', unit: '%' },
          { id: 'r2', code: null, value: 5, measured_at: null },
          null,
          { id: 'r3', code: 'hba1c', value: 5.8, measured_at: '2026-01-01', test_name: 'HbA1c', unit: '%' },
        ],
      },
      observationRepository: { listForMember: () => ({ items: [{ id: 'o1', observed_at: 'bad', data: { weightKg: NaN } }], total: NaN }) },
    });
    expect(() => withData.collect({ id: 'x', height_cm: 170 })).not.toThrow();
    const collected = withData.collect({ id: 'x', height_cm: 170 });
    for (const s of collected.signals) {
      for (const p of s.points) {
        expect(Number.isFinite(p.v)).toBe(true);
      }
    }
  });

  it('intelligence orchestrator degrades instead of throwing', () => {
    const failing = {
      labResultRepository: { verifiedValuesForMember: () => { throw new Error('down'); } },
      observationRepository: { listForMember: () => { throw new Error('down'); } },
      riskModelService: { assess: () => { throw new Error('down'); } },
    };
    const orch = new IntelligenceOrchestratorService(failing);
    for (const member of [null, undefined, {}, { id: 'x', height_cm: -5 }]) {
      let out;
      expect(() => { out = orch.getEvidence(member); }).not.toThrow();
      expect(Array.isArray(out.summaryCards)).toBe(true);
      expect(out.disclaimers.length).toBeGreaterThan(0);
    }
    // uncertainty/cards are total over malformed sub-results
    expect(() => orch.overallUncertainty({ member: null, baselines: null, anomalies: null, risk: null })).not.toThrow();
    expect(() => orch.summaryCards({ member: null, baselines: null, anomalies: null, graph: null, risk: null, uncertainty: null })).not.toThrow();
    const cards = orch.summaryCards({ member: null, baselines: null, anomalies: null, graph: null, risk: null, uncertainty: null });
    expect(Array.isArray(cards)).toBe(true);
  });

  it('counterfactual twin validates and never emits Infinity', () => {
    const risk = new RiskModelService(nullRepos);
    const twin = new CounterfactualTwinService({ ...nullRepos, riskModelService: risk });
    expect(() => twin.snapshot(null)).not.toThrow();
    const snap = twin.snapshot({ id: 'x', height_cm: 0 });
    expect(snap.bmi === null || Number.isFinite(snap.bmi)).toBe(true);
    const snap2 = twin.snapshot({ id: 'x', height_cm: 'tall' });
    expect(snap2.bmi).toBeNull();
    // validation errors are clean ValidationErrors, not crashes
    for (const bad of [null, [], {}, { nope: 1 }, { weightKg: NaN }, { weightKg: 9999 }]) {
      expect(() => twin.simulate({ id: 'x' }, bad)).toThrow();
    }
    let sim;
    expect(() => { sim = twin.simulate({ id: 'x', height_cm: 170 }, { activityMinutesPerWeek: 150 }); }).not.toThrow();
    expect(Number.isFinite(sim.modelAfter.result.probability)).toBe(true);
    expect(() => twin.explore(null)).not.toThrow();
    expect(() => twin.explore({ id: 'x' }, { maxScenarios: NaN, factors: 'x' })).not.toThrow();
  });

  it('time helpers survive hostile dates', () => {
    for (const dob of [null, undefined, '', 'garbage', '2050-01-01', '1800-01-01', 0, {}, []]) {
      expect(() => ageFromDob(dob)).not.toThrow();
      const age = ageFromDob(dob);
      expect(age === null || (Number.isInteger(age) && age >= 0 && age <= 150)).toBe(true);
    }
    expect(ageFromDob('1990-06-15')).toBeGreaterThan(20);
    for (const [a, b] of [[null, null], ['x', 'y'], [undefined, '2026-01-01'], ['2026-13-45', '2026-01-01']]) {
      expect(Number.isFinite(daysBetween(a, b))).toBe(true);
    }
    expect(daysBetween('2026-01-01', '2026-01-11')).toBeCloseTo(10, 5);
  });
});
