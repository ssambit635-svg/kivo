import { BaseRepository } from './BaseRepository.js';
import { AuditEvent } from '../domain/entities.js';

export class AuditLogRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'audit_log';
  }

  create({ userId = null, ip = null, userAgent = null, action, resourceType = null, resourceId = null, outcome = 'success', metadata = {} }) {
    const id = this.id();
    this.db.run(
      `INSERT INTO audit_log (id, user_id, actor_ip, user_agent, action, resource_type, resource_id, outcome, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      ip,
      userAgent,
      action,
      resourceType,
      resourceId,
      outcome,
      JSON.stringify(metadata || {}),
      this.now(),
    );
    return id;
  }

  /** Earliest matching audit event (e.g. "was a doctor summary ever generated for this member?"). */
  firstForAction({ action, resourceType = null, resourceId = null }) {
    const params = [action];
    let where = 'action = ?';
    if (resourceType) {
      where += ' AND resource_type = ?';
      params.push(resourceType);
    }
    if (resourceId) {
      where += ' AND resource_id = ?';
      params.push(resourceId);
    }
    const row = this.db.get(`SELECT * FROM audit_log WHERE ${where} ORDER BY created_at ASC LIMIT 1`, ...params);
    return AuditEvent.fromRow(row);
  }

  list({ userId = null, action = null, page = 1, pageSize = 50 } = {}) {
    const params = [];
    let where = '1=1';
    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }
    if (action) {
      where += ' AND action = ?';
      params.push(action);
    }
    const total = this.count(where, params);
    const rows = this.db.all(
      `SELECT * FROM audit_log WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      (page - 1) * pageSize,
    );
    return { items: rows.map(AuditEvent.fromRow), total, page, pageSize };
  }
}
