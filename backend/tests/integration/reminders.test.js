import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext, registerUser, auth, STRONG_PASSWORD } from '../helpers.js';

let ctx, sess, memberId, otherSess, otherMemberId;
beforeAll(async () => {
  ctx = makeTestContext();
  sess = await registerUser(request, ctx.app, { email: 'rem@mt.test', displayName: 'Rem' });
  const members = await request(ctx.app).get('/api/members').set(auth(sess.accessToken));
  memberId = members.body.owned.find((m) => m.relationship === 'self').id;

  otherSess = await registerUser(request, ctx.app, { email: 'rem2@mt.test', displayName: 'Rem2' });
  const members2 = await request(ctx.app).get('/api/members').set(auth(otherSess.accessToken));
  otherMemberId = members2.body.owned.find((m) => m.relationship === 'self').id;
});
afterAll(() => ctx.container.close());

const FUTURE = new Date(Date.now() + 86400000).toISOString();
const PAST = new Date(Date.now() - 3600000).toISOString();

describe('reminders (§10.6)', () => {
  let reminderId;

  it('creates a medication reminder', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/reminders`)
      .set(auth(sess.accessToken))
      .send({ kind: 'medication', title: 'Take vitamin D', dueAt: FUTURE, repeatIntervalDays: 1 });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('medication');
    expect(res.body.status).toBe('pending');
    expect(res.body.repeatIntervalDays).toBe(1);
    reminderId = res.body.id;
  });

  it('rejects unknown kinds and bad dates', async () => {
    const bad1 = await request(ctx.app)
      .post(`/api/members/${memberId}/reminders`)
      .set(auth(sess.accessToken))
      .send({ kind: 'surgery', title: 'x', dueAt: FUTURE });
    expect(bad1.status).toBe(400);
    const bad2 = await request(ctx.app)
      .post(`/api/members/${memberId}/reminders`)
      .set(auth(sess.accessToken))
      .send({ kind: 'checkup', title: 'x', dueAt: 'not-a-date' });
    expect(bad2.status).toBe(400);
  });

  it('lists reminders for the member', async () => {
    const res = await request(ctx.app)
      .get(`/api/members/${memberId}/reminders`)
      .set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0]).toHaveProperty('isDue');
  });

  it('reports due reminders (powers in-app notifications)', async () => {
    await request(ctx.app)
      .post(`/api/members/${memberId}/reminders`)
      .set(auth(sess.accessToken))
      .send({ kind: 'followup', title: 'Call clinic', dueAt: PAST });
    const res = await request(ctx.app)
      .get(`/api/members/${memberId}/reminders/due`)
      .set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(res.body.items.every((r) => r.isDue)).toBe(true);
    expect(res.body).toHaveProperty('checkedAt');
  });

  it('snoozing hides a due reminder until later', async () => {
    const created = await request(ctx.app)
      .post(`/api/members/${memberId}/reminders`)
      .set(auth(sess.accessToken))
      .send({ kind: 'checkup', title: 'Annual physical', dueAt: PAST });
    const snooze = new Date(Date.now() + 7200000).toISOString();
    const upd = await request(ctx.app)
      .patch(`/api/reminders/${created.body.id}`)
      .set(auth(sess.accessToken))
      .send({ snoozeUntil: snooze });
    expect(upd.status).toBe(200);
    expect(upd.body.isDue).toBe(false);
    const due = await request(ctx.app)
      .get(`/api/members/${memberId}/reminders/due`)
      .set(auth(sess.accessToken));
    expect(due.body.items.map((r) => r.id)).not.toContain(created.body.id);
  });

  it('completing a repeating reminder rolls it forward (no row spawn)', async () => {
    const before = await request(ctx.app)
      .get(`/api/members/${memberId}/reminders`)
      .set(auth(sess.accessToken));
    const done = await request(ctx.app)
      .patch(`/api/reminders/${reminderId}`)
      .set(auth(sess.accessToken))
      .send({ status: 'done' });
    expect(done.status).toBe(200);
    // repeating → stays pending with the next due date
    expect(done.body.status).toBe('pending');
    expect(new Date(done.body.dueAt).getTime()).toBeGreaterThan(new Date(FUTURE).getTime());
    const after = await request(ctx.app)
      .get(`/api/members/${memberId}/reminders`)
      .set(auth(sess.accessToken));
    expect(after.body.total).toBe(before.body.total);
  });

  it('deletes a reminder', async () => {
    const created = await request(ctx.app)
      .post(`/api/members/${memberId}/reminders`)
      .set(auth(sess.accessToken))
      .send({ kind: 'custom', title: 'temp', dueAt: FUTURE });
    const del = await request(ctx.app)
      .delete(`/api/reminders/${created.body.id}`)
      .set(auth(sess.accessToken));
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
  });

  it('enforces member isolation (stranger gets 404, no existence leak)', async () => {
    const res = await request(ctx.app)
      .get(`/api/members/${memberId}/reminders`)
      .set(auth(otherSess.accessToken));
    expect(res.status).toBe(404);
    const res2 = await request(ctx.app)
      .post(`/api/members/${memberId}/reminders`)
      .set(auth(otherSess.accessToken))
      .send({ kind: 'custom', title: 'x', dueAt: FUTURE });
    expect(res2.status).toBe(404);
    // sanity: other user's own list works
    const own = await request(ctx.app)
      .get(`/api/members/${otherMemberId}/reminders`)
      .set(auth(otherSess.accessToken));
    expect(own.status).toBe(200);
    expect(STRONG_PASSWORD.length).toBeGreaterThan(0);
  });
});
