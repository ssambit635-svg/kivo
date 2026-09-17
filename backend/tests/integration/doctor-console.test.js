import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext, registerUser, auth, STRONG_PASSWORD, SAMPLE_REPORT_TEXT, ingestAndVerify } from '../helpers.js';

/**
 * The doctor console end-to-end: role onboarding, RBAC walls, the one-screen
 * clinical brief behind scoped consent, the AI medicine draft that only a
 * doctor can approve, and the earnings statement.
 */

let ctx, patient, memberId, doctor, doctorId, otherDoctor, otherDoctorId, consultationId;

beforeAll(async () => {
  ctx = makeTestContext();
  patient = await registerUser(request, ctx.app, { email: 'dc-patient@mt.test', displayName: 'DC Patient' });
  const members = await request(ctx.app).get('/api/members').set(auth(patient.accessToken));
  memberId = members.body.owned.find((m) => m.relationship === 'self').id;

  // A 42-year-old man with a verified metabolic report → the brief and the
  // medicine draft both have something real to work with.
  await request(ctx.app)
    .patch(`/api/members/${memberId}`)
    .set(auth(patient.accessToken))
    .send({ dob: '1984-02-02', sex: 'male', heightCm: 174, familyHistory: { diabetes: 'mother' } });
  await ingestAndVerify(request, ctx.app, patient.accessToken, memberId, SAMPLE_REPORT_TEXT, '2026-03-12');
  await request(ctx.app)
    .post(`/api/members/${memberId}/observations`)
    .set(auth(patient.accessToken))
    .send({ kind: 'medication', payload: { name: 'Atorvastatin', dose: '10 mg' } });
  await request(ctx.app)
    .post(`/api/members/${memberId}/observations`)
    .set(auth(patient.accessToken))
    .send({ kind: 'bp', payload: { systolic: 138, diastolic: 88 } });

  const applied = await request(ctx.app).post('/api/doctor/apply').send({
    email: 'dr.mohan@mt.test',
    displayName: 'Dr Mohan Charan',
    password: 'Str0ng!Passw0rd#2026',
    specialty: 'orthopaedics',
    headline: 'Bone & joint specialist',
    registrationNo: 'MCI-778812',
    experienceYears: 14,
    city: 'Pune',
    consultFeeInr: 400,
    qualifications: ['MBBS', 'MS Ortho'],
  });
  doctor = applied.body;
  doctorId = applied.body.doctor.id;

  const second = await request(ctx.app).post('/api/doctor/apply').send({
    email: 'dr.second@mt.test',
    displayName: 'Dr Second Opinion',
    password: 'Str0ng!Passw0rd#2026',
    specialty: 'general_physician',
    registrationNo: 'MCI-778813',
    consultFeeInr: 250,
  });
  otherDoctor = second.body;
  otherDoctorId = second.body.doctor.id;
});
afterAll(() => ctx.container.close());

