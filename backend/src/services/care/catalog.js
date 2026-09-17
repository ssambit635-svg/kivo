/**
 * Doctor-facing catalogs and safety linters.
 *
 * Two things live here:
 *  1. SPECIALTIES — the controlled vocabulary behind a doctor's identity
 *     ("Dr Mohan Charan · Bone & joint specialist"), so the directory, the
 *     video topics and the search all speak the same language.
 *  2. CONTENT_LINT — the claim filter every short video must pass. Medical
 *     misinformation is the fastest way to lose a health product's credibility,
 *     so a video that promises a cure is rejected at upload time, not "flagged
 *     for review" later.
 */

export const SPECIALTIES = {
  general_physician: { label: 'General physician', blurb: 'Everyday illness, fever, infections, first opinions' },
  orthopaedics: { label: 'Bone & joint specialist', blurb: 'Knees, back, fractures, arthritis, sports injuries' },
  cardiology: { label: 'Heart specialist', blurb: 'BP, cholesterol, palpitations, heart risk' },
  endocrinology: { label: 'Diabetes & hormones', blurb: 'Sugar, thyroid, PCOS, hormones' },
  pulmonology: { label: 'Lungs & breathing', blurb: 'Asthma, cough, COPD, sleep apnoea' },
  gastroenterology: { label: 'Stomach & liver', blurb: 'Acidity, IBS, liver, digestion' },
  neurology: { label: 'Brain & nerves', blurb: 'Headache, migraine, fits, numbness' },
  nephrology: { label: 'Kidney specialist', blurb: 'Kidney function, stones, dialysis' },
  dermatology: { label: 'Skin & hair', blurb: 'Acne, rashes, hair fall, pigmentation' },
  gynaecology: { label: 'Women’s health', blurb: 'Periods, pregnancy, PCOS, fertility' },
  paediatrics: { label: 'Child specialist', blurb: 'Newborn to teens — growth, vaccines, infections' },
  psychiatry: { label: 'Mental health', blurb: 'Anxiety, sleep, mood, stress' },
  ent: { label: 'Ear, nose & throat', blurb: 'Sinus, hearing, tonsils, vertigo' },
  ophthalmology: { label: 'Eye specialist', blurb: 'Vision, cataract, screen strain' },
  dentistry: { label: 'Dental surgeon', blurb: 'Teeth, gums, alignment' },
  physiotherapy: { label: 'Physiotherapist', blurb: 'Rehab, posture, mobility, pain relief' },
  nutrition: { label: 'Nutrition & diet', blurb: 'Weight, diabetes diet, sports nutrition' },
  other: { label: 'Other specialty', blurb: 'Anything not covered above' },
};

export const SPECIALTY_KEYS = Object.keys(SPECIALTIES);

export function specialtyLabel(key) {
  return SPECIALTIES[key]?.label || SPECIALTIES.other.label;
}

/** "Bone & joint specialist" style headline, used when a doctor doesn't write one. */
export function defaultHeadline(specialtyKey) {
  return specialtyLabel(specialtyKey);
}

export const VIDEO_TOPIC_KEYS = [...SPECIALTY_KEYS];

/** Terms that turn education into a claim we are not allowed to make. */
export const BANNED_CLAIM_TERMS = [
  'cure',
  'cures',
  'cured',
  'guaranteed',
  'guarantee',
  '100%',
  'miracle',
  'permanent solution',
  'permanently cure',
  'stop taking your',
  'no need to visit',
  'no need to see a doctor',
  'never visit a doctor',
  'replaces your doctor',
  'instant cure',
];

/**
 * Claim lint for doctor content. Returns the offending terms (empty = clean).
 * Used by VideoService at create/update time.
 */
export function lintClaims(text) {
  const haystack = String(text || '').toLowerCase();
  return BANNED_CLAIM_TERMS.filter((term) => haystack.includes(term));
}

/**
 * Marker → "what a doctor might consider discussing" templates. This is the
 * DRAFT side of the medicine preview: it never states a diagnosis, never gives
 * a dose, never says "start X". It surfaces the class of therapy that is
 * commonly discussed for a value that is out of range, together with the
 * follow-up work needed before any prescription is written — and a human
 * doctor must edit/approve it before the patient ever sees it.
 */
