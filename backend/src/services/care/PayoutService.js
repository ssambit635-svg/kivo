import { REVENUE_MODEL, periodOf, rupees } from './plans.js';

/**
 * Revenue arithmetic for the doctor network.
 *
 * Money model (documented, tested, shown to doctors verbatim):
 *   • one-off consultation payment → doctor 70% / platform 30%
 *   • every subscription rupee     → 25% shorts-pool accrual, 35% consult-pool
 *                                    accrual, 40% platform
 *   • plan-funded consultation     → the doctor is credited 70% of their own
 *                                    fee from the consult pool
 *   • the shorts pool is settled   → split by WATCHED SECONDS, largest-remainder
 *                                    rounding, idempotent per month
 *
 * This is the answer to "why should a doctor upload videos and lose time?":
 * reach turns into a second income line, and the platform can show the exact
 * arithmetic behind it.
 */
export class PayoutService {
  constructor({ subscriptionRepository, videoRepository, doctorRepository, consultationRepository, auditService }) {
    this.ledger = subscriptionRepository;
    this.videos = videoRepository;
    this.doctors = doctorRepository;
    this.consultations = consultationRepository;
    this.audit = auditService;
  }

  /**
   * Called exactly once per settled mock payment.
   * `purpose: 'subscription'` → pool accruals + platform cut.
   * `purpose: 'consultation'` → doctor share + platform cut.
   */
  recordPaymentSplit(intent, { ctx = {} } = {}) {
    if (!intent || intent.status !== 'succeeded') return { recorded: false, reason: 'not_settled' };
    const period = periodOf(intent.created_at || new Date().toISOString());
    const total = Math.round(intent.amount_inr * 100);

    if (intent.purpose === 'consultation') {
      const consultation = intent.consultation_id
        ? this.consultations.findById(intent.consultation_id)
        : null;
      if (!consultation) return { recorded: false, reason: 'consultation_missing' };
      const doctorPaise = Math.round(total * REVENUE_MODEL.consultDoctorShare);
      const platformPaise = total - doctorPaise;
      this.ledger.addLedgerEntry({
        doctorId: consultation.doctor_id,
        paymentIntentId: intent.id,
        consultationId: consultation.id,
        entryType: 'consult_share',
        amountPaise: doctorPaise,
        period,
        description: `Consultation fee share (${Math.round(REVENUE_MODEL.consultDoctorShare * 100)}%)`,
      });
      this.ledger.addLedgerEntry({
        paymentIntentId: intent.id,
        consultationId: consultation.id,
        entryType: 'platform_fee',
        amountPaise: platformPaise,
        period,
        description: `Platform fee (${Math.round(REVENUE_MODEL.consultPlatformShare * 100)}%)`,
      });
      return { recorded: true, doctorPaise, platformPaise, period };
    }

    const videoPool = Math.round(total * REVENUE_MODEL.subscriptionVideoPool);
    const consultPool = Math.round(total * REVENUE_MODEL.subscriptionConsultPool);
    const platform = total - videoPool - consultPool;
    this.ledger.addLedgerEntry({
      paymentIntentId: intent.id,
      entryType: 'video_pool_accrual',
      amountPaise: videoPool,
      period,
      description: `Shorts pool accrual (${Math.round(REVENUE_MODEL.subscriptionVideoPool * 100)}% of subscription)`,
    });
    this.ledger.addLedgerEntry({
      paymentIntentId: intent.id,
      entryType: 'consult_pool_accrual',
      amountPaise: consultPool,
      period,
      description: `Consultation pool accrual (${Math.round(REVENUE_MODEL.subscriptionConsultPool * 100)}%)`,
    });
    this.ledger.addLedgerEntry({
      paymentIntentId: intent.id,
      entryType: 'platform_fee',
      amountPaise: platform,
      period,
      description: `Platform share (${Math.round(REVENUE_MODEL.subscriptionPlatform * 100)}%)`,
    });
    return { recorded: true, videoPool, consultPool, platform, period };
  }

