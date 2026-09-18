import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  makeTestContext,
  registerUser,
  auth,
  SAMPLE_REPORT_TEXT,
  ingestAndVerify,
} from '../helpers.js';

/**
 * Full endpoint coverage for Care network, doctor console and patient flows:
 * - Patient consultation messaging and consultation closing
 * - Care hub overview (GET /api/care/home) and plans
 * - Doctor specialties directory (public and authenticated)
 * - Doctor profile updates and mock KYC lifecycle
 * - Doctor consultation workflow: accept, close, and medicine-plan rejection
 * - Doctor video shorts: recommendable list, updating metadata, and archiving
 */

let ctx;
let patientSession;
let patientMemberId;
let doctorSession;
let doctorId;
let unverifiedDoctorSession;
let unverifiedDoctorId;
let testConsultationId;
let testVideoId;

beforeAll(async () => {
  ctx = makeTestContext();

  // 1. Setup Patient
  patientSession = await registerUser(request, ctx.app, {
    email: 'coverage-patient@mt.test',
    displayName: 'Coverage Patient',
  });
  const membersRes = await request(ctx.app)
    .get('/api/members')
    .set(auth(patientSession.accessToken));
  patientMemberId = membersRes.body.owned.find((m) => m.relationship === 'self').id;

  // Add baseline vitals and verify report
  await request(ctx.app)
    .patch(`/api/members/${patientMemberId}`)
    .set(auth(patientSession.accessToken))
    .send({ dob: '1990-06-15', sex: 'female', heightCm: 168 });
  await ingestAndVerify(
    request,
    ctx.app,
    patientSession.accessToken,
    patientMemberId,
    SAMPLE_REPORT_TEXT,
    '2026-04-10',
  );

  // Subscribe patient to Care+
  await request(ctx.app)
    .post('/api/care/subscription')
    .set(auth(patientSession.accessToken))
    .send({ planCode: 'care_monthly' });

  // 2. Setup Active Doctor
  const docApply = await request(ctx.app).post('/api/doctor/apply').send({
    email: 'coverage-dr@mt.test',
    displayName: 'Dr Coverage Specialist',
    password: 'Str0ng!Passw0rd#2026',
    specialty: 'cardiology',
    headline: 'Cardiology Consultant',
    registrationNo: 'MCI-998877',
    experienceYears: 12,
    city: 'Hyderabad',
    consultFeeInr: 500,
    qualifications: ['MBBS', 'MD Cardiology'],
  });
  doctorSession = docApply.body;
  doctorId = docApply.body.doctor.id;

  // 3. Setup Unverified / Pending Doctor for KYC testing
  ctx.container.config.doctorAutoApprove = false;
  const pendingDocApply = await request(ctx.app).post('/api/doctor/apply').send({
    email: 'pending-dr@mt.test',
    displayName: 'Dr Pending Verification',
    password: 'Str0ng!Passw0rd#2026',
    specialty: 'dermatology',
    headline: 'Skin & Hair Specialist',
    registrationNo: 'MCI-334455',
    experienceYears: 6,
    city: 'Bengaluru',
    consultFeeInr: 350,
  });
  unverifiedDoctorSession = pendingDocApply.body;
  unverifiedDoctorId = pendingDocApply.body.doctor.id;
  ctx.container.config.doctorAutoApprove = true;

  // 4. Book a consultation for patient with active doctor
  const consultRes = await request(ctx.app)
    .post('/api/care/consultations')
    .set(auth(patientSession.accessToken))
    .send({
      memberId: patientMemberId,
      doctorId,
      subject: 'Cardio Checkup Consultation',
      question: 'Reviewing recent lipid panels and heart rate variability metrics.',
      shareHealthData: true,
    });
  testConsultationId = consultRes.body.consultation.id;
});

afterAll(() => ctx.container.close());

