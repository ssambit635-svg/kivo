import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { TokenService } from '../../src/services/TokenService.js';
import { Config } from '../../src/config/Config.js';
import { UnauthorizedError } from '../../src/common/errors.js';

const config = new Config({ NODE_ENV: 'test', JWT_SECRET: 'unit-test-secret', ACCESS_TOKEN_TTL_SEC: '60' });
const tokens = new TokenService(config);

describe('TokenService access tokens', () => {
  it('sign-then-verify roundtrips claims', () => {
    const t = tokens.signAccessToken({ userId: 'u1', role: 'user', tokenVersion: 3 });
    const p = tokens.verifyAccessToken(t);
    expect(p.sub).toBe('u1');
    expect(p.role).toBe('user');
    expect(p.tv).toBe(3);
    expect(p.type).toBe('access');
    expect(p.exp - p.iat).toBe(60);
  });

  it('rejects tampered tokens', () => {
    const t = tokens.signAccessToken({ userId: 'u1', role: 'user', tokenVersion: 1 });
    expect(() => tokens.verifyAccessToken(`${t}x`)).toThrow(UnauthorizedError);
  });

  it('rejects tokens signed with a DIFFERENT secret', () => {
    const evil = jwt.sign({ sub: 'u1', role: 'admin', tv: 1, type: 'access' }, 'wrong-secret', { expiresIn: 60 });
    expect(() => tokens.verifyAccessToken(evil)).toThrow(UnauthorizedError);
  });

  it('rejects alg=none style tokens', () => {
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'u1', role: 'admin', type: 'access' })).toString('base64url')}.`;
    expect(() => tokens.verifyAccessToken(none)).toThrow(UnauthorizedError);
  });

  it('rejects expired tokens with a dedicated code', async () => {
    const expired = jwt.sign({ sub: 'u1', role: 'user', tv: 1, type: 'access' }, 'unit-test-secret', { expiresIn: -5 });
    try {
      tokens.verifyAccessToken(expired);
      expect.unreachable();
    } catch (e) {
      expect(e.code).toBe('TOKEN_EXPIRED');
    }
  });

  it('rejects non-HS256 algs', () => {
    // jsonwebtoken refuses to sign 'none' without allowlist, so craft HS384 claim instead:
    const hs384 = `${Buffer.from(JSON.stringify({ alg: 'HS384', typ: 'JWT' })).toString('base64url')}.x.y`;
    expect(() => tokens.verifyAccessToken(hs384)).toThrow(UnauthorizedError);
  });

  it('rejects tokens of the wrong type even when signed correctly', () => {
    const refreshType = jwt.sign({ sub: 'u1', role: 'user', tv: 1, type: 'refresh' }, 'unit-test-secret', { expiresIn: 60 });
    expect(() => tokens.verifyAccessToken(refreshType)).toThrow(/Wrong token type/);
  });
});

describe('TokenService refresh tokens', () => {
  it('generates high-entropy opaque tokens and SHA-256 hashes them', () => {
    const { token, tokenHash } = tokens.generateRefreshToken();
    expect(token.length).toBeGreaterThan(40);
    expect(/^[a-f0-9]{64}$/.test(tokenHash)).toBe(true);
    expect(tokenHash).not.toContain(token);
  });

  it('hash is deterministic (lookup-by-hash must work)', () => {
    expect(tokens.hashRefreshToken('abc')).toBe(tokens.hashRefreshToken('abc'));
  });

  it('two generated tokens never collide', () => {
    const a = tokens.generateRefreshToken();
    const b = tokens.generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});
