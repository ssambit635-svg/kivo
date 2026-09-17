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
    const safeMember = member && typeof member === 'object' ? member : {};
    const memberId = safeMember.id ?? null;
    const latest = (code) => {
      try {
        return memberId ? this.labs.latestForMember(memberId, code) : null;
      } catch {
        return null;
      }
    };
    const latestObs = (kind) => {
      try {
        return memberId ? this.observations.latestOfKind(memberId, kind) : null;
      } catch {
        return null;
      }
    };
    const weightObs = latestObs('weight');
    const bpObs = latestObs('bp');
    const activityObs = latestObs('activity');

    const finiteOrNull = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const weightKg = finiteOrNull(weightObs?.data?.weightKg);
    const heightCm = finiteOrNull(safeMember.height_cm ?? safeMember.heightCm);
    let bmi = null;
    // Height must be a sane positive number — a zero/negative/NaN height must
    // never produce Infinity/NaN BMI (division guard).
    if (weightKg != null && weightKg > 0 && weightKg <= 500 && heightCm != null && heightCm >= 30 && heightCm <= 280) {
      const h = heightCm / 100;
      const raw = weightKg / (h * h);
      bmi = Number.isFinite(raw) ? Number(raw.toFixed(1)) : null;
    }

    let activityLevel = null;
    const minutes = finiteOrNull(activityObs?.data?.minutesPerWeek);
    if (minutes != null && minutes >= 0 && minutes <= 5000) {
      activityLevel = minutes < 60 ? 0 : minutes < 150 ? 1 : 2;
    }

    const familyHistory = safeMember.familyHistory && typeof safeMember.familyHistory === 'object'
      ? safeMember.familyHistory
      : {};

    const assembled = {
      age: safeMember.dob ? ageFromDob(safeMember.dob) : null,
      bmi,
      fastingGlucose: finiteOrNull(latest('fasting_glucose')?.value),
      hba1c: finiteOrNull(latest('hba1c')?.value),
      systolicBp: finiteOrNull(bpObs?.data?.systolic),
      hdl: finiteOrNull(latest('hdl')?.value),
      triglycerides: finiteOrNull(latest('triglycerides')?.value),
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
    const srcs = sources && typeof sources === 'object' ? sources : {};

    for (const [feature, w] of Object.entries(MODEL.weights)) {
      try {
        const src = srcs[feature];
        if (!src || src.value == null) continue;
        const value = Number(src.value);
        if (!Number.isFinite(value)) continue;
        const stat = MODEL.stats[feature] || {};
        const mean = Number(stat.mean);
        const sd = Number(stat.sd);
        // A zero/missing sd would divide by zero — skip the feature instead.
        if (!Number.isFinite(mean) || !Number.isFinite(sd) || sd === 0) continue;
        const z = (value - mean) / sd;
        if (!Number.isFinite(z)) continue;
        const contribution = w * z;
        if (!Number.isFinite(contribution)) continue;
        logit += contribution;
        used.push({ feature, value, z, weight: w, contribution, overridden: !!src.overridden });
      } catch {
        continue; // one bad feature never kills the estimate
      }
    }

    // Clamp the logit so Math.exp can never overflow to Infinity.
    if (!Number.isFinite(logit)) logit = MODEL.intercept;
    logit = Math.min(20, Math.max(-20, logit));
    let probability = 1 / (1 + Math.exp(-logit));
    if (!Number.isFinite(probability)) probability = 1 / (1 + Math.exp(-MODEL.intercept));
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
  const v = Number(p);
  // Non-finite input can never happen from compute(), but the guard keeps the
  // exported helper total for any future caller (fail toward the middle band).
  if (!Number.isFinite(v)) return 'moderate';
  if (v < 0.15) return 'low';
  if (v < 0.35) return 'moderate';
  if (v < 0.6) return 'elevated';
  return 'high';
}

export const RISK_DISCLAIMER = DISCLAIMER;
