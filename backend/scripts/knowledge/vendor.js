#!/usr/bin/env node
/**
 * Vendors the upstream clinical-knowledge inputs used by the knowledge build.
 *
 * WHY VENDOR AT ALL: the knowledge build must be reproducible and must work
 * with no network (hackathon venue wifi / offline judging). So upstream files
 * are pinned by COMMIT SHA, downloaded once, checksummed, and committed under
 * `backend/knowledge/vendor/`. Everything downstream reads only local files.
 *
 * SAFETY / LEGAL POSTURE (see knowledge/README.md):
 *   - only repositories with a permissive licence are vendored here (MIT)
 *   - one of the three sources the product was asked to learn from
 *     (garg-tejas/blood-report-parser) carries NO licence, so NO file from it
 *     is vendored: only its published taxonomy was used as a reference, and
 *     that taxonomy is re-authored in `curated/curatedMappings.js`.
 *   - no patient-level data is fetched. The MIMIC-IV database itself requires
 *     credentialed PhysioNet access and is NOT used: what is vendored is the
 *     public item ↔ LOINC *mapping table* plus the concept SQL, which contain
 *     no records, only catalog metadata and aggregate row counts.
 *
 * Two transports, tried in order, because sandboxes and conference wifi are
 * unpredictable:
 *   1. `raw.githubusercontent.com` (fast, one request per file)
 *   2. `git fetch --depth 1 origin <sha>` (works wherever `github.com` is
 *      reachable — including environments that block the raw CDN)
 *
 * Usage:
 *   node scripts/knowledge/vendor.js                 # download missing/changed files
 *   node scripts/knowledge/vendor.js --force         # re-download everything
 *   node scripts/knowledge/vendor.js --verify        # offline: verify checksums only
 *   node scripts/knowledge/vendor.js --method=git    # skip the raw-CDN attempt
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KNOWLEDGE_DIR = path.resolve(HERE, '../../knowledge');
export const VENDOR_DIR = path.join(KNOWLEDGE_DIR, 'vendor');
export const SOURCES_FILE = path.join(KNOWLEDGE_DIR, 'SOURCES.json');

const RAW = 'https://raw.githubusercontent.com';

/**
 * Pinned upstream sources. `commit` is the exact revision the vendored bytes
 * came from — refreshing the knowledge base means bumping these SHAs on
 * purpose, never silently tracking a branch.
 */
