import { z } from 'zod';
import { ctxFromReq } from '../services/AuditService.js';
import { NotFoundError } from '../common/errors.js';

export const healthSchemas = {
  memberParams: z.object({ memberId: z.string().uuid() }),
  observationParams: z.object({ observationId: z.string().uuid() }),
  createObservation: z.object({
    kind: z.enum(['weight', 'bp', 'activity', 'sleep', 'symptom', 'note', 'medication']),
    payload: z.record(z.any()).default({}),
    source: z.enum(['manual', 'voice', 'device']).default('manual'),
    observedAt: z.string().nullish(),
  }),
  listObservationsQuery: z.object({
    kind: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }),
  trendsQuery: z.object({ code: z.string().trim().min(1).max(60).optional() }),
  riskAssess: z
    .object({
      overrides: z.record(z.number().finite().nullable()).optional(),
    })
    .optional(),
};

/**
 * Health-intelligence endpoints: trends, risk assessment + what-if,
 * observations/journal, doctor summary.
 */
export class HealthIntelController {
  constructor({ trendService, riskModelService, observationService, doctorSummaryService, policyService, llmGateway }) {
    this.trends = trendService;
    this.risk = riskModelService;
    this.observations = observationService;
    this.summaries = doctorSummaryService;
    this.policy = policyService;
    this.llm = llmGateway;
  }

  loadReadableMember(req) {
    const { member } = this.policy.loadMemberWithAccess(req.actor, req.params.memberId);
    this.policy.assertRead(req.actor, member);
    return member;
  }

  getTrends = async (req, res, next) => {
    try {
      const member = this.loadReadableMember(req);
      const { code } = req.query;
      if (code) {
        const analysis = this.trends.analyzeCode(member.id, code);
        if (!analysis) throw new NotFoundError(`Unknown marker code '${code}'`);
        return res.json(analysis);
      }
      const trends = this.trends.analyzeMember(member.id);
      const narration = await this.llm.narrate('summarize_trends', { memberName: member.name, trends });
      return res.json({ trends, narrative: narration });
    } catch (e) {
      return next(e);
    }
  };

  assessRisk = (req, res, next) => {
    try {
      const member = this.loadReadableMember(req);
      const overrides = req.body?.overrides || {};
      const result = this.risk.assess(member, overrides);
      res.json(result);
    } catch (e) {
      next(e);
    }
  };

  createObservation = (req, res, next) => {
    try {
      res.status(201).json(this.observations.create(req.actor, req.params.memberId, req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  listObservations = (req, res, next) => {
    try {
      res.json(this.observations.list(req.actor, req.params.memberId, req.query));
    } catch (e) {
      next(e);
    }
  };

  deleteObservation = (req, res, next) => {
    try {
      res.json(this.observations.remove(req.actor, req.params.observationId, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  getDoctorSummary = async (req, res, next) => {
    try {
      const member = this.loadReadableMember(req);
      res.json(await this.summaries.build(member));
    } catch (e) {
      next(e);
    }
  };
}
