# MedTwin AI — AI-Powered Digital Health Twin

> **APK 1.2 startup fix:** login is bundled, old saved server settings no longer override the cloud on launch, and `/m/` now opens the real authenticated app. Install the rebuilt APK once; no laptop/backend command is needed for cloud use. Live features still require internet. See [android/STARTUP_FIX.md](android/STARTUP_FIX.md) for verification and deployment limits.

> iQOO Hackathon 2026 · HealthTech track · Prototype (risk-awareness, **not** a diagnosis engine)

Turns scattered health reports into a living, understandable health timeline:
**point the phone camera at a paper report** → OCR → value extraction → **user verification** →
Digital Health Twin → longitudinal trend intelligence → explainable risk awareness →
grounded explanations → doctor-visit preparation.

Product context and rules: [`MedTwin_AI_Context.md`](MedTwin_AI_Context.md)
City-battle strategy and gap analysis: [`HACKATHON_GAP_ANALYSIS.md`](HACKATHON_GAP_ANALYSIS.md)

## Status

| Layer | State |
|---|---|
| Backend API | Complete - Built and tested, see [`backend/README.md`](backend/README.md) |
| AuthN/AuthZ | Complete - scrypt + JWT access (rotating refresh tokens w/ reuse detection), RBAC + member-isolation policies |
| AI pipeline | Complete - **Real image OCR (Tesseract)** + plain-text, extraction, trends, explainable risk, grounded local LLM, doctor summary |
| Phone-first UI | Complete - Camera report scanner (`getUserMedia` + gallery fallback) · voice journaling · installable PWA (manifest + service worker) · mobile bottom-nav |
| Engagement widgets | Complete - Health Score Timeline · Report Confidence Badges · Health Milestones (icon keys, no emojis) |
| Ask the Twin | Complete - Grounded conversational Q&A (`POST /api/members/:id/ask`) — deterministic intent → verified-data evidence → grounded narration; diagnosis requests always refused |
| Security automation | Complete - Automated IP abuse-block + audit alerts · `/api` no-store · Permissions-Policy · secret scanner · header-posture check · dependency advisory gate (npm's supported endpoint) · CI pipeline |
| Health Intelligence | Complete - Personal baselines · multivariate anomaly detection · pattern graph · counterfactual twin + scenario explorer (read-only add-on, CPU-only) |
| Clinical knowledge base | Complete - **1,226 markers** (1,219 with a LOINC code, 18 panels) built offline from pinned MIT-licensed sources — see [`backend/knowledge/README.md`](backend/knowledge/README.md) |
| Extraction model | Complete - Calibrated confidence trained on a documented OCR-noise corpus (Brier 0.15 → 0.07, ECE 0.26 → 0.06) with a shipped model card |
| Care network | Complete - Mock subscription (Care+) → doctor consultations + doctor-recorded shorts · consent-scoped chart sharing · payout ledger (70/30 consults, 25/35/40 subscription pools) |
| Doctor console | Complete - **Separate frontend at `/doctor/`** — self-onboarding (mock KYC), shorts studio, one-screen clinical brief, AI medicine draft the doctor edits/approves, shareable identity card, earnings statement |
| RBAC | Complete - `user_roles` table (`patient` / `doctor` / `admin`), server-side grants, re-read per request · doctors cannot touch the patient API · patients cannot open the console |
| Tests | Complete - **564 passing** in 43 files (`cd backend && npm test`) + 120-check live endpoint smoke (`npm run smoke`) |
| Frontend | Complete - Demo dashboard at `/app/` — vanilla HTML/CSS/JS, zero build step, real SVG icons |
| Android app | Complete - **Installable `kivo.apk`** (`ai.kivo.app`, minSdk 24 / targetSdk 34) built by GitHub Actions with the real toolchain (AAPT2 + javac + D8 + apksig v1/v2), verified twice before it is published · WebView shell with a surface switcher (`/m/`, `/app/`, `/doctor/`), camera + mic grants for the report scanner, gallery file chooser, honest network-error screens · see [`android/README.md`](android/README.md) |

## Quick start (cost-free)

```bash
cd backend
npm install
npm start          # API on :8080 — SQLite file DB, zero external services
                   # patient app:     http://localhost:8080/app/
                   # doctor console:  http://localhost:8080/doctor/
npm test           # full unit + integration suite, in-memory DB
npm run ocr:setup  # ONE-TIME: vendors Tesseract language data for offline image OCR
npm run seed:demo  # demo patient + demo doctor + 2 shorts (prints both logins)
npm run smoke      # boots the real server & exercises EVERY endpoint (120 checks)
npm run security:all  # secret scan + security-posture check + dependency audit
npm run apk:build  # signed Android APK: local SDK if you have one, else GitHub Actions
node scripts/create-admin.js admin@clinic.dev 'Admin' 'Str0ng!Passw0rd#x'
```

## Android app (`kivo.apk`)

The phone app is a thin, dependency-free WebView shell around the web product — no AndroidX, no
Kotlin, no third-party SDK. It adds what a browser tab cannot: a launcher icon, camera and
microphone runtime grants for the report scanner and voice journal, a gallery file chooser, a
first-run server picker that shows the phone's own Wi-Fi IPs, a switcher between the three
surfaces the backend serves, and real error screens instead of a blank page.

```bash
cd backend && npm run apk:build     # local SDK if present, otherwise it drives GitHub Actions via gh
```

Or just take the artifact CI already built:
[releases/tag/apk-latest](https://github.com/ssambit635-svg/kivo/releases/tag/apk-latest) →
`kivo.apk` (also served by the backend at `/download/apk`, which is what every
"Download App (APK)" button in the web app points at).

**Two ways the APK finds its server:**

- **Cloud build (default for the demo):** put the permanent URL into
  [`android/default-server.txt`](android/default-server.txt) and CI bakes it into the APK. The app
  then opens straight into the product — no first-run screen, no laptop, no `npm start`. If the
  free-tier cloud host is waking from sleep, the shell retries quietly (a bounded 2 attempts)
  before showing any error. The menu's "Change server…" keeps the picker reachable for a LAN demo.
- **LAN build (file left empty):** classic behaviour — start the backend (`cd backend && npm start`)
  and type your computer's LAN address, e.g. `http://192.168.1.7:8080`. `localhost` is the phone,
  not your laptop; the app says so if you try it.

The APK is **built by the Android toolchain in CI and verified twice before publication**
(`apksigner` + `aapt2 dump badging`, then an independent
[`android/tools/verify_apk.py`](android/tools/verify_apk.py) that re-checks the container, the
binary manifest, the resource table, the DEX checksums and both signature schemes). That guard
exists because a previously committed, hand-assembled APK was rejected by Android with
*"There was a problem parsing the package"* — its hand-built resource table had zero entries, so
the manifest's `android:icon` reference resolved to nothing. Details and the post-mortem:
[`android/README.md`](android/README.md).

## Permanent cloud deploy (free, no laptop) — the hackathon setup

The whole product runs on **one free Render web service** (Node + SQLite, zero external
services): API, patient app, doctor console and the APK download, all from a single permanent
`https` URL. Code lives on GitHub; every push to `main` auto-deploys.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ssambit635-svg/kivo)

**One-time setup (~3 minutes, browser only):**

1. Click **Deploy to Render** above (or render.com → *New + → Blueprint* → pick this repo). Render
   reads [`render.yaml`](render.yaml) and provisions the free service — it generates a strong
   `JWT_SECRET` automatically and sets `SEED_DEMO_ON_BOOT=1`.
2. Copy the service URL Render gives you (e.g. `https://kivo-api-xxxx.onrender.com` — you can set
   a cleaner subdomain under Settings → *Render Subdomain*).
3. Paste that URL into [`android/default-server.txt`](android/default-server.txt) and commit to
   `main`. CI rebuilds `kivo.apk` with the server baked in → download it from
   [releases/tag/apk-latest](https://github.com/ssambit635-svg/kivo/releases/tag/apk-latest),
   install once, done — **the app opens straight into kivo, every time, from anywhere.**
4. Recommended for demo day: add a repository variable `KIVO_SERVER_URL = <your url>`
   (Settings → Secrets and variables → Actions → Variables). The
   [keep-alive workflow](.github/workflows/keep-alive.yml) then pings the service every 10 minutes
   so the free tier never sleeps in front of the judges.

**Honest free-tier notes** (worth saying to judges — this prototype states its trade-offs):
the disk is ephemeral, so `SEED_DEMO_ON_BOOT` re-seeds the demo journey (patient, doctor, reports,
care plans) at every boot — the app is always demo-ready, while judge-created accounts reset on
restart. An idle service sleeps after ~15 min; the APK auto-retries through the ~30-60 s wake,
and the keep-alive workflow removes even that. A paid instance + persistent disk removes both
limits.

Demo logins after deploy (seeded automatically): patient `demo@kivo.dev` / `Kivo!Demo#2026` ·
doctor `dr.mohan@kivo.dev` / `Kivo!Doctor#2026`.

## Care network — subscription → consultation + doctor shorts

After the twin gives you the picture, the care network gives you the people. It is built as a
**mock-money MVP** on purpose: the plan, the payment intents and the payout ledger are real rows
in the database, but **no gateway is ever contacted and no card/UPI detail is ever collected**
(`mode: 'mock'`, `provider: 'mock-gateway'` appear on every payment row, and the demo KYC is labelled
`mock` everywhere it is shown).

- **Care+ subscription** — `free` / `care_monthly` (₹199, 4 consults) / `care_yearly` (₹1499).
  The subscription is stored (period, status, plan) and drives entitlements: 4 plan-funded
  consultations per month plus the full doctor-shorts library (previews stay free).
- **Personal doctor consultation** — pick a specialty → pick a doctor → describe the problem →
  choose **exactly which parts of your chart** that doctor may open (`labs / trends / vitals /
  medications / risk / reports`), scoped to that visit and expiring. Revoking consent instantly
  removes the doctor's brief and blocks further clinical replies.
- **Doctor-recorded shorts** — a doctor answers one recurring doubt in 45–60 s. The doctor gets a
  share of every plan (25 % of subscription revenue goes into the shorts pool, split by **watched
  seconds**, not clicks) and, in return, spends no consultation time on the ten questions the chart
  already answers.
- **Why a doctor uploads** — `GET /api/doctor/earnings` shows the honest arithmetic: consults pay
  70 % of the fee to the doctor, the subscription pools pay 25 % (shorts) / 35 % (consult pool) /
  40 % (platform) by largest-remainder so every paise is accounted for.

### The doctor console (`/doctor/`) — a separate frontend for a separate role

A doctor signs in at `/doctor/` (patients signing in at `/app/` are redirected there automatically),
and gets a workspace patients can never open:

1. **Shorts studio** — record/upload a video (mp4/webm/mov) or publish a caption short; claim
   language ("cure", "guaranteed") is rejected at upload by the content lint.
2. **One-screen clinical brief** — active problems, meaningful changes, vitals, current medicines,
   the prototype risk flag, recent reports and a *gap list* of only the things the chart genuinely
   cannot answer. Verified records only; OCR drafts never enter a brief.
3. **AI medicine preview** — deterministic rules over the patient's **verified** lab values suggest a
   therapy *class* (never a dose), with the rationale, cautions, duplicate-medicine check and
   follow-up markers. The doctor edits, includes or skips each line and must tick the 4-point safety
   checklist before anything reaches the patient; rejected drafts are invisible to patients.
4. **Identity card** — a self-created profile ("Dr Mohan Charan · Bone & joint specialist") with a
   stable card number (`MT-DOC-XXXXXXXX`), a public verify link and a mock-verification badge.

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
- **Ask the Twin never diagnoses** — diagnosis-seeking questions are refused and reframed onto recorded data; answers quote verified values only; question text is never written to the audit trail.
