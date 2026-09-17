#!/usr/bin/env node
/**
 * Trains the extraction-confidence calibration model.
 *
 * WHAT THIS ACTUALLY TRAINS (read this before quoting a metric):
 *   A binary classifier over *synthetic* lab-report readings. The inputs are
 *   the marker catalogue from the committed knowledge base; the noise comes
 *   from a documented OCR-corruption model (corruptor.js) derived from the
 *   glyph inventory of the vendored laboratory-report recognizer. The label is
 *   "did the extraction pipeline recover this marker's code and value?".
 *
 *   It does NOT train a clinical model, it does NOT consume patient records,
 *   and its metrics are OCR-reading metrics — not medical accuracy. The model
 *   card written alongside the parameters says so, in the artifact itself.
 *
 * Output: knowledge/generated/trainedParameters.json
 *   - weights      logistic-regression weights (interpretable, small)
 *   - isotonic     monotone recalibration of the logistic score
 *   - metrics      train/test Brier + ECE, accuracy at review thresholds
 *   - diagnostics  per-corruption-type failure rates, plausibility-guard hits
 *   - modelCard    what it is, what it is not, how to reproduce it
 *
 * Usage:
 *   node scripts/knowledge/train.js [--per-marker=2] [--quick]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpus, splitByMarker } from './corruptor.js';
import { FEATURE_NAMES, featurize } from '../../src/knowledge/calibration.js';
import { numericMarkers } from '../../src/knowledge/clinicalKnowledge.js';
import { LabExtractionService, resetPatternIndex } from '../../src/services/labs/LabExtractionService.js';
import { readSources } from './vendor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATED = path.resolve(HERE, '../../knowledge/generated');

/* ------------------------------------------------------------ utilities --- */

function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function brier(pairs) {
  if (pairs.length === 0) return 0;
  return pairs.reduce((s, [p, y]) => s + (p - y) ** 2, 0) / pairs.length;
}

/** Expected calibration error over equal-width bins. */
export function expectedCalibrationError(pairs, bins = 10) {
  if (pairs.length === 0) return 0;
  const buckets = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  for (const [p, y] of pairs) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    buckets[idx].n += 1;
    buckets[idx].p += p;
    buckets[idx].y += y;
  }
  let ece = 0;
  for (const b of buckets) {
    if (b.n === 0) continue;
    ece += (b.n / pairs.length) * Math.abs(b.p / b.n - b.y / b.n);
  }
  return ece;
}

function accuracyAt(pairs, threshold) {
  const selected = pairs.filter(([p]) => p >= threshold);
  const correct = selected.filter(([, y]) => y === 1).length;
  return { threshold, coverage: selected.length / (pairs.length || 1), accuracy: selected.length ? correct / selected.length : 0, n: selected.length };
}

/** Pool-adjacent-violators — monotone (isotonic) regression. */
export function fitIsotonic(pairs) {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const blocks = [];
  for (const [x, y] of sorted) {
    blocks.push({ x0: x, x1: x, sumY: y, n: 1 });
    while (blocks.length > 1) {
      const b2 = blocks[blocks.length - 1];
      const b1 = blocks[blocks.length - 2];
      if (b1.sumY / b1.n >= b2.sumY / b2.n) break;
      blocks.pop();
      blocks.pop();
      blocks.push({ x0: b1.x0, x1: b2.x1, sumY: b1.sumY + b2.sumY, n: b1.n + b2.n });
    }
  }
  const points = blocks.map((b) => [(b.x0 + b.x1) / 2, b.sumY / b.n]);
  // Guarantee strictly increasing x for interpolation.
  const out = [];
  for (const p of points) {
    if (out.length && p[0] <= out[out.length - 1][0]) continue;
    out.push(p.map((v) => Math.round(v * 1e6) / 1e6));
  }
  if (out.length === 0) out.push([0, 0.5], [1, 0.5]);
  return out;
}

/** Logistic regression by full-batch gradient descent with L2. */
export function fitLogistic(rows, { epochs = 400, lr = 0.35, l2 = 1e-3 } = {}) {
  const weights = new Array(FEATURE_NAMES.length).fill(0);
  const n = rows.length || 1;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const grad = new Array(weights.length).fill(0);
    for (const { x, y } of rows) {
      let z = 0;
      for (let i = 0; i < weights.length; i += 1) z += weights[i] * x[i];
      const err = sigmoid(z) - y;
      for (let i = 0; i < weights.length; i += 1) grad[i] += err * x[i];
    }
    for (let i = 0; i < weights.length; i += 1) {
      const penalty = i === 0 ? 0 : l2 * weights[i];
      weights[i] -= lr * ((grad[i] / n) + penalty);
    }
  }
  return weights.map((w) => Math.round(w * 1e6) / 1e6);
}

/* ---------------------------------------------------------------- training -- */

