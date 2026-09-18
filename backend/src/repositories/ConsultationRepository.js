import { BaseRepository } from './BaseRepository.js';
import { Consultation, MedicinePlan } from '../domain/care.js';

/**
 * Consultations, their message thread, doctor-reviewed medicine plans and the
 * scoped consent grants that decide whether a doctor may read a chart.
 *
 * The grant table is the ONLY path from a doctor to patient data, and every
 * read goes through `findActiveGrant` — a consultation alone never implies
 * chart access.
 */
export class ConsultationRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'consultations';
  }

  create({
    memberId,
    patientUserId,
    doctorId,
    subject,
    question,
    status = 'payment_pending',
    feeInr = 0,
    includedInPlan = false,
    consentScope = [],
    consentExpiresAt = null,
  }) {
    const id = this.id();
    const now = this.now();
    const consented = consentScope.length > 0;
    this.db.run(
      `INSERT INTO consultations
         (id, member_id, patient_user_id, doctor_id, subject, question, status, fee_inr,
          included_in_plan, consent_scope, consent_granted_at, consent_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      memberId,
      patientUserId,
      doctorId,
      subject,
      question,
      status,
      feeInr,
      includedInPlan ? 1 : 0,
      JSON.stringify(consentScope),
      consented ? now : null,
      consentExpiresAt,
      now,
      now,
    );
    if (consented) {
      this.createGrant({
        doctorId,
        memberId,
        consultationId: id,
        scope: consentScope,
        grantedBy: patientUserId,
        expiresAt: consentExpiresAt,
      });
    }
    return this.findById(id);
  }

  findById(id) {
    return Consultation.fromRow(this.db.get('SELECT * FROM consultations WHERE id = ?', id));
  }

  static UPDATABLE = {
    status: 'status',
    paymentIntentId: 'payment_intent_id',
    doctorReply: 'doctor_reply',
    doctorRepliedAt: 'doctor_replied_at',
    closedAt: 'closed_at',
    consentExpiresAt: 'consent_expires_at',
  };

  update(id, fields) {
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(ConsultationRepository.UPDATABLE)) {
      if (!(key in fields) || fields[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(fields[key]);
    }
    if (sets.length === 0) return this.findById(id);
    sets.push('updated_at = ?');
    params.push(this.now(), id);
    this.db.run(`UPDATE consultations SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.findById(id);
  }

  listForDoctor(doctorId, { status = null, page = 1, pageSize = 20 } = {}) {
    const params = [doctorId];
    let where = 'doctor_id = ?';
    if (status) {
      where += ' AND status = ?';
      params.push(status);
    }
    const total = this.count(where, params);
    const rows = this.db.all(
      `SELECT * FROM consultations WHERE ${where}
       ORDER BY CASE status WHEN 'requested' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END, created_at DESC
       LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      (page - 1) * pageSize,
    );
    return { items: rows.map(Consultation.fromRow), total, page, pageSize };
  }

  listForPatient(userId, { page = 1, pageSize = 20 } = {}) {
    const total = this.count('patient_user_id = ?', [userId]);
    const rows = this.db.all(
      'SELECT * FROM consultations WHERE patient_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      userId,
      pageSize,
      (page - 1) * pageSize,
    );
    return { items: rows.map(Consultation.fromRow), total, page, pageSize };
  }

  countForPatientSince(userId, sinceIso, { includedInPlanOnly = true } = {}) {
    const row = this.db.get(
      `SELECT COUNT(*) AS c FROM consultations
       WHERE patient_user_id = ? AND created_at >= ? AND status NOT IN ('cancelled')
       ${includedInPlanOnly ? 'AND included_in_plan = 1' : ''}`,
      userId,
      sinceIso,
    );
    return row ? row.c : 0;
  }

  countForDoctor(doctorId, { statuses = null } = {}) {
    if (!statuses || statuses.length === 0) return this.count('doctor_id = ?', [doctorId]);
    const placeholders = statuses.map(() => '?').join(',');
    return this.count(`doctor_id = ? AND status IN (${placeholders})`, [doctorId, ...statuses]);
  }

  // --------------------------------------------------------------- messages
  addMessage({ consultationId, authorUserId = null, authorRole, kind = 'text', body, metadata = {} }) {
    const id = this.id();
    this.db.run(
      `INSERT INTO consultation_messages
         (id, consultation_id, author_user_id, author_role, kind, body, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      consultationId,
      authorUserId,
      authorRole,
      kind,
      body,
      JSON.stringify(metadata),
      this.now(),
    );
    const row = this.db.get('SELECT * FROM consultation_messages WHERE id = ?', id);
    return {
      id: row.id,
      consultationId: row.consultation_id,
      authorUserId: row.author_user_id,
      authorRole: row.author_role,
      kind: row.kind,
      body: row.body,
      metadata: safeParse(row.metadata),
      createdAt: row.created_at,
    };
  }

  listMessages(consultationId) {
    return this.db
      .all(
        'SELECT * FROM consultation_messages WHERE consultation_id = ? ORDER BY created_at ASC, rowid ASC',
        consultationId,
      )
      .map((row) => ({
        id: row.id,
        authorUserId: row.author_user_id,
        authorRole: row.author_role,
        kind: row.kind,
        body: row.body,
        metadata: safeParse(row.metadata),
        createdAt: row.created_at,
      }));
  }

  // ---------------------------------------------------------- consent grants
  createGrant({ doctorId, memberId, consultationId, scope, grantedBy, expiresAt }) {
    const id = this.id();
    this.db.run(
      `INSERT INTO doctor_access_grants
         (id, doctor_id, member_id, consultation_id, scope, granted_by, granted_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      doctorId,
      memberId,
      consultationId ?? null,
      JSON.stringify(scope || []),
      grantedBy,
      this.now(),
      expiresAt,
    );
    return this.db.get('SELECT * FROM doctor_access_grants WHERE id = ?', id);
  }

  findActiveGrant({ doctorId, memberId, nowIso }) {
    const row = this.db.get(
      `SELECT * FROM doctor_access_grants
       WHERE doctor_id = ? AND member_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY granted_at DESC LIMIT 1`,
      doctorId,
      memberId,
      nowIso,
    );
    return row ? { ...row, scope: safeParse(row.scope) } : null;
  }

  listGrantsForMember(memberId, { activeOnly = true, nowIso = null } = {}) {
    const params = [memberId];
    let where = 'member_id = ?';
    if (activeOnly) {
      where += ' AND revoked_at IS NULL AND expires_at > ?';
      params.push(nowIso);
    }
    return this.db
      .all(`SELECT * FROM doctor_access_grants WHERE ${where} ORDER BY granted_at DESC`, ...params)
      .map((row) => ({
        id: row.id,
        doctorId: row.doctor_id,
        memberId: row.member_id,
        consultationId: row.consultation_id,
        scope: safeParse(row.scope),
        grantedBy: row.granted_by,
        grantedAt: row.granted_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        active: !row.revoked_at && new Date(row.expires_at).getTime() > Date.now(),
      }));
  }

  revokeByConsultation(consultationId, { memberId = null } = {}) {
    const params = [this.now(), consultationId];
    let sql =
      `UPDATE doctor_access_grants SET revoked_at = ?
       WHERE consultation_id = ? AND revoked_at IS NULL`;
    if (memberId) {
      sql += ' AND member_id = ?';
      params.push(memberId);
    }
    const result = this.db.run(sql, ...params);
    return result.changes ?? 0;
  }

  // ---------------------------------------------------------- medicine plans
  createMedicinePlan({ consultationId, memberId, doctorId, aiDraft, finalItems = [], doctorNote = null, status = 'draft', acknowledgements = [] }) {
    const id = this.id();
    const now = this.now();
    this.db.run(
      `INSERT INTO medicine_plans
         (id, consultation_id, member_id, doctor_id, status, ai_draft, final_items, doctor_note,
          acknowledgements, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      consultationId,
      memberId,
      doctorId,
      status,
      JSON.stringify(aiDraft || {}),
      JSON.stringify(finalItems),
      doctorNote,
      JSON.stringify(acknowledgements),
      status === 'approved' ? now : null,
      now,
      now,
    );
    return this.findMedicinePlanById(id);
  }

  findMedicinePlanById(id) {
    return MedicinePlan.fromRow(this.db.get('SELECT * FROM medicine_plans WHERE id = ?', id));
  }

  findLatestMedicinePlan(consultationId) {
    return MedicinePlan.fromRow(
      this.db.get(
        'SELECT * FROM medicine_plans WHERE consultation_id = ? ORDER BY created_at DESC LIMIT 1',
        consultationId,
      ),
    );
  }

  updateMedicinePlan(id, { status, finalItems, doctorNote, acknowledgements }) {
    const now = this.now();
    this.db.run(
      `UPDATE medicine_plans SET status = ?, final_items = ?, doctor_note = ?, acknowledgements = ?,
       approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END, updated_at = ?
       WHERE id = ?`,
      status,
      JSON.stringify(finalItems || []),
      doctorNote ?? null,
      JSON.stringify(acknowledgements || []),
      status,
      now,
      now,
      id,
    );
    return this.findMedicinePlanById(id);
  }
}

function safeParse(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return parsed == null ? [] : parsed;
  } catch {
    return [];
  }
}
