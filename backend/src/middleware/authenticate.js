import { UnauthorizedError } from '../common/errors.js';

/**
 * Bearer-token authentication middleware. Verifies the JWT, then resolves
 * it to a live user enforcing token-version + account status (revocation
 * of outstanding access tokens on logout-all / password change / disable).
 * Attaches `req.actor`.
 */
export function authenticate({ tokenService, authService }) {
  return (req, _res, next) => {
    try {
      const header = req.headers.authorization || '';
      const match = header.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        throw new UnauthorizedError('Missing Bearer token', 'NO_TOKEN');
      }
      const payload = tokenService.verifyAccessToken(match[1]);
      const actor = authService.resolveAccessToken(payload);
      req.actor = actor;
      next();
    } catch (err) {
      next(err);
    }
  };
}
