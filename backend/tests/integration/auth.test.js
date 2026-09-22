import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  makeTestContext,
  registerUser,
  login,
  auth,
  STRONG_PASSWORD,
} from '../helpers.js';

let ctx;
beforeAll(() => {
  ctx = makeTestContext();
});
afterAll(() => ctx.container.close());

const EMAIL = 'alice@mt.test';

describe('registration', () => {
  it('registers with a strong password and returns user + session', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/register')
      .send({ email: EMAIL, displayName: 'Alice', password: STRONG_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe(EMAIL);
    expect(res.body.user.role).toBe('user');
    expect(res.body.user).not.toHaveProperty('password_hash');
    expect(res.body.user).not.toHaveProperty('password');
  });

  it('rejects duplicate registration with EMAIL_IN_USE (and the email is case-insensitive)', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/register')
      .send({ email: EMAIL.toUpperCase(), displayName: 'Alice2', password: STRONG_PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
  });

  it('rejects weak passwords with ALL policy violations listed', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/register')
      // passes the 12-char schema gate, then the service finds 3 problems (no upper/digit/symbol)
      .send({ email: 'weak@mt.test', displayName: 'Weak', password: 'allthelowercase' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(3);
  });

  it('never lets a client self-assign the admin role', async () => {
    const s = await registerUser(request, ctx.app, { email: 'evil@mt.test' });
    await request(ctx.app)
      .post('/api/auth/register')
      .send({ email: 'evil2@mt.test', displayName: 'E', password: STRONG_PASSWORD, role: 'admin' });
    const me = await request(ctx.app).get('/api/auth/me').set(auth(s.accessToken));
    expect(me.body.user.role).toBe('user');
    const dbuser = ctx.container.userRepository.findByEmail('evil2@mt.test');
    expect(dbuser.role).toBe('user');
  });

  it('auto-creates a "self" health member for every new account', async () => {
    const s = await registerUser(request, ctx.app, { email: 'selfcheck@mt.test' });
    const res = await request(ctx.app).get('/api/members').set(auth(s.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.owned.some((m) => m.relationship === 'self')).toBe(true);
  });

  it('writes an audit event for registration', () => {
    const { items } = ctx.container.auditLogRepository.list({ action: 'auth.register' });
    expect(items.length).toBeGreaterThan(0);
  });
});

describe('login', () => {
  it('rejects unknown email as INVALID_CREDENTIALS (no user-enumeration signal)', async () => {
    const res = await login(request, ctx.app, 'ghost@mt.test', STRONG_PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.error.message).toMatch(/invalid email or password/i);
  });

  it('rejects wrong password and counts failures', async () => {
    const res = await login(request, ctx.app, EMAIL, 'Wr0ng!Passw0rd#totally');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    const user = ctx.container.userRepository.findByEmail(EMAIL);
    expect(user.failed_login_attempts).toBe(1);
  });

  it('locks the account after the configured number of failures', async () => {
    for (let i = 0; i < 5; i += 1) {
      await login(request, ctx.app, EMAIL, `Wr0ng!Passw0rd#${i}`);
    }
    const res = await login(request, ctx.app, EMAIL, 'Wr0ng!Passw0rd#x');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    const user = ctx.container.userRepository.findByEmail(EMAIL);
    expect(user.failed_login_attempts).toBeGreaterThanOrEqual(5);
    expect(user.lockout_until).toBeTruthy();
  });

  it('locked account rejects even the CORRECT password', async () => {
    const res = await login(request, ctx.app, EMAIL, STRONG_PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('audits failed logins and the lockout event', () => {
    const fails = ctx.container.auditLogRepository.list({ action: 'auth.login' }).items.filter(
      (e) => e.outcome === 'failure',
    );
    expect(fails.length).toBeGreaterThan(0);
    expect(ctx.container.auditLogRepository.list({ action: 'auth.lockout' }).items.length).toBe(1);
    // reset machinery for downstream tests
    ctx.container.userRepository.resetFailures(ctx.container.userRepository.findByEmail(EMAIL).id);
    ctx.container.db.run('UPDATE users SET lockout_until = NULL WHERE email = ?', EMAIL);
  });

  it('accepts the correct password afterwards and resets the failure counter', async () => {
    const res = await login(request, ctx.app, EMAIL, STRONG_PASSWORD);
    expect(res.status).toBe(200);
    const user = ctx.container.userRepository.findByEmail(EMAIL);
    expect(user.failed_login_attempts).toBe(0);
    expect(user.last_login_at).toBeTruthy();
  });
});

describe('refresh-token rotation & reuse detection', () => {
  let session;
  beforeAll(async () => {
    session = await registerUser(request, ctx.app, { email: 'rotation@mt.test' });
  });

  it('refresh rotates: new pair issued, old refresh token invalidated', async () => {
    const r1 = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(session.refreshToken);
    expect(r1.body.accessToken).not.toBe(session.accessToken);

    // Replay within the grace window is a BENIGN rotation race (multi-tab /
    // racing retries): a sibling session is issued, nobody is revoked.
    const grace = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(grace.status).toBe(200);
    expect(grace.body.refreshToken).toBeTruthy();
    expect(grace.body.refreshToken).not.toBe(r1.body.refreshToken);
    // the rotation from step 1 must still be alive after the grace replay
    const stillAlive = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(stillAlive.status).toBe(200);
  });

  it('replaying a rotated token AFTER the grace window is theft → REFRESH_REUSED', async () => {
    const s2 = await registerUser(request, ctx.app, { email: 'grace@mt.test' });
    const r1 = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: s2.refreshToken });
    expect(r1.status).toBe(200);
    // Age the rotation past the grace window (only the clock lies in tests).
    ctx.container.refreshTokenRepository.db.run(
      `UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?`,
      new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      ctx.container.tokenService.hashRefreshToken(s2.refreshToken),
    );
    const replay = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: s2.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSED');
  });

  it('a CONCURRENT burst of refreshes (the multi-tab race) keeps the session alive', async () => {
    const s3 = await registerUser(request, ctx.app, { email: 'burst@mt.test' });
    const body = { refreshToken: s3.refreshToken };
    // Fire three refreshes at once — exactly what racing 401-retries used to
    // do. Before the grace window the losers revoked the winner's brand-new
    // token and the whole session died within seconds of signing in.
    const burst = await Promise.all([
      request(ctx.app).post('/api/auth/refresh').send(body),
      request(ctx.app).post('/api/auth/refresh').send(body),
      request(ctx.app).post('/api/auth/refresh').send(body),
    ]);
    expect(burst.every((r) => r.status === 200)).toBe(true);
    // The winner's rotated token must still be usable afterwards.
    const next = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: burst[0].body.refreshToken });
    expect(next.status).toBe(200);
    // ...and the account has no reuse-detection event from this burst.
    const reuseEvents = ctx.container.auditLogRepository.list({ action: 'auth.refresh_reuse_detected' });
    expect(reuseEvents.items.every((e) => e.toJSON().user_id !== s3.user.id)).toBe(true);
  });

  it('reuse detection nukes the WHOLE token family (new token also dies)', async () => {
    // after the theft signal above, even the legitimately rotated token is dead
    const s4 = await login(request, ctx.app, 'grace@mt.test', STRONG_PASSWORD);
    const r = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: s4.body.refreshToken });
    const rotated = r.body.refreshToken;
    // legitimate rotation works...
    expect(r.status).toBe(200);
    // ...simulate theft: attacker replays the OLD token long after rotation
    ctx.container.refreshTokenRepository.db.run(
      `UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?`,
      new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      ctx.container.tokenService.hashRefreshToken(s4.body.refreshToken),
    );
    await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: s4.body.refreshToken });
    // → the full family, including the freshest token, must be revoked
    const after = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: rotated });
    expect(after.status).toBe(401);
  });

  it('unknown refresh tokens are REFRESH_INVALID', async () => {
    const res = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: 'x'.repeat(64) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_INVALID');
  });

  it('audits the reuse detection event with the family id', () => {
    const { items } = ctx.container.auditLogRepository.list({ action: 'auth.refresh_reuse_detected' });
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((e) => e.toJSON().metadata.familyId)).toBe(true);
  });
});

