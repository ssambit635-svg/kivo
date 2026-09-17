import { describe, it, expect, afterAll } from 'vitest';
import { AskTwinService, MAX_QUESTION_LENGTH } from '../../src/services/AskTwinService.js';
import { GroundedLocalProvider } from '../../src/services/llm/GroundedLocalProvider.js';
import { Container } from '../../src/container/Container.js';
import { Config } from '../../src/config/Config.js';

/**
 * Unit tests for Ask the Twin: deterministic intent classification, marker
 * matching, hostile-input robustness, and the safety properties of the
 * grounded narration (no diagnosis language, numbers copied verbatim).
 */

function makeService() {
  const config = new Config({ NODE_ENV: 'test', JWT_SECRET: 'unit-test-secret-0123456789abcdef' });
  const container = new Container({ config });
  return { container, service: container.askTwinService };
}

describe('AskTwinService.classifyIntent — deterministic routing', () => {
  const { container, service } = makeService();

  const CASES = [
    // greeting / thanks / capabilities
    ['Hello!', 'greeting'],
    ['hi', 'greeting'],
    ['good morning', 'greeting'],
    ['Thanks', 'thanks'],
    ['what can you do?', 'capabilities'],
    ['help me', 'capabilities'],
    // diagnosis-seeking ALWAYS wins over everything else (safety)
    ['Do I have diabetes?', 'diagnosis_request'],
    ['am I diabetic', 'diagnosis_request'],
    ['diagnose me', 'diagnosis_request'],
    ['do I have cancer', 'diagnosis_request'],
    ['Do I have high glucose?', 'diagnosis_request'],
    // risk
    ['what is my risk?', 'risk'],
    ['what are the chances of me getting diabetes?', 'risk'],
    ['how likely am I to develop it?', 'risk'],
    // medications
    ['tell me about my medications', 'medications'],
    ['what about the pills I take?', 'medications'],
    // doctor
    ['what should I ask my doctor?', 'doctor'],
    ['prepare me for my appointment', 'doctor'],
    // guidance
    ['what should I do to improve?', 'guidance'],
    ['any diet advice?', 'guidance'],
    ['how can I sleep better?', 'guidance'],
    // score
    ['how am I doing overall?', 'score'],
    ['what is my health score?', 'score'],
    // baseline / anomaly / patterns
    ['what is my baseline?', 'baseline'],
    ['what is normal for me?', 'baseline'],
    ['anything unusual lately?', 'anomaly'],
    ['did anything spike recently?', 'anomaly'],
    ['are my signals connected?', 'patterns'],
    ['any patterns in my data?', 'patterns'],
    // milestones / reports
    ['what milestones do I have?', 'milestones'],
    ['how many reports do I have?', 'reports'],
    // changes
    ['What has changed in my health over the last year?', 'changes'],
    ['what changed since my first report?', 'changes'],
    ['any differences between my reports?', 'changes'],
    ['is my health getting worse?', 'changes'],
    // unknown
    ['tell me about the weather on Mars', 'unknown'],
    ['banana', 'unknown'],
  ];

  for (const [q, expected] of CASES) {
    it(`"${q}" → ${expected}`, () => {
      expect(service.classifyIntent(q).intent).toBe(expected);
    });
  }
  afterAll(() => container.close());

  it('marker questions beat generic intents when a marker is named', () => {
    expect(service.classifyIntent('How is my HbA1c doing?').intent).toBe('marker');
    expect(service.classifyIntent('what about my fasting glucose').intent).toBe('marker');
    expect(service.classifyIntent('LDL and HDL please').intent).toBe('marker');
    expect(service.classifyIntent('creatinine').intent).toBe('marker');
  });

  it('longest alias wins (fasting glucose ≠ generic glucose collision)', () => {
    const { matchedCodes } = service.classifyIntent('How is my fasting glucose?');
    expect(matchedCodes).toContain('fasting_glucose');
    expect(matchedCodes).not.toContain('glucose_random'); // sanity: no spurious code
  });

  it('never matches more than 3 markers at once', () => {
    const q = 'hba1c glucose ldl hdl triglycerides creatinine hemoglobin tsh';
    const { matchedCodes } = service.classifyIntent(q);
    expect(matchedCodes.length).toBeLessThanOrEqual(3);
  });

  it('classification is total: hostile inputs classify, never throw', () => {
    for (const bad of [null, undefined, '', '   ', 0, 123, {}, [], true, '\x00\x00', '💉'.repeat(50), 'x'.repeat(5000)]) {
      expect(() => service.classifyIntent(bad)).not.toThrow();
      const out = service.classifyIntent(bad);
      expect(typeof out.intent).toBe('string');
      expect(Array.isArray(out.matchedCodes)).toBe(true);
    }
  });
});

