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
  const c = Number.isFinite(z) ? Math.min(20, Math.max(-20, z)) : 0;
  if (c >= 0) return 1 / (1 + Math.exp(-c));
  const e = Math.exp(c);
  return e / (1 + e);
}

/** Keep only well-formed [probability, label] pairs — metrics never see NaN. */
function cleanPairs(pairs) {
  if (!Array.isArray(pairs)) return [];
  return pairs.filter(
    (pr) => Array.isArray(pr) && Number.isFinite(pr[0]) && (pr[1] === 1 || pr[1] === 0),
  );
}

function brier(pairs) {
  const clean = cleanPairs(pairs);
  if (clean.length === 0) return 0;
  return clean.reduce((s, [p, y]) => s + (p - y) ** 2, 0) / clean.length;
}

/** Expected calibration error over equal-width bins. */
export function expectedCalibrationError(pairs, bins = 10) {
  const clean = cleanPairs(pairs);
  if (clean.length === 0) return 0;
  const b = Number.isInteger(bins) && bins > 0 ? Math.min(bins, 50) : 10;
  const buckets = Array.from({ length: b }, () => ({ n: 0, p: 0, y: 0 }));
  for (const [p, y] of clean) {
    const idx = Math.min(b - 1, Math.max(0, Math.floor(p * b)));
    buckets[idx].n += 1;
    buckets[idx].p += p;
    buckets[idx].y += y;
  }
  let ece = 0;
  for (const bucket of buckets) {
    if (bucket.n === 0) continue;
    ece += (bucket.n / clean.length) * Math.abs(bucket.p / bucket.n - bucket.y / bucket.n);
  }
  return Number.isFinite(ece) ? ece : 0;
}

function accuracyAt(pairs, threshold) {
  const clean = cleanPairs(pairs);
  const t = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.5;
  const selected = clean.filter(([p]) => p >= t);
  const correct = selected.filter(([, y]) => y === 1).length;
  return { threshold: t, coverage: selected.length / (clean.length || 1), accuracy: selected.length ? correct / selected.length : 0, n: selected.length };
}

