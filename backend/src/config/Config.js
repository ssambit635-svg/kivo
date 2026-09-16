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
    this.refreshTokenTtlSec = Number(env.REFRESH_TOKEN_TTL_SEC || 7 * 24 * 3600); // 7 days
    this.loginMaxFailedAttempts = Number(env.LOGIN_MAX_FAILED_ATTEMPTS || 5);
    this.lockoutMinutes = Number(env.LOCKOUT_MINUTES || 15);

    // password hashing (scrypt) parameters
    this.scrypt = { N: 16384, r: 8, p: 1, keylen: 64 };
    if (this.isTest) this.scrypt.N = 4096; // keep test suite fast, still scrypt

    // --- persistence -----------------------------------------------------
    this.dbPath = env.DB_PATH || (this.isTest ? ':memory:' : 'data/medtwin.db');
    this.uploadDir = env.UPLOAD_DIR || 'uploads';
    this.maxUploadBytes = Number(env.MAX_UPLOAD_MB || 5) * 1024 * 1024;

    // --- CORS ------------------------------------------------------------
    this.corsAllowedOrigins = (env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // E2B / arena live-preview hostnames + local dev frontends are allowed by default
    // outside production. In production you must set CORS_ORIGINS explicitly.
    this.corsAllowOriginRegexes = [];
    if (!this.isProd) {
      this.corsAllowOriginRegexes.push(/^https:\/\/[\w-]+\.e2b\.app$/);
      this.corsAllowOriginRegexes.push(/^https?:\/\/localhost(:\d+)?$/);
      this.corsAllowOriginRegexes.push(/^https?:\/\/127\.0\.0\.1(:\d+)?$/);
    }

    // --- rate limiting ---------------------------------------------------
    this.rateLimitGlobal = {
      windowMs: Number(env.RATE_LIMIT_GLOBAL_WINDOW_MS || 5 * 60 * 1000),
      max: Number(env.RATE_LIMIT_GLOBAL_MAX || (this.isTest ? 100000 : 600)),
    };
    this.rateLimitAuth = {
      windowMs: Number(env.RATE_LIMIT_AUTH_WINDOW_MS || 5 * 60 * 1000),
      max: Number(env.RATE_LIMIT_AUTH_MAX || (this.isTest ? 100000 : 30)),
    };

    // --- AI providers (cost-free by default) ------------------------------
    this.ocrProvider = env.OCR_PROVIDER || 'auto'; // auto -> plain-text, optional tesseract
    this.llmProvider = env.LLM_PROVIDER || 'grounded-local'; // deterministic, offline, free

    this.appVersion = env.APP_VERSION || '0.1.0';
  }

  isOriginAllowed(origin) {
    if (!origin) return true; // non-browser clients (curl, native apps)
    if (this.corsAllowedOrigins.includes(origin)) return true;
    return this.corsAllowOriginRegexes.some((re) => re.test(origin));
  }
}