describe('AskTwinService.gatherEvidence — degradation, never throws', () => {
  it('degrades when every repository throws', async () => {
    const throwing = new Proxy({}, { get: () => () => { throw new Error('boom'); } });
    const service = new AskTwinService({
      trendService: { analyze: () => { throw new Error('boom'); }, analyzeMember: () => { throw new Error('boom'); } },
      riskModelService: { assess: () => { throw new Error('boom'); } },
      reportRepository: throwing,
      labResultRepository: throwing,
      observationRepository: throwing,
      intelligenceOrchestrator: { getEvidence: () => { throw new Error('boom'); } },
      healthScoreService: { timelineFor: () => { throw new Error('boom'); } },
      milestoneService: { evaluate: () => { throw new Error('boom'); } },
      doctorSummaryService: { build: () => { throw new Error('boom'); } },
      guidanceService: { forMember: () => { throw new Error('boom'); } },
      medicationAwarenessService: { forMember: () => { throw new Error('boom'); } },
      llmGateway: new (class { async narrate() { return { text: 'x', provider: 'grounded-local', deterministic: true, grounding: {} }; } })(),
      policyService: { loadMemberWithAccess: () => ({ member: { id: 'm1', name: 'T' } }), assertRead: () => {} },
      auditService: { record: () => { throw new Error('audit down'); } }, // even audit failure must not break
    });
    for (const intent of ['changes', 'risk', 'marker', 'diagnosis_request', 'score', 'milestones', 'doctor', 'guidance', 'medications', 'baseline', 'anomaly', 'patterns', 'reports', 'unknown']) {
      const evidence = await service.gatherEvidence({ id: 'm1', name: 'T' }, intent, ['hba1c'], { id: 'u1' });
      expect(evidence).toHaveProperty('dataSummary');
    }
  });

  it('audit failures never break ask()', async () => {
    const { container } = makeService();
    const user = container.userRepository.create({
      email: 'audit-down@mt.test',
      displayName: 'Audit Down',
      passwordHash: container.passwordService.hash('Str0ng!Passw0rd#2026'),
    });
    const member = container.memberRepository.create({ userId: user.id, name: 'T', relationship: 'self' });
    const actor = { id: user.id, role: 'member' };
    container.auditService.record = () => { throw new Error('audit down'); };
    const res = await container.askTwinService.ask(actor, member.id, 'What changed over time?', {});
    expect(res.answer.length).toBeGreaterThan(0);
    container.close();
  });
});

describe('GroundedLocalProvider.askTwin — safety properties of the narration', () => {
  const provider = new GroundedLocalProvider();
  const DIAGNOSTIC_CLAIM = /\b(you have|you suffer from|you are (?:diabetic|pre-?diabetic)|diagnosed with)\s+(diabetes|cancer|hypertension|a disease|an illness)/i;

  it('diagnosis intent ALWAYS refuses and never claims a condition', async () => {
    for (const evidence of [{}, { trends: [] }, { dataSummary: {} }, null, undefined]) {
      const out = await provider.generate({
        task: 'ask_twin',
        data: { memberName: 'X', intent: 'diagnosis_request', evidence: evidence ?? {} },
      });
      expect(out.text).toMatch(/cannot diagnose/i);
      expect(out.text).not.toMatch(DIAGNOSTIC_CLAIM);
      expect(out.grounding.safetyNotice).toBeTruthy();
    }
  });

  it('copies risk numbers verbatim — never invents them', async () => {
    const riskResult = {
      percent: 37.3,
      band: 'elevated',
      completeness: 0.67,
      confidenceNote: 'Moderate data completeness — estimate has meaningful uncertainty.',
      contributingFactors: [{ label: 'Fasting glucose', value: 118, unit: 'mg/dL', effectOnEstimate: 'raises' }],
      disclaimer: 'd',
    };
    const out = await provider.generate({
      task: 'ask_twin',
      data: { memberName: 'X', intent: 'risk', evidence: { dataSummary: {}, risk: { result: riskResult } } },
    });
    expect(out.text).toContain('37.3%');
    expect(out.text).toContain('elevated');
    expect(out.text).toContain('67%');
    expect(out.text).toContain('Fasting glucose');
    expect(out.text).not.toContain('38%'); // no rounding/invention
  });

  it('empty evidence degrades to a friendly grounded answer for every intent', async () => {
    const intents = ['greeting', 'thanks', 'capabilities', 'risk', 'marker', 'changes', 'score', 'baseline',
      'anomaly', 'patterns', 'medications', 'guidance', 'doctor', 'reports', 'milestones', 'unknown'];
    for (const intent of intents) {
      const out = await provider.generate({
        task: 'ask_twin',
        data: { memberName: 'Y', intent, evidence: { dataSummary: {} } },
      });
      expect(typeof out.text).toBe('string');
      expect(out.text.length).toBeGreaterThan(10);
      expect(out.text).not.toMatch(DIAGNOSTIC_CLAIM);
      expect(out.deterministic).toBe(true);
    }
  });

  it('question length bound matches the service constant', () => {
    expect(MAX_QUESTION_LENGTH).toBe(400);
  });
});
