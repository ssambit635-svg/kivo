/**
 * Curated clinical mappings — the HUMAN-REVIEWED half of the knowledge base.
 *
 * The generated half (see `scripts/knowledge/build.js`) comes from vendored
 * upstream data (MIMIC-IV lab item ↔ LOINC mappings, MIT-LCP/mimic-code).
 * This file is where a human still owns the decisions, because these are the
 * decisions that carry medical-safety consequences:
 *
 *   1. LOINC_ANCHORS   — which upstream lab items fold into an EXISTING
 *                        MedTwin marker code (identity resolution).
 *   2. PANEL_RULES     — how markers group into report panels.
 *   3. LABEL_BLOCKLIST — upstream labels that are NOT analytes (flag columns,
 *                        specimen metadata, free-text fields).
 *   4. UNIT_EQUIVALENCES — unit spellings + the mass↔molar conversion factors
 *                        used for normalization. Standard chemistry constants.
 *   5. PLAUSIBILITY_BOUNDS — PHYSICAL plausibility guards, never clinical
 *                        reference ranges: a value outside these bounds cannot
 *                        be a real measurement of that analyte in a human, so a
 *                        reading outside them is almost certainly a misread
 *                        (OCR) or a data-entry error. Upstream applies the same
 *                        kind of filter inside its concept queries.
 *
 * HARD RULE enforced by the build and by tests: nothing in this pipeline ever
 * INVENTED a clinical reference range for a generated marker. Upstream hospital
 * item mappings do not carry reference intervals, so generated markers ship
 * with `typicalRange: null` and the product keeps using the range printed on
 * the user's OWN report (which the product already prefers everywhere).
 */

/** Identity resolution: upstream LOINC/label → existing MedTwin marker code. */
export const LOINC_ANCHORS = {
  hba1c: {
    loinc: ['4548-4', '17856-6'],
    labels: [/^%?\s*hemoglobin\s*a1c$/i, /glycated hemoglobin/i],
    note: 'HbA1c is reported as a ratio in the upstream vocabulary; both codes map to the same marker.',
  },
  hemoglobin: { loinc: ['718-7'], labels: [/^absolute hemoglobin$/i, /^hemoglobin$/i] },
  total_cholesterol: { loinc: ['2093-3'] },
  hdl: { loinc: ['2085-9'] },
  ldl: {
    loinc: ['13457-7', '18262-6'],
    note: 'Calculated and directly measured LDL are the same marker to a report reader; both fold here.',
  },
  triglycerides: { loinc: ['2571-8'] },
  creatinine: { loinc: ['2160-0'] },
  egfr: {
    loinc: ['77147-7', '76633-7', '33914-3', '48642-3', '48643-1', '98979-8'],
    labels: [/estimated gfr/i, /^egfr/i, /mdrdgfr$/i],
    note: 'Several estimating equations exist; all are reported as "eGFR" on consumer reports.',
  },
  tsh: { loinc: ['3016-3'] },
  vitamin_d: { loinc: ['1989-3', '62292-8'] },
  vitamin_b12: { loinc: ['2132-9'] },
  alt: { loinc: ['1742-6'] },
  ast: { loinc: ['1920-8'] },
  platelets: { loinc: ['777-3'] },
  wbc: { loinc: ['6690-2'] },
  // fasting_glucose / random_glucose deliberately have NO anchor: the upstream
  // hospital vocabulary has no fasting-specified glucose item, so anchoring
  // them would be a guess. Generic serum glucose is published as its own
  // generated marker instead (`glucose_serum`, LOINC 2345-7).
};

/**
 * Extra aliases for curated codes — reordered/qualified forms real reports use.
 * Kept here (not invented by the build) because each one is a claim about what
 * a printed label means.
 */
