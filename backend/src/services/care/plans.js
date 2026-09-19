/**
 * Care-network catalog: subscription plans and the honest revenue model that
 * pays doctors. Pure data + pure helpers — no DB, no side effects.
 *
 * ── Why a doctor uploads shorts ───────────────────────────────────────────
 * A doctor's fee does not scale with their time. A 45-second short answers one
 * recurring doubt ("does cracking a knuckle cause arthritis?") for thousands of
 * patients, so the platform routes a slice of every subscription into a video
 * pool that is split by WATCHED SECONDS. Doctors therefore get paid for reach,
 * get a verified public identity, and save clinic time on questions that never
 * needed a 20-minute appointment.
 *
 * ── Mock billing ──────────────────────────────────────────────────────────
 * No gateway exists in this build. Plans, payment intents and the ledger are
 * real rows in the DB so the business logic is demonstrable and testable, but
 * every payment row is stamped `is_mock = 1`, and no card/UPI credential is
 * ever collected, transmitted or stored.
 */

export const PLANS = [
  {
    id: 'plan-free',
    code: 'free',
    name: 'Free twin',
    tagline: 'Your digital health twin, forever free',
    priceInr: 0,
    interval: 'month',
    consultationsPerMonth: 0,
    videoAccess: 'preview',
    features: [
      'Unlimited report scans + health twin',
      'Trends, health score and milestones',
      'Free preview of doctor shorts',
      'Ask-the-Twin questions on your own data',
    ],
    sortOrder: 0,
  },
  {
    id: 'plan-care-monthly',
    code: 'care_monthly',
    name: 'kivo care+ (monthly)',
    tagline: 'A doctor on your chart, every month',
    priceInr: 199,
    interval: 'month',
    consultationsPerMonth: 4,
    videoAccess: 'full',
    features: [
      '4 async doctor consultations a month',
      'Full doctor shorts library (unlimited)',
      'Chart shared with the doctor only when you book',
      'Priority in the consultation queue',
    ],
    sortOrder: 1,
  },
  {
    id: 'plan-care-yearly',
    code: 'care_yearly',
    name: 'kivo care+ (yearly)',
    tagline: 'Best value — two months free',
    priceInr: 1499,
    interval: 'year',
    consultationsPerMonth: 4,
    videoAccess: 'full',
    features: [
      'Everything in Care+ monthly',
      '48 consultations a year (4/month)',
      'Full shorts library + yearly health review',
      'Family member add-on at no extra cost',
    ],
    sortOrder: 2,
  },
];

export const FREE_VIDEO_ACCESS = 'preview';

/**
 * Where every rupee goes. Used by PayoutService and shown to doctors
 * verbatim in their earnings screen — no hidden cuts.
 */
export const REVENUE_MODEL = {
  // Per-consultation payment (patient pays the doctor's fee for one consult).
  consultDoctorShare: 0.7,
  consultPlatformShare: 0.3,
  // Subscription rupee split (mock payments, real arithmetic).
  subscriptionVideoPool: 0.25, // funds the monthly shorts pool
  subscriptionConsultPool: 0.35, // funds plan-included consultations
  subscriptionPlatform: 0.4,
  // Guards the monthly arithmetic against rounding drift.
  rounding: 'largest-remainder',
};

export function planPeriodDays(plan) {
  return plan.interval === 'year' ? 365 : 30;
}

export function planMonthlyConsultationQuota(plan) {
  if (!plan) return 0;
  return plan.interval === 'year' ? plan.consultationsPerMonth : plan.consultations_per_month ?? plan.consultationsPerMonth;
}

/** Auto-renew demo: exactly one period forward from `from`. */
export function nextPeriodEnd(plan, from = new Date()) {
  return new Date(from.getTime() + planPeriodDays(plan) * 24 * 3600 * 1000).toISOString();
}

export function periodOf(iso) {
  return String(iso).slice(0, 7); // YYYY-MM
}

export function paise(inr) {
  return Math.round(Number(inr) * 100);
}

export function rupees(paiseValue) {
  return Number((Number(paiseValue) / 100).toFixed(2));
}
