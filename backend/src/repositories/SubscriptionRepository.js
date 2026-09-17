import { BaseRepository } from './BaseRepository.js';
import { SubscriptionPlan, Subscription, PaymentIntent } from '../domain/care.js';

/**
 * Subscription catalog, member subscriptions, MOCK payment intents and the
 * revenue ledger. Everything money-related in this build is a simulation:
 * rows are created/updated locally, no gateway is ever contacted.
 */
export class SubscriptionRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'subscriptions';
  }

  // ------------------------------------------------------------------ plans
  /** Idempotent catalog upsert — plans are code-defined, DB-readable. */
  ensurePlan(plan) {
    const now = this.now();
    this.db.run(
      `INSERT INTO subscription_plans
         (id, code, name, tagline, price_inr, interval, consultations_per_month, video_access,
          features, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         name = excluded.name, tagline = excluded.tagline, price_inr = excluded.price_inr,
         interval = excluded.interval, consultations_per_month = excluded.consultations_per_month,
         video_access = excluded.video_access, features = excluded.features,
         sort_order = excluded.sort_order, is_active = 1, updated_at = excluded.updated_at`,
      plan.id,
      plan.code,
      plan.name,
      plan.tagline ?? null,
      plan.priceInr,
      plan.interval,
      plan.consultationsPerMonth,
      plan.videoAccess,
      JSON.stringify(plan.features || []),
      plan.sortOrder ?? 0,
      now,
      now,
    );
  }

  listPlans({ activeOnly = true } = {}) {
    const rows = this.db.all(
      `SELECT * FROM subscription_plans ${activeOnly ? 'WHERE is_active = 1' : ''}
       ORDER BY sort_order ASC, price_inr ASC`,
    );
    return rows.map(SubscriptionPlan.fromRow);
  }

  findPlanByCode(code) {
    return SubscriptionPlan.fromRow(
      this.db.get('SELECT * FROM subscription_plans WHERE code = ?', code),
    );
  }

  findPlanById(id) {
    return SubscriptionPlan.fromRow(
      this.db.get('SELECT * FROM subscription_plans WHERE id = ?', id),
    );
  }

  // ---------------------------------------------------------- subscriptions
  createSubscription({ userId, planId, periodDays, autoRenew = false }) {
    const id = this.id();
    const now = this.now();
    const end = new Date(Date.now() + periodDays * 24 * 3600 * 1000).toISOString();
    this.db.run(
      `INSERT INTO subscriptions
         (id, user_id, plan_id, status, started_at, current_period_end, auto_renew, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      id,
      userId,
      planId,
      now,
      end,
      autoRenew ? 1 : 0,
      now,
      now,
    );
    return this.findById(id);
  }

  findById(id) {
    return Subscription.fromRow(this.db.get('SELECT * FROM subscriptions WHERE id = ?', id));
  }

  /** Latest subscription for a user, newest first (any status). */
  findLatestForUser(userId) {
    return Subscription.fromRow(
      this.db.get(
        'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
        userId,
      ),
    );
  }

  findActiveForUser(userId) {
    return Subscription.fromRow(
      this.db.get(
        `SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
        userId,
      ),
    );
  }

  /** Replace the active subscription (upgrade / renewal) in one step. */
  replaceActive({ userId, planId, periodDays }) {
    return this.db.transaction(() => {
      this.db.run(
        `UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, updated_at = ?
         WHERE user_id = ? AND status = 'active'`,
        this.now(),
        this.now(),
        userId,
      );
      return this.createSubscription({ userId, planId, periodDays });
    });
  }

  cancelActive(userId) {
    const active = this.findActiveForUser(userId);
    if (!active) return null;
    this.db.run(
      `UPDATE subscriptions SET status = 'cancelled', auto_renew = 0, cancelled_at = ?, updated_at = ?
       WHERE id = ?`,
      this.now(),
      this.now(),
      active.id,
    );
    return this.findById(active.id);
  }

  expireStale(nowIso) {
    this.db.run(
      `UPDATE subscriptions SET status = 'expired', updated_at = ?
       WHERE status = 'active' AND current_period_end <= ?`,
      nowIso,
      nowIso,
    );
  }

  // -------------------------------------------------------- payment intents
  createPaymentIntent({
    userId,
    purpose,
    amountInr,
    planId = null,
    consultationId = null,
    metadata = {},
  }) {
    const id = this.id();
    const now = this.now();
    this.db.run(
      `INSERT INTO payment_intents
         (id, user_id, purpose, plan_id, consultation_id, amount_inr, currency, provider,
          status, is_mock, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'INR', 'mock-gateway', 'created', 1, ?, ?)`,
      id,
      userId,
      purpose,
      planId,
      consultationId,
      amountInr,
      JSON.stringify(metadata),
      now,
    );
    return this.findIntentById(id);
  }

  findIntentById(id) {
    return PaymentIntent.fromRow(this.db.get('SELECT * FROM payment_intents WHERE id = ?', id));
  }

  markIntentSucceeded(id, { method = 'upi', providerRef }) {
    this.db.run(
      `UPDATE payment_intents SET status = 'succeeded', method = ?, provider_ref = ?, completed_at = ?
       WHERE id = ? AND status = 'created'`,
      method,
      providerRef,
      this.now(),
      id,
    );
    return this.findIntentById(id);
  }

  markIntentFailed(id, reason) {
    this.db.run(
      `UPDATE payment_intents SET status = 'failed', failure_reason = ?, completed_at = ?
       WHERE id = ? AND status = 'created'`,
      reason,
      this.now(),
      id,
    );
    return this.findIntentById(id);
  }

  listIntentsForUser(userId, { limit = 20 } = {}) {
    return this.db
      .all(
        'SELECT * FROM payment_intents WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
        userId,
        limit,
      )
      .map(PaymentIntent.fromRow);
  }

  // ----------------------------------------------------------- payout ledger
  addLedgerEntry({
    doctorId = null,
    paymentIntentId = null,
    consultationId = null,
    entryType,
    amountPaise,
    period,
    description = null,
    status = 'pending',
  }) {
    const id = this.id();
    this.db.run(
      `INSERT INTO payout_ledger
         (id, doctor_id, payment_intent_id, consultation_id, entry_type, amount_paise, period, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      doctorId,
      paymentIntentId,
      consultationId,
      entryType,
      Math.round(amountPaise),
      period,
      description,
      status,
      this.now(),
    );
    return this.db.get('SELECT * FROM payout_ledger WHERE id = ?', id);
  }

  ledgerForDoctor(doctorId, { period = null, limit = 200 } = {}) {
    const params = [doctorId];
    let where = 'doctor_id = ?';
    if (period) {
      where += ' AND period = ?';
      params.push(period);
    }
    return this.db
      .all(`SELECT * FROM payout_ledger WHERE ${where} ORDER BY created_at DESC LIMIT ?`, ...params, limit)
      .map(rowToLedger);
  }

  ledgerByPeriod(period, { entryType = null, doctorId = null } = {}) {
    const params = [period];
    let where = 'period = ?';
    if (entryType) {
      where += ' AND entry_type = ?';
      params.push(entryType);
    }
    if (doctorId !== null) {
      where += ' AND doctor_id = ?';
      params.push(doctorId);
    }
    return this.db
      .all(`SELECT * FROM payout_ledger WHERE ${where} ORDER BY created_at DESC`, ...params)
      .map(rowToLedger);
  }

  /** Net shorts-pool share per doctor for a period (excludes reversals' zeroes). */
  sharesByDoctor(period) {
    return this.db
      .all(
        `SELECT doctor_id, COALESCE(SUM(amount_paise), 0) AS amount
         FROM payout_ledger
         WHERE period = ? AND entry_type = 'video_pool_share' AND doctor_id IS NOT NULL
         GROUP BY doctor_id
         HAVING amount != 0`,
        period,
      )
      .map((r) => ({ doctorId: r.doctor_id, amountPaise: r.amount }));
  }

  sumLedger(period, entryType, { doctorId = null } = {}) {
    const params = [period, entryType];
    let where = 'period = ? AND entry_type = ?';
    if (doctorId !== null) {
      where += ' AND doctor_id IS ?';
      params.push(doctorId);
    }
    const row = this.db.get(
      `SELECT COALESCE(SUM(amount_paise), 0) AS total FROM payout_ledger WHERE ${where}`,
      ...params,
    );
    return row ? row.total : 0;
  }

  listPeriods() {
    return this.db
      .all('SELECT DISTINCT period FROM payout_ledger ORDER BY period DESC LIMIT 24')
      .map((r) => r.period);
  }
}

function rowToLedger(row) {
  return {
    id: row.id,
    doctorId: row.doctor_id,
    paymentIntentId: row.payment_intent_id,
    consultationId: row.consultation_id,
    entryType: row.entry_type,
    amountPaise: row.amount_paise,
    amountInr: Number((row.amount_paise / 100).toFixed(2)),
    period: row.period,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
  };
}
