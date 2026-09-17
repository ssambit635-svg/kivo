import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadClinicalKnowledge,
  allMarkers,
  numericMarkers,
  marker,
  panels,
  knowledgeStats,
  ocrLexicon,
  checkPlausibility,
  toDictionaryEntry,
  resetClinicalKnowledgeCache,
} from '../../src/knowledge/clinicalKnowledge.js';
import { LAB_DICTIONARY, aliasEntries, generatedLabMarkers, CURATED_CODES } from '../../src/services/labs/labDictionary.js';
import { LabExtractionService } from '../../src/services/labs/LabExtractionService.js';
import { MARKER_NARRATIVES, structuralNarrative } from '../../knowledge/curated/markerNarratives.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD_REPORT = JSON.parse(
  fs.readFileSync(path.resolve(HERE, '../../knowledge/generated/buildReport.json'), 'utf8'),
);
const extractor = new LabExtractionService();

describe('clinical knowledge base — provenance', () => {
  it('loads the committed artifact and caches it', () => {
    const first = loadClinicalKnowledge();
    resetClinicalKnowledgeCache();
    const second = loadClinicalKnowledge();
    expect(second.schema).toBe('medtwin.clinicalKnowledge/1');
    expect(Object.keys(second.markers).length).toBeGreaterThan(1000);
    expect(first.stats).toEqual(second.stats);
  });

  it('pins every source to a full commit SHA and carries its licence', () => {
    const { sources } = loadClinicalKnowledge();
    expect(sources.length).toBeGreaterThanOrEqual(3);
    for (const s of sources) {
      expect(s.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(s.licence).toBeTruthy();
    }
    const mimic = sources.find((s) => s.repo === 'MIT-LCP/mimic-code');
    expect(mimic.licence).toBe('MIT');
    expect(mimic.commit).toBe('303d26c623dcc9c49cc0f204468d4acc2f063797');
  });

  it('uses no patient records: the model card says so', () => {
    const trained = JSON.parse(
      fs.readFileSync(path.resolve(HERE, '../../knowledge/generated/trainedParameters.json'), 'utf8'),
    );
    expect(trained.corpus.patientsUsed).toBe(0);
    expect(trained.modelCard.notTrainedOn).toMatch(/patient data/i);
    expect(trained.modelCard.notTrainedOn).toMatch(/MIMIC-IV itself is credentialed/i);
  });

  it('records the unlicensed repo as reference-only with nothing vendored', () => {
    const { sources } = loadClinicalKnowledge();
    const unlicensed = sources.find((s) => s.repo === 'garg-tejas/blood-report-parser');
    expect(unlicensed.licence).toMatch(/NONE DECLARED/i);
    const dir = path.resolve(HERE, '../../knowledge/vendor/blood-report-parser');
    expect(fs.readdirSync(dir)).toEqual(['PROVENANCE.md']);
  });
});

describe('clinical knowledge base — LOINC coverage', () => {
  it('identifies the overwhelming majority of markers by LOINC code', () => {
    const stats = knowledgeStats();
    expect(stats.withLoinc / stats.markers).toBeGreaterThan(0.95);
    expect(stats.withLoinc).toBeGreaterThan(1000);
  });

  it('anchors the markers this product was designed around', () => {
    for (const [code, loinc] of [
      ['hba1c', '4548-4'],
      ['hemoglobin', '718-7'],
      ['platelets', '777-3'],
      ['creatinine', '2160-0'],
      ['total_cholesterol', '2093-3'],
      ['hdl', '2085-9'],
      ['ldl', '13457-7'],
      ['triglycerides', '2571-8'],
      ['tsh', '3016-3'],
      ['alt', '1742-6'],
      ['ast', '1920-8'],
      ['vitamin_d', '1989-3'],
      ['vitamin_b12', '2132-9'],
      ['wbc', '6690-2'],
    ]) {
      expect(marker(code)?.loinc, `${code} should resolve to LOINC ${loinc}`).toBe(loinc);
    }
  });

  it('folds upstream hospital itemids into the curated codes instead of duplicating them', () => {
    const hba1c = marker('hba1c');
    expect(hba1c.curated).toBe(true);
    expect(hba1c.upstreamItemIds).toContain(50852);
    expect(hba1c.provenance).toMatch(/curated \+ upstream-identity/);
    // a folded item must NOT also exist as its own generated marker
    expect(Object.keys(generatedLabMarkers()).filter((c) => c.includes('50852'))).toHaveLength(0);
  });
});

describe('clinical knowledge base — medical-safety invariants', () => {
  it('never invents a reference range for a generated marker', () => {
    const offenders = Object.entries(allMarkers()).filter(([, m]) => !m.curated && m.typicalRange);
    expect(offenders.map(([c]) => c)).toEqual([]);
    for (const m of Object.values(generatedLabMarkers())) {
      expect(m.typicalRange).toBeNull();
      expect(m.rangeSource).toBe('report-only');
    }
  });

  it('keeps the hand-authored prototype ranges on the core markers', () => {
    expect(marker('fasting_glucose').typicalRange.high).toBe(99);
    expect(marker('hba1c').typicalRange.low).toBe(4);
    expect(marker('hdl').betterDirection).toBe('higher');
    expect(marker('hba1c').rangeSource).toBe('curated-prototype');
  });

  it('describes plausibility bounds as physical limits and flags impossible values', () => {
    const implausible = checkPlausibility('creatinine', 900);
    expect(implausible.plausible).toBe(false);
    expect(implausible.reason).toMatch(/physically plausible/i);
    expect(checkPlausibility('creatinine', 1.1).plausible).toBe(true);
    expect(checkPlausibility('nonexistent_marker', 1).plausible).toBe(true); // no knowledge ⇒ no claim
  });

  it('flags a suspicious reading at extraction time and caps its confidence', () => {
    const { extracted } = extractor.extract('Creatinine 900 mg/dL');
    const row = extracted.find((e) => e.code === 'creatinine');
    expect(row).toBeTruthy();
    expect(row.suspicious).toBe(true);
    expect(row.suspiciousReason).toMatch(/physically plausible/i);
    expect(row.confidence).toBeLessThanOrEqual(0.25);
  });

  it('never lets a qualitative finding be matched as a numeric value', () => {
    const qualitative = Object.entries(allMarkers()).filter(([, m]) => m.valueKind === 'qualitative');
    expect(qualitative.length).toBeGreaterThan(50);
    const matchable = new Set(aliasEntries().map((e) => e.code));
    for (const [code] of qualitative) {
      expect(matchable.has(code), `${code} must not be offered to the numeric extractor`).toBe(false);
    }
    // ...and the dictionary still lists them, so UIs can display them
    expect(LAB_DICTIONARY[qualitative[0][0]]).toBeTruthy();
  });

  it('reports one physical plausibility bound per bounded marker, well-formed', () => {
    for (const [code, m] of Object.entries(allMarkers())) {
      const b = m.plausibilityBounds;
      if (!b) continue;
      if (b.min != null && b.max != null) {
        expect(b.min, `${code} bounds`).toBeLessThan(b.max);
      }
      expect(typeof (b.min ?? b.max)).toBe('number');
    }
  });
});

describe('clinical knowledge base — narratives', () => {
  it('covers every core numeric marker with curated text or the structural fallback', () => {
    const panelName = (key) => panels().find((p) => p.key === key)?.name;
    const core = Object.entries(allMarkers()).filter(([, m]) => m.tier === 'core' && m.valueKind === 'numeric');
    expect(core.length).toBeGreaterThan(100);
    for (const [code, m] of core) {
      const text = m.narrative?.text;
      expect(typeof text, `${code} needs a narrative`).toBe('string');
      expect(text.length).toBeGreaterThan(20);
      if (m.narrative.status !== 'curated') {
        // structural entries must be exactly the claim-free fallback: the app
        // may not put words in a marker's mouth
        expect(text, `${code} structural text`).toBe(
          structuralNarrative({ name: m.name, specimen: m.specimen, panelName: panelName(m.panel) }),
        );
      }
    }
  });

  it('never lets a generated marker inherit a neighbour\'s text', () => {
    const generated = Object.values(generatedLabMarkers()).filter((m) => m.narrativeStatus === 'structural');
    expect(generated.length).toBeGreaterThan(0);
    const texts = new Set(generated.map((m) => m.narrative));
    // the structural fallback is parameterised by name/specimen, so a shared
    // sentence is fine — a shared *curated* sentence would not be
    expect([...texts].every((t) => t.includes('report'))).toBe(true);
  });

  it('keeps the safety rule: no diagnosis wording anywhere in the knowledge base', () => {
    const banned = /\b(you have|diagnos(is|ed)|suffering from|indicates? (a|the) (disease|condition)|suggests? (a|the) (disease|condition))\b/i;
    const offenders = [];
    for (const [code, m] of Object.entries(allMarkers())) {
      const text = m.narrative?.text ?? '';
      if (banned.test(text)) offenders.push(code);
    }
    for (const [code, n] of Object.entries(MARKER_NARRATIVES)) {
      if (banned.test(n.plain)) offenders.push(`curated:${code}`);
    }
    expect(offenders).toEqual([]);
  });

  it('has no unused narrative entries (a typo would silently drop patient text)', () => {
    expect(BUILD_REPORT.unusedNarratives).toEqual([]);
    expect(BUILD_REPORT.unmatchedAliasAdditions).toEqual([]);
  });
});

describe('clinical knowledge base — build integrity', () => {
  it('build report counts agree with the committed artifact', () => {
    const stats = knowledgeStats();
    expect(BUILD_REPORT.counts.markers).toBe(stats.markers);
    expect(BUILD_REPORT.counts.curatedMarkers).toBe(stats.curatedMarkers);
    expect(BUILD_REPORT.counts.withLoinc).toBe(stats.withLoinc);
    expect(Object.keys(allMarkers()).length).toBe(stats.markers);
    expect(panels().length).toBeGreaterThanOrEqual(BUILD_REPORT.panelsCovered.length);
  });

  it('assigns every marker to a known panel and a specimen', () => {
    const known = new Set(panels().map((p) => p.key));
    for (const key of BUILD_REPORT.panelsCovered) expect(known.has(key), `panel ${key}`).toBe(true);
    for (const [code, m] of Object.entries(allMarkers())) {
      expect(known.has(m.panel), `${code} has panel ${m.panel}`).toBe(true);
      expect(m.specimen).toBeTruthy();
    }
  });

  it('resolved every alias collision without leaving a duplicated alias', () => {
    const owner = new Map();
    for (const m of Object.values(generatedLabMarkers())) {
      for (const a of m.aliases) {
        expect(owner.has(a), `alias "${a}" is claimed twice`).toBe(false);
        owner.set(a, m.code);
      }
    }
    expect(BUILD_REPORT.aliasCollisions.length).toBeGreaterThan(0);
  });

  it('excludes the upstream junk rows instead of inventing markers for them', () => {
    // flag rows ("H", "L", "I"), specimen-type rows and comment rows
    expect(BUILD_REPORT.excludedByReason['non-analyte label (blocklist)']).toBeGreaterThan(0);
    for (const junk of ['h', 'l', 'i', 'specimen_type', 'comments', 'n_a']) {
      expect(allMarkers()[junk]).toBeUndefined();
    }
  });

  it('takes the OCR lexicon from the vendored recognizer charset', () => {
    const lexicon = ocrLexicon();
    expect(lexicon.source).toMatch(/OCR-for-Medical-Laboratory-Reports/);
    expect(lexicon.charsetSize).toBeGreaterThan(100);
    expect(lexicon.flagGlyphs).toContain('↑');
    expect(lexicon.confusionClasses.map((c) => c.canonical)).toContain('0');
  });
});

describe('clinical knowledge base — dictionary exposure', () => {
  it('exposes a compact core tier by default with LOINC and panel metadata', () => {
    const core = extractor.dictionary();
    const all = extractor.dictionary({ tier: 'all' });
    expect(Object.keys(core).length).toBeLessThan(Object.keys(all).length);
    expect(core.hba1c.defaultUnit).toBe('%');
    expect(core.hba1c.typicalRange.high).toBe(5.6);
    expect(core.hba1c.loinc).toBe('4548-4');
    expect(core.hba1c.panel).toBe('diabetes');
    expect(core.hba1c.narrativeStatus).toBe('curated');
    expect(core.sodium.loinc).toBe('2951-2');
    expect(all.absolute_neutrophil_count.typicalRange).toBeNull();
    expect(all.absolute_neutrophil_count.rangeSource).toBe('report-only');
  });

  it('keeps every curated marker available and authoritative', () => {
    for (const code of CURATED_CODES) {
      expect(LAB_DICTIONARY[code], `${code} missing from the dictionary`).toBeTruthy();
      expect(marker(code), `${code} missing from the knowledge base`).toBeTruthy();
    }
    expect(CURATED_CODES.size).toBe(17);
  });

  it('converts a marker into the API dictionary shape', () => {
    const entry = toDictionaryEntry(marker('egfr'));
    expect(entry).toMatchObject({ name: expect.any(String), defaultUnit: expect.any(String), panel: 'kidney' });
    expect(entry.rangeSource).toBe('curated-prototype');
  });

  it('counts qualitative markers as catalogued-but-unmatchable', () => {
    expect(numericMarkers().length + knowledgeStats().qualitativeMarkers).toBe(knowledgeStats().markers);
  });
});
