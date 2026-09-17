#!/usr/bin/env node
/**
 * Knowledge build — vendored upstream data + curated decisions → committed
 * artifacts that the runtime loads.
 *
 * INPUT  (pinned, vendored, offline — see vendor.js)
 *   mimic-code:  d_labitems_to_loinc.csv  → analyte identity (name, specimen,
 *                category, unit, LOINC, aggregate assay frequency)
 *                lab_itemid_to_loinc.csv → additional item↔LOINC rows + notes
 *                concepts/*.sql          → physiologic validity bounds the
 *                                          upstream project applies to those
 *                                          items, and concept membership
 *   OCR report recognizer: recognition/keys.py → the glyph inventory a
 *                laboratory-report recognizer must cover
 * INPUT  (curated, human-reviewed — see curated/)
 *   curatedMappings.js, markerNarratives.js
 *
 * OUTPUT (committed; the runtime reads these, never the raw upstream files)
 *   generated/clinicalKnowledge.json  — marker catalogue + panels + lexicon
 *   generated/buildReport.json        — audit trail: what was folded, dropped,
 *                                       renamed, or left ambiguous
 *
 * DETERMINISM: sorted output, no timestamps in the artifacts, pure functions of
 * the inputs. `npm run knowledge:build` twice ⇒ byte-identical files, and the
 * test suite asserts that.
 *
 * MEDICAL-SAFETY INVARIANTS (asserted by tests):
 *   1. A generated marker NEVER carries a reference range. Upstream mappings
 *      contain no reference intervals, so inventing one would be fabricating
 *      clinical data. `typicalRange` is null for every generated marker and the
 *      product keeps comparing against the range printed on the user's report.
 *   2. Only curated narratives carry physiological meaning; generated markers
 *      get a structural, claim-free description.
 *   3. Physiologic "plausibility" bounds are stored separately from ranges and
 *      are only ever used to flag implausible readings for review.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  LOINC_ANCHORS,
  GENERATED_ALIAS_ADDITIONS,
  CURATED_EXTRA_ALIASES,
  LABEL_BLOCKLIST,
  UNIT_PLACEHOLDER_BLOCKLIST,
  PANEL_RULES,
  PANELS,
  HEMATOLOGY_RULES,
  UNIT_EQUIVALENCES,
  UNIT_CONVERSIONS,
  PLAUSIBILITY_BOUNDS,
} from '../../knowledge/curated/curatedMappings.js';
import { MARKER_NARRATIVES, structuralNarrative } from '../../knowledge/curated/markerNarratives.js';
// NOTE: the CURATED layer only — the build must not read the artifact it produces.
import { CURATED_LAB_DICTIONARY as LAB_DICTIONARY } from '../../src/services/labs/curatedLabDictionary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
const VENDOR = path.join(KNOWLEDGE_DIR, 'vendor');
const GENERATED = path.join(KNOWLEDGE_DIR, 'generated');

/* ------------------------------------------------------------------ CSV ---- */

/**
 * Minimal RFC4180 CSV parser (quoted fields, embedded commas/newlines).
 * Hand-rolled on purpose: this project ships zero non-essential dependencies,
 * and the knowledge build must run offline.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift().map((h) => h.replace(/^\uFEFF/, '').trim());
  return rows
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/* ------------------------------------------------------- text helpers ----- */

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');

