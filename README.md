# MedTwin AI — AI-Powered Digital Health Twin

> iQOO Hackathon 2026 · HealthTech track · Prototype (risk-awareness, **not** a diagnosis engine)

Turns scattered health reports into a living, understandable health timeline:
**point the phone camera at a paper report** → OCR → value extraction → **user verification** →
Digital Health Twin → longitudinal trend intelligence → explainable risk awareness →
grounded explanations → doctor-visit preparation.

📋 Product context & rules: [`MedTwin_AI_Context.md`](MedTwin_AI_Context.md)
🎯 City-battle strategy & gap analysis: [`HACKATHON_GAP_ANALYSIS.md`](HACKATHON_GAP_ANALYSIS.md)

## Status

| Layer | State |
|---|---|
| Backend API | ✅ Built & tested — see [`backend/README.md`](backend/README.md) |
| AuthN/AuthZ | ✅ scrypt + JWT access (rotating refresh tokens w/ reuse detection), RBAC + member-isolation policies |
| AI pipeline | ✅ **Real image OCR (Tesseract)** + plain-text, extraction, trends, explainable risk, grounded local LLM, doctor summary |
| Phone-first UI | ✅ Camera report scanner (`getUserMedia` + gallery fallback) · voice journaling · installable PWA (manifest + service worker) · mobile bottom-nav |
| Engagement widgets | ✅ Health Score Timeline · Report Confidence Badges · Health Milestones (icon keys, no emojis) |
| Health Intelligence | ✅ Personal baselines · multivariate anomaly detection · pattern graph · counterfactual twin + scenario explorer (read-only add-on, CPU-only) |
| Clinical knowledge base | ✅ **1,226 markers** (1,219 with a LOINC code, 18 panels) built offline from pinned MIT-licensed sources — see [`backend/knowledge/README.md`](backend/knowledge/README.md) |
| Extraction model | ✅ Calibrated confidence trained on a documented OCR-noise corpus (Brier 0.15 → 0.07, ECE 0.26 → 0.06) with a shipped model card |
| Tests | ✅ **337 passing** (`cd backend && npm test`) |
| Frontend | ✅ Demo dashboard at `/app/` — vanilla HTML/CSS/JS, zero build step, real SVG icons |

## Quick start (cost-free)

```bash
cd backend
npm install
npm start          # API on :8080 — SQLite file DB, zero external services
                   # demo dashboard: http://localhost:8080/app/
npm test           # full unit + integration suite, in-memory DB
npm run ocr:setup  # ONE-TIME: vendors Tesseract language data for offline image OCR
npm run seed:demo  # demo@medtwin.dev — 3 verified reports, 5/5 milestones
node scripts/create-admin.js admin@clinic.dev 'Admin' 'Str0ng!Passw0rd#x'
```

## Phone-first experience (built for the iQOO)

- **Camera report scanner** — the primary way to add a report. Live `getUserMedia`
  view with a document frame; tap **Capture** and the frame is OCR'd. A **Gallery**
  button (`capture="environment"`) covers devices without live-camera support.
- **Voice journaling** — tap the mic and say how you feel; Web Speech recognition
  (on-device on the iQOO) converts it into a structured observation
  (`source: 'voice'`) after a deterministic, rule-based parse. No free-text AI invention.
- **Installable PWA** — `manifest.webmanifest` + a service worker that caches the app
  shell so the dashboard cold-starts offline. `/api` is **never** cached (auth/health data
  always hits the live server).
- **OCR that survives venue wifi** — Tesseract language data can be vendored locally
  (`npm run ocr:setup`), so photo OCR works with **no network at all**. With no language
  data and no network, the app degrades gracefully and tells you exactly how to enable it.

## Clinical knowledge base (what the app knows)

`backend/knowledge/` is a committed, deterministic knowledge base: which tests a
report can contain, what they are called on real layouts, their units, their
LOINC identity, which panel they belong to, and how much to trust a value read
off a photograph. It is built offline from sources pinned by commit —
[MIT-LCP/mimic-code](https://github.com/MIT-LCP/mimic-code) (item ↔ LOINC
mapping tables and concept SQL, MIT), the charset of
[xuewenyuan/OCR-for-Medical-Laboratory-Reports](https://github.com/xuewenyuan/OCR-for-Medical-Laboratory-Reports)
(MIT) for the OCR repair layer, and in-house curated mappings for the markers
this product is built around.

```bash
cd backend
npm run knowledge:verify   # determinism + data-safety invariants
npm run knowledge:build    # rebuild from vendored sources
npm run knowledge:train    # rebuild the extraction-confidence calibration
curl localhost:8080/api/meta/knowledge   # public transparency report
```

Medical-safety invariants (enforced by `knowledge:verify` and by tests):

- **No fabricated reference ranges.** Only hand-authored markers carry a typical
  range; the other 1,209 markers are `report-only`, compared against the range
  printed on the user's own report.
- **Plausibility bounds are physical, not clinical** — they flag a suspected
  OCR misread for review, never judge a value.
- **No patient data anywhere.** MIMIC-IV itself needs credentialed PhysioNet
  access; only public mapping tables are used, and the model card says so.
- **Patient education text is curated or a claim-free fallback** — never
  generated per value, never a diagnosis.

## Safety principles baked into the code

- Predictions are **risk estimates with uncertainty**, always shipped with disclaimers — never diagnosis language.
- OCR/extracted values are **drafts (`verified=0`)**; trends & risk engines can only read **user-verified** rows.
- The grounded-local LLM narrates **only** from validated structured data — it cannot invent numbers or evidence.
- Reference ranges from the **report itself** always win over typical defaults.
- Admins **cannot** read members' health data; family isolation is enforced by `PolicyService`, tested end-to-end.
