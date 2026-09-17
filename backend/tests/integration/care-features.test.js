import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  makeTestContext,
  registerUser,
  auth,
  SAMPLE_REPORT_TEXT,
  ingestAndVerify,
} from '../helpers.js';

let ctx, sess, memberId, strangerSess, strangerMemberId;
beforeAll(async () => {
  ctx = makeTestContext();
  sess = await registerUser(request, ctx.app, { email: 'care@mt.test', displayName: 'Care' });
  const members = await request(ctx.app).get('/api/members').set(auth(sess.accessToken));
  memberId = members.body.owned.find((m) => m.relationship === 'self').id;

  await request(ctx.app)
    .patch(`/api/members/${memberId}`)
    .set(auth(sess.accessToken))
    .send({ dob: '1981-05-04', heightCm: 172, familyHistory: { diabetes: true, hypertension: 'father' } });

  await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, SAMPLE_REPORT_TEXT, '2026-03-12');

  await request(ctx.app).post(`/api/members/${memberId}/observations`).set(auth(sess.accessToken))
    .send({ kind: 'weight', payload: { weightKg: 96 } });
  await request(ctx.app).post(`/api/members/${memberId}/observations`).set(auth(sess.accessToken))
    .send({ kind: 'activity', payload: { minutesPerWeek: 20 } });
  await request(ctx.app).post(`/api/members/${memberId}/observations`).set(auth(sess.accessToken))
    .send({ kind: 'sleep', payload: { hours: 5 } });
  await request(ctx.app).post(`/api/members/${memberId}/observations`).set(auth(sess.accessToken))
    .send({ kind: 'medication', payload: { name: 'Atorvastatin', dose: '10mg' } });

  strangerSess = await registerUser(request, ctx.app, { email: 'care-stranger@mt.test', displayName: 'Stranger' });
  const sm = await request(ctx.app).get('/api/members').set(auth(strangerSess.accessToken));
  strangerMemberId = sm.body.owned.find((m) => m.relationship === 'self').id;
});
afterAll(() => ctx.container.close());

describe('diet & lifestyle guidance (§10.3)', () => {
  it('grounds every item in recorded values (why + inputs + disclaimer)', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/guidance`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.generalInformationOnly).toBe(true);
    expect(res.body.disclaimer).toMatch(/not medical advice/i);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) {
      expect(item.why).toBeTruthy();
      expect(item.generalInformationOnly).toBe(true);
    }
    // low activity + short sleep + high BMI + high glucose/lipids should all fire
    const keys = res.body.items.map((i) => i.key);
    expect(keys).toContain('movement-low');
    expect(keys).toContain('sleep-short');
    expect(keys).toContain('weight-context');
    expect(keys).toContain('glucose-context');
    expect(keys).toContain('lipid-context');
    // grounded narration ships alongside
    expect(res.body.narrative.text).toMatch(/general-information notes|General lifestyle information/);
    expect(res.body.context.bmi).toBeCloseTo(32.4, 0);
  });

  it('never prescribes: no directives, no extreme diets, no treatment claims', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/guidance`).set(auth(sess.accessToken));
    const blob = JSON.stringify(res.body).toLowerCase();
    expect(blob).not.toMatch(/you must|you should take|prescrib|keto|fasting diet|crash diet|will cure|will prevent/);
  });

  it('empty state for members with no data', async () => {
    const res = await request(ctx.app).get(`/api/members/${strangerMemberId}/guidance`).set(auth(strangerSess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.key)).toContain('no-data-yet');
  });

  it('strangers cannot read guidance', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/guidance`).set(auth(strangerSess.accessToken));
    expect(res.status).toBe(404);
  });
});

describe('medication & lab awareness (§10.4)', () => {
  it('places medications next to out-of-range labs as discussion topics', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/medication-awareness`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.notAnInteractionCheck).toBe(true);
    expect(res.body.disclaimer).toMatch(/NOT a drug-interaction check/);
    expect(res.body.medications.map((m) => m.name)).toContain('Atorvastatin');
    const topics = res.body.topics.filter((t) => t.kind === 'medication-lab-topic');
    expect(topics.length).toBeGreaterThan(0);
    // every topic uses the safe framing
    for (const t of topics) {
      expect(t.body).toMatch(/may warrant discussion with a healthcare professional/);
    }
  });

  it('never issues directives', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/medication-awareness`).set(auth(sess.accessToken));
    const blob = JSON.stringify(res.body).toLowerCase();
    expect(blob).not.toMatch(/stop taking|start taking|change your dose|increase your dose|safe to take/);
  });

  it('empty state when no medications are recorded', async () => {
    const res = await request(ctx.app).get(`/api/members/${strangerMemberId}/medication-awareness`).set(auth(strangerSess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.topics.map((t) => t.kind)).toContain('no-medications');
  });

  it('strangers cannot read medication awareness', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/medication-awareness`).set(auth(strangerSess.accessToken));
    expect(res.status).toBe(404);
  });
});

describe('family-history risk context (§10.1)', () => {
  it('shows stored history, explains model use, and disclaims genetics', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/family-history`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.stored.diabetes).toBe(true);
    expect(res.body.isGeneticTesting).toBe(false);
    expect(res.body.disclaimer).toMatch(/not genetic testing/i);
    expect(res.body.howItIsUsed.join(' ')).toMatch(/prototype diabetes risk estimate/);
  });

  it('strangers cannot read family history', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/family-history`).set(auth(strangerSess.accessToken));
    expect(res.status).toBe(404);
  });
});
