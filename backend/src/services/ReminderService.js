import { ValidationError } from '../common/errors.js';

export const REMINDER_KINDS = ['medication', 'checkup', 'followup', 'report_upload', 'custom'];
const KIND_SET = new Set(REMINDER_KINDS);

/**
 * Health reminders (§10.6 Reminders + §13 Notifications of the product spec).
 *
 * Cost-free by design: no push infrastructure, no background jobs. Clients poll
 * `due()` (or the /due endpoint) and surface due reminders in-app — the same
 * polling pattern already used for trends and milestones. Repeating reminders
 * roll forward when completed instead of spawning rows.
 */
export class ReminderService {
  constructor({ reminderRepository, policyService, auditService }) {
    this.reminders = reminderRepository;
    this.policy = policyService;
    this.audit = auditService;
  }

  create(actor, memberId, data, ctx = {}) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertWrite(actor, member);
    const kind = data?.kind;
    if (!KIND_SET.has(kind)) {
      throw new ValidationError(`kind must be one of: ${REMINDER_KINDS.join(', ')}`);
    }
    const title = typeof data?.title === 'string' ? data.title.trim() : '';
    if (!title) throw new ValidationError('title is required');
    const dueAt = this.requireFutureDate(data?.dueAt);
    const repeat = this.normalizeRepeat(data?.repeatIntervalDays);
    const notes = typeof data?.notes === 'string' && data.notes.trim()
      ? data.notes.trim().slice(0, 2000)
      : null;
    const row = this.reminders.create({
      memberId,
      createdBy: actor.id,
      kind,
      title: title.slice(0, 200),
      notes,
      dueAt,
      repeatIntervalDays: repeat,
    });
    this.audit.record({ userId: actor.id, action: 'reminder.create', resourceType: 'reminder', resourceId: row.id, ctx });
    return row.toJSON();
  }

  list(actor, memberId, query = {}) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertRead(actor, member);
    const kind = query?.kind && KIND_SET.has(query.kind) ? query.kind : null;
    const status = ['pending', 'done', 'dismissed'].includes(query?.status) ? query.status : null;
    const page = Math.max(1, Number(query?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query?.pageSize) || 50));
    const { items, total } = this.reminders.listForMember(memberId, { kind, status, page, pageSize });
    return { items: items.map((r) => r.toJSON()), total, page, pageSize };
  }

  /** Reminders that should surface right now (powers in-app notifications). */
  due(actor, memberId) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertRead(actor, member);
    const items = this.reminders.dueForMember(memberId).map((r) => r.toJSON());
    return { items, count: items.length, checkedAt: new Date().toISOString() };
  }

  update(actor, reminderId, data, ctx = {}) {
    const { reminder } = this.policy.loadReminderWithAccess(actor, this.reminders, reminderId, { write: true });
    const fields = {};
    if (data?.title !== undefined) {
      const title = String(data.title || '').trim();
      if (!title) throw new ValidationError('title cannot be empty');
      fields.title = title.slice(0, 200);
    }
    if (data?.notes !== undefined) {
      fields.notes = data.notes == null ? null : String(data.notes).slice(0, 2000);
    }
    if (data?.dueAt !== undefined) fields.due_at = this.requireFutureDate(data.dueAt);
    if (data?.repeatIntervalDays !== undefined) fields.repeat_interval_days = this.normalizeRepeat(data.repeatIntervalDays);
    if (data?.status !== undefined) {
      if (!['pending', 'done', 'dismissed'].includes(data.status)) {
        throw new ValidationError('status must be pending, done or dismissed');
      }
      fields.status = data.status;
      fields.completed_at = data.status === 'done' ? new Date().toISOString() : null;
      // A repeating reminder rolls forward instead of dying: completing it
      // schedules the next occurrence and keeps it pending.
      if (data.status === 'done' && reminder.repeat_interval_days) {
        const next = new Date(new Date(reminder.due_at).getTime() + reminder.repeat_interval_days * 86400000);
        fields.status = 'pending';
        fields.completed_at = null;
        fields.due_at = next.toISOString();
        fields.snoozed_until = null;
      }
    }
    if (data?.snoozeUntil !== undefined) {
      fields.snoozed_until = data.snoozeUntil == null ? null : this.requireFutureDate(data.snoozeUntil);
    }
    const updated = this.reminders.update(reminderId, fields);
    this.audit.record({ userId: actor.id, action: 'reminder.update', resourceType: 'reminder', resourceId: reminderId, ctx });
    return updated.toJSON();
  }

  remove(actor, reminderId, ctx = {}) {
    this.policy.loadReminderWithAccess(actor, this.reminders, reminderId, { write: true });
    this.reminders.delete(reminderId);
    this.audit.record({ userId: actor.id, action: 'reminder.delete', resourceType: 'reminder', resourceId: reminderId, ctx });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ helpers
  requireFutureDate(value) {
    const t = new Date(value).getTime();
    if (!Number.isFinite(t)) throw new ValidationError('dueAt must be a valid date');
    if (t > Date.now() + 10 * 365 * 86400000) {
      throw new ValidationError('dueAt is implausibly far in the future');
    }
    return new Date(t).toISOString();
  }

  normalizeRepeat(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      throw new ValidationError('repeatIntervalDays must be an integer between 1 and 3650');
    }
    return n;
  }
}
