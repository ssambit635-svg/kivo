# MedTwin AI — AI-Powered Digital Health Twin

> iQOO Hackathon 2026 · HealthTech track · Prototype (risk-awareness, **not** a diagnosis engine)

Turns scattered health reports into a living, understandable health timeline:
upload → OCR → value extraction → **user verification** → Digital Health Twin →
longitudinal trend intelligence → explainable risk awareness → grounded explanations →
doctor-visit preparation.

📋 Product context & rules: [`MedTwin_AI_Context.md`](MedTwin_AI_Context.md)

## Status

| Layer | State |
|---|---|
| Backend API | ✅ Built & tested — see [`backend/README.md`](backend/README.md) |
| AuthN/AuthZ | ✅ scrypt + JWT access (rotating refresh tokens w/ reuse detection), RBAC + member-isolation policies |
| AI pipeline | ✅ OCR (plugged), extraction, trends, explainable risk prototype, grounded local LLM, doctor summary |
| Engagement widgets | ✅ Health Score Timeline · Report Confidence Badges · Health Milestones (icon keys, no emojis) |
| Tests | ✅ **220 passing** (`cd backend && npm test`) |
| Frontend | ✅ Demo dashboard at `/app/` — vanilla HTML/CSS/JS, zero build step, real SVG icons |

## Quick start (cost-free)

```bash
cd backend
npm install
npm start          # API on :8080 — SQLite file DB, zero external services
                   # demo dashboard: http://localhost:8080/app/
npm test           # full unit + integration suite, in-memory DB
npm run seed:demo  # demo@medtwin.dev — 3 verified reports, 5/5 milestones
node scripts/create-admin.js admin@clinic.dev 'Admin' 'Str0ng!Passw0rd#x'
```

## Safety principles baked into the code

- Predictions are **risk estimates with uncertainty**, always shipped with disclaimers — never diagnosis language.
- OCR/extracted values are **drafts (`verified=0`)**; trends & risk engines can only read **user-verified** rows.
- The grounded-local LLM narrates **only** from validated structured data — it cannot invent numbers or evidence.
- Reference ranges from the **report itself** always win over typical defaults.
- Admins **cannot** read members' health data; family isolation is enforced by `PolicyService`, tested end-to-end.
