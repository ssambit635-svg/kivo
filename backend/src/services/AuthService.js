import { newId } from '../utils/id.js';
import { isPast } from '../utils/time.js';
import {
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
} from '../common/errors.js';

/**
 * Authentication use-cases: register / login / token refresh with rotation
 * and reuse detection / logout / change-password.
 *
 * Design notes:
 * - Refresh tokens are opaque, hashed (sha256) at rest, and ROTATED on
 *   every refresh. Presenting a token that was already rotated == token
 *   theft signal => the whole token family is revoked instantly.
 * - Failed logins are counted; at the configured threshold the account
 *   locks for a cooldown window. Unknown emails still pay a scrypt cost
 *   (dummy verify) to blunt user enumeration via response timing.
 * - Every meaningful event is written to the audit log.
 */
export class AuthService {
  constructor({
    config,
    userRepository,
    refreshTokenRepository,
    memberRepository,
    passwordService,
    tokenService,
    auditService,
    roleRepository = null,
    doctorRepository = null,
  }) {
    this.config = config;
    this.roleRepo = roleRepository;
    this.doctorRepo = doctorRepository;
    this.users = userRepository;
    this.refreshTokens = refreshTokenRepository;
    this.members = memberRepository;
    this.passwords = passwordService;
    this.tokens = tokenService;
    this.audit = auditService;
  }

  // ---------------------------------------------------------------- register
  register({ email, displayName, password }, ctx = {}) {
    const policy = this.passwords.validatePolicy(password, { email });
    if (!policy.ok) {
      throw new ValidationError('Password does not meet security requirements', policy.errors);
    }
    if (this.users.emailExists(email)) {
      // Same generic conflict either way — we never say WHICH account exists elsewhere.
      this.audit.record({ userId: null, action: 'auth.register', outcome: 'failure', metadata: { reason: 'email_in_use' }, ctx });
      throw new ConflictError('An account with this email already exists', 'EMAIL_IN_USE');
    }
    const passwordHash = this.passwords.hash(password);
    const user = this.users.create({ email, displayName, passwordHash });
    // Every account starts with a "self" member — the primary health twin.
    this.members.create({
      userId: user.id,
      name: displayName,
      relationship: 'self',
    });
    this.audit.record({ userId: user.id, action: 'auth.register', ctx });
    return this.issueSession(user, ctx, { familyId: newId() });
  }

  // ------------------------------------------------------------------- login
  login({ email, password }, ctx = {}) {
    const user = this.authenticateWithPassword(email, password, ctx, 'auth.login');
    return this.issueSession(user, ctx, { familyId: newId() });
  }

  /**
   * DOCTOR sign-in — the only door into the doctor console.
   *
   * Two things are checked beyond the password, and both are the point of the
   * feature: the account must really be a doctor account, and the medical
   * council registration number typed at sign-in must match the certificate on
   * file. A doctor whose certificate has not been checked yet still gets a
   * session (so they can finish verification on the console's upload screen)
   * but no `doctor` role, so every clinical endpoint stays shut until the
   * certificate check passes.
   */
  loginDoctor({ email, password, registrationNo }, ctx = {}) {
    if (!this.doctorRepo) throw new UnauthorizedError('Doctor sign-in is not available', 'UNAVAILABLE');
    const user = this.authenticateWithPassword(email, password, ctx, 'auth.doctor_login');
    const doctor = this.doctorRepo.findByUserId(user.id);
    if (!doctor) {
      this.audit.record({
        userId: user.id,
        action: 'auth.doctor_login',
        outcome: 'failure',
        metadata: { reason: 'not_a_doctor_account' },
        ctx,
      });
      throw new ForbiddenError(
        'This account is not a doctor account. Sign in as a patient, or apply to join the doctor network.',
        'NOT_A_DOCTOR_ACCOUNT',
      );
    }

    const typed = stripRegistration(registrationNo);
    const onFile = [doctor.registration_no, doctor.certificate_no]
      .filter(Boolean)
      .map(stripRegistration);
    if (!typed || !onFile.includes(typed)) {
      this.audit.record({
        userId: user.id,
        action: 'auth.doctor_login',
        outcome: 'failure',
        metadata: { reason: 'certificate_mismatch' },
        ctx,
      });
      throw new UnauthorizedError(
        'That registration number does not match the medical certificate on file for this account. ' +
          'Check the number (for example MCI-123456) and try again — the exact number is the one you applied with.',
        'CERTIFICATE_MISMATCH',
      );
    }

    if (doctor.status === 'suspended') {
      this.audit.record({
        userId: user.id,
        action: 'auth.doctor_login',
        outcome: 'failure',
        metadata: { reason: 'suspended' },
        ctx,
      });
      throw new ForbiddenError('This doctor profile is suspended', 'DOCTOR_SUSPENDED');
    }

    this.audit.record({
      userId: user.id,
      action: 'auth.doctor_login',
      metadata: {
        certificateStatus: doctor.certificate_status || 'not_submitted',
        profileStatus: doctor.status,
      },
      ctx,
    });

    const session = this.issueSession(user, ctx, { familyId: newId() });
    return {
      ...session,
      doctor: doctor.toJSON(),
      // Drives the console's verification screen when the certificate check is
      // still outstanding (or was rejected).
      certificate: doctor.certificate,
      requiresCertificate: !doctor.isCertificateVerified,
    };
  }

