import { ValidationError } from '../../common/errors.js';
import { SignalCollector } from './signalSeries.js';

/**
 * Counterfactual Health Twin (intelligence ADD-ON, capability #4 + #5).
 *
 * Builds a COPY of the member's current structured health state (the real
 * data is never modified), applies hypothetical changes, and re-runs the
 * EXISTING transparent risk model against the hypothetical state. No new
 * clinical predictions are invented: fields the prototype model does not
 * use are reported as context-only, with no model effect computed.
 *
 * Every output is labelled as a model-based scenario projection — never a
 * prediction, recommendation, or promised outcome.
 */

export const SCENARIO_LABELS = [
  'Model-based scenario projection',
  'Not a prediction',
  'Not a treatment recommendation',
  'Not a guaranteed outcome',
];

export const COUNTERFACTUAL_DISCLAIMER =
  'Counterfactual results re-run the existing transparent prototype model on hypothetical ' +
  'inputs. They show how the MODEL score responds to changed numbers — not what would happen ' +
  'to a person, not a treatment recommendation, and not a guaranteed outcome. The underlying ' +
  'model is a prototype and has not been clinically validated.';

// Plausible prototype boundaries for hypothetical inputs. Anything outside
// is rejected as an impossible scenario rather than silently clamped.
export const SCENARIO_BOUNDS = {
  weightKg: { min: 30, max: 250, label: 'Weight', unit: 'kg' },
  activityMinutesPerWeek: { min: 0, max: 1500, label: 'Physical activity', unit: 'min/week' },
  sleepHours: { min: 0, max: 16, label: 'Sleep duration', unit: 'hours' },
  systolicBp: { min: 70, max: 260, label: 'Systolic blood pressure', unit: 'mmHg' },
  diastolicBp: { min: 40, max: 160, label: 'Diastolic blood pressure', unit: 'mmHg' },
  hba1c: { min: 3.5, max: 16, label: 'HbA1c', unit: '%' },
  fastingGlucose: { min: 40, max: 500, label: 'Fasting glucose', unit: 'mg/dL' },
  hdl: { min: 10, max: 150, label: 'HDL cholesterol', unit: 'mg/dL' },
  triglycerides: { min: 30, max: 1200, label: 'Triglycerides', unit: 'mg/dL' },
  ldl: { min: 20, max: 400, label: 'LDL cholesterol', unit: 'mg/dL' },
  totalCholesterol: { min: 80, max: 600, label: 'Total cholesterol', unit: 'mg/dL' },
};

// Preset explorer candidates (deltas applied to the real snapshot).
const EXPLORER_PRESETS = [
  { id: 'weight_minus_2', label: 'Weight −2 kg (hypothetical)', changes: { weightKg: -2 }, factors: ['weight'] },
  { id: 'weight_minus_5', label: 'Weight −5 kg (hypothetical)', changes: { weightKg: -5 }, factors: ['weight'] },
  { id: 'activity_plus_60', label: 'Activity +60 min/week (hypothetical)', changes: { activityMinutesPerWeek: 60 }, factors: ['activity'] },
  { id: 'activity_plus_120', label: 'Activity +120 min/week (hypothetical)', changes: { activityMinutesPerWeek: 120 }, factors: ['activity'] },
  { id: 'weight_minus_2_activity_plus_60', label: 'Weight −2 kg + activity +60 min/week (hypothetical)', changes: { weightKg: -2, activityMinutesPerWeek: 60 }, factors: ['weight', 'activity'] },
  { id: 'weight_minus_5_activity_plus_120', label: 'Weight −5 kg + activity +120 min/week (hypothetical)', changes: { weightKg: -5, activityMinutesPerWeek: 120 }, factors: ['weight', 'activity'] },
];

export class CounterfactualTwinService {
  constructor({ labResultRepository, observationRepository, riskModelService }) {
    this.labs = labResultRepository;
    this.observations = observationRepository;
    this.risk = riskModelService;
    this.collector = new SignalCollector({ labResultRepository, observationRepository });
  }

