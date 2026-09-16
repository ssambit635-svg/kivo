import { describe, it, expect } from 'vitest';
import { LabExtractionService } from '../../src/services/labs/LabExtractionService.js';
import { SAMPLE_REPORT_TEXT } from '../helpers.js';

const extractor = new LabExtractionService();
const byCode = (list, code) => list.find((e) => e.code === code);

describe('LabExtractionService — realistic report text', () => {
  const { extracted, detectedReportDate } = extractor.extract(SAMPLE_REPORT_TEXT);

  it('extracts all 9 markers from the demo report', () => {
    expect(extracted.length).toBe(9);
  });

  it('normalizes every read to its canonical code (never trusts raw names)', () => {
    const codes = extracted.map((e) => e.code).sort();
    expect(codes).toEqual(
      ['creatinine', 'fasting_glucose', 'hba1c', 'hdl', 'hemoglobin', 'ldl', 'total_cholesterol', 'triglycerides', 'tsh'].sort(),
    );
  });

  it('parses value + unit + full reference range from "HbA1c 5.9 % (4.0 - 5.6)"', () => {
    const h = byCode(extracted, 'hba1c');
    expect(h.value).toBe(5.9);
    expect(h.unit).toBe('%');
    expect(h.refLow).toBe(4.0);
    expect(h.refHigh).toBe(5.6);
    expect(h.confidence).toBeGreaterThan(0.6);
  });

  it('parses a bare "70 - 100" range without parentheses/labels', () => {
    const g = byCode(extracted, 'fasting_glucose');
    expect(g.value).toBe(108);
    expect(g.refLow).toBe(70);
    expect(g.refHigh).toBe(100);
  });

  it('parses one-sided reference bounds "Reference: <200"', () => {
    const c = byCode(extracted, 'total_cholesterol');
    expect(c.value).toBe(214);
    expect(c.refHigh).toBe(200);
    expect(c.refLow).toBeNull();
  });

  it('prefers longer aliases: "Fasting Blood Sugar" is fasting_glucose, not glucose', () => {
    expect(byCode(extracted, 'fasting_glucose').value).toBe(108);
  });

  it('disambiguates HDL/LDL from the generic "cholesterol" alias', () => {
    expect(byCode(extracted, 'hdl').value).toBe(42);
    expect(byCode(extracted, 'total_cholesterol').value).toBe(214);
  });

  it('detects the report date from the header (dd-mm-yyyy)', () => {
    expect(detectedReportDate).toBe('2026-03-12T00:00:00.000Z');
  });

  it('keeps the raw source line for auditability of every extraction', () => {
    for (const e of extracted) {
      expect(e.rawLine).toBeTruthy();
      expect(e.rawLine).toContain(String(e.value));
    }
  });

  it('assigns higher confidence when unit+range are present than bare value', () => {
    const rich = extractor.extract('HbA1c 5.9 % (4.0 - 5.6)').extracted[0];
    const bare = extractor.extract('Hemoglobin 13.4').extracted; // no unit/range; 'hb' is too short for higher conf
    expect(rich.confidence).toBeGreaterThan(bare[0]?.confidence ?? 1);
  });
});

describe('LabExtractionService — defensive behavior', () => {
  it('returns zero extractions for garbage input instead of throwing', () => {
    expect(extractor.extract('🚀🚀🚀\nhello world\n').extracted).toHaveLength(0);
    expect(extractor.extract('').extracted).toHaveLength(0);
    expect(extractor.extract(null).extracted).toHaveLength(0);
    expect(extractor.extract(undefined).extracted).toHaveLength(0);
  });

  it('ignores header/footer lines that contain no digits', () => {
    expect(extractor.extract('COMPLETE BLOOD COUNT REPORT\nResult Reference Range').extracted).toHaveLength(0);
  });

  it('does not misuse a range number as the value ("70 - 100" has no value)', () => {
    const r = extractor.extract('HbA1c % (4.0 - 5.6)');
    expect(r.extracted).toHaveLength(0);
  });

  it('handles tabular "name | value | unit | low | high" style loosely', () => {
    const r = extractor.extract('Triglycerides | 162 | mg/dL | 30 | 150');
    expect(r.extracted[0].code).toBe('triglycerides');
    expect(r.extracted[0].value).toBe(162);
    expect(r.extracted[0].refLow).toBe(30);
  });

  it('puts the first value of a line — not the range top — into value', () => {
    const r = extractor.extract('LDL Cholesterol 110 mg/dL 50-100');
    expect(r.extracted[0].value).toBe(110);
  });

  it('canonicalizes unit casing from the dictionary ("mg/dl" → "mg/dL")', () => {
    const r = extractor.extract('Fasting Blood Sugar 108 mg/dl 70-100');
    expect(r.extracted[0].unit).toBe('mg/dL');
  });

  it('exposes the canonical dictionary for the frontend', () => {
    const dict = extractor.dictionary();
    expect(dict.hba1c.defaultUnit).toBe('%');
    expect(dict.fasting_glucose.typicalRange.high).toBe(99);
    expect(dict.hdl.betterDirection).toBe('higher');
  });
});
