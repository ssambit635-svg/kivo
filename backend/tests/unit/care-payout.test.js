import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestContext } from '../helpers.js';
import { REVENUE_MODEL } from '../../src/services/care/plans.js';

/**
 * Revenue arithmetic. The gateway is fake; the maths must not be.
 * A doctor's livelihood cannot depend on a rounding bug.
 */

let ctx, payout, subs, videos, doctors, period;

function makeDoctor(i, fee = 400) {
  const passwordHash = ctx.container.passwordService.hash('Str0ng!Passw0rd#2026');
  const user = ctx.container.userRepository.create({
    email: `payout-doc${i}@mt.test`,
    displayName: `Dr Payout ${i}`,
    passwordHash,
    role: 'user',
  });
  return doctors.create({
    userId: user.id,
    slug: `dr-payout-${i}`,
    fullName: `Dr Payout ${i}`,
    headline: 'Bone & joint specialist',
    specialty: 'orthopaedics',
    registrationNo: `MCI-9000${i}`,
    consultFeeInr: fee,
    status: 'active',
    identityCardNo: `MT-DOC-PAYOUT${i}`,
  });
}

beforeAll(() => {
  ctx = makeTestContext();
  payout = ctx.container.payoutService;
  subs = ctx.container.subscriptionRepository;
  videos = ctx.container.videoRepository;
  doctors = ctx.container.doctorRepository;
  period = new Date().toISOString().slice(0, 7);
});
afterAll(() => ctx.container.close());

describe('per-payment splits', () => {
  it('splits a consultation payment 70 / 30 between doctor and platform', () => {
    const doctor = makeDoctor(1);
    const patient = ctx.container.userRepository.create({
      email: 'payout-pat1@mt.test',
      displayName: 'P1',
      passwordHash: ctx.container.passwordService.hash('Str0ng!Passw0rd#2026'),
    });
    const member = ctx.container.memberRepository.create({ userId: patient.id, name: 'P1', relationship: 'self' });
    const consultation = ctx.container.consultationRepository.create({
      memberId: member.id,
      patientUserId: patient.id,
      doctorId: doctor.id,
      subject: 'Knee',
      question: 'Knee hurts',
      status: 'requested',
      feeInr: 400,
      includedInPlan: false,
    });
    const intent = subs.createPaymentIntent({
      userId: patient.id,
      purpose: 'consultation',
      amountInr: 400,
      consultationId: consultation.id,
    });
    const settled = subs.markIntentSucceeded(intent.id, { method: 'upi', providerRef: 'MOCK-1' });

    const result = payout.recordPaymentSplit(settled);
    expect(result.recorded).toBe(true);
    expect(result.doctorPaise).toBe(28000); // ₹280
    expect(result.platformPaise).toBe(12000); // ₹120
    const entries = subs.ledgerByPeriod(period);
    expect(entries.filter((e) => e.entryType === 'consult_share')).toHaveLength(1);
    expect(entries.filter((e) => e.entryType === 'platform_fee')).toHaveLength(1);
  });

  it('puts every subscription rupee somewhere (25 / 35 / 40, no lost paise)', () => {
    const before = subs.sumLedger(period, 'platform_fee');
    // An odd amount, so rounding has to be handled rather than hoped for.
    const intent = subs.createPaymentIntent({ userId: makePayer().id, purpose: 'subscription', amountInr: 333 });
    payout.recordPaymentSplit(subs.markIntentSucceeded(intent.id, { method: 'card', providerRef: 'MOCK-2' }));

    const video = subs.sumLedger(period, 'video_pool_accrual');
    const consult = subs.sumLedger(period, 'consult_pool_accrual');
    const platform = subs.sumLedger(period, 'platform_fee') - before;
    expect(video + consult + platform).toBe(33300); // every paise attributed
    expect(video).toBe(Math.round(33300 * REVENUE_MODEL.subscriptionVideoPool));
    expect(consult).toBe(Math.round(33300 * REVENUE_MODEL.subscriptionConsultPool));
  });

  it('ignores payments that never settled', () => {
    const intent = subs.createPaymentIntent({ userId: makePayer().id, purpose: 'subscription', amountInr: 199 });
    const result = payout.recordPaymentSplit(intent);
    expect(result.recorded).toBe(false);
  });
});

describe('shorts pool settlement', () => {
  it('splits the pool by watched seconds and allocates every paise', () => {
    const a = makeDoctor(2);
    const b = makeDoctor(3);
    const c = makeDoctor(4);
    const videoA = videos.create({ doctorId: a.id, title: 'A', topic: 'orthopaedics' });
    const videoB = videos.create({ doctorId: b.id, title: 'B', topic: 'orthopaedics' });
    // Doctor C published but nobody watched → no share, ever.
    videos.create({ doctorId: c.id, title: 'C', topic: 'orthopaedics' });
    videos.recordView({ videoId: videoA.id, doctorId: a.id, secondsWatched: 75 });
    videos.recordView({ videoId: videoB.id, doctorId: b.id, secondsWatched: 25 });

    const result = payout.settleVideoPool(period);
    expect(result.settled).toBe(true);
    expect(result.totalSeconds).toBe(100);
    const shareA = result.payouts.find((p) => p.doctorId === a.id).amountPaise;
    const shareB = result.payouts.find((p) => p.doctorId === b.id).amountPaise;
    expect(shareA + shareB).toBe(result.poolPaise); // largest-remainder: nothing lost
    expect(shareA).toBeGreaterThan(shareB);
    expect(result.payouts.find((p) => p.doctorId === c.id)).toBeUndefined();
  });

  it('never pays a month twice', () => {
    const again = payout.settleVideoPool(period);
    expect(again.settled).toBe(false);
    expect(again.reason).toBe('already_settled');
  });

  it('re-settles only when forced, and reverses the previous split first', () => {
    const before = subs.sumLedger(period, 'video_pool_share');
    const forced = payout.settleVideoPool(period, { force: true });
    expect(forced.settled).toBe(true);
    // Total credited is unchanged: the reversal cancels the earlier payout.
    expect(subs.sumLedger(period, 'video_pool_share')).toBe(before);
    expect(subs.sumLedger(period, 'video_pool_accrual')).toBeGreaterThan(0);
  });

  it('exposes pool context to the doctor so the payout is explainable', () => {
    const doctor = doctors.findById(subs.ledgerByPeriod(period).find((e) => e.entryType === 'video_pool_share').doctorId);
    const statement = payout.doctorStatement(doctor, { period });
    expect(statement.pools.shorts.accrualPaise).toBeGreaterThan(0);
    expect(statement.pools.shorts.yourSharePercent).toBeGreaterThan(0);
    expect(statement.revenueModel.explainer.join(' ')).toMatch(/watched seconds/i);
    expect(statement.payoutNote).toMatch(/demo ledger/i);
    expect(statement.payoutNote).toMatch(/no bank transfer/i);
  });
});

function makePayer() {
  return ctx.container.userRepository.create({
    email: `payer-${Math.random().toString(36).slice(2, 8)}@mt.test`,
    displayName: 'Payer',
    passwordHash: ctx.container.passwordService.hash('Str0ng!Passw0rd#2026'),
  });
}
