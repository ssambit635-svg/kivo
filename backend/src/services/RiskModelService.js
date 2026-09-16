import { ageFromDob } from '../utils/time.js';

/**
 * Explainable Type-2-Diabetes *risk-awareness* prototype model.
 *
 * IMPORTANT (medical safety, per product spec): this is a TRANSPARENT
 * logistic model with hand-specified, FINDRISC-inspired prototype
 * coefficients. It is NOT clinically validated. The output is a risk
 * estimate with uncertainty — never a diagnosis. The disclaimer is part
 * of the response object so no consumer can accidentally render a bare
 * score.
 *
 * Explainability: for each used feature we report its standardized value,
 * its model weight, and its signed contribution (weight × z). Positive
 * contribution pushes the estimate upward. Sorting contributions gives a
 * faithful "why" for this model class — no fabricated reasoning required.
 */
const MODEL = {
  id: 't2d-risk-awareness',
  version: '1.0.0',
  intercept: -2.35,
  // Standardization stats (typical adult survey means/stds — prototype constants).
  stats: {
    age: { mean: 45, sd: 16 },
    bmi: { mean: 26, sd: 5 },
    fastingGlucose: { mean: 96, sd: 22 },
    hba1c: { mean: 5.5, sd: 0.8 },
    systolicBp: { mean: 124, sd: 16 },
    hdl: { mean: 52, sd: 15 },
    triglycerides: { mean: 135, sd: 70 },
    familyDiabetes: { mean: 0.25, sd: 0.433 },
    activityLevel: { mean: 1, sd: 0.75 }, // 0 sedentary, 1 moderate, 2 active
  },
  weights: {
    age: 0.30,
    bmi: 0.55,
    fastingGlucose: 1.10,
    hba1c: 0.85,
    systolicBp: 0.18,
    hdl: -0.20, // protective direction
    triglycerides: 0.22,
    familyDiabetes: 0.45,
    activityLevel: -0.25, // protective direction
  },
  labels: {
    age: 'Age',
    bmi: 'Body-mass index',
    fastingGlucose: 'Fasting glucose',
    hba1c: 'HbA1c',
    systolicBp: 'Systolic blood pressure',
    hdl: 'HDL cholesterol',
    triglycerides: 'Triglycerides',
    familyDiabetes: 'Family history of diabetes',
    activityLevel: 'Physical activity level',
  },
  units: {
    age: 'years', bmi: 'kg/m²', fastingGlucose: 'mg/dL', hba1c: '%', systolicBp: 'mmHg',
    hdl: 'mg/dL', triglycerides: 'mg/dL', familyDiabetes: null, activityLevel: null,
  },
};

const DISCLAIMER =
  'This is a prototype risk-awareness estimate computed by a transparent statistical model. ' +
  'It is NOT a medical diagnosis, has not been clinically validated, and missing or inaccurate ' +
  'data changes the result. Please discuss persistent concerns with a qualified healthcare professional.';

export class RiskModelService {
  constructor({ labResultRepository, observationRepository }) {
    this.labs = labResultRepository;
    this.observations = observationRepository;
  }

  /** Assemble model inputs from the member's verified data. Mathe overrides enable what-if scenarios. */
  assembleInputs(member, overrides = {}) {
    const latest = (code) => this.labs.latestForMember(member.id, code);
    const weightObs = this.observations.latestOfKind(member.id, 'weight');
    const bpObs = this.observations.latestOfKind(member.id, 'bp');
    const activityObs = this.observations.latestOfKind(member.id, 'activity');

    const weightKg = weightObs?.data?.weightKg ?? null;
    const bmi =
      weightKg != null && member.height_cm
        ? Number((weightKg / (member.height_cm / 100) ** 2).toFixed(1))
        : null;

    let activityLevel = null;
    if (activityObs?.data?.minutesPerWeek != null) {
      const m = activityObs.data.minutesPerWeek;
      activityLevel = m < 60 ? 0 : m < 150 ? 1 : 2;
    }

    const familyHistory = member.familyHistory || {};

    const assembled = {
      age: member.dob ? ageFromDob(member.dob) : null,
      bmi,
      fastingGlucose: latest('fasting_glucose')?.value ?? null,
      hba1c: latest('hba1c')?.value ?? null,
      systolicBp: bpObs?.data?.systolic ?? null,
      hdl: latest('hdl')?.value ?? null,
      triglycerides: latest('triglycerides')?.value ?? null,
      familyDiabetes: familyHistory.diabetes === true ? 1 : familyHistory.diabetes === false ? 0 : null,
      activityLevel,
    };

    // What-if overrides are applied then flagged everywhere downstream.
    const sources = {};
    for (const k of Object.keys(MODEL.weights)) {
      sources[k] = { value: assembled[k], overridden: false };
    }
    for (const [k, v] of Object.entries(overrides || {})) {
      if (k in MODEL.weights && v != null) {
        sources[k] = { value: v, overridden: true };
      }
    }
    return sources;
  }

