#!/usr/bin/env node
/**
 * One-off admin bootstrap: `node scripts/create-admin.js admin@x.tld 'Display Name' 'Str0ng!Passw0rd#'`
 * Roles can only ever come from direct DB changes (never the API), which
 * is exactly what this script does — locally.
 */
import { Container } from '../src/container/Container.js';

const [email, displayName, password] = process.argv.slice(2);
if (!email || !displayName || !password) {
  console.error('usage: node scripts/create-admin.js <email> <displayName> <password>');
  process.exit(1);
}

const c = new Container();
const existing = c.userRepository.findByEmail(email);
if (existing) {
  c.db.run("UPDATE users SET role = 'admin' WHERE id = ?", existing.id);
  console.log(`promoted existing user ${email} to admin`);
} else {
  const policy = c.passwordService.validatePolicy(password, { email });
  if (!policy.ok) {
    console.error('weak password:', policy.errors.join('; '));
    process.exit(1);
  }
  const user = c.userRepository.create({
    email,
    displayName,
    passwordHash: c.passwordService.hash(password),
    role: 'admin',
  });
  c.memberRepository.create({ userId: user.id, name: displayName, relationship: 'self' });
  console.log(`created admin ${email} (${user.id})`);
}
c.close();