describe('doctor onboarding + RBAC', () => {
  it('creates a doctor account with a granted role and a mock-KYC badge — never self-declared', async () => {
    const me = await request(ctx.app).get('/api/auth/me').set(auth(doctor.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.user.roles).toContain('doctor');
    expect(me.body.user.accountType).toBe('doctor');

    const profile = await request(ctx.app).get('/api/doctor/me').set(auth(doctor.accessToken));
    expect(profile.body.doctor.status).toBe('active');
    expect(profile.body.doctor.kyc.status).toBe('mock_verified');
    expect(profile.body.doctor.kyc.ref).toMatch(/^MOCK-KYC-/);
    expect(profile.body.doctor.identityCardNo).toMatch(/^MT-DOC-/);
  });

  it('gives the doctor account no health twin to hide behind', async () => {
    const members = await request(ctx.app).get('/api/members').set(auth(doctor.accessToken));
    expect(members.status).toBe(403);
    expect(members.body.error.code).toBe('DOCTOR_ACCOUNT');
  });

  it('keeps patients out of the doctor console', async () => {
    const res = await request(ctx.app).get('/api/doctor/overview').set(auth(patient.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DOCTOR_ROLE_REQUIRED');
  });

  it('rejects duplicate registration numbers and duplicate emails', async () => {
    const dupReg = await request(ctx.app).post('/api/doctor/apply').send({
      email: 'dup-reg@mt.test',
      displayName: 'Dr Dup',
      password: 'Str0ng!Passw0rd#2026',
      specialty: 'cardiology',
      registrationNo: 'MCI-778812',
    });
    expect(dupReg.status).toBe(409);
    expect(dupReg.body.error.code).toBe('REGISTRATION_IN_USE');

    const dupEmail = await request(ctx.app).post('/api/doctor/apply').send({
      email: 'dr.mohan@mt.test',
      displayName: 'Dr Email Dup',
      password: 'Str0ng!Passw0rd#2026',
      specialty: 'cardiology',
      registrationNo: 'MCI-999999',
    });
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.error.code).toBe('EMAIL_IN_USE');
  });

  it('publishes a public identity card that never leaks the internal user id', async () => {
    const card = await request(ctx.app).get('/api/doctor/identity-card').set(auth(doctor.accessToken));
    expect(card.status).toBe(200);
    expect(card.body.card.verificationMode).toBe('mock');
    expect(card.body.card.headline).toBe('Bone & joint specialist');

    const pub = await request(ctx.app).get(`/api/public/doctors/${card.body.card.slug}`);
    expect(pub.status).toBe(200);
    expect(pub.body.doctor.headline).toBe('Bone & joint specialist');
    expect(pub.body.doctor).not.toHaveProperty('userId');
    expect(JSON.stringify(pub.body)).not.toMatch(/password|registrationNo"/);
  });
});

describe('consultation: brief behind consent, AI draft, doctor approval', () => {
  it('books a plan-funded consultation once the patient subscribes', async () => {
    await request(ctx.app)
      .post('/api/care/subscription')
      .set(auth(patient.accessToken))
      .send({ planCode: 'care_monthly' });

    const res = await request(ctx.app)
      .post('/api/care/consultations')
      .set(auth(patient.accessToken))
      .send({
        memberId,
        doctorId,
        subject: 'Knee pain for three weeks',
        question: 'My right knee hurts going up stairs for three weeks. Do I need an X-ray or can this wait?',
        shareHealthData: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.consultation.includedInPlan).toBe(true);
    expect(res.body.payment).toBeNull();
    expect(res.body.consultation.status).toBe('requested');
    expect(res.body.consultation.consent.scope).toContain('labs');
    consultationId = res.body.consultation.id;
  });

  it('shows the doctor a one-screen brief compiled from verified data only', async () => {
    const res = await request(ctx.app)
      .get(`/api/doctor/consultations/${consultationId}`)
      .set(auth(doctor.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.chartAccess.granted).toBe(true);
    const brief = res.body.brief;
    expect(brief).toBeTruthy();
    expect(brief.provenance.rule).toMatch(/OCR drafts/i);
    expect(brief.activeProblems.length).toBeGreaterThan(0);
    expect(brief.vitals.bp.systolic).toBe(138);
    expect(brief.medications.map((m) => m.name)).toContain('Atorvastatin');
    expect(brief.gapsToAsk.length).toBeGreaterThan(0);
    expect(brief.gapsToAsk.length).toBeLessThanOrEqual(6);
    // The brief must not carry the patient's account identity.
    expect(JSON.stringify(brief)).not.toMatch(/@mt\.test/);
  });

  it('blocks another doctor from reading the consultation at all', async () => {
    const res = await request(ctx.app)
      .get(`/api/doctor/consultations/${consultationId}`)
      .set(auth(otherDoctor.accessToken));
    expect(res.status).toBe(404);
  });

  it('generates an AI medicine draft with no doses and no patient-visible content', async () => {
    const res = await request(ctx.app)
      .post(`/api/doctor/consultations/${consultationId}/medicine-draft`)
      .set(auth(doctor.accessToken))
      .send({});
    expect(res.status).toBe(200);
    const draft = res.body.medicinePlan.aiDraft;
    expect(draft.aiGenerated).toBe(true);
    expect(draft.requiresDoctorApproval).toBe(true);
    expect(draft.patientVisible).toBe(false);
    expect(draft.dataBasis.note).toMatch(/verified values only/i);
    const serialized = JSON.stringify(draft);
    expect(serialized).not.toMatch(/\d+\s?mg/gi);
    const items = draft.items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.doseIncluded).toBe(false);
      expect(item.rationale).toBeTruthy();
      expect(item.cautions.length).toBeGreaterThan(0);
    }

    // the patient must not see the draft yet
    const mine = await request(ctx.app)
      .get(`/api/care/consultations/${consultationId}`)
      .set(auth(patient.accessToken));
    expect(mine.body.medicinePlan).toBeNull();
  });

  it('refuses to approve without the full safety checklist', async () => {
    const res = await request(ctx.app)
      .post(`/api/doctor/consultations/${consultationId}/medicine-plan/approve`)
      .set(auth(doctor.accessToken))
      .send({ items: [{ code: 'ldl', decision: 'edit' }], acknowledgements: ['allergies'] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.code)).toContain('ACK_REQUIRED');
  });

  it('lets the doctor edit + approve, and then — only then — the patient sees it', async () => {
    const approve = await request(ctx.app)
      .post(`/api/doctor/consultations/${consultationId}/medicine-plan/approve`)
      .set(auth(doctor.accessToken))
      .send({
        items: [
          { code: 'ldl', decision: 'edit', product: 'Statin class (as discussed)', instructions: 'Night dose; recheck lipids in 12 weeks' },
          { code: 'uric_acid', decision: 'skip' },
        ],
        doctorNote: 'Lifestyle first, medicine only if lipids stay high at review.',
        acknowledgements: ['allergies', 'interactions', 'organ_function', 'dose_omitted'],
      });
    expect(approve.status).toBe(200);
    expect(approve.body.medicinePlan.status).toBe('approved');
    expect(approve.body.medicinePlan.finalItems).toHaveLength(1);

    const mine = await request(ctx.app)
      .get(`/api/care/consultations/${consultationId}`)
      .set(auth(patient.accessToken));
    expect(mine.body.medicinePlan.status).toBe('approved');
    expect(mine.body.medicinePlan.items).toHaveLength(1);
    // Clinical scaffolding (AI rationale, follow-up codes) stays internal.
    expect(mine.body.medicinePlan.items[0]).not.toHaveProperty('rationale');
    expect(mine.body.medicinePlan.items[0]).not.toHaveProperty('exampleAgents');
  });

  it('replies and attaches a short, then answers the patient thread', async () => {
    const video = await request(ctx.app)
      .post('/api/doctor/videos')
      .set(auth(doctor.accessToken))
      .send({ title: 'Stairs and knee load explained', topic: 'orthopaedics', durationSec: 60 });
    const res = await request(ctx.app)
      .post(`/api/doctor/consultations/${consultationId}/reply`)
      .set(auth(doctor.accessToken))
      .send({ body: 'X-ray is not needed yet — start with loading advice and review in two weeks.', videoIds: [video.body.video.id] });
    expect(res.status).toBe(201);
    expect(res.body.consultation.status).toBe('answered');

    const mine = await request(ctx.app)
      .get(`/api/care/consultations/${consultationId}`)
      .set(auth(patient.accessToken));
    expect(mine.body.doctorReply).toMatch(/X-ray is not needed/);
    expect(mine.body.recommendedVideos).toHaveLength(1);
  });

  it('stops the doctor from replying once the patient revokes consent', async () => {
    const revoke = await request(ctx.app)
      .post(`/api/care/consultations/${consultationId}/consent/revoke`)
      .set(auth(patient.accessToken))
      .send({});
    expect(revoke.status).toBe(200);
    expect(revoke.body.consent.revoked).toBe(true);

    const after = await request(ctx.app)
      .get(`/api/doctor/consultations/${consultationId}`)
      .set(auth(doctor.accessToken));
    expect(after.body.brief).toBeNull();
    expect(after.body.chartAccess.granted).toBe(false);

    const reply = await request(ctx.app)
      .post(`/api/doctor/consultations/${consultationId}/reply`)
      .set(auth(doctor.accessToken))
      .send({ body: 'One more thing — please do the blood test.' });
    expect(reply.status).toBe(403);
    expect(reply.body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('credits the doctor for the plan-funded consult and settles the shorts pool by watch time', async () => {
    const videoId = ctx.container.videoRepository.listByDoctor(doctorId)[0].id;
    await request(ctx.app)
      .post(`/api/care/videos/${videoId}/views`)
      .set(auth(patient.accessToken))
      .send({ secondsWatched: 50 });

    const statement = await request(ctx.app).get('/api/doctor/earnings').set(auth(doctor.accessToken));
    expect(statement.status).toBe(200);
    expect(statement.body.totals.consultationSharePaise).toBe(28000); // ₹400 fee × 70%
    expect(statement.body.activity.watchSeconds).toBe(50);
    expect(statement.body.pools.shorts.distributedPaise).toBeGreaterThan(0);
    expect(statement.body.revenueModel.explainer.join(' ')).toMatch(/watched seconds/i);
  });
});

describe('admin controls + immediate role revocation', () => {
  let adminToken;

  it('lets an admin suspend a doctor, which revokes console access on the next request', async () => {
    const passwordHash = ctx.container.passwordService.hash(STRONG_PASSWORD);
    ctx.container.userRepository.create({ email: 'dc-admin@mt.test', displayName: 'Admin', passwordHash, role: 'admin' });
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'dc-admin@mt.test', password: STRONG_PASSWORD });
    adminToken = login.body.accessToken;

    const queue = await request(ctx.app).get('/api/admin/doctors').set(auth(adminToken));
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((d) => d.id)).toContain(doctorId);

    const suspend = await request(ctx.app)
      .post(`/api/admin/doctors/${doctorId}/status`)
      .set(auth(adminToken))
      .send({ status: 'suspended' });
    expect(suspend.status).toBe(200);
    expect(suspend.body.doctor.status).toBe('suspended');

    // Same access token, next request: the doctor role is gone from the DB.
    const blocked = await request(ctx.app).get('/api/doctor/overview').set(auth(doctor.accessToken));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('DOCTOR_ROLE_REQUIRED');

    const patientCantSettle = await request(ctx.app)
      .post('/api/admin/payouts/settle')
      .set(auth(patient.accessToken))
      .send({ period: new Date().toISOString().slice(0, 7) });
    expect(patientCantSettle.status).toBe(403);

    const reactivate = await request(ctx.app)
      .post(`/api/admin/doctors/${doctorId}/status`)
      .set(auth(adminToken))
      .send({ status: 'active' });
    expect(reactivate.status).toBe(200);
    const back = await request(ctx.app).get('/api/doctor/overview').set(auth(doctor.accessToken));
    expect(back.status).toBe(200);
  });
});