export const SOURCES = [
  {
    id: 'mimic-code',
    repo: 'MIT-LCP/mimic-code',
    commit: '303d26c623dcc9c49cc0f204468d4acc2f063797',
    licence: 'MIT',
    homepage: 'https://github.com/MIT-LCP/mimic-code',
    role: 'Canonical laboratory item catalogue: analyte names, specimen, category, unit and LOINC identity, with aggregate assay frequency.',
    files: [
      ['LICENSE', 'LICENSE'],
      ['README.md', 'README.md'],
      ['mimic-iv/mapping/d_labitems_to_loinc.csv', 'mapping/d_labitems_to_loinc.csv'],
      ['mimic-iv/mapping/lab_itemid_to_loinc.csv', 'mapping/lab_itemid_to_loinc.csv'],
      ['mimic-iv/concepts/measurement/chemistry.sql', 'concepts/chemistry.sql'],
      ['mimic-iv/concepts/measurement/complete_blood_count.sql', 'concepts/complete_blood_count.sql'],
      ['mimic-iv/concepts/measurement/blood_differential.sql', 'concepts/blood_differential.sql'],
      ['mimic-iv/concepts/measurement/enzyme.sql', 'concepts/enzyme.sql'],
      ['mimic-iv/concepts/measurement/coagulation.sql', 'concepts/coagulation.sql'],
      ['mimic-iv/concepts/measurement/inflammation.sql', 'concepts/inflammation.sql'],
      ['mimic-iv/concepts/measurement/bg.sql', 'concepts/bg.sql'],
      ['mimic-iv/concepts/measurement/vitalsign.sql', 'concepts/vitalsign.sql'],
      ['mimic-iv/concepts/measurement/icp.sql', 'concepts/icp.sql'],
    ],
  },
  {
    id: 'ocr-for-medical-laboratory-reports',
    repo: 'xuewenyuan/OCR-for-Medical-Laboratory-Reports',
    commit: '44504ee7a1d27c605e7e0e5d811026f297f876f6',
    licence: 'MIT (detection fork: MIT, endernewton/tf-faster-rcnn) · MIT (recognition: MIT, meijieru/crnn.pytorch)',
    homepage: 'https://github.com/xuewenyuan/OCR-for-Medical-Laboratory-Reports',
    role: 'Laboratory-report OCR character set (the glyph inventory a report recognizer must cover) and the patch-based detection strategy.',
    files: [
      ['README.md', 'README.md'],
      ['recognition/keys.py', 'recognition/keys.py'],
      ['recognition/LICENSE.md', 'recognition/LICENSE.md'],
      ['detection/LICENSE', 'detection/LICENSE'],
      ['detection/tools/printResults_with_crop.py', 'detection/tools/printResults_with_crop.py'],
    ],
  },
  {
    id: 'blood-report-parser',
    repo: 'garg-tejas/blood-report-parser',
    commit: 'a3cf5be2a71d8b8505ea0a6c43ac6baa5f898744',
    licence: 'NONE DECLARED — reference only, nothing vendored',
    homepage: 'https://github.com/garg-tejas/blood-report-parser',
    role:
      'Consulted for its published panel taxonomy (CBC, CMP, Lipid, LFT, KFT, Thyroid, Coagulation, Electrolytes) only. ' +
      'No file, schema, code or prose from it is copied anywhere in this repository; the taxonomy is standard clinical ' +
      'grouping and is re-authored in curated/curatedMappings.js.',
    files: [],
    noVendorReason:
      'The repository declares no licence, so vendoring its files would be a redistribution without permission. ' +
      'It also depends on hosted LLM APIs (GLM-OCR/Gemini) for extraction, which this cost-free, offline-first build ' +
      'cannot and does not use.',
  },
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function download(url, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw lastErr;
}

/**
 * Fetches a source at its pinned commit into a temp checkout using git.
 * GitHub supports fetching a specific commit with `--depth 1`, which keeps
 * this cheap (no history) while staying exactly reproducible.
 * @returns {string} path of the temporary checkout (caller removes it)
 */
function gitFetchSource(src, { log = () => {}, timeoutMs = 300_000 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `kivo-vendor-${src.id}-`));
  const git = (args) => {
    const res = spawnSync('git', args, { cwd: tmp, encoding: 'utf8', timeout: timeoutMs });
    if (res.status !== 0) {
      throw new Error(`git ${args[0]} failed for ${src.repo}: ${(res.stderr || res.stdout || '').trim().split('\n').pop()}`);
    }
    return res.stdout;
  };
  log(`  fetching ${src.repo}@${src.commit.slice(0, 10)} via git…`);
  git(['init', '-q', '.']);
  git(['remote', 'add', 'origin', `${src.homepage}.git`]);
  git(['fetch', '-q', '--depth', '1', 'origin', src.commit]);
  git(['checkout', '-q', 'FETCH_HEAD']);
  return tmp;
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * @param {{force?: boolean, verify?: boolean, method?: 'auto'|'raw'|'git', log?: Function}} opts
 * @returns {Promise<{sources: Array, downloaded: number, verified: number, skipped: number, bytes: number, transport: object}>}
 */
export async function vendorAll({ force = false, verify = false, method = 'auto', log = console.log } = {}) {
  const manifest = { generatedAt: new Date().toISOString(), sources: [] };
  let downloaded = 0;
  let verified = 0;
  let skipped = 0;
  let bytes = 0;
  const transport = {};

  for (const src of SOURCES) {
    const entry = {
      id: src.id,
      repo: src.repo,
      commit: src.commit,
      licence: src.licence,
      homepage: src.homepage,
      role: src.role,
      files: [],
      ...(src.noVendorReason ? { noVendorReason: src.noVendorReason } : {}),
    };
    if (src.files.length === 0) {
      manifest.sources.push(entry);
      continue;
    }

    // Which files still need bytes from the network?
    const pending = [];
    for (const [remote, localRel] of src.files) {
      const dest = path.join(VENDOR_DIR, src.id, localRel);
      if (!force && fs.existsSync(dest)) {
        const buf = fs.readFileSync(dest);
        skipped += 1;
        bytes += buf.length;
        entry.files.push({ path: path.relative(KNOWLEDGE_DIR, dest), bytes: buf.length, sha256: sha256(buf) });
      } else if (verify) {
        throw new Error(`verify failed: missing vendored file ${dest}`);
      } else {
        pending.push({ remote, localRel, dest, url: `${RAW}/${src.repo}/${src.commit}/${remote}` });
      }
    }

    if (verify) {
      verified += entry.files.length;
      manifest.sources.push(entry);
      continue;
    }

    let usedRaw = false;
    if (pending.length > 0 && method !== 'git') {
      try {
        const fetched = [];
        for (const p of pending) fetched.push({ ...p, buf: await download(p.url) });
        for (const f of fetched) {
          ensureDir(path.dirname(f.dest));
          fs.writeFileSync(f.dest, f.buf);
          downloaded += 1;
          bytes += f.buf.length;
          entry.files.push({ path: path.relative(KNOWLEDGE_DIR, f.dest), bytes: f.buf.length, sha256: sha256(f.buf) });
        }
        usedRaw = true;
      } catch (e) {
        log(`  raw.githubusercontent.com unavailable for ${src.id} (${e.message}) — falling back to git`);
      }
    }

    if (pending.length > 0 && !usedRaw) {
      const tmp = gitFetchSource(src, { log });
      try {
        for (const p of pending) {
          const from = path.join(tmp, p.remote);
          if (!fs.existsSync(from)) throw new Error(`pinned commit is missing ${p.remote}`);
          const buf = fs.readFileSync(from);
          ensureDir(path.dirname(p.dest));
          fs.writeFileSync(p.dest, buf);
          downloaded += 1;
          bytes += buf.length;
          entry.files.push({ path: path.relative(KNOWLEDGE_DIR, p.dest), bytes: buf.length, sha256: sha256(buf) });
        }
      } finally {
        rmrf(tmp);
      }
      transport[src.id] = 'git';
    } else if (pending.length > 0) {
      transport[src.id] = 'raw';
    } else {
      transport[src.id] = 'local';
    }

    manifest.sources.push(entry);
  }

  if (!verify) fs.writeFileSync(SOURCES_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  return { sources: manifest.sources, downloaded, verified, skipped, bytes, transport };
}

/** Reads the vendored manifest (written by vendorAll). */
export function readSources() {
  return JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  const verify = args.has('--verify');
  const methodArg = [...args].find((a) => a.startsWith('--method='))?.split('=')[1];
  try {
    const res = await vendorAll({ force: args.has('--force'), verify, method: methodArg || 'auto' });
    console.log(
      verify
        ? `verified ${res.verified} vendored file checksum(s)`
        : `vendored ${res.downloaded} new file(s), ${res.skipped} already present, manifest → ${path.relative(process.cwd(), SOURCES_FILE)}`,
    );
  } catch (e) {
    console.error(`vendor failed: ${e.message}`);
    process.exitCode = 1;
  }
}
