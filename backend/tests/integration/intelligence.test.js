import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  makeTestContext,
  registerUser,
  makeAdmin,
  auth,
  ingestAndVerify,
} from '../helpers.js';

const R1 = [
  'CITY LAB', 'Report Date: 01-06-2025',
  'HbA1c 5.4 % (4.0 - 5.6)',
  'Fasting Blood Sugar 95 mg/dL 70 - 100',
  'Triglycerides 140 mg/dL (30 - 150)',
  'HDL Cholesterol 45 mg/dL (40 - 60)',
  'LDL Cholesterol 110 mg/dL (50 - 100)',
  'Total Cholesterol 190 mg/dL Reference: <200',
].join('\n');

const R2 = [
  'CITY LAB', 'Report Date: 01-12-2025',
  'HbA1c 5.7 % (4.0 - 5.6)',
  'Fasting Blood Sugar 105 mg/dL 70 - 100',
  'Triglycerides 170 mg/dL (30 - 150)',
  'HDL Cholesterol 43 mg/dL (40 - 60)',
  'LDL Cholesterol 125 mg/dL (50 - 100)',
  'Total Cholesterol 205 mg/dL Reference: <200',
].join('\n');

const R3 = [
  'CITY LAB', 'Report Date: 01-06-2026',
  'HbA1c 6.2 % (4.0 - 5.6)',
  'Fasting Blood Sugar 118 mg/dL 70 - 100',
  'Triglycerides 195 mg/dL (30 - 150)',
  'HDL Cholesterol 40 mg/dL (40 - 60)',
  'LDL Cholesterol 140 mg/dL (50 - 100)',
  'Total Cholesterol 220 mg/dL Reference: <200',
].join('\n');

let ctx;
let sess;
let memberId;
const MEMBER_NAME = 'Twin';

async function addObs(kind, payload, observedAt) {
  const res = await request(ctx.app)
    .post(`/api/members/${memberId}/observations`)
    .set(auth(sess.accessToken))
    .send({ kind, payload, observedAt });
  if (res.status !== 201) throw new Error(`obs failed: ${res.status} ${JSON.stringify(res.body)}`);
}

beforeAll(async () => {
  ctx = makeTestContext();
  sess = await registerUser(request, ctx.app, { email: 'twin@mt.test', displayName: MEMBER_NAME });
  const members = await request(ctx.app).get('/api/members').set(auth(sess.accessToken));
  memberId = members.body.owned.find((m) => m.relationship === 'self').id;

  await request(ctx.app).patch(`/api/members/${memberId}`).set(auth(sess.accessToken)).send({
    dob: '1981-05-04', sex: 'male', heightCm: 170, familyHistory: { diabetes: false },
  });

  await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, R1, '2025-06-01');
  await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, R2, '2025-12-01');
  await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, R3, '2026-06-01');

  await addObs('weight', { weightKg: 78 }, '2025-06-01');
  await addObs('weight', { weightKg: 82 }, '2025-12-01');
  await addObs('weight', { weightKg: 86 }, '2026-06-01');
  await addObs('activity', { minutesPerWeek: 120 }, '2025-06-01');
  await addObs('activity', { minutesPerWeek: 60 }, '2025-12-01');
  await addObs('activity', { minutesPerWeek: 40 }, '2026-06-01');
  await addObs('bp', { systolic: 122, diastolic: 80 }, '2026-06-01');
  await addObs('sleep', { hours: 6.5 }, '2026-06-01');
});
afterAll(() => ctx.container.close());

