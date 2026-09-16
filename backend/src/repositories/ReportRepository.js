import { BaseRepository } from './BaseRepository.js';
import { Report } from '../domain/entities.js';

export class ReportRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'reports';
  }

  create({ memberId, uploadedBy, originalName = null, mimeType = null, storagePath = null, reportDate = null, notes = null }) {
    const id = this.id();
    const now = this.now();
    this.db.run(
      `INSERT INTO reports
        (id, member_id, uploaded_by, original_name, mime_type, storage_path, status, report_date, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?, ?, ?)`,
      id,
      memberId,
      uploadedBy,
      originalName,
      mimeType,
      storagePath,
      reportDate,
      notes,
      now,
      now,
    );
    return this.findById(id);
  }

  findById(id) {
    return Report.fromRow(this.db.get('SELECT * FROM reports WHERE id = ?', id));
  }

  listByMember(memberId, { page = 1, pageSize = 20, status = null } = {}) {
    const offset = (page - 1) * pageSize;
    const params = [memberId];
    let where = 'member_id = ?';
    if (status) {
      where += ' AND status = ?';
      params.push(status);
    }
    const total = this.count(where, params);
    const rows = this.db.all(
      `SELECT * FROM reports WHERE ${where}
       ORDER BY COALESCE(report_date, created_at) DESC LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      offset,
    );
    return { items: rows.map(Report.fromRow), total, page, pageSize };
  }

  setOcrResult(id, { status, ocrText = null, ocrProvider = null, ocrConfidence = null, ocrError = null, reportDate = undefined }) {
    const sets = 'status = ?, ocr_text = ?, ocr_provider = ?, ocr_confidence = ?, ocr_error = ?, updated_at = ?';
    const params = [status, ocrText, ocrProvider, ocrConfidence, ocrError, this.now(), id];
    this.db.run(`UPDATE reports SET ${sets} WHERE id = ?`, ...params);
    if (reportDate !== undefined) {
      this.db.run('UPDATE reports SET report_date = ?, updated_at = ? WHERE id = ?', reportDate, this.now(), id);
    }
    return this.findById(id);
  }

  updateMeta(id, { reportDate, notes }) {
    if (reportDate !== undefined) {
      this.db.run('UPDATE reports SET report_date = ?, updated_at = ? WHERE id = ?', reportDate, this.now(), id);
    }
    if (notes !== undefined) {
      this.db.run('UPDATE reports SET notes = ?, updated_at = ? WHERE id = ?', notes, this.now(), id);
    }
    return this.findById(id);
  }

  markVerified(id) {
    this.db.run(
      `UPDATE reports SET status = 'verified', verified_at = ?, updated_at = ? WHERE id = ?`,
      this.now(),
      this.now(),
      id,
    );
    return this.findById(id);
  }

  reopenReview(id) {
    this.db.run(
      `UPDATE reports SET status = 'needs_review', verified_at = NULL, updated_at = ? WHERE id = ?`,
      this.now(),
      id,
    );
    return this.findById(id);
  }

  setStatus(id, status) {
    this.db.run('UPDATE reports SET status = ?, updated_at = ? WHERE id = ?', status, this.now(), id);
    return this.findById(id);
  }

  delete(id) {
    this.db.run('DELETE FROM reports WHERE id = ?', id);
  }
}
