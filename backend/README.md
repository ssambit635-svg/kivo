# MedTwin AI — Backend (cost-free MVP)

Backend for **MedTwin AI — AI-Powered Digital Health Twin** (iQOO Hackathon 2026, HealthTech track), implementing the architecture in [`../MedTwin_AI_Context.md`](../MedTwin_AI_Context.md).

> **Medical-safety notice:** This is a hackathon prototype. It produces **risk-awareness estimates and explanations — never diagnoses**. The risk model is transparent but **not clinically validated**. OCR-extracted values are drafts until a **user explicitly verifies** them.

## Zero-cost guarantees

| Requirement | Solution |
|---|---|
| Database | Node's built-in SQLite (`node:sqlite`) — file or in-memory. No server, no cloud bill. |
| Password hashing | `scrypt` from `node:crypto` — no paid/native dependency. |
| OCR | Pluggable providers. Always-on **plain-text** provider (free). **`tesseract.js` is installed** and provides real image OCR; run `npm run ocr:setup` once to vendor language data so photo OCR works **offline**. With neither data nor network it degrades gracefully with actionable guidance. |
| "LLM" explanations | `grounded-local` provider — deterministic narration built **only** from validated structured data. No API keys, no hallucinated numbers. |
| ML risk model | Transparent logistic model with hand-specified, FINDRISC-inspired prototype coefficients — runs in-process, deterministic. |
| Rate limiting | In-memory fixed-window limiter — no Redis needed. |

## Quick start

```bash
cd backend
npm install
cp .env.example .env      # optional; safe dev defaults baked in
npm start                 # http://0.0.0.0:8080  (demo dashboard at /app/)
npm test                  # 297 tests: unit + integration (in-memory DB)
npm run ocr:setup         # one-time: vendor Tesseract language data for offline image OCR
npm run dev               # same, with --watch
npm run seed:demo         # demo@medtwin.dev with a full 3-report journey
node scripts/create-admin.js admin@clinic.dev 'Admin' 'Str0ng!Passw0rd#x'
```

### Troubleshooting

- **`EADDRINUSE: address already in use 0.0.0.0:8080`** — another process
  (usually a previous `npm start`/`npm run dev` still running in another
  terminal) already holds port 8080. Either stop that process, run
  `npm run kill-port` to free the port automatically, or start on another
  port with `PORT=8081 npm start` (Windows: `set PORT=8081 && npm start`).
- **`ExperimentalWarning: SQLite is an experimental feature`** — harmless;
  the backend uses Node's built-in `node:sqlite`. The npm scripts already
  silence it; if you run `node src/server.js` directly you may still see it.

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
| Doctor (`doctor` role) | ❌ 403 on the patient API | ❌ | ❌ | **only through a consultation consent grant**, scoped + expiring |
| Admin | ❌ 404 | ❌ | ❌ | **admins cannot read health data** — they manage accounts + audit only |

Every resource access loads the resource → resolves its owning member → derives access **from the member, never from caller-supplied ids**.

**Roles** live in the `user_roles` table (`patient` / `doctor` / `admin`), are granted **server-side only**,
and are re-read on every request — so suspending a doctor or revoking a role binds on the very next call,
even if the attacker still holds a valid access token. `users.role` (the account flag: `user` / `admin`)
is deliberately **not** widened: a doctor is a normal account plus a role + a professional profile.

**Doctors and patient data.** A doctor sees a chart only while a live consent grant exists for that
specific consultation (`doctor_access_grants`, scope + expiry, revocable by the patient at any moment).
Revoking consent makes the clinical brief vanish and blocks replies (`403 CONSENT_REQUIRED`) on the next
request. Every chart view is audited (`doctor.chart_viewed`).

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

## Engagement widgets (living-twin features)

