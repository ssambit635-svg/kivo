/**
 * The hand-authored prototype marker set.
 *
 * Kept in its own module with NO knowledge-base import: the knowledge build
 * (`scripts/knowledge/build.js`) reads this file to fold upstream lab items into
 * these codes, and the merged runtime dictionary (`labDictionary.js`) reads the
 * build artifact. Splitting them is what keeps that dependency one-directional —
 * otherwise the build would be reading the artifact it is about to overwrite.
 */

/** Curated prototype markers — the product's original, hand-authored set. */
export const CURATED_LAB_DICTIONARY = {
  hba1c: {
    name: 'HbA1c (Glycated Hemoglobin)',
    aliases: ['hba1c', 'hb a1c', 'hemoglobin a1c', 'glycated hemoglobin', 'glycated haemoglobin', 'glycosylated hemoglobin', 'a1c', 'ghb'],
    defaultUnit: '%',
    units: ['%', 'mmol/mol'],
    typicalRange: { low: 4.0, high: 5.6, unit: '%', note: 'Typical non-diabetic adult reference; lab ranges vary' },
    betterDirection: 'lower',
  },
  fasting_glucose: {
    name: 'Fasting Blood Glucose',
    aliases: ['fasting glucose', 'fasting blood sugar', 'fasting blood glucose', 'fbs', 'fbg', 'fasting plasma glucose', 'glucose fasting', 'blood sugar fasting', 'sugar fasting'],
    defaultUnit: 'mg/dL',
    units: ['mg/dl', 'mmol/l'],
    typicalRange: { low: 70, high: 99, unit: 'mg/dL', note: 'Typical adult fasting reference; lab ranges vary' },
    betterDirection: 'lower',
  },
  random_glucose: {
    name: 'Random Blood Glucose',
    aliases: ['random glucose', 'random blood sugar', 'rbs', 'casual glucose', 'random blood glucose'],
    defaultUnit: 'mg/dL',
    units: ['mg/dl', 'mmol/l'],
    typicalRange: { low: 70, high: 140, unit: 'mg/dL' },
    betterDirection: 'lower',
  },
  total_cholesterol: {
    name: 'Total Cholesterol',
    aliases: ['total cholesterol', 'cholesterol total', 'serum cholesterol', 't cholesterol', 'cholesterol'],
    defaultUnit: 'mg/dL',
    units: ['mg/dl', 'mmol/l'],
    typicalRange: { low: null, high: 200, unit: 'mg/dL', note: 'Desirable level; combined with other lipids for context' },
    betterDirection: 'lower',
  },
  hdl: {
    name: 'HDL Cholesterol',
    aliases: ['hdl', 'hdl cholesterol', 'hdl-c', 'high density lipoprotein', 'hdl chol'],
    defaultUnit: 'mg/dL',
    units: ['mg/dl', 'mmol/l'],
    typicalRange: { low: 40, high: null, unit: 'mg/dL', note: 'Higher is generally protective' },
    betterDirection: 'higher',
  },
  ldl: {
    name: 'LDL Cholesterol',
    aliases: ['ldl', 'ldl cholesterol', 'ldl-c', 'low density lipoprotein', 'ldl chol', 'calculated ldl'],
    defaultUnit: 'mg/dL',
    units: ['mg/dl', 'mmol/l'],
    typicalRange: { low: null, high: 100, unit: 'mg/dL', note: 'Optimal level; targets depend on personal risk' },
    betterDirection: 'lower',
  },
  triglycerides: {
    name: 'Triglycerides',
    aliases: ['triglycerides', 'triglyceride', 'tgl', 'tg', 'trigs'],
    defaultUnit: 'mg/dL',
    units: ['mg/dl', 'mmol/l'],
    typicalRange: { low: null, high: 150, unit: 'mg/dL' },
    betterDirection: 'lower',
  },
  hemoglobin: {
    name: 'Hemoglobin',
    aliases: ['hemoglobin', 'haemoglobin', 'hgb', 'hb'],
    defaultUnit: 'g/dL',
    units: ['g/dl', 'g/l'],
    typicalRange: { low: 12.0, high: 17.0, unit: 'g/dL', note: 'Broad adult span; sex-specific norms differ' },
    betterDirection: null,
  },
  creatinine: {
    name: 'Serum Creatinine',
    aliases: ['creatinine', 'serum creatinine', 's creatinine', 'creat'],
    defaultUnit: 'mg/dL',
    units: ['mg/dl', 'umol/l'],
    typicalRange: { low: 0.6, high: 1.3, unit: 'mg/dL' },
    betterDirection: null,
  },
  egfr: {
    name: 'eGFR',
    aliases: ['egfr', 'e gfr', 'estimated gfr', 'glomerular filtration rate'],
    defaultUnit: 'mL/min/1.73m2',
    units: ['ml/min', 'ml/min/1.73m2'],
    typicalRange: { low: 90, high: null, unit: 'mL/min/1.73m2', note: 'Higher broadly reflects better kidney filtration' },
    betterDirection: 'higher',
  },
  tsh: {
    name: 'TSH (Thyroid Stimulating Hormone)',
    aliases: ['tsh', 'thyroid stimulating hormone', 'thyrotropin'],
    defaultUnit: 'µIU/mL',
    units: ['uiu/ml', 'µiu/ml', 'miu/l'],
    typicalRange: { low: 0.4, high: 4.0, unit: 'µIU/mL' },
    betterDirection: null,
  },
  vitamin_d: {
    name: 'Vitamin D (25-OH)',
    aliases: ['vitamin d', '25-oh vitamin d', '25 hydroxy vitamin d', 'vit d', '25 ohd', '25(oh)d', 'total 25-oh vitamin d'],
    defaultUnit: 'ng/mL',
    units: ['ng/ml', 'nmol/l'],
    typicalRange: { low: 30, high: null, unit: 'ng/mL', note: 'Sufficiency threshold commonly cited' },
    betterDirection: 'higher',
  },
  vitamin_b12: {
    name: 'Vitamin B12',
    aliases: ['vitamin b12', 'vit b12', 'b12', 'cyanocobalamin'],
    defaultUnit: 'pg/mL',
    units: ['pg/ml', 'pmol/l'],
    typicalRange: { low: 200, high: null, unit: 'pg/mL' },
    betterDirection: null,
  },
  alt: {
    name: 'ALT (SGPT)',
    aliases: ['alt', 'sgpt', 'alanine aminotransferase', 'alanine transaminase'],
    defaultUnit: 'U/L',
    units: ['u/l', 'iu/l'],
    typicalRange: { low: null, high: 41, unit: 'U/L' },
    betterDirection: null,
  },
  ast: {
    name: 'AST (SGOT)',
    aliases: ['ast', 'sgot', 'aspartate aminotransferase', 'aspartate transaminase'],
    defaultUnit: 'U/L',
    units: ['u/l', 'iu/l'],
    typicalRange: { low: null, high: 40, unit: 'U/L' },
    betterDirection: null,
  },
  platelets: {
    name: 'Platelet Count',
    aliases: ['platelet count', 'platelets', 'plt'],
    defaultUnit: '10^3/µL',
    units: ['10^3/ul', 'k/ul', '×10^3/µl'],
    typicalRange: { low: 150, high: 410, unit: '10^3/µL' },
    betterDirection: null,
  },
  wbc: {
    name: 'White Blood Cell Count',
    aliases: ['wbc', 'white blood cell', 'total wbc', 'total wbc count', 'tlc', 'total leucocyte count', 'leucocytes'],
    defaultUnit: '10^3/µL',
    units: ['10^3/ul', 'k/ul', 'cumm'],
    typicalRange: { low: 4.0, high: 11.0, unit: '10^3/µL' },
    betterDirection: null,
  },
  sgot_to_alt_alias_guard: null, // reserved — avoids accidental 'ast/sgot' alias collisions in matching
};

/** Codes that carry hand-authored ranges/aliases — they always win. */
export const CURATED_CODES = new Set(Object.keys(CURATED_LAB_DICTIONARY).filter((k) => CURATED_LAB_DICTIONARY[k]));
