#!/usr/bin/env node
/**
 * Automated security-posture check. Boots the REAL app (in-process, in-memory
 * DB) on an ephemeral port and asserts the full defensive header surface and
 * a few transport behaviors. Fails hard (exit 1) on any regression.
 *
 * Run with `npm run security:headers`. Free, offline, deterministic.
 */
import http from 'node:http';
import { Container } from '../src/container/Container.js';
import { Config } from '../src/config/Config.js';
import { createApp } from '../src/app.js';

const config = new Config({ NODE_ENV: 'development', JWT_SECRET: 'security-headers-check-0123456789' });
const container = new Container({ config });
const app = createApp(container);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const failures = [];
function expect(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

async function get(p, headers = {}) {
  const res = await fetch(`${base}${p}`, { headers });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

const api = await get('/api/health');
expect('Content-Security-Policy served', !!api.headers.get('content-security-policy'));
expect('Strict-Transport-Security served', !!api.headers.get('strict-transport-security'));
expect('X-Content-Type-Options: nosniff', api.headers.get('x-content-type-options') === 'nosniff');
expect('X-Frame-Options served', !!api.headers.get('x-frame-options'));
expect('Referrer-Policy served', !!api.headers.get('referrer-policy'));
expect('Permissions-Policy lockdown served', (api.headers.get('permissions-policy') || '').includes('geolocation=()'));
expect('Cache-Control: no-store on /api', (api.headers.get('cache-control') || '').includes('no-store'));
expect('X-Powered-By removed', api.headers.get('x-powered-by') === null);
expect('Server banner not leaked', !String(api.headers.get('server') || '').toLowerCase().includes('express'));

const evil = await get('/api/health', { origin: 'https://evil.example.com' });
expect('CORS: evil origin gets no allow-origin', evil.headers.get('access-control-allow-origin') === null);

const good = await get('/api/health', { origin: 'http://localhost:3000' });
expect('CORS: localhost dev origin allowed', good.headers.get('access-control-allow-origin') === 'http://localhost:3000');

const missing = await get('/api/auth/me');
expect('missing token → 401 JSON (no html error page)', missing.status === 401 && missing.body.includes('"error"'));

const notFound = await get('/api/does-not-exist');
expect('unknown route → JSON 404', notFound.status === 404 && notFound.body.includes('ROUTE_NOT_FOUND'));
expect('no stack trace in error bodies', !notFound.body.includes('\n    at ') && !missing.body.includes('\n    at '));

// SecurityMonitor (enabled in dev) responds with 429 + Retry-After when blocked.
const monitor = container.securityMonitor;
monitor.recordFailure('203.0.113.9', 401); // direct trip for a deterministic check
for (let i = 0; i < config.securityMonitor.maxFailures; i += 1) monitor.recordFailure('203.0.113.9', 401);
expect('SecurityMonitor blocks after threshold', monitor.isBlocked('203.0.113.9'));
const audit = container.auditLogRepository.list({ action: 'security.ip_blocked' });
expect('SecurityMonitor writes security.ip_blocked audit event', audit.total >= 1);

server.close();
container.close();

console.log(failures.length === 0 ? '\nsecurity-headers: ALL CHECKS PASSED' : `\nsecurity-headers: ${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
