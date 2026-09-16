import { BaseRepository } from './BaseRepository.js';
import { RefreshToken } from '../domain/entities.js';
import { plusSeconds } from '../utils/time.js';

export class RefreshTokenRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'refresh_tokens';
  }

  create({ userId, tokenHash, familyId, ttlSec, deviceLabel = null, ip = null, userAgent = null }) {
    const id = this.id();
    this.db.run(
      `INSERT INTO refresh_tokens
        (id, user_id, token_hash, family_id, device_label, created_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      tokenHash,
      familyId,
      deviceLabel,
      this.now(),
      plusSeconds(new Date(), ttlSec),
      ip,
      userAgent,
    );
    return this.findById(id);
  }

  findById(id) {
    return RefreshToken.fromRow(this.db.get('SELECT * FROM refresh_tokens WHERE id = ?', id));
  }

  findByHash(tokenHash) {
    return RefreshToken.fromRow(
      this.db.get('SELECT * FROM refresh_tokens WHERE token_hash = ?', tokenHash),
    );
  }

  /** Mark a single token revoked; optionally record which token replaced it (rotation). */
  revoke(id, replacedBy = null) {
    this.db.run(
      'UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ? AND revoked_at IS NULL',
      this.now(),
      replacedBy,
      id,
    );
  }

  markUsed(id) {
    this.db.run('UPDATE refresh_tokens SET last_used_at = ? WHERE id = ?', this.now(), id);
  }

  /** Revoke every token in a rotation family — reuse-detection sledgehammer. */
  revokeFamily(familyId) {
    this.db.run(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
      this.now(),
      familyId,
    );
  }

  revokeAllForUser(userId) {
    this.db.run(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      this.now(),
      userId,
    );
  }

  countActiveForUser(userId) {
    const row = this.db.get(
      'SELECT COUNT(*) AS c FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?',
      userId,
      this.now(),
    );
    return row.c;
  }
}
