import { BaseRepository } from './BaseRepository.js';
import { Member } from '../domain/Member.js';

export class MemberRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'members';
  }

  create({ userId, name, relationship = 'other', dob = null, sex = null, heightCm = null, familyHistory = {} }) {
    const id = this.id();
    const now = this.now();
    this.db.run(
      `INSERT INTO members (id, user_id, name, relationship, dob, sex, height_cm, family_history, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      name,
      relationship,
      dob,
      sex,
      heightCm,
      JSON.stringify(familyHistory || {}),
      now,
      now,
    );
    return this.findById(id);
  }

  findById(id) {
    return Member.fromRow(this.db.get('SELECT * FROM members WHERE id = ?', id));
  }

  listOwned(userId) {
    return this.db
      .all('SELECT * FROM members WHERE user_id = ? ORDER BY created_at ASC', userId)
      .map(Member.fromRow);
  }

  /** Members shared TO this user by other accounts, with access level. */
  listSharedWith(userId) {
    return this.db
      .all(
        `SELECT m.*, s.permission AS shared_permission
         FROM member_shares s JOIN members m ON m.id = s.member_id
         WHERE s.user_id = ? ORDER BY m.created_at ASC`,
        userId,
      )
      .map((row) => ({ member: Member.fromRow(row), permission: row.shared_permission }));
  }

  update(id, fields) {
    const allowed = ['name', 'relationship', 'dob', 'sex', 'height_cm', 'family_history'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (key in fields) {
        sets.push(`${key} = ?`);
        params.push(key === 'family_history' ? JSON.stringify(fields[key] || {}) : fields[key]);
      }
    }
    if (sets.length === 0) return this.findById(id);
    sets.push('updated_at = ?');
    params.push(this.now(), id);
    this.db.run(`UPDATE members SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.findById(id);
  }

  delete(id) {
    this.db.run('DELETE FROM members WHERE id = ?', id);
  }

  // --- shares ------------------------------------------------------------
  setShare(memberId, userId, permission) {
    this.db.run(
      `INSERT INTO member_shares (member_id, user_id, permission, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(member_id, user_id) DO UPDATE SET permission = excluded.permission`,
      memberId,
      userId,
      permission,
      this.now(),
    );
  }

  removeShare(memberId, userId) {
    const res = this.db.run(
      'DELETE FROM member_shares WHERE member_id = ? AND user_id = ?',
      memberId,
      userId,
    );
    return res.changes > 0;
  }

  getShare(memberId, userId) {
    const row = this.db.get(
      'SELECT permission FROM member_shares WHERE member_id = ? AND user_id = ?',
      memberId,
      userId,
    );
    return row ? row.permission : null;
  }

  listShares(memberId) {
    return this.db.all(
      `SELECT s.user_id, s.permission, s.created_at, u.email, u.display_name
       FROM member_shares s JOIN users u ON u.id = s.user_id
       WHERE s.member_id = ? ORDER BY s.created_at ASC`,
      memberId,
    );
  }
}
