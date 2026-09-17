import { BaseRepository } from './BaseRepository.js';
import { User } from '../domain/User.js';

export class UserRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'users';
  }

  create({ email, displayName, passwordHash, role = 'user' }) {
    const id = this.id();
    const now = this.now();
    // Registration records processing consent (§14): creating the account is
    // the consent gesture; the timestamp + version travel with data exports.
    this.db.run(
      `INSERT INTO users (id, email, display_name, password_hash, role, status, consented_at, consent_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, '1.0', ?, ?)`,
      id,
      email.toLowerCase(),
      displayName,
      passwordHash,
      role,
      now,
      now,
      now,
    );
    return this.findById(id);
  }

  findById(id) {
    return User.fromRow(this.db.get('SELECT * FROM users WHERE id = ?', id));
  }

  findByEmail(email) {
    return User.fromRow(
      this.db.get('SELECT * FROM users WHERE email = ?', String(email).toLowerCase()),
    );
  }

  emailExists(email) {
    return !!this.db.get('SELECT id FROM users WHERE email = ?', String(email).toLowerCase());
  }

  recordLoginSuccess(id) {
    this.db.run(
      `UPDATE users SET failed_login_attempts = 0, lockout_until = NULL,
       last_login_at = ?, updated_at = ? WHERE id = ?`,
      this.now(),
      this.now(),
      id,
    );
  }

  recordLoginFailure(id, maxAttempts, lockoutMinutes) {
    const user = this.findById(id);
    if (!user) return;
    const attempts = user.failed_login_attempts + 1;
    const lockoutUntil =
      attempts >= maxAttempts
        ? new Date(Date.now() + lockoutMinutes * 60 * 1000).toISOString()
        : null;
    this.db.run(
      'UPDATE users SET failed_login_attempts = ?, lockout_until = ?, updated_at = ? WHERE id = ?',
      attempts,
      lockoutUntil,
      this.now(),
      id,
    );
    return { attempts, lockoutUntil };
  }

  resetFailures(id) {
    this.db.run(
      'UPDATE users SET failed_login_attempts = 0, lockout_until = NULL, updated_at = ? WHERE id = ?',
      this.now(),
      id,
    );
  }

  updatePassword(id, passwordHash) {
    this.db.run(
      `UPDATE users SET password_hash = ?, token_version = token_version + 1,
       failed_login_attempts = 0, lockout_until = NULL, updated_at = ? WHERE id = ?`,
      passwordHash,
      this.now(),
      id,
    );
  }

  updateDisplayName(id, displayName) {
    this.db.run(
      'UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?',
      displayName,
      this.now(),
      id,
    );
    return this.findById(id);
  }

  setStatus(id, status) {
    this.db.run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', status, this.now(), id);
    return this.findById(id);
  }

  bumpTokenVersion(id) {
    this.db.run(
      'UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?',
      this.now(),
      id,
    );
  }

  /** Admin user administration — never exposes password hashes via User entity. */
  list({ page = 1, pageSize = 20, q = null } = {}) {
    const offset = (page - 1) * pageSize;
    const params = [];
    let where = '1=1';
    if (q) {
      where += ' AND (email LIKE ? OR display_name LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    const total = this.count(where, params);
    const rows = this.db.all(
      `SELECT * FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      offset,
    );
    return { items: rows.map(User.fromRow), total, page, pageSize };
  }
}
