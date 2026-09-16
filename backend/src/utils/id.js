import { randomUUID, randomBytes } from 'node:crypto';

export function newId() {
  return randomUUID();
}

/** Cryptographically strong opaque token (for refresh tokens). */
export function newOpaqueToken(bytes = 48) {
  return randomBytes(bytes).toString('base64url');
}
