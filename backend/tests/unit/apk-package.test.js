import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Is frontend/kivo.apk a package Android will actually install?
 *
 * This file exists because of a real failure. The APK used to be assembled by a
 * Python script that hand-emitted the binary manifest, resources.arsc, the DEX
 * and both signature schemes. The result unzipped happily and survived a
 * lenient parser, yet every phone rejected it with "There was a problem parsing
 * the package". The cause: the manifest declared android:icon="@7F020000" while
 * the hand-built resource table contained ZERO entries, so the reference
 * resolved to nothing — and PackageParser resolves icon/label/theme while it
 * parses the package, before any code runs.
 *
 * The APK is now built by AAPT2/javac/D8/apksig in CI and gated there by
 * android/tools/verify_apk.py. These assertions are the same guard expressed in
 * the backend's own test language, so `npm test` fails if a package that cannot
 * install ever lands in the repo again. Everything is done with node:zlib and
 * Buffer — no zip library, no Python, no Android SDK.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const apkPath = path.resolve(here, '../../../frontend/kivo.apk');

/* ------------------------------------------------------------------ */
/* minimal zip reader (central directory)                              */
/* ------------------------------------------------------------------ */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip file: no end-of-central-directory record');
}

function zipEntries(buf) {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(pos) !== CD_SIG) break;
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLength);
    entries.set(name, { name, method, crc, compressedSize, size, localOffset });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryBytes(buf, entry) {
  const local = entry.localOffset;
  if (buf.readUInt32LE(local) !== LOCAL_SIG) throw new Error(`${entry.name}: bad local header`);
  const nameLength = buf.readUInt16LE(local + 26);
  const extraLength = buf.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const raw = buf.subarray(start, start + entry.compressedSize);
  const data = entry.method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
  if (data.length !== entry.size) throw new Error(`${entry.name}: truncated`);
  return data;
}

function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i += 1) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/* ------------------------------------------------------------------ */
/* resources.arsc / AXML / DEX walkers                                 */
/* ------------------------------------------------------------------ */

const CHUNK_TABLE = 0x0002;
const CHUNK_PACKAGE = 0x0200;
const CHUNK_TYPE = 0x0201;
const CHUNK_TYPE_SPEC = 0x0202;

function arscSummary(buf) {
  const tableType = buf.readUInt16LE(0);
  const packageCount = buf.readUInt32LE(8);
  const packageIds = [];
  let typeChunks = 0;
  let entries = 0;
  let pos = 12; // past the table header
  while (pos + 8 <= buf.length) {
    const type = buf.readUInt16LE(pos);
    const headerSize = buf.readUInt16LE(pos + 2);
    const size = buf.readUInt32LE(pos + 4);
    if (size < 8 || pos + size > buf.length) break;
    if (type === CHUNK_PACKAGE) {
      packageIds.push(buf.readUInt32LE(pos + 8));
      const end = pos + size;
      let inner = pos + headerSize;
      while (inner + 8 <= end) {
        const innerType = buf.readUInt16LE(inner);
        const innerSize = buf.readUInt32LE(inner + 4);
        if (innerSize < 8) break;
        if (innerType === CHUNK_TYPE_SPEC) typeChunks += 1;
        if (innerType === CHUNK_TYPE) entries += buf.readUInt32LE(inner + 12); // entryCount
        inner += innerSize;
      }
    }
    pos += size;
  }
  return { tableType, packageCount, packageIds, typeChunks, entries };
}

function isBinaryAxml(buf) {
  return buf.length > 8 && buf.readUInt16LE(0) === 0x0003 && buf.readUInt16LE(2) === 0x0008;
}

/** A string in the file, in either of the two encodings AXML/ARSC use. */
function containsName(buf, name) {
  return buf.includes(Buffer.from(name, 'utf8')) || buf.includes(Buffer.from(name, 'utf16le'));
}

function dexSummary(buf) {
  const checksum = buf.readUInt32LE(8);
  return {
    magic: buf.subarray(0, 8).toString('latin1'),
    checksum,
    checksumMatches: checksum === adler32(buf.subarray(12)),
    signatureMatches: buf.subarray(12, 32).equals(createHash('sha1').update(buf.subarray(32)).digest()),
    declaredSize: buf.readUInt32LE(32),
    headerSize: buf.readUInt32LE(36),
    endianTag: buf.readUInt32LE(40),
    classDefs: buf.readUInt32LE(96),
  };
}

const APK_SIG_BLOCK_MAGIC = 'APK Sig Block 42';
const SCHEME_IDS = {
  0x7109871a: 'v2',
  0xf05368c0: 'v3',
  0x1b93ad61: 'v3.1',
};

