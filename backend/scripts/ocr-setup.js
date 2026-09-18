#!/usr/bin/env node
/**
 * Vendors Tesseract language data for OFFLINE image OCR.
 *
 *   npm run ocr:setup            # eng, fast model
 *   npm run ocr:setup -- eng best
 *   npm run ocr:setup -- eng+hin
 *
 * tesseract.js downloads language data from a CDN on first use. That is fine
 * on a laptop with internet and fatal on stage with flaky venue wifi, so we
 * download it once and read it from disk thereafter (OcrService prefers the
 * local copy and only falls back to the CDN when it is missing).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LANG_DIR } from '../src/services/ocr/OcrService.js';

const CDN = 'https://tessdata.projectnaptha.com/4.0.0';

const [langs = 'eng', quality = 'fast'] = process.argv.slice(2);
if (!['fast', 'best'].includes(quality)) {
  console.error(`Unknown quality '${quality}' — use 'fast' (small, quick) or 'best' (large, accurate).`);
  process.exit(1);
}

fs.mkdirSync(DEFAULT_LANG_DIR, { recursive: true });

let failed = 0;
for (const lang of langs.split('+').filter(Boolean)) {
  const target = path.join(DEFAULT_LANG_DIR, `${lang}.traineddata.gz`);
  if (fs.existsSync(target)) {
    console.log(`[OK] ${lang}: already vendored (${(fs.statSync(target).size / 1024).toFixed(0)} KB) — skipping`);
    continue;
  }
  const url = `${CDN}/${lang}.traineddata.gz`;
  process.stdout.write(`Downloading ${lang} (${quality}) from ${url}\n`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(target, buf);
    console.log(`[OK] ${lang}: ${(buf.length / 1024 / 1024).toFixed(2)} MB -> ${target}`);
  } catch (e) {
    failed += 1;
    console.error(`[ERROR] ${lang}: ${e.message} — check your connection and re-run.`);
  }
}

if (failed) process.exit(1);
console.log(`\nLanguage data ready in ${DEFAULT_LANG_DIR}`);
console.log('Image OCR (photos of lab reports) now works with no network at all.');
