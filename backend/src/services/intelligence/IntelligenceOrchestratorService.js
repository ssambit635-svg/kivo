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

  /** Full evidence package (cached briefly; fingerprint-guarded). */
  getEvidence(member) {
    const fingerprint = this.fingerprint(member);
    const cached = this.cache.get(member.id);
    if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.evidence;
    }
    const evidence = this.buildEvidence(member);
    this.cache.set(member.id, { fingerprint, at: Date.now(), evidence });
    if (this.cache.size > 500) {
      // opportunistic bound — drop the oldest entries
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
      for (const [k] of oldest) this.cache.delete(k);
    }
    return evidence;
  }

  buildEvidence(member) {
    const baselines = this.baselineService.baselinesFor(member);
    const anomalies = this.anomalyService.analyze(member);
    const graph = this.graphService.build(member);
    const risk = this.risk.assess(member);
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
    const levels = baselines.baselines.map((b) => b.confidence.level);
    const lowCount = levels.filter((l) => l === 'low').length;
    const gapCount = anomalies.findings.filter((f) => f.type === 'data_gap').length;

    reasons.push(
      `${baselines.signalCount} signal(s): ${levels.filter((l) => l === 'high').length} high, ` +
      `${levels.filter((l) => l === 'moderate').length} moderate, ${lowCount} low baseline confidence.`,
    );
    reasons.push(`Prototype risk model data completeness: ${Math.round(risk.result.completeness * 100)}%.`);
    if (gapCount > 0) reasons.push(`${gapCount} data-gap finding(s) — some periods have no recorded values.`);
    if (baselines.dataContext.medicationCount > 0 || baselines.dataContext.symptomCount > 0) {
      reasons.push('Recorded symptoms/medications exist as context; the engines do not interpret them medically.');
    }

    let level = 'moderate';
    if (baselines.signalCount === 0 || risk.result.completeness < 0.5) {
      level = 'low';
      reasons.push(
        baselines.signalCount === 0
          ? 'No verified health signals yet — intelligence statements cannot be grounded.'
          : 'Very low data completeness — intelligence statements are highly uncertain.',
      );
    } else if (lowCount === 0 && risk.result.completeness >= 0.75 && gapCount === 0) {
      level = 'high';
      reasons.push('Repeated verified observations with good completeness — the firmest grounding this prototype offers.');
    } else {
      reasons.push('Mixed evidence strength — individual findings carry their own confidence levels; check each one.');
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

    // Personal Baseline card
    const shifted = baselines.baselines.filter((b) => ['sudden_deviation', 'persistent_deviation', 'gradual_drift'].includes(b.status));
    cards.push({
      key: 'personal_baseline',
      title: 'Personal Baseline',
      headline: baselines.signalCount === 0
        ? 'No personal baselines yet — verify a report to start yours.'
        : `${baselines.signalCount} personal baseline(s); ${shifted.length} showing a historical shift.`,
      detail: shifted.length > 0
        ? shifted.slice(0, 3).map((b) => b.summary)
        : baselines.baselines.slice(0, 3).map((b) => b.summary),
      level: baselines.overallConfidence.level,
    });

    // Detected Shift card
    const topFinding = anomalies.findings[0] || null;
    cards.push({
      key: 'detected_shift',
      title: 'Detected Shift',
      headline: !topFinding
        ? 'No notable shifts detected in the recorded history.'
        : `${anomalies.findings.length} pattern(s) noted — top: ${findingHeadline(topFinding)}.`,
      detail: topFinding ? [topFinding.interpretation] : [],
      level: topFinding ? topFinding.severity : 'informational',
      ref: topFinding ? { type: topFinding.type, signals: topFinding.signals } : null,
    });

    // Health Pattern card
    const topEdge = [...graph.edges].sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))[0] || null;
    cards.push({
      key: 'health_pattern',
      title: 'Health Pattern',
      headline: !topEdge
        ? 'No signal relationships described yet — more overlapping history is needed.'
        : `Strongest described relationship: ${edgeHeadline(topEdge)} (${topEdge.type}).`,
      detail: topEdge ? topEdge.evidence.slice(0, 2) : [],
      level: topEdge ? topEdge.confidence.level : 'low',
    });

    // Model Contribution card
    const topFactor = risk.result.contributingFactors[0] || null;
    cards.push({
      key: 'model_contribution',
      title: 'Model Contribution',
      headline: !topFactor
        ? 'The prototype model has no inputs yet.'
        : `Top model driver: ${topFactor.label} = ${topFactor.value}${topFactor.unit ? ` ${topFactor.unit}` : ''} (${topFactor.effectOnEstimate} the estimate).`,
      detail: topFactor
        ? [`Prototype estimate: ${risk.result.percent}% (${risk.result.band}); completeness ${Math.round(risk.result.completeness * 100)}%.`]
        : [],
      level: risk.result.completeness >= 0.75 ? 'moderate' : 'low',
    });

    // Confidence card
    cards.push({
      key: 'confidence',
      title: 'Confidence',
      headline: `Overall intelligence confidence: ${uncertainty.level}.`,
      detail: uncertainty.reasons.slice(0, 4),
      level: uncertainty.level,
    });

    // What Changed card
    const movers = baselines.baselines
      .filter((b) => b.latest.deviationZ != null)
      .sort((a, b) => Math.abs(b.latest.deviationZ) - Math.abs(a.latest.deviationZ))
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
  const heads = {
    sudden_shift: `sudden personal deviation in ${f.markers.join(', ')}`,
    gradual_drift: `gradual drift in ${f.markers.join(', ')}`,
    persistent_deviation: `persistent deviation in ${f.markers.join(', ')}`,
    change_point: `candidate change point in ${f.markers.join(', ')}`,
    multivariate_shift: `coordinated movement across ${f.markers.join(', ')}`,
    conflicting_measurements: `divergent movement between ${f.markers.join(' and ')}`,
    data_gap: `data gap in ${f.markers.join(', ')}`,
    unusual_combination: `unusual combination across ${f.markers.join(', ')}`,
  };
  return heads[f.type] || f.type;
}

function edgeHeadline(e) {
  return `${e.source} ↔ ${e.target}`;
}

export { timeOf };