export const CURATED_EXTRA_ALIASES = {
  fasting_glucose: ['glucose fasting', 'glucose, fasting', 'fasting sugar', 'sugar fasting', 'fbs fasting'],
  random_glucose: ['glucose random', 'glucose, random', 'random sugar'],
  hba1c: ['hba1c', 'hemoglobin a1c', 'glycated hemoglobin', 'glycosylated hemoglobin'],
  hemoglobin: ['haemoglobin', 'hb'],
  total_cholesterol: ['cholesterol, total', 'total cholesterol'],
  hdl: ['hdl cholesterol', 'cholesterol hdl', 'hdl-c'],
  ldl: ['ldl cholesterol', 'cholesterol ldl', 'ldl-c'],
  tsh: ['thyroid stimulating hormone', 'thyrotropin', 't3 tsh t4'],
  vitamin_d: ['vitamin d3', '25-hydroxy vitamin d', '25 oh vitamin d'],
  vitamin_b12: ['cobalamin', 'serum b12', 'vit b12'],
  alt: ['sgpt', 'alanine transaminase'],
  ast: ['sgot', 'aspartate transaminase'],
  platelets: ['platelet count', 'platelets', 'plt'],
  wbc: ['tlc', 'total leucocyte count', 'white blood cell count', 'total wbc count'],
  creatinine: ['serum creatinine', 's creatinine', 'creat'],
};

/**
 * Aliases a human wants added to SPECIFIC generated markers, keyed by generated
 * code. Needed because the build's automatic alias rules reject very short
 * aliases (they are risky in general), while a few two-character report labels
 * are unambiguous in this document class — "T3"/"T4" on a lab report are the
 * thyroid hormones, and "CD4"/"CD8" are the lymphocyte subsets.
 */
export const GENERATED_ALIAS_ADDITIONS = {
  triiodothyronine: ['t3', 'total t3', 't3 total'],
  thyroxine: ['t4', 'total t4', 't4 total'],
  thyroxine_free: ['ft4', 'free t4', 'ft3 free t4'],
  reverse_t3: ['rt3', 'reverse t3'],
  cd4_cells_percent: ['cd4', 'cd4 percent', 'cd4 percentage'],
  cd8_cells_percent: ['cd8', 'cd8 percent', 'cd8 percentage'],
  cd4_cd8_ratio: ['cd4 cd8 ratio', 'cd4/cd8'],
  calculated_thyroxine_index: ['fti', 'free thyroxine index'],
  rheumatoid_factor: ['rf', 'ra factor'],
  anti_nuclear_antibody: ['ana', 'ana screen'],
  prostate_specific_antigen: ['psa', 'total psa'],
  creatine_kinase_mb_isoenzyme: ['ck mb', 'ck-mb', 'ckmb'],
  creatine_kinase: ['cpk', 'ck total'],
  lactate_dehydrogenase: ['ldh', 'ld', 'ldh total'],
  alkaline_phosphatase: ['alp', 'alk phos'],
  gamma_glutamyltransferase: ['ggt', 'gamma gt', 'ggtp'],
  ntprobnp: ['nt probnp', 'nt-probnp'],
  parathyroid_hormone: ['pth', 'intact pth'],
  iron_binding_capacity_total: ['tibc', 'iron binding capacity'],
  transferrin_saturation: ['tsat', 'transferrin sat'],
  uric_acid: ['ua'],
  c_reactive_protein: ['crp', 'hs crp', 'hs-crp'],
  sedimentation_rate: ['esr', 'esr westergren'],
  free_thyroxine_index: ['fti'],
  protein_creatinine_ratio_urine: ['upcr', 'urine pcr'],
  albumin_creatinine_urine: ['uacr', 'microalbumin creatinine ratio'],
};

/**
 * Non-analyte labels: flag columns, specimen metadata and free-text fields that
 * appear in the upstream item table but must never become extractable markers.
 * (Upstream item ids for these are real; they are simply not measurements.)
 */
export const LABEL_BLOCKLIST = [
  /^(h|l|i|u|n|y|na|n\/a)$/i, // flag / placeholder columns
  /comment/i,
  /specimen type/i,
  /hold\b/i,
  /smear/i,
  /clumps?/i,
  /receiving/i,
  /accession/i,
  /^report/i,
  /free text/i,
  /surgical/i,
  /culture/i,
  /^other$/i,
  /test name/i,
  /units?$/i, // labels that are just a unit column header
];

/**
 * Upstream unit spellings that are placeholders rather than units.
 * `U` in particular is an unmapped default, not "units".
 */
