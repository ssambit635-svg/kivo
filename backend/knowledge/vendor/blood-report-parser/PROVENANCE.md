# `garg-tejas/blood-report-parser` — provenance & why nothing is vendored

**Repository:** https://github.com/garg-tejas/blood-report-parser
**Revision consulted:** `a3cf5be2a71d8b8505ea0a6c43ac6baa5f898744` (18 Feb 2026)
**Licence declared by that repository:** **none**

## Decision

No file, code, schema, prompt or prose from this repository is copied into
MedTwin AI. With no licence granted, redistributing any part of it here would
be a redistribution without permission, so the build does not read it at all.

## What was actually learned from it

Only its **published panel taxonomy** was used as a cross-check on the panel
grouping MedTwin ships: Complete Blood Count, Metabolic/Chemistry panel, Lipid
Profile, Liver Function, Kidney Function, Thyroid Function, Coagulation,
Electrolytes. That is standard clinical grouping (it is how lab reports are
printed), not creative expression, and MedTwin's own grouping is authored
independently in `../curated/curatedMappings.js` — `PANEL_RULES`, driven by the
analyte names in the vendored MIT-licensed catalogue.

Two further observations, recorded for completeness because they informed
design decisions rather than code:

1. **Extraction architecture.** That project runs extraction through hosted
   LLM/vision APIs (GLM-OCR, then Gemini). MedTwin deliberately does not: this
   build is cost-free, works offline, and keeps report images on the device —
   so MedTwin's extraction stays deterministic and local, and the catalogue of
   what can be read is data (this knowledge base) rather than a prompt.
2. **Health-score shape.** Its summary score is
   `((total − abnormal×1.5 − borderline×0.5) / total) × 100`. MedTwin's
   `HealthScoreService` is a separate, per-marker, range-aware point model
   (`POINTS` map in `src/services/HealthScoreService.js`); the comparison was
   reviewed and the existing model kept, because MedTwin's score must degrade
   gracefully when many markers have no captured range.

## If this ever becomes MIT/Apache-licensed

Then panels, per-test layperson definitions and the confidence-badge ideas
could be vendored like the other two sources. Until then, this file is the
complete record of the interaction.
