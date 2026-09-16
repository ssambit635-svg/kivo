import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  makeTestContext,
  registerUser,
  auth,
  SAMPLE_REPORT_TEXT,
  SAMPLE_REPORT_TEXT_R2,
  ingestAndVerify,
} from '../helpers.js';

let ctx, sess, memberId;
beforeAll(async () => {
  ctx = makeTestContext();
  sess = await registerUser(request, ctx.app, { email: 'intel@mt.test', displayName: 'Intel' });
  const members = await request(ctx.app).get('/api/members').set(auth(sess.accessToken));
  memberId = members.body.owned.find((m) => m.relationship === 'self').id;

  // member profile for risk inputs
  await request(ctx.app)
    .patch(`/api/members/${memberId}`)
    .set(auth(sess.accessToken))
    .send({ dob: '1984-02-20', sex: 'female', heightCm: 165, familyHistory: { diabetes: true } });

  // 2025 report (earlier), 2026 report (later) — both verified
  await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, SAMPLE_REPORT_TEXT_R2, '2025-03-10');
  await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, SAMPLE_REPORT_TEXT, '2026-03-12');

  // lifestyle observations
  await request(ctx.app)
    .post(`/api/members/${memberId}/observations`)
    .set(auth(sess.accessToken))
    .send({ kind: 'weight', payload: { weightKg: 78 }, observedAt: '2026-03-12' });
  await request(ctx.app)
    .post(`/api/members/${memberId}/observations`)
    .set(auth(sess.accessToken))
    .send({ kind: 'bp', payload: { systolic: 128, diastolic: 84 }, observedAt: '2026-03-12' });
  await request(ctx.app)
    .post(`/api/members/${memberId}/observations`)
    .set(auth(sess.accessToken))
    .send({ kind: 'activity', payload: { minutesPerWeek: 40 }, observedAt: '2026-03-12' });
});
afterAll(() => ctx.container.close());

describe('trend analysis across reports (primary USP)', () => {
  it('per-marker trend: direction, deltas, statuses and latest range context', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/trends?code=hba1c`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    const t = res.body;
    expect(t.pointCount).toBe(2);
    expect(t.direction).toBe('increasing');
    expect(t.deltaAbs).toBeCloseTo(0.5, 5); // 5.9 - 5.4
    expect(t.deltaPct).toBeCloseTo(9.3, 1);
    expect(t.meaningfulChange).toBe(true); // crossed range: normal→high
    expect(t.latestStatus).toBe('high');
    expect(t.referenceRange.source).toBe('report');
    expect(t.statusTransitions[0].to).toBe('high');
    expect(t.interpretation).toBe('moving_away_from_typical_direction');
    expect(t.slopePerDay).toBeNull(); // needs >= 3 points
  });

  it('unverified values NEVER enter trends (safety gate)', async () => {
    // an unverified third report with an absurd value must not pollute the series
    await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .send({ text: 'HbA1c 99.9 % (4.0 - 5.6)' });
    const res = await request(ctx.app).get(`/api/members/${memberId}/trends?code=hba1c`).set(auth(sess.accessToken));
    expect(res.body.latestValue).toBe(5.9);
    expect(res.body.pointCount).toBe(2);
    // cleanup
    const list = await request(ctx.app)
      .get(`/api/members/${memberId}/reports?status=needs_review`)
      .set(auth(sess.accessToken));
    for (const r of list.body.items) {
      await request(ctx.app).delete(`/api/reports/${r.id}`).set(auth(sess.accessToken));
    }
  });

  it('member-wide trend summary + grounded narrative', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/trends`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    const codes = res.body.trends.map((t) => t.code);
    expect(codes).toContain('hba1c');
    expect(codes).toContain('fasting_glucose');
    expect(codes).toContain('total_cholesterol');
    expect(codes).toContain('triglycerides');
    expect(res.body.narrative.text).toMatch(/increased/i);
    expect(res.body.narrative.text).toMatch(/not a diagnosis/i);
  });

  it('unknown marker codes are a clean 404', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/trends?code=nonsense`).set(auth(sess.accessToken));
    expect(res.status).toBe(404);
  });
});

describe('diabetes risk-awareness (explainable prototype)', () => {
  it('assembles inputs from verified labs + profile + observations', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/risk/diabetes`)
      .set(auth(sess.accessToken))
      .send({});
    expect(res.status).toBe(200);
    const { result, inputs } = res.body;
    expect(inputs.fastingGlucose.value).toBe(108);
    expect(inputs.hba1c.value).toBe(5.9);
    expect(inputs.age.value).toBe(42);
    expect(inputs.bmi.value).toBeCloseTo((78 / 1.65 ** 2), 1);
    expect(inputs.systolicBp.value).toBe(128);
    expect(inputs.familyDiabetes.value).toBe(1);
    expect(inputs.activityLevel.value).toBe(0); // 40 min/wk = sedentary band
    expect(result.probability).toBeGreaterThan(0);
    expect(result.probability).toBeLessThan(1);
    expect(['low', 'moderate', 'elevated', 'high']).toContain(result.band);
    expect(result.completeness).toBeGreaterThan(0.6);
  });

  it('contributing factors are explainable: biggest driver first, with directions', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/risk/diabetes`)
      .set(auth(sess.accessToken))
      .send({});
    const factors = res.body.result.contributingFactors;
    expect(factors.length).toBeGreaterThan(3);
    const glu = factors.find((f) => f.feature === 'fastingGlucose');
    expect(glu.effectOnEstimate).toBe('raises');
    expect(glu.directionOfInputVsTypical).toBe('above_typical');
    expect(glu.value).toBe(108);
  });

  it('what-if scenario: improving glucose + BMI lowers the estimate and is labeled a scenario', async () => {
    const base = await request(ctx.app)
      .post(`/api/members/${memberId}/risk/diabetes`)
      .set(auth(sess.accessToken))
      .send({});
    const scenario = await request(ctx.app)
      .post(`/api/members/${memberId}/risk/diabetes`)
      .set(auth(sess.accessToken))
      .send({ overrides: { fastingGlucose: 88, bmi: 23.5, activityLevel: 2 } });
    expect(scenario.body.result.percent).toBeLessThan(base.body.result.percent);
    expect(scenario.body.result.scenarioApplied).toBe(true);
    expect(scenario.body.result.scenarioNote).toMatch(/not a promised outcome/i);
  });

  it('SAFETY: disclaimer is embedded in every response — no diagnosis language', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/risk/diabetes`)
      .set(auth(sess.accessToken))
      .send({});
    expect(res.body.result.disclaimer).toMatch(/NOT a medical diagnosis/i);
    expect(JSON.stringify(res.body)).not.toMatch(/you have diabetes/i);
  });

  it('unknown override keys are silently ignored (no injection into the model)', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/risk/diabetes`)
      .set(auth(sess.accessToken))
      .send({ overrides: { evilFeature: 1, weight: 9999 } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.inputs)).not.toContain('evilFeature');
  });

  it('risk for another user\'s member is forbidden (404)', async () => {
    const other = await registerUser(request, ctx.app, { email: 'nosy3@mt.test' });
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/risk/diabetes`)
      .set(auth(other.accessToken))
      .send({});
    expect(res.status).toBe(404);
  });
});

