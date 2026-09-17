import { BaseRepository } from './BaseRepository.js';

/**
 * Product roles (patient / doctor / admin). Roles are GRANTED by the platform
 * — never accepted from a request body — and are re-read on every request so
 * a suspension takes effect immediately (no waiting for a token to expire).
 */
export class RoleRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'user_roles';
  }

  grant(userId, role, { grantedBy = null } = {}) {
    this.db.run(
      `INSERT INTO user_roles (user_id, role, status, granted_by, granted_at, revoked_at)
       VALUES (?, ?, 'active', ?, ?, NULL)
       ON CONFLICT(user_id, role) DO UPDATE SET status = 'active', revoked_at = NULL`,
      userId,
      role,
      grantedBy,
      this.now(),
    );
    return this.rolesFor(userId);
  }

  revoke(userId, role) {
    this.db.run(
      `UPDATE user_roles SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND role = ? AND status = 'active'`,
      this.now(),
      userId,
      role,
    );
    return this.rolesFor(userId);
  }

  rolesFor(userId) {
    return this.db
      .all(
        `SELECT role FROM user_roles WHERE user_id = ? AND status = 'active' ORDER BY role`,
        userId,
      )
      .map((r) => r.role);
  }

  hasRole(userId, role) {
    return !!this.db.get(
      `SELECT 1 AS ok FROM user_roles WHERE user_id = ? AND role = ? AND status = 'active' LIMIT 1`,
      userId,
      role,
    );
  }

  listByRole(role) {
    return this.db.all(
      `SELECT user_id, granted_at FROM user_roles WHERE role = ? AND status = 'active' ORDER BY granted_at`,
      role,
    );
  }
}
