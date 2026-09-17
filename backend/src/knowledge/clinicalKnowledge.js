import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Clinical knowledge base — the runtime view of `knowledge/generated/`.
 *
 * The artifact is produced offline by `npm run knowledge:build` from vendored,
 * MIT-licensed upstream data plus human-reviewed mappings, and committed to the
 * repository. So this module is a pure loader: no network, no build step at
 * startup, and the same bytes in tests, demo and production.
 *
 * MEDICAL-SAFETY CONTRACT (see knowledge/README.md):
 *   - `typicalRange` is only ever present for hand-curated markers. Generated
 *     markers are `rangeSource: 'report-only'`: the app compares against the
 *     range printed on the user's own report.
 *   - `plausibilityBounds` are PHYSICAL plausibility limits, not clinical
 *     ranges. They exist to flag an implausible reading (usually a misread) for
 *     review, never to declare a value good or bad.
 *   - `valueKind: 'qualitative'` markers are findings/screens, not numbers, and
 *     are excluded from numeric extraction.
 *   - a narrative is either hand-written ('curated') or the claim-free
 *     structural fallback; generated markers never inherit a neighbour's text.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KNOWLEDGE_ARTIFACT = path.resolve(HERE, '../../knowledge/generated/clinicalKnowledge.json');

let cached = null;

/**
 * Loads (and caches) the committed knowledge artifact.
 *
 * The cache matters: this is a ~1 MB JSON document and extraction asks for a
 * marker on every matched row, so re-parsing per call would dominate extraction
 * cost (measured at ~60 ms per report before caching was fixed).
 */
export function loadClinicalKnowledge(file = null) {
  if (!file) {
    if (cached) return cached;
    cached = parseKnowledge(fs.readFileSync(KNOWLEDGE_ARTIFACT, 'utf8'));
    return cached;
  }
  return parseKnowledge(fs.readFileSync(file, 'utf8'));
}

function parseKnowledge(text) {
  const parsed = JSON.parse(text);
  if (parsed?.schema !== 'medtwin.clinicalKnowledge/1') {
    throw new Error(`Unsupported clinical knowledge schema: ${parsed?.schema}`);
  }
  return parsed;
}

/** Test seam: forget the cached artifact. */
export function resetClinicalKnowledgeCache() {
  cached = null;
}

/* --------------------------------------------------------------- queries -- */

/** All markers (curated + generated), keyed by code. */
export function allMarkers() {
  return loadClinicalKnowledge().markers;
}

/** Markers readable from a report as numbers (excludes qualitative findings). */
export function numericMarkers() {
  return Object.values(allMarkers()).filter((m) => m.valueKind !== 'qualitative');
}

/** Marker codes whose aliases should be matched during extraction. */
export function extractableMarkers() {
  return numericMarkers();
}

export function marker(code) {
  return allMarkers()[code] || null;
}

export function panels() {
  return loadClinicalKnowledge().panels;
}

export function knowledgeStats() {
  return loadClinicalKnowledge().stats;
}

export function ocrLexicon() {
  return loadClinicalKnowledge().ocrLexicon;
}

/** Converts a marker into the dictionary shape the API/frontend consumes. */
export function toDictionaryEntry(m) {
  return {
    name: m.name,
    defaultUnit: m.defaultUnit,
    units: m.units,
    typicalRange: m.typicalRange,
    betterDirection: m.betterDirection,
    loinc: m.loinc,
    panel: m.panel,
    specimen: m.specimen,
    tier: m.tier,
    valueKind: m.valueKind ?? 'numeric',
    rangeSource: m.rangeSource,
    prevalence: m.prevalence,
    narrative: m.narrative?.text ?? null,
    narrativeStatus: m.narrative?.status ?? 'structural',
    related: m.narrative?.related ?? [],
    plausibilityBounds: m.plausibilityBounds ?? null,
  };
}

/**
 * Physical plausibility check used to flag suspicious readings.
 * @returns {{plausible: boolean, reason: string|null}}
 */
export function checkPlausibility(code, value) {
  const m = marker(code);
  const v = Number(value);
  if (!m || !Number.isFinite(v)) return { plausible: true, reason: null };
  const b = m.plausibilityBounds;
  if (!b) return { plausible: true, reason: null };
  if (b.min != null && b.max != null && (v < b.min || v > b.max)) {
    return { plausible: false, reason: `${m.name} of ${v}${m.defaultUnit ? ` ${m.defaultUnit}` : ''} is outside the physically plausible range (${b.min}–${b.max}) — check the value against your report` };
  }
  if (b.min != null && v < b.min) {
    return { plausible: false, reason: `${m.name} of ${v}${m.defaultUnit ? ` ${m.defaultUnit}` : ''} is below the physically plausible minimum (${b.min}) — check the value against your report` };
  }
  if (b.max != null && v > b.max) {
    return { plausible: false, reason: `${m.name} of ${v}${m.defaultUnit ? ` ${m.defaultUnit}` : ''} is above the physically plausible maximum (${b.max}) — check the value against your report` };
  }
  return { plausible: true, reason: null };
}
