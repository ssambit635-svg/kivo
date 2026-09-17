import { ForbiddenError } from '../common/errors.js';

/**
 * Role gates for the two consoles.
 *
 * Roles come from `req.actor.roles`, which the auth layer resolves from the
 * database on EVERY request (users.role + user_roles). Nothing about access
 * lives in the token, so revoking a role or suspending a doctor takes effect
 * immediately instead of when the access token happens to expire.
 */
export function requireRole(role, { message, code } = {}) {
  return (req, _res, next) => {
    const roles = req.actor?.roles || [];
    if (!roles.includes(role)) {
      return next(
        new ForbiddenError(
          message || `The ${role} role is required for this endpoint`,
          code || `${role.toUpperCase()}_ROLE_REQUIRED`,
        ),
      );
    }
    return next();
  };
}

export function requireDoctorRole() {
  return requireRole('doctor', {
    message: 'Doctor access required. Sign in with a doctor account or apply to join the network.',
    code: 'DOCTOR_ROLE_REQUIRED',
  });
}

export function requireAdminRole() {
  return requireRole('admin', { message: 'Administrator role required', code: 'ADMIN_REQUIRED' });
}

/**
 * The health-twin surface is patient-only: a doctor account holds no health
 * twin of its own and must not be able to use the patient APIs as a back door
 * into anyone's chart. Admins keep their existing (already limited) surface.
 */
export function patientOnly() {
  return (req, _res, next) => {
    const roles = req.actor?.roles || [];
    if (roles.includes('doctor') && !roles.includes('admin')) {
      return next(
        new ForbiddenError(
          'This account is a doctor account — use the doctor console instead of the patient app.',
          'DOCTOR_ACCOUNT',
        ),
      );
    }
    return next();
  };
}
