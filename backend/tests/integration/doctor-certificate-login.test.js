import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext, auth, STRONG_PASSWORD } from '../helpers.js';

/**
 * Doctor sign-in is gated on the medical council certificate.
 *
 * Two toggles exist on the patient app (patient / doctor) and the doctor side
 * has its own frontend; this file pins the backend contract behind them:
 *
 *   • a doctor session needs the registration number that matches the
 *     certificate on file — a borrowed/mistyped number is refused;
 *   • a certificate that has not been checked leaves the account able to reach
 *     ONLY the verification screen, never a clinical endpoint;
 *   • uploading the certificate runs real checks (number present on the
 *     document, name spotted, file type/size) and the verdict is what opens the
 *     console in demo mode.
 */

const CERT_TEXT = [
  'MEDICAL COUNCIL OF INDIA — DEMO CERTIFICATE',
  'This is to certify that Dr Meera Nair is registered to practise medicine.',
  'Registration No: MCI-556677',
  'Issued: 2019-04-02',
].join('\n');

let ctx, app;

const applyBody = (overrides = {}) => ({
  email: 'dr.cert@mt.test',
  displayName: 'Dr Meera Nair',
  password: STRONG_PASSWORD,
  specialty: 'general_physician',
  registrationNo: 'MCI-556677',
  registrationCouncil: 'MCI',
  consultFeeInr: 300,
  ...overrides,
});

/** multipart apply/upload helper — supertest attaches the text file. */
function withCertificate(req, field, text, filename = 'certificate.txt') {
  return req
    .attach(field, Buffer.from(text, 'utf8'), { filename, contentType: 'text/plain' });
}

beforeAll(() => {
  ctx = makeTestContext();
  app = ctx.app;
});
afterAll(() => ctx.container.close());