/** Alias normalization used for matching: lowercase, collapse punctuation runs. */
export const normalizeAlias = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%^/.\-+,]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const titleCase = (s) =>
  String(s)
    .split(/\s+/)
    .map((w) => (/^[A-Z0-9^%(./+\-]+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');

/** Derives the base analyte name from an upstream label. */
export function analyteFromLabel(label) {
  return String(label)
    .replace(/\([^)]*\)/g, ' ') // drop parenthetical qualifiers: "INR(PT)" → "INR"
    .replace(/^%\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------ plausibility from SQL ---- */

/**
 * Extracts physiologic validity bounds from the upstream concept SQL.
 * Upstream applies these as data-quality filters ("lab values cannot be 0 and
 * cannot be negative"); reusing them lets this pipeline flag an implausible
 * reading (usually an OCR misread) instead of storing it as fact.
 * @returns {{ itemBounds: Map<number,{min:number|null,max:number|null}>, positiveOnlyItems: Set<number> }}
 */
export function parseConceptBounds(sqlText) {
  const itemBounds = new Map();
  const positiveOnlyItems = new Set();
  const bump = (itemid, op, value) => {
    const cur = itemBounds.get(itemid) || { min: null, max: null };
    if (op === '>' || op === '>=') cur.min = cur.min == null ? value : Math.max(cur.min, value);
    if (op === '<' || op === '<=') cur.max = cur.max == null ? value : Math.min(cur.max, value);
    itemBounds.set(itemid, cur);
  };

  // itemid = 50912 AND valuenum <= 150  (either order)
  const pairA = /itemid\s*=\s*(\d+)\s*(?:AND|\s)\s*valuenum\s*(<=|>=|<|>)\s*([\d.]+)/gi;
  const pairB = /valuenum\s*(<=|>=|<|>)\s*([\d.]+)\s*(?:AND|\s)\s*itemid\s*=\s*(\d+)/gi;
  for (const m of sqlText.matchAll(pairA)) bump(Number(m[1]), m[2], Number(m[3]));
  for (const m of sqlText.matchAll(pairB)) bump(Number(m[3]), m[1], Number(m[2]));

  // File-level "valuenum IS NOT NULL AND valuenum > 0" gates.
  const itemIds = [...sqlText.matchAll(/itemid\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  const positiveGate = /valuenum\s*>\s*0/.test(sqlText);
  if (positiveGate) for (const id of itemIds) positiveOnlyItems.add(id);

  // Concept membership: every itemid mentioned in a concept query is part of
  // that concept's panel (used only as a cross-check, never as the identity).
  const conceptItems = new Set(itemIds);
  return { itemBounds, positiveOnlyItems, conceptItems };
}

/* --------------------------------------------------------- OCR lexicon ---- */

/** Extracts the character inventory from the vendored recognizer source. */
export function parseOcrCharset(keysSource) {
  const m = keysSource.match(/alphabet\s*=\s*u?'([^']*)'/);
  const raw = m ? m[1] : '';
  const chars = [...new Set([...raw])].filter((c) => c !== ' ' && c !== "'" && c !== '\\');
  return {
    size: chars.length,
    chars,
    asciiLetters: chars.filter((c) => /[A-Za-z]/.test(c)).length,
    digits: chars.filter((c) => /[0-9]/.test(c)).length,
    cjk: chars.filter((c) => /[\u4e00-\u9fff]/.test(c)).length,
    symbols: chars.filter((c) => /[^\p{L}\p{N}]/u.test(c)),
  };
}

/* -------------------------------------------------------------- helpers --- */

function unitIsPlaceholder(u) {
  return !u || UNIT_PLACEHOLDER_BLOCKLIST.some((re) => re.test(u));
}

function canonicalUnit(u) {
  if (unitIsPlaceholder(u)) return null;
  const key = String(u).toLowerCase().replace(/\s+/g, ' ').trim();
  return UNIT_EQUIVALENCES[key] || u.split('|')[0].trim() || null;
}

function labelIsBlocked(label) {
  if (label.length < 2) return true;
  return LABEL_BLOCKLIST.some((re) => re.test(label));
}

function panelFor(label, category) {
  for (const rule of PANEL_RULES) if (rule.test.test(label)) return rule.panel;
  const lower = String(category).toLowerCase();
  if (lower === 'hematology') return 'cbc';
  if (lower === 'blood gas') return 'electrolytes';
  if (lower === 'chemistry') return 'other';
  return 'other';
}

/** Alias specificity: generic single short tokens are riskier to match blindly. */
function aliasSpecificity(alias) {
  const words = alias.split(/[^a-z0-9]+/i).filter(Boolean);
  if (words.length >= 2) return 'precise';
  return alias.length >= 5 ? 'medium' : 'generic';
}

/**
 * Numeric vs qualitative result.
 *
 * Many upstream items are qualitative findings or screens (morphology notes,
 * antigen/antibody screens) whose "unit" column is the placeholder `N/A` or a
 * presence/finding concept. A numeric extractor must not turn "Anisocytosis 1+"
 * into a measurement, so these markers are catalogued (they exist, they can be
 * displayed) but are marked non-numeric and the extractor skips them.
 */
const QUALITATIVE_CONCEPT_RE = /(presence|finding|morpholog|narrative|appearance|colour|color|quality|screen|smear)/i;

export function valueKindOf(row) {
  if (String(row.rawUnit || '').trim().toUpperCase() === 'N/A') return 'qualitative';
  if (!row.unit && row.conceptName && QUALITATIVE_CONCEPT_RE.test(row.conceptName)) return 'qualitative';
  return 'numeric';
}

/* ------------------------------------------------------------- the build -- */

/**
 * @returns {{ knowledge: object, report: object }}
 */
export function buildKnowledge({ vendorDir = VENDOR, log = () => {} } = {}) {
  const dLab = parseCsv(fs.readFileSync(path.join(vendorDir, 'mimic-code/mapping/d_labitems_to_loinc.csv'), 'utf8'));
  const labItem = parseCsv(fs.readFileSync(path.join(vendorDir, 'mimic-code/mapping/lab_itemid_to_loinc.csv'), 'utf8'));
  const conceptFiles = fs
    .readdirSync(path.join(vendorDir, 'mimic-code/concepts'))
    .filter((f) => f.endsWith('.sql'));
  const sqlText = conceptFiles.map((f) => fs.readFileSync(path.join(vendorDir, 'mimic-code/concepts', f), 'utf8')).join('\n');

  const { itemBounds, positiveOnlyItems, conceptItems } = parseConceptBounds(sqlText);
  const ocrCharset = parseOcrCharset(
    fs.readFileSync(path.join(vendorDir, 'ocr-for-medical-laboratory-reports/recognition/keys.py'), 'utf8'),
  );

  /* --- 1. normalize upstream rows ------------------------------------- */

  const ITEM_KEY = 'itemid (omop_source_code)';
  const byItem = new Map();
  for (const r of dLab) {
    const itemid = Number(r[ITEM_KEY]);
    if (!Number.isFinite(itemid)) continue;
    byItem.set(itemid, {
      itemid,
      label: r.label,
      fluid: r.fluid || 'Blood',
      category: r.category || 'Chemistry',
      unit: canonicalUnit(r.valueuom),
      rawUnit: r.valueuom,
      loinc: r.omop_concept_code || null,
      conceptName: r.omop_concept_name || null,
      frequency: Number(r.labevents_row_count || 0),
      source: 'd_labitems_to_loinc',
    });
  }
  // ── second mapping table: fill gaps (notes tell us why a code is absent)
  let gapFilled = 0;
  for (const r of labItem) {
    const itemid = Number(r.itemid);
    if (!Number.isFinite(itemid) || byItem.has(itemid)) continue;
    byItem.set(itemid, {
      itemid,
      label: r.label,
      fluid: r.fluid || 'Blood',
      category: r.category || 'Chemistry',
      unit: canonicalUnit(r.valueuom),
      rawUnit: r.valueuom,
      loinc: r.loinc || null,
      conceptName: null,
      frequency: 0,
      source: 'lab_itemid_to_loinc',
    });
    gapFilled += 1;
  }

  /* --- 2. exclusions (auditable) --------------------------------------- */

  const excluded = [];
  const usable = [];
  for (const row of byItem.values()) {
    if (labelIsBlocked(row.label)) {
      excluded.push({ itemid: row.itemid, label: row.label, reason: 'non-analyte label (blocklist)' });
      continue;
    }
    if (unitIsPlaceholder(row.rawUnit) && !row.loinc) {
      excluded.push({ itemid: row.itemid, label: row.label, reason: 'no unit and no LOINC identity' });
      continue;
    }
    usable.push(row);
  }

  /* --- 3. fold upstream items into existing curated markers ------------- */

  const anchorsByCode = new Map(Object.entries(LOINC_ANCHORS));
  const foldOf = new Map(); // itemid → curated code
  for (const row of usable) {
    for (const [code, anchor] of anchorsByCode) {
      const loincHit = anchor.loinc && row.loinc && anchor.loinc.includes(row.loinc);
      const labelHit = (anchor.labels || []).some((re) => re.test(row.label));
      if (loincHit || labelHit) {
        foldOf.set(row.itemid, code);
        break;
      }
    }
  }

  const curatedMarkers = {};
  for (const [code, def] of Object.entries(LAB_DICTIONARY)) {
    if (!def) continue;
    const rows = usable.filter((r) => foldOf.get(r.itemid) === code);
    const freq = rows.reduce((s, r) => s + r.frequency, 0);
    const aliases = new Set([...def.aliases, ...(CURATED_EXTRA_ALIASES[code] || [])].map(normalizeAlias));
    for (const r of rows) {
      aliases.add(normalizeAlias(r.label));
      if (r.conceptName) {
        const base = analyzeName(r.conceptName);
        if (base && base.length >= 3) aliases.add(normalizeAlias(base));
      }
    }
    curatedMarkers[code] = {
      code,
      name: def.name,
      aliases: [...aliases].filter(Boolean).sort(),
      defaultUnit: def.defaultUnit,
      units: [...new Set([def.defaultUnit, ...def.units, ...rows.map((r) => r.unit).filter(Boolean)])],
      typicalRange: def.typicalRange ?? null, // curated markers keep their authored prototype defaults
      betterDirection: def.betterDirection ?? null,
      loinc: rows.map((r) => r.loinc).filter(Boolean).sort()[0] || null,
      specimen: rows[0]?.fluid || 'Blood',
      upstreamCategory: rows[0]?.category || null,
      panel: panelFor(def.name, rows[0]?.category),
      prevalence: freq,
      upstreamItemIds: rows.map((r) => r.itemid).sort((a, b) => a - b),
      tier: 'core',
      valueKind: 'numeric', // every curated marker is a numeric measurement
      rangeSource: def.typicalRange ? 'curated-prototype' : 'report-only',
      narrativeStatus: MARKER_NARRATIVES[code] ? 'curated' : 'structural',
      curated: true,
      provenance: rows.length ? 'curated + upstream-identity' : 'curated',
    };
  }

  /* --- 4. group the remaining upstream items into generated markers ----- */

  const groups = new Map();
  for (const row of usable) {
    if (foldOf.has(row.itemid)) continue;
    // Identity = label + specimen (NOT the LOINC code alone): upstream carries
    // several items for one analyte measured by different assays, and a report
    // prints one row for it. Extra LOINC codes are recorded as variants.
    const analyte = analyteFromLabel(row.label);
    // "Glucose, Urine" and "Glucose (Urine)" are the same urine glucose row on
    // a report: strip the specimen words from the analyte before keying so the
    // two upstream items merge into one marker.
    const analyteSlug = slugify(analyte);
    const fluidWords = slugify(row.fluid).split('_').filter(Boolean);
    const trimmed = stripTrailingWords(analyteSlug, fluidWords) || 'body_fluid';
    const key = `name:${trimmed}|${row.fluid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...row, analyteKey: slugify(analyte) });
  }

  // Analyte names that exist in more than one specimen: only the blood variant
  // may claim the bare name as an alias ("Glucose" ≠ "Glucose, Urine").
  const fluidsByAnalyte = new Map();
  for (const rows of groups.values()) {
    const analyte = rows[0].analyteKey;
    if (!fluidsByAnalyte.has(analyte)) fluidsByAnalyte.set(analyte, new Set());
    fluidsByAnalyte.get(analyte).add(rows[0].fluid);
  }

  const usedCodes = new Set(Object.keys(curatedMarkers));
  const generatedMarkers = {};
  const appliedAliasAdditions = new Set();
  const aliasOwner = new Map(); // alias → code (collision resolution)

  // Seed ownership with curated aliases first: curated always wins.
  for (const m of Object.values(curatedMarkers)) {
    for (const a of m.aliases) if (!aliasOwner.has(a)) aliasOwner.set(a, m.code);
  }

  const collisions = [];
  // Blood markers claim the bare aliases first ("glucose" belongs to the serum
  // measurement, not to urine glucose), then by real-world frequency.
  const orderedGroups = [...groups.entries()].sort((a, b) => {
    const bloodA = a[1][0].fluid === 'Blood' ? 0 : 1;
    const bloodB = b[1][0].fluid === 'Blood' ? 0 : 1;
    const fa = Math.max(...a[1].map((r) => r.frequency));
    const fb = Math.max(...b[1].map((r) => r.frequency));
    return bloodA - bloodB || fb - fa || a[0].localeCompare(b[0]);
  });

  for (const [key, rows] of orderedGroups) {
    const primary = rows.reduce((best, r) => (r.frequency > best.frequency ? r : best), rows[0]);
    const fluid = primary.fluid;
    const multiFluid = (fluidsByAnalyte.get(primary.analyteKey) || new Set()).size > 1;
    const isBlood = fluid === 'Blood';

    // Code = stable slug of the analyte (+ specimen when not blood). If that
    // collides (several upstream items share one analyte, e.g. urine glucose
    // measured by two methods), disambiguate with the LOINC code — which is
    // exactly what distinguishes the measurements — before falling back to the
    // upstream item id. `glucose_urine_2350_7` is honest; `glucose_50809` is not.
    const fluidSlug = slugify(fluid);
    const alreadyQualified = primary.analyteKey.endsWith(`_${fluidSlug}`);
    let code = isBlood ? primary.analyteKey : alreadyQualified ? primary.analyteKey : `${primary.analyteKey}_${fluidSlug}`;
    if (usedCodes.has(code) && slugify(primary.category) !== fluidSlug) code = `${code}_${slugify(primary.category)}`;
    if (usedCodes.has(code) && primary.loinc) code = `${code}_${primary.loinc.replace(/-/g, '_')}`;
    if (usedCodes.has(code)) code = `${code}_${primary.itemid}`;
    usedCodes.add(code);

    // Aliases: the label itself, the LOINC concept name, and a fluid-qualified
    // form when the bare name would be ambiguous across specimens.
    const aliasSet = new Set();
    const addAlias = (alias, source) => {
      const norm = normalizeAlias(alias);
      if (!norm || norm.length < 3) return;
      if (!/[a-z]/.test(norm)) return; // never alias on pure numbers/symbols
      if (/^(test|result|value|unit|range|normal|sample|level|total|other)\b/.test(norm) && norm.split(' ').length === 1) return;
      aliasSet.add(norm);
      return source;
    };

    const displayName = isBlood || primary.analyteKey.endsWith(`_${fluidSlug}`)
      ? titleCase(analyteFromLabel(primary.label))
      : `${titleCase(analyteFromLabel(primary.label))} (${fluid})`;
    addAlias(displayName); // the exact name this build publishes
    addAlias(displayName.replace(/\([^)]*\)/g, ' ')); // and without the parenthetical
    addAlias(primary.label);
    if (primary.analyteKey && primary.analyteKey.length >= 3) {
      if (isBlood || !multiFluid) addAlias(primary.analyteKey.replace(/_/g, ' '));
    }
    if (primary.conceptName) addAlias(analyzeName(primary.conceptName));
    for (const r of rows) if (r.itemid !== primary.itemid) addAlias(r.label);
    if (!isBlood) {
      // Qualified forms only: "urine glucose" / "glucose urine".
      const base = primary.analyteKey.replace(/_/g, ' ');
      addAlias(`${slugify(fluid).replace(/_/g, ' ')} ${base}`);
      addAlias(`${base} ${slugify(fluid).replace(/_/g, ' ')}`);
    }
    if (isBlood && multiFluid) addAlias(`${primary.analyteKey.replace(/_/g, ' ')} blood`);

    // Human-vetted aliases for this specific marker (short but unambiguous in
    // this document class — see curatedMappings.js). A key that matches no
    // emitted code is reported, so a typo can never silently drop an alias.
    appliedAliasAdditions.add(code);
    for (const extra of GENERATED_ALIAS_ADDITIONS[code] || []) {
      const norm = normalizeAlias(extra);
      if (norm) aliasSet.add(norm);
    }

    // Collision policy: first owner (highest prevalence, curated first) wins;
    // the loser keeps the alias out of its list and the event is audited.
    const aliases = [];
    for (const a of [...aliasSet].sort()) {
      const owner = aliasOwner.get(a);
      if (owner && owner !== code) {
        collisions.push({ alias: a, keptBy: owner, droppedFrom: code });
        continue;
      }
      aliasOwner.set(a, code);
      aliases.push(a);
    }
    if (aliases.length === 0) {
      excluded.push({ itemid: primary.itemid, label: primary.label, reason: 'no usable alias after collision resolution' });
      continue;
    }
    if (!code || code === 'body_fluid' || !primary.label.trim()) {
      excluded.push({ itemid: primary.itemid, label: primary.label, reason: 'analyte name reduces to nothing usable' });
      continue;
    }

    const bounds = mergeBounds(rows, itemBounds, positiveOnlyItems);
    const curatedBound = PLAUSIBILITY_BOUNDS[code];
    const prevalence = rows.reduce((s, r) => s + r.frequency, 0);
    const panel = panelFor(primary.label, primary.category);
    const valueKind = rows.some((r) => valueKindOf(r) === 'numeric') ? 'numeric' : 'qualitative';

    generatedMarkers[code] = {
      code,
      name: isBlood || primary.analyteKey.endsWith(`_${fluidSlug}`)
        ? titleCase(analyteFromLabel(primary.label))
        : `${titleCase(analyteFromLabel(primary.label))} (${fluid})`,
      aliases,
      defaultUnit: primary.unit,
      units: [...new Set(rows.map((r) => r.unit).filter(Boolean))],
      // INVARIANT: never a reference range for a generated marker.
      typicalRange: null,
      betterDirection: null,
      loinc: primary.loinc,
      loincVariants: [...new Set(rows.map((r) => r.loinc).filter(Boolean))].sort(),
      specimen: fluid,
      upstreamCategory: primary.category,
      panel,
      prevalence,
      upstreamItemIds: rows.map((r) => r.itemid).sort((a, b) => a - b),
      tier: isBlood && (primary.category === 'Chemistry' || primary.category === 'Hematology') && prevalence >= 1000 ? 'core' : 'extended',
      rangeSource: 'report-only',
      valueKind,
      plausibilityBounds: curatedBound || bounds || null,
      narrativeStatus: MARKER_NARRATIVES[code] ? 'curated' : 'structural',
      curated: false,
      // A marker is only worth matching if at least one alias is long enough to
      // be unambiguous; the rest stay catalogued for display.
      // Only numeric, unambiguously-named markers are offered to the numeric
      // extractor: a qualitative finding ("Acanthocytes: present") has no value
      // to read, and a 2-letter alias would match half the alphabet.
      extractable: valueKind !== 'qualitative' && aliases.some((a) => a.length >= 3),
      provenance: 'upstream-identity',
      aliasSpecificity: aliases.some((a) => aliasSpecificity(a) === 'precise')
        ? 'precise'
        : aliases.some((a) => aliasSpecificity(a) === 'medium')
          ? 'medium'
          : 'generic',
    };
  }

  // Apply curated plausibility bounds to curated markers too.
  for (const m of Object.values(curatedMarkers)) {
    const curatedBound = PLAUSIBILITY_BOUNDS[m.code];
    const sqlBound = mergeBounds(
      usable.filter((r) => foldOf.get(r.itemid) === m.code),
      itemBounds,
      positiveOnlyItems,
    );
    m.plausibilityBounds = curatedBound || sqlBound || null;
  }

  /* --- 5. narratives --------------------------------------------------- */

  const enriched = {};
  for (const m of Object.values(generatedMarkers)) {
    const curated = MARKER_NARRATIVES[m.code];
    enriched[m.code] = {
      ...m,
      narrative: curated
        ? { status: 'curated', text: curated.plain, related: curated.related || [] }
        : {
            status: 'structural',
            text: structuralNarrative({ name: m.name, specimen: m.specimen, panelName: panelNameOf(m.panel) }),
            related: [],
          },
    };
  }
  for (const m of Object.values(curatedMarkers)) {
    const curated = MARKER_NARRATIVES[m.code];
    m.narrative = curated
      ? { status: 'curated', text: curated.plain, related: curated.related || [] }
      : {
          status: 'structural',
          text: structuralNarrative({ name: m.name, specimen: m.specimen, panelName: panelNameOf(m.panel) }),
          related: [],
        };
  }

  const markers = { ...curatedMarkers, ...enriched };
  const sortedMarkers = Object.fromEntries(Object.entries(markers).sort(([a], [b]) => a.localeCompare(b)));

  /* --- 6. assemble the artifact ---------------------------------------- */

  const usedNarratives = new Set(
    Object.values(sortedMarkers)
      .filter((m) => m.narrative.status === 'curated')
      .map((m) => m.code),
  );
  const unusedNarratives = Object.keys(MARKER_NARRATIVES).filter((c) => !usedNarratives.has(c));

  const knowledge = {
    schema: 'medtwin.clinicalKnowledge/1',
    sources: sourceRevisions(),
    stats: {
      markers: Object.keys(sortedMarkers).length,
      curatedMarkers: Object.keys(curatedMarkers).length,
      generatedMarkers: Object.keys(enriched).length,
      coreMarkers: Object.values(sortedMarkers).filter((m) => m.tier === 'core').length,
      withLoinc: Object.values(sortedMarkers).filter((m) => m.loinc).length,
      withCuratedNarrative: usedNarratives.size,
      withAuthoredRange: Object.values(sortedMarkers).filter((m) => m.typicalRange).length,
      numericMarkers: Object.values(sortedMarkers).filter((m) => m.valueKind === 'numeric').length,
      qualitativeMarkers: Object.values(sortedMarkers).filter((m) => m.valueKind === 'qualitative').length,
      upstreamItemsFolded: foldOf.size,
      upstreamItemsExcluded: excluded.length,
    },
    panels: PANELS,
    markers: sortedMarkers,
    unitEquivalences: UNIT_EQUIVALENCES,
    unitConversions: UNIT_CONVERSIONS,
    ocrLexicon: {
      source: 'xuewenyuan/OCR-for-Medical-Laboratory-Reports (recognition/keys.py, MIT)',
      charsetSize: ocrCharset.size,
      digits: ocrCharset.digits,
      cjkGlyphs: ocrCharset.cjk,
      symbols: ocrCharset.symbols,
      // Glyph classes a lab-report recognizer must not confuse. Derived from the
      // upstream inventory (it is exactly the set a report recognizer is trained
      // to read) plus standard OCR confusions for these glyphs.
      confusionClasses: [
        { canonical: '0', lookalikes: ['O', 'o', 'Q', 'D'] },
        { canonical: '1', lookalikes: ['l', 'I', 'i', '|', '!'] },
        { canonical: '2', lookalikes: ['Z', 'z'] },
        { canonical: '5', lookalikes: ['S', 's'] },
        { canonical: '6', lookalikes: ['G', 'b'] },
        { canonical: '8', lookalikes: ['B'] },
        { canonical: '9', lookalikes: ['g', 'q'] },
        { canonical: 'µ', lookalikes: ['u', 'μ', 'mc'] },
        { canonical: '×', lookalikes: ['x', '*'] },
        { canonical: '.', lookalikes: [',', '·'] },
        { canonical: '-', lookalikes: ['–', '—', '~'] },
      ],
      flagGlyphs: ['↑', '↓', 'H', 'L', 'HH', 'LL', '*'],
    },
  };

  const report = {
    schema: 'medtwin.knowledgeBuildReport/1',
    sources: sourceRevisions(),
    counts: knowledge.stats,
    transport: 'vendored (offline)',
    conceptItemsRecognized: conceptItems.size,
    gapFilledFromSecondMapping: gapFilled,
    exclusions: excluded.slice(0, 200),
    excludedByReason: tally(excluded.map((e) => e.reason)),
    aliasCollisions: collisions,
    unmatchedAliasAdditions: Object.keys(GENERATED_ALIAS_ADDITIONS).filter((c) => !appliedAliasAdditions.has(c)),
    unusedNarratives,
    panelsCovered: [...new Set(Object.values(sortedMarkers).map((m) => m.panel))].sort(),
    ocrCharset: { size: ocrCharset.size, cjkGlyphs: ocrCharset.cjk, digits: ocrCharset.digits },
  };

  return { knowledge, report };
}

/** "Glucose [Mass/volume] in Serum or Plasma" → "Glucose" */
function analyzeName(conceptName) {
  const base = String(conceptName).split('[')[0].trim();
  return base.length >= 3 ? base : null;
}

function mergeBounds(rows, itemBounds, positiveOnlyItems) {
  let min = null;
  let max = null;
  for (const r of rows) {
    const b = itemBounds.get(r.itemid);
    if (b?.min != null) min = min == null ? b.min : Math.max(min, b.min);
    if (b?.max != null) max = max == null ? b.max : Math.min(max, b.max);
    if (positiveOnlyItems.has(r.itemid)) min = min == null ? 0 : Math.max(min, 0);
  }
  if (min == null && max == null) return null;
  return { min, max };
}

/**
 * Removes a trailing run of specimen words from an analyte slug:
 * "glucose_urine" + fluid "Urine" → "glucose". Returns the original slug when
 * nothing matches, and null for an empty result.
 */
export function stripTrailingWords(slug, words) {
  if (!slug || words.length === 0) return slug || null;
  let parts = slug.split('_');
  let stripped = false;
  for (let guard = 0; guard < words.length; guard += 1) {
    const tail = parts[parts.length - 1];
    if (tail && words.includes(tail)) {
      parts = parts.slice(0, -1);
      stripped = true;
    } else break;
  }
  if (!stripped) return slug;
  return parts.length ? parts.join('_') : null;
}

function panelNameOf(key) {
  return PANELS.find((p) => p.key === key)?.name || null;
}

function tally(list) {
  const out = {};
  for (const x of list) out[x] = (out[x] || 0) + 1;
  return out;
}

function sourceRevisions() {
  const file = path.join(KNOWLEDGE_DIR, 'SOURCES.json');
  if (!fs.existsSync(file)) return [];
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  return manifest.sources.map((s) => ({
    id: s.id,
    repo: s.repo,
    commit: s.commit,
    licence: s.licence,
    vendoredFiles: s.files.length,
    contentHash: crypto
      .createHash('sha256')
      .update(s.files.map((f) => f.sha256).join(':'))
      .digest('hex')
      .slice(0, 16),
  }));
}

/* ---------------------------------------------------------------- write --- */

export function writeKnowledge({ vendorDir = VENDOR, outDir = GENERATED } = {}) {
  const { knowledge, report } = buildKnowledge({ vendorDir });
  fs.mkdirSync(outDir, { recursive: true });
  // Compact JSON: this artifact is machine-read (the runtime loads it at
  // startup), so whitespace is pure payload weight on a phone-sized budget.
  fs.writeFileSync(path.join(outDir, 'clinicalKnowledge.json'), `${JSON.stringify(knowledge)}\n`);
  fs.writeFileSync(path.join(outDir, 'buildReport.json'), `${JSON.stringify(report, null, 2)}\n`);
  return { knowledge, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { knowledge, report } = writeKnowledge();
  const s = knowledge.stats;
  console.log(`build ok → ${path.relative(process.cwd(), path.join(GENERATED, 'clinicalKnowledge.json'))}`);
  console.log(
    `  markers: ${s.markers} (curated ${s.curatedMarkers} + generated ${s.generatedMarkers}, core ${s.coreMarkers})\n` +
      `  LOINC-identified: ${s.withLoinc} · curated narratives: ${s.withCuratedNarrative} · authored ranges: ${s.withAuthoredRange}\n` +
      `  upstream items folded into curated codes: ${s.upstreamItemsFolded} · excluded: ${s.upstreamItemsExcluded}\n` +
      `  alias collisions resolved: ${report.aliasCollisions.length} · unused narratives: ${report.unusedNarratives.length}` +
      (report.unusedNarratives.length ? ` → ${report.unusedNarratives.join(', ')}` : ''),
  );
}
