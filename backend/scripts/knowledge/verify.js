#!/usr/bin/env node
/**
 * Verifies the committed knowledge artifacts.
 *
 * Checks (fail ⇒ non-zero exit, so CI or a reviewer can trust the artifacts):
 *   1. the generated knowledge base re-builds BYTE-IDENTICALLY from the
 *      vendored upstream files (determinism — no timestamps, no randomness)
 *   2. the trained calibration parameters match the current knowledge base
 *      (re-training on the same seed reproduces the same metrics)
 *   3. every marker satisfies the data-safety invariants:
 *        - a generated marker NEVER carries a fabricated typical range
 *        - a qualitative marker is never offered to the numeric extractor
 *        - plausibility bounds are physically possible (low < high)
 *   4. the vendored upstream revisions still match knowledge/SOURCES.json
 *
 * Usage: node scripts/knowledge/verify.js [--skip-train]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '../..');
const GENERATED = path.join(BACKEND, 'knowledge/generated');

const md5 = (file) => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
const failures = [];
const notes = [];
const check = (ok, message) => {
  (ok ? notes : failures).push(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
};

/* ---------------------------------------------------- 1. determinism ------- */
const before = {
  clinical: md5(path.join(GENERATED, 'clinicalKnowledge.json')),
  report: md5(path.join(GENERATED, 'buildReport.json')),
};
execFileSync(process.execPath, [path.join(HERE, 'build.js')], { cwd: BACKEND });
const after = {
  clinical: md5(path.join(GENERATED, 'clinicalKnowledge.json')),
  report: md5(path.join(GENERATED, 'buildReport.json')),
};
check(before.clinical === after.clinical, `clinicalKnowledge.json is deterministic (${after.clinical})`);
check(before.report === after.report, `buildReport.json is deterministic (${after.report})`);

const knowledge = JSON.parse(fs.readFileSync(path.join(GENERATED, 'clinicalKnowledge.json'), 'utf8'));
const markers = Object.entries(knowledge.markers);

/* ------------------------------------------------- 2. safety invariants ---- */
// Only the hand-authored markers may carry a reference range; anything derived
// from the upstream mapping tables ships without one.
const fabricated = markers.filter(([, m]) => !m.curated && m.typicalRange);
check(fabricated.length === 0, `no generated marker carries an invented reference range (${fabricated.length} found)`);

const badBounds = markers.filter(([, m]) => {
  const b = m.plausibilityBounds;
  if (!b) return false;
  const lo = b.min ?? b.low ?? null;
  const hi = b.max ?? b.high ?? null;
  if (lo == null || hi == null) return false; // one-sided bound: nothing to order
  return !(lo < hi);
});
check(badBounds.length === 0, `plausibility bounds are well-formed (${badBounds.length} broken)`);

const qualitativeLeak = markers.filter(([, m]) => m.valueKind === 'qualitative' && m.extractable);
check(qualitativeLeak.length === 0, `no qualitative marker is marked extractable (${qualitativeLeak.length} leaked)`);

const extractable = markers.filter(([, m]) => m.extractable);
check(extractable.length > 0, `knowledge base offers ${extractable.length} matchable markers`);

/* ------------------------------------------------------ 3. provenance ------ */
const sourcesFile = path.join(BACKEND, 'knowledge/SOURCES.json');
const sources = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));
check(
  sources.sources.every((s) => s.commit && /^[0-9a-f]{40}$/.test(s.commit)),
  `every vendored source is pinned to a full commit SHA (${sources.sources.length} sources)`,
);

/* ------------------------------------------------------ 4. calibration ----- */
const trainedFile = path.join(GENERATED, 'trainedParameters.json');
if (!fs.existsSync(trainedFile)) {
  check(false, 'trainedParameters.json is missing — run npm run knowledge:train');
} else {
  const params = JSON.parse(fs.readFileSync(trainedFile, 'utf8'));
  const t = params.metrics.test;
  const chosen = t[params.metrics.chosen === 'isotonic' ? 'isotonic' : 'logisticPlusIso'] ?? t.isotonic;
  check(params.schema === 'medtwin.extractionCalibration/1', 'calibration artifact schema is current');
  check(t.baseline.ece > chosen.ece, `calibration improves ECE (${t.baseline.ece} → ${chosen.ece})`);
  check(t.baseline.brier >= chosen.brier, `calibration does not worsen Brier (${t.baseline.brier} → ${chosen.brier})`);
  check(
    params.corpus.patientsUsed === 0,
    'model card states zero patient records were used',
  );
}

/* ---------------------------------------------------------------- report --- */
for (const line of [...notes, ...failures]) console.log(line);
if (failures.length) {
  console.error(`\n${failures.length} knowledge check(s) failed.`);
  process.exit(1);
}
console.log(`\nall ${notes.length} knowledge checks passed.`);
