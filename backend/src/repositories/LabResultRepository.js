import { BaseRepository } from './BaseRepository.js';
import { LabResult } from '../domain/entities.js';

export class LabResultRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'lab_results';
  }

  create({
    reportId, memberId, code, testName, value = null, valueText = null, unit = null,
    refLow = null, refHigh = null, confidence = null, rawLine = null, measuredAt, verified = 0,
    suspicious = 0, suspiciousReason = null, loinc = null, panel = null,
    heuristicConfidence = null, rangeSource = null,
  }) {
    const id = this.id();
    const now = this.now();
    this.db.run(
      `INSERT INTO lab_results
        (id, report_id, member_id, code, test_name, value, value_text, unit, ref_low, ref_high,
         confidence, raw_line, measured_at, verified, suspicious, suspicious_reason, loinc, panel,
         heuristic_confidence, range_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      reportId,
      memberId,
      code,
      testName,
      value,
      valueText,
      unit,
      refLow,
      refHigh,
      confidence,
      rawLine,
      measuredAt,
      verified ? 1 : 0,
      suspicious ? 1 : 0,
      suspiciousReason,
      loinc,
      panel,
      heuristicConfidence,
      rangeSource,
      now,
      now,
    );
    return this.findById(id);
  }

  createBatch(items) {
    return this.db.transaction(() => items.map((item) => this.create(item)));
  }

  findById(id) {
    return LabResult.fromRow(this.db.get('SELECT * FROM lab_results WHERE id = ?', id));
  }

  listByReport(reportId) {
    return this.db
      .all('SELECT * FROM lab_results WHERE report_id = ? ORDER BY created_at ASC', reportId)
      .map(LabResult.fromRow);
  }

  update(id, fields) {
    const allowed = ['value', 'value_text', 'unit', 'ref_low', 'ref_high', 'measured_at', 'code', 'test_name'];
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
    this.db.run(`UPDATE lab_results SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.findById(id);
  }

  setVerifiedForReport(reportId, ids = null) {
    if (ids && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      this.db.run(
        `UPDATE lab_results SET verified = 1, updated_at = ? WHERE report_id = ? AND id IN (${placeholders})`,
        this.now(),
        reportId,
        ...ids,
      );
    } else {
      this.db.run(
        'UPDATE lab_results SET verified = 1, updated_at = ? WHERE report_id = ?',
        this.now(),
        reportId,
      );
    }
  }

  setUnverifiedForReport(reportId) {
    this.db.run(
      'UPDATE lab_results SET verified = 0, updated_at = ? WHERE report_id = ?',
      this.now(),
      reportId,
    );
  }

  /**
   * Verified-only marker series for trend/risk engines — the safety rule
   * ("unverified OCR output is never treated as fact") lives in this WHERE clause.
   */
  seriesForMember(memberId, code, { verifiedOnly = true } = {}) {
    const rows = this.db.all(
      `SELECT * FROM lab_results
       WHERE member_id = ? AND code = ? AND value IS NOT NULL ${verifiedOnly ? 'AND verified = 1' : ''}
       ORDER BY measured_at ASC`,
      memberId,
      code,
    );
    return rows.map(LabResult.fromRow);
  }

  latestForMember(memberId, code, { verifiedOnly = true } = {}) {
    const row = this.db.get(
      `SELECT * FROM lab_results
       WHERE member_id = ? AND code = ? AND value IS NOT NULL ${verifiedOnly ? 'AND verified = 1' : ''}
       ORDER BY measured_at DESC LIMIT 1`,
      memberId,
      code,
    );
    return LabResult.fromRow(row);
  }

  /** Every verified numeric value for a member, oldest first (Health Score timeline input). */
  verifiedValuesForMember(memberId) {
    const rows = this.db.all(
      `SELECT * FROM lab_results
       WHERE member_id = ? AND verified = 1 AND value IS NOT NULL
       ORDER BY measured_at ASC`,
      memberId,
    );
    return rows.map(LabResult.fromRow);
  }

  /** Distinct measurement dates of verified values, oldest first (milestone span input). */
  verifiedMeasuredDates(memberId) {
    return this.db
      .all(
        `SELECT DISTINCT measured_at AS d FROM lab_results
         WHERE member_id = ? AND verified = 1 AND value IS NOT NULL
         ORDER BY d ASC`,
        memberId,
      )
      .map((r) => r.d);
  }

  codesWithVerifiedData(memberId, minPoints = 2) {
    return this.db
      .all(
        `SELECT code, COUNT(*) AS n FROM lab_results
         WHERE member_id = ? AND verified = 1 AND value IS NOT NULL
         GROUP BY code HAVING n >= ? ORDER BY code ASC`,
        memberId,
        minPoints,
      )
      .map((r) => r.code);
  }

  delete(id) {
    this.db.run('DELETE FROM lab_results WHERE id = ?', id);
  }
}
