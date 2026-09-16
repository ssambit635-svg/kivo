/**
 * Security/audit trail. Best-effort by design: an audit write failure is
 * logged, but never crashes the request path.
 */
export class AuditService {
  constructor(auditLogRepository) {
    this.auditLog = auditLogRepository;
  }

  record({ userId = null, action, resourceType = null, resourceId = null, outcome = 'success', metadata = {}, ctx = {} }) {
    try {
      this.auditLog.create({
        userId,
        ip: ctx.ip || null,
        userAgent: ctx.userAgent || null,
        action,
        resourceType,
        resourceId,
        outcome,
        metadata,
      });
    } catch (err) {
      console.error('AUDIT_WRITE_FAILURE', err.message);
    }
  }
}

/** Extract request context for audit entries. */
export function ctxFromReq(req) {
  return {
    ip: req.ip || req.socket?.remoteAddress || null,
    userAgent: req.headers['user-agent'] || null,
  };
}
