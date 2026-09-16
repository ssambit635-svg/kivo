import { ForbiddenError, NotFoundError } from '../common/errors.js';

/**
 * Authorization policy engine (ABAC + RBAC).
 *
 * Access model:
 * - Every Member (health twin subject) has exactly ONE owner account.
 * - The owner may grant other accounts 'viewer' (read) or 'editor' (read+write) shares.
 * - Admins exist for platform administration; by policy they do NOT get
 *   access to members' health data (least privilege / family isolation),
 *   only to user administration and audit trails.
 *
 * Every assert* method throws — services stay free of inline if/throw soup.
 * Unknown IDs throw NotFoundError (not Forbidden) so existence of other
 * people's resources cannot be probed via status-code differences.
 */
export class PolicyService {
  constructor(memberRepository) {
    this.members = memberRepository;
  }

  /** Resolve a member + the actor's access level, or throw NotFound. */
  loadMemberWithAccess(actor, memberId) {
    const member = this.members.findById(memberId);
    if (!member) throw new NotFoundError('Member not found');
    const access = this.accessLevel(actor, member);
    if (!access) throw new NotFoundError('Member not found'); // hide existence from strangers
    return { member, access };
  }

  /** 'owner' | 'editor' | 'viewer' | null for a given actor+member pair. */
  accessLevel(actor, member) {
    if (member.user_id === actor.id) return 'owner';
    const share = this.members.getShare(member.id, actor.id);
    return share || null; // 'viewer' | 'editor' | null
  }

  canRead(actor, member) {
    return this.accessLevel(actor, member) !== null;
  }

  canWrite(actor, member) {
    const level = this.accessLevel(actor, member);
    return level === 'owner' || level === 'editor';
  }

  canManageShares(actor, member) {
    return member.user_id === actor.id; // owner-only
  }

  assertRead(actor, member) {
    if (!this.canRead(actor, member)) {
      throw new NotFoundError('Resource not found');
    }
  }

  assertWrite(actor, member) {
    if (!this.canWrite(actor, member)) {
      if (this.canRead(actor, member)) {
        // viewer/editor distinction is visible to insiders only
        throw new ForbiddenError('You have read-only access to this member', 'INSUFFICIENT_PERMISSION');
      }
      throw new NotFoundError('Resource not found');
    }
  }

  assertOwner(actor, member) {
    if (!this.canManageShares(actor, member)) {
      throw new NotFoundError('Resource not found');
    }
  }

  assertAdmin(actor) {
    if (!actor.isAdmin) {
      throw new ForbiddenError('Administrator role required', 'ADMIN_REQUIRED');
    }
  }

  /**
   * Load a report with its member and check read/write. Reports carry their
   * own member_id, and access is always derived from the member — never
   * from caller-provided ids.
   */
  loadReportWithAccess(actor, reportRepository, reportId, { write = false } = {}) {
    const report = reportRepository.findById(reportId);
    if (!report) throw new NotFoundError('Report not found');
    const { member, access } = this.loadMemberWithAccess(actor, report.member_id);
    if (write) this.assertWrite(actor, member);
    return { report, member, access };
  }

  loadLabResultWithAccess(actor, labResultRepository, labResultId, { write = false } = {}) {
    const lab = labResultRepository.findById(labResultId);
    if (!lab) throw new NotFoundError('Lab result not found');
    const { member, access } = this.loadMemberWithAccess(actor, lab.member_id);
    if (write) this.assertWrite(actor, member);
    return { lab, member, access };
  }

  loadObservationWithAccess(actor, observationRepository, observationId, { write = false } = {}) {
    const observation = observationRepository.findById(observationId);
    if (!observation) throw new NotFoundError('Observation not found');
    const { member, access } = this.loadMemberWithAccess(actor, observation.member_id);
    if (write) this.assertWrite(actor, member);
    return { observation, member, access };
  }
}
