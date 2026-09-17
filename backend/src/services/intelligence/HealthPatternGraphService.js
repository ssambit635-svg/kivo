import { SignalCollector, pearson, timeOf, daysBetween, round2 } from './signalSeries.js';
import { PersonalBaselineService } from './PersonalBaselineService.js';
import { TemporalAnomalyService } from './TemporalAnomalyService.js';

/**
 * Personal Health Pattern Graph (intelligence ADD-ON, capability #3).
 *
 * Builds a dynamic graph of relationships between the person's own health
 * signals from their actual recorded data — nothing is hardcoded.
 *
 * Relationship types (never causal unless the data genuinely supports causal
 * inference — these observational summaries never do):
 *   OBSERVED               signals measured together repeatedly
 *   TEMPORAL_ASSOCIATION    signals shifting during the same period
 *   STATISTICAL_ASSOCIATION time-aligned values correlate across history
 *   MODEL_CONTRIBUTION     signal feeds the existing prototype risk estimate
 *   UNKNOWN                considered, but evidence is insufficient
 */

export const GRAPH_DISCLAIMER =
  'Relationships in this graph are observed, temporal, or statistical associations in recorded ' +
  'values — association is not causation, and no edge implies that one signal influences, treats, ' +
  'or predicts another. Discuss persistent concerns with a qualified healthcare professional.';

export const RELATIONSHIP_LEGEND = {
  OBSERVED: 'The two signals were measured together repeatedly (joint observation frequency). Strength = co-measurement frequency (capped).',
  TEMPORAL_ASSOCIATION: 'Both signals shifted from their baselines during the same period (shared timing only). Strength = mean standardized shift.',
  STATISTICAL_ASSOCIATION: 'Time-aligned values correlate across history (Pearson r on nearest-date pairs within 60 days). Strength = |r|.',
  MODEL_CONTRIBUTION: 'The signal is an input to the existing transparent prototype risk model. Strength = |model contribution|; direction comes from the model.',
  UNKNOWN: 'The pair was considered but has too little overlapping data to describe. No statement is made either way.',
};

// Risk-model feature → signal node, where one exists.
const FEATURE_SIGNAL_MAP = {
  fastingGlucose: 'lab:fasting_glucose',
  hba1c: 'lab:hba1c',
  hdl: 'lab:hdl',
  triglycerides: 'lab:triglycerides',
  bmi: 'derived:bmi',
  systolicBp: 'obs:systolic_bp',
  activityLevel: 'obs:activity_min_week',
};

const ALIGN_DAYS = 60;
const CO_MEASURE_DAYS = 7;

export class HealthPatternGraphService {
  constructor({ labResultRepository, observationRepository, riskModelService }) {
    this.collector = new SignalCollector({ labResultRepository, observationRepository });
    this.baselines = new PersonalBaselineService({ labResultRepository, observationRepository });
    this.anomalies = new TemporalAnomalyService({ labResultRepository, observationRepository });
    this.risk = riskModelService;
  }

  build(member) {
    const { signals } = this.collector.collect(member);
    const baselineBySignal = new Map(signals.map((s) => [s.signal, this.baselines.describeSignal(s)]));
    const anomalyReport = this.anomalies.analyze(member);
    const risk = this.risk.assess(member);

    const nodes = signals.map((s) => {
      const b = baselineBySignal.get(s.signal);
      return {
        id: s.signal,
        type: 'signal',
        label: s.label,
        unit: s.unit,
        kind: s.kind,
        latestValue: b.latest.value,
        latestAt: b.lastAt,
        baselineMean: b.mean,
        deviationZ: b.latest.deviationZ,
        pointCount: b.observationCount,
        baselineStatus: b.status,
      };
    });
    const nodeIds = new Set(nodes.map((n) => n.id));

    const edges = [];
    edges.push(...this.statisticalEdges(signals));
    edges.push(...this.temporalEdges(anomalyReport));
    edges.push(...this.observedEdges(signals));
    const { modelNode, modelEdges, unmapped } = this.modelEdges(risk, nodeIds);
    if (modelNode) nodes.push(modelNode);
    edges.push(...modelEdges);

    const unknownExamples = this.unknownExamples(signals);

    return {
      memberId: member.id,
      generatedAt: new Date().toISOString(),
      nodes,
      edges,
      legend: RELATIONSHIP_LEGEND,
      unmappedModelContributions: unmapped,
      unknownPairExamples: unknownExamples,
      consideredPairs: countPairs(signals.length),
      disclaimer: GRAPH_DISCLAIMER,
    };
  }

