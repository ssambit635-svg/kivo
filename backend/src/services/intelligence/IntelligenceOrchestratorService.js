import { SignalCollector, timeOf } from './signalSeries.js';
import { PersonalBaselineService, BASELINE_DISCLAIMER } from './PersonalBaselineService.js';
import { TemporalAnomalyService, ANOMALY_DISCLAIMER } from './TemporalAnomalyService.js';
import { HealthPatternGraphService, GRAPH_DISCLAIMER } from './HealthPatternGraphService.js';

/**
 * Intelligence Orchestrator (ADD-ON): assembles the full Personal Health
 * Intelligence evidence package from deterministic/statistical components:
 *
 *   verified data → baselines → anomalies → pattern graph → risk → package
 *
 * The package feeds UI cards and the grounded explanation service. Nothing
 * here generates language on its own; every number is computed from stored,
 * verified data. Results are cached briefly per member, keyed by a
 * fingerprint of the underlying data so stale results are never served.
 */

export const INTELLIGENCE_DISCLAIMER =
  'Personal Health Intelligence is an experimental pattern-recognition aid over recorded values. ' +
  'It is not a doctor, not a diagnosis, and not clinically validated. Associations are not ' +
  'causation, and scenario projections are model arithmetic on hypothetical numbers — not ' +
  'predictions about any person.';

const CACHE_TTL_MS = 60_000;

export class IntelligenceOrchestratorService {
  constructor({ labResultRepository, observationRepository, riskModelService }) {
    this.collector = new SignalCollector({ labResultRepository, observationRepository });
    this.baselineService = new PersonalBaselineService({ labResultRepository, observationRepository });
    this.anomalyService = new TemporalAnomalyService({ labResultRepository, observationRepository });
    this.graphService = new HealthPatternGraphService({ labResultRepository, observationRepository, riskModelService });
    this.risk = riskModelService;
    this.cache = new Map(); // memberId → { fingerprint, at, evidence }
  }