  /**
   * Compute the risk estimate.
   * @param {object} sources output of assembleInputs()
   */
  compute(sources) {
    const used = [];
    let logit = MODEL.intercept;

    for (const [feature, w] of Object.entries(MODEL.weights)) {
      const src = sources[feature];
      if (!src || src.value == null || Number.isNaN(Number(src.value))) continue;
      const value = Number(src.value);
      const { mean, sd } = MODEL.stats[feature];
      const z = (value - mean) / sd;
      const contribution = w * z;
      logit += contribution;
      used.push({ feature, value, z, weight: w, contribution, overridden: !!src.overridden });
    }

    const probability = 1 / (1 + Math.exp(-logit));
    const totalFeatures = Object.keys(MODEL.weights).length;
    const completeness = used.length / totalFeatures;

    const band = bandFor(probability);
    const factors = used
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .map((f) => ({
        feature: f.feature,
        label: MODEL.labels[f.feature],
        value: f.value,
        unit: MODEL.units[f.feature] ?? null,
        directionOfInputVsTypical: f.z > 0.25 ? 'above_typical' : f.z < -0.25 ? 'below_typical' : 'near_typical',
        effectOnEstimate: f.contribution > 0.02 ? 'raises' : f.contribution < -0.02 ? 'lowers' : 'neutral',
        contribution: Number(f.contribution.toFixed(3)),
        overridden: f.overridden,
      }));

    const missing = Object.keys(MODEL.weights)
      .filter((k) => !used.some((u) => u.feature === k))
      .map((k) => ({ feature: k, label: MODEL.labels[k] }));

    const scenarioApplied = used.some((u) => u.overridden);

    return {
      model: {
        id: MODEL.id,
        version: MODEL.version,
        kind: 'transparent-logistic (prototype, hand-specified coefficients)',
      },
      probability: Number(probability.toFixed(4)),
      percent: Math.round(probability * 1000) / 10,
      band,
      completeness: Number(completeness.toFixed(2)),
      confidenceNote:
        completeness < 0.5
          ? 'Very low data completeness — this estimate is highly uncertain.'
          : completeness < 0.75
            ? 'Moderate data completeness — estimate has meaningful uncertainty.'
            : 'Good data completeness for a prototype estimate.',
      contributingFactors: factors,
      missingInputs: missing,
      scenarioApplied,
      scenarioNote: scenarioApplied
        ? 'What-if scenario: one or more inputs were manually simulated. ' +
          'This is a scenario projection — a direction of travel, not a promised outcome.'
        : null,
      generatedAt: new Date().toISOString(),
      disclaimer: DISCLAIMER,
    };
  }

  /** Full pipeline: assemble from member data and compute. */
  assess(member, overrides = {}) {
    const sources = this.assembleInputs(member, overrides);
    return { inputs: Object.fromEntries(
        Object.entries(sources).map(([k, v]) => [k, { value: v.value, overridden: v.overridden }]),
      ),
      result: this.compute(sources) };
  }
}

export function bandFor(p) {
  if (p < 0.15) return 'low';
  if (p < 0.35) return 'moderate';
  if (p < 0.6) return 'elevated';
  return 'high';
}

export const RISK_DISCLAIMER = DISCLAIMER;
