# Login-first APK (1.2)

## What was wrong

- The old native launcher preferred persisted `server_url` / `surface` over the newly baked cloud URL. Installing an update could retain a dead LAN address.
- `/m/` was a separate mock UI with hard-coded health scores/reports and no real sign-in screen. It was not the complete patient app.
- The login document depended on a live cloud request; network errors displayed infrastructure setup/troubleshooting instead of the product.
- The PWA cache served old assets indefinitely (cache-first, no backfill on hits).

## What changed

- Cold launches use the configured cloud origin + `/native/?login=1`, regardless of old preferences. The query is consumed once: cold launch asks for login; ordinary refresh within the app preserves the session.
- The actual patient app and doctor console are bundled by Gradle from `frontend/`. Java serves only those static assets at the cloud origin. No file://, cross-origin API, or embedded private data. `/api` and protected media always reach the live cloud.
- Login works as UI even without connectivity. A bounded health probe (up to ~70 seconds) wakes a sleeping service, reports connection problems inside login, and never retries a mutation.
- `/m/` redirects to the real responsive `/app/`. Old Android root requests also redirect to login rather than backend metadata.
- Role-specific sign-in transfers the doctor session once without asking for the password twice. Patient and doctor persistent tokens remain separate.
- The native toolbar no longer displays infrastructure URLs; APK download buttons are hidden inside the installed app.
- Browser shell updates are network-first; only allowlisted public assets are cached. Native `/native/` bypasses old `/app/` service-worker scope.
- CI rebuilds on frontend changes too, checks bundled bytes against source, and uses increasing second-resolution version codes.

## Install / deployment

**The previously installed APK cannot change its native launcher by itself. Install the newly built APK once.** Do not re-download an older `/download/apk` file from a cloud deployment that has not updated yet.

No laptop or `npm start` is required for the cloud APK. Internet and the configured cloud API must be available for authentication, reports, OCR and care features. A bundled login is not an offline backend. Camera/microphone depend on Android permissions; Web Speech support varies by WebView, with manual journal entry available.

The web `/m/` redirect and cache fixes require deployment of this branch's server/frontend changes. The new APK's bundled UI does not wait for that web deployment; it uses the already-existing API routes.

Free Render still sleeps and its SQLite disk is ephemeral. Paid always-on hosting with a persistent disk is needed for durable user accounts/data; a UI fix cannot remove those hosting limits. Care billing remains intentionally mock-money, not live payments.

## Verification

- `cd backend && npm test` — API/unit regressions, including bounded readiness retries.
- `npm run smoke` — 124 endpoint checks spanning auth, reports, observations, risk, reminders, Ask, care and doctor workflows.
- `npx playwright install --with-deps chromium && npm run test:browser` — mobile-viewport login/signup, logout, Ask/Care, doctor handoff, simulated offline bundled UI, cold relaunch and cloud-wake recovery.
- `python3 android/tools/verify_resources.py` — resource references.
- CI: official Gradle/AAPT2/D8/apksigner build, `verify_apk.py`, `verify_bundle.py`.
- CI cloud smoke separately checks the configured live API and demo login; it is NOT inferred from local tests.

Browser native tests mirror asset interception; they are not an Android device/emulator test. Final phone checks: install update, launch with Wi-Fi disabled (login visible), enable network, sign in, grant camera permission, upload a photo/PDF, verify extracted values, open Care, sign out, kill/relaunch. Never describe untested phone hardware as verified.
