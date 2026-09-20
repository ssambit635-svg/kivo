// Read-only demo journey against the APK's configured cloud. Never print tokens.
// Run explicitly or from the Android workflow, not the offline unit suite.
import fs from 'node:fs';
const file = new URL('../../android/default-server.txt', import.meta.url);
const base = new URL(fs.readFileSync(file, 'utf8').split(/\r?\n/).find(s => s.trim() && !s.trim().startsWith('#')).trim()).origin;
async function call(path, options = {}) {
  const res = await fetch(base + path, { ...options, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}
let awake = false;
for (let attempt = 1; attempt <= 4; attempt++) {
  try {
    const health = await call('/api/health');
    if (health.status !== 'ok') throw new Error('unexpected health response');
    awake = true;
    break;
  } catch (e) {
    console.log(`Cloud readiness attempt ${attempt}: ${e.message}`);
    if (attempt < 4) await new Promise(r => setTimeout(r, 5000));
  }
}
if (!awake) throw new Error('Cloud unavailable. Bundled login works, but live features cannot be verified.');
const session = await call('/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'demo@kivo.dev', password: 'Kivo!Demo#2026' }),
});
try {
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const { owned } = await call('/api/members', { headers });
  if (!owned?.length) throw new Error('Demo has no member');
  await call(`/api/members/${owned[0].id}/reports`, { headers });
  await call('/api/care/entitlements', { headers });
  console.log('CLOUD PASSED: health, patient login, member, reports, Care entitlements');
} finally {
  await call('/api/auth/logout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
}
