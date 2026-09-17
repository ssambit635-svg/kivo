import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext, registerUser, auth } from '../helpers.js';
import { SecurityMonitorService } from '../../src/services/SecurityMonitorService.js';

/**
 * Automated security layer tests:
 *  - /api is never cacheable (health data must not sit in browser/proxy caches)
 *  - Permissions-Policy lockdown is served
 *  - SecurityMonitor: cross-endpoint 401/403 failure tracking with AUTOMATIC
 *    IP block + audit alert; honest 400/404 errors never count; blocks expire.
 */

describe('defense-in-depth headers', () => {
  let ctx;
  beforeAll(() => { ctx = makeTestContext(); });
  afterAll(() => ctx.container.close());

  it('serves Cache-Control: no-store on every /api response', async () => {
    const r = await request(ctx.app).get('/api/health');
    expect(r.headers['cache-control']).toMatch(/no-store/);
    expect(r.headers.pragma).toBe('no-cache');

    const sess = await registerUser(request, ctx.app, { email: 'nostore@mt.test' });
    const me = await request(ctx.app).get('/api/auth/me').set(auth(sess.accessToken));
    expect(me.headers['cache-control']).toMatch(/no-store/);
  });

  it('serves a Permissions-Policy lockdown', async () => {
    const r = await request(ctx.app).get('/api/health');
    const pp = r.headers['permissions-policy'] || '';
    expect(pp).toContain('geolocation=()');
    expect(pp).toContain('payment=()');
    expect(pp).toContain('camera=(self)');
  });
});

describe('SecurityMonitor — automated IP blocking', () => {
  it('is OFF by default in the test environment (suite stability)', () => {
    const ctx = makeTestContext();
    expect(ctx.container.securityMonitor.enabled).toBe(false);
    ctx.container.close();
  });

  it('hammering invalid tokens does not block when disabled', async () => {
    const ctx = makeTestContext();
    for (let i = 0; i < 30; i += 1) {
      const r = await request(ctx.app).get('/api/auth/me').set(auth('garbage-token'));
      expect(r.status).toBe(401);
    }
    const ok = await request(ctx.app).get('/api/health');
    expect(ok.status).toBe(200);
    ctx.container.close();
  });

  it('auto-blocks an IP after repeated cross-endpoint 401s and audits it', async () => {
    const ctx = makeTestContext({
      SECURITY_MONITOR_ENABLED: 'true',
      SECURITY_MONITOR_MAX_FAILURES: '5',
      SECURITY_MONITOR_WINDOW_MS: '60000',
      SECURITY_MONITOR_BLOCK_MS: '60000',
    });
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      const r = await request(ctx.app).get('/api/auth/me').set(auth(`bad-token-${i}`));
      statuses.push(r.status);
    }
    // first 6 pass through as 401 (5 tolerated + the one that trips the block),
    // everything after is auto-blocked with 429 + Retry-After
    expect(statuses.filter((s) => s === 401).length).toBeGreaterThanOrEqual(6);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);

    const blocked = await request(ctx.app).get('/api/health');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    const { items } = ctx.container.auditLogRepository.list({ action: 'security.ip_blocked' });
    expect(items.length).toBe(1);
    const meta = items[0].toJSON().metadata;
    expect(meta.automated).toBe(true);
    expect(meta.failures).toBeGreaterThan(5);

    // legit traffic from the same IP is blocked too — the block is IP-scoped
    const me = await request(ctx.app).get('/api/auth/me').set(auth('anything'));
    expect(me.status).toBe(429);
    const health = await request(ctx.app).get('/api/health');
    expect(health.status).toBe(429);
    ctx.container.close();
  });

  it('never counts honest 400 validation errors toward a block', async () => {
    const ctx = makeTestContext({
      SECURITY_MONITOR_ENABLED: 'true',
      SECURITY_MONITOR_MAX_FAILURES: '4',
      SECURITY_MONITOR_BLOCK_MS: '60000',
    });
    // 30 validation errors (400) must not trigger a block
    const sess = await registerUser(request, ctx.app, { email: 'honest@mt.test' });
    for (let i = 0; i < 30; i += 1) {
      const r = await request(ctx.app)
        .post(`/api/members/not-a-uuid/ask`)
        .set(auth(sess.accessToken))
        .send({ question: 'hello there' });
      expect(r.status).toBe(400);
    }
    const stillFine = await request(ctx.app).get('/api/health');
    expect(stillFine.status).toBe(200);

    // ...but 401 failures do
    for (let i = 0; i < 6; i += 1) {
      await request(ctx.app).get('/api/auth/me').set(auth('forged'));
    }
    const after = await request(ctx.app).get('/api/health');
    expect(after.status).toBe(429);
    ctx.container.close();
  });

  it('blocks auto-expire after the cooldown', async () => {
    const monitor = new SecurityMonitorService({
      config: { securityMonitor: { enabled: true, windowMs: 60_000, maxFailures: 1, blockMs: 40 } },
      auditService: { record: () => {} },
    });
    monitor.recordFailure('1.2.3.4', 401);
    monitor.recordFailure('1.2.3.4', 401); // trips block (count 2 > 1)
    expect(monitor.isBlocked('1.2.3.4')).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(monitor.isBlocked('1.2.3.4')).toBe(false);
    expect(monitor.stats().blockedIps).toBe(0);
  });

  it('monitor faults degrade open (never weaken auth)', () => {
    const monitor = new SecurityMonitorService({ config: {}, auditService: null });
    expect(() => monitor.recordFailure(null, 401)).not.toThrow();
    expect(() => monitor.recordFailure('9.9.9.9', 401)).not.toThrow();
    expect(monitor.enabled).toBe(true);
  });
});
