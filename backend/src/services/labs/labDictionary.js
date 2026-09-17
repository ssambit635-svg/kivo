import { loadClinicalKnowledge } from '../../knowledge/clinicalKnowledge.js';

/**
 * Canonical laboratory marker dictionary used by extraction, reference
 * ranges, trends and the risk model.
 *
 * It has TWO layers:
 *
 *   1. CURATED_LAB_DICTIONARY (below) — the 17 markers this product's trends,
 *      risk model and demo were designed around. Their aliases and "typical
 *      adult range" values are hand-authored prototype defaults; when a report
 *      carries its own reference range, THAT range always wins.
 *
 *   2. Generated markers from the committed knowledge base
 *      (`knowledge/generated/clinicalKnowledge.json`, built by
 *      `npm run knowledge:build` from vendored MIT-licensed upstream data —
 *      see knowledge/README.md). This is where the ~1,100 additional real-world
 *      markers (CBC differential, electrolytes, liver/kidney panels, thyroid,
 *      vitamins, cardiac, coagulation, urinalysis …) come from.
 *
 * MEDICAL-SAFETY RULES that hold across both layers:
 *   - a generated marker NEVER has a `typicalRange`; upstream data contains no
 *     reference intervals, so inventing one would be fabricating clinical data.
 *     Those markers are `rangeSource: 'report-only'` — compared only against the
 *     range printed on the user's own report.
 *   - `plausibilityBounds` are PHYSICAL plausibility limits, never clinical
 *     ranges: they flag an implausible reading for review.
 *   - `valueKind: 'qualitative'` markers (morphology findings, screens) are
 *     catalogued but never matched by the numeric extractor.
 *   - a curated marker always wins: generated markers with a colliding code are
 *     dropped, and alias collisions were already resolved in the build with
 *     curated aliases seeded first.
 */

/** Re-exported for callers that want the curated layer explicitly. */
export { CURATED_LAB_DICTIONARY, CURATED_CODES } from './curatedLabDictionary.js';
import { CURATED_LAB_DICTIONARY, CURATED_CODES } from './curatedLabDictionary.js';

/**
 * Generated markers from the knowledge base, in dictionary shape.
 * Exported separately for tests that need to distinguish the two layers.
 */
export function generatedLabMarkers() {
  const out = {};
  for (const m of Object.values(loadClinicalKnowledge().markers)) {
    if (CURATED_CODES.has(m.code)) continue;
    out[m.code] = {
      name: m.name,
      // A marker the build marked non-extractable (qualitative finding, or only
      // ambiguous short aliases) stays catalogued for display but is offered
      // with NO aliases, so the numeric extractor can never match it.
      aliases: m.extractable === false ? [] : m.aliases,
      defaultUnit: m.defaultUnit,
      units: m.units ?? [],
      typicalRange: null, // INVARIANT: never fabricated for a generated marker
      betterDirection: null,
      loinc: m.loinc,
      panel: m.panel,
      specimen: m.specimen,
      tier: m.tier,
      valueKind: m.valueKind ?? 'numeric',
      rangeSource: m.rangeSource ?? 'report-only',
      prevalence: m.prevalence,
      plausibilityBounds: m.plausibilityBounds ?? null,
      narrative: m.narrative?.text ?? null,
      narrativeStatus: m.narrative?.status ?? 'structural',
      related: m.narrative?.related ?? [],
      provenance: m.provenance,
    };
  }
  return out;
}

/**
 * Curated entries win on the fields this product was designed around (aliases,
 * typical ranges, units), but they still carry the knowledge-base fields —
 * LOINC, panel, specimen, prevalence prior, plausibility bounds and the
 * patient-education narrative — so a core marker is documented as richly as a
 * generated one.
 */
function curatedLayerWithKnowledge() {
  const knowledge = loadClinicalKnowledge();
  const out = {};
  for (const [code, def] of Object.entries(CURATED_LAB_DICTIONARY)) {
    if (!def) continue;
    const m = knowledge.markers[code] ?? null;
    out[code] = {
      ...def,
      loinc: m?.loinc ?? null,
      panel: m?.panel ?? null,
      specimen: m?.specimen ?? 'Blood',
      tier: m?.tier ?? 'core',
      rangeSource: m?.rangeSource ?? (def.typicalRange ? 'curated-prototype' : 'report-only'),
      prevalence: m?.prevalence ?? null,
      plausibilityBounds: m?.plausibilityBounds ?? null,
      narrative: m?.narrative?.text ?? null,
      narrativeStatus: m?.narrative?.status ?? 'none',
      related: m?.narrative?.related ?? [],
      provenance: m?.provenance ?? 'curated',
    };
  }
  return out;
}

/**
 * The single dictionary every service reads. Curated entries are merged last so
 * a curated marker can never be shadowed by a generated one.
 */
export const LAB_DICTIONARY = Object.freeze({ ...generatedLabMarkers(), ...curatedLayerWithKnowledge() });

/** Sorted alias list (longest-first) so 'fasting glucose' beats 'glucose'. */
export function aliasEntries({ includeQualitative = false } = {}) {
  const entries = [];
  for (const [code, def] of Object.entries(LAB_DICTIONARY)) {
    if (!def) continue;
    if (!includeQualitative && def.valueKind === 'qualitative') continue;
    for (const alias of def.aliases) {
      entries.push({ code, alias, def });
    }
  }
  entries.sort((a, b) => b.alias.length - a.alias.length);
  return entries;
}

/** Marker codes the numeric extractor may emit. */
export function extractableCodes() {
  return new Set(
    Object.entries(LAB_DICTIONARY)
      .filter(([, def]) => def && def.valueKind !== 'qualitative')
      .map(([code]) => code),
  );
}
