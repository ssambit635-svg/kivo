import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext, registerUser, makeAdmin, auth, ingestAndVerify, STRONG_PASSWORD } from '../helpers.js';

/**
 * Ask the Twin — grounded conversational Q&A (demo narrative §17 step 7).
 *
 * Covers: authN/authZ surface (same as trends: viewer/editor may read,
 * strangers 404, admins 404), validation, intent routing, grounding (every
 * number in an answer comes from verified data), and medical-safety language
 * (never a diagnosis, refusal on diagnosis-seeking questions).
 */

const R1 = [
  'CITY LAB', 'Report Date: 01-06-2025',
  'HbA1c 5.4 % (4.0 - 5.6)',
  'Fasting Blood Sugar 95 mg/dL 70 - 100',
  'Triglycerides 140 mg/dL (30 - 150)',
  'HDL Cholesterol 45 mg/dL (40 - 60)',
  'LDL Cholesterol 110 mg/dL (50 - 100)',
].join('\n');

const R2 = [
  'CITY LAB', 'Report Date: 01-06-2026',
  'HbA1c 6.2 % (4.0 - 5.6)',
  'Fasting Blood Sugar 118 mg/dL 70 - 100',
  'Triglycerides 195 mg/dL (30 - 150)',
  'HDL Cholesterol 40 mg/dL (40 - 60)',
  'LDL Cholesterol 140 mg/dL (50 - 100)',
].join('\n');

let ctx;
let sess; // owner session
let viewerSess;
let adminSess;
let memberId;

async function ask(token, question) {
  return request(ctx.app)
    .post(`/api/members/${memberId}/ask`)
    .set(auth(token))
    .send({ question });
}

beforeAll(async () => {
  ctx = makeTestContext();
  sess = await registerUser(request, ctx.app, { email: 'asker@mt.test', displayName: 'Asker' });
  const members = await request(ctx.app).get('/api/members').set(auth(sess.accessToken));
  memberId = members.body.owned.find((m) => m.relationship === 'self').id;

  await request(ctx.app).patch(`/api/members/${memberId}`).set(auth(sess.accessToken)).send({
    dob: '1981-05-04', sex: 'male', heightCm: 170, familyHistory: { diabetes: false },
  });

  await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, R1, '2025-06-01');
  await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, R2, '2026-06-01');

  await request(ctx.app).post(`/api/members/${memberId}/observations`).set(auth(sess.accessToken))
    .send({ kind: 'medication', payload: { name: 'Metformin', dose: '500mg' } });

  viewerSess = await registerUser(request, ctx.app, { email: 'viewer@mt.test', displayName: 'Viewer' });
  await request(ctx.app)
    .post(`/api/members/${memberId}/shares`)
    .set(auth(sess.accessToken))
    .send({ granteeEmail: 'viewer@mt.test', permission: 'viewer' });

  adminSess = await makeAdmin(ctx.container, request, ctx.app, { email: 'askadmin@mt.test', password: STRONG_PASSWORD });
});
afterAll(() => ctx.container.close());