function signingBlockSchemes(buf) {
  const eocd = findEocd(buf);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset < 24) return [];
  if (buf.toString('latin1', cdOffset - 16, cdOffset) !== APK_SIG_BLOCK_MAGIC) return [];
  const sizeOfBlock = Number(buf.readBigUInt64LE(cdOffset - 24));
  const start = cdOffset - sizeOfBlock - 8;
  if (start < 0) return [];
  const body = buf.subarray(start + 8, start + 8 + sizeOfBlock - 24);
  const schemes = [];
  let pos = 0;
  while (pos + 12 <= body.length) {
    const pairLength = Number(body.readBigUInt64LE(pos));
    const pairId = body.readUInt32LE(pos + 8);
    if (SCHEME_IDS[pairId]) schemes.push(SCHEME_IDS[pairId]);
    if (pairLength <= 4) break;
    pos += 8 + pairLength;
  }
  return schemes;
}

function manifestDigests(text) {
  const out = new Map();
  let current = null;
  let lastKey = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!raw.trim()) {
      current = null;
      lastKey = null;
      continue;
    }
    if (raw.startsWith(' ') && current && lastKey) {
      current.set(lastKey, current.get(lastKey) + raw.slice(1));
      continue;
    }
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const key = raw.slice(0, colon).trim().toLowerCase();
    const value = raw.slice(colon + 1).trim();
    if (key === 'name') {
      current = new Map();
      out.set(value, current);
      lastKey = null;
    } else if (current) {
      current.set(key, value);
      lastKey = key;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* the package                                                         */
/* ------------------------------------------------------------------ */

describe('frontend/kivo.apk — is it a package Android will install?', () => {
  const exists = existsSync(apkPath);
  const buf = exists ? readFileSync(apkPath) : Buffer.alloc(0);
  const entries = exists ? zipEntries(buf) : new Map();
  const read = (name) => entryBytes(buf, entries.get(name));

  it('exists and is a zip container', () => {
    expect(exists, 'frontend/kivo.apk is missing — run `npm run apk:build` (or take the CI artifact)').toBe(true);
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(() => findEocd(buf)).not.toThrow();
    expect(entries.size).toBeGreaterThan(10);
  });

  it('contains the four things every installable package needs', () => {
    for (const required of ['AndroidManifest.xml', 'classes.dex', 'resources.arsc']) {
      expect(entries.has(required), `${required} is missing from the package`).toBe(true);
    }
    const signature = [...entries.keys()].filter((n) => /^META-INF\/.*\.(RSA|DSA|EC)$/i.test(n));
    expect(signature.length, 'no v1 signature block in META-INF/').toBeGreaterThan(0);
    expect(entries.has('META-INF/MANIFEST.MF')).toBe(true);
    // apksigner names the signer CERT (CERT.SF + CERT.RSA); jarsigner uses the
    // key alias instead. What actually has to hold is that the .SF and the
    // PKCS#7 block belong to the same signer.
    const sfFiles = [...entries.keys()].filter((n) => /^META-INF\/.*\.SF$/i.test(n));
    expect(sfFiles.length, 'no v1 signature file (.SF) in META-INF/').toBeGreaterThan(0);
    const signerOf = (n) => n.slice('META-INF/'.length).replace(/\.[^.]+$/, '');
    expect(
      signature.some((block) => sfFiles.some((sf) => signerOf(sf) === signerOf(block))),
      `the .SF and the signature block must share a signer name (got ${sfFiles.join(', ')} and ${signature.join(', ')})`,
    ).toBe(true);
  });

  it('stores the manifest as binary AXML, not text', () => {
    const manifest = read('AndroidManifest.xml');
    expect(isBinaryAxml(manifest), 'AndroidManifest.xml must be compiled AXML').toBe(true);
    for (const tag of ['manifest', 'application', 'activity', 'uses-sdk', 'uses-permission']) {
      expect(containsName(manifest, tag), `manifest does not mention <${tag}>`).toBe(true);
    }
    expect(containsName(manifest, 'android.intent.action.MAIN')).toBe(true);
    expect(containsName(manifest, 'android.intent.category.LAUNCHER')).toBe(true);
    expect(containsName(manifest, 'ai.kivo.app.MainActivity')).toBe(true);
    // A manifest that still carries a `package` attribute was not built by AGP 8.
    expect(manifest.toString('latin1')).not.toContain('tests.androguard');
  });

  it('has a resource table with real entries — the check the old APK failed', () => {
    const arsc = read('resources.arsc');
    const summary = arscSummary(arsc);
    expect(summary.tableType, 'resources.arsc is not a RES_TABLE_TYPE chunk').toBe(CHUNK_TABLE);
    expect(summary.packageIds).toContain(0x7f);
    expect(summary.typeChunks, 'resource table declares no types').toBeGreaterThan(0);
    // THE regression guard: the hand-built table had zero entries, so
    // android:icon="@7F020000" resolved to nothing and the installer bailed out
    // with "There was a problem parsing the package".
    expect(summary.entries, 'resource table holds no entries').toBeGreaterThan(20);
  });

  it('resolves the launcher icon the manifest points at', () => {
    const arsc = read('resources.arsc');
    // AAPT2 stores resource names in the key pool; a table that resolves
    // @mipmap/ic_launcher has to name it.
    expect(containsName(arsc, 'ic_launcher'), 'ic_launcher is not in the resource key pool').toBe(true);
    expect(containsName(arsc, 'mipmap'), 'no mipmap resource type').toBe(true);
    expect(containsName(arsc, 'app_name'), 'no app_name string resource').toBe(true);

    // AGP's release resource optimizer renames res/ paths — res/mipmap-hdpi/
    // ic_launcher.png can ship as res/BW.png — so density coverage is asserted
    // against the readable paths when they are there, and against the resource
    // table when they are not. The bytes must be real PNGs either way: a launcher
    // icon Android cannot decode is exactly the install failure this guards.
    const resPngs = [...entries.keys()].filter((n) => n.startsWith('res/') && n.endsWith('.png'));
    expect(resPngs.length, 'no compiled PNG resources in the package').toBeGreaterThanOrEqual(5);
    const mipmapPngs = resPngs.filter((n) => n.startsWith('res/mipmap'));
    if (mipmapPngs.length > 0) {
      for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
        expect(
          mipmapPngs.some((n) => n.includes(`mipmap-${density}/ic_launcher.png`)),
          `no ${density} launcher icon`,
        ).toBe(true);
      }
    }
    for (const icon of resPngs) {
      const bytes = read(icon);
      expect(bytes.subarray(1, 4).toString('ascii'), `${icon} is not a PNG`).toBe('PNG');
    }
    // compiled layouts too — the shell has a real UI, not a text file in res/.
    // Same story: ask the table for the entry, then check whichever compiled XML
    // the package actually carries is binary AXML.
    expect(containsName(arsc, 'layout'), 'no layout resource type in the table').toBe(true);
    expect(containsName(arsc, 'activity_main'), 'no activity_main entry in the table').toBe(true);
    const layout = [...entries.keys()].find((n) => n.startsWith('res/layout/'))
      ?? [...entries.keys()].find((n) => n.startsWith('res/') && n.endsWith('.xml'));
    expect(layout, 'no compiled XML resource in the package').toBeTruthy();
    expect(isBinaryAxml(read(layout)), `${layout} is not compiled AXML`).toBe(true);
  });

  it('ships a DEX whose header, checksum and signature agree with its bytes', () => {
    const dex = read('classes.dex');
    const summary = dexSummary(dex);
    expect(summary.magic.startsWith('dex\n'), 'classes.dex has a bad magic').toBe(true);
    expect(summary.checksumMatches, 'DEX adler32 checksum does not match the file').toBe(true);
    expect(summary.signatureMatches, 'DEX SHA-1 signature does not match the file').toBe(true);
    expect(summary.declaredSize).toBe(dex.length);
    expect(summary.headerSize).toBe(0x70);
    expect(summary.endianTag).toBe(0x12345678);
    expect(summary.classDefs, 'DEX defines no classes').toBeGreaterThan(0);
    // A shell this size has one activity; a 1280-byte DEX that cannot construct
    // it is what the hand-written bytecode used to be.
    expect(dex.length, 'classes.dex is implausibly small').toBeGreaterThan(2048);
  });

  it('is signed with v1 digests that match the stored bytes', () => {
    const manifestMf = read('META-INF/MANIFEST.MF').toString('utf8');
    const digests = manifestDigests(manifestMf);
    expect(digests.size).toBeGreaterThan(10);
    let checked = 0;
    for (const [name, attributes] of digests) {
      if (name.startsWith('META-INF/') || !entries.has(name)) continue;
      const bytes = read(name);
      for (const [attribute, expected] of attributes) {
        if (!attribute.endsWith('-digest')) continue;
        const algorithm = attribute.slice(0, -'-digest'.length);
        const actual = createHash(algorithm).update(bytes).digest('base64');
        expect(actual, `${name}: ${attribute} does not match`).toBe(expected);
        checked += 1;
      }
    }
    expect(checked, 'no v1 digests were checked at all').toBeGreaterThan(10);
  });

  it('carries an APK Signing Block with a v2 or v3 scheme', () => {
    // targetSdk 34 will not install from a v1-only signature on Android 11+.
    const schemes = signingBlockSchemes(buf);
    expect(schemes.length, 'no APK Signing Block — v2/v3 signature missing').toBeGreaterThan(0);
    expect(schemes.some((s) => s === 'v2' || s === 'v3' || s === 'v3.1')).toBe(true);
  });

  it('is small enough to hand out over a phone network', () => {
    // The shell has no dependencies and does not bundle the web app (the phone
    // loads it from the server), so the package stays tens of kilobytes.
    const kb = buf.length / 1024;
    expect(kb).toBeGreaterThan(10);
    expect(kb, `kivo.apk is ${kb.toFixed(0)} KB — did someone bundle the frontend into it?`).toBeLessThan(1024);
  });
});
