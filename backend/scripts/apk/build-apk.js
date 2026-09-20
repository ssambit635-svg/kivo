#!/usr/bin/env node
/**
 * kivo APK builder — gets you a signed, installable frontend/kivo.apk.
 *
 *   npm run apk:build                 # local Android toolchain if you have one, else GitHub Actions
 *   npm run apk:build -- --local      # force a local gradle build (needs ANDROID_HOME + gradle)
 *   npm run apk:build -- --ci         # force a GitHub Actions build (needs gh, no local SDK)
 *   npm run apk:build -- --fetch      # just download the newest APK the CI already built
 *   npm run apk:build -- --verify     # verify the APK that is already in frontend/
 *
 * Why this is not a "write the bytes yourself" script any more: the previous
 * version hand-assembled the binary manifest, resources.arsc, DEX and both
 * signature schemes in Python. It produced a file that unzipped happily and
 * still made Android say "There was a problem parsing the package" — its
 * resource table had zero entries, so the manifest's android:icon reference
 * resolved to nothing. A package only survives PackageInstaller if it was built
 * by the real toolchain (AAPT2 + javac + D8 + apksig), so this script now either
 * drives that toolchain locally or asks GitHub Actions to run it, and verifies
 * the result before it is allowed to overwrite frontend/kivo.apk.
 *
 * Verification is android/tools/verify_apk.py: container, binary manifest,
 * resource table entries, icon resolution, DEX checksum/signature, v1 digests
 * and the v2/v3 signing block. Non-zero exit = the APK is NOT published.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const androidDir = path.join(repoRoot, 'android');
const verifier = path.join(androidDir, 'tools', 'verify_apk.py');
const targetApk = path.join(repoRoot, 'frontend', 'kivo.apk');
const releaseApk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const WORKFLOW = 'android.yml';
const ARTIFACT = 'kivo-apk';
const RELEASE_TAG = 'apk-latest';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);

const log = {
  step: (msg) => console.log(`\n[kivo apk] ${msg}`),
  ok: (msg) => console.log(`[OK] ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${msg}`),
  fail: (msg) => console.error(`[ERROR] ${msg}`),
};

/** Run a command, returning { status, stdout } without inheriting stdio. */
function capture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error,
  };
}

/** Run a command with the user watching (long builds). */
function stream(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  return result.status === 0;
}

function have(cmd) {
  const probe = capture(process.platform === 'win32' ? 'where' : 'which', [cmd]);
  return probe.status === 0 && probe.stdout.length > 0;
}

function gitRef() {
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  return branch.status === 0 ? branch.stdout : 'main';
}

