import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newId } from '../utils/id.js';
import { ConflictError, UnprocessableError, UnsupportedMediaError, ValidationError } from '../common/errors.js';
import { deriveReportBadge } from '../domain/reportBadge.js';

const ALLOWED_MIME = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'image/png', 'image/jpeg', 'image/bmp', 'image/webp', 'image/tiff',
  'application/pdf',
]);

/**
 * OCR failures arrive in many shapes — Error objects, plain strings
 * (tesseract.js rejects with `err.toString()`), even worker payloads. The
 * pipeline must never persist an empty `ocr_error` or return an empty
 * `preview.note`: both feed the red badge + manual-entry guidance.
 */
function ocrFailureMessage(err) {
  if (typeof err === 'string' && err.trim()) return err;
  if (err?.message) return err.message;
  try {
    const s = String(err);
    if (s && s !== '[object Object]') return s;
  } catch {
    /* fall through to the default */
  }
  return 'OCR failed to read this file — paste the report text into the upload dialog, or run `npm run ocr:setup` to enable image OCR.';
}

/**
 * Report pipeline (Layers 1–2 of the AI architecture):
 *   upload → safe storage → OCR → extraction → needs_review → user verifies → verified
 *
 * Safety invariants enforced HERE, at the service boundary:
 * - files land on disk under a random name; the original name is only metadata
 * - MIME allowlist + size limit (multer enforces size; we double-check)
 * - extracted values are created with verified=0 (drafts), never silently trusted
 * - a verified report is immutable until explicitly re-opened
 */
export class ReportService {
  constructor({ config, reportRepository, labResultRepository, policyService, ocrService, extractionService, llmGateway, auditService }) {
    this.config = config;
    this.reports = reportRepository;
    this.labs = labResultRepository;
    this.policy = policyService;
    this.ocr = ocrService;
    this.extractor = extractionService;
    this.llm = llmGateway;
    this.audit = auditService;
  }

  /** Upload + OCR + extract. Returns report with the extracted draft preview. */
  async ingest(actor, memberId, { file = null, text = null, reportDate = null, mimeType = null }, ctx = {}) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertWrite(actor, member);

    let buffer = null;
    let finalMime = null;
    let originalName = null;
    let storagePath = null;

    if (file) {
      buffer = file.buffer;
      finalMime = (file.mimetype || 'application/octet-stream').toLowerCase();
      originalName = file.originalname;
      if (buffer.length > this.config.maxUploadBytes) {
        throw new ValidationError(`File exceeds the ${Math.round(this.config.maxUploadBytes / 1048576)} MB limit`);
      }
      if (!ALLOWED_MIME.has(finalMime)) {
        throw new UnsupportedMediaError(`File type '${finalMime}' is not allowed`);
      }
      // Random, extension-derived name — no traversal possible.
      const ext = { 'text/plain': '.txt', 'image/png': '.png', 'image/jpeg': '.jpg', 'application/pdf': '.pdf' }[finalMime] || '.bin';
      const fileName = `${crypto.randomBytes(16).toString('hex')}${ext}`;
      const dir = path.resolve(this.config.uploadDir, actor.id.slice(0, 2));
      fs.mkdirSync(dir, { recursive: true });
      storagePath = path.join(dir, fileName);
      fs.writeFileSync(storagePath, buffer);
    } else if (text != null) {
      buffer = Buffer.from(String(text), 'utf8');
      finalMime = mimeType || 'text/plain';
    } else {
      throw new ValidationError('Provide either a file upload or report text');
    }

    const report = this.reports.create({
      memberId,
      uploadedBy: actor.id,
      originalName,
      mimeType: finalMime,
      storagePath,
      reportDate,
    });

