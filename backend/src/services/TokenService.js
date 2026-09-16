import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { newId, newOpaqueToken } from '../utils/id.js';
import { UnauthorizedError } from '../common/errors.js';

/**
 * Stateless access-token (JWT HS256) + opaque refresh-token service.
 * Access tokens are short-lived and carry `tv` (token version) so a
 * password change or logout-all invalidates outstanding access tokens
 * immediately at verification time.
 */
export class TokenService {
  constructor(config) {
    this.secret = config.jwtSecret;
    this.accessTtlSec = config.accessTokenTtlSec;
    this.refreshTtlSec = config.refreshTokenTtlSec;
  }

  signAccessToken({ userId, role, tokenVersion }) {
    return jwt.sign(
      { sub: userId, role, tv: tokenVersion, type: 'access', jti: newId() },
      this.secret,
      { expiresIn: this.accessTtlSec, algorithm: 'HS256' },
    );
  }

  verifyAccessToken(token) {
    let payload;
    try {
      payload = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
    } catch (err) {
      if (err && err.name === 'TokenExpiredError') {
        throw new UnauthorizedError('Access token expired', 'TOKEN_EXPIRED');
      }
      throw new UnauthorizedError('Invalid access token', 'TOKEN_INVALID');
    }
    if (payload.type !== 'access') {
      throw new UnauthorizedError('Wrong token type', 'TOKEN_TYPE_INVALID');
    }
    return payload;
  }

  /** New opaque refresh token; only its hash is ever persisted. */
  generateRefreshToken() {
    const token = newOpaqueToken(48);
    return { token, tokenHash: this.hashRefreshToken(token) };
  }

  hashRefreshToken(token) {
    return createHash('sha256').update(String(token), 'utf8').digest('hex');
  }

  get refreshTtl() {
    return this.refreshTtlSec;
  }
}
