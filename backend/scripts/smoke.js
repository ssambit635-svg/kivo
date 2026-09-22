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

const BASE_PORT = Number(process.env.SMOKE_PORT || 8091);
// Try BASE_PORT, then fall back to random free ports if busy (CI runners sometimes reuse)
let PORT = BASE_PORT;
let BASE = `http://127.0.0.1:${PORT}`;
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

  // Try up to 3 ports: 8091, 8092, random
  const portsToTry = [PORT, 8092, 8093, 0];
  let lastErr = null;
  for (const tryPort of portsToTry) {
    const actualPort = tryPort === 0 ? Math.floor(10000 + Math.random() * 50000) : tryPort;
    PORT = actualPort;
    BASE = `http://127.0.0.1:${PORT}`;
    server = spawn('node', ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
      // REFRESH_GRACE_SEC=0 puts refresh back in strict-theft mode: the reuse
      // checks below replay a rotated token SEQUENTIALLY (which the grace
      // window would rightly forgive as a benign multi-tab race). The grace
      // behavior itself is covered by tests/integration/auth.test.js.
      env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, UPLOAD_DIR: uploadDir, JWT_SECRET, NODE_ENV: 'development', REFRESH_GRACE_SEC: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

    let healthy = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) { healthy = true; break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (healthy) {
      console.log(`smoke server healthy on ${BASE}`);
      return;
    }
    // kill and try next
    try { server.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    lastErr = `port ${actualPort} not healthy`;
  }
  throw new Error(`server did not become healthy in 15s (tried ports, last: ${lastErr})`);
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
  // The Care tab is a separate file pair on purpose: a silent 404 here would
  // strip the whole subscription/consultation UI out of the patient app.
  await check('GET /app/care.js (Care tab module served)', async () => {
    const r = await req('GET', '/app/care.js');
    expectStatus(r.status, 200, 'care.js');
    if (!r.text.includes('MtApp')) throw new Error('care.js does not bind to the shell bridge');
  });
  await check('GET /app/care.css (Care tab styles served)', async () => {
    const r = await req('GET', '/app/care.css');
    expectStatus(r.status, 200, 'care.css');
  });
  // The mobile surface: a phone judge taps /m/ and the APK button. A silent
  // 404 here is a dead button on stage, so both are probed end-to-end.
  await check('GET /m/ (legacy APK opens real login)', async () => {
    const r = await req('GET', '/m/');
    expectStatus(r.status, 200, 'mobile app');
    if (!r.text.includes('id="auth-form"')) throw new Error('real login markup missing');
    if (!r.headers.get('content-security-policy')) throw new Error('no CSP on /m/');
  });
  await check('GET /m/mobile.js (mobile logic served)', async () => {
    const r = await req('GET', '/m/mobile.js');
    expectStatus(r.status, 200, 'mobile.js');
    if (!r.text.includes("location.replace('/app/')")) throw new Error('legacy mobile entry does not forward to the real app');
  });
  await check('GET /download/apk (installer served as an attachment)', async () => {
    const r = await req('GET', '/download/apk');
    expectStatus(r.status, 200, 'apk');
    if (!(r.headers.get('content-type') || '').includes('vnd.android.package-archive')) throw new Error('wrong content-type');
    if (!(r.headers.get('content-disposition') || '').includes('attachment')) throw new Error('not an attachment');
    if (r.text.length < 1000) throw new Error('apk body looks empty');
  });
  await check('GET /kivo.apk (installer alias)', async () => {
    const r = await req('GET', '/kivo.apk');
    expectStatus(r.status, 200, 'apk alias');
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

  // ---------------- care network: subscriptions + doctor console + shorts ----------------
  let doctorTok, doctorId, doctorEmail, doctorRegNo, careConsultationId, careVideoId, carePaidVideoId;
  await check('GET /api/public/plans (mock billing catalog)', async () => {
    const r = await req('GET', '/api/public/plans');
    expectStatus(r.status, 200, 'plans');
    if (!r.json.plans.some((p) => p.code === 'care_monthly')) throw new Error('care plan missing');
    if (r.json.billing.mode !== 'mock') throw new Error('billing not marked mock');
    return `${r.json.plans.length} plans`;
  });
  await check('GET /doctor/doctor.js (console module served)', async () => {
    const r = await req('GET', '/doctor/doctor.js');
    expectStatus(r.status, 200, 'doctor.js');
    if (!r.text.includes('mt.doctor.tokens')) throw new Error('doctor.js is not the console module');
  });
  await check('GET /doctor/ (doctor console served)', async () => {
    const r = await req('GET', '/doctor/');
    expectStatus(r.status, 200, 'doctor console');
    if (!r.text.includes('<html')) throw new Error('no html');
  });
  await check('POST /api/doctor/apply (registration-number certificate check + doctor role)', async () => {
    doctorEmail = `dr.smoke+${Date.now()}@medtwin.dev`;
    doctorRegNo = `MCI-SMOKE-${Date.now()}`;
    const r = await req('POST', '/api/doctor/apply', {
      body: {
        email: doctorEmail,
        displayName: 'Dr Smoke Charan',
        password: PASSWORD,
        specialty: 'orthopaedics',
        headline: 'Bone & joint specialist',
        registrationNo: doctorRegNo,
        experienceYears: 11,
        city: 'Pune',
        consultFeeInr: 400,
        qualifications: ['MBBS', 'MS Ortho'],
      },
    });
    expectStatus(r.status, 201, 'doctor apply');
    doctorTok = r.json.accessToken;
    doctorId = r.json.doctor.id;
    if (!r.json.user.roles.includes('doctor')) throw new Error('role not granted');
    if (r.json.doctor.kyc.status !== 'mock_verified') throw new Error('kyc not mock-verified');
    if (r.json.doctor.certificate.status !== 'verified') throw new Error('certificate not verified');
    if (r.json.requiresCertificate !== false) throw new Error('requiresCertificate should be false');
  });
  await check('POST /api/auth/doctor-login (registration number must match the certificate on file)', async () => {
    const ok = await req('POST', '/api/auth/doctor-login', {
      body: { email: doctorEmail, password: PASSWORD, registrationNo: doctorRegNo },
    });
    expectStatus(ok.status, 200, 'doctor login');
    if (ok.json.doctor?.id !== doctorId) throw new Error('wrong doctor profile');
    if (ok.json.requiresCertificate !== false) throw new Error('certificate flag wrong');

    const bad = await req('POST', '/api/auth/doctor-login', {
      body: { email: doctorEmail, password: PASSWORD, registrationNo: 'MCI-000000' },
    });
    expectStatus(bad.status, 401, 'wrong registration number');
    if (bad.json?.error?.code !== 'CERTIFICATE_MISMATCH') throw new Error(`code ${bad.json?.error?.code}`);

    const notDoctor = await req('POST', '/api/auth/doctor-login', {
      body: { email, password: NEW_PASSWORD, registrationNo: doctorRegNo },
    });
    expectStatus(notDoctor.status, 403, 'patient at the doctor door');
    if (notDoctor.json?.error?.code !== 'NOT_A_DOCTOR_ACCOUNT') throw new Error(`code ${notDoctor.json?.error?.code}`);

    const noReg = await req('POST', '/api/auth/doctor-login', {
      body: { email: doctorEmail, password: PASSWORD },
    });
    expectStatus(noReg.status, 400, 'registration number is required');
  });
  await check('POST /api/doctor/certificate (document read; only its sha256 is kept)', async () => {
    const certText = [
      'MEDICAL COUNCIL OF INDIA — SMOKE FIXTURE',
      'This is to certify that Dr Smoke Charan is registered to practise medicine.',
      `Registration No: ${doctorRegNo}`,
    ].join('\n');
    const form = new FormData();
    form.append('certificate', new Blob([certText], { type: 'text/plain' }), 'certificate.txt');
    const r = await req('POST', '/api/doctor/certificate', { token: doctorTok, body: form, raw: true });
    expectStatus(r.status, 200, 'certificate upload');
    if (r.json.certificate.status !== 'verified') throw new Error(`status ${r.json.certificate.status}`);
    if (r.json.certificate.method !== 'document_checked') throw new Error('method not document_checked');
    if (!/^CERT-[0-9A-F]{12}$/.test(r.json.certificate.ref)) throw new Error('bad certificate ref');
    if (!/^[0-9a-f]{64}$/.test(r.json.certificate.document?.sha256 || '')) throw new Error('no document fingerprint');
    if (JSON.stringify(r.json).includes('MEDICAL COUNCIL')) throw new Error('certificate text echoed back');
  });
  await check('GET /api/doctor/overview', async () => {
    const r = await req('GET', '/api/doctor/overview', { token: doctorTok });
    expectStatus(r.status, 200, 'overview');
    if (r.json.doctor.specialty !== 'orthopaedics') throw new Error('wrong specialty');
  });
  await check('RBAC: doctor account blocked from the patient API', async () => {
    const r = await req('GET', '/api/members', { token: doctorTok });
    expectStatus(r.status, 403, 'doctor on patient api');
    if (r.json?.error?.code !== 'DOCTOR_ACCOUNT') throw new Error(`code ${r.json?.error?.code}`);
  });
  await check('RBAC: patient blocked from the doctor console', async () => {
    const r = await req('GET', '/api/doctor/overview', { token: sess.accessToken });
    expectStatus(r.status, 403, 'patient on doctor api');
    if (r.json?.error?.code !== 'DOCTOR_ROLE_REQUIRED') throw new Error(`code ${r.json?.error?.code}`);
  });
  await check('POST /api/doctor/videos (preview short)', async () => {
    const r = await req('POST', '/api/doctor/videos', {
      token: doctorTok,
      body: {
        title: 'Knee pain: three red flags',
        summary: 'When a knee needs a scan.',
        topic: 'orthopaedics',
        durationSec: 48,
        keyPoints: ['Swelling that persists', 'Locking', 'Night pain'],
        isPreview: true,
      },
    });
    expectStatus(r.status, 201, 'publish');
    careVideoId = r.json.video.id;
  });
  await check('content claim-lint rejects "guaranteed cure"', async () => {
    const r = await req('POST', '/api/doctor/videos', {
      token: doctorTok,
      body: { title: 'Guaranteed cure for arthritis', topic: 'orthopaedics' },
    });
    expectStatus(r.status, 400, 'claim lint');
    if (!r.json.error.details.some((d) => d.code === 'CLAIM_LINT')) throw new Error('no CLAIM_LINT detail');
  });
  await check('POST /api/doctor/videos (paid short)', async () => {
    const r = await req('POST', '/api/doctor/videos', {
      token: doctorTok,
      body: { title: 'ACL recovery week by week', topic: 'orthopaedics', durationSec: 90 },
    });
    expectStatus(r.status, 201, 'publish paid');
    carePaidVideoId = r.json.video.id;
  });
  await check('GET /api/care/videos (paid short locked for free patient)', async () => {
    const r = await req('GET', '/api/care/videos', { token: sess.accessToken });
    expectStatus(r.status, 200, 'feed');
    const paid = r.json.items.find((v) => v.id === carePaidVideoId);
    if (!paid?.locked) throw new Error('paid short not locked');
  });
  await check('paywall: playback of a paid short → 402', async () => {
    const r = await req('POST', `/api/care/videos/${carePaidVideoId}/playback`, { token: sess.accessToken, body: {} });
    expectStatus(r.status, 402, 'paywall');
    if (r.json?.error?.code !== 'SUBSCRIPTION_REQUIRED') throw new Error(`code ${r.json?.error?.code}`);
  });
  await check('POST /api/care/subscription (mock payment activates Care+)', async () => {
    const r = await req('POST', '/api/care/subscription', { token: sess.accessToken, body: { planCode: 'care_monthly', method: 'upi' } });
    expectStatus(r.status, 201, 'subscribe');
    if (r.json.payment.mode !== 'mock') throw new Error('not mock');
    if (r.json.entitlements.videoAccess !== 'full') throw new Error('entitlements not upgraded');
    if (JSON.stringify(r.json.payment).match(/cardNumber|cvv|vpaId/i)) throw new Error('credential-ish field present');
  });
  await check('GET /api/care/entitlements (plan quota)', async () => {
    const r = await req('GET', '/api/care/entitlements', { token: sess.accessToken });
    expectStatus(r.status, 200, 'entitlements');
    if (r.json.entitlements.consultationsRemaining !== 4) throw new Error(`remaining ${r.json.entitlements.consultationsRemaining}`);
  });
  await check('playback + watch tracking after subscribing', async () => {
    const p = await req('POST', `/api/care/videos/${carePaidVideoId}/playback`, { token: sess.accessToken, body: {} });
    expectStatus(p.status, 200, 'playback');
    const w = await req('POST', `/api/care/videos/${carePaidVideoId}/views`, { token: sess.accessToken, body: { secondsWatched: 45 } });
    expectStatus(w.status, 200, 'watch');
    if (w.json.secondsWatched !== 45) throw new Error('watch not recorded');
  });
  await check('POST /api/care/consultations (plan-funded consult)', async () => {
    const r = await req('POST', '/api/care/consultations', {
      token: sess.accessToken,
      body: {
        memberId,
        doctorId,
        subject: 'Knee pain for three weeks',
        question: 'My knee hurts when climbing stairs for three weeks. Do I need an X-ray?',
        shareHealthData: true,
      },
    });
    expectStatus(r.status, 201, 'book');
    if (!r.json.consultation.includedInPlan) throw new Error('not plan-funded');
    if (r.json.payment !== null) throw new Error('plan-funded consult asked for payment');
    careConsultationId = r.json.consultation.id;
  });
  await check('GET /api/doctor/consultations (inbox with consent grant)', async () => {
    const r = await req('GET', '/api/doctor/consultations', { token: doctorTok });
    expectStatus(r.status, 200, 'inbox');
    if (!r.json.items.some((c) => c.id === careConsultationId && c.chartAccess.granted)) {
      throw new Error('consultation missing or no chart access');
    }
  });
  await check('GET /api/doctor/consultations/:id (one-screen clinical brief)', async () => {
    const r = await req('GET', `/api/doctor/consultations/${careConsultationId}`, { token: doctorTok });
    expectStatus(r.status, 200, 'detail');
    if (!r.json.brief) throw new Error('no brief');
    if (!r.json.summaryLine.problemCount) throw new Error('brief has no problems');
    if (!r.json.brief.gapsToAsk.length) throw new Error('no gap list');
  });
  await check('POST /api/doctor/consultations/:id/medicine-draft (AI draft, no doses)', async () => {
    const r = await req('POST', `/api/doctor/consultations/${careConsultationId}/medicine-draft`, { token: doctorTok, body: {} });
    expectStatus(r.status, 200, 'draft');
    if (!r.json.medicinePlan.aiDraft.aiGenerated) throw new Error('not flagged AI-generated');
    if (r.json.medicinePlan.aiDraft.patientVisible) throw new Error('draft marked patient-visible');
  });
  await check('medicine approval is blocked without the safety checklist', async () => {
    const r = await req('POST', `/api/doctor/consultations/${careConsultationId}/medicine-plan/approve`, {
      token: doctorTok,
      body: { items: [{ code: 'ldl', decision: 'edit' }], acknowledgements: ['allergies'] },
    });
    expectStatus(r.status, 400, 'ack gate');
  });
  await check('POST …/medicine-plan/approve (doctor approves edit)', async () => {
    const r = await req('POST', `/api/doctor/consultations/${careConsultationId}/medicine-plan/approve`, {
      token: doctorTok,
      body: {
        items: [{ code: 'ldl', decision: 'edit', product: 'Statin class (as discussed)', instructions: 'Night dose; recheck lipids in 12 weeks' }],
        doctorNote: 'Lifestyle first; medicine only if lipids stay high at review.',
        acknowledgements: ['allergies', 'interactions', 'organ_function', 'dose_omitted'],
      },
    });
    expectStatus(r.status, 200, 'approve');
    if (r.json.medicinePlan.status !== 'approved') throw new Error('not approved');
  });
  await check('POST /api/doctor/consultations/:id/reply (with attached short)', async () => {
    const r = await req('POST', `/api/doctor/consultations/${careConsultationId}/reply`, {
      token: doctorTok,
      body: { body: 'X-ray is not needed yet — start loading advice and review in two weeks.', videoIds: [carePaidVideoId] },
    });
    expectStatus(r.status, 201, 'reply');
    if (r.json.consultation.status !== 'answered') throw new Error('status not answered');
  });
  await check('GET /api/care/consultations/:id (patient sees reply + plan + shorts)', async () => {
    const r = await req('GET', `/api/care/consultations/${careConsultationId}`, { token: sess.accessToken });
    expectStatus(r.status, 200, 'patient view');
    if (!r.json.doctorReply) throw new Error('no reply');
    if (r.json.medicinePlan?.status !== 'approved') throw new Error('approved plan not visible');
    if (!r.json.recommendedVideos.length) throw new Error('no recommended shorts');
  });
  await check('consent revocation immediately blocks the doctor', async () => {
    const revoke = await req('POST', `/api/care/consultations/${careConsultationId}/consent/revoke`, { token: sess.accessToken, body: {} });
    expectStatus(revoke.status, 200, 'revoke');
    const after = await req('GET', `/api/doctor/consultations/${careConsultationId}`, { token: doctorTok });
    expectStatus(after.status, 200, 'after revoke');
    if (after.json.brief !== null) throw new Error('brief still served after revocation');
    const reply = await req('POST', `/api/doctor/consultations/${careConsultationId}/reply`, { token: doctorTok, body: { body: 'One more thing to check.' } });
    expectStatus(reply.status, 403, 'reply after revoke');
    if (reply.json?.error?.code !== 'CONSENT_REQUIRED') throw new Error(`code ${reply.json?.error?.code}`);
  });
  await check('GET /api/doctor/earnings (split arithmetic, demo ledger)', async () => {
    const r = await req('GET', '/api/doctor/earnings', { token: doctorTok });
    expectStatus(r.status, 200, 'earnings');
    if (r.json.totals.consultationSharePaise !== 28000) throw new Error(`consult share ${r.json.totals.consultationSharePaise}`);
    if (r.json.pools.shorts.accrualPaise !== 4975) throw new Error(`pool ${r.json.pools.shorts.accrualPaise}`);
    if (r.json.payoutNote.search(/demo ledger/i) === -1) throw new Error('missing demo payout note');
    return `₹${r.json.totals.totalInr} this period`;
  });
  await check('GET /api/admin/doctors (verification queue)', async () => {
    const r = await req('GET', '/api/admin/doctors', { token: adminTok });
    expectStatus(r.status, 200, 'admin doctors');
    if (r.json.total < 1) throw new Error('no doctors listed');
  });
  await check('POST /api/admin/payouts/settle (idempotent)', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const r = await req('POST', '/api/admin/payouts/settle', { token: adminTok, body: { period } });
    expectStatus(r.status, 200, 'settle');
    if (r.json.result.settled) throw new Error('pool settled twice');
  });
  await check('GET /api/media/videos/:id (tampered signature → 403)', async () => {
    const r = await req('GET', `/api/media/videos/${carePaidVideoId}?v=1&uid=someone&exp=9999999999&sig=deadbeef`);
    expectStatus(r.status, 403, 'bad signature');
    if (r.json?.error?.code !== 'PLAYBACK_LINK_INVALID') throw new Error(`code ${r.json?.error?.code}`);
  });
  await check('GET /api/public/doctors?specialty=orthopaedics (public directory)', async () => {
    const r = await req('GET', '/api/public/doctors?specialty=orthopaedics');
    expectStatus(r.status, 200, 'directory');
    if (!r.json.items.length) throw new Error('no doctors');
    if (r.json.verification.mode !== 'mock') throw new Error('verification not labelled mock');
  });

  // ---------------- summary ----------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SMOKE RESULT: ${results.length - failed.length}/${results.length} passed${failed.length ? ` — ${failed.length} FAILED:` : ' — ALL ENDPOINTS OK'}`);
  for (const f of failed) console.log(`  FAIL: ${f.name} — ${f.detail}`);
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
