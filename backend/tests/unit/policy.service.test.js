import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyService } from '../../src/services/PolicyService.js';
import { MemberRepository } from '../../src/repositories/MemberRepository.js';
import { Database } from '../../src/db/Database.js';
import { NotFoundError, ForbiddenError } from '../../src/common/errors.js';

function fakeUser(id, role = 'user') {
  return { id, role, isAdmin: role === 'admin' };
}

let db, members, policy, owner, viewer, editor, stranger, admin, member;

beforeEach(() => {
  db = new Database(':memory:');
  members = new MemberRepository(db);
  policy = new PolicyService(members);
  owner = fakeUser('owner');
  viewer = fakeUser('viewer');
  editor = fakeUser('editor');
  stranger = fakeUser('stranger');
  admin = fakeUser('admin', 'admin');
  // FK — members require referenced users to exist.
  for (const u of [owner, viewer, editor, stranger, admin]) {
    db.run(
      `INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at)
       VALUES (?, ?, 'x', 'x', 'user', '2026-01-01', '2026-01-01')`,
      u.id,
      `${u.id}@x.tld`,
    );
  }
  member = members.create({ userId: owner.id, name: 'Twin' });
  members.setShare(member.id, viewer.id, 'viewer');
  members.setShare(member.id, editor.id, 'editor');
});

describe('PolicyService access matrix', () => {
  it('resolves access levels: owner / viewer / editor / none', () => {
    expect(policy.accessLevel(owner, member)).toBe('owner');
    expect(policy.accessLevel(viewer, member)).toBe('viewer');
    expect(policy.accessLevel(editor, member)).toBe('editor');
    expect(policy.accessLevel(stranger, member)).toBeNull();
  });

  it('owner + editor can write; viewer and strangers cannot', () => {
    expect(policy.canWrite(owner, member)).toBe(true);
    expect(policy.canWrite(editor, member)).toBe(true);
    expect(policy.canWrite(viewer, member)).toBe(false);
    expect(policy.canWrite(stranger, member)).toBe(false);
  });

  it('owner, viewer, editor can read; strangers cannot', () => {
    for (const u of [owner, viewer, editor]) expect(policy.canRead(u, member)).toBe(true);
    expect(policy.canRead(stranger, member)).toBe(false);
  });

  it('CRITICAL: admin does NOT get health-data access via the admin role', () => {
    expect(policy.canRead(admin, member)).toBe(false);
    expect(() => policy.assertRead(admin, member)).toThrow(NotFoundError);
  });

  it('assertWrite: stranger gets 404-style NotFound (existence hidden)', () => {
    expect(() => policy.assertWrite(stranger, member)).toThrow(NotFoundError);
  });

  it('assertWrite: insider viewer gets 403-style Forbidden with explicit code', () => {
    try {
      policy.assertWrite(viewer, member);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError);
      expect(e.code).toBe('INSUFFICIENT_PERMISSION');
    }
  });

  it('only the owner can manage shares', () => {
    expect(policy.canManageShares(owner, member)).toBe(true);
    expect(policy.canManageShares(editor, member)).toBe(false);
    expect(policy.canManageShares(viewer, member)).toBe(false);
    expect(() => policy.assertOwner(editor, member)).toThrow(NotFoundError);
  });

  it('loadMemberWithAccess: unknown ids and strangers both see NotFound', () => {
    expect(() => policy.loadMemberWithAccess(owner, 'no-such-id')).toThrow(NotFoundError);
    expect(() => policy.loadMemberWithAccess(stranger, member.id)).toThrow(NotFoundError);
    const { member: m, access } = policy.loadMemberWithAccess(editor, member.id);
    expect(m.id).toBe(member.id);
    expect(access).toBe('editor');
  });

  it('revoking a share immediately removes access', () => {
    members.removeShare(member.id, viewer.id);
    expect(policy.canRead(viewer, member)).toBe(false);
  });

  it('upgrading viewer→editor flips write permission', () => {
    members.setShare(member.id, viewer.id, 'editor');
    expect(policy.canWrite(viewer, member)).toBe(true);
  });
});