/** Pool-adjacent-violators — monotone (isotonic) regression. */
export function fitIsotonic(pairs) {
  const sorted = cleanPairs(pairs).sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return [[0, 0.5], [1, 0.5]];
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

/**
 * Isotonic calibration with Beta-prior shrinkage.
 *
 * Raw PAV on a finite sample is noisy at the extremes: a bin whose point
 * estimate is 0 or 1 is usually over-fit, and blowing a confidence up to 1.0
 * *increases* Brier error even though it looks perfectly calibrated on the
 * training split. Here each equal-count bin's rate is shrunk toward the base
 * rate with a Beta(priorStrength) prior and the monotone constraint is then
 * re-applied over the bins, which keeps ranking, fixes the calibration curve
 * and does not detonate the Brier score.
 */
export function fitSmoothedIsotonic(pairs, { minBin = 40, priorStrength = 25 } = {}) {
  const clean = cleanPairs(pairs);
  if (clean.length === 0) return [[0, 0.5], [1, 0.5]];
  const base = clean.reduce((s, [, y]) => s + y, 0) / clean.length;
  const sorted = [...clean].sort((a, b) => a[0] - b[0]);
  const binCount = Math.max(1, Math.min(Math.floor(sorted.length / minBin), 50));
  const bins = [];
  for (let i = 0; i < binCount; i += 1) {
    const from = Math.floor((i * sorted.length) / binCount);
    const to = Math.floor(((i + 1) * sorted.length) / binCount);
    const slice = sorted.slice(from, to);
    if (slice.length === 0) continue;
    const x = slice.reduce((s, [p]) => s + p, 0) / slice.length;
    const y = slice.reduce((s, [, v]) => s + v, 0);
    bins.push({ x, rate: (y + priorStrength * base) / (slice.length + priorStrength), n: slice.length });
  }
  // Pool adjacent violators over the smoothed bins so the curve stays monotone.
  const blocks = [];
  for (const b of bins) {
    blocks.push({ x0: b.x, x1: b.x, sum: b.rate * b.n, n: b.n });
    while (blocks.length > 1) {
      const b2 = blocks[blocks.length - 1];
      const b1 = blocks[blocks.length - 2];
      if (b1.sum / b1.n <= b2.sum / b2.n) break;
      blocks.pop();
      blocks.pop();
      blocks.push({ x0: b1.x0, x1: b2.x1, sum: b1.sum + b2.sum, n: b1.n + b2.n });
    }
  }
  const points = blocks.map((b) => {
    const x = (b.x0 + b.x1) / 2;
    return [Math.round(x * 1e6) / 1e6, Math.round((b.sum / b.n) * 1e6) / 1e6];
  });
  const out = [];
  for (const p of points) {
    if (out.length && p[0] <= out[out.length - 1][0]) continue;
    out.push(p);
  }
  if (out.length === 0) out.push([0, base], [1, base]);
  return out;
}

/** Area under the ROC curve (rank quality); unchanged by any monotone recalibration. */
export function auc(pairs) {
  const clean = cleanPairs(pairs);
  const pos = clean.filter(([, y]) => y === 1).map(([p]) => p);
  const neg = clean.filter(([, y]) => y === 0).map(([p]) => p);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  // Rank-based AUC (Mann–Whitney): O(n log n) instead of O(pos × neg), so a
  // bigger corpus trains in seconds rather than minutes.
  const ranked = [...clean].sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  for (let i = 0; i < ranked.length; i += 1) {
    if (ranked[i][1] === 1) rankSum += i + 1;
  }
  const u = rankSum - (pos.length * (pos.length + 1)) / 2;
  const out = u / (pos.length * neg.length);
  return Number.isFinite(out) ? out : 0.5;
}

/** Logistic regression by full-batch gradient descent with L2. */
export function fitLogistic(rows, { epochs = 400, lr = 0.35, l2 = 1e-3 } = {}) {
  const weights = new Array(FEATURE_NAMES.length).fill(0);
  const clean = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && Array.isArray(r.x) && r.x.length === FEATURE_NAMES.length
      && r.x.every(Number.isFinite) && (r.y === 1 || r.y === 0),
  );
  if (clean.length === 0) return weights.map(() => 0);
  const n = clean.length;
  const safeEpochs = Number.isInteger(epochs) && epochs > 0 ? Math.min(epochs, 2000) : 400;
  const safeLr = Number.isFinite(lr) && lr > 0 ? Math.min(lr, 2) : 0.35;
  for (let epoch = 0; epoch < safeEpochs; epoch += 1) {
    const grad = new Array(weights.length).fill(0);
    for (const { x, y } of clean) {
      let z = 0;
      for (let i = 0; i < weights.length; i += 1) z += weights[i] * x[i];
      const err = sigmoid(z) - y;
      for (let i = 0; i < weights.length; i += 1) grad[i] += err * x[i];
    }
    for (let i = 0; i < weights.length; i += 1) {
      const penalty = i === 0 ? 0 : l2 * weights[i];
      const step = safeLr * ((grad[i] / n) + penalty);
      weights[i] -= Number.isFinite(step) ? step : 0;
      // Clamp: a degenerate feature column must not explode a weight.
      if (!Number.isFinite(weights[i])) weights[i] = 0;
      weights[i] = Math.min(10, Math.max(-10, weights[i]));
    }
  }
  return weights.map((w) => (Number.isFinite(w) ? Math.round(w * 1e6) / 1e6 : 0));
}

/* ---------------------------------------------------------------- training -- */