describe('doctor sign-in is certificate-gated', () => {
  let doctor; // apply WITH certificate
  let patient; // plain patient account

  it('applies with a certificate: the document is checked and the profile goes live', async () => {
    const res = await withCertificate(
      request(app).post('/api/doctor/apply'),
      'certificate',
      CERT_TEXT,
    ).field(applyBody());

    expect(res.status).toBe(201);
    doctor = res.body;
    expect(res.body.doctor.status).toBe('active');
    expect(res.body.doctor.certificate.status).toBe('verified');
    expect(res.body.doctor.certificate.method).toBe('document_checked');
    expect(res.body.doctor.certificate.ref).toMatch(/^CERT-[0-9A-F]{12}$/);
    expect(res.body.requiresCertificate).toBe(false);
    expect(res.body.doctor.certificate.document.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The document itself is never stored — only its fingerprint.
    expect(JSON.stringify(res.body)).not.toContain('MEDICAL COUNCIL OF INDIA');
  });

  it('refuses a doctor sign-in whose registration number does not match the certificate', async () => {
    const res = await request(app)
      .post('/api/auth/doctor-login')
      .send({ email: 'dr.cert@mt.test', password: STRONG_PASSWORD, registrationNo: 'MCI-000000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('CERTIFICATE_MISMATCH');
  });

  it('accepts the exact registration number (formatting-insensitive) and returns the doctor profile', async () => {
    const res = await request(app)
      .post('/api/auth/doctor-login')
      .send({ email: 'dr.cert@mt.test', password: STRONG_PASSWORD, registrationNo: 'mci 556677' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.doctor.id).toBe(doctor.doctor.id);
    expect(res.body.certificate.status).toBe('verified');

    const overview = await request(app).get('/api/doctor/overview').set(auth(res.body.accessToken));
    expect(overview.status).toBe(200);
  });

  it('keeps patient accounts out of the doctor door', async () => {
    const registered = await request(app).post('/api/auth/register').send({
      email: 'cert-patient@mt.test',
      displayName: 'Cert Patient',
      password: STRONG_PASSWORD,
    });
    patient = registered.body;
    const res = await request(app)
      .post('/api/auth/doctor-login')
      .send({ email: 'cert-patient@mt.test', password: STRONG_PASSWORD, registrationNo: 'MCI-556677' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_A_DOCTOR_ACCOUNT');
  });

  it('gives a doctor without a checked certificate a session that can ONLY verify — never read patients', async () => {
    // A certificate whose text names a different registration number.
    const res = await withCertificate(
      request(app).post('/api/doctor/apply'),
      'certificate',
      CERT_TEXT.replace('MCI-556677', 'MCI-999999'),
    ).field(
      applyBody({ email: 'dr.unchecked@mt.test', displayName: 'Dr Unchecked', registrationNo: 'MCI-112233' }),
    );

    expect(res.status).toBe(201);
    const unchecked = res.body;
    expect(unchecked.doctor.certificate.status).toBe('rejected');
    expect(unchecked.requiresCertificate).toBe(true);
    const failed = unchecked.doctor.certificate.checks.filter((c) => c.blocking && !c.passed);
    expect(failed.map((c) => c.key)).toContain('certificate.number_found');

    const signIn = await request(app)
      .post('/api/auth/doctor-login')
      .send({ email: 'dr.unchecked@mt.test', password: STRONG_PASSWORD, registrationNo: 'MCI-112233' });
    expect(signIn.status).toBe(200);
    expect(signIn.body.requiresCertificate).toBe(true);

    const blocked = await request(app).get('/api/doctor/overview').set(auth(signIn.body.accessToken));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('DOCTOR_ROLE_REQUIRED');

    // The verification screen is reachable, and the right document opens it up.
    const me = await request(app).get('/api/doctor/me').set(auth(signIn.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.certificate.status).toBe('rejected');
    expect(me.body.certificatePolicy.maxBytes).toBeGreaterThan(0);

    const verified = await withCertificate(
      request(app).post('/api/doctor/certificate'),
      'certificate',
      CERT_TEXT.replace('MCI-556677', 'MCI-112233'),
    )
      .set(auth(signIn.body.accessToken))
      .field({ registrationNo: 'MCI-112233' });

    expect(verified.status).toBe(200);
    expect(verified.body.certificate.status).toBe('verified');
    expect(verified.body.activated).toBe(true);

    const overview = await request(app).get('/api/doctor/overview').set(auth(signIn.body.accessToken));
    expect(overview.status).toBe(200);
  });

  it('rejects a certificate upload with no file attached, with guidance', async () => {
    const signIn = await request(app)
      .post('/api/auth/doctor-login')
      .send({ email: 'dr.unchecked@mt.test', password: STRONG_PASSWORD, registrationNo: 'MCI-112233' });
    const res = await request(app)
      .post('/api/doctor/certificate')
      .set(auth(signIn.body.accessToken))
      .field({ registrationNo: 'MCI-112233' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/certificate/i);
  });

  it('does not let a patient session upload a certificate to someone else’s profile', async () => {
    const res = await withCertificate(
      request(app).post('/api/doctor/certificate'),
      'certificate',
      CERT_TEXT,
    ).set(auth(patient.accessToken));
    // No doctor profile on a patient account → 404 (there is nothing to verify into).
    expect([403, 404]).toContain(res.status);
    expect(res.body.error.message).toMatch(/doctor profile/i);
  });

  it('signs in doctors created by the JSON (registration-number) apply too', async () => {
    const applied = await request(app).post('/api/doctor/apply').send(
      applyBody({ email: 'dr.nodoc@mt.test', registrationNo: 'MCI-445566' }),
    );
    expect(applied.status).toBe(201);
    expect(applied.body.doctor.certificate.status).toBe('verified');
    expect(applied.body.doctor.certificate.method).toBe('registration_no_only');

    const res = await request(app)
      .post('/api/auth/doctor-login')
      .send({ email: 'dr.nodoc@mt.test', password: STRONG_PASSWORD, registrationNo: 'MCI-445566' });
    expect(res.status).toBe(200);
    expect(res.body.requiresCertificate).toBe(false);
  });

  it('keeps the session alive on the device for the long haul (30-day refresh window)', () => {
    expect(ctx.container.config.refreshTokenTtlSec).toBe(30 * 24 * 3600);
  });
});
