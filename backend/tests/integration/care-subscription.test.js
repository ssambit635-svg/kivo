import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext, registerUser, auth, SAMPLE_REPORT_TEXT, ingestAndVerify } from '../helpers.js';

/**
 * Care+ subscription (mock billing) + the paywalled shorts library.
 * The money is simulated; the entitlement logic and the ledger are not.
 */

let ctx, patient, memberId, doctor, doctorId;
let previewId, paidId;

async function applyDoctor(overrides = {}) {
  const res = await request(ctx.app).post('/api/doctor/apply').send({
    email: 'dr.femur@mt.test',
    displayName: 'Dr Femur Rao',
    password: 'Str0ng!Passw0rd#2026',
    specialty: 'orthopaedics',
    headline: 'Bone & joint specialist',
    registrationNo: 'MCI-10001',
    experienceYears: 9,
    city: 'Pune',
    consultFeeInr: 400,
    qualifications: ['MBBS', 'MS Ortho'],
    languages: ['English', 'Hindi'],
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`doctor apply failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

beforeAll(async () => {
  ctx = makeTestContext();
  patient = await registerUser(request, ctx.app, { email: 'sub-patient@mt.test', displayName: 'Sub Patient' });
  const members = await request(ctx.app).get('/api/members').set(auth(patient.accessToken));
  memberId = members.body.owned.find((m) => m.relationship === 'self').id;
  const doctorSession = await applyDoctor();
  doctor = { accessToken: doctorSession.accessToken, user: doctorSession.user };
  doctorId = doctorSession.doctor.id;
  await ingestAndVerify(request, ctx.app, patient.accessToken, memberId, SAMPLE_REPORT_TEXT, '2026-03-12');
});
afterAll(() => ctx.container.close());

describe('subscription catalog', () => {
  it('publishes the plans publicly with the mock-billing notice', async () => {
    const res = await request(ctx.app).get('/api/public/plans');
    expect(res.status).toBe(200);
    const codes = res.body.plans.map((p) => p.code);
    expect(codes).toContain('care_monthly');
    expect(codes).toContain('care_yearly');
    expect(res.body.billing.mode).toBe('mock');
    expect(res.body.billing.notice).toMatch(/no real gateway/i);
  });

  it('starts every new account on the free entitlements', async () => {
    const res = await request(ctx.app).get('/api/care/entitlements').set(auth(patient.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.entitlements.active).toBe(false);
    expect(res.body.entitlements.videoAccess).toBe('preview');
    expect(res.body.entitlements.consultationsRemaining).toBe(0);
  });
});

describe('shorts access control', () => {
  it('lets a doctor publish a preview short and a paid short', async () => {
    const preview = await request(ctx.app)
      .post('/api/doctor/videos')
      .set(auth(doctor.accessToken))
      .send({
        title: 'Knee pain: three red flags',
        summary: 'When a knee needs a scan.',
        topic: 'orthopaedics',
        durationSec: 48,
        keyPoints: ['Swelling that persists', 'Locking', 'Night pain'],
        isPreview: true,
      });
    expect(preview.status).toBe(201);
    previewId = preview.body.video.id;

    const paid = await request(ctx.app)
      .post('/api/doctor/videos')
      .set(auth(doctor.accessToken))
      .send({ title: 'ACL recovery week by week', topic: 'orthopaedics', durationSec: 90, isPreview: false });
    expect(paid.status).toBe(201);
    paidId = paid.body.video.id;
  });

  it('rejects outcome claims at upload time (no "cure", no "guaranteed")', async () => {
    const res = await request(ctx.app)
      .post('/api/doctor/videos')
      .set(auth(doctor.accessToken))
      .send({ title: 'Guaranteed cure for arthritis', topic: 'orthopaedics' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some((d) => d.code === 'CLAIM_LINT')).toBe(true);
  });

  it('marks paid shorts as locked for free patients and blocks playback with 402', async () => {
    const feed = await request(ctx.app).get('/api/care/videos').set(auth(patient.accessToken));
    expect(feed.status).toBe(200);
    const preview = feed.body.items.find((v) => v.id === previewId);
    const paid = feed.body.items.find((v) => v.id === paidId);
    expect(preview.locked).toBe(false);
    expect(paid.locked).toBe(true);
    expect(feed.body.access.fullAccess).toBe(false);

    const playback = await request(ctx.app)
      .post(`/api/care/videos/${paidId}/playback`)
      .set(auth(patient.accessToken))
      .send({});
    expect(playback.status).toBe(402);
    expect(playback.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('allows preview playback without a subscription', async () => {
    const res = await request(ctx.app)
      .post(`/api/care/videos/${previewId}/playback`)
      .set(auth(patient.accessToken))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.captions).toBe(true); // caption short — no binary asset needed
  });
});

describe('mock subscription purchase', () => {
  it('activates Care+ and flips entitlements to full video access', async () => {
    const res = await request(ctx.app)
      .post('/api/care/subscription')
      .set(auth(patient.accessToken))
      .send({ planCode: 'care_monthly', method: 'upi' });
    expect(res.status).toBe(201);
    expect(res.body.payment.mode).toBe('mock');
    expect(res.body.payment.status).toBe('succeeded');
    expect(res.body.entitlements.active).toBe(true);
    expect(res.body.entitlements.videoAccess).toBe('full');
    expect(res.body.entitlements.consultationsIncluded).toBe(4);
    expect(res.body.entitlements.consultationsRemaining).toBe(4);
    // No credential material is ever stored or returned.
    expect(JSON.stringify(res.body.payment)).not.toMatch(/cardNumber|vpa|cvv|upiId/i);
  });

  it('splits the subscription rupee into the documented pools', async () => {
    const ledger = ctx.container.subscriptionRepository;
    const period = new Date().toISOString().slice(0, 7);
    // ₹199 → 19900 paise
    expect(ledger.sumLedger(period, 'video_pool_accrual')).toBe(4975); // 25%
    expect(ledger.sumLedger(period, 'consult_pool_accrual')).toBe(6965); // 35%
    expect(ledger.sumLedger(period, 'platform_fee')).toBe(7960); // 40%
  });

  it('unlocks the paid short and records watch time for the payout pool', async () => {
    const playback = await request(ctx.app)
      .post(`/api/care/videos/${paidId}/playback`)
      .set(auth(patient.accessToken))
      .send({});
    expect(playback.status).toBe(200);
    expect(playback.body.captions).toBe(true);

    const watch = await request(ctx.app)
      .post(`/api/care/videos/${paidId}/views`)
      .set(auth(patient.accessToken))
      .send({ secondsWatched: 45 });
    expect(watch.status).toBe(200);
    expect(watch.body.secondsWatched).toBe(45);
  });

  it('clamps a dishonest watch claim to the length of the short', async () => {
    const watch = await request(ctx.app)
      .post(`/api/care/videos/${paidId}/views`)
      .set(auth(patient.accessToken))
      .send({ secondsWatched: 3600 });
    expect(watch.status).toBe(200);
    expect(watch.body.secondsWatched).toBe(90); // duration of that short
  });

  it('cancels the subscription and drops back to preview access', async () => {
    const cancel = await request(ctx.app).delete('/api/care/subscription').set(auth(patient.accessToken));
    expect(cancel.status).toBe(200);
    expect(cancel.body.entitlements.active).toBe(false);
    expect(cancel.body.entitlements.videoAccess).toBe('preview');
    const replay = await request(ctx.app)
      .post(`/api/care/videos/${paidId}/playback`)
      .set(auth(patient.accessToken))
      .send({});
    expect(replay.status).toBe(402);
  });

  it('exposes the mock failure path for demos without a gateway', async () => {
    const intent = await request(ctx.app)
      .post('/api/care/payments')
      .set(auth(patient.accessToken))
      .send({ purpose: 'subscription', planCode: 'care_yearly' });
    expect(intent.status).toBe(201);
    const failed = await request(ctx.app)
      .post(`/api/care/payments/${intent.body.payment.id}/confirm`)
      .set(auth(patient.accessToken))
      .send({ method: 'card', simulate: 'failure' });
    expect(failed.status).toBe(200);
    expect(failed.body.payment.status).toBe('failed');
    expect(failed.body.payment.failureReason).toMatch(/simulated/i);
    // a failed payment must not activate anything
    expect(failed.body.entitlements.active).toBe(false);
  });
});
