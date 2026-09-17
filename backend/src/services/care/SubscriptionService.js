import { ValidationError, ForbiddenError, NotFoundError, ConflictError } from '../../common/errors.js';
import { nowIso } from '../../utils/time.js';
import {
  PLANS,
  FREE_VIDEO_ACCESS,
  REVENUE_MODEL,
  planPeriodDays,
  paise,
  periodOf,
} from './plans.js';

/**
 * Subscriptions + MOCK billing.
 *
 * Everything here is deliberately honest: real rows, real entitlement math,
 * real ledger arithmetic — and a fake gateway. Payment intents never touch a
 * network, no card/UPI credential field even exists in the schema, and every
 * response carries `mode: 'mock'` with a plain-language notice.
 *
 * Entitlements are derived, never stored twice:
 *   videoAccess        ← active plan's `video_access`
 *   consultationsLeft  ← plan quota − plan-funded consultations used this period
 */
export class SubscriptionService {
  constructor({ config, subscriptionRepository, consultationRepository, payoutService, auditService }) {
    this.config = config;
    this.plansRepo = subscriptionRepository;
    this.consultations = consultationRepository;
    this.payouts = payoutService;
    this.audit = auditService;
    this.ensureCatalog();
  }

  /** Idempotent: plans are code-defined, so booting the app syncs the catalog. */
  ensureCatalog() {
    for (const plan of PLANS) this.plansRepo.ensurePlan(plan);
    // An expired demo subscription must not silently keep granting access.
    this.plansRepo.expireStale(nowIso());
  }

  plans() {
    return this.plansRepo.listPlans().map((p) => p.toJSON());
  }

  findPlan(code) {
    const plan = this.plansRepo.findPlanByCode(code);
    if (!plan) throw new NotFoundError('Subscription plan not found');
    return plan;
  }

  activeSubscription(user) {
    this.plansRepo.expireStale(nowIso());
    const sub = this.plansRepo.findActiveForUser(user.id);
    if (!sub || !sub.isActive) return null;
    return { subscription: sub, plan: this.plansRepo.findPlanById(sub.plan_id) };
  }

  /** Where the patient is entitled to go, in one object the UI can render. */
  entitlements(user) {
    const active = this.activeSubscription(user);
    if (!active) {
      return {
        active: false,
        plan: null,
        subscription: null,
        videoAccess: FREE_VIDEO_ACCESS,
        consultationsIncluded: 0,
        consultationsUsed: 0,
        consultationsRemaining: 0,
        currentPeriodEnd: null,
        billingMode: 'mock',
        billingNotice: 'Demo billing — no real payment gateway is used in this build.',
      };
    }
    const { subscription, plan } = active;
    const included = plan.consultations_per_month;
    const used = this.consultations.countForPatientSince(user.id, subscription.started_at);
    return {
      active: true,
      plan: plan.toJSON(),
      subscription: subscription.toJSON(plan),
      videoAccess: plan.video_access,
      consultationsIncluded: included,
      consultationsUsed: used,
      consultationsRemaining: Math.max(0, included - used),
      currentPeriodEnd: subscription.current_period_end,
      periodDays: planPeriodDays(plan),
      billingMode: 'mock',
      billingNotice: 'Demo billing — no real payment gateway is used in this build.',
    };
  }

  canWatchFullLibrary(user) {
    return this.entitlements(user).videoAccess === 'full';
  }

  /**
   * Demo "buy": creates a mock intent and settles it immediately.
   * Kept as one call so the plan purchase stays a single tap in the UI, while
   * the two-step intent/confirm pair still exists for consultations.
   */
  subscribe(user, { planCode, method = 'upi', ctx = {} }) {
    const plan = this.findPlan(planCode);
    if (plan.code === 'free') {
      throw new ValidationError('The free plan needs no payment — simply cancel your paid plan to return to it.');
    }
    const intent = this.plansRepo.createPaymentIntent({
      userId: user.id,
      purpose: 'subscription',
      amountInr: plan.price_inr,
      planId: plan.id,
      metadata: { planCode: plan.code, interval: plan.interval },
    });
    const payment = this.settleIntent(user, intent.id, { method, simulate: 'success', ctx });
    const subscription = this.plansRepo.replaceActive({
      userId: user.id,
      planId: plan.id,
      periodDays: planPeriodDays(plan),
    });
    this.audit.record({
      userId: user.id,
      action: 'subscription.activated',
      resourceType: 'subscription',
      resourceId: subscription.id,
      metadata: { planCode: plan.code, mockPayment: true, amountInr: plan.price_inr },
      ctx,
    });
    return { subscription: subscription.toJSON(plan), payment: payment.toJSON(), entitlements: this.entitlements(user) };
  }

