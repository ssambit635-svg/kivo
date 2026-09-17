#!/usr/bin/env node
/**
 * Zero-dependency secret & credential scanner.
 *
 * Walks the backend + frontend trees and fails (exit 1) when anything that
 * looks like a committed secret is found: cloud access keys, private key
 * material, hard-coded JWTs, high-entropy values assigned to key/secret/token
 * identifiers, and hard-coded password literals outside known-safe fixtures.
 *
 * Run with `npm run security:scan`. Free, offline, deterministic.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND = path.join(ROOT, 'frontend');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'uploads', 'data',
  '.venv', '.cache', 'knowledge', // vendored upstream data (MIT-licensed corpora) is not our code
]);
const SKIP_FILES = new Set(['package-lock.json']);

/** Known-safe matches (test fixtures / docs / examples), keyed by substring. */
const ALLOWLIST = [
  'test-secret-not-for-prod',
  'unit-test-secret-',
  'medtwin-dev-secret-change-me',
  'change-me-to-a-long-random-string',
  'Str0ng!Passw0rd', // documented demo/test password
  'N3w!Passw0rd#Smoke',
  'dummy-password-for-constant-time',
  'JWT_SECRET=change-me',
];

const RULES = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'private-key-material', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'jwt-literal', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    id: 'secret-assignment',
    re: /\b(api[_-]?key|apikey|secret|token|password|passwd|pwd)\b\s*[:=]\s*['"][A-Za-z0-9+/=_\-]{20,}['"]/gi,
  },
  { id: 'bearer-literal', re: /\bbearer\s+[A-Za-z0-9+/=_\-\.]{40,}/gi },
];

const findings = [];
let scanned = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(p);
      continue;
    }
    if (SKIP_FILES.has(entry)) continue;
    if (st.size > 1_000_000) continue; // never scan giant blobs
    if (!/\.(js|mjs|cjs|ts|json|html|css|md|env|yml|yaml|sh|example)$/.test(entry) && !entry.startsWith('.env')) continue;

    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    scanned += 1;
    const rel = path.relative(ROOT, p);
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of text.matchAll(rule.re)) {
        const snippet = m[0].slice(0, 80);
        if (ALLOWLIST.some((a) => snippet.includes(a) || m[0].includes(a))) continue;
        const line = text.slice(0, m.index).split('\n').length;
        findings.push({ rule: rule.id, file: rel, line, snippet });
      }
    }
  }
}

walk(BACKEND);
walk(FRONTEND);

console.log(`security-scan: ${scanned} files scanned, ${RULES.length} rules`);
if (findings.length === 0) {
  console.log('OK — no hard-coded secrets detected.');
  process.exit(0);
}
console.error(`FAIL — ${findings.length} potential secret(s) found:`);
for (const f of findings) {
  console.error(`  [${f.rule}] ${f.file}:${f.line} → ${f.snippet}`);
}
console.error('If this is a false positive, add it to the ALLOWLIST in scripts/security-scan.js with a reason.');
process.exit(1);
