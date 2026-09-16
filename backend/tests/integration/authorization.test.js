import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext, registerUser, login, auth, makeAdmin, STRONG_PASSWORD } from '../helpers.js';

let ctx, ownerSess, viewerSess, editorSess, strangerSess, adminSess, memberId;
beforeAll(async () => {
  ctx = makeTestContext();
  ownerSess = await registerUser(request, ctx.app, { email: 'owner@mt.test', displayName: 'Owner' });
  viewerSess = await registerUser(request, ctx.app, { email: 'viewer@mt.test', displayName: 'Viewer' });
  editorSess = await registerUser(request, ctx.app, { email: 'editor@mt.test', displayName: 'Editor' });
  strangerSess = await registerUser(request, ctx.app, { email: 'stranger@mt.test', displayName: 'Stranger' });
  adminSess = await makeAdmin(ctx.container, request, ctx.app, { email: 'root@mt.test' });

  const membersRes = await request(ctx.app).get('/api/members').set(auth(ownerSess.accessToken));
  memberId = membersRes.body.owned.find((m) => m.relationship === 'self').id;

  // share: viewer (read-only), editor (read+write)
  await request(ctx.app)
    .post(`/api/members/${memberId}/shares`)
    .set(auth(ownerSess.accessToken))
    .send({ granteeEmail: 'viewer@mt.test', permission: 'viewer' });
  await request(ctx.app)
    .post(`/api/members/${memberId}/shares`)
    .set(auth(ownerSess.accessToken))
    .send({ granteeEmail: 'editor@mt.test', permission: 'editor' });
});
afterAll(() => ctx.container.close());

const report = (token) =>
  request(ctx.app)
    .post(`/api/members/${memberId}/reports`)
    .set(auth(token))
    .send({ text: 'HbA1c 5.9 % (4.0 - 5.6)' });

describe('family member isolation (privacy between accounts)', () => {
  it('a stranger cannot READ another account\'s member (404 — existence hidden)', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}`).set(auth(strangerSess.accessToken));
    expect(res.status).toBe(404);
  });

  it('a stranger cannot WRITE another account\'s member', async () => {
    const res = await request(ctx.app)
      .patch(`/api/members/${memberId}`)
      .set(auth(strangerSess.accessToken))
      .send({ name: 'Hacked' });
    expect(res.status).toBe(404);
  });

  it('a stranger cannot post reports into another account\'s member', async () => {
    const res = await report(strangerSess.accessToken);
    expect(res.status).toBe(404);
  });

  it('"shared" list shows only members actually shared with the account', async () => {
    const res = await request(ctx.app).get('/api/members').set(auth(strangerSess.accessToken));
    expect(res.body.shared).toHaveLength(0);
    expect(res.body.owned.length).toBeGreaterThanOrEqual(1); // own self member
  });

  it('random/uuid-shaped ids never 500 — always a clean 404', async () => {
    const res = await request(ctx.app)
      .get('/api/members/11111111-1111-1111-1111-111111111111')
      .set(auth(strangerSess.accessToken));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('share permissions (viewer vs editor)', () => {
  it('viewer can READ the shared member', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}`).set(auth(viewerSess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.access).toBe('viewer');
  });

  it('viewer posting a report is refused 403 INSUFFICIENT_PERMISSION', async () => {
    const res = await report(viewerSess.accessToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSION');
  });

  it('editor CAN post a report', async () => {
    const res = await report(editorSess.accessToken);
    expect(res.status).toBe(201);
  });

  it('editor still CANNOT manage shares (owner-only action)', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/shares`)
      .set(auth(editorSess.accessToken))
      .send({ granteeEmail: 'stranger@mt.test', permission: 'viewer' });
    expect(res.status).toBe(404);
  });

  it('share grants upgrade/downgrade idempotently', async () => {
    const upgrade = await request(ctx.app)
      .post(`/api/members/${memberId}/shares`)
      .set(auth(ownerSess.accessToken))
      .send({ granteeEmail: 'viewer@mt.test', permission: 'editor' });
    expect(upgrade.status).toBe(201);
    const res = await request(ctx.app).get(`/api/members/${memberId}`).set(auth(viewerSess.accessToken));
    expect(res.body.access).toBe('editor');
    // restore viewer for other tests
    await request(ctx.app)
      .post(`/api/members/${memberId}/shares`)
      .set(auth(ownerSess.accessToken))
      .send({ granteeEmail: 'viewer@mt.test', permission: 'viewer' });
  });

  it('revoking a share immediately removes access', async () => {
    const target = await registerUser(request, ctx.app, { email: 'temp@mt.test', displayName: 'Temp' });
    await request(ctx.app)
      .post(`/api/members/${memberId}/shares`)
      .set(auth(ownerSess.accessToken))
      .send({ granteeEmail: 'temp@mt.test', permission: 'viewer' });
    expect((await request(ctx.app).get(`/api/members/${memberId}`).set(auth(target.accessToken))).status).toBe(200);
    const tempId = target.user.id;
    await request(ctx.app)
      .delete(`/api/members/${memberId}/shares/${tempId}`)
      .set(auth(ownerSess.accessToken));
    expect((await request(ctx.app).get(`/api/members/${memberId}`).set(auth(target.accessToken))).status).toBe(404);
  });

  it('owner sees the share list with emails + permission levels', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/shares`).set(auth(ownerSess.accessToken));
    expect(res.status).toBe(200);
    const emails = res.body.items.map((s) => s.email);
    expect(emails).toContain('viewer@mt.test');
    expect(emails).toContain('editor@mt.test');
  });

  it('owner cannot share with themselves or nonexistent accounts', async () => {
    const self = await request(ctx.app)
      .post(`/api/members/${memberId}/shares`)
      .set(auth(ownerSess.accessToken))
      .send({ granteeEmail: 'owner@mt.test', permission: 'viewer' });
    expect(self.status).toBe(400);
    const ghost = await request(ctx.app)
      .post(`/api/members/${memberId}/shares`)
      .set(auth(ownerSess.accessToken))
      .send({ granteeEmail: 'ghost@mt.test', permission: 'viewer' });
    expect(ghost.status).toBe(404);
  });
});