  /**
   * Snapshot of the CURRENT structured state. Pure read — the object is a
   * detached copy; mutating it can never touch stored data.
   */
  snapshot(member) {
    const latest = (code) => this.labs.latestForMember(member.id, code)?.value ?? null;
    const weight = this.observations.latestOfKind(member.id, 'weight')?.data?.weightKg ?? null;
    const bp = this.observations.latestOfKind(member.id, 'bp')?.data ?? {};
    const activity = this.observations.latestOfKind(member.id, 'activity')?.data?.minutesPerWeek ?? null;
    const sleep = this.observations.latestOfKind(member.id, 'sleep')?.data?.hours ?? null;
    const bmi = weight != null && member.height_cm ? Number((weight / (member.height_cm / 100) ** 2).toFixed(1)) : null;
    return {
      weightKg: weight,
      activityMinutesPerWeek: activity,
      sleepHours: sleep,
      systolicBp: bp.systolic ?? null,
      diastolicBp: bp.diastolic ?? null,
      bmi,
      heightCm: member.height_cm ?? null,
      hba1c: latest('hba1c'),
      fastingGlucose: latest('fasting_glucose'),
      hdl: latest('hdl'),
      triglycerides: latest('triglycerides'),
      ldl: latest('ldl'),
      totalCholesterol: latest('total_cholesterol'),
    };
  }

  /**
   * Run one hypothetical scenario. `changes` maps scenario fields to the
   * HYPOTHETICAL absolute values (not deltas).
   */
  simulate(member, changes, { label = 'Custom hypothetical scenario' } = {}) {
    const clean = this.validateChanges(changes);
    const baseline = this.snapshot(member);
    const scenario = { ...baseline };
    const changedFactors = [];
    const overrides = {};

    for (const [field, value] of Object.entries(clean)) {
      const from = baseline[field] ?? null;
      scenario[field] = value;
      const mapped = this.mapToModelOverride(member, baseline, scenario, field, value, from);
      Object.assign(overrides, mapped.overrides);
      changedFactors.push(mapped.factor);
    }

    // BMI follows hypothetical weight when height is known.
    if (clean.weightKg != null && member.height_cm) {
      scenario.bmi = Number((clean.weightKg / (member.height_cm / 100) ** 2).toFixed(1));
    }

    const modelBefore = this.risk.assess(member);
    const modelAfter = this.risk.assess(member, overrides);
    const contributionChanges = diffContributions(modelBefore.result, modelAfter.result);
    const uncertainty = this.uncertaintyFor(member, modelBefore.result, modelAfter.result, changedFactors);

    return {
      kind: 'counterfactual_twin',
      label,
      generatedAt: new Date().toISOString(),
      baseline,
      scenario,
      changedFactors,
      modelBefore,
      modelAfter,
      contributionChanges,
      uncertainty,
      labels: SCENARIO_LABELS,
      disclaimer: COUNTERFACTUAL_DISCLAIMER,
    };
  }

