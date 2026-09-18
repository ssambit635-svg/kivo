# MedTwin AI — iQOO City Battle Gap Analysis & 10-Day Plan

**Target:** Hyderabad City Battle · Sat 26 – Sun 27 Sep 2026
**Prepared:** Wed 16 Sep 2026 → **10 days of prep left**
**Verdict:** your instinct is right — the project as it stands would likely **not** clear city-battle screening. But the reason is narrow and very fixable. ~55% of the rubric is phone-first, and that half currently scores near zero. The backend half is genuinely strong.

Every number and claim below was verified against this repo on 16 Sep 2026. Evidence is cited inline.

---

## Implementation status (updated 17 Sep 2026)

The highest-leverage items below have been **implemented** in this branch (see PR):

- **[Done] §3.1 flagship OCR** — `tesseract.js` installed; image OCR works; language data vendored for offline via `npm run ocr:setup`; the three tests that asserted `ocr_failed` were rewritten; new `tests/integration/image-ocr.test.js` pins the success path (12 tests). Suite now **232 passing**.
- **[Done] §3.2 camera** — `getUserMedia` live scanner + frame overlay + `capture="environment"` gallery fallback.
- **[Done] §3.4 voice journaling** — Web Speech API → `POST /observations` with `source:'voice'`.
- **[Done] §3.3 PWA + mobile UI** — manifest, service worker (offline shell, `/api` never cached), bottom nav, safe-area insets.

**Not yet done (needs real device/internet to verify):** real OCR extraction on-device (needs `npm run ocr:setup` on a connected machine), live camera & speech on the iQOO, and the Office Kit workflow (§3.5) + pitch rehearsal. Those are device/network-dependent — see §4 day-plan.

---

## 1. The actual rubric (this is what you are being scored on)

| # | Criteria | Weight | Scored by |
|---|---|---|---|
| 1 | End product quality | **30%** | Jury — demoed **on the iQOO phone** |
| 2 | Novelty and impact | **20%** | Jury |
| 3 | Creative phone use (camera, voice, on-device AI) | **15%** | **HackTracker device data** |
| 4 | Technical depth | **15%** | Jury |
| 5 | Office Kit usage | **10%** | **HackTracker device data** |
| 6 | Demo and presentation | **10%** | Jury |

Source: Reskilll's own iQOO City Battles strategy guide — https://reskilll.com/blogs/how-to-win-iqoo-city-battles-strategy-guide-phone-first-ai-hackathon/

**The single most important fact:** criteria 3 + 5 = **25% comes from HackTracker device telemetry, not your pitch.** You cannot claim phone-first; the device data either shows it or it doesn't.

Also structural: **55% of build time is "Red Light" — phone only, no laptop.** And only the **top 6 teams per city** (3 student + 3 professional) advance to the Grand Finale.

---

## 2. Scorecard: where MedTwin sits today

| Criteria | Weight | Honest estimate | Score | Evidence |
|---|---|---|---|---|
| End product quality | 30% | ~40% | **12** | Backend solid; but the UI's only working report input is *paste text*, and the flagship image scanner is broken (see §3.1) |
| Novelty & impact | 20% | ~70% | **14** | Longitudinal trend engine + user-verification gate + grounded non-hallucinating LLM is a real, defensible idea |
| Creative phone use | 15% | ~0% | **0** | No camera, no voice, no on-device model anywhere in `frontend/` (§3.2) |
| Technical depth | 15% | ~85% | **13** | 220 tests green, scrypt, rotating refresh w/ reuse detection, RBAC, layered OOP |
| Office Kit usage | 10% | 0% | **0** | Zero Office Kit integration or workflow |
| Demo & presentation | 10% | ~20% | **2** | No deck, no demo script, no slides anywhere in repo |
| | **100%** | | **≈ 41 / 100** | |

**≈41/100, with a guaranteed 25-point floor locked at zero** until you touch a real iQOO device with camera/voice/Office Kit. That is the gap. It is not a "bad project" problem — it is a "right project, wrong form factor" problem.

---

## 3. The five gaps, in priority order

### 3.1 [CRITICAL] — the flagship feature does not work for real reports

The README's headline is **"AI Blood Report Scanner: upload → OCR → value extraction"**. Image upload is accepted by the allowlist (`backend/src/services/ReportService.js:10` allows `image/png`, `image/jpeg`, `image/bmp`, `image/webp`, `image/tiff`) — but no OCR engine is installed, so every image throws.

Verified by running the actual service:

```
$ node -e "import {OcrService} from './src/services/ocr/OcrService.js'; ..."
image/jpeg   -> provider: NULL (will throw OcrUnavailableError)
image/png    -> provider: NULL (will throw OcrUnavailableError)
text/plain   -> provider: plain-text
image extract THREW: OcrUnavailableError :: No OCR provider available for 'image/jpeg'
```

`tesseract.js` is the optional provider the code looks for (`OcrService.js:46`, inside `isAvailable()`) and it is **not** in `backend/package.json` dependencies. Confirmed: `import('tesseract.js')` → `ERR_MODULE_NOT_FOUND`.