describe('admin role (least-privilege RBAC)', () => {
  it('non-admin users get ADMIN_REQUIRED on admin routes', async () => {
    const res = await request(ctx.app).get('/api/admin/users').set(auth(ownerSess.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('admin can list users (paginated, no password hashes ever)', async () => {
    const res = await request(ctx.app).get('/api/admin/users?page=1&pageSize=100').set(auth(adminSess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(5);
    for (const u of res.body.items) {
      expect(u).not.toHaveProperty('password_hash');
      expect(u).not.toHaveProperty('failed_login_attempts');
    }
  });

  it('admin CANNOT read members\' health data (isolation beats role)', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}`).set(auth(adminSess.accessToken));
    expect(res.status).toBe(404);
  });

  it('admin can disable an account; its sessions die immediately', async () => {
    const victim = await registerUser(request, ctx.app, { email: 'victim@mt.test', displayName: 'Victim' });
    const disable = await request(ctx.app)
      .post(`/api/admin/users/${victim.user.id}/status`)
      .set(auth(adminSess.accessToken))
      .send({ status: 'disabled' });
    expect(disable.status).toBe(200);
    expect(disable.body.status).toBe('disabled');

    const me = await request(ctx.app).get('/api/auth/me').set(auth(victim.accessToken));
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('ACCOUNT_DISABLED');
    expect((await login(request, ctx.app, 'victim@mt.test', STRONG_PASSWORD)).status).toBe(403);
    const r = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: victim.refreshToken });
    expect(r.status).toBe(403);
  });

  it('admin can re-enable an account', async () => {
    const victim = ctx.container.userRepository.findByEmail('victim@mt.test');
    await request(ctx.app)
      .post(`/api/admin/users/${victim.id}/status`)
      .set(auth(adminSess.accessToken))
      .send({ status: 'active' });
    expect((await login(request, ctx.app, 'victim@mt.test', STRONG_PASSWORD)).status).toBe(200);
  });

  it('admin cannot disable their own account', async () => {
    const me = await request(ctx.app).get('/api/auth/me').set(auth(adminSess.accessToken));
    const res = await request(ctx.app)
      .post(`/api/admin/users/${me.body.user.id}/status`)
      .set(auth(adminSess.accessToken))
      .send({ status: 'disabled' });
    expect(res.status).toBe(400);
  });

  it('admin can read the audit trail — end users cannot', async () => {
    const ok = await request(ctx.app).get('/api/admin/audit?pageSize=1').set(auth(adminSess.accessToken));
    expect(ok.status).toBe(200);
    expect(ok.body.items[0]).toHaveProperty('action');
    const denied = await request(ctx.app).get('/api/admin/audit').set(auth(ownerSess.accessToken));
    expect(denied.status).toBe(403);
  });
});

describe('member lifecycle rules', () => {
  it('the self member cannot be deleted', async () => {
    const res = await request(ctx.app).delete(`/api/members/${memberId}`).set(auth(ownerSess.accessToken));
    expect(res.status).toBe(400);
  });

  it('a stranger cannot delete anything; owner deletes a non-self member', async () => {
    const created = await request(ctx.app)
      .post('/api/members')
      .set(auth(ownerSess.accessToken))
      .send({ name: 'Father', relationship: 'parent', dob: '1960-01-01', sex: 'male' });
    expect(created.status).toBe(201);
    const fid = created.body.id;

    const byStranger = await request(ctx.app).delete(`/api/members/${fid}`).set(auth(strangerSess.accessToken));
    expect(byStranger.status).toBe(404);

    const byEditor = await request(ctx.app).delete(`/api/members/${fid}`).set(auth(editorSess.accessToken));
    expect(byEditor.status).toBe(404); // not shared with editor

    const byOwner = await request(ctx.app).delete(`/api/members/${fid}`).set(auth(ownerSess.accessToken));
    expect(byOwner.status).toBe(200);
    expect((await request(ctx.app).get(`/api/members/${fid}`).set(auth(ownerSess.accessToken))).status).toBe(404);
  });

  it('member profile PATCH enforces access + updates family history JSON', async () => {
    const res = await request(ctx.app)
      .patch(`/api/members/${memberId}`)
      .set(auth(ownerSess.accessToken))
      .send({ dob: '1984-02-20', sex: 'female', heightCm: 165, familyHistory: { diabetes: true } });
    expect(res.status).toBe(200);
    expect(res.body.familyHistory.diabetes).toBe(true);
    expect(res.body.age).toBe(42); // 2026-02-20 already passed by 2026-09-16
  });
});