describe('Care patient endpoints coverage', () => {
  it('GET /api/care/home returns care hub overview with consultations and entitlements', async () => {
    const res = await request(ctx.app)
      .get('/api/care/home')
      .set(auth(patientSession.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.entitlements).toBeDefined();
    expect(res.body.entitlements.active).toBe(true);
    expect(Array.isArray(res.body.consultations)).toBe(true);
    expect(Array.isArray(res.body.videos)).toBe(true);
    expect(Array.isArray(res.body.doctors)).toBe(true);
    expect(res.body.billing.mode).toBe('mock');
  });

  it('GET /api/care/plans returns subscription plans catalog for patient', async () => {
    const res = await request(ctx.app)
      .get('/api/care/plans')
      .set(auth(patientSession.accessToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.plans)).toBe(true);
    expect(res.body.plans.length).toBeGreaterThan(0);
    expect(res.body.billing.mode).toBe('mock');
    expect(res.body.revenueModel).toBeDefined();
  });

  it('GET /api/public/doctors/specialties returns specialties directory without auth', async () => {
    const res = await request(ctx.app).get('/api/public/doctors/specialties');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.specialties)).toBe(true);
    expect(res.body.specialties.length).toBeGreaterThan(0);
    const cardio = res.body.specialties.find((s) => s.key === 'cardiology');
    expect(cardio).toBeDefined();
    expect(cardio.doctors).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/care/doctors and GET /api/care/doctors/specialties return doctor network for patient', async () => {
    const specRes = await request(ctx.app)
      .get('/api/care/doctors/specialties')
      .set(auth(patientSession.accessToken));
    expect(specRes.status).toBe(200);
    expect(Array.isArray(specRes.body.specialties)).toBe(true);

    const docListRes = await request(ctx.app)
      .get('/api/care/doctors?specialty=cardiology')
      .set(auth(patientSession.accessToken));
    expect(docListRes.status).toBe(200);
    expect(Array.isArray(docListRes.body.items)).toBe(true);
    expect(docListRes.body.items.some((d) => d.id === doctorId)).toBe(true);

    const docSingleRes = await request(ctx.app)
      .get(`/api/care/doctors/${doctorId}`)
      .set(auth(patientSession.accessToken));
    expect(docSingleRes.status).toBe(200);
    expect(docSingleRes.body.doctor.id).toBe(doctorId);
    expect(docSingleRes.body.doctor.specialty).toBe('cardiology');
  });

  it('POST /api/care/consultations/:id/messages adds a patient message to the thread', async () => {
    const res = await request(ctx.app)
      .post(`/api/care/consultations/${testConsultationId}/messages`)
      .set(auth(patientSession.accessToken))
      .send({ body: 'Could we also look into my cholesterol trend from last year?' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBeDefined();
    expect(res.body.message.body).toBe('Could we also look into my cholesterol trend from last year?');
    expect(res.body.message.authorRole).toBe('patient');
    expect(res.body.message.createdAt).toBeDefined();
  });
});

describe('Doctor console endpoints coverage', () => {
  it('GET /api/doctor/revenue-model explains revenue share rules to active doctor', async () => {
    const res = await request(ctx.app)
      .get('/api/doctor/revenue-model')
      .set(auth(doctorSession.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.revenueModel).toBeDefined();
    expect(res.body.revenueModel.consultDoctorShare).toBe(0.7);
    expect(Array.isArray(res.body.revenueModel.explainer)).toBe(true);
    expect(res.body.payoutNote).toMatch(/mock ledger/i);
  });

  it('PATCH /api/doctor/profile updates doctor professional profile fields', async () => {
    const res = await request(ctx.app)
      .patch('/api/doctor/profile')
      .set(auth(doctorSession.accessToken))
      .send({
        headline: 'Lead Cardiologist and Heart Health Specialist',
        clinicName: 'Hyderabad Heart Institute',
        bio: 'Over a decade dedicated to preventive cardiology and digital health monitoring.',
        consultFeeInr: 600,
      });

    expect(res.status).toBe(200);
    expect(res.body.doctor.headline).toBe('Lead Cardiologist and Heart Health Specialist');
    expect(res.body.doctor.clinicName).toBe('Hyderabad Heart Institute');
    expect(res.body.doctor.consultFeeInr).toBe(600);
  });

  it('POST /api/doctor/kyc/mock completes KYC verification for a pending doctor', async () => {
    // Check pending state
    const meBefore = await request(ctx.app)
      .get('/api/doctor/me')
      .set(auth(unverifiedDoctorSession.accessToken));
    expect(meBefore.body.doctor.status).toBe('pending_verification');

    // Complete mock KYC
    const kycRes = await request(ctx.app)
      .post('/api/doctor/kyc/mock')
      .set(auth(unverifiedDoctorSession.accessToken))
      .send({ ref: 'MOCK-KYC-CUSTOM-TEST-REF' });

    expect(kycRes.status).toBe(200);
    expect(kycRes.body.doctor.status).toBe('active');
    expect(kycRes.body.doctor.kyc.status).toBe('mock_verified');
    expect(kycRes.body.doctor.kyc.ref).toBe('MOCK-KYC-CUSTOM-TEST-REF');
    expect(kycRes.body.verification.mode).toBe('mock');

    // Now has doctor role access
    const overview = await request(ctx.app)
      .get('/api/doctor/overview')
      .set(auth(unverifiedDoctorSession.accessToken));
    expect(overview.status).toBe(200);
  });

  it('POST /api/doctor/consultations/:id/accept accepts a requested consultation', async () => {
    const acceptRes = await request(ctx.app)
      .post(`/api/doctor/consultations/${testConsultationId}/accept`)
      .set(auth(doctorSession.accessToken));

    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.consultation.status).toBe('in_review');

    // Accepting again is idempotent and returns current state
    const acceptAgain = await request(ctx.app)
      .post(`/api/doctor/consultations/${testConsultationId}/accept`)
      .set(auth(doctorSession.accessToken));
    expect(acceptAgain.status).toBe(200);
    expect(acceptAgain.body.consultation.status).toBe('in_review');
  });

  it('POST /api/doctor/consultations/:id/medicine-plan/reject rejects the AI medicine draft', async () => {
    // Generate draft first
    await request(ctx.app)
      .post(`/api/doctor/consultations/${testConsultationId}/medicine-draft`)
      .set(auth(doctorSession.accessToken))
      .send({});

    // Reject the draft
    const rejectRes = await request(ctx.app)
      .post(`/api/doctor/consultations/${testConsultationId}/medicine-plan/reject`)
      .set(auth(doctorSession.accessToken));

    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.medicinePlan.status).toBe('rejected');
    expect(rejectRes.body.medicinePlan.finalItems).toHaveLength(0);
    expect(rejectRes.body.medicinePlan.doctorNote).toMatch(/rejected by the doctor/i);
  });

  it('Doctor video management: recommendable list, PATCH metadata, and DELETE archive', async () => {
    // 1. Create a published short video
    const pubRes = await request(ctx.app)
      .post('/api/doctor/videos')
      .set(auth(doctorSession.accessToken))
      .send({
        title: 'Managing Blood Pressure Naturally',
        summary: 'Daily habit adjustments that support cardiovascular wellness and arterial health.',
        topic: 'cardiology',
        durationSec: 55,
        isPreview: true,
      });
    expect(pubRes.status).toBe(201);
    testVideoId = pubRes.body.video.id;

    // 2. GET recommendable videos
    const recRes = await request(ctx.app)
      .get('/api/doctor/videos/recommendable')
      .set(auth(doctorSession.accessToken));
    expect(recRes.status).toBe(200);
    expect(Array.isArray(recRes.body.videos)).toBe(true);
    expect(recRes.body.videos.some((v) => v.id === testVideoId)).toBe(true);

    // 3. PATCH video metadata
    const patchRes = await request(ctx.app)
      .patch(`/api/doctor/videos/${testVideoId}`)
      .set(auth(doctorSession.accessToken))
      .send({
        title: 'Managing Blood Pressure Through Daily Lifestyle',
        summary: 'Updated guidelines for healthy cardiovascular habits and exercise.',
      });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.video.title).toBe('Managing Blood Pressure Through Daily Lifestyle');

    // 4. DELETE / archive video
    const archiveRes = await request(ctx.app)
      .delete(`/api/doctor/videos/${testVideoId}`)
      .set(auth(doctorSession.accessToken));
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.archived).toBe(true);
    expect(archiveRes.body.id).toBe(testVideoId);
  });

  it('POST /api/doctor/consultations/:id/close closes a consultation by doctor', async () => {
    // Create another consultation to close via doctor
    const secondConsult = await request(ctx.app)
      .post('/api/care/consultations')
      .set(auth(patientSession.accessToken))
      .send({
        memberId: patientMemberId,
        doctorId,
        subject: 'Follow-up Consultation',
        question: 'Checking on the earlier advice regarding diet and exercise.',
        shareHealthData: true,
      });
    const cId = secondConsult.body.consultation.id;

    const closeDocRes = await request(ctx.app)
      .post(`/api/doctor/consultations/${cId}/close`)
      .set(auth(doctorSession.accessToken));
    expect(closeDocRes.status).toBe(200);
    expect(closeDocRes.body.consultation.status).toBe('closed');
  });

  it('POST /api/care/consultations/:id/close closes a consultation by patient', async () => {
    const closePatRes = await request(ctx.app)
      .post(`/api/care/consultations/${testConsultationId}/close`)
      .set(auth(patientSession.accessToken));

    expect(closePatRes.status).toBe(200);
    expect(closePatRes.body.status).toBe('closed');

    // Calling close again is idempotent and returns the closed consultation object
    const closeAgain = await request(ctx.app)
      .post(`/api/care/consultations/${testConsultationId}/close`)
      .set(auth(patientSession.accessToken));
    expect(closeAgain.status).toBe(200);
    expect(closeAgain.body.status).toBe('closed');
  });
});