  cancel(user, { ctx = {} } = {}) {
    const cancelled = this.plansRepo.cancelActive(user.id);
    if (!cancelled) throw new ConflictError('You do not have an active subscription', 'NO_ACTIVE_SUBSCRIPTION');
    this.audit.record({
      userId: user.id,
      action: 'subscription.cancelled',
      resourceType: 'subscription',
      resourceId: cancelled.id,
      ctx,
    });
    return { subscription: cancelled.toJSON(this.plansRepo.findPlanById(cancelled.plan_id)), entitlements: this.entitlements(user) };
  }

  // ---------------------------------------------------------- mock payments
  /**
   * Settle a mock intent. `simulate: 'failure'` exists so the demo (and the
   * tests) can exercise the failure path without a real gateway.
   */
  settleIntent(user, intentId, { method = 'upi', simulate = 'success', ctx = {} } = {}) {
    const intent = this.plansRepo.findIntentById(intentId);
    if (!intent) throw new NotFoundError('Payment not found');
    if (intent.user_id !== user.id) throw new NotFoundError('Payment not found');
    if (intent.status === 'succeeded') return intent; // idempotent retry
    if (intent.status !== 'created') {
      throw new ConflictError(`Payment is ${intent.status} and can no longer be settled`, 'PAYMENT_NOT_SETTLEABLE');
    }
    if (!['upi', 'card', 'netbanking', 'wallet'].includes(method)) {
      throw new ValidationError('Unsupported payment method for the mock gateway');
    }
    if (simulate === 'failure') {
      const failed = this.plansRepo.markIntentFailed(intent.id, 'Simulated gateway decline (demo)');
      this.audit.record({
        userId: user.id,
        action: 'payment.failed',
        outcome: 'failure',
        resourceType: 'payment_intent',
        resourceId: intent.id,
        metadata: { purpose: intent.purpose, mock: true },
        ctx,
      });
      return failed;
    }

    const providerRef = `MOCK-${intent.id.slice(0, 8).toUpperCase()}`;
    const settled = this.plansRepo.markIntentSucceeded(intent.id, { method, providerRef });
    this.payouts?.recordPaymentSplit(settled);
    this.audit.record({
      userId: user.id,
      action: 'payment.succeeded',
      resourceType: 'payment_intent',
      resourceId: intent.id,
      metadata: { purpose: intent.purpose, amountInr: intent.amount_inr, mock: true, method },
      ctx,
    });
    return settled;
  }

  createIntent(user, { purpose, planCode = null, consultationId = null, amountInr = null, ctx = {} }) {
    if (purpose === 'subscription') {
      const plan = this.findPlan(planCode);
      return this.plansRepo.createPaymentIntent({
        userId: user.id,
        purpose,
        amountInr: plan.price_inr,
        planId: plan.id,
        metadata: { planCode: plan.code },
      });
    }
    if (amountInr == null) throw new ValidationError('amountInr is required for consultation payments');
    return this.plansRepo.createPaymentIntent({
      userId: user.id,
      purpose,
      amountInr: Math.max(0, Math.round(amountInr)),
      consultationId,
      metadata: { mock: true },
    });
  }

  listPayments(user, { limit = 20 } = {}) {
    return this.plansRepo.listIntentsForUser(user.id, { limit }).map((p) => p.toJSON());
  }

  /** Doctors are never paid by patients directly — this is a read model. */
  revenueModel() {
    return { ...REVENUE_MODEL, note: 'Mock payments; the arithmetic — not the money — is real.' };
  }

  static paise = paise;
  static periodOf = periodOf;

  assertSubscribed(user) {
    const ent = this.entitlements(user);
    if (!ent.active) {
      throw new ForbiddenError('This feature needs an active Care+ subscription', 'SUBSCRIPTION_REQUIRED');
    }
    return ent;
  }
}
