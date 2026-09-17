import fs from 'node:fs';
import { UnauthorizedError, ValidationError } from '../common/errors.js';

export const CONSENT_VERSION = '1.0';

/**
 * User-controlled data rights (§14 of the product spec): full export and full
 * account deletion. Export contains everything the account owns — profile,
 * consent record, members, reports, lab values, observations, reminders —
 * and NEVER secrets (no password hash, no token hashes).
 *
 * Deletion removes the account and cascades to all owned health data plus
 * uploaded files. Audit rows are append-only system records without health
 * values; they are retained without the deleted user's id (null-ed) so the
 * security trail keeps its shape while the account disappears.
 */
export class PrivacyService {
  constructor({
    userRepository, memberRepository, reportRepository, labResultRepository,
    observationRepository, reminderRepository, refreshTokenRepository,
    auditLogRepository, passwordService, auditService, db,
  }) {
    this.users = userRepository;
    this.members = memberRepository;
    this.reports = reportRepository;
    this.labs = labResultRepository;
    this.observations = observationRepository;
    this.reminders = reminderRepository;
    this.refreshTokens = refreshTokenRepository;
    this.auditLog = auditLogRepository;
    this.passwords = passwordService;
    this.audit = auditService;
    this.db = db;
  }

  /** Complete portable export of everything the account owns. */
  exportFor(actor, ctx = {}) {
    const user = this.users.findById(actor.id);
    if (!user) throw new UnauthorizedError('Account not found', 'UNAUTHORIZED');

    const members = this.members.listOwned(actor.id);
    const memberIds = members.map((m) => m.id);

    const reports = [];
    const labResults = [];
    const observations = [];
    const reminders = [];
    for (const memberId of memberIds) {
      const { items } = this.reports.listByMember(memberId, { page: 1, pageSize: 10000 });
      for (const r of items) {
        reports.push(r.toJSON({ includeOcrText: true }));
        for (const lab of this.labs.listByReport(r.id)) labResults.push(lab.toJSON());
      }
      observations.push(
        ...this.observations.listForMember(memberId, { page: 1, pageSize: 10000 }).items.map((o) => o.toJSON()),
      );
      if (this.reminders) {
        reminders.push(
          ...this.reminders.listForMember(memberId, { page: 1, pageSize: 10000 }).items.map((o) => o.toJSON()),
        );
      }
    }

    this.audit.record({ userId: actor.id, action: 'privacy.export', resourceType: 'user', resourceId: actor.id, ctx });

    return {
      exportedAt: new Date().toISOString(),
      format: 'medtwin-export/1',
      user: {
        ...user.toJSON(),
        consentedAt: user.consented_at ?? null,
        consentVersion: user.consent_version ?? null,
      },
      members: members.map((m) => m.toJSON('owner')),
      reports,
      labResults,
      observations,
      reminders,
      counts: {
        members: members.length,
        reports: reports.length,
        labResults: labResults.length,
        observations: observations.length,
        reminders: reminders.length,
      },
      notice: 'This export contains your health data. Store it securely and share it only with people you trust.',
    };
  }

  /**
   * Delete the account and all its data. Requires the current password as an
   * explicit confirmation gesture (mirrors change-password safety).
   */
  deleteAccount(actor, { password }, ctx = {}) {
    if (!password) throw new ValidationError('Current password is required to delete your account');
    const user = this.users.findById(actor.id);
    if (!user) throw new UnauthorizedError('Account not found', 'UNAUTHORIZED');
    if (!this.passwords.verify(password, user.password_hash)) {
      this.audit.record({ userId: user.id, action: 'privacy.delete', outcome: 'failure', metadata: { reason: 'bad_password' }, ctx });
      throw new UnauthorizedError('Current password is incorrect', 'INVALID_CREDENTIALS');
    }

    // Collect uploaded files first — DB rows cascade, disk files do not.
    const storagePaths = [];
    for (const m of this.members.listOwned(actor.id)) {
      const { items } = this.reports.listByMember(m.id, { page: 1, pageSize: 10000 });
      for (const r of items) {
        if (r.storage_path) storagePaths.push(r.storage_path);
      }
    }

    this.audit.record({ userId: actor.id, action: 'privacy.delete', resourceType: 'user', resourceId: actor.id, ctx });

    this.db.transaction(() => {
      this.refreshTokens.revokeAllForUser(actor.id);
      // Detach audit rows from the deleted identity (the security trail keeps
      // its shape; the account itself disappears).
      this.db.run('UPDATE audit_log SET user_id = NULL WHERE user_id = ?', actor.id);
      this.db.run('DELETE FROM users WHERE id = ?', actor.id);
    });

    for (const p of storagePaths) {
      try {
        if (p && fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* file cleanup is best-effort */
      }
    }

    return { deleted: true, removedFiles: storagePaths.length };
  }
}
