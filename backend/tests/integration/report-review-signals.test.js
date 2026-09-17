import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext, registerUser, auth } from '../helpers.js';

/**
 * The knowledge layer's review signals must survive the trip from the extractor
 * into the API, otherwise a flagged (physically implausible) reading looks
 * exactly like a clean one in the review UI — which is the whole point of
 * flagging it.
 */
const REPORT = [
  'CITY DIAGNOSTICS CENTER - DEMO LAB',
  'Report Date: 12-03-2026',
  'HbA1c                        6.4 %       (4.0 - 5.6)',
  'Serum Creatinine           900 mg/dL     0.6 - 1.3',
  'Sodium                       139 mmol/L   135 - 145',
  'Platelet Count               245 10^3/µL  150 - 410',
];

describe('report review signals from the clinical knowledge layer', () => {
  let ctx, sess, memberId, reportId, preview;

  beforeAll(async () => {
    ctx = makeTestContext();
    sess = await registerUser(request, ctx.app, { email: 'signals@mt.test', displayName: 'S' });
    const members = await request(ctx.app).get('/api/members').set(auth(sess.accessToken));
    memberId = members.body.owned.find((m) => m.relationship === 'self').id;
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .send({ text: REPORT.join('\n') });
    expect(res.status).toBe(201);
    reportId = res.body.report.id;
    preview = res.body.preview;
  });
  afterAll(() => ctx.container.close());

  it('extracts every row and carries LOINC identity + panel on each draft', async () => {
    expect(preview.extracted).toHaveLength(4);
    for (const row of preview.extracted) {
      expect(row.loinc).toMatch(/^\d+-\d$/);
      expect(row.panel).toBeTruthy();
      expect(row.verified).toBe(false);
    }
  });

  it('flags the physically implausible reading and says why', async () => {
    const creatinine = preview.extracted.find((r) => r.code === 'creatinine');
    const sodium = preview.extracted.find((r) => r.code === 'sodium');
    expect(creatinine.suspicious).toBe(true);
    expect(creatinine.suspiciousReason).toMatch(/physically plausible/i);
    expect(creatinine.needsAttention).toBe(true);
    expect(sodium.suspicious).toBe(false);
    expect(sodium.needsAttention).toBe(false);
  });

  it('tells the user how many values need a second look', async () => {
    expect(preview.note).toMatch(/1 value\(s\) look physically implausible/);
  });

  it('exposes the signals on the stored report detail too', async () => {
    const res = await request(ctx.app).get(`/api/reports/${reportId}`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    const creatinine = res.body.results.find((r) => r.code === 'creatinine');
    expect(creatinine.suspicious).toBe(true);
    expect(creatinine.panel).toBe('kidney');
    expect(creatinine.heuristicConfidence).toBeGreaterThan(0);
    expect(creatinine.confidence).toBeLessThan(creatinine.heuristicConfidence + 0.5);
  });

  it('the flag stays advisory: the row is still an unverified draft', async () => {
    const res = await request(ctx.app).get(`/api/reports/${reportId}`).set(auth(sess.accessToken));
    const creatinine = res.body.results.find((r) => r.code === 'creatinine');
    expect(creatinine.verified).toBe(false);
    // and nothing flagged can enter trends by accident: verification is explicit
    expect(res.body.status).toBe('needs_review');
    expect(res.body.results.every((r) => r.verified === false)).toBe(true);
  });
});