  /** Full evidence package (cached briefly; fingerprint-guarded). Never throws — degrades. */
  getEvidence(member) {
    try {
      const memberId = member?.id ?? null;
      const fingerprint = this.fingerprint(member);
      const cached = memberId ? this.cache.get(memberId) : null;
      if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.evidence;
      }
      const evidence = this.buildEvidence(member);
      if (memberId) {
        this.cache.set(memberId, { fingerprint, at: Date.now(), evidence });
        if (this.cache.size > 500) {
          // opportunistic bound — drop the oldest entries
          const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
          for (const [k] of oldest) this.cache.delete(k);
        }
      }
      return evidence;
    } catch {
      return this.degradedEvidence(member);
    }
  }

  /** Minimal package used only when a component throws — routes keep responding. */
  degradedEvidence(member) {
    return {
      memberId: member?.id ?? null,
      memberName: member?.name ?? null,
      generatedAt: new Date().toISOString(),
      degraded: true,
      dataSummary: { signalCount: 0, verifiedLabCount: 0, observationCount: 0, symptomCount: 0, medicationCount: 0 },
      baselines: { signalCount: 0, baselines: [], dataContext: { verifiedLabCount: 0, observationCount: 0, symptomCount: 0, medicationCount: 0 }, overallConfidence: { level: 'low' } },
      anomalies: { findings: [] },
      graph: { nodes: [], edges: [] },
      risk: null,
      uncertainty: { level: 'low', reasons: ['Intelligence is temporarily unavailable for this member.'], note: 'Partial results — try again shortly.' },
      summaryCards: [],
      disclaimers: [INTELLIGENCE_DISCLAIMER],
    };
  }

  buildEvidence(member) {
    const build = (fn, fallback) => {
      try {
        const out = fn();
        return out && typeof out === 'object' ? out : fallback;
      } catch {
        return fallback;
      }
    };
    const degraded = this.degradedEvidence(member);
    const baselines = build(() => this.baselineService.baselinesFor(member), degraded.baselines);
    const anomalies = build(() => this.anomalyService.analyze(member), degraded.anomalies);
    const graph = build(() => this.graphService.build(member), degraded.graph);
    const risk = build(() => this.risk.assess(member), null);
    const uncertainty = this.overallUncertainty({ member, baselines, anomalies, risk });
    const summaryCards = this.summaryCards({ member, baselines, anomalies, graph, risk, uncertainty });

    return {
      memberId: member.id,
      memberName: member.name,
      generatedAt: new Date().toISOString(),
      dataSummary: {
        signalCount: baselines.signalCount,
        verifiedLabCount: baselines.dataContext.verifiedLabCount,
        observationCount: baselines.dataContext.observationCount,
        symptomCount: baselines.dataContext.symptomCount,
        medicationCount: baselines.dataContext.medicationCount,
      },
      baselines,
      anomalies,
      graph,
      risk,
      uncertainty,
      summaryCards,
      disclaimers: [INTELLIGENCE_DISCLAIMER, BASELINE_DISCLAIMER, ANOMALY_DISCLAIMER, GRAPH_DISCLAIMER],
    };
  }

  fingerprint(member) {
    const { signals, context } = this.collector.collect(member);
    let latest = '';
    let points = 0;
    for (const s of signals) {
      points += s.points.length;
      const last = s.points[s.points.length - 1]?.t || '';
      if (last > latest) latest = last;
    }
    return [member.id, member.updated_at, signals.length, points, latest, context.observationCount, context.verifiedLabCount].join('|');
  }

  overallUncertainty({ member, baselines, anomalies, risk }) {
    const reasons = [];
    let level = 'low';
    try {
      const list = Array.isArray(baselines?.baselines) ? baselines.baselines : [];
      const levels = list.map((b) => b?.confidence?.level);
      const lowCount = levels.filter((l) => l === 'low').length;
      const findings = Array.isArray(anomalies?.findings) ? anomalies.findings : [];
      const gapCount = findings.filter((f) => f?.type === 'data_gap').length;
      const signalCount = Number(baselines?.signalCount) || 0;
      const completeness = Number(risk?.result?.completeness);

      reasons.push(
        `${signalCount} signal(s): ${levels.filter((l) => l === 'high').length} high, ` +
        `${levels.filter((l) => l === 'moderate').length} moderate, ${lowCount} low baseline confidence.`,
      );
      reasons.push(`Prototype risk model data completeness: ${Number.isFinite(completeness) ? Math.round(completeness * 100) : 0}%.`);
      if (gapCount > 0) reasons.push(`${gapCount} data-gap finding(s) — some periods have no recorded values.`);
      const ctx = baselines?.dataContext || {};
      if (Number(ctx.medicationCount) > 0 || Number(ctx.symptomCount) > 0) {
        reasons.push('Recorded symptoms/medications exist as context; the engines do not interpret them medically.');
      }

      level = 'moderate';
      if (signalCount === 0 || !(completeness >= 0.5)) {
        level = 'low';
        reasons.push(
          signalCount === 0
            ? 'No verified health signals yet — intelligence statements cannot be grounded.'
            : 'Very low data completeness — intelligence statements are highly uncertain.',
        );
      } else if (lowCount === 0 && completeness >= 0.75 && gapCount === 0) {
        level = 'high';
        reasons.push('Repeated verified observations with good completeness — the firmest grounding this prototype offers.');
      } else {
        reasons.push('Mixed evidence strength — individual findings carry their own confidence levels; check each one.');
      }
    } catch {
      reasons.length = 0;
      reasons.push('Uncertainty could not be computed from the available pieces — treating confidence as low.');
      level = 'low';
    }

    void member;
    return {
      level,
      score: level === 'low' ? null : level === 'high' ? 0.8 : 0.6,
      reasons,
      note: level === 'low'
        ? 'Confidence is low: statements below should be read as early observations over sparse data.'
        : 'Confidence reflects data quantity/quality only — never clinical certainty.',
    };
  }

  summaryCards({ member, baselines, anomalies, graph, risk, uncertainty }) {
    void member;
    const cards = [];
    const bList = Array.isArray(baselines?.baselines) ? baselines.baselines : [];
    const signalCount = Number(baselines?.signalCount) || 0;
    const findings = Array.isArray(anomalies?.findings) ? anomalies.findings : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const factors = Array.isArray(risk?.result?.contributingFactors) ? risk.result.contributingFactors : [];
    const completeness = Number(risk?.result?.completeness);

    // Personal Baseline card
    const shifted = bList.filter((b) => b && ['sudden_deviation', 'persistent_deviation', 'gradual_drift'].includes(b.status));
    cards.push({
      key: 'personal_baseline',
      title: 'Personal Baseline',
      headline: signalCount === 0
        ? 'No personal baselines yet — verify a report to start yours.'
        : `${signalCount} personal baseline(s); ${shifted.length} showing a historical shift.`,
      detail: shifted.length > 0
        ? shifted.slice(0, 3).map((b) => b.summary).filter(Boolean)
        : bList.slice(0, 3).map((b) => b?.summary).filter(Boolean),
      level: baselines?.overallConfidence?.level || 'low',
    });

    // Detected Shift card
    const topFinding = findings[0] || null;
    cards.push({
      key: 'detected_shift',
      title: 'Detected Shift',
      headline: !topFinding
        ? 'No notable shifts detected in the recorded history.'
        : `${findings.length} pattern(s) noted — top: ${findingHeadline(topFinding)}.`,
      detail: topFinding?.interpretation ? [topFinding.interpretation] : [],
      level: topFinding?.severity || 'informational',
      ref: topFinding ? { type: topFinding.type, signals: topFinding.signals } : null,
    });

    // Health Pattern card
    const topEdge = [...edges].sort((a, b) => (Number(b?.strength) || 0) - (Number(a?.strength) || 0))[0] || null;
    cards.push({
      key: 'health_pattern',
      title: 'Health Pattern',
      headline: !topEdge
        ? 'No signal relationships described yet — more overlapping history is needed.'
        : `Strongest described relationship: ${edgeHeadline(topEdge)} (${topEdge.type}).`,
      detail: Array.isArray(topEdge?.evidence) ? topEdge.evidence.slice(0, 2) : [],
      level: topEdge?.confidence?.level || 'low',
    });

    // Model Contribution card
    const topFactor = factors[0] || null;
    cards.push({
      key: 'model_contribution',
      title: 'Model Contribution',
      headline: !topFactor
        ? 'The prototype model has no inputs yet.'
        : `Top model driver: ${topFactor.label} = ${topFactor.value}${topFactor.unit ? ` ${topFactor.unit}` : ''} (${topFactor.effectOnEstimate} the estimate).`,
      detail: topFactor
        ? [`Prototype estimate: ${risk?.result?.percent ?? '—'}% (${risk?.result?.band ?? 'unknown'}); completeness ${Number.isFinite(completeness) ? Math.round(completeness * 100) : 0}%.`]
        : [],
      level: completeness >= 0.75 ? 'moderate' : 'low',
    });

    // Confidence card
    const uReasons = Array.isArray(uncertainty?.reasons) ? uncertainty.reasons : [];
    const uLevel = uncertainty?.level || 'low';
    cards.push({
      key: 'confidence',
      title: 'Confidence',
      headline: `Overall intelligence confidence: ${uLevel}.`,
      detail: uReasons.slice(0, 4),
      level: uLevel,
    });

    // What Changed card
    const movers = bList
      .filter((b) => b && Number.isFinite(Number(b.latest?.deviationZ)))
      .sort((a, b) => Math.abs(Number(b.latest.deviationZ)) - Math.abs(Number(a.latest.deviationZ)))
      .slice(0, 3);
    cards.push({
      key: 'what_changed',
      title: 'What Changed?',
      headline: movers.length === 0
        ? 'Nothing to compare yet.'
        : 'Largest latest-vs-baseline differences in your own recorded history:',
      detail: movers.map(
        (b) => `${b.label}: latest ${b.latest.value}${b.unit ? ` ${b.unit}` : ''} vs personal mean ${b.mean} (${b.latest.deviationZ > 0 ? '+' : ''}${b.latest.deviationZ} spreads).`,
      ),
      level: 'informational',
    });

    return cards;
  }
}

function findingHeadline(f) {
  try {
    const markers = Array.isArray(f?.markers) ? f.markers : [];
    const joined = markers.join(', ');
    const heads = {
      sudden_shift: `sudden personal deviation in ${joined}`,
      gradual_drift: `gradual drift in ${joined}`,
      persistent_deviation: `persistent deviation in ${joined}`,
      change_point: `candidate change point in ${joined}`,
      multivariate_shift: `coordinated movement across ${joined}`,
      conflicting_measurements: `divergent movement between ${markers.join(' and ')}`,
      data_gap: `data gap in ${joined}`,
      unusual_combination: `unusual combination across ${joined}`,
    };
    return heads[f?.type] || f?.type || 'pattern';
  } catch {
    return 'pattern';
  }
}

function edgeHeadline(e) {
  try {
    return `${e?.source ?? '?'} ↔ ${e?.target ?? '?'}`;
  } catch {
    return 'relationship';
  }
}

export { timeOf };
