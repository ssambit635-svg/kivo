/**
 * Report Confidence Badge (product widget: "🟢 Verified / 🟡 Needs review /
 * 🔴 OCR issue" — expressed for clients as structured data + an icon KEY,
 * never an emoji, so any frontend can render its own real icon set).
 *
 * The important property: the badge is 100% DERIVED from state the report
 * pipeline already tracks — `status`, `ocr_confidence`, `ocr_error`. No new
 * storage, no new source of truth, nothing for a UI to invent. The same
 * safety story as the rest of the system applies: a value only enters
 * trends/risk after verification, and the badge communicates exactly where
 * a report stands on that path.
 *
 * Rules (documented + unit-tested in tests/unit/report-badge.test.js):
 *   verified                        → 'verified'
 *   ocr_failed                      → 'ocr_issue'
 *   OCR confidence below the floor  → 'ocr_issue'  (read succeeded but is suspect)
 *   everything else (uploaded / needs_review, good confidence)
 *                                   → 'needs_review'
 */
export const OCR_CONFIDENCE_REVIEW_FLOOR = 0.6;

/** Static badge metadata. `icon` is a KEY — frontends map it to real SVG assets. */
export const REPORT_BADGES = {
  verified: {
    level: 'verified',
    label: 'Verified',
    tone: 'green',
    icon: 'shield-check',
    hint: 'Values were checked and confirmed — they now feed trends and risk estimates.',
  },
  needs_review: {
    level: 'needs_review',
    label: 'Needs review',
    tone: 'amber',
    icon: 'alert-triangle',
    hint: 'Draft extraction awaits your review — nothing enters trends until you verify.',
  },
  ocr_issue: {
    level: 'ocr_issue',
    label: 'OCR issue',
    tone: 'red',
    icon: 'scan-line',
    hint: 'The scanner struggled with this report — double-check every value or add them manually.',
  },
};

/**
 * Derive the badge for a report. Accepts a Report entity (snake_case row
 * fields), a serialized report (camelCase), or plain row object.
 * @returns {{level: string, label: string, tone: string, icon: string, hint: string, ocrConfidence: number|null}}
 */
export function deriveReportBadge(report) {
  const status = report?.status ?? null;
  const confidence = report?.ocrConfidence ?? report?.ocr_confidence ?? null;
  const ocrError = report?.ocrError ?? report?.ocr_error ?? null;

  let base;
  if (status === 'verified') {
    base = REPORT_BADGES.verified;
  } else if (status === 'ocr_failed') {
    base = REPORT_BADGES.ocr_issue;
  } else if (confidence != null && confidence < OCR_CONFIDENCE_REVIEW_FLOOR) {
    base = {
      ...REPORT_BADGES.ocr_issue,
      hint: `Low OCR confidence (${Math.round(confidence * 100)}%) — double-check every value against the paper report.`,
    };
  } else {
    base = REPORT_BADGES.needs_review;
  }

  return {
    ...base,
    ocrConfidence: confidence,
    ...(base.level === 'ocr_issue' && ocrError ? { ocrError } : {}),
  };
}