**1. Health Score Timeline** — `GET /api/members/:id/health-score`  
A snapshot score (0–100) per verified report: *Jan → 53 | Mar → 63 | Jun → 95* on the seeded demo.
Transparent, deterministic, **verified-values-only**: each marker scores 100 in range, 70 with no range
context, and 60/45/25 when out of range within 10%/25%/beyond (overshoot measured against the crossed
bound; the report's own reference range always wins). One "living twin" rule: a marker omitted from the
latest panel keeps its last known verified value. Every snapshot ships its full per-marker breakdown,
`delta` vs the previous snapshot, `methodology`, and a not-a-clinical-score disclaimer in-payload.

**2. Report Confidence Badge** — `badge` field on report list/get/ingest payloads  
Derived (never stored) from state the pipeline already tracks: `status` + `ocr_confidence` + `ocr_error`.
`verified` (green, `shield-check`) · `needs_review` (amber, `alert-triangle`) · `ocr_issue` (red,
`scan-line` — OCR failed, or confidence below the 0.6 review floor). Ships an icon **key**, never an
emoji — frontends map keys to real SVG art (see `frontend/icons.js`).

**3. Health Milestones** — `GET /api/members/:id/milestones`  
Five achievements computed from real events (nothing stored, nothing fakeable): first report added,
first report verified, first health trend detected (second verified point of any marker), doctor summary
generated (tracked via the audited `summary.doctor_generated` event), and 3-month health history
(≥92 days of verified data — carries live progress `{daysCovered, requiredDays}` while locked).
Response includes `earned/total`, the `next` milestone to pursue, and icon keys per milestone.

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
| GET | `/api/members/:id/doctor-summary` | sections + disclaimers (audited → milestone) |
| GET | `/api/members/:id/health-score` | verified-only score timeline + breakdowns |
| GET | `/api/members/:id/milestones` | achievement evaluation + progress |
| GET | `/api/members/:id/intelligence` | full intelligence evidence package (see below) |
| GET | `/api/members/:id/intelligence/baseline[?signal=]` | personal baselines, all or one signal |
| GET | `/api/members/:id/intelligence/patterns[?type=&minStrength=]` | pattern graph edges + multivariate findings |
| POST | `/api/members/:id/intelligence/simulate` | counterfactual twin: hypothetical scenario |
| POST | `/api/members/:id/intelligence/scenarios` | model scenario explorer (ranked presets) |
| GET | `/api/members/:id/intelligence/explanation` | grounded narration of the evidence package |
| POST | `/api/members/:id/ask` | **Ask the Twin** — grounded Q&A over the twin (deterministic intent → verified-data evidence → grounded answer; diagnosis requests always refused) |
| GET | `/api/members/:id/ask/suggestions` | deterministic question suggestions shaped by the data |
| GET | `/api/admin/users`, POST `/api/admin/users/:uid/status`, GET `/api/admin/audit` | admin role |
| GET | `/api/health`, `/api/meta/lab-dictionary`, `/api/meta/knowledge` | public |

### Care network (subscription · consultations · doctor shorts)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/public/plans`, `/api/public/doctors[...]`, `/api/public/doctors/specialties` | public plan + doctor directory |
| POST | `/api/doctor/apply` | doctor self-onboarding (rate-limited; **mock** KYC in this build) |
| GET | `/api/doctor/me`, PATCH `/api/doctor/profile`, POST `/api/doctor/kyc/mock`, GET `/api/doctor/identity-card` | usable **before** activation so a pending doctor can finish verification |
| GET | `/api/doctor/overview` | queue + reach + best-performing shorts |
| GET/POST/PATCH/DELETE | `/api/doctor/videos[...]`, GET `/api/doctor/videos/recommendable` | multipart `file` (mp4/webm/mov) **or** a caption short; claim-lint rejects cure/guarantee language |
| GET | `/api/doctor/consultations[...]`, POST `…/accept`, `…/reply`, `…/close` | consent-gated; reply attaches up to 3 of the doctor's own shorts |
| POST | `/api/doctor/consultations/:id/medicine-draft`, `…/medicine-plan/approve`, `…/medicine-plan/reject` | AI suggests, **the doctor decides**; approval needs the 4-point safety checklist |
| GET | `/api/doctor/earnings` | per-period statement from the payout ledger (consult split + shorts pool) |
| GET | `/api/care/home`, `/plans`, `/entitlements`, `/doctors`, `/videos` | patient care surface |
| GET/POST/DELETE | `/api/care/subscription`, GET/POST `/api/care/payments`, POST `/api/care/payments/:id/confirm` | **mock** billing: intents are stored with `mode: 'mock'`, `provider: 'mock-gateway'`, no credential ever collected |
| GET/POST | `/api/care/consultations[...]` (`…/messages`, `…/consent/revoke`, `…/close`) | plan quota or mock payment; consent scope chosen when booking |
| POST | `/api/care/videos/:id/playback` / `/views` | signed, expiring, user-bound URL; wallet-free |
| GET | `/api/media/videos/:id?v&uid&exp&sig` | the signature **is** the authorization (a `<video>` tag cannot send headers); HTTP Range supported |
| GET/POST | `/api/admin/doctors`, `/api/admin/doctors/:id/status`, `/api/admin/payouts/settle` | admin role: verification queue + idempotent pool settlement |

## Personal Health Intelligence Engine (add-on)

A read-only, CPU-only reasoning layer over **verified** data — pure add-on, no existing
behavior changed. It answers four questions: *what is normal for THIS person? what unusual
changes are happening? which signals move together, with what evidence? what happens to the
MODELLED state under hypothetical changes?*

- **Personal baselines** (`PersonalBaselineService`) — per-signal mean/median/spread,
  recent vs long-term split, latest deviation, confidence + reasons, and one of
  `insufficient_data | stable | normal_variation | gradual_drift | sudden_deviation |
  persistent_deviation`. Deviations are reported as *personal* deviations — never as
  medically abnormal.
- **Temporal anomalies** (`TemporalAnomalyService`) — sudden shifts (robust z-score),
  drift (least-squares slope), persistent deviation, change points (split-mean scan),
  coordinated multi-signal movement, divergent same-group measurements, data gaps, and
  unusual combinations (personal typical-state distance). Every finding names its
  `method`, `score` and `threshold`; severity caps at `informational | watch`.
- **Pattern graph** (`HealthPatternGraphService`) — nodes per recorded signal plus the
  existing risk model; edges typed `OBSERVED | TEMPORAL_ASSOCIATION |
  STATISTICAL_ASSOCIATION | MODEL_CONTRIBUTION` (with `UNKNOWN` examples when overlap is
  too thin). Association is never presented as causation.
- **Counterfactual twin** (`CounterfactualTwinService`) — snapshots the real state into
  a detached copy (stored data is never touched), applies hypothetical changes within
  plausible prototype bounds, and re-runs the **existing** risk model. Fields the model
  doesn't consume are reported as context-only with no invented effect. Every output is
  labeled *Model-based scenario projection / Not a prediction / Not a treatment
  recommendation / Not a guaranteed outcome*.
- **Scenario explorer** — preset hypothetical deltas (weight/activity, solo + combined),
  ranked ONLY by mathematical model effect, with infeasible presets skipped + explained.
- **Uncertainty** — per-signal, per-finding and overall confidence from observation
  counts, time spans, extraction confidence, gaps and model completeness; low-confidence
  results explain why and omit precise scores.
- **Grounded explanation** — the existing `LlmGateway` narrates the structured evidence
  package (`explain_intelligence` task); the LLM computes nothing and every number in
  the text is traceable to the evidence.

`GET /intelligence` returns the whole package plus frontend-ready `summaryCards`
(Personal Baseline · Detected Shift · Health Pattern · Model Contribution · Confidence ·
What Changed?). Results are cached 60s per member behind a data fingerprint, so reads
stay cheap and never go stale. Same auth model as trends/risk: owners/editors/viewers
may read; strangers get 404; admins get no health access. No new tables — intelligence
is recomputed from source-of-truth health data.

## Ask the Twin — grounded conversational Q&A

`POST /api/members/:id/ask { "question": "What changed in my health over the last year?" }`
closes the demo narrative (§17 step 7). Architecture mirrors the rest of the
pipeline — there is **no generative model**:

1. A deterministic intent classifier routes the question (changes, specific
   marker, risk, baseline, shifts, patterns, score, milestones, medications,
   guidance, doctor prep, records, greeting…). Marker detection runs over the
   full 992-marker dictionary alias index.
2. Each intent assembles **evidence from the existing validated-data services**
   (trends, transparent risk model, personal baselines, anomalies, health
   score, milestones, doctor summary, guidance, medication awareness).
3. The `grounded-local` provider renders the answer **only from that evidence**
   — every number is copied verbatim; nothing is computed or invented.
4. **Safety**: diagnosis-seeking questions ("do I have diabetes?") are detected
   first and always answered with a refusal + data-grounded reframe; answers
   never contain condition claims; unverified OCR drafts can never leak into
   answers; the audit event (`ask.question`) stores intent + length only —
   **never the question text** (privacy-by-design).

Same authorization surface as trends: owner/editor/viewer may ask, strangers
get 404, admins get no health access. `GET /ask/suggestions` returns
deterministic follow-up questions shaped by what the data actually supports.

## Error contract

```json
{ "error": { "code": "REFRESH_REUSED", "message": "...", "details": [] }, "requestId": "uuid" }
```

## Security cheat-sheet

helmet headers • CORS allowlist (dev: localhost + `*.e2b.app` previews; prod via `CORS_ORIGINS`) strict  • rate limits (auth bucket vs global) • 1 MB JSON cap • 10 MB upload cap + MIME allowlist ≤ random on-disk names • request ids + full audit trail • existence-hiding 404s • parameterized SQL everywhere • `Cache-Control: no-store` on all of `/api` (health data is never cached) • `Permissions-Policy` lockdown (camera/mic self-only, geolocation/payment/usb denied).

**Automated defense layer (free, zero-dependency):**

- **SecurityMonitor** — cross-endpoint abuse detection: every 401/403 per IP is counted in a rolling window; an IP exceeding the threshold is **auto-blocked for 15 min** (429 + `Retry-After`) and an audit-alerted `security.ip_blocked` event is written. Validation 400s/404s never count, blocks auto-expire, and a monitor fault degrades open (never weakens auth).
- **`npm run security:scan`** — deterministic in-repo secret scanner (cloud keys, private key material, JWT literals, secret assignments, bearer tokens) with an explicit allowlist for documented fixtures.
- **`npm run security:headers`** — boots the real app and asserts the full defensive posture (CSP, HSTS, nosniff, frame/referrer policy, Permissions-Policy, no-store, CORS denial of unknown origins, JSON-only errors, monitor + audit wiring).
- **`npm run security:deps`** — `npm audit` gate (currently **0 known vulnerabilities**).
- **`npm run security:all`** — all three gates; the same chain runs in CI (`.github/workflows/ci.yml`) together with the 460-test suite, knowledge invariants, and the endpoint smoke test.
- **`npm run smoke`** — boots the production entrypoint and exercises **every API endpoint** end-to-end (89 checks), including token rotation/reuse, lockout surfaces, isolation, and security probes.

## Testing — every tiny thing

```
tests/
├── unit/        password·token·lab-extraction·trend·risk-model·policy
│                health-score·milestones·report-badge
└── integration/ auth (rotation/reuse/lockout/password-change)
                 authorization (isolation/viewer/editor/admin/self-admin)
                 reports (ingest→review→verify→immutability→explain)
                 image-ocr (photo→extract→verify→trends + Tesseract availability/offline)
                 health-intel (trends/risk/what-if/summary)
                 engagement (score timeline/milestones/badges/viewer+stranger authz)
                 security (headers/CORS/rate-limit/JSON/SQLi/413/404)
                 ask-twin (intents/grounding/refusal/authz/audit privacy)
                 auto-defense (no-store headers/Permissions-Policy/IP auto-block)
                 care-subscriptions (mock billing, entitlements, plan quota, cancel)
                 doctor-console (apply/KYC/roles/videos/consult flow/RBAC both ways)
                 care-media (upload → signed URL → Range/expiry/tamper + paywall)
```

`npm test` — **518 passing tests**, each with an in-memory DB and low-cost scrypt parameters. Image OCR (photo of a lab report → extracted values → verify → trends) is covered in `tests/integration/image-ocr.test.js`; the Personal Health Intelligence Engine is covered in `tests/unit/{personal-baseline,temporal-anomaly,pattern-graph,counterfactual-twin}.test.js` + `tests/integration/intelligence.test.js`.
