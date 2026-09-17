import { BaseRepository } from './BaseRepository.js';
import { Reminder } from '../domain/entities.js';

export class ReminderRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'reminders';
  }

  create({ memberId, createdBy, kind, title, notes = null, dueAt, repeatIntervalDays = null }) {
    const id = this.id();
    const now = this.now();
    this.db.run(
      `INSERT INTO reminders (id, member_id, created_by, kind, title, notes, due_at,
        repeat_interval_days, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      memberId,
      createdBy,
      kind,
      title,
      notes,
      dueAt,
      repeatIntervalDays,
      now,
      now,
    );
    return this.findById(id);
  }

  findById(id) {
    return Reminder.fromRow(this.db.get('SELECT * FROM reminders WHERE id = ?', id));
  }

  listForMember(memberId, { kind = null, status = null, page = 1, pageSize = 50 } = {}) {
    const params = [memberId];
    let where = 'member_id = ?';
    if (kind) {
      where += ' AND kind = ?';
      params.push(kind);
    }
    if (status) {
      where += ' AND status = ?';
      params.push(status);
    }
    const total = this.count(where, params);
    const rows = this.db.all(
      `SELECT * FROM reminders WHERE ${where} ORDER BY due_at ASC LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      (page - 1) * pageSize,
    );
    return { items: rows.map(Reminder.fromRow), total, page, pageSize };
  }

  /** Pending reminders whose due time has passed and which are not snoozed. */
  dueForMember(memberId, at = null) {
    const now = at || this.now();
    return this.db
      .all(
        `SELECT * FROM reminders
         WHERE member_id = ? AND status = 'pending' AND due_at <= ?
           AND (snoozed_until IS NULL OR snoozed_until <= ?)
         ORDER BY due_at ASC`,
        memberId,
        now,
        now,
      )
      .map(Reminder.fromRow);
  }

  update(id, fields) {
    const allowed = ['title', 'notes', 'due_at', 'repeat_interval_days', 'status', 'snoozed_until', 'completed_at'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (key in fields) {
        sets.push(`${key} = ?`);
        params.push(fields[key]);
      }
    }
    if (sets.length === 0) return this.findById(id);
    sets.push('updated_at = ?');
    params.push(this.now(), id);
    this.db.run(`UPDATE reminders SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.findById(id);
  }

  delete(id) {
    this.db.run('DELETE FROM reminders WHERE id = ?', id);
  }
}
