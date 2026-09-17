#!/usr/bin/env node
/**
 * MedTwin AI backend — full-surface smoke test.
 *
 * Boots the REAL server (same entrypoint as `npm start`) on a scratch
 * file DB, then exercises EVERY API endpoint end-to-end over HTTP:
 * public meta, full auth lifecycle (register/login/refresh rotation/
 * reuse-detection/password-change/logout), members + shares, reports
 * ingest→verify→explain, observations, trends/risk/doctor-summary/
 * health-score/milestones/guidance/medication-awareness, reminders,
 * the Personal Health Intelligence engine, Ask the Twin, admin, and a
 * security probe set (headers, CORS, 401/404 hiding, validation, 413).
 *
 * Zero-cost: no external services. Run with `npm run smoke`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.SMOKE_PORT || 8091);
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = mkdtempSync(path.join(tmpdir(), 'medtwin-smoke-'));
const dbPath = path.join(scratch, 'smoke.db');
const uploadDir = path.join(scratch, 'uploads');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const PASSWORD = 'Str0ng!Passw0rd#Smoke';

const results = [];
let step = 0;
function record(name, ok, detail = '') {
  step += 1;
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(step).padStart(2, ' ')}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (e) {
    record(name, false, e.message);
  }
}

async function req(method, p, { token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, json, text, headers: res.headers };
}
const expectStatus = (got, want, label) => {
  if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`);
};

let server;
async function startServer() {
  // Admin account created on the scratch DB BEFORE the server boots.
  await new Promise((resolve, reject) => {
    const p = spawn('node', ['scripts/create-admin.js', 'smoke-admin@medtwin.dev', 'Smoke Admin', PASSWORD], {
      env: { ...process.env, DB_PATH: dbPath, JWT_SECRET, NODE_ENV: 'development' },
      stdio: 'inherit',
    });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`create-admin exited ${code}`))));
  });

  server = spawn('node', ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOAD_DIR: uploadDir, JWT_SECRET, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become healthy in 15s');
}

const REPORT1 = [
  'CITY DIAGNOSTICS - SMOKE LAB', 'Patient: SMOKE USER   Age/Gender: 40/M',
  'Report Date: 10-01-2025',
  'Test Result Unit Reference Range',
  'HbA1c 5.5 % (4.0 - 5.6)',
  'Fasting Blood Sugar 96 mg/dL 70 - 100',
  'Total Cholesterol 195 mg/dL Reference: <200',
  'HDL Cholesterol 44 mg/dL (40 - 60)',
  'LDL Cholesterol 118 mg/dL (50 - 100)',
  'Triglycerides 132 mg/dL (30 - 150)',
  'Hemoglobin 14.1 g/dL (12 - 16)',
  'Creatinine 1.0 mg/dL (0.7 - 1.3)',
].join('\n');
const REPORT2 = REPORT1
  .replace('10-01-2025', '10-07-2025')
  .replace('HbA1c 5.5', 'HbA1c 5.9')
  .replace('Fasting Blood Sugar 96', 'Fasting Blood Sugar 107')
  .replace('Triglycerides 132', 'Triglycerides 168');

async function main() {
  console.log(`MedTwin smoke test — server ${BASE}, scratch DB ${dbPath}\n`);
  await startServer();

  // ---------------- public / system ----------------
  await check('GET / (service banner)', async () => {
    const r = await req('GET', '/');
    expectStatus(r.status, 200, 'banner');
    if (!r.json?.name) throw new Error('no name in banner');
  });
  await check('GET /api/health', async () => {
    const r = await req('GET', '/api/health');
    expectStatus(r.status, 200, 'health');
    if (r.json?.status !== 'ok') throw new Error('status not ok');
  });
  await check('GET /api/meta/lab-dictionary (public knowledge)', async () => {
    const r = await req('GET', '/api/meta/lab-dictionary');
    expectStatus(r.status, 200, 'dictionary');
    const n = Object.keys(r.json?.markers || {}).length;
    if (n === 0) throw new Error('no markers');
    return `${n} core markers`;
  });
  await check('GET /api/meta/lab-dictionary?tier=all (full catalogue)', async () => {
    const r = await req('GET', '/api/meta/lab-dictionary?tier=all');
    expectStatus(r.status, 200, 'dictionary all');
    const n = Object.keys(r.json?.markers || {}).length;
    if (n < 500) throw new Error(`expected full catalogue, got ${n}`);
    return `${n} markers`;
  });
  await check('GET /api/meta/knowledge (transparency report)', async () => {
    const r = await req('GET', '/api/meta/knowledge');
    expectStatus(r.status, 200, 'knowledge');
  });
  await check('GET /app/ (demo dashboard served)', async () => {
    const r = await req('GET', '/app/');
    expectStatus(r.status, 200, 'dashboard');
    if (!r.text.includes('<html')) throw new Error('no html');
  });

  // ---------------- auth lifecycle ----------------
  const email = `smoke+${Date.now()}@medtwin.dev`;
  let sess;
  await check('POST /api/auth/register', async () => {
    const r = await req('POST', '/api/auth/register', { body: { email, displayName: 'Smoke User', password: PASSWORD } });
    expectStatus(r.status, 201, 'register');
    sess = r.json;
    if (!sess.accessToken || !sess.refreshToken) throw new Error('no tokens');
  });
  await check('POST /api/auth/login', async () => {
    const r = await req('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    expectStatus(r.status, 200, 'login');
  });
  await check('POST /api/auth/login (wrong password rejected)', async () => {
    const r = await req('POST', '/api/auth/login', { body: { email, password: 'Wr0ng!Passw0rd#nope' } });
    expectStatus(r.status, 401, 'wrong password');
  });
  await check('GET /api/auth/me', async () => {
    const r = await req('GET', '/api/auth/me', { token: sess.accessToken });
    expectStatus(r.status, 200, 'me');
    if (r.json?.user?.email !== email) throw new Error('email mismatch');
  });
  await check('GET /api/profile', async () => {
    const r = await req('GET', '/api/profile', { token: sess.accessToken });
    expectStatus(r.status, 200, 'profile');
    if (JSON.stringify(r.json).includes('password_hash')) throw new Error('hash leaked');
  });

  // refresh rotation + reuse detection
  let rt2;
  await check('POST /api/auth/refresh (rotates tokens)', async () => {
    const r = await req('POST', '/api/auth/refresh', { body: { refreshToken: sess.refreshToken } });
    expectStatus(r.status, 200, 'refresh');
    rt2 = r.json.refreshToken;
    if (!rt2 || rt2 === sess.refreshToken) throw new Error('token not rotated');
    sess.accessToken = r.json.accessToken;
  });
  await check('POST /api/auth/refresh (REUSE of rotated token detected)', async () => {
    const r = await req('POST', '/api/auth/refresh', { body: { refreshToken: sess.refreshToken } });
    expectStatus(r.status, 401, 'reuse');
    if (r.json?.error?.code !== 'REFRESH_REUSED') throw new Error(`code ${r.json?.error?.code}`);
  });
  await check('family revocation: newest token also dead after reuse', async () => {
    const r = await req('POST', '/api/auth/refresh', { body: { refreshToken: rt2 } });
    expectStatus(r.status, 401, 'family revoked');
    // recover a session for the rest of the smoke run
    const lg = await req('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    expectStatus(lg.status, 200, 're-login');
    sess = lg.json;
  });
  await check('GET /api/auth/me without token → 401', async () => {
    const r = await req('GET', '/api/auth/me');
    expectStatus(r.status, 401, 'no token');
  });
  await check('GET /api/auth/me with garbage token → 401', async () => {
    const r = await req('GET', '/api/auth/me', { token: 'garbage.token.here' });
    expectStatus(r.status, 401, 'garbage token');
  });

  // ---------------- members ----------------
  let memberId;
  await check('GET /api/members (self twin auto-created)', async () => {
    const r = await req('GET', '/api/members', { token: sess.accessToken });
    expectStatus(r.status, 200, 'members');
    const self = r.json.owned.find((m) => m.relationship === 'self');
    if (!self) throw new Error('no self member');
    memberId = self.id;
  });
  await check('POST /api/members (add family member)', async () => {
    const r = await req('POST', '/api/members', { token: sess.accessToken, body: { name: 'Parent', relationship: 'parent' } });
    expectStatus(r.status, 201, 'create member');
  });
  await check('PATCH /api/members/:id (twin profile)', async () => {
    const r = await req('PATCH', `/api/members/${memberId}`, {
      token: sess.accessToken,
      body: { dob: '1985-03-12', sex: 'male', heightCm: 172, familyHistory: { diabetes: true } },
    });
    expectStatus(r.status, 200, 'patch member');
  });
  await check('GET /api/members/:id', async () => {
    const r = await req('GET', `/api/members/${memberId}`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'get member');
  });
  await check('GET /api/members/:id/family-history', async () => {
    const r = await req('GET', `/api/members/${memberId}/family-history`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'family history');
  });

  // ---------------- reports pipeline ----------------
  let reportIds = [];
  for (const [i, text] of [REPORT1, REPORT2].entries()) {
    await check(`POST /api/members/:id/reports (ingest text report #${i + 1})`, async () => {
      const r = await req('POST', `/api/members/${memberId}/reports`, { token: sess.accessToken, body: { text } });
      expectStatus(r.status, 201, 'ingest');
      const extracted = r.json.preview?.extracted?.length ?? 0;
      if (extracted === 0) throw new Error('no markers extracted');
      reportIds.push(r.json.report.id);
      return `${extracted} markers extracted`;
    });
  }
  await check('GET /api/members/:id/reports (list)', async () => {
    const r = await req('GET', `/api/members/${memberId}/reports`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'list reports');
    if (r.json.total < 2) throw new Error('expected 2 reports');
  });
  let labId;
  await check('GET /api/reports/:id (single + badge)', async () => {
    const r = await req('GET', `/api/reports/${reportIds[0]}`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'get report');
    if (!r.json.badge?.level) throw new Error('no badge');
    labId = r.json.results?.[0]?.id;
    if (!labId) throw new Error('no lab results on report');
    return `badge=${r.json.badge.level}`;
  });
  await check('POST /api/reports/:id/lab-results (manual add)', async () => {
    const r = await req('POST', `/api/reports/${reportIds[0]}/lab-results`, {
      token: sess.accessToken,
      body: { code: 'tsh', value: 2.1, unit: 'uIU/mL', refLow: 0.4, refHigh: 4.0 },
    });
    expectStatus(r.status, 201, 'add lab');
  });
  await check('PATCH /api/lab-results/:id (correction before verify)', async () => {
    const r = await req('PATCH', `/api/lab-results/${labId}`, { token: sess.accessToken, body: { value: 5.6 } });
    expectStatus(r.status, 200, 'patch lab');
  });
  await check('PATCH /api/reports/:id (update meta)', async () => {
    const r = await req('PATCH', `/api/reports/${reportIds[0]}`, { token: sess.accessToken, body: { notes: 'smoke run' } });
    expectStatus(r.status, 200, 'patch report');
  });
  for (const rid of reportIds) {
    await check(`POST /api/reports/${rid.slice(0, 8)}…/verify (trust gate)`, async () => {
      const r = await req('POST', `/api/reports/${rid}/verify`, { token: sess.accessToken, body: {} });
      expectStatus(r.status, 200, 'verify');
    });
  }
  await check('verified report is immutable (409 on lab edit)', async () => {
    const r = await req('PATCH', `/api/lab-results/${labId}`, { token: sess.accessToken, body: { value: 1 } });
    expectStatus(r.status, 409, 'immutable');
  });
  await check('POST /api/reports/:id/unverify → re-verify', async () => {
    const r = await req('POST', `/api/reports/${reportIds[1]}/unverify`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'unverify');
    const v = await req('POST', `/api/reports/${reportIds[1]}/verify`, { token: sess.accessToken, body: {} });
    expectStatus(v.status, 200, 're-verify');
  });
  await check('GET /api/reports/:id/explanation (grounded narration)', async () => {
    const r = await req('GET', `/api/reports/${reportIds[0]}/explanation`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'explain');
    if (!r.json.explanation?.text) throw new Error('no explanation text');
  });

  // ---------------- observations ----------------
  let obsId;
  await check('POST /api/members/:id/observations (manual)', async () => {
    const r = await req('POST', `/api/members/${memberId}/observations`, {
      token: sess.accessToken, body: { kind: 'weight', payload: { weightKg: 78 } },
    });
    expectStatus(r.status, 201, 'obs');
    obsId = r.json.observation?.id || r.json.id;
  });
  await check('POST /api/members/:id/observations (voice-sourced)', async () => {
    const r = await req('POST', `/api/members/${memberId}/observations`, {
      token: sess.accessToken,
      body: { kind: 'symptom', payload: { text: 'feeling tired' }, source: 'voice' },
    });
    expectStatus(r.status, 201, 'voice obs');
  });
  await check('POST /api/members/:id/observations (bp + activity + sleep)', async () => {
    for (const [kind, payload] of [
      ['bp', { systolic: 124, diastolic: 82 }],
      ['activity', { minutesPerWeek: 150 }],
      ['sleep', { hours: 7 }],
      ['medication', { name: 'Multivitamin', dose: '1/day' }],
    ]) {
      const r = await req('POST', `/api/members/${memberId}/observations`, { token: sess.accessToken, body: { kind, payload } });
      expectStatus(r.status, 201, kind);
    }
  });
  await check('GET /api/members/:id/observations (list + filter)', async () => {
    const r = await req('GET', `/api/members/${memberId}/observations?kind=weight`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'list obs');
    if (r.json.total < 1) throw new Error('no weight obs');
  });
  await check('DELETE /api/observations/:id', async () => {
    const r = await req('DELETE', `/api/observations/${obsId}`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'delete obs');
  });

  // ---------------- health intelligence ----------------
  await check('GET /api/members/:id/trends (all markers + narrative)', async () => {
    const r = await req('GET', `/api/members/${memberId}/trends`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'trends');
    if (!Array.isArray(r.json.trends)) throw new Error('no trends array');
  });
  await check('GET /api/members/:id/trends?code=hba1c (single marker)', async () => {
    const r = await req('GET', `/api/members/${memberId}/trends?code=hba1c`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'trend code');
    if (r.json.code !== 'hba1c') throw new Error('wrong code');
  });
  await check('POST /api/members/:id/risk/diabetes (explainable estimate)', async () => {
    const r = await req('POST', `/api/members/${memberId}/risk/diabetes`, { token: sess.accessToken, body: {} });
    expectStatus(r.status, 200, 'risk');
    if (!Number.isFinite(r.json.result?.percent)) throw new Error('no percent');
    if (!r.json.result?.disclaimer) throw new Error('missing disclaimer');
  });
  await check('POST /api/members/:id/risk/diabetes (what-if scenario)', async () => {
    const r = await req('POST', `/api/members/${memberId}/risk/diabetes`, {
      token: sess.accessToken, body: { overrides: { activityLevel: 2 } },
    });
    expectStatus(r.status, 200, 'what-if');
    if (r.json.result?.scenarioApplied !== true) throw new Error('scenario not flagged');
  });
  await check('GET /api/members/:id/doctor-summary (audited)', async () => {
    const r = await req('GET', `/api/members/${memberId}/doctor-summary`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'doctor summary');
    if (!Array.isArray(r.json.sections)) throw new Error('no sections');
  });
  await check('GET /api/members/:id/health-score (timeline)', async () => {
    const r = await req('GET', `/api/members/${memberId}/health-score`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'health score');
  });
  await check('GET /api/members/:id/milestones', async () => {
    const r = await req('GET', `/api/members/${memberId}/milestones`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'milestones');
    if (r.json.total !== 5) throw new Error(`expected 5 milestones, got ${r.json.total}`);
  });
  await check('GET /api/members/:id/guidance', async () => {
    const r = await req('GET', `/api/members/${memberId}/guidance`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'guidance');
  });
  await check('GET /api/members/:id/medication-awareness', async () => {
    const r = await req('GET', `/api/members/${memberId}/medication-awareness`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'med awareness');
  });

  // ---------------- reminders ----------------
  let reminderId;
  await check('POST /api/members/:id/reminders', async () => {
    const r = await req('POST', `/api/members/${memberId}/reminders`, {
      token: sess.accessToken,
      body: { kind: 'checkup', title: 'Annual checkup', dueAt: new Date(Date.now() + 86400000).toISOString() },
    });
    expectStatus(r.status, 201, 'create reminder');
    reminderId = r.json.reminder?.id || r.json.id;
  });
  await check('GET /api/members/:id/reminders', async () => {
    const r = await req('GET', `/api/members/${memberId}/reminders`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'list reminders');
  });
  await check('GET /api/members/:id/reminders/due', async () => {
    const r = await req('GET', `/api/members/${memberId}/reminders/due`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'due reminders');
  });
  await check('PATCH /api/reminders/:id', async () => {
    const r = await req('PATCH', `/api/reminders/${reminderId}`, { token: sess.accessToken, body: { status: 'done' } });
    expectStatus(r.status, 200, 'patch reminder');
  });
  await check('DELETE /api/reminders/:id', async () => {
    const r = await req('DELETE', `/api/reminders/${reminderId}`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'delete reminder');
  });

  // ---------------- personal health intelligence engine ----------------
  await check('GET /api/members/:id/intelligence (full package)', async () => {
    const r = await req('GET', `/api/members/${memberId}/intelligence`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'intelligence');
    if (!Array.isArray(r.json.summaryCards)) throw new Error('no summaryCards');
  });
  await check('GET /api/members/:id/intelligence/baseline', async () => {
    const r = await req('GET', `/api/members/${memberId}/intelligence/baseline`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'baseline');
  });
  await check('GET /api/members/:id/intelligence/patterns', async () => {
    const r = await req('GET', `/api/members/${memberId}/intelligence/patterns`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'patterns');
  });
  await check('POST /api/members/:id/intelligence/simulate (counterfactual twin)', async () => {
    const r = await req('POST', `/api/members/${memberId}/intelligence/simulate`, {
      token: sess.accessToken, body: { label: 'lighter+active', changes: { weightKg: 72, activityMinutesPerWeek: 240 } },
    });
    expectStatus(r.status, 200, 'simulate');
  });
  await check('POST /api/members/:id/intelligence/scenarios (explorer)', async () => {
    const r = await req('POST', `/api/members/${memberId}/intelligence/scenarios`, { token: sess.accessToken, body: {} });
    expectStatus(r.status, 200, 'scenarios');
  });
  await check('GET /api/members/:id/intelligence/explanation', async () => {
    const r = await req('GET', `/api/members/${memberId}/intelligence/explanation`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'intelligence explanation');
  });

  // ---------------- Ask the Twin (NEW) ----------------
  await check('POST /api/members/:id/ask — “What changed in my health?”', async () => {
    const r = await req('POST', `/api/members/${memberId}/ask`, {
      token: sess.accessToken, body: { question: 'What has changed in my health over time?' },
    });
    expectStatus(r.status, 200, 'ask changes');
    if (r.json.intent !== 'changes') throw new Error(`intent ${r.json.intent}`);
    if (!r.json.answer) throw new Error('no answer');
  });
  await check('POST /api/members/:id/ask — marker question', async () => {
    const r = await req('POST', `/api/members/${memberId}/ask`, {
      token: sess.accessToken, body: { question: 'How is my HbA1c trending?' },
    });
    expectStatus(r.status, 200, 'ask marker');
    if (r.json.intent !== 'marker') throw new Error(`intent ${r.json.intent}`);
  });
  await check('POST /api/members/:id/ask — diagnosis refusal', async () => {
    const r = await req('POST', `/api/members/${memberId}/ask`, {
      token: sess.accessToken, body: { question: 'Do I have diabetes?' },
    });
    expectStatus(r.status, 200, 'ask diagnosis');
    if (r.json.intent !== 'diagnosis_request') throw new Error(`intent ${r.json.intent}`);
    if (!/cannot diagnose/i.test(r.json.answer)) throw new Error('no refusal');
  });
  await check('POST /api/members/:id/ask — validation (empty question 400)', async () => {
    const r = await req('POST', `/api/members/${memberId}/ask`, { token: sess.accessToken, body: { question: '   ' } });
    expectStatus(r.status, 400, 'empty question');
  });
  await check('GET /api/members/:id/ask/suggestions', async () => {
    const r = await req('GET', `/api/members/${memberId}/ask/suggestions`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'suggestions');
    if (!Array.isArray(r.json.suggestions) || r.json.suggestions.length === 0) throw new Error('no suggestions');
  });

  // ---------------- shares (family access) ----------------
  const viewerEmail = `smoke-viewer+${Date.now()}@medtwin.dev`;
  let viewerSess;
  await check('POST /api/auth/register (viewer account)', async () => {
    const r = await req('POST', '/api/auth/register', { body: { email: viewerEmail, displayName: 'Viewer', password: PASSWORD } });
    expectStatus(r.status, 201, 'viewer register');
    viewerSess = r.json;
  });
  await check('POST /api/members/:id/shares (grant viewer)', async () => {
    const r = await req('POST', `/api/members/${memberId}/shares`, {
      token: sess.accessToken, body: { granteeEmail: viewerEmail, permission: 'viewer' },
    });
    expectStatus(r.status, 201, 'grant share');
  });
  await check('GET /api/members/:id/shares', async () => {
    const r = await req('GET', `/api/members/${memberId}/shares`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'list shares');
    if (!Array.isArray(r.json.items) || r.json.items.length === 0) throw new Error('no shares listed');
  });
  await check('viewer CAN read member (granted)', async () => {
    const r = await req('GET', `/api/members/${memberId}`, { token: viewerSess.accessToken });
    expectStatus(r.status, 200, 'viewer read');
  });
  await check('viewer CANNOT write member (403)', async () => {
    const r = await req('PATCH', `/api/members/${memberId}`, { token: viewerSess.accessToken, body: { name: 'Hacked' } });
    expectStatus(r.status, 403, 'viewer write');
  });
  await check('DELETE /api/members/:id/shares/:uid (revoke)', async () => {
    const shares = await req('GET', `/api/members/${memberId}/shares`, { token: sess.accessToken });
    const grantee = shares.json.items[0].userId;
    const r = await req('DELETE', `/api/members/${memberId}/shares/${grantee}`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'revoke');
  });
  await check('revoked viewer now gets existence-hiding 404', async () => {
    const r = await req('GET', `/api/members/${memberId}`, { token: viewerSess.accessToken });
    expectStatus(r.status, 404, 'revoked');
  });

  // ---------------- privacy (export/delete) — before admin touches accounts ----------------
  await check('GET /api/profile/export (data portability)', async () => {
    const r = await req('GET', '/api/profile/export', { token: viewerSess.accessToken });
    expectStatus(r.status, 200, 'export');
  });
  await check('DELETE /api/profile (account deletion)', async () => {
    const r = await req('DELETE', '/api/profile', { token: viewerSess.accessToken, body: { password: PASSWORD } });
    expectStatus(r.status, 200, 'delete account');
    const me = await req('GET', '/api/auth/me', { token: viewerSess.accessToken });
    expectStatus(me.status, 401, 'token dead after delete');
  });

  // ---------------- admin ----------------
  let adminTok;
  await check('admin login', async () => {
    const r = await req('POST', '/api/auth/login', { body: { email: 'smoke-admin@medtwin.dev', password: PASSWORD } });
    expectStatus(r.status, 200, 'admin login');
    adminTok = r.json.accessToken;
  });
  await check('GET /api/admin/users', async () => {
    const r = await req('GET', '/api/admin/users', { token: adminTok });
    expectStatus(r.status, 200, 'admin users');
    if (!Array.isArray(r.json.items)) throw new Error('no items');
  });
  await check('GET /api/admin/audit (full trail incl. ask.question)', async () => {
    const r = await req('GET', '/api/admin/audit?action=ask.question', { token: adminTok });
    expectStatus(r.status, 200, 'admin audit');
    if (r.json.total < 3) throw new Error(`expected ≥3 ask events, got ${r.json.total}`);
    const meta = typeof r.json.items[0].metadata === 'string' ? JSON.parse(r.json.items[0].metadata) : r.json.items[0].metadata;
    if (JSON.stringify(meta).includes('What has changed')) throw new Error('question text leaked into audit');
  });
  await check('admin CANNOT read member health data (404)', async () => {
    const r = await req('GET', `/api/members/${memberId}`, { token: adminTok });
    expectStatus(r.status, 404, 'admin health access');
  });
  await check('member CANNOT access admin API (403/404)', async () => {
    const r = await req('GET', '/api/admin/users', { token: sess.accessToken });
    if (r.status !== 403 && r.status !== 404) throw new Error(`got ${r.status}`);
  });
  await check('POST /api/admin/users/:uid/status (disable kills sessions, enable restores)', async () => {
    const victimEmail = `smoke-victim+${Date.now()}@medtwin.dev`;
    const reg = await req('POST', '/api/auth/register', { body: { email: victimEmail, displayName: 'Victim', password: PASSWORD } });
    expectStatus(reg.status, 201, 'victim register');
    const off = await req('POST', `/api/admin/users/${reg.json.user.id}/status`, { token: adminTok, body: { status: 'disabled' } });
    expectStatus(off.status, 200, 'disable');
    const me = await req('GET', '/api/auth/me', { token: reg.json.accessToken });
    // disabled account is rejected (401 session-revoked or 403 account-disabled)
    if (me.status !== 401 && me.status !== 403) throw new Error(`disabled user got ${me.status}`);
    const on = await req('POST', `/api/admin/users/${reg.json.user.id}/status`, { token: adminTok, body: { status: 'active' } });
    expectStatus(on.status, 200, 're-enable');
  });

  // ---------------- auth: change password + logouts ----------------
  const NEW_PASSWORD = 'N3w!Passw0rd#Smoke2';
  await check('POST /api/auth/change-password (kills old access tokens)', async () => {
    const r = await req('POST', '/api/auth/change-password', {
      token: sess.accessToken, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expectStatus(r.status, 200, 'change password');
    const me = await req('GET', '/api/auth/me', { token: sess.accessToken });
    expectStatus(me.status, 401, 'old token dead');
    const lg = await req('POST', '/api/auth/login', { body: { email, password: NEW_PASSWORD } });
    expectStatus(lg.status, 200, 'login with new password');
    sess = lg.json;
  });
  await check('POST /api/auth/logout (revokes refresh token)', async () => {
    const r = await req('POST', '/api/auth/logout', { token: sess.accessToken, body: { refreshToken: sess.refreshToken } });
    expectStatus(r.status, 200, 'logout');
    const rf = await req('POST', '/api/auth/refresh', { body: { refreshToken: sess.refreshToken } });
    expectStatus(rf.status, 401, 'refresh dead after logout');
  });
  await check('POST /api/auth/logout-all', async () => {
    const lg = await req('POST', '/api/auth/login', { body: { email, password: NEW_PASSWORD } });
    expectStatus(lg.status, 200, 'login');
    const r = await req('POST', '/api/auth/logout-all', { token: lg.json.accessToken });
    expectStatus(r.status, 200, 'logout-all');
  });

  // ---------------- security probes ----------------
  // (logout-all killed every session above — take a fresh one)
  await check('fresh login for security probes', async () => {
    const lg = await req('POST', '/api/auth/login', { body: { email, password: NEW_PASSWORD } });
    expectStatus(lg.status, 200, 'login');
    sess = lg.json;
  });
  await check('security headers present on /api', async () => {
    const r = await req('GET', '/api/health');
    for (const h of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'strict-transport-security', 'referrer-policy', 'permissions-policy']) {
      if (!r.headers.get(h)) throw new Error(`missing header ${h}`);
    }
    if (!(r.headers.get('cache-control') || '').includes('no-store')) throw new Error('/api is cacheable!');
    if (r.headers.get('x-powered-by')) throw new Error('x-powered-by leaked');
  });
  await check('CORS: evil origin rejected', async () => {
    const r = await fetch(`${BASE}/api/health`, { headers: { origin: 'https://evil.example.com' } });
    if (r.headers.get('access-control-allow-origin')) throw new Error('evil origin was allowed');
  });
  await check('CORS: localhost origin allowed (dev)', async () => {
    const r = await fetch(`${BASE}/api/health`, { headers: { origin: 'http://localhost:3000' } });
    if (r.headers.get('access-control-allow-origin') !== 'http://localhost:3000') throw new Error('localhost not allowed');
  });
  await check('unknown API path → JSON 404 (no stack trace)', async () => {
    const r = await req('GET', '/api/nope/nothing', { token: sess.accessToken });
    expectStatus(r.status, 404, 'unknown path');
    if (r.text.includes('at ')) throw new Error('stack trace leaked');
  });
  await check('SQLi-style memberId → 400 validation, not 500', async () => {
    const r = await req('GET', `/api/members/1'%20OR%20'1'='1/trends`, { token: sess.accessToken });
    if (r.status !== 400 && r.status !== 404) throw new Error(`got ${r.status}`);
  });
  await check('oversized JSON body → 413', async () => {
    const r = await req('POST', `/api/members/${memberId}/ask`, {
      token: sess.accessToken, raw: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expectStatus(r.status, 413, 'oversized');
  });
  await check('existence-hiding: stranger member id → 404', async () => {
    const r = await req('GET', `/api/members/${crypto.randomUUID()}/trends`, { token: sess.accessToken });
    expectStatus(r.status, 404, 'stranger member');
  });

  // ---------------- summary ----------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SMOKE RESULT: ${results.length - failed.length}/${results.length} passed${failed.length ? ` — ${failed.length} FAILED:` : ' — ALL ENDPOINTS OK'}`);
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
  console.log('='.repeat(60));
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    server?.kill('SIGTERM');
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(code);
  })
  .catch((e) => {
    console.error('SMOKE RUNNER ERROR:', e);
    server?.kill('SIGTERM');
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(2);
  });
