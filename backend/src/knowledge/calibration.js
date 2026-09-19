import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Extraction-confidence calibration.
 *
 * WHAT "TRAINING" MEANS HERE (and what it does not):
 *   The knowledge build gives this system the *catalogue* of what a printed lab
 *   report can contain. What it cannot give — from any public mapping table —
 *   is a probability that a value we just read off a photographed report is
 *   correct. This module consumes a model trained offline by
 *   `npm run knowledge:train` on a documented synthetic corpus (real marker
 *   names/units/plausible values × a documented OCR-corruption model; see
 *   scripts/knowledge/corruptor.js). No patient records are used, and the model
 *   card shipped in `trainedParameters.json` states exactly that.
 *
 *   The output is a probability in [0,1] that a drafted row (code + value) is
 *   correct — the number the review UI should sort by, and the number that
 *   feeds the report badge. It is monotone in the transparent rule score, so a
 *   row with a unit and a printed reference range never scores below a bare
 *   number.
 *
 * If the trained parameters are absent (fresh clone without
 * `npm run knowledge:train`), this falls back to the transparent heuristic —
 * the pipeline never depends on the artifact to function.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TRAINED_PARAMETERS_FILE = path.resolve(HERE, '../../knowledge/generated/trainedParameters.json');

let cached = null;
let loaded = false;

/**
 * True only for a structurally sound calibration artifact. A corrupt or
 * hand-edited JSON file must degrade to the transparent heuristic — never
 * throw, never produce NaN confidences downstream.
 */
function isValidArtifact(parsed) {
  if (!parsed || parsed.schema !== 'medtwin.extractionCalibration/1') return false;
  const model = parsed.model;
  if (!model || (model.kind !== 'isotonic' && model.kind !== 'logistic+isotonic')) return false;
  if (!Array.isArray(model.isotonic) || model.isotonic.length === 0) return false;
  for (const pt of model.isotonic) {
    if (!Array.isArray(pt) || pt.length < 2) return false;
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return false;
  }
  if (model.kind === 'logistic+isotonic') {
    if (!Array.isArray(model.weights) || model.weights.length !== FEATURE_NAMES.length) return false;
    if (!model.weights.every((w) => Number.isFinite(w))) return false;
  }
  return true;
}

