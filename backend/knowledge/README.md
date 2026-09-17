# Clinical knowledge base

MedTwin AI reads a photographed lab report, drafts the values it can see, and
explains them against **the reference range printed on that report**. This
directory is the knowledge that makes that possible: which tests exist, what
they are called on real report layouts, their units, their LOINC identity, and
how strongly to trust a value that came out of OCR.

It is built **offline** from vendored, licence-checked upstream data, committed
as a single artifact, and loaded read-only at runtime. No network call happens
at startup, and no build step is needed to run the app.

```
knowledge/
├── SOURCES.json          pinned revisions + licences of everything vendored
├── curated/              hand-authored, human-reviewed input
│   ├── curatedMappings.js    LOINC anchors, panels, unit tables, plausibility bounds
│   └── markerNarratives.js   patient-education text (authored in-house)
├── vendor/               upstream files, copied verbatim at a pinned commit
│   ├── mimic-code/                        (MIT)
│   ├── ocr-for-medical-laboratory-reports/ (MIT)
│   └── blood-report-parser/PROVENANCE.md   (nothing vendored — see below)
└── generated/            build output, committed so runtime is deterministic
    ├── clinicalKnowledge.json    the knowledge base itself
    ├── buildReport.json          what the build did (counts, collisions, exclusions)
    └── trainedParameters.json    extraction-confidence calibration + model card
```

## Pipeline

```bash
npm run knowledge:vendor   # fetch/refresh upstream files at the pinned commits
npm run knowledge:build    # rebuild generated/clinicalKnowledge.json
npm run knowledge:train    # rebuild trainedParameters.json (calibration)
npm run knowledge:verify   # determinism + data-safety invariants (CI-friendly)
```

Every stage is deterministic: the build contains no timestamps, the corruption
model is seeded, and `knowledge:verify` re-runs the build and fails if a single
byte of the committed artifact changes.

## What came from where (and what did not)