  /**
   * A consultation covered by the patient's plan still pays the doctor —
   * from the consult pool, at the same share rate. Recorded with ₹0 patient
   * payment so the books stay explainable.
   */
  recordPlanFundedConsultation({ doctor, consultation }) {
    const fee = consultation.fee_inr > 0 ? consultation.fee_inr : doctor.consult_fee_inr;
    if (!fee || fee <= 0) return { recorded: false, reason: 'no_fee_configured' };
    const total = Math.round(fee * 100);
    const doctorPaise = Math.round(total * REVENUE_MODEL.consultDoctorShare);
    const period = periodOf(consultation.created_at || new Date().toISOString());
    this.ledger.addLedgerEntry({
      doctorId: doctor.id,
      consultationId: consultation.id,
      entryType: 'consult_share',
      amountPaise: doctorPaise,
      period,
      description: 'Plan-funded consultation (₹0 charged to the patient)',
    });
    return { recorded: true, doctorPaise, period };
  }

  /**
   * Settle a month's shorts pool by watched seconds.
   * Idempotent: once shares exist for the period, it refuses to pay twice
   * unless `force` is set (which first removes the earlier share rows).
   */
  settleVideoPool(period, { force = false, ctx = {} } = {}) {
    const accrual = this.ledger.sumLedger(period, 'video_pool_accrual');
    const alreadyPaid = this.ledger.sumLedger(period, 'video_pool_share');
    if (alreadyPaid > 0 && !force) {
      return {
        settled: false,
        reason: 'already_settled',
        period,
        poolPaise: accrual - alreadyPaid,
        paidPaise: alreadyPaid,
      };
    }
    if (force && alreadyPaid > 0) {
      // Re-running a statement must not double-pay. The reversal is booked
      // against the SAME entry type, per doctor, so the ledger nets to zero
      // for the old split and every correction stays visible.
      for (const share of this.ledger.sharesByDoctor(period)) {
        this.ledger.addLedgerEntry({
          doctorId: share.doctorId,
          entryType: 'video_pool_share',
          amountPaise: -share.amountPaise,
          period,
          description: 'Reversal of previous shorts-pool settlement (re-settle requested)',
        });
      }
    }

    const pool = this.ledger.sumLedger(period, 'video_pool_accrual') - this.ledger.sumLedger(period, 'video_pool_share');
    if (pool <= 0) return { settled: false, reason: 'empty_pool', period, poolPaise: 0 };

    const rows = this.videos.watchSecondsByDoctor(period).filter((r) => r.seconds > 0);
    const totalSeconds = rows.reduce((sum, r) => sum + r.seconds, 0);
    if (totalSeconds === 0) {
      return { settled: false, reason: 'no_watch_activity', period, poolPaise: pool, totalSeconds: 0 };
    }

    // Largest-remainder rounding: every paise is allocated, nobody loses a
    // rounding penny to the largest earner by accident of float math.
    const withShares = rows.map((r) => {
      const exact = (pool * r.seconds) / totalSeconds;
      return { ...r, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
    });
    let allocated = withShares.reduce((sum, r) => sum + r.floor, 0);
    const byRemainder = [...withShares].sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; allocated < pool && byRemainder.length > 0; i += 1) {
      byRemainder[i % byRemainder.length].floor += 1;
      allocated += 1;
    }

    const payouts = [];
    for (const row of withShares) {
      if (row.floor <= 0) continue;
      this.ledger.addLedgerEntry({
        doctorId: row.doctor_id,
        entryType: 'video_pool_share',
        amountPaise: row.floor,
        period,
        description: `Shorts pool share — ${row.seconds}s watched of ${totalSeconds}s (${row.views} views)`,
      });
      payouts.push({ doctorId: row.doctor_id, amountPaise: row.floor, watchSeconds: row.seconds, views: row.views });
    }

    this.audit?.record({
      userId: null,
      action: 'payouts.video_pool_settled',
      resourceType: 'payout_period',
      resourceId: period,
      metadata: { poolPaise: pool, totalSeconds, doctors: payouts.length, force },
      ctx,
    });
    return { settled: true, period, poolPaise: pool, totalSeconds, payouts };
  }

