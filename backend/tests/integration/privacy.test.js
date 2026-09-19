import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  makeTestContext,
  registerUser,
  auth,
  SAMPLE_REPORT_TEXT,
  ingestAndVerify,
  STRONG_PASSWORD,
} from '../helpers.js';

let ctx, sess, memberId;
beforeAll(async () => {
  ctx = makeTestContext();
  sess = await registerUser(request, ctx.app, { email: 'priv@mt.test', displayName: 'Priv' });
  const members = await request(ctx.app).get('/api/members').set(auth(sess.accessToken));
  memberId = members.body.owned.find((m) => m.relationship === 'self').id;
  await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, SAMPLE_REPORT_TEXT, '2026-03-12');
  await request(ctx.app).post(`/api/members/${memberId}/observations`).set(auth(sess.accessToken))
    .send({ kind: 'weight', payload: { weightKg: 70 } });
  await request(ctx.app).post(`/api/members/${memberId}/reminders`).set(auth(sess.accessToken))
    .send({ kind: 'checkup', title: 'Annual', dueAt: new Date(Date.now() + 86400000).toISOString() });
});
afterAll(() => ctx.container.close());

describe('user data rights (§14)', () => {
  it('profile carries the consent record', async () => {
    const res = await request(ctx.app).get('/api/profile').set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.user.consentedAt).toBeTruthy();
    expect(res.body.user.consentVersion).toBe('1.0');
    expect(res.body.user).not.toHaveProperty('password_hash');
  });

  it('export contains everything owned — and no secrets', async () => {
    const res = await request(ctx.app).get('/api/profile/export').set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.format).toBe('kivo-export/1');
    expect(res.body.user.email).toBe('priv@mt.test');
    expect(res.body.members.length).toBeGreaterThanOrEqual(1);
    expect(res.body.reports.length).toBeGreaterThanOrEqual(1);
    expect(res.body.labResults.length).toBeGreaterThan(0);
    expect(res.body.observations.length).toBeGreaterThanOrEqual(1);
    expect(res.body.reminders.length).toBeGreaterThanOrEqual(1);
    expect(res.body.counts.labResults).toBe(res.body.labResults.length);
    const blob = JSON.stringify(res.body);
    expect(blob).not.toMatch(/password_hash/);
    expect(blob).not.toMatch(/token_hash/);
    expect(blob).not.toMatch(/refreshToken/);
  });

  it('export requires authentication', async () => {
    const res = await request(ctx.app).get('/api/profile/export');
    expect(res.status).toBe(401);
  });

  it('account deletion rejects a wrong password', async () => {
    const res = await request(ctx.app)
      .delete('/api/profile')
      .set(auth(sess.accessToken))
      .send({ password: 'Wrong!Password#000' });
    expect(res.status).toBe(401);
    // still alive
    const me = await request(ctx.app).get('/api/profile').set(auth(sess.accessToken));
    expect(me.status).toBe(200);
  });

  it('account deletion wipes the account and all its health data', async () => {
    // a second account whose data must survive
    const other = await registerUser(request, ctx.app, { email: 'priv-other@mt.test', displayName: 'Other' });

    const res = await request(ctx.app)
      .delete('/api/profile')
      .set(auth(sess.accessToken))
      .send({ password: STRONG_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    // login no longer works
    const login = await request(ctx.app).post('/api/auth/login').send({ email: 'priv@mt.test', password: STRONG_PASSWORD });
    expect(login.status).toBe(401);
    // old access token is dead
    const me = await request(ctx.app).get('/api/profile').set(auth(sess.accessToken));
    expect(me.status).toBe(401);
    // health data is gone at the repository level
    expect(ctx.container.memberRepository.listOwned(sess.user.id)).toEqual([]);
    // the other account is untouched
    const otherMe = await request(ctx.app).get('/api/profile').set(auth(other.accessToken));
    expect(otherMe.status).toBe(200);
  });
});