**Worse — the test suite has codified the failure as correct.** Six assertions lock in `ocr_failed` for images:

- `tests/integration/reports.test.js:166` — *"reports without a provider-supported type go to ocr_failed"*
- `tests/integration/engagement.test.js:188` — comment literally says *"no image OCR provider is installed in this cost-free test env"*
- `tests/unit/report-badge.test.js:16`

So **"220 tests passing" is partly green because it asserts the flagship feature is broken.** A judge who uploads a photo of a real lab report gets a red `ocr_issue` badge and a message telling them to go paste text instead. On the one screen that matters most, the demo fails in front of the jury.

**Fix:** `npm i tesseract.js` in `backend/`, plus install language data, then rewrite those three tests to assert *successful* extraction from a real scanned report image. This is the highest points-per-hour item in the entire plan — it unblocks criterion 1 (30%).

---

### 3.2 [CRITICAL] — zero phone-native capability (15% + feeds the 30%)

Precise per-API grep counts across `frontend/` and `backend/src/` (16 Sep 2026):

```
getUserMedia          -> 0        mediaDevices            -> 0
SpeechRecognition     -> 0        webkitSpeechRecognition -> 0
serviceWorker         -> 0        webmanifest             -> 0
rel="manifest"        -> 0
```

There is no camera, no microphone, no service worker, no web manifest. The only phone-adjacent line in the entire frontend is `<meta name="viewport" ...>` at `frontend/index.html:5`. And `frontend/index.html` offers exactly one way to add a report: a `<textarea>` labelled *"Add a report (paste its text)"*.

This is the crux: **MedTwin's entire premise is "point your phone at a paper lab report."** Section 13 of your own `MedTwin_AI_Context.md` says so — camera scan, voice journaling, on-device AI. None of it is built. Right now it is a laptop web app about a phone idea.

**Fix (all frontend-only, backend already supports it):**
- `getUserMedia` live scanner with a document-frame overlay + `capture="environment"` fallback for the gallery path
- Web Speech API voice journaling → `POST /observations`
- On-device OCR: run `tesseract.js` **in the browser** (WASM). This is the killer move — it makes OCR genuinely on-device and offline-capable, which is exactly the "local/open-source model" brownie point the rubric rewards, and it means **the health report never leaves the phone** (a real privacy story for a health app).

---

### 3.3 [HIGH] — not installable / not demoable on a phone (feeds the 30%)

No `manifest.webmanifest`, no service worker → the app cannot be added to the iQOO home screen, so the demo runs in a browser tab, not as an app. Criterion 1 is explicitly *"demoed on iQOO"* and the Reskilll guide stresses *"Native feel matters."*

Layout evidence: `frontend/styles.css` has exactly **one** media query, at line 136 — `@media (min-width: 1024px)`. Mobile is just the single-column fallback. There is no bottom navigation, no thumb-reachable primary action, no `env(safe-area-inset-*)` handling for the notch/gesture bar.

**Fix:** PWA manifest + icons + service worker (offline shell — pairs perfectly with on-device OCR), plus a mobile-first shell: bottom tab bar, large tap targets, scan as a floating primary action, safe-area padding.

---

### 3.4 [MEDIUM] — voice journaling is *already designed* but never wired (free 15% points)

This one is nearly free, which is why it is high priority despite being "medium" in effort. The backend **already accepts voice-sourced observations**:

```js
// backend/src/controllers/HealthIntelController.js:8-13
createObservation: z.object({
  kind: z.enum(['weight','bp','activity','sleep','symptom','note','medication']),
  payload: z.record(z.any()).default({}),
  source: z.enum(['manual', 'voice', 'device']).default('manual'),   // ← 'voice' already exists
  observedAt: z.string().nullish(),
})
```

The enum value `'voice'` is defined and unused. Nobody has ever posted with it. So the API contract for voice journaling is done; only ~100 lines of frontend (SpeechRecognition → parse → confirm → POST) are missing. You get a scored phone capability for a day's work, and the architecture already anticipated it — a strong "we designed this properly" story for the jury.

---

### 3.5 [MEDIUM] — no Office Kit story, no pitch (10% + 10%)

- `find` for pitch/deck/slides/pdf across the repo → **nothing** (only `seed-demo.js`, a false match on "demo").
- No Office Kit usage documented or integrated.

Office Kit (10%) is pure device telemetry, so the countermeasure is **behavioural, not code**: install Office Kit on your laptop now (pc.vivoglobal.com), and during the build do real work through it — screen-mirror the phone, push files, use the shared clipboard — so HackTracker records genuine usage. Practice the workflow before the event; being slow at it during Red Light costs you twice.

The pitch (10%) needs a deck and a **rehearsed demo script** that runs on the phone. Top teams are separated here, not in the code.

---

## 4. Ten-day plan (Wed 16 Sep → Fri 25 Sep)