export function loadTrainedParameters(file = null) {
  const resolved = file || TRAINED_PARAMETERS_FILE;
  if (loaded && !file) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!isValidArtifact(parsed)) return null;
    if (!file) {
      cached = parsed;
      loaded = true;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Test seam. */
export function resetCalibrationCache() {
  cached = null;
  loaded = false;
}

/** Feature vector serialization — ORDER IS PART OF THE MODEL CONTRACT. */
export const FEATURE_NAMES = [
  'bias',
  'heuristicConfidence',
  'hasUnit',
  'hasReferenceRange',
  'aliasIsLong',
  'aliasAtLineStart',
  'suspicious',
  // Repairs the normalizer had to make on this line. They are evidence about
  // the reading itself: a value that needed a glyph repaired is measurably
  // likelier to be wrong than one that came through cleanly.
  'glyphRepaired',
  'decimalRepaired',
];

/** @returns {number[]} features in FEATURE_NAMES order — finite numbers only, never NaN */
export function featurize(input = {}) {
  try {
    const {
      heuristicConfidence = 0.5,
      hasUnit = false,
      hasReferenceRange = false,
      aliasLength = 0,
      aliasAtLineStart = false,
      suspicious = false,
      glyphRepaired = false,
      decimalRepaired = false,
    } = input || {};
    const h = Number(heuristicConfidence);
    const aliasLen = Number(aliasLength);
    return [
      1,
      Number.isFinite(h) ? Math.min(1, Math.max(0, h)) : 0.5,
      hasUnit ? 1 : 0,
      hasReferenceRange ? 1 : 0,
      Number.isFinite(aliasLen) && aliasLen >= 5 ? 1 : 0,
      aliasAtLineStart ? 1 : 0,
      suspicious ? 1 : 0,
      glyphRepaired ? 1 : 0,
      decimalRepaired ? 1 : 0,
    ];
  } catch {
    return [1, 0.5, 0, 0, 0, 0, 0, 0, 0];
  }
}

function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Piecewise-linear interpolation over isotonic breakpoints — total function, never NaN/throw. */
function interpolateIsotonic(score, points) {
  const s = Number(score);
  const fallback = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0.5;
  try {
    if (!Array.isArray(points) || points.length === 0) return fallback;
    const clean = points.filter(
      (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
    );
    if (clean.length === 0) return fallback;
    if (s <= clean[0][0]) return clean[0][1];
    const last = clean[clean.length - 1];
    if (s >= last[0]) return last[1];
    for (let i = 1; i < clean.length; i += 1) {
      const [x0, y0] = clean[i - 1];
      const [x1, y1] = clean[i];
      if (s <= x1) {
        const t = x1 === x0 ? 0 : (s - x0) / (x1 - x0);
        const y = y0 + t * (y1 - y0);
        return Number.isFinite(y) ? y : fallback;
      }
    }
    return last[1];
  } catch {
    return fallback;
  }
}

const clamp = (p) => Math.min(0.995, Math.max(0.02, p));

/**
 * Calibrated probability that an extracted row is correct.
 *
 * @param {{code: string, heuristicConfidence: number, hasUnit: boolean, hasReferenceRange: boolean,
 *          aliasLength: number, aliasAtLineStart: boolean, suspicious: boolean, marker?: object}} input
 * @returns {number} probability in (0,1)
 */
export function calibrateExtraction(input = {}) {
  try {
    const safe = input && typeof input === 'object' ? input : {};
    const rawH = Number(safe.heuristicConfidence);
    const heuristicConfidence = Number.isFinite(rawH) ? Math.min(1, Math.max(0, rawH)) : 0.5;
    const suspicious = !!safe.suspicious;
    const params = loadTrainedParameters();
    if (!params) return clamp(round3(heuristicConfidence));
    if (suspicious) {
      // An implausible value is never "probably right", whatever the model says
      // about the reading quality.
      return clamp(Math.min(0.25, round3(heuristicConfidence) * 0.5));
    }
    // Two trained shapes are supported; the training run picks whichever
    // calibrates better on held-out data and records it in `model.kind`.
    let score;
    if (params.model.kind === 'logistic+isotonic' && params.model.weights) {
      const x = featurize(safe);
      const w = params.model.weights;
      let z = 0;
      for (let i = 0; i < x.length; i += 1) z += w[i] * x[i];
      // Clamp the logit: extreme weights × features must not overflow to ±Infinity.
      if (!Number.isFinite(z)) z = 0;
      z = Math.min(20, Math.max(-20, z));
      score = sigmoid(z);
    } else {
      score = heuristicConfidence;
    }
    if (!Number.isFinite(score)) score = heuristicConfidence;
    const calibrated = interpolateIsotonic(score, params.model.isotonic);
    // Guard rail: never report a *lower* confidence than the transparent rule
    // score for a row the rule considers strong, and never inflate a weak read
    // beyond what the corpus supports.
    const floor = heuristicConfidence >= 0.6 ? Math.min(heuristicConfidence, 0.9) : 0.02;
    const out = Math.max(calibrated, floor);
    return clamp(round3(Number.isFinite(out) ? out : heuristicConfidence));
  } catch {
    // Confidence scoring must never take down extraction — fall back to neutral.
    return 0.5;
  }
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * Held-out metrics for the shipped model card.
 *
 * The training run picks a shape and records it in `metrics.chosen`; the
 * matching block under `metrics.test` is the one to quote. Exposed so clients
 * (the landing page, the docs) can print the REAL score instead of a
 * hand-typed number that silently rots.
 */
function heldOutMetrics(params) {
  const test = params?.metrics?.test;
  if (!test) return null;
  const chosen =
    params.metrics.chosen === 'logistic+isotonic'
      ? test.logisticPlusIso
      : params.metrics.chosen === 'isotonic'
        ? test.isotonic
        : test.baseline;
  if (!chosen) return null;
  const rounds = (x, places = 4) => (Number.isFinite(x) ? Number(x.toFixed(places)) : null);
  return {
    brier: rounds(chosen.brier),
    ece: rounds(chosen.ece),
    auc: rounds(chosen.auc),
    accuracy: rounds(chosen.accuracy),
    sampleSize: chosen.thresholds?.[0]?.n ?? null,
  };
}

/** Model card for the UI/docs: what trained this, how well it scored. */
export function calibrationInfo() {
  const params = loadTrainedParameters();
  if (!params) {
    return { active: false, reason: 'no trained parameters committed (run `npm run knowledge:train`)' };
  }
  return {
    active: true,
    ...params.modelCard,
    trainedAt: params.trainedAt ?? null,
    corpus: params.corpus?.name ?? null,
    metrics: { heldOut: heldOutMetrics(params) },
  };
}