export const MEDICINE_DRAFT_RULES = [
  {
    code: 'hba1c',
    severity: 'attention',
    trigger: (v) => v >= 6.5,
    label: 'Glycaemic control',
    suggestedClass: 'Antidiabetic therapy (biguanide class, or another class as clinically indicated)',
    exampleAgents: ['metformin'],
    rationale: 'HbA1c ≥ 6.5% on a verified report is in the range where glucose-lowering therapy is commonly discussed.',
    cautions: [
      'Confirm renal function (eGFR) before biguanide therapy.',
      'Review pregnancy/lactation status and hepatic function.',
      'Assess GI tolerance and current alcohol intake.',
    ],
    followUpCodes: ['creatinine', 'fasting_glucose', 'egfr'],
    reviewInDays: 90,
  },
  {
    code: 'fasting_glucose',
    severity: 'attention',
    trigger: (v) => v >= 126,
    label: 'Fasting glucose above range',
    suggestedClass: 'Antidiabetic therapy or intensified existing therapy',
    exampleAgents: ['metformin'],
    rationale: 'Verified fasting glucose ≥ 126 mg/dL repeated with a raised HbA1c usually changes diabetes management.',
    cautions: ['Confirm with a repeat fasting sample or HbA1c.', 'Check for symptoms of hyperglycaemia.'],
    followUpCodes: ['hba1c', 'creatinine'],
    reviewInDays: 90,
  },
  {
    code: 'ldl',
    severity: 'attention',
    trigger: (v) => v >= 130,
    label: 'LDL cholesterol above target',
    suggestedClass: 'Lipid-lowering therapy (statin class, or non-statin if not tolerated)',
    exampleAgents: ['atorvastatin', 'rosuvastatin'],
    rationale: 'LDL above target on a verified report is where lipid-lowering therapy is commonly considered, guided by overall cardiovascular risk.',
    cautions: [
      'Estimate 10-year cardiovascular risk before starting.',
      'Check liver enzymes and pregnancy status.',
      'Review interactions with current medicines (e.g. fibrates).',
    ],
    followUpCodes: ['total_cholesterol', 'hdl', 'triglycerides'],
    reviewInDays: 90,
  },
  {
    code: 'triglycerides',
    severity: 'attention',
    trigger: (v) => v >= 200,
    label: 'Triglycerides above range',
    suggestedClass: 'Lifestyle-first management; fibrate/omega-3 only if the doctor decides',
    exampleAgents: ['fenofibrate'],
    rationale: 'Verified triglycerides ≥ 200 mg/dL is usually managed with diet/alcohol/glucose control first.',
    cautions: ['Rule out secondary causes: uncontrolled diabetes, alcohol, hypothyroidism.', 'Check pancreatic risk if very high.'],
    followUpCodes: ['hba1c', 'tsh'],
    reviewInDays: 90,
  },
  {
    code: 'total_cholesterol',
    severity: 'info',
    trigger: (v) => v >= 240,
    label: 'Total cholesterol above range',
    suggestedClass: 'Lipid-lowering therapy — decide with LDL and risk profile',
    exampleAgents: ['atorvastatin'],
    rationale: 'Total cholesterol alone is a weak signal; the decision follows LDL and cardiovascular risk.',
    cautions: ['Use LDL and risk score, not total cholesterol alone.'],
    followUpCodes: ['ldl', 'hdl'],
    reviewInDays: 120,
  },
  {
    code: 'hemoglobin',
    severity: 'attention',
    trigger: (v) => v < 11,
    label: 'Low haemoglobin',
    suggestedClass: 'Iron studies first, then iron/haematinic therapy if deficiency is confirmed',
    exampleAgents: ['ferrous sulphate', 'folic acid'],
    rationale: 'Verified haemoglobin < 11 g/dL warrants a cause-first workup; haematinics follow the diagnosis.',
    cautions: [
      'Confirm the cause before supplementing (menstrual loss, GI bleed, nutrition).',
      'Do not start iron without iron studies in adults.',
    ],
    followUpCodes: ['mcv', 'ferritin'],
    reviewInDays: 30,
  },
  {
    code: 'tsh',
    severity: 'attention',
    trigger: (v) => v > 5.0,
    label: 'Thyroid-stimulating hormone above range',
    suggestedClass: 'Thyroid hormone replacement — dose decided by the treating doctor',
    exampleAgents: ['levothyroxine'],
    rationale: 'Raised TSH with low/normal T4 is the pattern where replacement therapy is commonly discussed.',
    cautions: [
      'Confirm with free T4 (and repeat TSH) before treating.',
      'Review cardiac status and pregnancy status; start low if elderly.',
    ],
    followUpCodes: ['free_t4', 'tsh'],
    reviewInDays: 45,
  },
  {
    code: 'creatinine',
    severity: 'info',
    trigger: (v) => v > 1.4,
    label: 'Creatinine above range',
    suggestedClass: 'No drug suggestion — nephrology review and medication dose audit',
    exampleAgents: [],
    rationale: 'Raised creatinine changes drug dosing decisions; this needs clinical review rather than a new prescription.',
    cautions: ['Audit every current medicine for renal dosing.', 'Check hydration, BP and urine analysis.'],
    followUpCodes: ['egfr', 'creatinine'],
    reviewInDays: 21,
  },
  {
    code: 'uric_acid',
    severity: 'info',
    trigger: (v) => v > 7.0,
    label: 'Uric acid above range',
    suggestedClass: 'Urate-lowering therapy — only with a confirmed diagnosis',
    exampleAgents: ['allopurinol', 'febuxostat'],
    rationale: 'Asymptomatic hyperuricaemia is often not treated; therapy follows the clinical picture.',
    cautions: ['Treat the patient, not the number.', 'Review renal function and interactions before urate-lowering therapy.'],
    followUpCodes: ['creatinine'],
    reviewInDays: 120,
  },
  {
    code: 'vitamin_d',
    severity: 'info',
    trigger: (v) => v < 20,
    label: 'Vitamin D below range',
    suggestedClass: 'Vitamin D supplementation',
    exampleAgents: ['cholecalciferol'],
    rationale: 'Verified deficiency is commonly corrected with replacement therapy.',
    cautions: ['Check calcium and renal function with high-dose regimens.'],
    followUpCodes: ['calcium'],
    reviewInDays: 90,
  },
  {
    code: 'vitamin_b12',
    severity: 'info',
    trigger: (v) => v < 200,
    label: 'Vitamin B12 below range',
    suggestedClass: 'B12 replacement (oral or injectable)',
    exampleAgents: ['methylcobalamin'],
    rationale: 'Verified B12 deficiency is treated with replacement, after finding the cause.',
    cautions: ['Look for the cause: diet, metformin, pernicious anaemia.'],
    followUpCodes: ['hemoglobin', 'mcv'],
    reviewInDays: 90,
  },
];

export const VIDEO_CLAIM_LINT_NOTE =
  'Every short is scanned for outcome claims (cure/guaranteed/miracle/…). Claim language is rejected at upload, ' +
  'so the library stays education and the doctor keeps their registration safe.';

export const MEDICINE_DRAFT_DISCLAIMER =
  'AI-generated DRAFT for doctor review only. Not a prescription, not a diagnosis and never shown to a patient ' +
  'before a registered doctor edits or approves it. Dose, titration and product choice are clinical decisions ' +
  'that require the full history, examination, allergies, interactions, renal/hepatic function and local guidelines.';

/** Guardrails re-checked when the doctor approves a plan. */
export const MEDICINE_ACKNOWLEDGEMENTS = [
  { key: 'allergies', label: 'I checked allergies and intolerances with the patient' },
  { key: 'interactions', label: 'I reviewed interactions with the current medication list' },
  { key: 'organ_function', label: 'I considered renal/hepatic function, pregnancy and age' },
  { key: 'dose_omitted', label: 'I will decide dose/frequency myself — the draft contains none' },
];