describe('observations journal', () => {
  it('lists observations with filters', async () => {
    const res = await request(ctx.app)
      .get(`/api/members/${memberId}/observations?kind=bp`)
      .set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].payload.systolic).toBe(128);
  });

  it('rejects implausible vitals at the service boundary', async () => {
    for (const [kind, payload] of [
      ['weight', { weightKg: -5 }],
      ['bp', { systolic: 999, diastolic: 9 }],
      ['sleep', { hours: 30 }],
      ['activity', { minutesPerWeek: -1 }],
    ]) {
      const res = await request(ctx.app)
        .post(`/api/members/${memberId}/observations`)
        .set(auth(sess.accessToken))
        .send({ kind, payload });
      expect(res.status).toBe(400);
    }
  });

  it('deletes own observation; strangers cannot', async () => {
    const add = await request(ctx.app)
      .post(`/api/members/${memberId}/observations`)
      .set(auth(sess.accessToken))
      .send({ kind: 'note', payload: { text: 'felt dizzy after lunch' } });
    const other = await registerUser(request, ctx.app, { email: 'nosy4@mt.test' });
    const denied = await request(ctx.app)
      .delete(`/api/observations/${add.body.id}`)
      .set(auth(other.accessToken));
    expect(denied.status).toBe(404);
    const ok = await request(ctx.app).delete(`/api/observations/${add.body.id}`).set(auth(sess.accessToken));
    expect(ok.status).toBe(200);
  });
});

describe('doctor-visit summary', () => {
  it('assembles sections, discussion points, grounded narrative + disclaimers', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/doctor-summary`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    const titles = res.body.sections.map((s) => s.title);
    expect(titles).toEqual([
      'Patient',
      'Recent reports',
      'Values currently outside reference range',
      'Notable changes across reports',
      'Medications (as entered by the user)',
      'Risk-awareness estimate (prototype, not a diagnosis)',
      'Suggested discussion points',
    ]);
    const abnormal = res.body.sections.find((s) => s.title === 'Values currently outside reference range');
    expect(abnormal.items.join(' ')).toMatch(/HbA1c/);
    expect(res.body.narrative.text).toContain('Intel');
    expect(res.body.disclaimers.join(' ')).toMatch(/not replace clinical assessment/i);
    const points = res.body.sections.find((s) => s.title === 'Suggested discussion points').items;
    expect(points.length).toBeGreaterThan(0);
    expect(points.join(' ')).toMatch(/discuss|review|ask/i);
  });
});