/** Strip explicitly-negated safety phrases, then ban affirmative harmful claims. */
function assertSafeLanguage(value) {
  const text = JSON.stringify(value)
    .replace(/not a diagnosis/gi, '')
    .replace(/not a medical diagnosis/gi, '')
    .replace(/does not diagnose/gi, '')
    .replace(/never diagnoses/gi, '')
    .replace(/not a doctor/gi, '')
    .replace(/associations are not causation/gi, '')
    .replace(/association is not causation/gi, '')
    .replace(/not evidence of causation/gi, '')
    .replace(/not evidence that one caused/gi, '')
    .replace(/not proof that one caused/gi, '')
    .replace(/not as a shared cause/gi, '')
    .replace(/no shared cause/gi, '')
    .replace(/does not claim causation/gi, '')
    .replace(/describes the model, not the body/gi, '')
    .replace(/non-causal/gi, '')
    .replace(/not a treatment recommendation/gi, '')
    .replace(/not a guaranteed outcome/gi, '')
    .replace(/not been clinically validated/gi, '')
    .replace(/has not been clinically validated/gi, '')
    .replace(/not clinically validated/gi, '');
  expect(text).not.toMatch(/you have/i);
  expect(text).not.toMatch(/you will develop/i);
  expect(text).not.toMatch(/diagnos/i);
  expect(text).not.toMatch(/caus(e[sd]?|ation|al)/i);
  expect(text).not.toMatch(/you should/i);
  expect(text).not.toMatch(/stop (taking|your) medication/i);
  expect(text).not.toMatch(/proves that/i);
  expect(text).not.toMatch(/guaranteed/i);
  expect(text).not.toMatch(/treatment recommendation/i);
}

describe('GET /intelligence — full evidence package', () => {
  it('returns baselines + anomalies + graph + risk + cards + disclaimers', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/intelligence`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.memberId).toBe(memberId);
    expect(b.dataSummary.verifiedLabCount).toBe(18);
    expect(b.baselines.baselines.length).toBeGreaterThanOrEqual(6);
    const hba1c = b.baselines.baselines.find((x) => x.signal === 'lab:hba1c');
    expect(hba1c.mean).toBeCloseTo((5.4 + 5.7 + 6.2) / 3, 2);
    expect(hba1c.observationCount).toBe(3);
    expect(hba1c.confidence.level).toBe('moderate');
    expect(b.anomalies.findings.length).toBeGreaterThan(0);
    expect(b.graph.nodes.length).toBeGreaterThan(0);
    expect(b.graph.edges.length).toBeGreaterThan(0);
    expect(b.risk.result.percent).toBeGreaterThan(0);
    expect(b.summaryCards.map((c) => c.key)).toEqual([
      'personal_baseline', 'detected_shift', 'health_pattern',
      'model_contribution', 'confidence', 'what_changed',
    ]);
    expect(b.disclaimers.join(' ')).toMatch(/not a diagnosis/i);
  });

  it('is cached briefly: repeat reads share a generatedAt until data changes', async () => {
    const a = await request(ctx.app).get(`/api/members/${memberId}/intelligence`).set(auth(sess.accessToken));
    const b = await request(ctx.app).get(`/api/members/${memberId}/intelligence`).set(auth(sess.accessToken));
    expect(a.body.generatedAt).toBe(b.body.generatedAt);
  });

  it('unverified drafts NEVER enter intelligence (safety gate holds)', async () => {
    const before = await request(ctx.app).get(`/api/members/${memberId}/intelligence`).set(auth(sess.accessToken));
    const meanBefore = before.body.baselines.baselines.find((x) => x.signal === 'lab:hba1c').mean;
    await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .send({ text: 'HbA1c 99.9 % (4.0 - 5.6)' });
    const after = await request(ctx.app).get(`/api/members/${memberId}/intelligence`).set(auth(sess.accessToken));
    expect(after.body.baselines.baselines.find((x) => x.signal === 'lab:hba1c').mean).toBe(meanBefore);
    // cleanup
    const list = await request(ctx.app)
      .get(`/api/members/${memberId}/reports?status=needs_review`)
      .set(auth(sess.accessToken));
    for (const r of list.body.items) {
      await request(ctx.app).delete(`/api/reports/${r.id}`).set(auth(sess.accessToken));
    }
  });

  it('SAFETY: no diagnostic/causal/prescriptive language anywhere in the package', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/intelligence`).set(auth(sess.accessToken));
    assertSafeLanguage(res.body);
  });
});