export function runTraining({ perMarker = 2, intensities = [0, 1, 2, 3], seed = 20260917 } = {}) {
  const markers = numericMarkers().filter((m) => m.aliases?.length);
  const examples = buildCorpus({ markers, perMarker, intensities, seed });
  const { train, test } = splitByMarker(examples, 0.3, 7);

  const extractor = new LabExtractionService();

  const evaluateExample = (ex, { normalize }) => {
    const { extracted, normalization } = extractor.extract(ex.line, { normalize });
    const row = extracted.find((e) => e.code === ex.code) || null;
    const codeOk = Boolean(row);
    const tol = Math.max(1e-9, Math.abs(ex.trueValue) * 0.005);
    const valueOk = codeOk && Math.abs(row.value - ex.trueValue) <= tol;
    return {
      ex,
      row,
      correct: codeOk && valueOk,
      codeOk,
      valueOk,
      suspicious: Boolean(row?.suspicious),
      features: {
        heuristicConfidence: row?.heuristicConfidence ?? 0.5,
        hasUnit: Boolean(row?.unit),
        hasReferenceRange: row ? row.refLow != null || row.refHigh != null : false,
        aliasLength: row?.matchedAlias?.length ?? 0,
        aliasAtLineStart: row ? row.rawLine.toLowerCase().startsWith(row.matchedAlias?.toLowerCase() ?? '') : false,
        suspicious: Boolean(row?.suspicious),
      },
      normalizations: normalization?.corrections?.length ?? 0,
    };
  };

  const runSet = (set, opts) => set.map((ex) => evaluateExample(ex, opts));

  const withNormalize = runSet(train.flatMap((ex) => [ex]), { normalize: true });
  const testWithNormalize = runSet(test, { normalize: true });
  const testWithoutNormalize = runSet(test, { normalize: false });

  // ── corpus summary
  const clean = testWithNormalize.filter((r) => r.ex.intensity === 0);
  const doc = {
    examples: examples.length,
    train: train.length,
    test: test.length,
    markers: markers.length,
    byIntensity: intensities.map((i) => {
      const set = testWithNormalize.filter((r) => r.ex.intensity === i);
      return {
        intensity: i,
        n: set.length,
        codeRecovery: ratio(set.filter((r) => r.codeOk).length, set.length),
        valueRecovery: ratio(set.filter((r) => r.valueOk).length, set.length),
      };
    }),
    normalization: {
      normalizedAccuracy: ratio(testWithNormalize.filter((r) => r.correct).length, testWithNormalize.length),
      rawAccuracy: ratio(testWithoutNormalize.filter((r) => r.correct).length, testWithoutNormalize.length),
      linesChanged: testWithNormalize.filter((r) => r.normalizations > 0).length,
    },
    byCorruptionType: {},
  };

  for (const type of new Set(testWithNormalize.flatMap((r) => r.ex.corruptionTypes))) {
    const set = testWithNormalize.filter((r) => r.ex.corruptionTypes.includes(type));
    const raw = testWithoutNormalize.filter((r) => r.ex.corruptionTypes.includes(type));
    doc.byCorruptionType[type] = {
      n: set.length,
      normalizedAccuracy: ratio(set.filter((r) => r.correct).length, set.length),
      rawAccuracy: ratio(raw.filter((r) => r.correct).length, raw.length),
    };
  }

  // ── plausibility guard effectiveness
  const wrongReads = testWithNormalize.filter((r) => r.row && !r.correct);
  doc.plausibilityGuard = {
    wrongReads: wrongReads.length,
    flaggedSuspicious: wrongReads.filter((r) => r.suspicious).length,
    flagRate: ratio(wrongReads.filter((r) => r.suspicious).length, wrongReads.length),
    falseFlagRateOnCorrect: ratio(
      testWithNormalize.filter((r) => r.correct && r.suspicious).length,
      Math.max(1, testWithNormalize.filter((r) => r.correct).length),
    ),
  };

  // ── model A: isotonic on the transparent heuristic
  const isoPairsTrain = withNormalize.map((r) => [r.features.heuristicConfidence, r.correct ? 1 : 0]);
  const iso = fitIsotonic(isoPairsTrain);
  const interp = (score, points) => {
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
  };

  // ── model B: logistic on reading features, then isotonic on its output
  const rows = withNormalize.map((r) => ({ x: featurize(r.features), y: r.correct ? 1 : 0 }));
  const weights = fitLogistic(rows);
  const logisticScoresTrain = withNormalize.map((r) => {
    const x = featurize(r.features);
    let z = 0;
    for (let i = 0; i < x.length; i += 1) z += weights[i] * x[i];
    return [sigmoid(z), r.correct ? 1 : 0];
  });
  const isoOnLogistic = fitIsotonic(logisticScoresTrain);

  const evalTest = (predict) => {
    const pairs = testWithNormalize.map((r) => [predict(r), r.correct ? 1 : 0]);
    return {
      brier: round4(brier(pairs)),
      ece: round4(expectedCalibrationError(pairs)),
      accuracy: round4(ratio(pairs.filter(([p, y]) => (p >= 0.5 ? 1 : 0) === y).length, pairs.length)),
      thresholds: [0.5, 0.6, 0.8].map((t) => accuracyAt(pairs, t)),
    };
  };

  const baseline = evalTest((r) => clamp01(r.features.heuristicConfidence));
  const isoOnly = evalTest((r) => clamp01(interp(r.features.heuristicConfidence, iso)));
  const logisticPlusIso = evalTest((r) => {
    const x = featurize(r.features);
    let z = 0;
    for (let i = 0; i < x.length; i += 1) z += weights[i] * x[i];
    return clamp01(interp(sigmoid(z), isoOnLogistic));
  });

  const candidates = [
    { kind: 'isotonic', metrics: isoOnly },
    { kind: 'logistic+isotonic', metrics: logisticPlusIso },
  ];
  const chosen = candidates.slice().sort((a, b) => a.metrics.brier - b.metrics.brier)[0];

  const params = {
    schema: 'medtwin.extractionCalibration/1',
    model: {
      kind: chosen.kind,
      featureNames: FEATURE_NAMES,
      weights: chosen.kind === 'logistic+isotonic' ? weights : null,
      isotonic: chosen.kind === 'logistic+isotonic' ? isoOnLogistic : iso,
      suspiciousBranch: 'short-circuits to <=0.25 (an implausible value is never "probably correct")',
    },
    metrics: {
      chosen: chosen.kind,
      test: { baseline: baseline, isotonic: isoOnly, logisticPlusIso: logisticPlusIso },
      trainSize: train.length,
      testSize: test.length,
    },
    diagnostics: doc,
    corpus: {
      name: 'synthetic-lab-reading-v1',
      description:
        'Marker names/units/values sampled from the committed knowledge catalogue, corrupted with the documented OCR noise model in scripts/knowledge/corruptor.js.',
      seed,
      perMarker,
      intensities,
      patientsUsed: 0,
      note: 'No patient records are used or redistributed. This measures OCR reading reliability, not clinical accuracy.',
    },
    sources: readSources().sources.map((s) => ({ id: s.id, repo: s.repo, commit: s.commit, licence: s.licence })),
    modelCard: {
      intendedUse: 'Rank and gate DRAFT extracted lab rows for review; never a clinical decision, never a diagnosis.',
      trainedOn: 'Synthetic readings derived from the committed marker catalogue + documented OCR noise model.',
      notTrainedOn: 'Patient data (MIMIC-IV itself is credentialed and is NOT used or shipped — only its public item↔LOINC mapping tables and concept SQL are vendored).',
      limitations: [
        'Synthetic noise cannot cover every scanner, camera, font or paper condition.',
        'Calibration is per-reading quality, not clinical meaningfulness.',
        'Markers absent from the catalogue are never recovered, so coverage, not confidence, is the limiting factor for exotic tests.',
      ],
      reproduce: 'npm run knowledge:train',
    },
  };

  return { params, modelSummary: { chosen: chosen.kind, baseline, isoOnly, logisticPlusIso, doc } };
}