export function runTraining({ perMarker = 3, intensities = [0, 1, 2, 3, 4], seed = 20260917 } = {}) {
  const markers = numericMarkers().filter((m) => m && Array.isArray(m.aliases) && m.aliases.length);
  if (markers.length === 0) {
    throw new Error('runTraining: knowledge base has no numeric markers with aliases — run `npm run knowledge:build` first');
  }
  const examples = buildCorpus({ markers, perMarker, intensities, seed });
  if (examples.length < 20) {
    throw new Error(`runTraining: corpus too small to train on (${examples.length} examples) — refusing to write a meaningless artifact`);
  }
  const { train, test } = splitByMarker(examples, 0.3, 7);
  if (train.length === 0 || test.length === 0) {
    throw new Error('runTraining: degenerate train/test split — refusing to write a meaningless artifact');
  }

  const extractor = new LabExtractionService();
  let evaluationFailures = 0;

  const evaluateExample = (ex, { normalize }) => {
    // One hostile example must never abort a training run — it counts as a
    // miss and is tallied in diagnostics.evaluationFailures.
    try {
      const out = extractor.extract(ex.line, { normalize });
      const extracted = Array.isArray(out?.extracted) ? out.extracted : [];
      const normalization = out?.normalization || { corrections: [] };
      const row = extracted.find((e) => e && e.code === ex.code) || null;
      const codeOk = Boolean(row);
      const trueValue = Number(ex.trueValue);
      const tol = Number.isFinite(trueValue) ? Math.max(1e-9, Math.abs(trueValue) * 0.005) : 1e-9;
      const valueOk = codeOk && Number.isFinite(row.value) && Number.isFinite(trueValue)
        && Math.abs(row.value - trueValue) <= tol;
      const h = Number(row?.heuristicConfidence);
      return {
        ex,
        row,
        correct: codeOk && valueOk,
        codeOk,
        valueOk,
        suspicious: Boolean(row?.suspicious),
        features: {
          heuristicConfidence: Number.isFinite(h) ? h : 0.5,
          hasUnit: Boolean(row?.unit),
          hasReferenceRange: row ? row.refLow != null || row.refHigh != null : false,
          aliasLength: typeof row?.matchedAlias === 'string' ? row.matchedAlias.length : 0,
          aliasAtLineStart: Boolean(
            row && typeof row.rawLine === 'string' && typeof row.matchedAlias === 'string'
            && row.rawLine.toLowerCase().startsWith(row.matchedAlias.toLowerCase()),
          ),
          suspicious: Boolean(row?.suspicious),
          glyphRepaired: (normalization?.corrections ?? []).some(
            (c) => c && (c.type === 'digit-glyph' || c.type === 'value-unit-split'),
          ),
          decimalRepaired: (normalization?.corrections ?? []).some(
            (c) => c && (c.type === 'decimal-comma' || c.type === 'decimal-glyph'),
          ),
        },
        normalizations: normalization?.corrections?.length ?? 0,
      };
    } catch {
      evaluationFailures += 1;
      return {
        ex, row: null, correct: false, codeOk: false, valueOk: false, suspicious: false,
        features: {
          heuristicConfidence: 0.5, hasUnit: false, hasReferenceRange: false,
          aliasLength: 0, aliasAtLineStart: false, suspicious: false,
          glyphRepaired: false, decimalRepaired: false,
        },
        normalizations: 0,
      };
    }
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
  doc.evaluationFailures = evaluationFailures;

  // ── adversarial robustness probe: hostile inputs must degrade, never throw,
  // and every emitted confidence must be a finite probability.
  doc.robustness = probeRobustness(extractor);

  // ── model A: isotonic on the transparent heuristic
  const isoPairsTrain = withNormalize.map((r) => [r.features.heuristicConfidence, r.correct ? 1 : 0]);
  const iso = fitSmoothedIsotonic(isoPairsTrain);
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
  const isoOnLogistic = fitSmoothedIsotonic(logisticScoresTrain);

  const evalTest = (predict) => {
    const pairs = testWithNormalize.map((r) => [predict(r), r.correct ? 1 : 0]);
    return {
      brier: round4(brier(pairs)),
      ece: round4(expectedCalibrationError(pairs)),
      auc: round4(auc(pairs)),
      accuracy: round4(ratio(pairs.filter(([p, y]) => (p >= 0.5 ? 1 : 0) === y).length, pairs.length)),
      thresholds: [0.5, 0.6, 0.8].map((t) => accuracyAt(pairs, t)),
    };
  };

  // Discrimination among MATCHED rows only. The model is good at "was a row
  // read at all?" and much weaker at "is this the right number for that row?"
  // — the residual corpus errors are wrong-value-to-right-label, which the
  // extractor cannot self-detect without the report's own range. The model card
  // publishes this instead of quoting only the flattering number.
  const matchedDiagnostics = (predict) => {
    const rowsMatched = testWithNormalize.filter((r) => r.row);
    const pairs = rowsMatched.map((r) => [predict(r), r.correct ? 1 : 0]);
    return {
      n: rowsMatched.length,
      accuracy: round4(ratio(pairs.filter(([p, y]) => (p >= 0.5 ? 1 : 0) === y).length, pairs.length)),
      auc: round4(auc(pairs)),
      baseRate: round4(ratio(rowsMatched.filter((r) => r.correct).length, rowsMatched.length)),
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
  // Choose by Brier score first (a proper scoring rule: it punishes both
  // miscalibration *and* useless over-confidence), then by ECE.
  const chosen = candidates
    .slice()
    .sort((a, b) => a.metrics.brier - b.metrics.brier || a.metrics.ece - b.metrics.ece)[0];

  const predictFor = (kind) => (r) => {
    if (kind === 'logistic+isotonic') {
      const x = featurize(r.features);
      let z = 0;
      for (let i = 0; i < x.length; i += 1) z += weights[i] * x[i];
      return clamp01(interp(sigmoid(z), isoOnLogistic));
    }
    return clamp01(interp(r.features.heuristicConfidence, iso));
  };

  const params = {
    schema: 'medtwin.extractionCalibration/1',
    trainedAt: new Date().toISOString(),
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
      matchedSubset: matchedDiagnostics(predictFor(chosen.kind)),
      unmatchedReadings: testWithNormalize.filter((r) => !r.row).length,
    },
    diagnostics: doc,
    corpus: {
      name: 'synthetic-lab-reading-v2',
      description:
        'Marker names/units/values sampled from the committed knowledge catalogue, corrupted with the documented OCR noise model in scripts/knowledge/corruptor.js (18 corruption families incl. case/punctuation/thousands-separator/sign/digit damage, 16 report layouts, intensity 0–4).',
      seed,
      perMarker,
      intensities,
      corruptionFamilies: 18,
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
        'Overall discrimination mostly separates "a row was read" from "no row was read"; ' +
          'among matched rows the confidence is far weaker at catching a wrong-but-plausible number ' +
          '(see metrics.matchedSubset) — such a row is why every extraction stays a draft for review.',
        'Markers absent from the catalogue are never recovered, so coverage, not confidence, is the limiting factor for exotic tests.',
      ],
      reproduce: 'npm run knowledge:train',
    },
  };

  return { params, modelSummary: { chosen: chosen.kind, baseline, isoOnly, logisticPlusIso, doc } };
}

const clamp01 = (p) => {
  const n = Number(p);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(0.999, Math.max(0.001, n));
};
const ratio = (a, b) => {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return 0;
  return x / y;
};
const round4 = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e4) / 1e4;
};