  /**
   * Shared password/lockout verification for both sign-in doors. Unknown emails
   * still pay a scrypt cost (dummy verify) to blunt user enumeration.
   */
  authenticateWithPassword(email, password, ctx = {}, action = 'auth.login') {
    const user = this.users.findByEmail(email);
    if (!user) {
      this.passwords.verify(password, this.passwords.dummyHash); // constant-ish time
      this.audit.record({ action, outcome: 'failure', metadata: { reason: 'unknown_email' }, ctx });
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    if (user.isDisabled) {
      this.audit.record({ userId: user.id, action, outcome: 'failure', metadata: { reason: 'disabled' }, ctx });
      throw new ForbiddenError('This account has been disabled', 'ACCOUNT_DISABLED');
    }

    if (user.lockout_until && !isPast(user.lockout_until)) {
      this.audit.record({ userId: user.id, action, outcome: 'failure', metadata: { reason: 'locked' }, ctx });
      throw new UnauthorizedError(
        `Account is temporarily locked. Try again after ${user.lockout_until}`,
        'ACCOUNT_LOCKED',
      );
    }

    if (!this.passwords.verify(password, user.password_hash)) {
      const { lockoutUntil } = this.users.recordLoginFailure(
        user.id,
        this.config.loginMaxFailedAttempts,
        this.config.lockoutMinutes,
      );
      this.audit.record({ userId: user.id, action, outcome: 'failure', metadata: { reason: 'bad_password' }, ctx });
      if (lockoutUntil) {
        this.audit.record({ userId: user.id, action: 'auth.lockout', metadata: { lockoutUntil }, ctx });
        throw new UnauthorizedError(
          `Too many failed attempts. Account locked until ${lockoutUntil}`,
          'ACCOUNT_LOCKED',
        );
      }
      throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    this.users.recordLoginSuccess(user.id);
    return user;
  }

  // ----------------------------------------------------------------- refresh
  /**
   * Rotate an opaque refresh token. Reuse of a rotated/revoked token is a
   * theft signal: the whole family is revoked and the client must log in
   * again.
   */
  refresh({ refreshToken }, ctx = {}) {
    const hash = this.tokens.hashRefreshToken(refreshToken);
    const stored = this.refreshTokens.findByHash(hash);

    if (!stored) {
      this.audit.record({ action: 'auth.refresh', outcome: 'failure', metadata: { reason: 'unknown_token' }, ctx });
      throw new UnauthorizedError('Invalid refresh token', 'REFRESH_INVALID');
    }

    // Disabled accounts short-circuit BEFORE the reuse machinery: presenting
    // a token revoked by an administrative disable is not a theft signal.
    const owner = this.users.findById(stored.user_id);
    if (owner && owner.isDisabled) {
      this.audit.record({ userId: stored.user_id, action: 'auth.refresh', outcome: 'failure', metadata: { reason: 'disabled' }, ctx });
      throw new ForbiddenError('This account has been disabled', 'ACCOUNT_DISABLED');
    }

    if (stored.isRevoked) {
      // REUSE DETECTED — revoke the entire rotation family.
      this.refreshTokens.revokeFamily(stored.family_id);
      this.audit.record({
        userId: stored.user_id,
        action: 'auth.refresh_reuse_detected',
        outcome: 'failure',
        metadata: { familyId: stored.family_id },
        ctx,
      });
      throw new UnauthorizedError('Refresh token reuse detected — session revoked', 'REFRESH_REUSED');
    }

    if (stored.isExpired) {
      this.audit.record({ userId: stored.user_id, action: 'auth.refresh', outcome: 'failure', metadata: { reason: 'expired' }, ctx });
      throw new UnauthorizedError('Refresh token expired', 'REFRESH_EXPIRED');
    }

    const user = owner;
    if (!user) {
      this.refreshTokens.revokeFamily(stored.family_id);
      throw new UnauthorizedError('Account no longer exists', 'UNAUTHORIZED');
    }
    user.roles = this.rolesFor(user);

    // Rotate atomically: old token revoked and linked to its replacement.
    const { token, tokenHash } = this.tokens.generateRefreshToken();
    const rotated = this.users.db.transaction(() => {
      const fresh = this.refreshTokens.create({
        userId: user.id,
        tokenHash,
        familyId: stored.family_id,
        ttlSec: this.tokens.refreshTtl,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      this.refreshTokens.revoke(stored.id, fresh.id);
      this.refreshTokens.markUsed(stored.id);
      return fresh;
    });

    const accessToken = this.tokens.signAccessToken({
      userId: user.id,
      role: user.role,
      tokenVersion: user.token_version,
    });
    this.audit.record({ userId: user.id, action: 'auth.refresh', metadata: { familyId: stored.family_id, newTokenId: rotated.id }, ctx });

    return {
      accessToken,
      refreshToken: token,
      tokenType: 'Bearer',
      expiresIn: this.config.accessTokenTtlSec,
      user: user.toJSON(),
    };
  }

  // ------------------------------------------------------------------ logout
  logout({ refreshToken }, ctx = {}) {
    if (!refreshToken) return { revoked: false };
    const stored = this.refreshTokens.findByHash(this.tokens.hashRefreshToken(refreshToken));
    if (stored && !stored.isRevoked) {
      this.refreshTokens.revoke(stored.id);
      this.audit.record({ userId: stored.user_id, action: 'auth.logout', ctx });
      return { revoked: true };
    }
    return { revoked: false }; // idempotent — never reveal which tokens exist
  }

  logoutAll(actor, ctx = {}) {
    this.refreshTokens.revokeAllForUser(actor.id);
    this.users.bumpTokenVersion(actor.id); // kills outstanding access tokens too
    this.audit.record({ userId: actor.id, action: 'auth.logout_all', ctx });
    return { revokedAll: true };
  }

  // --------------------------------------------------------- change password
  changePassword(actor, { currentPassword, newPassword }, ctx = {}) {
    const user = this.users.findById(actor.id);
    if (!user) throw new UnauthorizedError('Account not found', 'UNAUTHORIZED');
    if (!this.passwords.verify(currentPassword, user.password_hash)) {
      this.audit.record({ userId: user.id, action: 'auth.change_password', outcome: 'failure', metadata: { reason: 'bad_current' }, ctx });
      throw new UnauthorizedError('Current password is incorrect', 'INVALID_CREDENTIALS');
    }
    const policy = this.passwords.validatePolicy(newPassword, { email: user.email });
    if (!policy.ok) {
      throw new ValidationError('New password does not meet security requirements', policy.errors);
    }
    if (currentPassword === newPassword) {
      throw new ValidationError('New password must differ from the current password');
    }
    this.users.updatePassword(user.id, this.passwords.hash(newPassword)); // bumps token_version
    this.refreshTokens.revokeAllForUser(user.id);
    this.audit.record({ userId: user.id, action: 'auth.change_password', ctx });
    return { changed: true, sessionsRevoked: true };
  }

  // ------------------------------------------------------------- verify path
  /** Resolve an access token to a live actor, enforcing version + status. */
  resolveAccessToken(payload) {
    const user = this.users.findById(payload.sub);
    if (!user) throw new UnauthorizedError('Account no longer exists', 'UNAUTHORIZED');
    if (user.isDisabled) throw new ForbiddenError('This account has been disabled', 'ACCOUNT_DISABLED');
    if (user.token_version !== payload.tv) {
      throw new UnauthorizedError('Session revoked — please log in again', 'SESSION_REVOKED');
    }
    user.roles = this.rolesFor(user);
    return user;
  }

  // ------------------------------------------------------------------ roles
  /**
   * RBAC roles are resolved from the DATABASE on every request, never carried
   * in the token: `users.role` gives admin/patient, `user_roles` adds granted
   * product roles (doctor). Suspending a doctor therefore takes effect on the
   * next request instead of when their access token expires.
   */
  rolesFor(user) {
    const base = user.role === 'admin' ? ['admin'] : ['patient'];
    const granted = this.roleRepo ? this.roleRepo.rolesFor(user.id) : [];
    return [...new Set([...base, ...granted])];
  }

  // ---------------------------------------------------------------- internal
  issueSession(user, ctx, { familyId }) {
    user.roles = this.rolesFor(user);
    const accessToken = this.tokens.signAccessToken({
      userId: user.id,
      role: user.role,
      tokenVersion: user.token_version,
    });
    const { token, tokenHash } = this.tokens.generateRefreshToken();
    this.refreshTokens.create({
      userId: user.id,
      tokenHash,
      familyId,
      ttlSec: this.tokens.refreshTtl,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return {
      accessToken,
      refreshToken: token,
      tokenType: 'Bearer',
      expiresIn: this.config.accessTokenTtlSec,
      user: user.toJSON(),
    };
  }

  /** Run the configured scrypt cost once at startup — guards misconfiguration. */
  selfTest() {
    const probe = this.passwords.hash('self-test');
    if (!this.passwords.verify('self-test', probe)) throw new Error('Password self-test failed');
  }
}

/** `MCI-123456` and `mci 123456` are the same certificate number. */
function stripRegistration(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
