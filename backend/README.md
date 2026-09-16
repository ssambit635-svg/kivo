# MedTwin AI — Backend (cost-free MVP)

Backend for **MedTwin AI — AI-Powered Digital Health Twin** (iQOO Hackathon 2026, HealthTech track), implementing the architecture in [`../MedTwin_AI_Context.md`](../MedTwin_AI_Context.md).

> **Medical-safety notice:** This is a hackathon prototype. It produces **risk-awareness estimates and explanations — never diagnoses**. The risk model is transparent but **not clinically validated**. OCR-extracted values are drafts until a **user explicitly verifies** them.

## Zero-cost guarantees

| Requirement | Solution |
|---|---|
| Database | Node's built-in SQLite (`node:sqlite`) — file or in-memory. No server, no cloud bill. |
| Password hashing | `scrypt` from `node:crypto` — no paid/native dependency. |
| OCR | Pluggable providers; the always-on **plain-text** provider is free. `tesseract.js` kicks in automatically **if installed** (still free). |
| "LLM" explanations | `grounded-local` provider — deterministic narration built **only** from validated structured data. No API keys, no hallucinated numbers. |
| ML risk model | Transparent logistic model with hand-specified, FINDRISC-inspired prototype coefficients — runs in-process, deterministic. |
| Rate limiting | In-memory fixed-window limiter — no Redis needed. |

## Quick start

```bash
cd backend
npm install
cp .env.example .env      # optional; safe dev defaults baked in
npm start                 # http://0.0.0.0:8080
npm test                  # 182 tests: unit + integration (in-memory DB)
npm run dev               # same, with --watch
node scripts/create-admin.js admin@clinic.dev 'Admin' 'Str0ng!Passw0rd#x'
```

## Architecture (OOP, layered)

```
HTTP ──► Controllers (thin) ──► Services (use-cases + safety invariants)
                                    │
                    PolicyService (authZ)   LlmGateway / OCR / Trend / Risk engines
                                    │
                              Repositories (SQL, no authZ) ──► Database (node:sqlite)
```

- **Domain entities** sanitize themselves (`User.toJSON()` can never leak `password_hash`).
- **Repositories** know SQL but nothing about permissions.
- **Services** enforce invariants: verification gates, immutability of verified reports, risk-model disclaimers.
- **PolicyService** is the single authorization brain (see below).
- **Container** wires dependencies explicitly; tests inject fakes by constructor.

## Authentication (high-level)

- **Register / login**: email+password. Policy: ≥12 chars, upper/lower/digit/symbol, deny-list + email-name ban. scrypt-hashed (per-user salt, constant-time verify).
- **Access tokens**: JWT (HS256), 15 min, claim `tv` = user's `token_version`. Password change / logout-all / admin-disable **bumps the version → old access tokens die immediately at verification time** (no stale sessions).
- **Refresh tokens**: opaque 48-byte random, **SHA-256 hashed at rest**, **rotated on every use**. Presenting a rotated token = theft signal → **whole token family revoked**, audit event `auth.refresh_reuse_detected`.
- **Brute force**: 5 failed logins → 15-min lockout; unknown emails still pay a scrypt verify (timing-blunting). Every outcome is written to the audit log.
- **Logout**: revokes the presented refresh token (idempotent). **Logout-all** also bumps token version.

## Authorization (high-level)

Policy matrix enforced by `PolicyService` (`tests/unit/policy.service.test.js` + `tests/integration/authorization.test.js`):

| Actor | Member read | Member write | Manage shares | Health data |
|---|---|---|---|---|
| Owner (account) | ✅ | ✅ | ✅ | own members |
| Shared `viewer` | ✅ | ❌ 403 | ❌ | granted member only |
| Shared `editor` | ✅ | ✅ | ❌ | granted member only |
| Stranger | ❌ 404 (existence hidden) | ❌ 404 | ❌ | — |
| Admin | ❌ 404 | ❌ | ❌ | **admins cannot read health data** — they manage accounts + audit only |

Every resource access loads the resource → resolves its owning member → derives access **from the member, never from caller-supplied ids**.

## The AI pipeline (not "one LLM")

```
upload (.txt / image / PDF / pasted text)
  → OcrService (provider: plain-text, optional tesseract.js)
  → LabExtractionService (canonical dictionary: 16 markers, alias-matched; value/unit/ref-range/confidence/rawLine)
  → lab_results with verified=0            ← draft, never trusted
  → USER VERIFY (corrections allowed)      ← the safety gate
  → TrendService (order, deltas, %change, status crossings, slope, meaningful-change)
  → RiskModelService (transparent logistic; signed feature contributions; completeness; uncertainty notes)
  → DoctorSummaryService (sections + rule-based discussion points)
  → LlmGateway 'grounded-local' (narrates ONLY from the structured outputs above)
```

## API map

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` / `login` / `refresh` / `logout` | strict rate-limit bucket |
| POST | `/api/auth/logout-all`, `/api/auth/change-password`, GET `/api/auth/me`, GET `/api/profile` | Bearer |
| GET/POST/PATCH/DELETE | `/api/members[...]` | + `/shares` (owner-only) |
| POST | `/api/members/:id/reports` | multipart `file` **or** JSON `{text}` |
| GET | `/api/members/:id/reports`, GET `/api/reports/:rid` | |
| POST | `/api/reports/:rid/lab-results`, PATCH/DELETE `/api/lab-results/:lid` | blocked when report verified (409) |
| POST | `/api/reports/:rid/verify` / `unverify` | the trust gate |
| GET | `/api/reports/:rid/explanation` | grounded narration |
| GET | `/api/members/:id/trends[?code=]` | series + stats + narrative |
| POST | `/api/members/:id/risk/diabetes` | `overrides` = labeled what-if scenario |
| GET/POST/DELETE | `/api/members/:id/observations` | weight/bp/activity/sleep/symptom/note/medication |
| GET | `/api/members/:id/doctor-summary` | sections + disclaimers |
| GET | `/api/admin/users`, POST `/api/admin/users/:uid/status`, GET `/api/admin/audit` | admin role |
| GET | `/api/health`, `/api/meta/lab-dictionary` | public |

## Error contract

```json
{ "error": { "code": "REFRESH_REUSED", "message": "...", "details": [] }, "requestId": "uuid" }
```

## Security cheat-sheet

helmet headers • CORS allowlist (dev: localhost + `*.e2b.app` previews; prod via `CORS_ORIGINS`) strict  • rate limits (auth bucket vs global) • 1 MB JSON cap • 5 MB upload cap + MIME allowlist ≤ random on-disk names • request ids + full audit trail • existence-hiding 404s • parameterized SQL everywhere.

## Testing — every tiny thing

```
tests/
├── unit/        password·token·lab-extraction·trend·risk-model·policy
└── integration/ auth (rotation/reuse/lockout/password-change)
                 authorization (isolation/viewer/editor/admin/self-admin)
                 reports (ingest→review→verify→immutability→explain)
                 health-intel (trends/risk/what-if/summary)
                 security (headers/CORS/rate-limit/JSON/SQLi/413/404)
```

`npm test` — **182 passing assertions**, each with an in-memory DB and low-cost scrypt parameters.
