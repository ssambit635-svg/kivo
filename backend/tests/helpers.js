import { Container } from '../src/container/Container.js';
import { Config } from '../src/config/Config.js';
import { createApp } from '../src/app.js';

export const STRONG_PASSWORD = 'Str0ng!Passw0rd#2026';

/**
 * Build a fresh app+container per test file (in-memory DB, low scrypt cost).
 * `ocrService` can be overridden to inject a deterministic OCR provider — the
 * real Tesseract provider needs vendored language data, so image-path tests
 * inject a stand-in OCR *engine* while still exercising the genuine
 * ingest → extract → verify → trend pipeline.
 */
export function makeTestContext(configOverrides = {}, { ocrService = null } = {}) {
  const config = new Config({ NODE_ENV: 'test', JWT_SECRET: 'test-secret-not-for-prod', ...configOverrides });
  const container = new Container({ config, ocrService });
  const app = createApp(container);
  return { config, container, app };
}

/** Register a user through the real API and return { tokens, agent-friendly helpers }. */
export async function registerUser(request, app, { email, displayName = 'Test User', password = STRONG_PASSWORD } = {}) {
  const res = await request(app).post('/api/auth/register').send({ email, displayName, password });
  if (res.status !== 201) {
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body; // { accessToken, refreshToken, user, ... }
}

export async function login(request, app, email, password) {
  return request(app).post('/api/auth/login').send({ email, password });
}

export function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

/** Create an admin directly at the repository level (roles never come from the API). */
export function makeAdmin(container, request, app, { email = 'admin@mt.test', password = STRONG_PASSWORD } = {}) {
  const passwordHash = container.passwordService.hash(password);
  const user = container.userRepository.create({ email, displayName: 'Admin', passwordHash, role: 'admin' });
  container.memberRepository.create({ userId: user.id, name: 'Admin', relationship: 'self' });
  return login(request, app, email, password).then((r) => r.body);
}

/** Realistic demo blood-report text used by extraction/report tests. */
export const SAMPLE_REPORT_TEXT = [
  'CITY DIAGNOSTICS CENTER - DEMO LAB',
  'Patient: DEMO USER                  Age/Gender: 42/M',
  'Report Date: 12-03-2026',
  'Regn No: 99977                       Sample Type: EDTA WHOLE BLOOD',
  '--------------------------------------------------------------',
  'Test                        Result       Unit          Reference Range',
  '--------------------------------------------------------------',
  'HbA1c                       5.9          %             (4.0 - 5.6)',
  'Fasting Blood Sugar         108          mg/dL         70 - 100',
  'Total Cholesterol           214          mg/dL         Reference: <200',
  'HDL Cholesterol             42           mg/dL         (40 - 60)',
  'LDL Cholesterol             138          mg/dL         (50 - 100)',
  'Triglycerides               190          mg/dL         (30 - 150)',
  'Hemoglobin                  13.4         g/dL          (12 - 16)',
  'Creatinine                  1.1          mg/dL         (0.7 - 1.3)',
  'TSH                         2.4          uIU/mL        (0.4 - 4.0)',
  '----- END OF REPORT -----',
].join('\n');

/** A second report ~1 year later with worse metabolic numbers. */
export const SAMPLE_REPORT_TEXT_R2 = [
  'CITY DIAGNOSTICS CENTER - DEMO LAB',
  'Patient: DEMO USER',
  'Report Date: 10-03-2025',
  'Test                        Result       Unit          Reference Range',
  'HbA1c                       5.4          %             (4.0 - 5.6)',
  'Fasting Blood Sugar         92           mg/dL         70 - 100',
  'Total Cholesterol           182          mg/dL         Reference: <200',
  'Triglycerides               121          mg/dL         (30 - 150)',
  '----- END OF REPORT -----',
].join('\n');

/** Ingest + verify a text report via the API. Returns created report id. */
export async function ingestAndVerify(request, app, accessToken, memberId, text, reportDate = null) {
  const ingestRes = await request(app)
    .post(`/api/members/${memberId}/reports`)
    .set(auth(accessToken))
    .send({ text, reportDate });
  if (ingestRes.status !== 201) throw new Error(`ingest failed: ${ingestRes.status} ${JSON.stringify(ingestRes.body)}`);
  const reportId = ingestRes.body.report.id;
  const verifyRes = await request(app)
    .post(`/api/reports/${reportId}/verify`)
    .set(auth(accessToken))
    .send({});
  if (verifyRes.status !== 200) throw new Error(`verify failed: ${verifyRes.status} ${JSON.stringify(verifyRes.body)}`);
  return { reportId, ingestBody: ingestRes.body };
}