function gitSha() {
  const sha = capture('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  return sha.status === 0 ? sha.stdout : '';
}

function pythonCmd() {
  for (const candidate of ['python3', 'python']) {
    if (have(candidate)) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* verification                                                        */
/* ------------------------------------------------------------------ */

function verify(apkPath, { required = true } = {}) {
  const py = pythonCmd();
  if (!py) {
    const msg = 'python3 not found — cannot verify the APK independently.';
    if (required) {
      log.fail(msg);
      return false;
    }
    log.warn(msg);
    return true;
  }
  if (!fs.existsSync(verifier)) {
    log.fail(`verifier missing: ${path.relative(repoRoot, verifier)}`);
    return false;
  }
  log.step(`verifying ${path.relative(repoRoot, apkPath)}`);
  const result = spawnSync(py, [verifier, apkPath], { stdio: 'inherit' });
  if (result.status !== 0) {
    log.fail('verification failed — this APK would be rejected by Android, so it was NOT published.');
    return false;
  }
  log.ok('verification passed');
  return true;
}

function publish(apkPath) {
  fs.mkdirSync(path.dirname(targetApk), { recursive: true });
  fs.copyFileSync(apkPath, targetApk);
  const size = (fs.statSync(targetApk).length / 1024).toFixed(0);
  log.ok(`published frontend/kivo.apk (${size} KB)`);
  console.log(`
Next:
  cd backend && npm start          # API + frontends on :8080
  copy frontend/kivo.apk to the phone (or serve it: http://<host>:8080/download/apk)
  open it, allow "install unknown apps", then type the server address on first run
  (the app shows this phone's own Wi-Fi IPs so you know which subnet to use)
`);
}

/* ------------------------------------------------------------------ */
/* build paths                                                         */
/* ------------------------------------------------------------------ */

function canBuildLocally() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk || !fs.existsSync(sdk)) return { ok: false, why: 'ANDROID_HOME / ANDROID_SDK_ROOT is not set' };
  if (!have('gradle')) return { ok: false, why: 'gradle is not on PATH (brew install gradle / sdkman)' };
  const java = capture('java', ['-version']);
  if (java.status !== 0) return { ok: false, why: 'no JDK on PATH (JDK 17+ required)' };
  return { ok: true };
}

function buildLocal() {
  const check = canBuildLocally();
  if (!check.ok) {
    log.fail(`cannot build locally: ${check.why}`);
    return false;
  }
  // Same scheme CI uses: yyMMddHH, so a newer build always outranks an older one.
  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const ymd = `${two(now.getUTCFullYear() % 100)}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}`;
  const versionCode = Number(`${ymd}${two(now.getUTCHours())}`);
  const versionName = `1.1.${ymd}`;
  log.step(`gradle :app:assembleRelease (versionCode ${versionCode}, versionName ${versionName})`);

  if (!fs.existsSync(path.join(androidDir, 'keystore.properties'))) {
    log.warn('no android/keystore.properties — AGP will sign with your local debug key.');
    log.warn('That installs fine on your own phone, but every machine signs differently,');
    log.warn('so an update from another machine needs the old app uninstalled first.');
  }

  const ok = stream('gradle', [
    '--stacktrace',
    `-PkivoVersionCode=${versionCode}`,
    `-PkivoVersionName=${versionName}`,
    ':app:assembleRelease',
  ], { cwd: androidDir });
  if (!ok) {
    log.fail('gradle build failed');
    return false;
  }
  if (!fs.existsSync(releaseApk)) {
    log.fail(`expected APK not found at ${releaseApk}`);
    return false;
  }
  if (!verify(releaseApk)) return false;
  publish(releaseApk);
  return true;
}

async function waitForCiRun(ref, sinceRunId) {
  const deadline = Date.now() + 30 * 60 * 1000;
  let announced = null;
  while (Date.now() < deadline) {
    const runs = capture('gh', [
      'run', 'list', '--workflow', WORKFLOW, '--branch', ref,
      '--json', 'databaseId,status,conclusion,event,headSha,createdAt,url', '--limit', '10',
    ], { cwd: repoRoot });
    if (runs.status === 0 && runs.stdout) {
      let parsed = [];
      try {
        parsed = JSON.parse(runs.stdout);
      } catch {
        parsed = [];
      }
      const fresh = parsed
        .filter((run) => Number(run.databaseId) > Number(sinceRunId || 0))
        .sort((a, b) => Number(b.databaseId) - Number(a.databaseId))[0];
      if (fresh) {
        if (!announced) {
          announced = fresh.databaseId;
          console.log(`[kivo apk] watching run ${fresh.databaseId}: ${fresh.url}`);
        }
        if (fresh.status === 'completed') return fresh;
        process.stdout.write('.');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  console.log();
  return null;
}

function downloadArtifact(runId, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const result = capture('gh', [
    'run', 'download', String(runId), '--name', ARTIFACT, '--dir', destDir,
  ], { cwd: repoRoot });
  if (result.status !== 0) {
    log.fail(`could not download the ${ARTIFACT} artifact: ${result.stderr || result.stdout}`);
    return null;
  }
  const candidates = [
    path.join(destDir, 'dist', 'kivo.apk'),
    path.join(destDir, 'kivo.apk'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function buildViaCi() {
  if (!have('gh')) {
    log.fail('the GitHub CLI (gh) is required for a CI build — or build locally with --local.');
    return false;
  }
  const auth = capture('gh', ['auth', 'status'], { cwd: repoRoot });
  if (auth.status !== 0) {
    log.fail('gh is not authenticated. Run `gh auth login`, or build locally with --local.');
    return false;
  }

  const ref = gitRef();
  const sha = gitSha();
  const remoteHasWorkflow = capture('gh', [
    'api', `repos/{owner}/{repo}/actions/workflows/${WORKFLOW}`,
  ], { cwd: repoRoot }).status === 0;

  const before = capture('gh', [
    'run', 'list', '--workflow', WORKFLOW, '--json', 'databaseId', '--limit', '1',
  ], { cwd: repoRoot });
  let sinceRunId = 0;
  try {
    sinceRunId = JSON.parse(before.stdout || '[]')[0]?.databaseId ?? 0;
  } catch {
    sinceRunId = 0;
  }

  if (remoteHasWorkflow) {
    log.step(`dispatching "${WORKFLOW}" on ${ref}`);
    const dispatch = capture('gh', ['workflow', 'run', WORKFLOW, '--ref', ref], { cwd: repoRoot });
    if (dispatch.status !== 0) {
      log.warn(`dispatch failed (${dispatch.stderr || dispatch.stdout}) — falling back to the latest run`);
    }
  } else {
    log.warn(`${WORKFLOW} is not on the remote yet (push this branch first).`);
    log.warn('Trying to reuse the most recent completed run instead.');
  }

  let run = await waitForCiRun(ref, remoteHasWorkflow ? sinceRunId : 0);
  if (!run) {
    const latest = capture('gh', [
      'run', 'list', '--workflow', WORKFLOW, '--status', 'completed',
      '--json', 'databaseId,conclusion,url,headSha', '--limit', '1',
    ], { cwd: repoRoot });
    try {
      run = JSON.parse(latest.stdout || '[]')[0] || null;
    } catch {
      run = null;
    }
    if (!run) {
      log.fail('no completed CI run to download from. Push the branch, then re-run this command.');
      return false;
    }
    log.warn(`using the most recent completed run ${run.databaseId} instead of a fresh one.`);
  }

  if (run.conclusion && run.conclusion !== 'success') {
    log.fail(`the CI run finished with conclusion "${run.conclusion}": ${run.url}`);
    return false;
  }
  if (sha && run.headSha && run.headSha !== sha) {
    log.warn(`that APK was built from ${run.headSha.slice(0, 7)}; your HEAD is ${sha.slice(0, 7)}.`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kivo-apk-'));
  const apk = downloadArtifact(run.databaseId, tmp);
  if (!apk) return false;
  log.ok(`downloaded ${path.basename(apk)} from run ${run.databaseId}`);
  if (!verify(apk)) return false;
  publish(apk);
  return true;
}

async function fetchPublished() {
  if (!have('gh')) {
    log.fail('the GitHub CLI (gh) is required to download a published APK.');
    return false;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kivo-apk-'));
  const result = capture('gh', [
    'release', 'download', RELEASE_TAG, '--pattern', 'kivo.apk', '--dir', tmp, '--clobber',
  ], { cwd: repoRoot });
  if (result.status !== 0) {
    log.fail(`no "${RELEASE_TAG}" release asset yet: ${result.stderr || result.stdout}`);
    log.warn('Run `npm run apk:build -- --ci` to build one, or open the Actions tab manually.');
    return false;
  }
  const apk = path.join(tmp, 'kivo.apk');
  log.ok(`downloaded ${RELEASE_TAG}/kivo.apk`);
  if (!verify(apk)) return false;
  publish(apk);
  return true;
}

/* ------------------------------------------------------------------ */

const mode = flag('local') ? 'local'
  : flag('ci') ? 'ci'
  : flag('fetch') ? 'fetch'
  : flag('verify') ? 'verify'
  : 'auto';

if (mode === 'verify') {
  if (!fs.existsSync(targetApk)) {
    log.fail('frontend/kivo.apk does not exist yet — build it first.');
    process.exit(1);
  }
  process.exit(verify(targetApk) ? 0 : 1);
}

if (mode === 'fetch') {
  process.exit((await fetchPublished()) ? 0 : 1);
}

if (mode === 'local') {
  process.exit(buildLocal() ? 0 : 1);
}

if (mode === 'ci') {
  process.exit((await buildViaCi()) ? 0 : 1);
}

// auto: prefer a real local toolchain, otherwise let CI do it.
const local = canBuildLocally();
if (local.ok) {
  console.log('[kivo apk] local Android toolchain detected — building here.');
  process.exit(buildLocal() ? 0 : 1);
}

console.log(`[kivo apk] no local Android toolchain (${local.why}).`);
console.log('[kivo apk] falling back to GitHub Actions — it has the SDK, JDK and gradle already.');
process.exit((await buildViaCi()) ? 0 : 1);
