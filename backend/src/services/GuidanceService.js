import { ageFromDob } from '../utils/time.js';

const DISCLAIMER =
  'These notes are general health information generated from your recorded values only. They are not medical advice, ' +
  'not a diet plan, not a treatment recommendation, and they do not replace professional dietary or medical guidance. ' +
  'Please discuss any change with a qualified healthcare professional or dietitian.';

/**
 * Personalized diet & lifestyle guidance (§10.3 of the product spec).
 *
 * Deterministic and rule-based, grounded ONLY in verified labs + observations:
 * every item carries `why` (the exact recorded inputs that triggered it) and
 * `inputs` (the values). The service can only emit general-information notes
 * from fixed templates — it cannot invent a diet plan, prescribe anything, or
 * make treatment claims. No extreme diets exist in the template set.
 */
export class GuidanceService {
  constructor({ labResultRepository, observationRepository, trendService, policyService, llmGateway }) {
    this.labs = labResultRepository;
    this.observations = observationRepository;
    this.trends = trendService;
    this.policy = policyService;
    this.llm = llmGateway;
  }

  async forMember(actor, memberId) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertRead(actor, member);

    const latest = (code) => {
      try {
        return this.labs.latestForMember(memberId, code);
      } catch {
        return null;
      }
    };
    const latestObs = (kind) => {
      try {
        return this.observations.latestOfKind(memberId, kind);
      } catch {
        return null;
      }
    };

    const hba1c = latest('hba1c');
    const glucose = latest('fasting_glucose');
    const ldl = latest('ldl');
    const hdl = latest('hdl');
    const trig = latest('triglycerides');
    const weightObs = latestObs('weight');
    const bpObs = latestObs('bp');
    const activityObs = latestObs('activity');
    const sleepObs = latestObs('sleep');

    const weightKg = num(weightObs?.data?.weightKg);
    const heightCm = num(member.height_cm ?? member.heightCm);
    const bmi = weightKg != null && heightCm != null && heightCm >= 30 && heightCm <= 280
      ? weightKg / (heightCm / 100) ** 2
      : null;
    const minutes = num(activityObs?.data?.minutesPerWeek);
    const sleepHours = num(sleepObs?.data?.hours);
    const systolic = num(bpObs?.data?.systolic);
    const age = member.dob ? ageFromDob(member.dob) : null;

    const items = [];
    const push = (key, area, title, body, why, inputs) => {
      items.push({ key, area, title, body, why, inputs, generalInformationOnly: true });
    };

    // --- movement -----------------------------------------------------------
    if (minutes != null && minutes < 60) {
      push(
        'movement-low',
        'activity',
        'Everyday movement',
        'Adults are commonly encouraged to build up toward regular moderate activity across the week (for example brisk walking), increasing gradually and resting when unwell. If you have a health condition, check what fits you with a qualified professional first.',
        `Recorded activity is ${minutes} min/week, below the commonly cited 150 min/week reference.`,
        [{ label: 'Activity', value: minutes, unit: 'min/week' }],
      );
    } else if (minutes != null && minutes >= 150) {
      push(
        'movement-steady',
        'activity',
        'Activity looks consistent',
        'Your recorded activity meets the commonly cited weekly reference. Keeping a routine you enjoy — and rest days — is what usually sustains it.',
        `Recorded activity is ${minutes} min/week.`,
        [{ label: 'Activity', value: minutes, unit: 'min/week' }],
      );
    }

    // --- sleep ----------------------------------------------------------------
    if (sleepHours != null && sleepHours < 6) {
      push(
        'sleep-short',
        'sleep',
        'Short sleep pattern',
        'Short sleep is often discussed alongside consistent bedtimes, morning light, and evening screen/caffeine habits. Persistent poor sleep is worth raising with a qualified professional.',
        `Latest recorded sleep is ${sleepHours} h.`,
        [{ label: 'Sleep', value: sleepHours, unit: 'h' }],
      );
    }

    // --- weight context ---------------------------------------------------------
    if (bmi != null && bmi >= 30) {
      push(
        'weight-context',
        'nutrition',
        'Weight and balanced eating',
        'General guidance usually centers on regular meals built around vegetables, whole grains and protein sources, and on discussing a personal plan with a doctor or dietitian. Crash or extreme diets are not recommended.',
        `BMI from recorded weight/height is ${bmi.toFixed(1)}.`,
        [{ label: 'BMI', value: Number(bmi.toFixed(1)), unit: 'kg/m²' }],
      );
    }

