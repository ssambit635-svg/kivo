import { knowledgeStats, panels, ocrLexicon, loadClinicalKnowledge } from './clinicalKnowledge.js';
import { calibrationInfo } from './calibration.js';
import { aliasEntries, LAB_DICTIONARY } from '../services/labs/labDictionary.js';

/**
 * Read-only description of the clinical knowledge base for
 * `GET /api/meta/knowledge`.
 *
 * It is public because it contains no user data at all: it answers "which
 * markers does this app know, where did that knowledge come from, and how was
 * the extraction confidence calibrated?" — the transparency a health tool owes
 * its users. The safety notice travels with it.
 */
export function knowledgeReport() {
  const stats = knowledgeStats();
  const knowledge = loadClinicalKnowledge();
  const aliases = aliasEntries();
  const calibration = calibrationInfo();

  const markers = Object.values(LAB_DICTIONARY).filter(Boolean);
  const withLoinc = markers.filter((m) => m.loinc).length;
  const core = markers.filter((m) => m.tier === 'core').length;
  const curatedNarratives = markers.filter((m) => m.narrativeStatus === 'curated').length;

  return {
    stats: {
      ...stats,
      dictionaryMarkers: markers.length,
      matchableAliases: aliases.length,
      coreMarkers: core,
      withLoinc,
      loincCoverage: Number((withLoinc / Math.max(1, markers.length)).toFixed(4)),
      curatedNarratives,
      panels: Object.keys(panels()).length,
      qualitativeExcludedFromExtraction: markers.filter((m) => m.valueKind === 'qualitative').length,
    },
    sources: knowledge.sources,
    sourcesNote:
      'Upstream mapping tables are vendored at pinned commits from MIT-licensed repositories. ' +
      'No patient records are used or redistributed: the MIMIC-IV database itself requires credentialed ' +
      'PhysioNet access and is NOT part of this project.',
    panels: panels(),
    ocrLexicon: {
      source: ocrLexicon().source,
      charsetSize: ocrLexicon().charsetSize,
      confusionClasses: ocrLexicon().confusionClasses.length,
      flagGlyphs: ocrLexicon().flagGlyphs,
      unitSpellings: Object.keys(knowledge.unitEquivalences || {}).length,
    },
    calibration: {
      active: calibration.active,
      corpus: calibration.corpus,
      trainedAt: calibration.trainedAt,
      intendedUse: calibration.intendedUse,
      limitations: calibration.limitations,
      // Held-out scores from the shipped model card (Brier/ECE/AUC + sample
      // size) so any surface can quote the real number for this build.
      metrics: calibration.metrics || { heldOut: null },
    },
    rangePolicy:
      'Comparison is always against the reference range printed on the user\'s own report. Only the ' +
      'hand-curated markers carry a prototype typical range; generated markers are report-only, and ' +
      'plausibility bounds are physical limits used to flag a suspected misread, never clinical ranges.',
    disclaimer: 'Informational only — not a diagnosis and not a substitute for a qualified clinician.',
  };
}