describe('authenticated session', () => {
  let session;
  beforeAll(async () => {
    session = await registerUser(request, ctx.app, { email: 'sess@mt.test' });
  });

  it('GET /api/auth/me returns the current user', async () => {
    const res = await request(ctx.app).get('/api/auth/me').set(auth(session.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('sess@mt.test');
  });

  it('missing Authorization header → 401 NO_TOKEN', async () => {
    const res = await request(ctx.app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('NO_TOKEN');
  });

  it('garbage bearer → 401 TOKEN_INVALID', async () => {
    const res = await request(ctx.app).get('/api/auth/me').set(auth('garbage.token.here'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('refresh token used as bearer is rejected (wrong token type)', async () => {
    const res = await request(ctx.app).get('/api/auth/me').set(auth(session.refreshToken));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('logout revokes only the presented refresh token (idempotent)', async () => {
    const a = await registerUser(request, ctx.app, { email: 'logout@mt.test' });
    const r = await request(ctx.app).post('/api/auth/logout').send({ refreshToken: a.refreshToken });
    expect(r.body.revoked).toBe(true);
    const again = await request(ctx.app).post('/api/auth/logout').send({ refreshToken: a.refreshToken });
    expect(again.body.revoked).toBe(false);
    // access token still valid until it expires (design: short TTL + refresh kill)
    const me = await request(ctx.app).get('/api/auth/me').set(auth(a.accessToken));
    expect(me.status).toBe(200);
  });

  it('logout-all invalidates outstanding ACCESS tokens immediately (token version bump)', async () => {
    const b = await registerUser(request, ctx.app, { email: 'logoutall@mt.test' });
    await request(ctx.app).post('/api/auth/logout-all').set(auth(b.accessToken));
    const me = await request(ctx.app).get('/api/auth/me').set(auth(b.accessToken));
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
    const r = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: b.refreshToken });
    expect(r.status).toBe(401);
  });

  it('change-password invalidates old sessions and the old password no longer works', async () => {
    const c = await registerUser(request, ctx.app, { email: 'changepw@mt.test' });
    const NEW = 'N3w!Str0nger#Passw0rd';
    const res = await request(ctx.app)
      .post('/api/auth/change-password')
      .set(auth(c.accessToken))
      .send({ currentPassword: STRONG_PASSWORD, newPassword: NEW });
    expect(res.status).toBe(200);
    expect(res.body.sessionsRevoked).toBe(true);

    const me = await request(ctx.app).get('/api/auth/me').set(auth(c.accessToken));
    expect(me.body.error.code).toBe('SESSION_REVOKED');
    expect((await login(request, ctx.app, 'changepw@mt.test', STRONG_PASSWORD)).status).toBe(401);
    expect((await login(request, ctx.app, 'changepw@mt.test', NEW)).status).toBe(200);
  });

  it('change-password rejects a wrong current password (401, no change)', async () => {
    const d = await registerUser(request, ctx.app, { email: 'wrongcur@mt.test' });
    const res = await request(ctx.app)
      .post('/api/auth/change-password')
      .set(auth(d.accessToken))
      .send({ currentPassword: 'Wr0ng!Passw0rd#1', newPassword: 'N3w!Str0nger#Passw0rd' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await login(request, ctx.app, 'wrongcur@mt.test', STRONG_PASSWORD)).status).toBe(200);
  });

  it('change-password refuses identical new password', async () => {
    const e = await registerUser(request, ctx.app, { email: 'samepw@mt.test' });
    const res = await request(ctx.app)
      .post('/api/auth/change-password')
      .set(auth(e.accessToken))
      .send({ currentPassword: STRONG_PASSWORD, newPassword: STRONG_PASSWORD });
    expect(res.status).toBe(400);
  });
});
