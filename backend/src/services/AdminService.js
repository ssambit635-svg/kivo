import { NotFoundError, ValidationError } from '../common/errors.js';

/**
 * Platform administration. Least privilege by policy: admins can manage
 * accounts and read the audit trail, but they do NOT gain access to
 * members' health data (PolicyService never grants admin that path).
 */
export class AdminService {
  constructor({ userRepository, refreshTokenRepository, auditLogRepository, policyService, auditService }) {
    this.users = userRepository;
    this.refreshTokens = refreshTokenRepository;
    this.auditLog = auditLogRepository;
    this.policy = policyService;
    this.audit = auditService;
  }

  listUsers(actor, query) {
    this.policy.assertAdmin(actor);
    const { items, total, page, pageSize } = this.users.list(query);
    return { items: items.map((u) => u.toJSON()), total, page, pageSize };
  }

  setUserStatus(actor, targetUserId, status, ctx = {}) {
    this.policy.assertAdmin(actor);
    if (!['active', 'disabled'].includes(status)) {
      throw new ValidationError("status must be 'active' or 'disabled'");
    }
    const target = this.users.findById(targetUserId);
    if (!target) throw new NotFoundError('User not found');
    if (target.id === actor.id && status === 'disabled') {
      throw new ValidationError('You cannot disable your own admin account');
    }
    const updated = this.users.setStatus(targetUserId, status);
    if (status === 'disabled') {
      this.refreshTokens.revokeAllForUser(targetUserId);
      this.users.bumpTokenVersion(targetUserId);
    }
    this.audit.record({
      userId: actor.id, action: `admin.user_${status}`, resourceType: 'user', resourceId: targetUserId, ctx,
    });
    return updated.toJSON();
  }

  listAudit(actor, query) {
    this.policy.assertAdmin(actor);
    const { items, total, page, pageSize } = this.auditLog.list(query);
    return { items: items.map((e) => e.toJSON()), total, page, pageSize };
  }
}