export const UNIT_PLACEHOLDER_BLOCKLIST = [/^u$/i, /^none$/i, /^null$/i, /^unknown$/i];

/**
 * Marker → report panel. This is a standard clinical grouping (the same panels
 * any lab report prints). Rules are evaluated in order; the first match wins.
 * Facts (which analyzer measures what) are taxonomy, so we author them here
 * rather than shipping any third-party UI copy.
 */
export const PANEL_RULES = [
  { panel: 'thyroid', test: /thyroid|thyrotropin|\btsh\b|\bt3\b|\bt4\b|thyroxine|triiodothyronine/i },
  { panel: 'lipid', test: /cholesterol|\bhdl\b|\bldl\b|triglycerid|\bapob\b|lipoprotein/i },
  { panel: 'liver', test: /bilirubin|\balt\b|\bast\b|aminotransferase|alkaline phosphatase|\bggt\b|gamma glutamyl|albumin|globulin|total protein|prothrombin|\binr\b|\bpt\b|\bptt\b/i },
  { panel: 'kidney', test: /\burea\b|urea nitrogen|\bbun\b|creatinine|\begfr\b|\bgfr\b|cystatin|glomerular|uric acid|microalbumin/i },
  { panel: 'electrolytes', test: /\bsodium\b|\bpotassium\b|\bchloride\b|bicarbonate|carbon dioxide|\bco2\b|\bcalcium\b|magnesium|phosphate|phosphorus|anion gap|\bph\b|base excess|\bpco2\b|\bpo2\b|\blactate\b/i },
  { panel: 'inflammation', test: /c-reactive|\bcrp\b|procalcitonin|erythrocyte sedimentation|\besr\b|ferritin|interleukin|fibrinogen|d-dimer/i },
  { panel: 'vitamins', test: /vitamin|folate|cobalamin|\bb12\b|\biron\b|transferrin|binding capacity/i },
  { panel: 'cardiac', test: /troponin|creatine kinase|\bck\b|\bckmb\b|\bck-mb\b|natriuretic|\bbnp\b/i },
  { panel: 'diabetes', test: /glucose|glycated|\bhba1c\b|\binsulin\b|\bc-peptide\b|fructosamine/i },
  { panel: 'coagulation', test: /\binr\b|prothrombin|\bptt\b|\baptt\b|fibrinogen|bleeding time|thrombin/i },
  { panel: 'immunology', test: /antibody|antibodies|immunoglobulin|\bana\b|anti-|rheumatoid|complement|\bc3\b|\bc4\b/i },
  { panel: 'hormones', test: /\bcortisol\b|testosterone|estradiol|progesterone|\blh\b|\bfsh\b|prolactin|parathyroid|\bpth\b|growth hormone/i },
  { panel: 'tumor_markers', test: /tumou?r marker|\bca-?125\b|\bca-?19\b|\bca-?15\b|\bca-?27\b|\bcea\b|\bpsa\b|\bafp\b|beta hcg/i },
  { panel: 'urinalysis', test: /\burine\b|urinalysis|specific gravity|\burobilinogen\b|\bketones?\b|\bnitrite\b|leukocyte esterase/i },
  { panel: 'therapeutic_drugs', test: /acetaminophen|vancomycin|digoxin|lithium|phenytoin|valproate|carbamazepine|gentamicin|tacrolimus|salicylate/i },
];

/** Panels that are part of a standard blood count / differential. */
export const HEMATOLOGY_PANEL = 'cbc';
export const HEMATOLOGY_RULES = [
  { panel: 'cbc_differential', test: /neutrophil|lymphocyte|monocyte|eosinophil|basophil|band|blast|granulocyte|\bnrbc\b/i },
  { panel: 'cbc', test: /hemoglobin|haematocrit|hematocrit|\brbc\b|red blood cell|\bmcv\b|\bmch\b|\bmchc\b|\brdw\b|platelet|\bwbc\b|white blood cell|mean platelet/i },
];

