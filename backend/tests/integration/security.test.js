import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext, registerUser, auth, STRONG_PASSWORD } from '../helpers.js';

describe('HTTP security headers & hygiene', () => {
  let ctx;
  beforeAll(() => {
    ctx = makeTestContext();
  });
  afterAll(() => ctx.container.close());

  it('sets hardened security headers (helmet)', async () => {
    const res = await request(ctx.app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeTruthy();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('issues and echoes a request id for correlation', async () => {
    const res = await request(ctx.app).get('/api/health');
    expect(res.headers['x-request-id']).toBeTruthy();
    const res2 = await request(ctx.app).get('/api/health').set('X-Request-Id', 'corr-123');
    expect(res2.headers['x-request-id']).toBe('corr-123');
  });

  it('unknown API routes return ROUTE_NOT_FOUND, not a stack trace', async () => {
    const res = await request(ctx.app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('malformed JSON bodies are rejected as BAD_JSON', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "incomplete"');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_JSON');
  });

  it('huge JSON bodies are rejected 413', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(`{"email":"${'a'.repeat(2 * 1024 * 1024)}@x.tld","password":"x"}`);
    expect([413, 400]).toContain(res.status);
    if (res.status === 413) expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('validation errors shape: path + message per failing field', async () => {
    const res = await request(ctx.app).post('/api/auth/register').send({ email: 'not-an-email', displayName: '', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.map((d) => d.path);
    expect(paths).toContain('email');
    expect(paths).toContain('password');
  });

  it('non-uuid path parameters are VALIDATION_ERROR, not 500s', async () => {
    const s = await registerUser(request, ctx.app, { email: 'sec1@mt.test' });
    const res = await request(ctx.app).get('/api/members/not-a-uuid').set(auth(s.accessToken));
    expect(res.status).toBe(400);
  });

  it('error responses never leak stack traces or SQL fragments', async () => {
    const s = await registerUser(request, ctx.app, { email: 'sec2@mt.test' });
    const res = await request(ctx.app).get('/api/members/not-a-uuid').set(auth(s.accessToken));
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+\.|SELECT \*|sqlite/i);
  });

  it("SQL-injection attempts in text fields are stored as data, never executed", async () => {
    const s = await registerUser(request, ctx.app, { email: 'sec3@mt.test' });
    const members = await request(ctx.app).get('/api/members').set(auth(s.accessToken));
    const memberId = members.body.owned.find((m) => m.relationship === 'self').id;
    const injection = "x'); DROP TABLE users;--";
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/observations`)
      .set(auth(s.accessToken))
      .send({ kind: 'note', payload: { text: injection } });
    expect(res.status).toBe(201);
    const list = await request(ctx.app).get('/api/members').set(auth(s.accessToken));
    expect(list.status).toBe(200); // users table intact
    const detail = await request(ctx.app)
      .get(`/api/members/${memberId}/observations?kind=note`)
      .set(auth(s.accessToken));
    expect(detail.body.items[0].payload.text).toBe(injection); // stored verbatim, harmless
  });
});

describe('rate limiting', () => {
  let ctx;
  beforeAll(() => {
    ctx = makeTestContext({ RATE_LIMIT_AUTH_MAX: '3' });
  });
  afterAll(() => ctx.container.close());

  it('the auth bucket locks out after the configured max, with Retry-After', async () => {
    for (let i = 0; i < 3; i += 1) {
      const ok = await request(ctx.app).post('/api/auth/login').send({ email: `rl${i}@x.tld`, password: 'whatever' });
      expect(ok.status).toBe(401);
    }
    const blocked = await request(ctx.app).post('/api/auth/login').send({ email: 'rl3@x.tld', password: 'whatever' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect(blocked.headers['x-ratelimit-limit']).toBe('3');
  });

  it('the general bucket is independent — health still answers', async () => {
    const res = await request(ctx.app).get('/api/health');
    expect(res.status).toBe(200);
  });
});

describe('CORS policy', () => {
  let ctx;
  beforeAll(() => {
    ctx = makeTestContext(); // dev-test mode: localhost + *.e2b.app allowed
  });
  afterAll(() => ctx.container.close());

  it('allows configured-dev origins (localhost frontend)', async () => {
    const res = await request(ctx.app).get('/api/health').set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('allows the e2b live-preview host', async () => {
    const res = await request(ctx.app).get('/api/health').set('Origin', 'https://8080-abc.e2b.app');
    expect(res.headers['access-control-allow-origin']).toBe('https://8080-abc.e2b.app');
  });

  it('rejects unknown origins badly', async () => {
    const res = await request(ctx.app).get('/api/health').set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORS_DENIED');
  });

  it('handles preflight requests', async () => {
    const res = await request(ctx.app)
      .options('/api/auth/login')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization');
    expect([200, 204]).toContain(res.status);
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
  });

  it('requests without Origin (curl/mobile app) pass through', async () => {
    const res = await request(ctx.app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('allows the dashboard same-origin in strict production mode', async () => {
    const prod = makeTestContext({ NODE_ENV: 'production', DB_PATH: ':memory:', CORS_ORIGINS: '' });
    try {
      const res = await request(prod.app)
        .get('/api/health')
        .set('Host', 'kivo.local')
        .set('Origin', 'http://kivo.local');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://kivo.local');
    } finally {
      prod.container.close();
    }
  });

  it('normalizes a configured origin copied with a trailing slash', () => {
    const prod = makeTestContext({ NODE_ENV: 'production', DB_PATH: ':memory:', CORS_ORIGINS: 'https://app.example.com/' });
    try {
      expect(prod.config.isOriginAllowed('https://app.example.com')).toBe(true);
    } finally {
      prod.container.close();
    }
  });
});

describe('JWT body limit + helmet on API root', () => {
  let ctx;
  beforeAll(() => {
    ctx = makeTestContext();
  });
  afterAll(() => ctx.container.close());

  it('GET / returns product metadata — never a service name or internal path', async () => {
    const res = await request(ctx.app).get('/');
    expect(res.body.name).toBe('kivo');
    expect(JSON.stringify(res.body)).not.toMatch(/backend|readme|\.md\b/i);
    expect(res.body.dashboard).toBe('/app/');
  });

  it('lab dictionary is public so clients can show ranges', async () => {
    const res = await request(ctx.app).get('/api/meta/lab-dictionary');
    expect(res.status).toBe(200);
    expect(res.body.markers.hba1c.name).toMatch(/hba1c/i);
  });

  it('a password with spaces inside is valid if it meets policy', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/register')
      .send({ email: 'spaces@x.tld', displayName: 'Sp', password: 'My S3cret Is Str0ng!' });
    expect(res.status).toBe(201);
  });
});
