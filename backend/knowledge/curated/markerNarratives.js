/**
 * Patient-education narratives — authored for MedTwin AI.
 *
 * WHAT THIS IS: plain-language descriptions of what each marker measures, so a
 * report reader understands the row they are looking at. Written in-house for
 * this product (no third-party text is copied).
 *
 * WHAT THIS IS NOT (and must never become):
 *   - it never states or implies a diagnosis
 *   - it never claims a value is "normal/abnormal" on its own authority: the
 *     comparison that matters is against the reference range printed on the
 *     user's OWN report, which the runtime always prefers
 *   - it never invents prevalence, risk or outcome numbers
 *
 * Coverage rule (enforced by tests): every marker the knowledge base marks as
 * `tier: core` and that can be READ from a report has either a curated
 * narrative here or the structural fallback. A curated narrative is only used
 * for markers a human wrote one for — generated markers never inherit a
 * neighbour's text by guessing.
 *
 * `related` lists are used to suggest what to discuss together, not to imply
 * causality.
 */

/** Keyed by marker code (curated codes + generated slugs). */
export const MARKER_NARRATIVES = {
  // ---------- glycaemic ----------
  hba1c: {
    plain: 'HbA1c reflects average blood-sugar levels over roughly the past two to three months.',
    related: ['fasting_glucose', 'random_glucose'],
  },
  fasting_glucose: {
    plain: 'Fasting glucose measures blood sugar after at least eight hours without food.',
    related: ['hba1c'],
  },
  random_glucose: {
    plain: 'Random glucose measures blood sugar at whatever time the sample was taken, without a fasting requirement.',
    related: ['fasting_glucose', 'hba1c'],
  },
  glucose: {
    plain: 'This is a blood glucose (blood sugar) measurement, taken without an explicit fasting instruction.',
    related: ['hba1c', 'fasting_glucose'],
  },

  // ---------- lipids ----------
  total_cholesterol: {
    plain: 'Total cholesterol is the sum of the different cholesterol-carrying particles in blood; it is interpreted together with HDL, LDL and triglycerides.',
    related: ['hdl', 'ldl', 'triglycerides'],
  },
  hdl: {
    plain: 'HDL is the cholesterol carried by high-density lipoprotein particles — the fraction that helps move cholesterol back to the liver.',
    related: ['total_cholesterol', 'ldl', 'triglycerides'],
  },
  ldl: {
    plain: 'LDL is the cholesterol carried by low-density lipoprotein particles, the fraction most discussed when cholesterol is assessed.',
    related: ['total_cholesterol', 'hdl', 'triglycerides'],
  },
  triglycerides: {
    plain: 'Triglycerides are a form of blood fat strongly influenced by recent meals, alcohol and physical activity.',
    related: ['total_cholesterol', 'hdl'],
  },
  cholesterol_ratio: {
    plain: 'This is a computed ratio between total cholesterol and HDL cholesterol.',
    related: ['total_cholesterol', 'hdl'],
  },

  // ---------- kidney & electrolytes ----------
  creatinine: {
    plain: 'Creatinine is a muscle waste product cleared by the kidneys; it is one of the inputs used to estimate kidney filtration.',
    related: ['egfr', 'urea_nitrogen'],
  },
  egfr: {
    plain: 'eGFR (estimated glomerular filtration rate) is a calculated estimate of how well the kidneys filter blood, derived from creatinine and personal details such as age and sex.',
    related: ['creatinine', 'urea_nitrogen'],
  },
  urea_nitrogen: {
    plain: 'Urea nitrogen reflects the waste nitrogen your body produces and the kidneys clear; it also shifts with hydration and diet.',
    related: ['creatinine', 'egfr'],
  },
  uric_acid: {
    plain: 'Uric acid is a breakdown product of purines cleared by the kidneys.',
    related: ['creatinine'],
  },
  sodium: {
    plain: 'Sodium is the main salt in the fluid outside your cells; it reflects the balance of water and salt in the body.',
    related: ['potassium', 'chloride', 'bicarbonate'],
  },
  potassium: {
    plain: 'Potassium is the main salt inside your cells and is important for nerve and muscle function, including the heart rhythm.',
    related: ['sodium', 'chloride'],
  },
  chloride: {
    plain: 'Chloride is a salt that works alongside sodium in keeping fluid and acid balance.',
    related: ['sodium', 'bicarbonate'],
  },
  bicarbonate: {
    plain: 'Bicarbonate helps buffer the acidity of the blood; it is interpreted together with the blood gases.',
    related: ['anion_gap', 'chloride'],
  },
  calculated_total_co2: {
    plain: 'Total CO2 is a blood-gas measurement closely related to bicarbonate and the body’s acid–base balance.',
    related: ['bicarbonate'],
  },
  anion_gap: {
    plain: 'The anion gap is a calculated difference between measured salts; it helps interpret acid–base balance.',
    related: ['sodium', 'chloride', 'bicarbonate'],
  },
  calcium_total: {
    plain: 'Calcium is a mineral involved in bone, muscle and nerve function; the total form is measured with the proteins that carry it.',
    related: ['albumin', 'magnesium', 'phosphate'],
  },
  magnesium: {
    plain: 'Magnesium is a mineral involved in muscle, nerve and enzyme function.',
    related: ['calcium_total', 'potassium'],
  },
  phosphate: {
    plain: 'Phosphate is a mineral that works with calcium in bone and energy metabolism.',
    related: ['calcium_total'],
  },

  // ---------- liver & proteins ----------
  albumin: {
    plain: 'Albumin is the main protein the liver makes; it helps hold fluid in the blood vessels and carries many substances.',
    related: ['total_protein', 'globulin'],
  },
  globulin: {
    plain: 'Globulin is the group of blood proteins that includes antibodies and transport proteins.',
    related: ['albumin', 'total_protein'],
  },
  protein_total: {
    plain: 'Total protein sums the proteins in blood, mainly albumin and globulins.',
    related: ['albumin', 'globulin'],
  },
  bilirubin_total: {
    plain: 'Bilirubin is a yellow pigment produced when red blood cells are broken down; it is processed by the liver and cleared in bile.',
    related: ['bilirubin_direct', 'alt', 'ast'],
  },
  bilirubin_direct: {
    plain: 'Direct (conjugated) bilirubin is the form the liver has already processed.',
    related: ['bilirubin_total'],
  },
  alkaline_phosphatase: {
    plain: 'Alkaline phosphatase is an enzyme found mainly in liver and bone tissue.',
    related: ['alt', 'ast', 'ggt'],
  },
  alt: {
    plain: 'ALT (SGPT) is a liver enzyme; it is one of the routine markers of liver cell health.',
    related: ['ast', 'alkaline_phosphatase'],
  },
  ast: {
    plain: 'AST (SGOT) is an enzyme found in liver and muscle tissue.',
    related: ['alt', 'alkaline_phosphatase'],
  },
  gamma_glutamyltransferase: {
    plain: 'GGT (gamma-glutamyl transferase) is an enzyme used as another view of liver and bile-duct status.',
    related: ['alt', 'alkaline_phosphatase'],
  },
  lactate_dehydrogenase: {
    plain: 'Lactate dehydrogenase is an enzyme released by many tissues; it is non-specific and read alongside other results.',
    related: ['ast', 'alt'],
  },

  // ---------- complete blood count ----------
  hemoglobin: {
    plain: 'Hemoglobin is the oxygen-carrying protein inside red blood cells.',
    related: ['hematocrit', 'red_blood_cells', 'mcv'],
  },
  hematocrit: {
    plain: 'Hematocrit is the share of your blood volume made up of red blood cells.',
    related: ['hemoglobin', 'red_blood_cells'],
  },
  red_blood_cells: {
    plain: 'This counts the red blood cells that carry oxygen around the body.',
    related: ['hemoglobin', 'hematocrit'],
  },
  mcv: {
    plain: 'MCV describes the average size of your red blood cells.',
    related: ['mch', 'mchc', 'rdw'],
  },
  mch: {
    plain: 'MCH is the average amount of hemoglobin carried in each red blood cell.',
    related: ['mcv', 'mchc'],
  },
  mchc: {
    plain: 'MCHC is the concentration of hemoglobin inside a given volume of red blood cells.',
    related: ['mcv', 'mch'],
  },
  rdw: {
    plain: 'RDW describes how much the sizes of your red blood cells vary from one another.',
    related: ['mcv'],
  },
  rdw_sd: {
    plain: 'RDW-SD is the width of the red-cell size distribution, expressed directly in volume units.',
    related: ['rdw', 'mcv'],
  },
  wbc: {
    plain: 'White blood cells are the immune cells that respond to infection and inflammation.',
    related: ['neutrophils', 'lymphocytes'],
  },
  platelets: {
    plain: 'Platelets are the cell fragments that form the first plug when blood vessels are injured.',
    related: ['inr', 'pt'],
  },
  neutrophils: {
    plain: 'Neutrophils are the most common white blood cell type and act early against bacterial infection.',
    related: ['wbc', 'lymphocytes'],
  },
  lymphocytes: {
    plain: 'Lymphocytes are white blood cells central to immune memory and to fighting viral infection.',
    related: ['wbc', 'neutrophils'],
  },
  monocytes: {
    plain: 'Monocytes are white blood cells that clean up debris and help coordinate the immune response.',
    related: ['wbc'],
  },
  eosinophils: {
    plain: 'Eosinophils are white blood cells involved in allergic reactions and parasite defence.',
    related: ['wbc'],
  },
  basophils: {
    plain: 'Basophils are the least common white blood cell type and release histamine in allergic responses.',
    related: ['eosinophils', 'wbc'],
  },
  absolute_neutrophil_count: {
    plain: 'This is the absolute number (not the percentage) of neutrophils in the blood sample.',
    related: ['neutrophils', 'wbc'],
  },
  absolute_lymphocyte_count: {
    plain: 'This is the absolute number (not the percentage) of lymphocytes in the blood sample.',
    related: ['lymphocytes', 'wbc'],
  },
  immature_granulocytes: {
    plain: 'Immature granulocytes are young forms of the granular white blood cells that can appear when the marrow is responding to demand.',
    related: ['neutrophils', 'wbc'],
  },

  // ---------- clotting ----------
  inr: {
    plain: 'The INR is a standardized clotting time, used to describe how quickly blood clots.',
    related: ['pt', 'ptt'],
  },
  pt: {
    plain: 'Prothrombin time measures how long a plasma sample takes to clot through the extrinsic pathway.',
    related: ['inr_pt', 'ptt'],
  },
  ptt: {
    plain: 'PTT (aPTT) measures clotting through the intrinsic pathway and is read alongside the PT/INR.',
    related: ['inr_pt', 'pt'],
  },
  fibrinogen_functional: {
    plain: 'Fibrinogen is the clotting protein that is converted into fibrin to form a clot.',
    related: ['inr_pt', 'd_dimer'],
  },
  d_dimer: {
    plain: 'D-dimer is a fragment released when a blood clot is broken down.',
    related: ['fibrinogen'],
  },

  // ---------- inflammation & iron ----------
  c_reactive_protein: {
    plain: 'CRP (C-reactive protein) is a protein the liver produces in response to inflammation.',
    related: ['esr', 'wbc'],
  },
  sedimentation_rate: {
    plain: 'ESR (erythrocyte sedimentation rate) is a general, slow-reacting marker of inflammation.',
    related: ['c_reactive_protein'],
  },
  ferritin: {
    plain: 'Ferritin is the main iron-storage protein and the usual first look at the body’s iron stores.',
    related: ['iron', 'hemoglobin'],
  },
  iron: {
    plain: 'Serum iron measures the iron circulating in the blood at the time of the sample.',
    related: ['ferritin', 'transferrin'],
  },
  transferrin: {
    plain: 'Transferrin is the protein that transports iron; it is often reported with its saturation.',
    related: ['iron', 'ferritin'],
  },

  // ---------- vitamins & hormones ----------
  vitamin_d: {
    plain: 'Vitamin D (25-OH) is the storage form used to judge vitamin D status; it supports bone and muscle function.',
    related: ['calcium_total', 'phosphate'],
  },
  vitamin_b12: {
    plain: 'Vitamin B12 is needed for red blood cell formation and normal nerve function.',
    related: ['folate', 'hemoglobin'],
  },
  folate: {
    plain: 'Folate is a B vitamin involved in cell division and red blood cell production.',
    related: ['vitamin_b12'],
  },
  tsh: {
    plain: 'TSH is the pituitary hormone that tells the thyroid how much hormone to make; it is the usual first-line thyroid test.',
    related: ['free_t4', 'free_t3'],
  },
  thyroxine_free: {
    plain: 'Free T4 is the unbound, active portion of the main thyroid hormone in circulation.',
    related: ['tsh'],
  },
  triiodothyronine: {
    plain: 'Free T3 is the unbound form of the thyroid hormone that acts most directly on tissues.',
    related: ['tsh', 'free_t4'],
  },
  testosterone: {
    plain: 'Testosterone is the main sex hormone measured in both sexes, at very different typical concentrations.',
    related: [],
  },

  // ---------- cardiac & other chemistry ----------
  troponin_t: {
    plain: 'Troponin T is a heart-muscle protein released into blood when heart muscle is injured.',
    related: ['creatine_kinase_mb_isoenzyme'],
  },
  creatine_kinase_mb_isoenzyme: {
    plain: 'CK-MB is a muscle enzyme fraction historically used alongside troponin in cardiac assessment.',
    related: ['troponin_t'],
  },
  lactate: {
    plain: 'Lactate is produced when tissues metabolise without enough oxygen and is read together with the blood gases.',
    related: ['ph', 'bicarbonate'],
  },
  ph: {
    plain: 'pH describes the acidity of the blood sample.',
    related: ['pco2', 'bicarbonate'],
  },
  po2: {
    plain: 'pO2 is the partial pressure of oxygen in the blood sample.',
    related: ['pco2', 'ph'],
  },
  pco2: {
    plain: 'pCO2 is the partial pressure of carbon dioxide in the blood sample.',
    related: ['po2', 'bicarbonate'],
  },
  base_excess: {
    plain: 'Base excess is a calculated view of how much extra base or acid the blood contains.',
    related: ['bicarbonate', 'ph'],
  },
  amylase: {
    plain: 'Amylase is an enzyme produced mainly by the pancreas and salivary glands.',
    related: ['lipase'],
  },
  lipase: {
    plain: 'Lipase is a pancreatic enzyme; it is read alongside amylase.',
    related: ['amylase'],
  },

  // ---------- urine ----------
  specific_gravity_urine: {
    plain: 'Specific gravity describes how concentrated the urine is compared with water.',
    related: [],
  },
  ketone_urine: {
    plain: 'Ketones are acids produced when the body burns fat for energy instead of glucose.',
    related: ['glucose'],
  },
  nitrite_urine: {
    plain: 'Nitrite in urine can be produced by certain bacteria and is used as a screening clue.',
    related: ['leukocyte_esterase'],
  },
  urobilinogen_urine: {
    plain: 'Urobilinogen is formed from bilirubin processing and appears in urine in small amounts.',
    related: ['bilirubin_total'],
  },


  // ---------- additional core markers (top real-world panel coverage) ----------
  absolute_eosinophil_count: {
    plain: 'This is the absolute number (not the percentage) of eosinophils in the blood sample.',
    related: ['eosinophils', 'wbc'],
  },
  absolute_monocyte_count: {
    plain: 'This is the absolute number (not the percentage) of monocytes in the blood sample.',
    related: ['monocytes', 'wbc'],
  },
  absolute_basophil_count: {
    plain: 'This is the absolute number (not the percentage) of basophils in the blood sample.',
    related: ['basophils', 'wbc'],
  },
  bands: {
    plain: 'Band cells are immature neutrophils released early when the marrow is under demand.',
    related: ['neutrophils', 'immature_granulocytes'],
  },
  metamyelocytes: {
    plain: 'Metamyelocytes are maturing white-cell forms that are normally found in the marrow, not circulating blood.',
    related: ['neutrophils'],
  },
  myelocytes: {
    plain: 'Myelocytes are early white-cell forms usually confined to the bone marrow.',
    related: ['metamyelocytes'],
  },
  atypical_lymphocytes: {
    plain: 'Atypical (reactive) lymphocytes are lymphocytes that look activated, often during a viral illness.',
    related: ['lymphocytes'],
  },
  nucleated_red_cells: {
    plain: 'Nucleated red cells are immature red cells that still contain a nucleus; they are not normally seen in adults.',
    related: ['red_blood_cells', 'reticulocyte_count_automated'],
  },
  reticulocyte_count_automated: {
    plain: 'Reticulocytes are newly released red blood cells; counting them shows how actively the marrow is replacing red cells.',
    related: ['red_blood_cells', 'hemoglobin'],
  },
  reticulocyte_count_absolute: {
    plain: 'This is the absolute count of newly released (reticulocyte) red blood cells.',
    related: ['reticulocyte_count_automated'],
  },
  creatine_kinase: {
    plain: 'Creatine kinase is an enzyme released by muscle; it rises after muscle exertion or muscle injury.',
    related: ['creatine_kinase_mb_isoenzyme', 'ast'],
  },
  bilirubin_indirect: {
    plain: 'Indirect (unconjugated) bilirubin is the form not yet processed by the liver.',
    related: ['bilirubin_total', 'bilirubin_direct'],
  },
  bilirubin_neonatal: {
    plain: 'This bilirubin measurement comes from a newborn sample, where bilirubin is followed closely after birth.',
    related: ['bilirubin_total'],
  },
  protein_total: {
    plain: 'Total protein sums all the proteins measured in the sample, mainly albumin and globulins.',
    related: ['albumin', 'globulin'],
  },
  protein_urine: {
    plain: 'Urine protein measures protein leaking into urine; the result is often compared with a creatinine ratio.',
    related: ['protein_creatinine_ratio_urine', 'albumin'],
  },
  albumin_urine: {
    plain: 'Urine albumin measures a small protein that appears in urine; it is used as an early marker of kidney filter stress.',
    related: ['protein_urine', 'egfr'],
  },
  iron_binding_capacity_total: {
    plain: 'Total iron-binding capacity estimates how much iron the blood proteins can carry, and is read with serum iron and ferritin.',
    related: ['iron', 'ferritin', 'transferrin_saturation'],
  },
  transferrin_saturation: {
    plain: 'Transferrin saturation is the percentage of iron-carrying capacity that is currently filled.',
    related: ['iron', 'iron_binding_capacity_total'],
  },
  haptoglobin: {
    plain: 'Haptoglobin is a protein that binds free hemoglobin released from red blood cells.',
    related: ['hemoglobin', 'lactate_dehydrogenase'],
  },
  ntprobnp: {
    plain: 'NT-proBNP is a fragment released by heart muscle when it is stretched; it is used as a supportive cardiac marker.',
    related: ['troponin_t'],
  },
  troponin_i: {
    plain: 'Troponin I is a heart-muscle protein released into blood when heart muscle is injured.',
    related: ['troponin_t', 'creatine_kinase_mb_isoenzyme'],
  },
  parathyroid_hormone: {
    plain: 'Parathyroid hormone regulates calcium balance and is interpreted together with calcium and vitamin D.',
    related: ['calcium_total', 'vitamin_d', 'phosphate'],
  },
  osmolality_measured: {
    plain: 'Osmolality measures the concentration of dissolved particles in the sample.',
    related: ['sodium', 'glucose', 'urea_nitrogen'],
  },
  alpha_fetoprotein: {
    plain: 'Alpha-fetoprotein is a protein measured in blood and used as a marker in specific clinical situations, including pregnancy and liver assessment.',
    related: [],
  },
  carcinoembyronic_antigen: {
    plain: 'CEA is a protein used as a tumour marker in specific clinical settings; it is tracked over time by clinicians rather than interpreted alone.',
    related: [],
  },
  human_chorionic_gonadotropin: {
    plain: 'hCG is the hormone produced in pregnancy; it is also measured in other clinical situations.',
    related: [],
  },
  cd4_cells_percent: {
    plain: 'This is the percentage of T-helper (CD4) lymphocytes among lymphocytes.',
    related: ['cd8_cells_percent', 'lymphocytes'],
  },
  cd8_cells_percent: {
    plain: 'This is the percentage of T-suppressor/cytotoxic (CD8) lymphocytes among lymphocytes.',
    related: ['cd4_cells_percent'],
  },
  cd4_cd8_ratio: {
    plain: 'This ratio compares CD4 and CD8 lymphocyte populations.',
    related: ['cd4_cells_percent', 'cd8_cells_percent'],
  },
  immunoglobulin_g: {
    plain: 'IgG is the most abundant class of antibody in blood.',
    related: ['immunoglobulin_a', 'immunoglobulin_m'],
  },
  immunoglobulin_a: {
    plain: 'IgA is an antibody class that protects mucosal surfaces.',
    related: ['immunoglobulin_g'],
  },
  immunoglobulin_m: {
    plain: 'IgM is the antibody class produced early in an immune response.',
    related: ['immunoglobulin_g'],
  },
  immunoglobulin_e: {
    plain: 'IgE is the antibody class associated with allergic responses.',
    related: [],
  },
  vancomycin: {
    plain: 'This is a measured blood level of the antibiotic vancomycin, reported so that a clinician can keep the dose in the intended range.',
    related: [],
  },
  ethanol: {
    plain: 'This is a measured blood alcohol (ethanol) level.',
    related: [],
  },
  salicylate: {
    plain: 'This is a measured blood level of salicylate, the active form of aspirin.',
    related: [],
  },
  hiv_antibody: {
    plain: 'This is a screening test for antibodies related to HIV. Screening results are always interpreted by a clinician, usually with a confirmatory test.',
    related: [],
  },
  hepatitis_b_surface_antigen: {
    plain: 'This screening test looks for a surface protein of hepatitis B virus. Screening results are interpreted by a clinician with confirmatory testing.',
    related: [],
  },
  hepatitis_b_surface_antibody: {
    plain: 'This test looks for antibodies against hepatitis B surface protein, which can indicate immunity.',
    related: [],
  },
  hepatitis_c_virus_antibody: {
    plain: 'This is a screening test for antibodies related to hepatitis C virus; screening results are confirmed with a direct viral test.',
    related: [],
  },
  promyelocytes: {
    plain: 'Promyelocytes are early white-cell precursors that are normally confined to the bone marrow.',
    related: ['myelocytes', 'metamyelocytes'],
  },
  eag: {
    plain: 'Estimated average glucose converts an HbA1c value into the average blood sugar it corresponds to.',
    related: ['hba1c'],
  },
  thyroxine: {
    plain: 'T4 (thyroxine) is the main hormone the thyroid produces, mostly in an inactive carrier-bound form.',
    related: ['tsh', 'thyroxine_free'],
  },
  reverse_t3: {
    plain: 'Reverse T3 is an inactive form of the thyroid hormone T3.',
    related: ['triiodothyronine'],
  },
  specific_gravity_urine: {
    plain: 'Specific gravity describes how concentrated a fluid sample is compared with water.',
    related: [],
  },
  bilirubin_urine: {
    plain: 'This test looks for bilirubin appearing in urine.',
    related: ['bilirubin_total'],
  },
  uric_acid_urine: {
    plain: 'This is a urine uric-acid measurement, usually part of a stone or gout assessment.',
    related: ['uric_acid'],
  },

  // ---------- tumour markers / drugs (kept deliberately minimal) ----------
  prostate_specific_antigen: {
    plain: 'PSA is a protein produced by the prostate gland and measured in blood.',
    related: [],
  },
  acetaminophen: {
    plain: 'This row reports the measured blood level of paracetamol/acetaminophen, usually as a drug-level check.',
    related: [],
  },
};

/**
 * Structural fallback for markers without a curated narrative.
 *
 * It states only what is structurally true from the knowledge base — the
 * marker's own name, specimen, and the fact that the report's own reference
 * range is the comparison used. It deliberately makes NO claim about what the
 * analyte means physiologically, because the pipeline has no reviewed source
 * for that claim. This is the safety valve that lets the extractor cover
 * hundreds of real markers without inventing medical text.
 */
export function structuralNarrative({ name, specimen, panelName } = {}) {
  const specimenNote =
    specimen && specimen !== 'Blood' ? ` measured in ${String(specimen).toLowerCase()}` : ' measured in blood';
  const panelNote = panelName ? ` It is grouped under ${panelName} on this report.` : '';
  return (
    `${name || 'This marker'} is a laboratory measurement${specimenNote}.${panelNote} ` +
    'This app compares it with the reference range printed on your own report; if it stays outside that ' +
    'range across reports, that is a good thing to raise with a qualified healthcare professional.'
  );
}