| Source | Licence | What MedTwin uses | What it does **not** use |
| --- | --- | --- | --- |
| [`MIT-LCP/mimic-code`](https://github.com/MIT-LCP/mimic-code) @ `303d26c6` | MIT | `d_labitems_to_loinc.csv` / `lab_itemid_to_loinc.csv` (item ↔ LOINC ↔ label ↔ fluid ↔ category ↔ unit, plus aggregate `labevents_row_count` frequencies) and the plausibility filters from `concepts/measurement/*.sql` | **No patient data.** The MIMIC-IV database itself is credentialed (PhysioNet DUA) and is not part of the repository — only public code and mapping tables are used. |
| [`xuewenyuan/OCR-for-Medical-Laboratory-Reports`](https://github.com/xuewenyuan/OCR-for-Medical-Laboratory-Reports) @ `44504ee7` | MIT (both bundled forks: `endernewton/tf-faster-rcnn`, `meijieru/crnn.pytorch`) | the recognizer's character inventory (`recognition/keys.py`) → the charset, symbol set and glyph-confusion classes the OCR repair layer is derived from | the network itself: it is TensorFlow 1.0 / PyTorch 0.2 GPU research code, and neither the dataset nor the trained weights ship in the repo (Google Drive links), so it cannot be executed here. |
| [`garg-tejas/blood-report-parser`](https://github.com/garg-tejas/blood-report-parser) @ `a3cf5be2` | **none declared** | **nothing is copied** — its panel taxonomy (CBC / metabolic / lipid / liver / kidney / thyroid / …) motivated the category rules, which were re-authored from scratch | any code, prompt, text or asset. With no licence file and no `license` field, the default is "all rights reserved"; the provenance file records that decision. |

The vendored upstream files are redistributed under their own licences (MIT),
with the copyright notices retained in `vendor/*/LICENSE*`. LOINC codes are the
property of the Regenstrief Institute and are used here under the LOINC licence
terms for non-commercial/research use; attribution is carried in `SOURCES.json`
and in `GET /api/meta/knowledge`.

## Data-safety contract

These rules are enforced by the build, by `knowledge:verify`, and by tests —
they are not aspirations:

1. **Never fabricate a reference range.** The upstream mapping tables contain no
   reference intervals. Only the 17 hand-authored markers carry a "typical adult
   range" prototype; every generated marker ships `typicalRange: null` with
   `rangeSource: 'report-only'`, so the app compares exclusively against the
   range printed on the user's own report.
2. **Plausibility is physical, not clinical.** `plausibilityBounds` come from
   upstream concept SQL (`valuenum > 0`, `< 150` for creatinine, …) and from
   hand-authored physical limits. They answer "could any human have this
   number?" — a suspicious reading is flagged for review and its confidence is
   capped, never silently stored.
3. **Qualitative findings are not numbers.** 202 catalogue entries are
   morphology/screen findings (`Acanthocytes`, `Urine Glucose (dipstick)`, …).
   They are listed in the dictionary for display but are *not* offered to the
   numeric extractor, so a number on a nearby line can never be attributed to a
   finding.
4. **Patient-education text is curated or generic, never invented per value.**
   Every narrative is either hand-written (`narrativeStatus: 'curated'`) or the
   claim-free structural fallback that tells the reader to compare the value
   with their own report. Generated markers never inherit a neighbour's text.
5. **No diagnosis, ever.** The knowledge layer describes what a test measures;
   it never states what a value means about a person's health.

## Marker record

```jsonc
{
  "code": "hba1c",                 // stable slug used across the app
  "name": "HbA1c (Glycated Hemoglobin)",
  "aliases": ["hba1c", "a1c", "glycated hemoglobin", "glycosylated hemoglobin"],
  "defaultUnit": "%",
  "typicalRange": { "low": 4, "high": 5.6, "unit": "%" },   // curated markers only
  "rangeSource": "curated-prototype",                        // or "report-only"
  "loinc": "4548-4",
  "loincVariants": ["4548-4", "17856-6"],
  "specimen": "Blood",
  "panel": "diabetes",
  "tier": "core",                  // core = shown/treated as default; extended = catalogue
  "valueKind": "numeric",          // or "qualitative"
  "prevalence": 44527,             // upstream aggregate row count (alias tie-breaker)
  "upstreamItemIds": [50852],
  "plausibilityBounds": null,
  "extractable": true,             // false ⇒ catalogued but never matched by the extractor
  "narrative": { "status": "curated", "text": "…", "related": ["fasting_glucose"] },
  "curated": true
}
```

## Extraction confidence ("the trained model")

`scripts/knowledge/train.js` trains a **calibration model for OCR reading
quality**, not a clinical model:

* the corpus is synthetic, generated by `corruptor.js`, which applies a
  documented noise model (character confusions taken from the recognizer
  charset, decimal/parenthesis drops, column merges, unit damage) to marker
  labels, units and values drawn from this catalogue;
* the label is "did the extraction pipeline recover this marker's code *and*
  value?";
* a logistic model over reading features is fitted, followed by isotonic
  (PAV) recalibration with Beta-prior shrinkage, and the better of
  {isotonic, logistic+isotonic} is chosen **by Brier score**, with ECE and AUC
  reported alongside;
* the artifact carries a model card stating exactly this, including the
  limitation that synthetic noise cannot cover every scanner or paper stock.

Current held-out metrics (`npm run knowledge:train`, seed 20260917):

| metric | raw heuristic | calibrated | meaning |
| --- | --- | --- | --- |
| Brier | 0.153 | **0.068** | probability error over all readings |
| ECE (10 bins) | 0.263 | **0.059** | how far stated confidence is from observed accuracy |
| AUC | 0.890 | **0.894** | separating "a row was read" from "no row was read" |

The corpus-wide numbers are dominated by the honest question *did the pipeline
read this row at all?* Two further facts belong next to them, and both are in
the model card:

* clean lines are recovered at **99.7 %** (value and code correct), degraded
  lines at ~48 % at the highest damage level, and the normalization layer adds
  ~5 points of recovery overall;
* among rows that *were* matched, accuracy is ~91 % and the confidence's AUC is
  only **~0.54**. In other words: the confidence is good at telling a report
  reader "this line was read" versus "this line was skipped", and weak at
  catching a wrong-but-plausible number for the right label. That residual risk
  is exactly why every extraction is a draft (`verified = 0`) that a human
  confirms, and why the app never computes trends or risk from unverified rows.

`heuristicConfidence` keeps the transparent rule score next to the calibrated
one so any row can be audited.

## Adding knowledge

* **A new curated marker**: add it to `curated/curatedLabDictionary.js` (code,
  aliases, unit, optional prototype range) and, if the upstream tables contain
  it, add its LOINC to `LOINC_ANCHORS` so real-world label variants fold in.
* **Better aliases**: `CURATED_EXTRA_ALIASES` (curated codes) or
  `GENERATED_ALIAS_ADDITIONS` (generated codes, applied before collision
  resolution and reported if a key matches nothing).
* **A better explanation**: add a `MARKER_NARRATIVES` entry in
  `curated/markerNarratives.js` — no diagnosis, no numbers you cannot source.
* Then: `npm run knowledge:build && npm run knowledge:train && npm test`.