    // OCR — failure keeps the report with an explicit status; the user can
    // still add values manually. Nothing is ever silently dropped.
    let ocrResult;
    try {
      ocrResult = await this.ocr.extractText({ buffer, mimeType: finalMime });
    } catch (err) {
      // err can be a non-Error (tesseract.js rejects with plain strings) —
      // never persist an empty ocr_error or return an empty preview note.
      const message = ocrFailureMessage(err);
      const updated = this.reports.setOcrResult(report.id, {
        status: 'ocr_failed',
        ocrError: message,
      });
      this.audit.record({
        userId: actor.id, action: 'report.ocr_failed', resourceType: 'report', resourceId: report.id,
        outcome: 'failure', metadata: { reason: err?.code || 'ocr_error' }, ctx,
      });
      return { report: this.withBadge(updated), preview: { extracted: [], needsManualEntry: true, note: message } };
    }

    const { extracted, detectedReportDate } = this.extractor.extract(ocrResult.text);
    const updated = this.reports.setOcrResult(report.id, {
      status: 'needs_review',
      ocrText: this.clip(ocrResult.text, 20000),
      ocrProvider: ocrResult.provider,
      ocrConfidence: ocrResult.confidence,
      ocrError: null,
      reportDate: report.report_date ?? detectedReportDate,
    });

    // Persist extracted values as UNVERIFIED drafts.
    const measuredAt = updated.report_date || updated.created_at;
    const drafts = extracted.map((e) => ({
      reportId: report.id,
      memberId,
      code: e.code,
      testName: e.testName,
      value: e.value,
      unit: e.unit,
      refLow: e.refLow,
      refHigh: e.refHigh,
      confidence: e.confidence,
      rawLine: e.rawLine,
      measuredAt,
      verified: 0,
    }));
    const created = drafts.length > 0 ? this.labs.createBatch(drafts) : [];

    this.audit.record({
      userId: actor.id, action: 'report.ingest', resourceType: 'report', resourceId: report.id,
      metadata: { extractedCount: created.length, provider: ocrResult.provider }, ctx,
    });