  /**
   * Model Scenario Explorer: several mathematically valid preset scenarios,
   * ranked ONLY by mathematical model effect (largest decrease in the model
   * score first) — never as recommendations.
   */
  explore(member, { maxScenarios = 6, factors = null } = {}) {
    const baseline = this.snapshot(member);
    const modelBefore = this.risk.assess(member);
    const scenarios = [];
    const skipped = [];

    const presets = EXPLORER_PRESETS.filter(
      (p) => !factors || p.factors.every((f) => factors.includes(f)),
    ).slice(0, Math.min(Math.max(maxScenarios, 1), 6));

    for (const preset of presets) {
      // Translate deltas to absolute hypothetical values.
      const absolute = {};
      let feasible = true;
      let reason = null;
      for (const [field, delta] of Object.entries(preset.changes)) {
        const base = field === 'weightKg' ? baseline.weightKg : baseline.activityMinutesPerWeek;
        if (base == null) {
          feasible = false;
          reason = `No recorded ${field === 'weightKg' ? 'weight' : 'activity'} value to vary from.`;
          break;
        }
        absolute[field] = Math.round((base + delta) * 10) / 10;
      }
      if (!feasible) {
        skipped.push({ id: preset.id, label: preset.label, reason });
        continue;
      }
      try {
        const sim = this.simulate(member, absolute, { label: preset.label });
        const deltaProb = sim.modelAfter.result.probability - sim.modelBefore.result.probability;
        scenarios.push({
          id: preset.id,
          label: preset.label,
          changes: absolute,
          modelAfter: {
            probability: sim.modelAfter.result.probability,
            percent: sim.modelAfter.result.percent,
            band: sim.modelAfter.result.band,
          },
          deltaProbability: Math.round(deltaProb * 10000) / 10000,
          deltaPercent: Math.round((sim.modelAfter.result.percent - sim.modelBefore.result.percent) * 10) / 10,
          topContributionChanges: sim.contributionChanges.slice(0, 3),
          uncertainty: sim.uncertainty,
        });
      } catch (err) {
        skipped.push({ id: preset.id, label: preset.label, reason: err.message });
      }
    }

    scenarios.sort((a, b) => a.deltaProbability - b.deltaProbability);
    scenarios.forEach((s, i) => { s.rank = i + 1; });

    return {
      kind: 'model_scenario_explorer',
      generatedAt: new Date().toISOString(),
      baseline,
      modelBefore: {
        probability: modelBefore.result.probability,
        percent: modelBefore.result.percent,
        band: modelBefore.result.band,
        completeness: modelBefore.result.completeness,
      },
      scenarios,
      skipped,
      rankingNote:
        'Scenarios are ranked ONLY by mathematical effect on the prototype model score ' +
        '(largest decrease first). A rank is not advice — it says which hypothetical numbers ' +
        'moved the model most, e.g. "in this hypothetical model scenario, changing X produced ' +
        'the largest change in the model score."',
      labels: SCENARIO_LABELS,
      disclaimer: COUNTERFACTUAL_DISCLAIMER,
    };
  }