  /**
   * What a doctor actually earned in a month, including the context that
   * makes it make sense (pool size, their slice, watch time, unpaid balance).
   */
  doctorStatement(doctor, { period = null, autoSettle = true, ctx = {} } = {}) {
    const target = period || periodOf(new Date().toISOString());
    if (autoSettle) this.settleVideoPool(target, { ctx });

    const entries = this.ledger.ledgerForDoctor(doctor.id, { period: target });
    const totals = entries.reduce(
      (acc, e) => {
        const bucket = e.entryType === 'consult_share' ? 'consultPaise' : e.entryType === 'video_pool_share' ? 'videoPaise' : 'otherPaise';
        acc[bucket] += e.amountPaise;
        if (e.status === 'pending') acc.pendingPaise += e.amountPaise;
        if (e.status === 'paid') acc.paidPaise += e.amountPaise;
        return acc;
      },
      { consultPaise: 0, videoPaise: 0, otherPaise: 0, pendingPaise: 0, paidPaise: 0 },
    );
    const watch = this.videos.watchSecondsForDoctor(doctor.id, { period: target });
    const poolAccrual = this.ledger.sumLedger(target, 'video_pool_accrual');
    const poolPaid = this.ledger.sumLedger(target, 'video_pool_share');
    const consultPoolAccrual = this.ledger.sumLedger(target, 'consult_pool_accrual');
    const consultPoolPaid = this.ledger.sumLedger(target, 'consult_share');

    return {
      period: target,
      availablePeriods: this.ledger.listPeriods(),
      totals: {
        totalPaise: totals.consultPaise + totals.videoPaise + totals.otherPaise,
        totalInr: rupees(totals.consultPaise + totals.videoPaise + totals.otherPaise),
        consultationSharePaise: totals.consultPaise,
        consultationShareInr: rupees(totals.consultPaise),
        videoPoolSharePaise: totals.videoPaise,
        videoPoolShareInr: rupees(totals.videoPaise),
        pendingPaise: totals.pendingPaise,
        paidPaise: totals.paidPaise,
      },
      activity: { views: watch.views, watchSeconds: watch.seconds, videosPublished: doctor.video_count },
      pools: {
        shorts: {
          accrualPaise: poolAccrual,
          accrualInr: rupees(poolAccrual),
          distributedPaise: poolPaid,
          distributedInr: rupees(poolPaid),
          remainingPaise: poolAccrual - poolPaid,
          yourSharePercent: poolPaid > 0 ? Number(((totals.videoPaise / poolPaid) * 100).toFixed(1)) : 0,
        },
        consultations: {
          accrualPaise: consultPoolAccrual,
          accrualInr: rupees(consultPoolAccrual),
          paidToDoctorsPaise: consultPoolPaid,
          paidToDoctorsInr: rupees(consultPoolPaid),
          balancePaise: consultPoolAccrual - consultPoolPaid,
        },
      },
      entries,
      revenueModel: {
        ...REVENUE_MODEL,
        explainer: [
          `A patient paying your consult fee sends you ${Math.round(REVENUE_MODEL.consultDoctorShare * 100)}%.`,
          `Every subscription rupee puts ${Math.round(REVENUE_MODEL.subscriptionVideoPool * 100)}% into the monthly shorts pool.`,
          'The shorts pool is split by watched seconds — reach pays, clickbait does not.',
          'Plan-funded consultations are paid from the consult pool at your own fee rate.',
        ],
      },
      payoutNote:
        'Demo ledger: every amount is computed from settled payments, and no bank transfer is initiated in this build.',
    };
  }
}