  // ------------------------------------------- STATISTICAL_ASSOCIATION (Pearson)
  statisticalEdges(signals) {
    const edges = [];
    for (let i = 0; i < signals.length; i += 1) {
      for (let j = i + 1; j < signals.length; j += 1) {
        const pairs = alignNearest(signals[i].points, signals[j].points, ALIGN_DAYS);
        if (pairs.length < 3) continue;
        const r = pearson(pairs);
        if (r == null || Math.abs(r) < 0.5) continue;
        const sameDirection = r > 0;
        edges.push({
          source: signals[i].signal,
          target: signals[j].signal,
          type: 'STATISTICAL_ASSOCIATION',
          strength: round2(Math.abs(r)),
          direction: sameDirection ? 'same_direction' : 'opposite_direction',
          confidence: pairs.length >= 5
            ? { level: 'moderate', score: round2(Math.min(0.85, 0.5 + pairs.length * 0.05)), reasons: [`Pearson r=${round2(r)} across ${pairs.length} time-aligned pairs.`] }
            : { level: 'low', score: null, reasons: [`Pearson r=${round2(r)} across only ${pairs.length} time-aligned pairs — suggestive, not firm.`] },
          evidence: [
            `${pairs.length} time-aligned observation pairs (nearest dates within ${ALIGN_DAYS} days) from ${shortDate(pairs[0][2])} to ${shortDate(pairs[pairs.length - 1][2])}.`,
            sameDirection
              ? 'When one value was relatively high in its own history, the other tended to be relatively high too.'
              : 'When one value was relatively high in its own history, the other tended to be relatively low.',
          ],
          timeWindow: { from: pairs[0][2], to: pairs[pairs.length - 1][2] },
          note: 'Correlation across recorded history; not evidence of causation.',
        });
      }
    }
    return edges;
  }

  // ------------------------------------------- TEMPORAL_ASSOCIATION (co-shifts)
  temporalEdges(anomalyReport) {
    const edges = [];
    for (const f of anomalyReport.findings) {
      if (f.type !== 'multivariate_shift') continue;
      for (let i = 0; i < f.signals.length; i += 1) {
        for (let j = i + 1; j < f.signals.length; j += 1) {
          edges.push({
            source: f.signals[i],
            target: f.signals[j],
            type: 'TEMPORAL_ASSOCIATION',
            strength: typeof f.score === 'number' ? f.score : null,
            direction: 'shared_timing',
            confidence: f.confidence,
            evidence: [
              `Both signals shifted from their personal baselines during ${shortDate(f.startDate)} → ${shortDate(f.endDate)}.`,
              ...f.evidence.filter((e) => e.startsWith(f.markers[i].split(':')[0]) || e.startsWith(f.markers[j].split(':')[0])).slice(0, 2),
            ],
            timeWindow: { from: f.startDate, to: f.endDate },
            note: 'Shared timing only — co-movement describes timing overlap, nothing more.',
          });
        }
      }
    }
    return edges;
  }

  // ------------------------------------------------ OBSERVED (co-measurement)
  observedEdges(signals) {
    const scored = [];
    for (let i = 0; i < signals.length; i += 1) {
      for (let j = i + 1; j < signals.length; j += 1) {
        const co = countCoMeasured(signals[i].points, signals[j].points, CO_MEASURE_DAYS);
        if (co.count < 2) continue;
        scored.push({ a: signals[i], b: signals[j], co });
      }
    }
    scored.sort((x, y) => y.co.count - x.co.count || (x.a.signal < y.a.signal ? -1 : 1));
    return scored.slice(0, 15).map(({ a, b, co }) => ({
      source: a.signal,
      target: b.signal,
      type: 'OBSERVED',
      strength: round2(Math.min(1, co.count / 5)),
      direction: 'co_measured',
      confidence: { level: co.count >= 4 ? 'moderate' : 'low', score: null, reasons: [`Measured within ${CO_MEASURE_DAYS} days of each other ${co.count} time(s).`] },
      evidence: [`${co.count} joint observation(s), most recently around ${shortDate(co.latest)}.`],
      timeWindow: { from: co.earliest, to: co.latest },
      note: 'Joint observation frequency; timing overlap only, with no directional meaning.',
    }));
  }