    // --- glucose context ----------------------------------------------------------
    const glucoseFlag = outOfRange(hba1c) === 'high' || outOfRange(glucose) === 'high';
    if (glucoseFlag) {
      const which = [hba1c && outOfRange(hba1c) === 'high' ? label(hba1c) : null, glucose && outOfRange(glucose) === 'high' ? label(glucose) : null]
        .filter(Boolean)
        .join(' and ');
      push(
        'glucose-context',
        'nutrition',
        'Blood-sugar related values',
        'When sugar-related values run high, clinicians commonly discuss regular meal timing, sugary drinks, and follow-up testing. This note cannot interpret your values — please review them with your doctor.',
        `${which} is above its reference range.`,
        [hba1c, glucose].filter(Boolean).map((r) => ({ label: r.test_name, value: r.value, unit: r.unit })),
      );
    }

    // --- lipids ---------------------------------------------------------------------
    const lipidFlag = outOfRange(ldl) === 'high' || outOfRange(trig) === 'high';
    if (lipidFlag) {
      push(
        'lipid-context',
        'nutrition',
        'Cholesterol-related values',
        'Heart-healthy eating patterns are commonly discussed when lipid values run high — for example vegetables, legumes, whole grains and fewer fried or heavily processed foods. What applies to you is a question for your doctor.',
        `${[ldl, trig].filter((r) => r && outOfRange(r) === 'high').map(label).join(' and ')} is above its reference range.`,
        [ldl, trig].filter(Boolean).map((r) => ({ label: r.test_name, value: r.value, unit: r.unit })),
      );
    }
    if (hdl && outOfRange(hdl) === 'low') {
      push(
        'hdl-context',
        'activity',
        'HDL (protective-direction lipid)',
        'HDL is the lipid clinicians usually like to see higher; regular movement is one of the habits commonly discussed alongside it. Your doctor can say whether yours needs attention.',
        `${label(hdl)} is below its reference range.`,
        [{ label: hdl.test_name, value: hdl.value, unit: hdl.unit }],
      );
    }

    // --- blood pressure ------------------------------------------------------------
    if (systolic != null && systolic >= 140) {
      push(
        'bp-context',
        'lifestyle',
        'Blood-pressure reading',
        'A high reading is worth re-checking with correct cuff technique and discussing with a qualified professional, especially if it repeats. General habits often discussed include regular movement, sleep, and salty or processed foods.',
        `Latest recorded systolic pressure is ${systolic} mmHg.`,
        [{ label: 'Systolic BP', value: systolic, unit: 'mmHg' }],
      );
    }

    // --- empty / steady states ----------------------------------------------------------
    if (items.length === 0) {
      const hasAnyData = [hba1c, glucose, ldl, hdl, trig, weightObs, bpObs, activityObs, sleepObs].some(Boolean);
      push(
        hasAnyData ? 'steady-state' : 'no-data-yet',
        'general',
        hasAnyData ? 'Nothing standing out right now' : 'Not enough information yet',
        hasAnyData
          ? 'Your recorded values show no strong trigger for a specific note. Keeping up regular check-ups is what usually keeps this picture current.'
          : 'Add a verified report or a few observations (weight, activity, sleep) and this section will personalize from your own recorded values.',
        hasAnyData ? 'Recorded values sit broadly within their reference ranges.' : 'No verified labs or relevant observations are recorded yet.',
        [],
      );
    }

    // Data context the UI can show next to the notes.
    const context = {
      age,
      bmi: bmi != null && Number.isFinite(bmi) ? Number(bmi.toFixed(1)) : null,
      activityMinPerWeek: minutes,
      sleepHours,
      latestLabs: [hba1c, glucose, ldl, hdl, trig].filter(Boolean).map((r) => ({
        code: r.code, name: r.test_name, value: r.value, unit: r.unit, status: outOfRange(r),
      })),
    };

    let narrative;
    try {
      narrative = await this.llm.narrate('lifestyle_guidance', { memberName: member.name, items });
    } catch {
      narrative = {
        text: `General lifestyle notes for ${member.name}: ${items.length} note(s) based on recorded values. Automatic narration is temporarily unavailable.`,
        provider: 'fallback',
        deterministic: true,
        grounding: { valuesFrom: 'structured-validated-input' },
      };
    }

    return {
      memberId,
      generatedAt: new Date().toISOString(),
      context,
      items,
      narrative,
      generalInformationOnly: true,
      disclaimer: DISCLAIMER,
    };
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 'high' | 'low' | null using the row's stored report range, else the dictionary default via status. */
function outOfRange(row) {
  if (!row || row.value == null) return null;
  try {
    if (typeof row.statusFromStoredRange === 'function') {
      const s = row.statusFromStoredRange();
      return s === 'high' || s === 'low' ? s : null;
    }
    if (row.ref_high != null && row.value > row.ref_high) return 'high';
    if (row.ref_low != null && row.value < row.ref_low) return 'low';
    return null;
  } catch {
    return null;
  }
}

function label(row) {
  return `${row.test_name} (${row.value}${row.unit ? ` ${row.unit}` : ''})`;
}