/**
 * Hostile-input probe over the extraction pipeline. Each case must (a) not
 * throw and (b) emit only finite confidences in [0,1]. Recorded in the
 * artifact so reviewers can see the "never crash" property is measured.
 */
export function probeRobustness(extractor) {
  const cases = [
    ['empty', ''],
    ['whitespace', '   \n\t  \n'],
    ['null-bytes', 'Glucose\x00126\x00 mg/dL'],
    ['no-digits', 'Hemoglobin mg/dL reference range'],
    ['nan-token', 'Glucose NaN mg/dL 70 - 100'],
    ['infinity-token', 'Glucose Infinity mg/dL'],
    ['huge-number', 'Glucose 99999999999999999999999 mg/dL 70 - 100'],
    ['negative', 'Glucose -42 mg/dL 70 - 100'],
    ['unicode-soup', 'Glucośe\u200b 12\u00a06 mg\u2044dL \u2191\u2193'],
    ['long-line', `${'Glucose 126 mg/dL '.repeat(500)}70 - 100`],
    ['many-lines', Array.from({ length: 3000 }, (_, i) => `Marker${i} ${i} mg/dL`).join('\n')],
    ['sql-injection', "Glucose 126'; DROP TABLE lab_results; -- mg/dL"],
    ['html-injection', '<script>alert(1)</script> Glucose 126 mg/dL'],
    ['emoji', '💉 Glucose 😷 126 mg/dL ✅'],
    ['tabs-crlf', 'Glucose\r\n\t126\r\n\tmg/dL\r\n'],
  ];
  const results = [];
  for (const [name, input] of cases) {
    try {
      const out = extractor.extract(input);
      const rows = Array.isArray(out?.extracted) ? out.extracted : [];
      const bad = rows.filter(
        (r) => !Number.isFinite(r?.confidence) || r.confidence < 0 || r.confidence > 1
          || (r.value != null && !Number.isFinite(r.value)),
      );
      results.push({ case: name, threw: false, rows: rows.length, invalidConfidences: bad.length });
    } catch (err) {
      results.push({ case: name, threw: true, error: String(err?.message || err).slice(0, 200) });
    }
  }
  return {
    threw: results.filter((r) => r.threw).length,
    invalidConfidences: results.reduce((s, r) => s + (r.invalidConfidences || 0), 0),
    cases: results,
  };
}

