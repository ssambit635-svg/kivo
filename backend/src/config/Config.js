/**
 * Application configuration, loaded from environment variables with
 * safe, cost-free / local-friendly defaults for development and tests.
 * Production deployments MUST override JWT_SECRET (config throws otherwise).
 */
export class Config {
  constructor(env = process.env) {
    this.nodeEnv = env.NODE_ENV || 'development';
    this.isTest = this.nodeEnv === 'test';
    this.isProd = this.nodeEnv === 'production';

    this.host = env.HOST || '0.0.0.0';
    this.port = Number(env.PORT || 8080);

    // --- security / auth -------------------------------------------------
    this.jwtSecret = env.JWT_SECRET || (this.isProd ? '' : 'medtwin-dev-secret-change-me');
    if (!this.jwtSecret) {
      throw new Error('FATAL: JWT_SECRET must be set in production');
    }
    this.accessTokenTtlSec = Number(env.ACCESS_TOKEN_TTL_SEC || 15 * 60); // 15 minutes
    // "Stay signed in on this device until I sign out": the refresh token is
    // rotated (and its window extended) on every use, so an app that is opened
    // at least once a month never asks for a password again. Signing out —
    // or the server revoking the family — is what ends the session.
    this.refreshTokenTtlSec = Number(env.REFRESH_TOKEN_TTL_SEC || 30 * 24 * 3600); // 30 days
    this.loginMaxFailedAttempts = Number(env.LOGIN_MAX_FAILED_ATTEMPTS || 5);
    this.lockoutMinutes = Number(env.LOCKOUT_MINUTES || 15);

    // password hashing (scrypt) parameters
    this.scrypt = { N: 16384, r: 8, p: 1, keylen: 64 };
    if (this.isTest) this.scrypt.N = 4096; // keep test suite fast, still scrypt

    // --- persistence -----------------------------------------------------
    this.dbPath = env.DB_PATH || (this.isTest ? ':memory:' : 'data/medtwin.db');
    this.uploadDir = env.UPLOAD_DIR || 'uploads';

    // --- demo seed on boot -------------------------------------------------
    // Cloud hosts (Render free tier etc.) wipe the disk on every restart. With
    // SEED_DEMO_ON_BOOT=1 the server re-seeds the demo journey at startup, so
    // the deployed app always has the demo patient, doctor and reports ready.
    // Harmless when data already exists — the seed exits with a notice.
    this.seedOnBoot = ['1', 'true', 'yes'].includes(String(env.SEED_DEMO_ON_BOOT || '').toLowerCase());
    // Phone cameras (esp. 50MP+ sensors) produce multi-MB originals; the PWA
    // downscales before upload, but gallery picks can still be large — 10 MB
    // default keeps real phones working while staying abuse-safe.
    this.maxUploadBytes = Number(env.MAX_UPLOAD_MB || 10) * 1024 * 1024;

    // --- CORS ------------------------------------------------------------
    // Normalize configured origins once so a harmless trailing slash does not
    // turn a valid browser origin into a CORS failure. Browsers send origins
    // without a trailing slash, while deployment environment variables often
    // include one when copied from a URL bar.
    this.corsAllowedOrigins = (env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => String(s).trim().replace(/\/+$/, ''))
      .filter(Boolean);
    // E2B / arena live-preview hostnames + local dev frontends are allowed by default
    // outside production. Same-origin requests are accepted in every environment;
    // production cross-origin frontends must still be listed in CORS_ORIGINS.
    this.corsAllowOriginRegexes = [];
    if (!this.isProd) {
      this.corsAllowOriginRegexes.push(/^https:\/\/[\w-]+\.e2b\.app$/);
      this.corsAllowOriginRegexes.push(/^https?:\/\/localhost(:\d+)?$/);
      this.corsAllowOriginRegexes.push(/^https?:\/\/127\.0\.0\.1(:\d+)?$/);
      // Native-app shells (Capacitor / Cordova / Ionic WebViews) send a
      // custom-scheme Origin instead of https — the mobile app needs these.
      this.corsAllowOriginRegexes.push(/^(capacitor|ionic|http|https):\/\/localhost(:\d+)?$/);
      this.corsAllowOriginRegexes.push(/^capacitor:\/\/[^/]+$/);
      this.corsAllowOriginRegexes.push(/^ionic:\/\/[^/]+$/);
      // Demo-day reality: the phone's browser hits the laptop backend over
      // LAN (http://192.168.x.x:8080). Private-network origins are safe to
      // allow outside production; same-origin PWA use needs no CORS at all.
      this.corsAllowOriginRegexes.push(/^https?:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/);
    }

        // --- automated abuse detection (SecurityMonitor) -----------------------
        // Cross-endpoint 401/403 failure tracking per IP with automatic block.
        // Enabled everywhere EXCEPT the unit/integration suite (which fires
        // thousands of deliberate 401/403s from one IP); tests opt in per file.
        this.securityMonitor = {
          enabled: env.SECURITY_MONITOR_ENABLED
            ? env.SECURITY_MONITOR_ENABLED !== 'false'
            : !this.isTest,
          windowMs: Number(env.SECURITY_MONITOR_WINDOW_MS || 5 * 60 * 1000),
          maxFailures: Number(env.SECURITY_MONITOR_MAX_FAILURES || 60),
          blockMs: Number(env.SECURITY_MONITOR_BLOCK_MS || 15 * 60 * 1000),
        };

        // --- rate limiting ---------------------------------------------------
        this.rateLimitGlobal = {
      windowMs: Number(env.RATE_LIMIT_GLOBAL_WINDOW_MS || 5 * 60 * 1000),
      max: Number(env.RATE_LIMIT_GLOBAL_MAX || (this.isTest ? 100000 : 600)),
    };
    this.rateLimitAuth = {
      windowMs: Number(env.RATE_LIMIT_AUTH_WINDOW_MS || 5 * 60 * 1000),
      max: Number(env.RATE_LIMIT_AUTH_MAX || (this.isTest ? 100000 : 30)),
    };

    // --- care network: subscriptions + doctor console ---------------------
    // DEMO MODE: a doctor who applies is activated immediately with a mock
    // KYC reference so the hackathon demo needs no verification queue.
    // Production must set DOCTOR_AUTO_APPROVE=false and wire a real process.
    this.doctorAutoApprove = env.DOCTOR_AUTO_APPROVE
      ? env.DOCTOR_AUTO_APPROVE !== 'false'
      : !this.isProd;
    // There is no real KYC/registry integration anywhere in this build; the
    // value is echoed in API responses and badged "MOCK" in every UI surface.
    this.doctorKycMode = 'mock';
    // A medical council certificate (PDF/JPEG/PNG) is read before a doctor
    // account is allowed into the console. 4 MB covers a council PDF or a
    // straight-on phone photo of the certificate without inviting abuse.
    this.maxCertificateBytes = Math.max(
      64 * 1024,
      Math.round(Number(env.MAX_CERTIFICATE_MB || 4) * 1024 * 1024),
    );
    // How long a patient's chart consent to a doctor lasts once a
    // consultation is booked (patient can revoke at any time before then).
    this.consentDefaultDays = Number(env.CONSENT_DEFAULT_DAYS || 30);
    // Shorts are small by design ("why should a doctor record a lecture?"):
    // 25 MB default holds a phone-shot 45-90s clip at 1080p comfortably.
    // Rounded: multer's limit validator only accepts integers.
    this.maxVideoUploadBytes = Math.max(1024, Math.round(Number(env.MAX_VIDEO_MB || 25) * 1024 * 1024));
    // Expiring, HMAC-signed playback URLs — paid content must not be a
    // guessable static path. 15 minutes covers a clinic session's watching.
    this.videoTtlSec = Number(env.VIDEO_URL_TTL_SEC || 900);
    this.mediaSigningSecret = env.MEDIA_SIGNING_SECRET || `${this.jwtSecret}:care-media`;
    this.videoDir = env.VIDEO_DIR || `${this.uploadDir}/videos`;
    this.paymentsMode = 'mock'; // never 'live' in this build

    // --- AI providers (cost-free by default) ------------------------------
    this.ocrProvider = env.OCR_PROVIDER || 'auto'; // auto -> plain-text, optional tesseract
    this.llmProvider = env.LLM_PROVIDER || 'grounded-local'; // deterministic, offline, free

    this.appVersion = env.APP_VERSION || '0.1.0';
  }

  isOriginAllowed(origin, requestOrigin = null) {
    if (!origin) return true; // non-browser clients (curl, native apps)

    const normalizedOrigin = String(origin).trim().replace(/\/+$/, '');
    // A same-origin browser request is always safe, including in production.
    // This matters when the dashboard and API are served by this same server:
    // production intentionally disables the development hostname regexes, but
    // must not disable the app's own login form with it.
    if (requestOrigin) {
      const normalizedRequestOrigin = String(requestOrigin).trim().replace(/\/+$/, '');
      if (normalizedOrigin === normalizedRequestOrigin) return true;
    }
    if (this.corsAllowedOrigins.includes(normalizedOrigin)) return true;
    return this.corsAllowOriginRegexes.some((re) => re.test(normalizedOrigin));
  }
}
