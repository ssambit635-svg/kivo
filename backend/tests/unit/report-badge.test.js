import { describe, it, expect } from 'vitest';
import { deriveReportBadge, REPORT_BADGES, OCR_CONFIDENCE_REVIEW_FLOOR } from '../../src/domain/reportBadge.js';

describe('deriveReportBadge — Report Confidence Badge (derived from stored state, never invented by UIs)', () => {
  it('verified report → green "verified" badge with shield-check icon key', () => {
    const badge = deriveReportBadge({ status: 'verified', ocr_confidence: 0.97 });
    expect(badge.level).toBe('verified');
    expect(badge.label).toBe('Verified');
    expect(badge.tone).toBe('green');
    expect(badge.icon).toBe('shield-check');
    expect(badge.ocrConfidence).toBe(0.97);
    expect(badge.hint).toBeTruthy();
  });

  it('OCR failure → red "ocr_issue" badge, error surfaced', () => {
    const badge = deriveReportBadge({ status: 'ocr_failed', ocr_error: 'No OCR provider available' });
    expect(badge.level).toBe('ocr_issue');
    expect(badge.tone).toBe('red');
    expect(badge.icon).toBe('scan-line');
    expect(badge.ocrError).toBe('No OCR provider available');
  });

  it('needs_review with LOW OCR confidence → ocr_issue (suspect read, not a normal draft)', () => {
    const badge = deriveReportBadge({ status: 'needs_review', ocr_confidence: OCR_CONFIDENCE_REVIEW_FLOOR - 0.01 });
    expect(badge.level).toBe('ocr_issue');
    expect(badge.hint).toMatch(/Low OCR confidence/);
  });

  it('needs_review with confidence exactly at the floor → needs_review (floor is inclusive)', () => {
    const badge = deriveReportBadge({ status: 'needs_review', ocr_confidence: OCR_CONFIDENCE_REVIEW_FLOOR });
    expect(badge.level).toBe('needs_review');
    expect(badge.tone).toBe('amber');
    expect(badge.icon).toBe('alert-triangle');
  });

  it('fresh upload (interim state) and good-confidence drafts → needs_review', () => {
    expect(deriveReportBadge({ status: 'uploaded' }).level).toBe('needs_review');
    expect(deriveReportBadge({ status: 'needs_review', ocr_confidence: 1.0 }).level).toBe('needs_review');
    expect(deriveReportBadge({ status: 'needs_review', ocr_confidence: null }).level).toBe('needs_review');
  });

  it('accepts both entity rows (snake_case) and serialized JSON (camelCase)', () => {
    const row = { status: 'verified', ocr_confidence: 0.9 };
    const json = { status: 'verified', ocrConfidence: 0.9 };
    expect(deriveReportBadge(row).level).toBe('verified');
    expect(deriveReportBadge(json).level).toBe('verified');
    expect(deriveReportBadge(json).ocrConfidence).toBe(0.9);
  });

  it('is robust to a missing report object', () => {
    expect(deriveReportBadge(null).level).toBe('needs_review');
    expect(deriveReportBadge(undefined).level).toBe('needs_review');
  });

  it('ships icon KEYS, never emojis (frontends map keys to real SVG assets)', () => {
    // eslint-disable-next-line no-control-regex
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const badge of Object.values(REPORT_BADGES)) {
      expect(emoji.test(badge.icon)).toBe(false);
      expect(emoji.test(badge.label)).toBe(false);
      expect(emoji.test(badge.hint)).toBe(false);
    }
    // deterministic derivation — same input, same badge
    expect(deriveReportBadge({ status: 'verified' })).toEqual(deriveReportBadge({ status: 'verified' }));
  });
});