/* ------------------------------------------------------------------- CLI --- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, dflt) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split('=')[1]) : dflt;
  };
  const perMarker = process.argv.includes('--quick') ? 1 : arg('per-marker', 3);
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
      `  ECE    baseline ${m.baseline.ece} → isotonic ${m.isoOnly.ece} → logistic+isotonic ${m.logisticPlusIso.ece}\n` +
      `  AUC    baseline ${m.baseline.auc} → isotonic ${m.isoOnly.auc} → logistic+isotonic ${m.logisticPlusIso.auc}`,
  );
  console.log(
    `  normalization: raw ${(m.doc.normalization.rawAccuracy * 100).toFixed(1)}% → normalized ${(m.doc.normalization.normalizedAccuracy * 100).toFixed(1)}% correct`,
  );
  const matched = params.metrics.matchedSubset;
  console.log(
    `  matched rows: n ${matched.n}, accuracy ${(matched.accuracy * 100).toFixed(1)}%, AUC ${matched.auc} ` +
      `(unmatched readings excluded: ${params.metrics.unmatchedReadings})`,
  );
  console.log(
    `  plausibility guard caught ${m.doc.plausibilityGuard.flaggedSuspicious}/${m.doc.plausibilityGuard.wrongReads} wrong reads ` +
      `(${(m.doc.plausibilityGuard.flagRate * 100).toFixed(1)}%), false-flagged ${(m.doc.plausibilityGuard.falseFlagRateOnCorrect * 100).toFixed(2)}% of correct reads`,
  );
  const rob = params.diagnostics.robustness;
  console.log(
    `  robustness probe: ${rob.threw} throws, ${rob.invalidConfidences} invalid confidences across ${rob.cases.length} hostile inputs` +
      ` · evaluation failures: ${params.diagnostics.evaluationFailures}`,
  );
}
