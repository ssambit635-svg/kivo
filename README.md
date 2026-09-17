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
| Tests | ✅ **297 passing** (`cd backend && npm test`) |
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

## Safety principles baked into the code

- Predictions are **risk estimates with uncertainty**, always shipped with disclaimers — never diagnosis language.
- OCR/extracted values are **drafts (`verified=0`)**; trends & risk engines can only read **user-verified** rows.
- The grounded-local LLM narrates **only** from validated structured data — it cannot invent numbers or evidence.
- Reference ranges from the **report itself** always win over typical defaults.
- Admins **cannot** read members' health data; family isolation is enforced by `PolicyService`, tested end-to-end.
