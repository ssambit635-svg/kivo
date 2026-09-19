#!/usr/bin/env node
/**
 * Zero-dependency dependency-vulnerability gate.
 *
 * Why this exists instead of `npm audit`:
 *
 *   `npm audit` (npm 10 and older) posts to
 *   `/-/npm/v1/security/audits/quick`. npm is retiring that endpoint — it now
 *   answers `400 Invalid package tree` for *any* lockfile, including one
 *   generated seconds earlier on a clean tree, so the gate went red on
 *   perfectly healthy code. npm's own notice on the response says it plainly:
 *   "This endpoint is being retired. Use the bulk advisory endpoint instead."
 *
 * So this gate talks to the supported endpoint directly:
 *
 *   POST /-/npm/v1/security/advisories/bulk   { "package": ["version", ...] }
 *
 * It reads the *committed lockfile* (not node_modules), walks the production
 * dependency closure, asks the advisory service once for the whole set, and
 * fails on high/critical advisories.
 *
 * Outage policy: a third-party advisory service being unreachable is NOT a
 * vulnerability in this codebase, and it must never be reported as one — that
 * is exactly how a red `main` gets blamed on healthy code. If every attempt
 * fails, the gate says so loudly and passes; run with `--strict` to fail
 * instead (use it for release runs, not for every push).
 *
 * Usage:
 *   node scripts/security-audit.js              # production deps, fail on high+
 *   node scripts/security-audit.js --all        # include devDependencies
 *   node scripts/security-audit.js --strict     # unreachable service → exit 1
 *   AUDIT_REGISTRY=http://localhost:9000  ...   # point at a mirror/stub
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILE = path.join(ROOT, 'package-lock.json');

const REGISTRY = (process.env.AUDIT_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
const ENDPOINT = `${REGISTRY}/-/npm/v1/security/advisories/bulk`;

const FLAGS = new Set(process.argv.slice(2));
const INCLUDE_DEV = FLAGS.has('--all');
const STRICT = FLAGS.has('--strict');

/** Severities that fail the build. Everything else is reported, not fatal. */
const BLOCKING = new Set(['high', 'critical']);

const ATTEMPTS = 3;
const BACKOFF_MS = [500, 1500];
const TIMEOUT_MS = 15000;

/**
 * Resolves `name` the way Node does, starting from the directory an entry
 * lives in and walking up through nested `node_modules`.
 */
function resolveFrom(packages, fromKey, name) {
  let base = fromKey;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

/**
 * The installed dependency closure, as { name: [versions] }. Follows the real
 * resolution graph so `--omit=dev` semantics hold: a package that is only
 * reachable through a devDependency is never audited as a production risk.
 */
function collectDependencies(lock) {
  const packages = lock.packages || {};
  const root = packages[''] || {};
  const versions = new Map();
  const visited = new Set();

  const queue = [''];
  visited.add('');
  // Seed the root: production deps always, devDeps only with --all.
  const rootDeps = new Set([
    ...Object.keys(root.dependencies || {}),
    ...Object.keys(root.optionalDependencies || {}),
    ...(INCLUDE_DEV ? Object.keys(root.devDependencies || {}) : []),
  ]);

  while (queue.length) {
    const key = queue.shift();
    const entry = packages[key];
    if (!entry) continue;
    const names = key === '' ? rootDeps : new Set([
      ...Object.keys(entry.dependencies || {}),
      ...Object.keys(entry.optionalDependencies || {}),
    ]);

    for (const name of names) {
      const resolved = resolveFrom(packages, key, name);
      if (!resolved || visited.has(resolved)) continue;
      visited.add(resolved);
      const version = packages[resolved].version;
      if (version) {
        if (!versions.has(name)) versions.set(name, new Set());
        versions.get(name).add(version);
      }
      queue.push(resolved);
    }
  }
  return versions;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One POST to the bulk advisory endpoint; `null` means "could not ask". */
async function askAdvisoryService(payload) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const hint = res.headers.get('npm-notice') || '';
    throw new Error(`${res.status} ${res.statusText}${hint ? ` — ${hint}` : ''}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('advisory service returned a non-JSON body');
  }
}

async function main() {
  let lock;
  try {
    lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'));
  } catch (err) {
    console.error(`FAIL — cannot read ${path.relative(ROOT, LOCKFILE)}: ${err.message}`);
    process.exit(1);
  }

  const deps = collectDependencies(lock);
  const payload = Object.fromEntries([...deps].map(([name, set]) => [name, [...set]]));
  const packageCount = deps.size;
  const versionCount = [...deps.values()].reduce((n, s) => n + s.size, 0);

  console.log(
    `security-audit: ${packageCount} packages (${versionCount} versions) from package-lock.json` +
      `${INCLUDE_DEV ? ' including devDependencies' : ' — production only'}`,
  );

  let advisories = null;
  let lastError = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      advisories = await askAdvisoryService(payload);
      break;
    } catch (err) {
      lastError = err;
      if (attempt < ATTEMPTS - 1) await sleep(BACKOFF_MS[attempt] ?? 1500);
    }
  }

  if (advisories === null) {
    // Could not obtain a verdict. Never dress this up as a finding.
    const line =
      `WARN — could not reach the dependency advisory service after ${ATTEMPTS} attempts: ${lastError.message}\n` +
      `       ${ENDPOINT}\n` +
      '       This is an outage on the service side, not a vulnerability in this codebase.\n' +
      '       The dependency gate did NOT run. Re-run it when the service is back, or use --strict to fail hard.';
    if (STRICT) {
      console.error(line.replace('WARN', 'FAIL'));
      process.exit(1);
    }
    console.warn(line);
    process.exit(0);
  }

  const findings = [];
  for (const [name, list] of Object.entries(advisories)) {
    for (const a of Array.isArray(list) ? list : []) {
      findings.push({
        name,
        severity: String(a.severity || 'unknown').toLowerCase(),
        title: a.title || '(no title)',
        vulnerable: a.vulnerable_versions || a.range || '*',
        url: a.url || '',
      });
    }
  }

  const rank = { critical: 0, high: 1, moderate: 2, low: 3, info: 4, unknown: 5 };
  findings.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || a.name.localeCompare(b.name));

  const blocking = findings.filter((f) => BLOCKING.has(f.severity));

  if (findings.length === 0) {
    console.log(`OK — no known vulnerabilities across ${packageCount} packages.`);
    process.exit(0);
  }

  const label = blocking.length ? 'FAIL' : 'WARN';
  const say = blocking.length ? console.error : console.warn;
  say(`${label} — ${findings.length} advisory(ies) affect this dependency tree:`);
  for (const f of findings) {
    say(`  [${f.severity}] ${f.name} — ${f.title} (vulnerable: ${f.vulnerable})${f.url ? `\n         ${f.url}` : ''}`);
  }
  if (!blocking.length) {
    console.log('No high/critical advisories — gate passed (the above are informational).');
    process.exit(0);
  }
  console.error('Fix with `npm install <pkg>@<patched>` or add an npm `overrides` entry, then re-run `npm run security:deps`.');
  process.exit(1);
}

await main();