/** Human-facing panel metadata (order = display order on a report view). */
export const PANELS = [
  { key: 'cbc', name: 'Complete Blood Count', order: 1, icon: 'droplet' },
  { key: 'cbc_differential', name: 'Blood Differential', order: 2, icon: 'shield' },
  { key: 'diabetes', name: 'Diabetes', order: 3, icon: 'activity' },
  { key: 'lipid', name: 'Lipid Profile', order: 4, icon: 'heart' },
  { key: 'liver', name: 'Liver Function', order: 5, icon: 'beaker' },
  { key: 'kidney', name: 'Kidney Function', order: 6, icon: 'filter' },
  { key: 'electrolytes', name: 'Electrolytes & Blood Gas', order: 7, icon: 'zap' },
  { key: 'thyroid', name: 'Thyroid Function', order: 8, icon: 'gauge' },
  { key: 'vitamins', name: 'Vitamins & Minerals', order: 9, icon: 'sun' },
  { key: 'inflammation', name: 'Inflammation & Iron', order: 10, icon: 'flame' },
  { key: 'cardiac', name: 'Cardiac Markers', order: 11, icon: 'heart-pulse' },
  { key: 'coagulation', name: 'Coagulation', order: 12, icon: 'clock' },
  { key: 'hormones', name: 'Hormones', order: 13, icon: 'gauge' },
  { key: 'immunology', name: 'Immunology', order: 14, icon: 'shield' },
  { key: 'tumor_markers', name: 'Tumour Markers', order: 15, icon: 'target' },
  { key: 'therapeutic_drugs', name: 'Drug Levels', order: 16, icon: 'pill' },
  { key: 'urinalysis', name: 'Urinalysis', order: 17, icon: 'flask' },
  { key: 'other', name: 'Other', order: 18, icon: 'beaker' },
];

/**
 * Unit spellings the extractor should recognize, mapped to a canonical
 * spelling. Sourced from the vendored upstream unit column plus standard lab
 * report conventions; the OCR-side character set that motivated the symbol
 * entries is vendored from xuewenyuan/OCR-for-Medical-Laboratory-Reports.
 */
export const UNIT_EQUIVALENCES = {
  // mass / volume
  'mg/dl': 'mg/dL', 'mg / dl': 'mg/dL', 'mgdl': 'mg/dL',
  'g/dl': 'g/dL', 'gm/dl': 'g/dL', 'g/dl.': 'g/dL',
  'g/l': 'g/L',
  'mg/l': 'mg/L',
  'ng/ml': 'ng/mL', 'ng/ml.': 'ng/mL',
  'pg/ml': 'pg/mL',
  'ug/ml': 'µg/mL', 'mcg/ml': 'µg/mL', 'µg/ml': 'µg/mL',
  'ug/dl': 'µg/dL', 'mcg/dl': 'µg/dL', 'µg/dl': 'µg/dL',
  'ng/l': 'ng/L',
  'mg/24hr': 'mg/24h', 'mg/24h': 'mg/24h',
  // molar
  'mmol/l': 'mmol/L', 'm mol/l': 'mmol/L',
  'umol/l': 'µmol/L', 'µmol/l': 'µmol/L', 'mcmol/l': 'µmol/L',
  'nmol/l': 'nmol/L',
  'pmol/l': 'pmol/L',
  'mol/l': 'mol/L',
  'mmol/mol': 'mmol/mol',
  // activity
  'u/l': 'U/L', 'iu/l': 'IU/L', 'uiu/ml': 'µIU/mL', 'µiu/ml': 'µIU/mL',
  'uu/ml': 'µIU/mL', 'uiu/ml': 'µIU/mL', 'miu/l': 'mIU/L', 'miu/ml': 'mIU/mL',
  'u/ml': 'U/mL', 'iu/ml': 'IU/mL',
  // counts
  'k/ul': '10^3/µL', '10^3/ul': '10^3/µL', '10*3/ul': '10^3/µL', 'x10^3/ul': '10^3/µL',
  'cells/ul': 'cells/µL', '/ul': '/µL',
  'x10^9/l': '10^9/L', '10^9/l': '10^9/L', 'g/l (10^9)': '10^9/L',
  'm/ul': '10^6/µL', '10^6/ul': '10^6/µL', 'x10^6/ul': '10^6/µL',
  'mil/ul': '10^6/µL',
  '10^3/µl': '10^3/µL',
  // proportions & derived
  '%': '%', 'percent': '%',
  'fl': 'fL', 'pg': 'pg', 'fmol/l': 'fmol/L',
  'meq/l': 'mEq/L', 'mmol/kg': 'mmol/kg',
  'ratio': 'ratio', 'index': 'index',
  'sec': 'sec', 'seconds': 'sec',
  'mm hg': 'mm Hg', 'mmhg': 'mm Hg',
  'ml/min/1.73m2': 'mL/min/1.73m²', 'ml/min/1.73m²': 'mL/min/1.73m²',
  'ml/min': 'mL/min', 'ml/min/1.73': 'mL/min/1.73m²',
  'miu/ml': 'mIU/mL',
  'iuu/ml': 'µIU/mL', 'iuu/ml.': 'µIU/mL',
  'us': 'µs', 'um': 'µm',
};

