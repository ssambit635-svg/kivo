import { z } from 'zod';
import { ctxFromReq } from '../services/AuditService.js';
import { ValidationError } from '../common/errors.js';

const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const reportSchemas = {
  jsonIngest: z
    .object({
      text: z.string().min(1).max(500_000).optional(),
      reportDate: z.string().nullish(),
    })
    .optional(),
  listQuery: paginationQuery.extend({ status: z.enum(['uploaded', 'ocr_failed', 'needs_review', 'verified']).optional() }),
  updateMeta: z
    .object({
      reportDate: z.string().nullish(),
      notes: z.string().max(4000).nullish(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'At least one field is required' }),
  addLab: z.object({
    code: z.string().trim().min(1).max(60),
    testName: z.string().trim().min(1).max(160).optional(),
    value: z.number().finite().nullish(),
    valueText: z.string().max(200).nullish(),
    unit: z.string().max(30).nullish(),
    refLow: z.number().finite().nullish(),
    refHigh: z.number().finite().nullish(),
    measuredAt: z.string().nullish(),
  }),
  updateLab: z
    .object({
      code: z.string().trim().min(1).max(60).optional(),
      testName: z.string().trim().min(1).max(160).optional(),
      value: z.number().finite().nullish(),
      valueText: z.string().max(200).nullish(),
      unit: z.string().max(30).nullish(),
      refLow: z.number().finite().nullish(),
      refHigh: z.number().finite().nullish(),
      measuredAt: z.string().nullish(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'At least one field is required' }),
  verify: z.object({ ids: z.array(z.string().uuid()).min(1).optional() }).optional(),
  memberParams: z.object({ memberId: z.string().uuid() }),
  reportParams: z.object({ reportId: z.string().uuid() }),
  labParams: z.object({ labId: z.string().uuid() }),
};

export class ReportController {
  constructor(reportService) {
    this.reports = reportService;
  }

  /** Multipart (file=...) or JSON ({text}) — one ingestion entry point. */
  ingest = async (req, res, next) => {
    try {
      if (req.file) {
        const out = await this.reports.ingest(
          req.actor,
          req.params.memberId,
          { file: req.file, reportDate: req.body?.reportDate || null },
          ctxFromReq(req),
        );
        return res.status(201).json(out);
      }
      const parsed = reportSchemas.jsonIngest.safeParse(req.body || {});
      if (!parsed.success) throw new ValidationError('Invalid JSON body for report ingestion');
      const { text, reportDate } = parsed.data || {};
      const out = await this.reports.ingest(req.actor, req.params.memberId, { text, reportDate }, ctxFromReq(req));
      return res.status(201).json(out);
    } catch (e) {
      return next(e);
    }
  };

  list = (req, res, next) => {
    try {
      res.json(this.reports.listForMember(req.actor, req.params.memberId, req.query));
    } catch (e) {
      next(e);
    }
  };

  get = (req, res, next) => {
    try {
      const { report, results } = this.reports.getForActor(req.actor, req.params.reportId);
      res.json({ ...report, results });
    } catch (e) {
      next(e);
    }
  };

  updateMeta = (req, res, next) => {
    try {
      res.json(this.reports.updateMeta(req.actor, req.params.reportId, req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  addLabResult = (req, res, next) => {
    try {
      res.status(201).json(this.reports.addLabResult(req.actor, req.params.reportId, req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  updateLabResult = (req, res, next) => {
    try {
      res.json(this.reports.updateLabResult(req.actor, req.params.labId, req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  deleteLabResult = (req, res, next) => {
    try {
      res.json(this.reports.deleteLabResult(req.actor, req.params.labId, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  verify = (req, res, next) => {
    try {
      res.json(this.reports.verify(req.actor, req.params.reportId, req.body || {}, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  unverify = (req, res, next) => {
    try {
      res.json(this.reports.unverify(req.actor, req.params.reportId, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  remove = (req, res, next) => {
    try {
      res.json(this.reports.remove(req.actor, req.params.reportId, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  explain = async (req, res, next) => {
    try {
      res.json(await this.reports.explain(req.actor, req.params.reportId));
    } catch (e) {
      next(e);
    }
  };
}
