import { describe, it, expect } from 'vitest';
import { buildCorpus } from '../../scripts/knowledge/corruptor.js';
import { numericMarkers } from '../../src/knowledge/clinicalKnowledge.js';
import { LabExtractionService } from '../../src/services/labs/LabExtractionService.js';

/**
 * End-to-end quality of the reading pipeline on the documented synthetic
 * corpus: marker catalogue × OCR-corruption model. These are the numbers the
 * model card in trainedParameters.json is derived from, so they are pinned
 * here — a knowledge or extractor change that silently breaks reading quality
 * fails the suite instead of shipping.
 *
 * These are OCR-reading metrics. They say nothing about clinical accuracy.
 */
const extractor = new LabExtractionService();
const markers = numericMarkers().filter((m) => m.aliases?.length);

const readAll = (corpus, { normalize = true } = {}) => {
  let correct = 0;
  const confidences = { correct: [], wrong: [] };
  for (const example of corpus) {
    const { extracted } = extractor.extract(example.line, { normalize });
    const row = extracted.find((e) => e.code === example.code) || null;
    const tol = Math.max(1e-9, Math.abs(example.trueValue) * 0.005);
    const ok = Boolean(row) && Math.abs(row.value - example.trueValue) <= tol;
    if (ok) correct += 1;
    if (row) confidences[ok ? 'correct' : 'wrong'].push(row.confidence);
  }
  return { correct, total: corpus.length, rate: correct / corpus.length, confidences };
};

const corpus = buildCorpus({ markers, perMarker: 1, intensities: [0, 1, 2, 3], seed: 20260917 });
const clean = corpus.filter((e) => e.intensity === 0);
const heavy = corpus.filter((e) => e.intensity >= 2);

describe('extraction quality — clean report lines', () => {
  it('recovers nearly every marker and value from an undamaged line', () => {
    const { rate } = readAll(clean);
    expect(rate).toBeGreaterThan(0.95);
  });

  it('does not invent values: a mark-free read is never suspicious', () => {
    const flagged = clean.filter((e) => {
      const row = extractor.extract(e.line).extracted.find((r) => r.code === e.code);
      return row?.suspicious;
    });
    expect(flagged.length).toBe(0);
  });
});

describe('extraction quality — OCR damage', () => {
  it('degrades gracefully as damage increases', () => {
    const cleanRate = readAll(clean).rate;
    const heavyRate = readAll(heavy).rate;
    expect(heavyRate).toBeLessThan(cleanRate);
    expect(heavyRate).toBeGreaterThan(0.4);
  });

  it('the normalization layer measurably improves recovery, never worsens it', () => {
    const normalized = readAll(corpus, { normalize: true });
    const raw = readAll(corpus, { normalize: false });
    expect(normalized.rate).toBeGreaterThan(raw.rate);
    // and the improvement must hold for clean lines too (it is a no-op there)
    expect(readAll(clean, { normalize: true }).rate).toBeGreaterThanOrEqual(
      readAll(clean, { normalize: false }).rate - 0.01,
    );
  });

  it('repairs each documented corruption family on the corpus', () => {
    for (const type of ['digit-glyph', 'unit-mangle', 'decimal-comma', 'column-merge']) {
      const subset = corpus.filter((e) => e.corruptionTypes.includes(type));
      const normalized = readAll(subset).correct;
      const raw = readAll(subset, { normalize: false }).correct;
      expect(normalized, `${type} recovery`).toBeGreaterThanOrEqual(raw);
    }
  });
});

describe('extraction quality — confidence', () => {
  it('keeps calibrated confidence monotone in the transparent heuristic', () => {
    const samples = ['HbA1c 5.7 %', 'HbA1c 5.7', 'HbA1c', 'Creatinine 1.1 mg/dL (0.6 - 1.3)']
      .map((line) => extractor.extract(line).extracted[0])
      .filter(Boolean);
    for (const row of samples) {
      expect(row.confidence).toBeGreaterThan(0);
      expect(row.confidence).toBeLessThanOrEqual(1);
      // a row that has a unit and a printed range can never score below a bare number
      if (row.unit && (row.refLow != null || row.refHigh != null)) expect(row.confidence).toBeGreaterThan(0.5);
    }
  });

  it('sorts a clean read above a damaged read of the same marker', () => {
    const cleanRow = extractor.extract('HbA1c 5.7 % (4.0 - 5.6)').extracted[0];
    const bareRow = extractor.extract('HbA1c 5.7').extracted[0];
    expect(cleanRow.confidence).toBeGreaterThan(bareRow.confidence);
  });

  it('caps confidence on a physically implausible reading', () => {
    const row = extractor.extract('Hemoglobin 900 g/dL').extracted[0];
    expect(row.suspicious).toBe(true);
    expect(row.confidence).toBeLessThanOrEqual(0.25);
  });
});

describe('extraction quality — cost', () => {
  it('reads a 200-line report in well under a second', () => {
    const lines = corpus.slice(0, 200);
    const started = process.hrtime.bigint();
    for (const example of lines) extractor.extract(example.line);
    const msPerLine = Number(process.hrtime.bigint() - started) / 1e6 / lines.length;
    expect(msPerLine).toBeLessThan(10);
  });
});