/**
 * Mass ↔ molar conversion factors → canonical (first) unit of the pair.
 * Standard clinical-chemistry constants; used for unit NORMALIZATION only
 * (never to change a value the user verified without recording the conversion).
 */
export const UNIT_CONVERSIONS = [
  { code: 'glucose', from: 'mg/dL', to: 'mmol/L', factor: 0.0555 },
  { code: 'total_cholesterol', from: 'mg/dL', to: 'mmol/L', factor: 0.02586 },
  { code: 'hdl', from: 'mg/dL', to: 'mmol/L', factor: 0.02586 },
  { code: 'ldl', from: 'mg/dL', to: 'mmol/L', factor: 0.02586 },
  { code: 'triglycerides', from: 'mg/dL', to: 'mmol/L', factor: 0.01129 },
  { code: 'creatinine', from: 'mg/dL', to: 'µmol/L', factor: 88.4 },
  { code: 'bilirubin_total', from: 'mg/dL', to: 'µmol/L', factor: 17.1 },
  { code: 'calcium_total', from: 'mg/dL', to: 'mmol/L', factor: 0.25 },
  { code: 'urea_nitrogen', from: 'mg/dL', to: 'mmol/L', factor: 0.357 },
  { code: 'hemoglobin', from: 'g/dL', to: 'g/L', factor: 10 },
  { code: 'albumin', from: 'g/dL', to: 'g/L', factor: 10 },
  { code: 'platelets', from: '10^3/µL', to: '10^9/L', factor: 1 },
  { code: 'wbc', from: '10^3/µL', to: '10^9/L', factor: 1 },
];

/**
 * PHYSICAL plausibility bounds (min exclusive / max inclusive where noted).
 *
 * These are NOT reference ranges. A value outside these bounds is not a
 * plausible human measurement of that analyte, which makes it a strong
 * "this reading is probably wrong" signal — the extraction pipeline flags it
 * for review instead of silently storing it. Upstream applies the same idea
 * (validity filters inside its concept queries); the specific numbers below
 * are conservative extremes authored for this prototype.
 */
export const PLAUSIBILITY_BOUNDS = {
  hba1c: { min: 1.5, max: 25, note: 'Reported as % of total hemoglobin' },
  fasting_glucose: { min: 10, max: 1500 },
  random_glucose: { min: 10, max: 1500 },
  total_cholesterol: { min: 30, max: 1500 },
  hdl: { min: 1, max: 200 },
  ldl: { min: 5, max: 1200 },
  triglycerides: { min: 10, max: 10000 },
  hemoglobin: { min: 1, max: 25 },
  creatinine: { min: 0.05, max: 50 },
  egfr: { min: 1, max: 250 },
  tsh: { min: 0.001, max: 1000 },
  vitamin_d: { min: 1, max: 400 },
  vitamin_b12: { min: 20, max: 20000 },
  alt: { min: 0.1, max: 20000 },
  ast: { min: 0.1, max: 20000 },
  platelets: { min: 1, max: 3000 },
  wbc: { min: 0.01, max: 500 },
};

/** Panels whose values are proportions of a whole — used for sanity messaging. */
export const PROPORTION_UNITS = ['%'];