const clamp01 = (p) => Math.min(0.999, Math.max(0.001, p));
const ratio = (a, b) => (b === 0 ? 0 : a / b);
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/* ------------------------------------------------------------------- CLI --- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, dflt) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split('=')[1]) : dflt;
  };
  const perMarker = process.argv.includes('--quick') ? 1 : arg('per-marker', 2);
  const started = Date.now();
  resetPatternIndex();
  const { params, modelSummary } = runTraining({ perMarker });
  fs.mkdirSync(GENERATED, { recursive: true });
  fs.writeFileSync(path.join(GENERATED, 'trainedParameters.json'), `${JSON.stringify(params, null, 2)}\n`);
  const m = modelSummary;
  console.log(`trained in ${((Date.now() - started) / 1000).toFixed(1)}s · model: ${m.chosen}`);
  console.log(
    `  corpus: ${params.diagnostics.examples} examples (${params.metrics.trainSize} train / ${params.metrics.testSize} test), ` +
      `clean value recovery ${(m.doc.byIntensity[0].valueRecovery * 100).toFixed(1)}%`,
  );
  console.log(
    `  Brier  baseline ${m.baseline.brier} → isotonic ${m.isoOnly.brier} → logistic+isotonic ${m.logisticPlusIso.brier}\n` +
      `  ECE    baseline ${m.baseline.ece} → isotonic ${m.isoOnly.ece} → logistic+isotonic ${m.logisticPlusIso.ece}`,
  );
  console.log(
    `  normalization: raw ${(m.doc.normalization.rawAccuracy * 100).toFixed(1)}% → normalized ${(m.doc.normalization.normalizedAccuracy * 100).toFixed(1)}% correct`,
  );
  console.log(
    `  plausibility guard caught ${m.doc.plausibilityGuard.flaggedSuspicious}/${m.doc.plausibilityGuard.wrongReads} wrong reads ` +
      `(${(m.doc.plausibilityGuard.flagRate * 100).toFixed(1)}%), false-flagged ${(m.doc.plausibilityGuard.falseFlagRateOnCorrect * 100).toFixed(2)}% of correct reads`,
  );
}