  // ------------------------------------------------------------------ internals
  validateChanges(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new ValidationError('Scenario changes must be an object of field → hypothetical value.');
    }
    const keys = Object.keys(changes);
    if (keys.length === 0) {
      throw new ValidationError('Scenario must change at least one supported field.', {
        supportedFields: Object.keys(SCENARIO_BOUNDS),
      });
    }
    const clean = {};
    const violations = [];
    for (const [field, value] of keys.map((k) => [k, changes[k]])) {
      const bound = SCENARIO_BOUNDS[field];
      if (!bound) {
        violations.push({ field, message: `Unsupported scenario field '${field}'.`, supportedFields: Object.keys(SCENARIO_BOUNDS) });
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        violations.push({ field, message: `'${field}' must be a finite number (hypothetical absolute value).` });
        continue;
      }
      if (value < bound.min || value > bound.max) {
        violations.push({
          field,
          message: `'${field}' value ${value} is outside the plausible prototype range ${bound.min}–${bound.max}${bound.unit ? ` ${bound.unit}` : ''} — impossible scenario rejected.`,
        });
        continue;
      }
      clean[field] = value;
    }
    if (violations.length > 0) {
      throw new ValidationError('Impossible or unsupported scenario values rejected.', violations);
    }
    return clean;
  }

  /**
   * Map one scenario field to existing-model overrides + a changed-factor record.
   * Fields the prototype model does not consume are recorded as context-only.
   */
  mapToModelOverride(member, baseline, scenario, field, value, from) {
    const base = { field, label: SCENARIO_BOUNDS[field].label, unit: SCENARIO_BOUNDS[field].unit, from, to: value };
    switch (field) {
      case 'weightKg': {
        if (!member.height_cm) {
          return { overrides: {}, factor: { ...base, modelEffect: 'not_computable', note: 'Height is not recorded, so no hypothetical BMI can be derived — no model effect computed.' } };
        }
        const bmi = Number((value / (member.height_cm / 100) ** 2).toFixed(1));
        return { overrides: { bmi }, factor: { ...base, modelEffect: 'via_bmi', derivedBmi: bmi, note: `Mapped to hypothetical BMI ${bmi} (height ${member.height_cm} cm).` } };
      }
      case 'activityMinutesPerWeek': {
        const level = value < 60 ? 0 : value < 150 ? 1 : 2; // same bands as the risk model
        return { overrides: { activityLevel: level }, factor: { ...base, modelEffect: 'via_activity_level', derivedActivityLevel: level, note: `Mapped to activity band ${['sedentary', 'moderate', 'active'][level]} (same bands as the risk model).` } };
      }
      case 'systolicBp':
        return { overrides: { systolicBp: value }, factor: { ...base, modelEffect: 'direct', note: 'Used directly as the hypothetical model input.' } };
      case 'hba1c':
      case 'fastingGlucose':
      case 'hdl':
      case 'triglycerides':
        return { overrides: { [field]: value }, factor: { ...base, modelEffect: 'direct', note: 'Used directly as the hypothetical model input.' } };
      default:
        // sleepHours, diastolicBp, ldl, totalCholesterol: recorded, no model effect.
        return { overrides: {}, factor: { ...base, modelEffect: 'context_only', note: 'The prototype risk model does not consume this input — recorded for context; no model effect computed or invented.' } };
    }
  }

  uncertaintyFor(member, before, after, changedFactors) {
    const { signals } = this.collector.collect(member);
    const historyPoints = signals.reduce((s, x) => s + x.points.length, 0);
    const reasons = [
      `Model data completeness: ${Math.round(before.completeness * 100)}% before, ${Math.round(after.completeness * 100)}% after.`,
      `${historyPoints} recorded signal point(s) underpin the real-state snapshot.`,
      `${changedFactors.length} hypothetical input(s) changed: ${changedFactors.map((f) => f.label).join(', ') || 'none'}.`,
    ];
    const contextOnly = changedFactors.filter((f) => f.modelEffect === 'context_only' || f.modelEffect === 'not_computable');
    if (contextOnly.length > 0) {
      reasons.push(`${contextOnly.map((f) => f.label).join(', ')}: no model effect computed (not consumed by the prototype model).`);
    }
    const level = before.completeness >= 0.75 && historyPoints >= 5 ? 'moderate' : 'low';
    if (level === 'low') {
      reasons.push('Scenario projections inherit all uncertainty of the sparse real-state snapshot — treat deltas as rough model sensitivity, not forecasts.');
    } else {
      reasons.push('Scenario deltas are still model sensitivity only — hypothetical numbers in, model arithmetic out.');
    }
    return { level, historyPoints, completenessBefore: before.completeness, completenessAfter: after.completeness, reasons };
  }
}

function diffContributions(before, after) {
  const bMap = new Map(before.contributingFactors.map((f) => [f.feature, f]));
  const aMap = new Map(after.contributingFactors.map((f) => [f.feature, f]));
  const features = new Set([...bMap.keys(), ...aMap.keys()]);
  const out = [];
  for (const feature of features) {
    const b = bMap.get(feature);
    const a = aMap.get(feature);
    out.push({
      feature,
      label: (a || b).label,
      unit: (a || b).unit ?? null,
      contributionBefore: b ? b.contribution : 0,
      contributionAfter: a ? a.contribution : 0,
      delta: Math.round(((a ? a.contribution : 0) - (b ? b.contribution : 0)) * 1000) / 1000,
      valueBefore: b ? b.value : null,
      valueAfter: a ? a.value : null,
      overriddenAfter: a ? !!a.overridden : false,
    });
  }
  out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return out;
}
