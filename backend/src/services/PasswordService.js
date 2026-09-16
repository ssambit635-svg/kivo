import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** A short, curated denylists of too-common passwords (extend freely). */
const COMMON_PASSWORDS = new Set([
  'password', 'password123', '12345678', '123456789', '1234567890', 'qwerty123',
  'letmein123', 'iloveyou', 'admin1234', 'welcome123', 'dragon123', 'football1',
  'monkey1234', 'sunshine1', 'password1!', 'qwertyuiop', 'trustno1',
]);

/**
 * Password hashing via scrypt (node:crypto built-in — zero dependency cost)
 * with per-user random salt and constant-time comparison.
 * Stored format: scrypt$N$r$p$<salt_b64>$<hash_b64>
 */
export class PasswordService {
  constructor(config) {
    this.params = config.scrypt;
    this.policy = {
      minLength: 12,
      maxLength: 128,
    };
    // Dummy hash so a login against an unknown email takes ~the same time
    // as one against a real account (blunts user-enumeration timing).
    this.dummyHash = this.hash('dummy-password-for-constant-time');
  }

  hash(plaintext) {
    const { N, r, p, keylen } = this.params;
    const salt = randomBytes(16);
    const derived = scryptSync(String(plaintext), salt, keylen, {
      N, r, p, maxmem: 128 * N * r * 2,
    });
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
  }

  verify(plaintext, stored) {
    try {
      const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
      if (scheme !== 'scrypt') return false;
      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(hashB64, 'base64');
      const derived = scryptSync(String(plaintext), salt, expected.length, {
        N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 2,
      });
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }

  /**
   * Password policy. Returns { ok, errors[] } so the API can surface ALL
   * problems at once instead of a frustrating one-by-one loop.
   */
  validatePolicy(plaintext, { email = null } = {}) {
    const errors = [];
    const pw = String(plaintext ?? '');
    const lower = pw.toLowerCase();

    if (pw.length < this.policy.minLength) {
      errors.push(`Password must be at least ${this.policy.minLength} characters long`);
    }
    if (pw.length > this.policy.maxLength) {
      errors.push(`Password must be at most ${this.policy.maxLength} characters long`);
    }
    if (!/[a-z]/.test(pw)) errors.push('Password must contain a lowercase letter');
    if (!/[A-Z]/.test(pw)) errors.push('Password must contain an uppercase letter');
    if (!/[0-9]/.test(pw)) errors.push('Password must contain a digit');
    if (!/[^A-Za-z0-9]/.test(pw)) errors.push('Password must contain a symbol');
    if (COMMON_PASSWORDS.has(lower)) errors.push('This password is too common — pick a rarer one');
    if (email && lower.includes(String(email).split('@')[0].toLowerCase())) {
      errors.push('Password must not contain your email name');
    }
    if (/^(.)\1+$/.test(pw)) errors.push('Password must not be one repeated character');

    return { ok: errors.length === 0, errors };
  }
}
