# kivo Android shell

The installable Android app. It is a **thin, dependency-free WebView shell** around
the web product that already ships in [`/frontend`](../frontend) — no AndroidX, no
Kotlin, no third-party SDK, ~1 file of Java.

```
ai.kivo.app   ·   minSdk 24 (Android 7.0)   ·   targetSdk 34 (Android 14)
signed with APK Signature Scheme v1 + v2 (+ v3 when the key allows)
```

## Get the APK

The APK is built by GitHub Actions with the real Android toolchain — see
[`.github/workflows/android.yml`](../.github/workflows/android.yml). Three ways to get it:

| Way | Command / link |
|---|---|
| Latest build (easiest) | https://github.com/ssambit635-svg/kivo/releases/tag/apk-latest → `kivo.apk` |
| Any workflow run | Actions → **Android APK** → a run → *Artifacts* → `kivo-apk` → unzip → `dist/kivo.apk` |
| From your machine | `cd backend && npm run apk:build` (uses a local SDK if you have one, otherwise drives CI through `gh`) |

The same file is committed at [`frontend/kivo.apk`](../frontend/kivo.apk) and served by the
backend at `/download/apk`, which is what every "Download App (APK)" button in the web app
points at. On a `push` to `main` the workflow rebuilds it and commits the verified APK back.

### Install