  // ------------------------------------------- MODEL_CONTRIBUTION (risk model)
  modelEdges(risk, nodeIds) {
    const result = risk.result;
    const modelNode = {
      id: `model:${result.model.id}`,
      type: 'model',
      label: 'Prototype risk estimate (existing transparent model)',
      modelId: result.model.id,
      modelVersion: result.model.version,
      band: result.band,
      percent: result.percent,
      completeness: result.completeness,
    };
    const edges = [];
    const unmapped = [];
    const factors = [...result.contributingFactors]
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 5);
    for (const f of factors) {
      const signalId = FEATURE_SIGNAL_MAP[f.feature];
      if (!signalId || !nodeIds.has(signalId)) {
        unmapped.push({ feature: f.feature, label: f.label, contribution: f.contribution, reason: 'No recorded signal stream maps to this model input.' });
        continue;
      }
      edges.push({
        source: signalId,
        target: modelNode.id,
        type: 'MODEL_CONTRIBUTION',
        strength: round2(Math.abs(f.contribution)),
        direction: f.effectOnEstimate === 'raises' ? 'raises_estimate' : f.effectOnEstimate === 'lowers' ? 'lowers_estimate' : 'neutral',
        confidence: {
          level: result.completeness >= 0.75 ? 'moderate' : 'low',
          score: null,
          reasons: [
            `Model input value ${f.value}${f.unit ? ` ${f.unit}` : ''}; contribution ${f.contribution} (weight × standardized distance).`,
            `Model data completeness ${Math.round(result.completeness * 100)}%.`,
          ],
        },
        evidence: [
          `${f.label} = ${f.value}${f.unit ? ` ${f.unit}` : ''} ${f.effectOnEstimate === 'raises' ? 'raises' : f.effectOnEstimate === 'lowers' ? 'lowers' : 'does not move'} the prototype estimate (contribution ${f.contribution}).`,
        ],
        timeWindow: null,
        note: 'Faithful readout of the existing transparent model — describes the model, not the body.',
      });
    }
    return { modelNode, modelEdges: edges, unmapped };
  }

  unknownExamples(signals) {
    const examples = [];
    for (let i = 0; i < signals.length && examples.length < 5; i += 1) {
      for (let j = i + 1; j < signals.length && examples.length < 5; j += 1) {
        const pairs = alignNearest(signals[i].points, signals[j].points, ALIGN_DAYS);
        if (pairs.length >= 3) continue;
        examples.push({
          source: signals[i].signal,
          target: signals[j].signal,
          type: 'UNKNOWN',
          reason: `Only ${pairs.length} time-aligned observation pair(s) — too little overlap to describe any relationship.`,
        });
      }
    }
    return examples;
  }
}

// ---------------------------------------------------------------------------
/** Pair each point of the shorter series with its nearest neighbour in the
 *  other series (each target point used once), keeping pairs within maxDays.
 *  Returns [[vA, vB, pairDate], ...] sorted by date. Deterministic. */
export function alignNearest(pointsA, pointsB, maxDays) {
  const [shorter, longer, flipped] = pointsA.length <= pointsB.length
    ? [pointsA, pointsB, false]
    : [pointsB, pointsA, true];
  const used = new Set();
  const pairs = [];
  for (const p of shorter) {
    let best = -1;
    let bestDt = Infinity;
    for (let i = 0; i < longer.length; i += 1) {
      if (used.has(i)) continue;
      const dt = Math.abs(daysBetween(p.t, longer[i].t));
      if (dt < bestDt) {
        bestDt = dt;
        best = i;
      }
    }
    if (best >= 0 && bestDt <= maxDays) {
      used.add(best);
      const q = longer[best];
      pairs.push(flipped ? [q.v, p.v, avgDate(q.t, p.t)] : [p.v, q.v, avgDate(p.t, q.t)]);
    }
  }
  pairs.sort((a, b) => timeOf(a[2]) - timeOf(b[2]));
  return pairs;
}

function countCoMeasured(pointsA, pointsB, maxDays) {
  let count = 0;
  let earliest = null;
  let latest = null;
  const usedB = new Set();
  for (const p of pointsA) {
    for (let i = 0; i < pointsB.length; i += 1) {
      if (usedB.has(i)) continue;
      if (Math.abs(daysBetween(p.t, pointsB[i].t)) <= maxDays) {
        usedB.add(i);
        count += 1;
        const d = avgDate(p.t, pointsB[i].t);
        if (!earliest || timeOf(d) < timeOf(earliest)) earliest = d;
        if (!latest || timeOf(d) > timeOf(latest)) latest = d;
        break;
      }
    }
  }
  return { count, earliest, latest };
}

function avgDate(a, b) {
  return new Date(Math.round((timeOf(a) + timeOf(b)) / 2)).toISOString();
}

function countPairs(n) {
  return Math.max(0, (n * (n - 1)) / 2);
}

function shortDate(iso) {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : String(iso);
}
