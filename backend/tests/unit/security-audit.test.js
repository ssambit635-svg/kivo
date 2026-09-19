/**
 * Regression pin for the dependency advisory gate.
 *
 * The gate exists because `npm audit` on npm 10 posts to a retired endpoint
 * that answers `400 Invalid package tree` for every lockfile — that turned
 * `main` red on healthy code. These tests pin the two halves of the contract:
 *
 *   1. a real high/critical advisory must fail the build, and
 *   2. an unreachable advisory service must NOT be reported as a vulnerability
 *      (a third-party outage may never fail CI again), unless --strict is set.
 *
 * A local stub stands in for registry.npmjs.org, so this runs fully offline.
 * The child is spawned asynchronously on purpose: `spawnSync` would block this
 * process's event loop, leaving the in-process stub unable to answer.
 */
import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(BACKEND, 'scripts', 'security-audit.js');

const servers = [];
afterAll(() => {
  for (const s of servers) s.close();
});

/** Starts a stub advisory service; `reply` decides what POSTs receive. */
function startStub(reply) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => reply(JSON.parse(body || '{}'), res));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/** Runs the gate against a stub port and resolves with { code, out }. */
function runGate(port, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: BACKEND,
      env: { ...process.env, AUDIT_REGISTRY: `http://127.0.0.1:${port}` },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const jsonStub = (payload) =>
  startStub((p, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });

describe('dependency advisory gate', () => {
  it('reads the production closure from the lockfile, not node_modules', async () => {
    let seen = null;
    const port = await startStub((payload, res) => {
      seen = Object.keys(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });

    const { code, out } = await runGate(port);

    expect(code).toBe(0);
    expect(out).toMatch(/packages \(\d+ versions\) from package-lock\.json — production only/);
    // Production deps are asked about; the dev-only tree is not.
    expect(seen).toContain('express');
    expect(seen).toContain('helmet');
    expect(seen).not.toContain('vitest');
    expect(seen).not.toContain('supertest');
  });

  it('--all widens the closure to devDependencies', async () => {
    let seen = null;
    const port = await startStub((payload, res) => {
      seen = Object.keys(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });

    const { code } = await runGate(port, ['--all']);

    expect(code).toBe(0);
    expect(seen).toContain('vitest');
  });

  it('fails (exit 1) on a high advisory and names the package', async () => {
    const port = await jsonStub({
      express: [{
        id: 1,
        url: 'https://github.com/advisories/GHSA-test',
        title: 'Test RCE',
        severity: 'high',
        vulnerable_versions: '<4.21.3',
      }],
    });

    const { code, out } = await runGate(port);

    expect(code).toBe(1);
    expect(out).toContain('FAIL');
    expect(out).toContain('express');
    expect(out).toContain('Test RCE');
  });

  it('fails on critical too, and passes low/moderate with a warning', async () => {
    const critical = await jsonStub({ zod: [{ title: 'c', severity: 'critical', vulnerable_versions: '*' }] });
    expect((await runGate(critical)).code).toBe(1);

    const moderate = await jsonStub({ zod: [{ title: 'm', severity: 'moderate', vulnerable_versions: '*' }] });
    const { code, out } = await runGate(moderate);
    expect(code).toBe(0);
    expect(out).toContain('No high/critical advisories');
  });

  it('an unresponsive advisory service warns and passes — never a false red', async () => {
    const port = await startStub((p, res) => {
      // Exactly what registry.npmjs.org answers today for the retired endpoint.
      res.writeHead(503, { 'Content-Type': 'application/json', 'npm-notice': 'This endpoint is being retired.' });
      res.end(JSON.stringify({ error: 'maintenance' }));
    });

    const { code, out } = await runGate(port);

    expect(code).toBe(0);
    expect(out).toContain('WARN');
    expect(out).toContain('did NOT run');
    expect(out).not.toContain('FAIL');
  });

  it('--strict makes an unreachable service fail closed', async () => {
    // Nothing is listening on this port.
    const { code, out } = await runGate(9, ['--strict']);

    expect(code).toBe(1);
    expect(out).toContain('FAIL');
  });
});