const DIAGNOSTIC_CLAIM = /\b(you have|you suffer from|you are (?:diabetic|pre-?diabetic)|diagnosed with|you've got)\s+(diabetes|cancer|hypertension|a disease|an illness)/i;

describe('Ask the Twin — auth & validation', () => {
  it('requires authentication (401 without a token)', async () => {
    const res = await request(ctx.app).post(`/api/members/${memberId}/ask`).send({ question: 'hi' });
    expect(res.status).toBe(401);
  });

  it('hides the member from strangers (404, existence-hiding)', async () => {
    const stranger = await registerUser(request, ctx.app, { email: 'stranger@mt.test' });
    const res = await ask(stranger.accessToken, 'What changed in my health?');
    expect(res.status).toBe(404);
    const sug = await request(ctx.app).get(`/api/members/${memberId}/ask/suggestions`).set(auth(stranger.accessToken));
    expect(sug.status).toBe(404);
  });

  it('admins cannot ask about member health data (404 by policy)', async () => {
    const res = await ask(adminSess.accessToken, 'What changed in my health?');
    expect(res.status).toBe(404);
  });

  it('shared viewers may ask (read-level access)', async () => {
    const res = await ask(viewerSess.accessToken, 'How is my HbA1c trending?');
    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('marker');
  });

  it('rejects empty, missing, non-string and oversized questions (400)', async () => {
    for (const bad of ['', '   ', null, 42, {}, ['hi']]) {
      const res = await request(ctx.app)
        .post(`/api/members/${memberId}/ask`)
        .set(auth(sess.accessToken))
        .send({ question: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const tooLong = await ask(sess.accessToken, 'x'.repeat(401));
    expect(tooLong.status).toBe(400);
    const atLimit = await ask(sess.accessToken, `What changed? ${'y'.repeat(380)}`);
    expect(atLimit.status).toBe(200); // 400 chars exactly is allowed
  });

  it('rejects a malformed memberId (400, not 500)', async () => {
    const res = await request(ctx.app)
      .post('/api/members/not-a-uuid/ask')
      .set(auth(sess.accessToken))
      .send({ question: 'hi there' });
    expect(res.status).toBe(400);
  });
});

describe('Ask the Twin — grounding & intents', () => {
  it('answers "what changed" with real verified numbers from the trends engine', async () => {
    const res = await ask(sess.accessToken, 'What has changed in my health over the last year?');
    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('changes');
    expect(Array.isArray(res.body.evidence.trends)).toBe(true);
    expect(res.body.evidence.trends.length).toBeGreaterThan(0);
    // Every headline number appears in the grounded text, copied verbatim.
    expect(res.body.answer).toContain('HbA1c');
    expect(res.body.answer).toMatch(/5\.4/);
    expect(res.body.answer).toMatch(/6\.2/);
    expect(res.body.answer).not.toMatch(DIAGNOSTIC_CLAIM);
    expect(res.body.followUps.length).toBeGreaterThan(0);
    expect(res.body.grounding.valuesFrom).toBe('structured-validated-input');
    expect(res.body.grounding.deterministic).toBe(true);
  });

  it('answers a marker question with that marker only, latest value + direction', async () => {
    const res = await ask(sess.accessToken, 'How is my fasting glucose doing?');
    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('marker');
    expect(res.body.matchedMarkers.map((m) => m.code)).toContain('fasting_glucose');
    const marker = res.body.evidence.markers.find((m) => m.code === 'fasting_glucose');
    expect(marker.latestValue).toBe(118);
    expect(marker.direction).toBe('increasing');
    expect(res.body.answer).toMatch(/118/);
    expect(res.body.answer).not.toMatch(DIAGNOSTIC_CLAIM);
  });

  it('answers a risk question from the transparent model, with disclaimer', async () => {
    const res = await ask(sess.accessToken, 'What is my risk and what drives it?');
    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('risk');
    const result = res.body.evidence.risk?.result;
    expect(Number.isFinite(result.percent)).toBe(true);
    expect(typeof result.disclaimer).toBe('string');
    expect(res.body.answer).toContain(`${result.percent}%`);
    expect(res.body.answer).toMatch(/not a diagnosis|not clinically validated|model-based/i);
    expect(res.body.answer).not.toMatch(DIAGNOSTIC_CLAIM);
  });

  it('REFUSES diagnosis-seeking questions and never answers with a condition', async () => {
    const res = await ask(sess.accessToken, 'Do I have diabetes?');
    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('diagnosis_request');
    expect(res.body.answer).toMatch(/cannot diagnose/i);
    expect(res.body.answer).not.toMatch(DIAGNOSTIC_CLAIM);
    // The reframe points at recorded data instead.
    expect(res.body.evidence.trends.length).toBeGreaterThan(0);
  });

  it('handles medication questions without ever advising med changes', async () => {
    const res = await ask(sess.accessToken, 'What about my medications?');
    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('medications');
    expect(res.body.answer).toMatch(/never recommend starting, stopping, or changing/i);
  });

  it('answers doctor-visit questions from the verified-data summary', async () => {
    const res = await ask(sess.accessToken, 'What should I discuss with my doctor at the next visit?');
    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('doctor');
    expect(res.body.answer).not.toMatch(DIAGNOSTIC_CLAIM);
  });

  it('answers health-score questions from the score timeline', async () => {
    const res = await ask(sess.accessToken, 'What is my health score right now?');
    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('score');
    expect(res.body.evidence.healthScore?.current?.score).not.toBeNull();
  });

  it('answers milestones questions from the milestone evaluator', async () => {
    const res = await ask(sess.accessToken, 'What milestones have I earned?');
    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('milestones');
    expect(res.body.evidence.milestones.total).toBeGreaterThan(0);
  });

  it('answers records questions with counts, and unknown questions gracefully', async () => {
    const reports = await ask(sess.accessToken, 'How many reports do I have on file?');
    expect(reports.status).toBe(200);
    expect(reports.body.intent).toBe('reports');
    expect(reports.body.evidence.dataSummary.verifiedReportCount).toBe(2);

    const unknown = await ask(sess.accessToken, 'Tell me about the weather on Mars please');
    expect(unknown.status).toBe(200);
    expect(unknown.body.intent).toBe('unknown');
    expect(unknown.body.answer).toMatch(/could not map that question/i);
    expect(unknown.body.answer).not.toMatch(DIAGNOSTIC_CLAIM);
  });

  it('answers greeting and thanks without touching health data claims', async () => {
    const hi = await ask(sess.accessToken, 'Hello!');
    expect(hi.status).toBe(200);
    expect(hi.body.intent).toBe('greeting');
    const ty = await ask(sess.accessToken, 'Thanks');
    expect(ty.status).toBe(200);
    expect(ty.body.intent).toBe('thanks');
  });

  it('serves deterministic suggestions shaped by the data', async () => {
    const res = await request(ctx.app)
      .get(`/api/members/${memberId}/ask/suggestions`)
      .set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.suggestions)).toBe(true);
    expect(res.body.suggestions).toContain('What has changed in my health since my first report?');
    expect(res.body.suggestions).toContain('What is my current risk estimate and what drives it?');
  });

  it('answers identically for the same question (deterministic, grounded-local)', async () => {
    const a = await ask(sess.accessToken, 'How is my HbA1c trending?');
    const b = await ask(sess.accessToken, 'How is my HbA1c trending?');
    expect(a.body.answer).toBe(b.body.answer);
    expect(a.body.evidence.markers).toEqual(b.body.evidence.markers);
  });
});

describe('Ask the Twin — privacy & audit', () => {
  it('audits the question event WITHOUT storing the question text', async () => {
    const secretPhrase = 'UNIQUE_SECRET_PHRASE_12345';
    await ask(sess.accessToken, `Do I have ${secretPhrase}?`);
    const { items } = ctx.container.auditLogRepository.list({ action: 'ask.question' });
    expect(items.length).toBeGreaterThan(0);
    const row = items[items.length - 1];
    const json = row.toJSON();
    expect(json.metadata.intent).toBeTruthy();
    expect(Array.isArray(json.metadata.matchedCodes)).toBe(true);
    expect(typeof json.metadata.questionLength).toBe('number');
    // The audit trail never stores the free-form question text.
    expect(JSON.stringify(json)).not.toContain(secretPhrase);
  });

  it('never lets unverified draft data leak into answers', async () => {
    // Ingest a draft (NOT verified) with a distinctive value.
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .send({ text: ['SECRET LAB', 'Report Date: 01-08-2026', 'HbA1c 9.9 % (4.0 - 5.6)'].join('\n') });
    expect(res.status).toBe(201);
    const ans = await ask(sess.accessToken, 'How is my HbA1c trending?');
    expect(ans.body.answer).not.toContain('9.9'); // draft value never grounded
    expect(ans.body.evidence.markers.find((m) => m.code === 'hba1c').latestValue).toBe(6.2);
  });

  it('answers gracefully for a member with no data at all', async () => {
    const fresh = await registerUser(request, ctx.app, { email: 'empty@mt.test' });
    const list = await request(ctx.app).get('/api/members').set(auth(fresh.accessToken));
    const freshId = list.body.owned.find((m) => m.relationship === 'self').id;
    const res = await request(ctx.app)
      .post(`/api/members/${freshId}/ask`)
      .set(auth(fresh.accessToken))
      .send({ question: 'What has changed in my health over time?' });
    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('changes');
    expect(res.body.answer).toMatch(/no verified|upload and verify/i);
  });
});
