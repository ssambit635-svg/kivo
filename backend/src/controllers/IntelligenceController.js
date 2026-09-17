import { z } from 'zod';
import { NotFoundError } from '../common/errors.js';
import { SCENARIO_BOUNDS } from '../services/intelligence/CounterfactualTwinService.js';

const scenarioFieldSchemas = Object.fromEntries(
  Object.keys(SCENARIO_BOUNDS).map((field) => [field, z.number().finite().optional()]),
);

export const intelligenceSchemas = {
  memberParams: z.object({ memberId: z.string().uuid() }),
  baselineQuery: z.object({ signal: z.string().trim().min(1).max(80).optional() }),
  patternsQuery: z.object({
    type: z.enum(['OBSERVED', 'TEMPORAL_ASSOCIATION', 'STATISTICAL_ASSOCIATION', 'MODEL_CONTRIBUTION']).optional(),
    minStrength: z.coerce.number().min(0).max(1).optional(),
  }),
  simulate: z.object({
    label: z.string().trim().min(1).max(80).optional(),
    changes: z.object(scenarioFieldSchemas).refine((o) => Object.keys(o).length > 0, {
      message: 'At least one scenario field is required',
    }),
  }),
  scenarios: z
    .object({
      maxScenarios: z.coerce.number().int().min(1).max(6).optional(),
      factors: z.array(z.enum(['weight', 'activity'])).min(1).max(2).optional(),
    })
    .optional(),
};

/**
 * Personal Health Intelligence endpoints (ADD-ON). All routes are read-only
 * computations over verified data plus hypothetical (never persisted)
 * scenario math, so the existing READ policy applies: owners, editors and
 * viewers may use them; strangers get 404; admins get no health access —
 * exactly like trends/risk today.
 */
export class IntelligenceController {
  constructor({ orchestratorService, counterfactualService, explanationService, policyService }) {
    this.intelligence = orchestratorService;
    this.counterfactual = counterfactualService;
    this.explainer = explanationService;
    this.policy = policyService;
  }

  loadReadableMember(req) {
    const { member } = this.policy.loadMemberWithAccess(req.actor, req.params.memberId);
    this.policy.assertRead(req.actor, member);
    return member;
  }

  /** Full evidence package: baselines + anomalies + graph + risk + cards. */
  getIntelligence = (req, res, next) => {
    try {
      const member = this.loadReadableMember(req);
      res.json(this.intelligence.getEvidence(member));
    } catch (e) {
      next(e);
    }
  };

  getBaseline = (req, res, next) => {
    try {
      const member = this.loadReadableMember(req);
      const { signal } = req.query;
      if (signal) {
        const one = this.intelligence.baselineService.baselineForSignal(member, signal);
        if (!one) throw new NotFoundError(`No baseline for signal '${signal}'`);
        return res.json(one);
      }
      res.json(this.intelligence.baselineService.baselinesFor(member));
    } catch (e) {
      next(e);
    }
  };

  getPatterns = (req, res, next) => {
    try {
      const member = this.loadReadableMember(req);
      const evidence = this.intelligence.getEvidence(member);
      const { type, minStrength } = req.query;
      let edges = evidence.graph.edges;
      if (type) edges = edges.filter((e) => e.type === type);
      if (minStrength != null) edges = edges.filter((e) => (e.strength ?? 0) >= minStrength);
      res.json({
        memberId: member.id,
        generatedAt: evidence.graph.generatedAt,
        nodes: evidence.graph.nodes,
        edges,
        edgeCount: edges.length,
        totalEdges: evidence.graph.edges.length,
        legend: evidence.graph.legend,
        unmappedModelContributions: evidence.graph.unmappedModelContributions,
        unknownPairExamples: evidence.graph.unknownPairExamples,
        multivariateFindings: evidence.anomalies.findings.filter(
          (f) => f.type === 'multivariate_shift' || f.type === 'conflicting_measurements' || f.type === 'unusual_combination',
        ),
        disclaimer: evidence.graph.disclaimer,
      });
    } catch (e) {
      next(e);
    }
  };

  simulate = (req, res, next) => {
    try {
      const member = this.loadReadableMember(req);
      const { changes, label } = req.body;
      res.json(this.counterfactual.simulate(member, changes, { label }));
    } catch (e) {
      next(e);
    }
  };

  exploreScenarios = (req, res, next) => {
    try {
      const member = this.loadReadableMember(req);
      res.json(this.counterfactual.explore(member, req.body || {}));
    } catch (e) {
      next(e);
    }
  };

  explain = async (req, res, next) => {
    try {
      const member = this.loadReadableMember(req);
      res.json(await this.explainer.explain(member));
    } catch (e) {
      next(e);
    }
  };
}
