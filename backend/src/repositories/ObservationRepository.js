import { BaseRepository } from './BaseRepository.js';
import { Observation } from '../domain/entities.js';

export class ObservationRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'observations';
  }

  create({ memberId, createdBy, kind, payload = {}, source = 'manual', observedAt = null }) {
    const id = this.id();
    this.db.run(
      `INSERT INTO observations (id, member_id, created_by, kind, payload, source, observed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      memberId,
      createdBy,
      kind,
      JSON.stringify(payload || {}),
      source,
      observedAt || this.now(),
      this.now(),
    );
    return this.findById(id);
  }

  findById(id) {
    return Observation.fromRow(this.db.get('SELECT * FROM observations WHERE id = ?', id));
  }

  listForMember(memberId, { kind = null, from = null, to = null, page = 1, pageSize = 50 } = {}) {
    const params = [memberId];
    let where = 'member_id = ?';
    if (kind) {
      where += ' AND kind = ?';
      params.push(kind);
    }
    if (from) {
      where += ' AND observed_at >= ?';
      params.push(from);
    }
    if (to) {
      where += ' AND observed_at <= ?';
      params.push(to);
    }
    const total = this.count(where, params);
    const rows = this.db.all(
      `SELECT * FROM observations WHERE ${where} ORDER BY observed_at DESC LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      (page - 1) * pageSize,
    );
    return { items: rows.map(Observation.fromRow), total, page, pageSize };
  }

  latestOfKind(memberId, kind) {
    return Observation.fromRow(
      this.db.get(
        'SELECT * FROM observations WHERE member_id = ? AND kind = ? ORDER BY observed_at DESC LIMIT 1',
        memberId,
        kind,
      ),
    );
  }

  delete(id) {
    this.db.run('DELETE FROM observations WHERE id = ?', id);
  }
}