1. Copy `kivo.apk` to the phone (USB, Drive, or open `/download/apk` in the phone's browser).
2. Open it and allow **"install unknown apps"** for the browser/files app.
3. First launch asks for the **server address** — unless the build has a **baked-in default**
   (see [`default-server.txt`](default-server.txt)), in which case it opens straight into that
   server, every time. For a LAN demo, start the backend on your computer
   (`cd backend && npm start`) and type that computer's LAN address, e.g. `http://192.168.1.7:8080`.
   The screen shows this phone's own Wi-Fi IPs so you know which subnet to look in.
4. `localhost` / `127.0.0.1` will not work — on a phone, localhost is the phone. The app
   says so if you try.

#### Baked-in default server (cloud mode)

Put the permanent URL as the first non-comment line of [`default-server.txt`](default-server.txt)
and rebuild: the first-run screen disappears, the app auto-connects, and a sleeping free-tier
cloud host is handled by a bounded auto-retry ("waking the cloud… attempt 1 of 2") before any
error screen. The menu's **Change server…** entry still opens the picker for a laptop-on-Wi-Fi
demo.

> **Signature note.** An update only installs over an existing app when both are signed with
> the *same* key. CI reuses one cached key, so successive CI builds update cleanly. If you build
> locally with your own debug key after installing a CI build, uninstall first (or add the four
> `KIVO_KEYSTORE_*` secrets so every build uses your key).

## What the shell adds over a browser

| Piece | Where |
|---|---|
| Launcher icon (adaptive + legacy, every density) | `app/src/main/res/mipmap-*`, generated from `frontend/icons` by `tools/make_icons.py` |
| Server picker on first run, with the phone's LAN IPs | `MainActivity.showLanHint()` / `res/layout/activity_main.xml` |
| Baked-in default server (`default-server.txt`) + bounded "waking the cloud" auto-retry | `defaultServer()` / `scheduleWakeRetry()` in `MainActivity` |
| Camera + microphone for `getUserMedia` (report scanner, voice journal) | `KivoChromeClient.onPermissionRequest` → runtime permissions → `PermissionRequest.grant` |
| Gallery fallback for `<input type="file">` | `KivoChromeClient.onShowFileChooser` |
| Surface switcher: `/m/` phone app, `/app/` dashboard, `/doctor/` console | overflow menu → `openSurface()` |
| Honest error screens (DNS / refused / timeout / TLS rejected / 404) | `KivoWebViewClient.onReceived*` + `res/values/strings.xml` |
| Back button navigates the web app's history | `onKeyDown` |
| External links and downloads hand off to the browser | `shouldOverrideUrlLoading`, `setDownloadListener` |
| `window.KivoNative` bridge (`isNative`, `apiBase`, `surface`, `toast`, `changeServer`) | `KivoBridge` — the web app can detect the shell without sniffing the user agent |
| Refuses bad TLS certificates | `onReceivedSslError` → `handler.cancel()`, never `proceed()` |

Cleartext HTTP is allowed (`android:usesCleartextTraffic="true"`) because the demo backend runs
as `http://<laptop-ip>:8080` on the same Wi-Fi. A production build should serve HTTPS and flip
that to `false`.

## Build it yourself

**In CI (recommended — nothing to install):** the workflow installs
`platforms;android-34` + `build-tools;34.0.0`, signs, verifies with `apksigner`,
`aapt2 dump badging` **and** `tools/verify_apk.py`, then uploads the artifact and
publishes the release.

**Locally:** JDK 17+, Gradle 8.7+, `ANDROID_HOME` pointing at an SDK with
platform 34 and build-tools 34.0.0.

```bash
cd android
gradle :app:assembleRelease            # → app/build/outputs/apk/release/app-release.apk
gradle icons                            # regenerate launcher icons after a brand change
python3 tools/verify_resources.py      # preflight: every @string/@mipmap/R.* reference resolves
python3 tools/compile_check.py         # preflight: the Java compiles (no Gradle, no SDK download)
python3 tools/verify_apk.py app/build/outputs/apk/release/app-release.apk
```

`tools/compile_check.py` is the fast answer to "did I just break the build?".
It generates throwaway `R.java` / `BuildConfig.java` stubs from `res/` and runs
`javac` over the module's sources against an `android.jar` — so a missing
symbol or an unhandled checked exception surfaces in about a second instead of
after a full Gradle/AGP round trip. It picks the compiler up from `--javac`,
`$JAVA_HOME/bin/javac`, or `PATH`, and the platform from `--android-jar` or
`$ANDROID_HOME/platforms/android-34/android.jar`; with no toolchain present it
prints `SKIPPED` and exits 0, because a missing local JDK is not a code defect.

Signing keys are read from `android/keystore.properties` (git-ignored) when present;
otherwise AGP signs with your local debug key, which still installs.

```properties
storeFile=/absolute/path/to/release.keystore
storePassword=…
keyAlias=kivo
keyPassword=…
```

## Why this project exists (the "problem parsing the package" incident)

`frontend/kivo.apk` used to be produced by a Python script that hand-assembled every part of
the package: binary `AndroidManifest.xml`, `resources.arsc`, the DEX, and both signature
schemes. The result unzipped cleanly, passed a lenient parser, and still failed to install with
**"There was a problem parsing the package"**.

The cause is visible in one line of `tools/verify_apk.py` output against that old file:

```
FAIL  resource table holds 0 resource entries
FAIL  android:icon resolves to a real entry (None)
      androguard: The requested rid '0x7f020000' could not be found in the list of resources.
```

The manifest declared `android:icon="@7F020000"`, but the hand-built resource table had no
entries at all, so the reference resolved to nothing. `PackageParser` resolves the icon (and
label, theme, and every other resource reference) *while parsing the package* — an
unresolvable reference means the package is rejected before any code runs. Hand-emitting a
resource table that satisfies AAPT2's format, the framework's `android:` attribute ids and the
installer's expectations is not a realistic thing to maintain, so the fake builder
(`backend/scripts/apk/build-apk.py`) is gone and the package is built by AAPT2 + javac + D8 +
apksig instead.

Three guards keep it that way:

- **`tools/verify_resources.py`** — runs *before* Gradle in CI: every `@kind/name` in the
  manifest/layouts/values and every `R.kind.name` in Java must resolve to something that
  exists, and `getString(...)` arity must match the `%1$s` placeholders in the strings.
- **`tools/compile_check.py`** — compiles the module's Java against an `android.jar` with
  generated `R`/`BuildConfig` stubs, so a symbol error costs a second instead of a Gradle run.
- **`tools/verify_apk.py`** — runs on the built APK: container, binary AXML manifest, resource
  table with real entries, `android:icon` resolving to a stored file, DEX header/checksum/SHA-1,
  v1 digests recomputed against the zip, and a v2/v3 APK Signing Block whose certificate matches
  the v1 one. Non-zero exit blocks publication.

CI writes the outcome of all of it — plus `apksigner verify`, `aapt2 dump badging` and the
compiler's own error output — into **[`android/BUILD_REPORT.md`](BUILD_REPORT.md)**, committed
straight back to the branch, so a failed build explains itself without anyone having to open
the Action logs. That file is excluded from this workflow's own path filters, which is what
stops the report commit from re-triggering the build forever.

## Layout

```
android/
├── build.gradle                  AGP 8.5.2, nothing else
├── settings.gradle               google() + mavenCentral(), one module
├── gradle.properties
├── keystore.properties           (git-ignored; written by CI or by you)
├── BUILD_REPORT.md               what the last CI build did — written by CI, never by hand
├── tools/
│   ├── make_icons.py             frontend/icons → res/mipmap-* (pure stdlib PNG decode/resize/encode)
│   ├── verify_resources.py       preflight: every resource reference resolves
│   ├── compile_check.py          preflight: the Java compiles, no Gradle/SDK download needed
│   └── verify_apk.py             postflight: is this package actually installable?
└── app/src/main/
    ├── AndroidManifest.xml       permissions, MAIN/LAUNCHER, cleartext for LAN demos
    ├── java/ai/kivo/app/MainActivity.java
    └── res/                      layout, values (strings/colors/dimens/themes), menu, drawables, mipmaps
```