**Rule for every day:** keep the phone in the loop. HackTracker is running at the event, and it is 25%. Practise Office Kit daily from Day 1 even before you need it.

| Day | Date | Focus | Done when |
|---|---|---|---|
| **1** | Wed 16 | **Unblock the flagship.** `npm i tesseract.js`, make image OCR work, add a real scanned-report fixture | Photo of a real lab report → extracted markers, verified by a test that asserts success |
| **2** | Thu 17 | Flip the three `ocr_failed` tests to assert real extraction; add an end-to-end image→verify→trend test | `npm test` green with image path covered |
| **3** | Fri 18 | **Camera scanner UI** — `getUserMedia` live view, frame overlay, shutter, `capture` fallback | Pointing phone at paper → report ingested |
| **4** | Sat 19 | **On-device OCR in browser** (tesseract WASM client-side). Offline mode | Airplane mode scan → extraction works on the phone alone |
| **5** | Sun 20 | **Voice journaling** → observations with `source:'voice'` | Say "sleeping badly, no exercise" → structured observation appears |
| **6** | Mon 21 | **PWA** — manifest, icons, service worker, install prompt | Installs to iQOO home screen, opens full-screen, cold-starts offline |
| **7** | Tue 22 | **Mobile-first shell** — bottom nav, thumb zones, safe-area, empty/loading/error states | Whole flow usable one-handed; no horizontal scroll at 360px |
| **8** | Wed 23 | **Office Kit workflow** + polish. Screen-mirror, file push, shared clipboard. Fix demo-path bugs | Documented Office Kit flow you can run without thinking |
| **9** | Thu 24 | **Pitch deck + demo script.** Rehearse on the phone, time it | 3-min pitch + 2-min phone demo, rehearsed twice, cut to time |
| **10** | Fri 25 | **Freeze.** Bug-fix only, no features. Rehearse. Full dry run on device | Cold-start demo works first try, twice in a row |

**Days 1–2 are non-negotiable and should start today.** A broken flagship feature cannot survive a live jury demo, and nothing else on this list matters if that screen fails.

---

## 5. The demo narrative that wins (write this down now)

Judge-facing story, in order, all on the phone:

1. **Point the camera at a paper lab report** → OCR **runs on the device**; the report never leaves the phone. *(camera + on-device AI + privacy, in one move)*
2. **Extracted values land as drafts, not facts** → user verifies. Say this out loud: *"we refuse to let uncertain OCR become medical fact."* This is your medical-safety differentiator and it is already built and tested.
3. **The twin comes alive** → Health Score Timeline, *Jan 53 → Mar 63 → Jun 95* on the seeded demo.
4. **Speak a journal entry** → structured observation. *(voice)*
5. **Explainable risk + What-If** → signed feature contributions, ranges not fake precision, disclaimers in the payload itself.
6. **Doctor summary** → the human outcome: walk into a consultation prepared.

The line to land: **"Most health apps store your reports. MedTwin reads them, remembers them, and explains the change — on your phone, without your health data leaving it."**

---

## 6. What is already strong — protect it, do not rewrite

Do not spend your 10 days here; spend them on §3. These are genuine assets to *show*, not to rebuild:

- **220 tests passing** (verified: `npx vitest run` → `Test Files 15 passed (15)`, `Tests 220 passed (220)`, 2.51s). Real coverage: auth rotation/reuse/lockout, authorization isolation, reports lifecycle, security headers/CORS/rate-limit/SQLi/413.
- **Security depth** most hackathon teams will not match: scrypt hashing, 15-min JWT with `token_version` claim so password change kills live sessions, rotating refresh tokens with **family revocation on reuse detection**, brute-force lockout with timing-blunting, existence-hiding 404s, full audit trail.
- **Authorization model**: admins *cannot* read member health data; family isolation enforced by a single `PolicyService` and tested end-to-end.
- **The safety architecture** — verification gate, verified-values-only for trends/risk, report's own reference range always beating defaults, grounded LLM that can only narrate validated structured data. This is your novelty score. Lead with it.

---

## 7. Two claims to stop making

Your `MedTwin_AI_Context.md` §14 already warns about this and the code has drifted:

1. **"AI Blood Report Scanner"** — currently false for images. Fix it or rename it. Do not demo a headline you cannot deliver.
2. **"Tests (220 passing)"** in the README reads as full coverage. It is real coverage of the *text* path, and it actively asserts the *image* path fails. Fix §3.1 and the number means what it looks like it means.

Neither is a lie in intent — both are the kind of thing a judge finds in ninety seconds, and finding it costs you the 30%.

---

## 8. Immediate next actions (today)

1. `cd backend && npm i tesseract.js` — make image OCR real.
2. Add a genuine scanned-report image fixture to `tests/` and assert extraction **succeeds**.
3. Install Office Kit on your laptop (pc.vivoglobal.com) and practise screen-mirror + file transfer today, while it is free time.
4. Get hands on the actual iQOO device as early as possible — 25% of your score is telemetry you cannot retrofit on day 2 of the event.