    return {
      report: this.withBadge(updated),
      preview: {
        extracted: created.map((r) => r.toJSON()),
        needsManualEntry: created.length === 0,
        note:
          created.length === 0
            ? 'No lab values were recognized — please review the text and add values manually.'
            : `${created.length} value(s) extracted. Review and correct them, then verify — nothing enters trends until you do.`,
      },
    };
  }

  getForActor(actor, reportId) {
    const { report, access } = this.policy.loadReportWithAccess(actor, this.reports, reportId);
    return { report: this.withBadge(report, { includeOcrText: true }), access, results: this.labs.listByReport(reportId).map((r) => r.toJSON()) };
  }

  listForMember(actor, memberId, query) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertRead(actor, member);
    const { items, total, page, pageSize } = this.reports.listByMember(memberId, query);
    return {
      items: items.map((r) => ({ ...r.toJSON(), badge: deriveReportBadge(r), labResultCount: this.labs.listByReport(r.id).length })),
      total,
      page,
      pageSize,
    };
  }

  updateMeta(actor, reportId, data, ctx = {}) {
    const { report } = this.policy.loadReportWithAccess(actor, this.reports, reportId, { write: true });
    if (report.isVerified) throw new ConflictError('Report is verified — re-open review before editing', 'REPORT_LOCKED');
    const updated = this.reports.updateMeta(reportId, data);
    this.audit.record({ userId: actor.id, action: 'report.update', resourceType: 'report', resourceId: reportId, ctx });
    return updated.toJSON();
  }

  addLabResult(actor, reportId, data, ctx = {}) {
    const { report, member } = this.policy.loadReportWithAccess(actor, this.reports, reportId, { write: true });
    if (report.isVerified) throw new ConflictError('Report is verified — re-open review before adding values', 'REPORT_LOCKED');
    const measuredAt = data.measuredAt || report.report_date || report.created_at;
    const created = this.labs.create({
      reportId,
      memberId: member.id,
      code: data.code,
      testName: data.testName || data.code,
      value: data.value ?? null,
      valueText: data.valueText ?? null,
      unit: data.unit ?? null,
      refLow: data.refLow ?? null,
      refHigh: data.refHigh ?? null,
      measuredAt,
      verified: 0,
    });
    this.audit.record({ userId: actor.id, action: 'lab.create', resourceType: 'lab_result', resourceId: created.id, ctx });
    return created.toJSON();
  }

  updateLabResult(actor, labId, data, ctx = {}) {
    const { lab } = this.policy.loadLabResultWithAccess(actor, this.labs, labId, { write: true });
    const report = this.reports.findById(lab.report_id);
    if (report?.isVerified) throw new ConflictError('Report is verified — re-open review before editing values', 'REPORT_LOCKED');
    const columnMap = { value: 'value', valueText: 'value_text', unit: 'unit', refLow: 'ref_low', refHigh: 'ref_high', measuredAt: 'measured_at', code: 'code', testName: 'test_name' };
    const fields = {};
    for (const [k, v] of Object.entries(data)) {
      if (columnMap[k]) fields[columnMap[k]] = v;
    }
    const updated = this.labs.update(labId, fields);
    this.audit.record({ userId: actor.id, action: 'lab.update', resourceType: 'lab_result', resourceId: labId, ctx });
    return updated.toJSON();
  }

  deleteLabResult(actor, labId, ctx = {}) {
    const { lab } = this.policy.loadLabResultWithAccess(actor, this.labs, labId, { write: true });
    const report = this.reports.findById(lab.report_id);
    if (report?.isVerified) throw new ConflictError('Report is verified — re-open review before deleting values', 'REPORT_LOCKED');
    this.labs.delete(labId);
    this.audit.record({ userId: actor.id, action: 'lab.delete', resourceType: 'lab_result', resourceId: labId, ctx });
    return { deleted: true };
  }

  /** Promote the report's values to verified — the single gate into trends/risk. */
  verify(actor, reportId, { ids = null } = {}, ctx = {}) {
    const { report } = this.policy.loadReportWithAccess(actor, this.reports, reportId, { write: true });
    if (report.status === 'verified') return this.reports.findById(reportId).toJSON();
    if (this.labs.listByReport(reportId).length === 0) {
      throw new UnprocessableError('Cannot verify a report with no values — add at least one value first');
    }
    this.labs.setVerifiedForReport(reportId, ids);
    const updated = this.reports.markVerified(reportId);
    this.audit.record({ userId: actor.id, action: 'report.verify', resourceType: 'report', resourceId: reportId, ctx });
    return updated.toJSON();
  }

  unverify(actor, reportId, ctx = {}) {
    const { report } = this.policy.loadReportWithAccess(actor, this.reports, reportId, { write: true });
    if (!report.isVerified) throw new ConflictError('Report is not verified', 'REPORT_NOT_VERIFIED');
    this.labs.setUnverifiedForReport(reportId);
    const updated = this.reports.reopenReview(reportId);
    this.audit.record({ userId: actor.id, action: 'report.reopen', resourceType: 'report', resourceId: reportId, ctx });
    return updated.toJSON();
  }

  remove(actor, reportId, ctx = {}) {
    const { report } = this.policy.loadReportWithAccess(actor, this.reports, reportId, { write: true });
    this.reports.delete(reportId);
    if (report.storage_path && fs.existsSync(report.storage_path)) {
      try {
        fs.unlinkSync(report.storage_path);
      } catch {
        /* file cleanup is best-effort */
      }
    }
    this.audit.record({ userId: actor.id, action: 'report.delete', resourceType: 'report', resourceId: reportId, ctx });
    return { deleted: true };
  }

  /** Grounded explanation of a report's values (Layer 6). */
  async explain(actor, reportId) {
    const { report } = this.policy.loadReportWithAccess(actor, this.reports, reportId);
    const { member } = this.policy.loadMemberWithAccess(actor, report.member_id);
    const results = this.labs.listByReport(reportId).map((r) => r.toJSON());
    const narration = await this.llm.narrate('explain_report', {
      memberName: member.name,
      reportDate: report.report_date,
      markers: results,
    });
    return { reportId, results, explanation: narration };
  }

  /** Serialized report + its confidence badge (derived, never stored). */
  withBadge(report, toJsonOpts = {}) {
    return { ...report.toJSON(toJsonOpts), badge: deriveReportBadge(report) };
  }

  clip(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
  }
}