describe('GET /intelligence/baseline + /patterns', () => {
  it('single-signal baseline lookup; unknown signal is 404', async () => {
    const ok = await request(ctx.app)
      .get(`/api/members/${memberId}/intelligence/baseline?signal=lab:hba1c`)
      .set(auth(sess.accessToken));
    expect(ok.status).toBe(200);
    expect(ok.body.signal).toBe('lab:hba1c');
    const missing = await request(ctx.app)
      .get(`/api/members/${memberId}/intelligence/baseline?signal=lab:nope`)
      .set(auth(sess.accessToken));
    expect(missing.status).toBe(404);
  });

  it('patterns endpoint filters by relationship type and strength', async () => {
    const all = await request(ctx.app)
      .get(`/api/members/${memberId}/intelligence/patterns`)
      .set(auth(sess.accessToken));
    expect(all.status).toBe(200);
    expect(all.body.legend.OBSERVED).toBeDefined();
    expect(all.body.multivariateFindings).toBeDefined();
    const model = await request(ctx.app)
      .get(`/api/members/${memberId}/intelligence/patterns?type=MODEL_CONTRIBUTION`)
      .set(auth(sess.accessToken));
    expect(model.body.edges.length).toBeGreaterThan(0);
    expect(model.body.edges.every((e) => e.type === 'MODEL_CONTRIBUTION')).toBe(true);
    const strong = await request(ctx.app)
      .get(`/api/members/${memberId}/intelligence/patterns?minStrength=0.9`)
      .set(auth(sess.accessToken));
    expect(strong.body.edges.every((e) => (e.strength ?? 0) >= 0.9)).toBe(true);
    assertSafeLanguage(all.body);
  });
});

describe('POST /intelligence/simulate — counterfactual twin', () => {
  it('runs a hypothetical scenario through the existing model', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/intelligence/simulate`)
      .set(auth(sess.accessToken))
      .send({ label: 'Lighter + active?', changes: { weightKg: 78, activityMinutesPerWeek: 165 } });
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.kind).toBe('counterfactual_twin');
    expect(b.baseline.weightKg).toBe(86);
    expect(b.scenario.weightKg).toBe(78);
    expect(b.modelAfter.result.probability).toBeLessThan(b.modelBefore.result.probability);
    expect(b.modelAfter.result.scenarioApplied).toBe(true);
    expect(b.contributionChanges[0].delta).not.toBe(0);
    expect(b.labels).toContain('Not a prediction');
    expect(b.labels).toContain('Not a treatment recommendation');
    expect(b.uncertainty.reasons.length).toBeGreaterThan(0);
    assertSafeLanguage(b);
  });

  it('rejects impossible scenarios (400) and empty changes (400)', async () => {
    const bad = await request(ctx.app)
      .post(`/api/members/${memberId}/intelligence/simulate`)
      .set(auth(sess.accessToken))
      .send({ changes: { weightKg: 999, hba1c: 99 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const empty = await request(ctx.app)
      .post(`/api/members/${memberId}/intelligence/simulate`)
      .set(auth(sess.accessToken))
      .send({ changes: {} });
    expect(empty.status).toBe(400);
  });

  it('simulation never mutates real data', async () => {
    await request(ctx.app)
      .post(`/api/members/${memberId}/intelligence/simulate`)
      .set(auth(sess.accessToken))
      .send({ changes: { weightKg: 60 } });
    const intel = await request(ctx.app).get(`/api/members/${memberId}/intelligence`).set(auth(sess.accessToken));
    const weight = intel.body.baselines.baselines.find((x) => x.signal === 'obs:weight_kg');
    expect(weight.latest.value).toBe(86);
    const risk = await request(ctx.app)
      .post(`/api/members/${memberId}/risk/diabetes`)
      .set(auth(sess.accessToken))
      .send({});
    expect(risk.body.result.scenarioApplied).toBe(false);
  });
});

describe('POST /intelligence/scenarios — model scenario explorer', () => {
  it('returns mathematically ranked scenarios, never advice', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/intelligence/scenarios`)
      .set(auth(sess.accessToken))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.scenarios.length).toBeGreaterThanOrEqual(4);
    const deltas = res.body.scenarios.map((s) => s.deltaProbability);
    expect(deltas).toEqual([...deltas].sort((a, b) => a - b));
    expect(res.body.rankingNote).toMatch(/ONLY by mathematical effect/i);
    assertSafeLanguage(res.body);
  });
});

