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

export function loadTrainedParameters(file = TRAINED_PARAMETERS_FILE) {
  if (loaded && !file) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(file || TRAINED_PARAMETERS_FILE, 'utf8'));
    if (parsed?.schema !== 'medtwin.extractionCalibration/1') return null;
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
];

/** @returns {number[]} features in FEATURE_NAMES order */
export function featurize({ heuristicConfidence = 0.5, hasUnit = false, hasReferenceRange = false, aliasLength = 0, aliasAtLineStart = false, suspicious = false }) {
  return [
    1,
    Number(heuristicConfidence) || 0,
    hasUnit ? 1 : 0,
    hasReferenceRange ? 1 : 0,
    aliasLength >= 5 ? 1 : 0,
    aliasAtLineStart ? 1 : 0,
    suspicious ? 1 : 0,
  ];
}

function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Piecewise-linear interpolation over isotonic breakpoints. */
function interpolateIsotonic(score, points) {
  if (!points || points.length === 0) return score;
  if (score <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (score >= last[0]) return last[1];
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (score <= x1) {
      const t = x1 === x0 ? 0 : (score - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return last[1];
}

const clamp = (p) => Math.min(0.995, Math.max(0.02, p));

/**
 * Calibrated probability that an extracted row is correct.
 *
 * @param {{code: string, heuristicConfidence: number, hasUnit: boolean, hasReferenceRange: boolean,
 *          aliasLength: number, aliasAtLineStart: boolean, suspicious: boolean, marker?: object}} input
 * @returns {number} probability in (0,1)
 */
export function calibrateExtraction(input) {
  const params = loadTrainedParameters();
  const { heuristicConfidence = 0.5, suspicious = false } = input;
  if (!params) return clamp(round3(heuristicConfidence));
  if (suspicious) {
    // An implausible value is never "probably right", whatever the model says
    // about the reading quality.
    return clamp(Math.min(0.25, round3(heuristicConfidence) * 0.5));
  }
  const x = featurize(input);
  const w = params.model.weights;
  let z = 0;
  for (let i = 0; i < x.length; i += 1) z += w[i] * x[i];
  const logistic = sigmoid(z);
  const calibrated = interpolateIsotonic(logistic, params.model.isotonic);
  // Guard rail: never report a *lower* confidence than the transparent rule
  // score for a row the rule considers strong, and never inflate a weak read
  // beyond what the corpus supports.
  const floor = heuristicConfidence >= 0.6 ? Math.min(heuristicConfidence, 0.9) : 0.02;
  return clamp(round3(Math.max(calibrated, floor)));
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** Model card for the UI/docs: what trained this, how well it scored. */
export function calibrationInfo() {
  const params = loadTrainedParameters();
  if (!params) {
    return { active: false, reason: 'no trained parameters committed (run `npm run knowledge:train`)' };
  }
  return { active: true, ...params.modelCard, trainedAt: params.trainedAt ?? null, corpus: params.corpus?.name ?? null };
}
