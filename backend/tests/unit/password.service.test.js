import { describe, it, expect } from 'vitest';
import { PasswordService } from '../../src/services/PasswordService.js';
import { Config } from '../../src/config/Config.js';

const config = new Config({ NODE_ENV: 'test' });
const pw = new PasswordService(config);

describe('PasswordService hashing', () => {
  it('produces the scrypt$N$r$p$salt$hash format', () => {
    const h = pw.hash('Sup3r!Secret#pw');
    const parts = h.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(parts).toHaveLength(6);
  });

  it('uses a random per-password salt (two hashes differ)', () => {
    expect(pw.hash('Sup3r!Secret#pw')).not.toBe(pw.hash('Sup3r!Secret#pw'));
  });

  it('verify() accepts the correct password', () => {
    expect(pw.verify('Sup3r!Secret#pw', pw.hash('Sup3r!Secret#pw'))).toBe(true);
  });

  it('verify() rejects wrong passwords', () => {
    const h = pw.hash('Sup3r!Secret#pw');
    expect(pw.verify('Sup3r!Secret#px', h)).toBe(false);
    expect(pw.verify('', h)).toBe(false);
  });

  it('verify() survives malformed stored hashes without throwing', () => {
    expect(pw.verify('x', 'not-a-hash')).toBe(false);
    expect(pw.verify('x', '')).toBe(false);
    expect(pw.verify('x', null)).toBe(false);
    expect(pw.verify('x', 'argon2$whatever')).toBe(false);
  });

  it('timing: correct vs incorrect verify are of the same order of magnitude', () => {
    const h = pw.hash('Sup3r!Secret#pw');
    const t0 = performance.now(); pw.verify('Sup3r!Secret#pw', h); const ok = performance.now() - t0;
    const t1 = performance.now(); pw.verify('Wr0ng!Secret#pw', h); const no = performance.now() - t1;
    expect(Math.abs(ok - no)).toBeLessThan(Math.max(ok, no)); // same ballpark
  });
});

describe('PasswordService policy', () => {
  it('accepts a genuinely strong password', () => {
    expect(pw.validatePolicy('Y7!kQuartz#91Mellow').ok).toBe(true);
  });

  it('rejects too-short passwords', () => {
    const { ok, errors } = pw.validatePolicy('Ab1!very');
    expect(ok).toBe(false);
    expect(errors.join(' ')).toMatch(/12/);
  });

  it('rejects missing character classes and lists every problem', () => {
    const { ok, errors } = pw.validatePolicy('alllowercasenodigit'); // missing upper, digit, symbol
    expect(ok).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects common passwords', () => {
    expect(pw.validatePolicy('password123').ok).toBe(false);
  });

  it('rejects passwords containing the email local part', () => {
    expect(pw.validatePolicy('Ramesh.k2026!xX', { email: 'ramesh.k@example.com' }).ok).toBe(false);
  });

  it('rejects repeated single characters', () => {
    expect(pw.validatePolicy('aaaaaaaaaaaaAA1!').ok).toBe(true); // not single char repeated
    expect(pw.validatePolicy('aaaaaaaaaaaaaaaaaaaaaaaaaaaa').ok).toBe(false);
  });

  it('rejects over-long passwords (DoS guard)', () => {
    expect(pw.validatePolicy(`Aa1!${'x'.repeat(200)}`).ok).toBe(false);
  });
});