describe('GET /intelligence/explanation — grounded narration', () => {
  it('narrates ONLY from the evidence package (every number is traceable)', async () => {
    const res = await request(ctx.app)
      .get(`/api/members/${memberId}/intelligence/explanation`)
      .set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    const { explanation, evidence } = res.body;
    expect(explanation.provider).toBe('grounded-local');
    expect(explanation.text).toContain(MEMBER_NAME);
    expect(explanation.text).toMatch(/not a diagnosis/i);
    expect(explanation.text).toMatch(/not proof that one caused the other/i);
    // LLM grounding: every multi-digit/decimal number in the text must occur in the evidence JSON.
    const dump = JSON.stringify(evidence);
    const tokens = explanation.text.match(/\d{3,}|\d+\.\d+/g) || [];
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect(dump.includes(t)).toBe(true);
    }
    assertSafeLanguage(res.body);
  });
});

describe('intelligence authorization (existing policy reused)', () => {
  it('strangers get 404, unauthenticated get 401', async () => {
    const stranger = await registerUser(request, ctx.app, { email: 'stranger@mt.test' });
    for (const [method, path, body] of [
      ['get', `/api/members/${memberId}/intelligence`],
      ['get', `/api/members/${memberId}/intelligence/baseline`],
      ['get', `/api/members/${memberId}/intelligence/patterns`],
      ['post', `/api/members/${memberId}/intelligence/simulate`, { changes: { weightKg: 80 } }],
      ['post', `/api/members/${memberId}/intelligence/scenarios`, {}],
      ['get', `/api/members/${memberId}/intelligence/explanation`],
    ]) {
      const denied = await request(ctx.app)[method](path).set(auth(stranger.accessToken)).send(body || {});
      expect(denied.status).toBe(404);
      const anon = await request(ctx.app)[method](path).send(body || {});
      expect(anon.status).toBe(401);
    }
  });

  it('viewers and editors may use intelligence; admins get no health access', async () => {
    const viewer = await registerUser(request, ctx.app, { email: 'viewer@mt.test' });
    const editor = await registerUser(request, ctx.app, { email: 'editor@mt.test' });
    await request(ctx.app)
      .post(`/api/members/${memberId}/shares`)
      .set(auth(sess.accessToken))
      .send({ granteeEmail: 'viewer@mt.test', permission: 'viewer' });
    await request(ctx.app)
      .post(`/api/members/${memberId}/shares`)
      .set(auth(sess.accessToken))
      .send({ granteeEmail: 'editor@mt.test', permission: 'editor' });

    const v = await request(ctx.app).get(`/api/members/${memberId}/intelligence`).set(auth(viewer.accessToken));
    expect(v.status).toBe(200);
    const e = await request(ctx.app)
      .post(`/api/members/${memberId}/intelligence/simulate`)
      .set(auth(editor.accessToken))
      .send({ changes: { weightKg: 80 } });
    expect(e.status).toBe(200);

    const admin = await makeAdmin(ctx.container, request, ctx.app);
    const a = await request(ctx.app).get(`/api/members/${memberId}/intelligence`).set(auth(admin.accessToken));
    expect(a.status).toBe(404);
  });
});
