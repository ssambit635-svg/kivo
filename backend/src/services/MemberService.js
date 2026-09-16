import { NotFoundError, ValidationError } from '../common/errors.js';

/**
 * Member (health twin subject) management + sharing use-cases.
 */
export class MemberService {
  constructor({ memberRepository, userRepository, policyService, auditService }) {
    this.members = memberRepository;
    this.users = userRepository;
    this.policy = policyService;
    this.audit = auditService;
  }

  listForActor(actor) {
    const owned = this.members.listOwned(actor.id).map((m) => m.toJSON('owner'));
    const shared = this.members
      .listSharedWith(actor.id)
      .map(({ member, permission }) => member.toJSON(permission));
    return { owned, shared };
  }

  getForActor(actor, memberId) {
    const { member, access } = this.policy.loadMemberWithAccess(actor, memberId);
    return member.toJSON(access);
  }

  create(actor, data, ctx = {}) {
    const member = this.members.create({ userId: actor.id, ...data });
    this.audit.record({ userId: actor.id, action: 'member.create', resourceType: 'member', resourceId: member.id, ctx });
    return member.toJSON('owner');
  }

  update(actor, memberId, data, ctx = {}) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertWrite(actor, member);
    const updated = this.members.update(memberId, {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.relationship !== undefined ? { relationship: data.relationship } : {}),
      ...(data.dob !== undefined ? { dob: data.dob } : {}),
      ...(data.sex !== undefined ? { sex: data.sex } : {}),
      ...(data.heightCm !== undefined ? { height_cm: data.heightCm } : {}),
      ...(data.familyHistory !== undefined ? { family_history: data.familyHistory } : {}),
    });
    this.audit.record({ userId: actor.id, action: 'member.update', resourceType: 'member', resourceId: memberId, ctx });
    return updated.toJSON(this.policy.accessLevel(actor, updated));
  }

  remove(actor, memberId, ctx = {}) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    if (member.relationship === 'self') {
      throw new ValidationError("The 'self' member cannot be deleted");
    }
    this.policy.assertOwner(actor, member);
    this.members.delete(memberId);
    this.audit.record({ userId: actor.id, action: 'member.delete', resourceType: 'member', resourceId: memberId, ctx });
    return { deleted: true };
  }

  // ---- sharing (owner only) ------------------------------------------------
  listShares(actor, memberId) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertOwner(actor, member);
    return this.members.listShares(memberId).map((s) => ({
      userId: s.user_id,
      email: s.email,
      displayName: s.display_name,
      permission: s.permission,
      createdAt: s.created_at,
    }));
  }

  grantShare(actor, memberId, { granteeEmail, permission }, ctx = {}) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertOwner(actor, member);
    const grantee = this.users.findByEmail(granteeEmail);
    if (!grantee) throw new NotFoundError('No account exists with that email');
    if (grantee.id === actor.id) throw new ValidationError('You already own this member');
    if (grantee.isDisabled) throw new ValidationError('Cannot share with a disabled account');
    this.members.setShare(memberId, grantee.id, permission);
    this.audit.record({
      userId: actor.id, action: 'member.share_grant', resourceType: 'member', resourceId: memberId,
      metadata: { grantee: grantee.id, permission }, ctx,
    });
    return { granted: true, userId: grantee.id, permission };
  }

  revokeShare(actor, memberId, granteeUserId, ctx = {}) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertOwner(actor, member);
    const removed = this.members.removeShare(memberId, granteeUserId);
    if (!removed) throw new NotFoundError('Share not found');
    this.audit.record({
      userId: actor.id, action: 'member.share_revoke', resourceType: 'member', resourceId: memberId,
      metadata: { grantee: granteeUserId }, ctx,
    });
    return { revoked: true };
  }
}
