import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApiRouter } from './routes/api.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiNoStore, permissionsPolicy } from './middleware/securityHeaders.js';
import { ForbiddenError } from './common/errors.js';

/** Absolute path of the bundled demo dashboard, or null when it isn't shipped. */
function resolveFrontendDir() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
  return fs.existsSync(path.join(dir, 'index.html')) ? dir : null;
}

/**
 * Creates the Express app. Pure function of a container — tests build the
 * same app the server boots, with an in-memory DB.
 */
export function createApp(container) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // preview/edge proxies terminate TLS in front of us

  app.use(requestId());
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          // blob: is required for client-side photo downscaling (gallery
          // picks are loaded via object URLs, resized on canvas, then
          // uploaded). Blob URLs can only be created by our own origin's
          // scripts, so this stays same-origin safe.
          'img-src': ["'self'", 'data:', 'blob:'],
        },
      },
    }),
  );
  app.use(permissionsPolicy());
  app.use(
    // Use cors's per-request options delegate so the origin check can compare
    // the browser Origin with the actual host/protocol of this request. A
    // static origin callback cannot see the request and would reject a
    // same-origin production deployment with an empty CORS_ORIGINS list.
    cors((req, callback) => {
      const requestOrigin = `${req.protocol}://${req.get('host')}`;
      callback(null, {
        origin(origin, cb) {
          if (container.config.isOriginAllowed(origin, requestOrigin)) return cb(null, true);
          return cb(new ForbiddenError(`Origin '${origin}' is not allowed by CORS policy`, 'CORS_DENIED'));
        },
        preflightContinue: false,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
        maxAge: 600,
      });
    }),
  );
  // Automated abuse detection: blocks IPs with many cross-endpoint 401/403
  // failures (audit-alerted). Runs before rate limiting and every route.
  app.use(container.securityMonitor.middleware());
  app.use(container.globalRateLimiter.middleware());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Cost-free demo dashboard (vanilla HTML/CSS/JS, zero build step, real SVG
  // icons). Served only when the frontend directory is present in the repo.
  const frontendDir = resolveFrontendDir();

  // Marketing landing (sofiahealth-style page) lives at the root for
  // browsers; non-HTML clients (curl, tests, monitoring) keep the JSON
  // metadata — see the content negotiation below.
  let landingDir = null;
  let mobileDir = null;
  if (frontendDir) {
    const dir = path.join(frontendDir, 'landing');
    if (fs.existsSync(path.join(dir, 'index.html'))) landingDir = dir;
    const mDir = path.join(frontendDir, 'm');
    if (fs.existsSync(path.join(mDir, 'index.html'))) mobileDir = mDir;
  }

  // Direct APK auto-download endpoints
  app.get(['/download/apk', '/kivo.apk'], (req, res) => {
    const apkFile = frontendDir && path.join(frontendDir, 'kivo.apk');
    if (apkFile && fs.existsSync(apkFile)) {
      res.setHeader('Content-Disposition', 'attachment; filename="kivo.apk"');
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      return res.sendFile(apkFile);
    }
    res.status(404).json({ error: 'APK package not found' });
  });

  app.get('/', (req, res) => {
    if (frontendDir && /kivo-android\//i.test(req.get('user-agent') || '')) {
      return res.set('Cache-Control', 'no-store').redirect(302, '/app/');
    }
    const meta = {
      // Deliberately product metadata only: no service name, no internal paths.
      name: 'kivo',
      version: container.config.appVersion,
      health: '/api/health',
      ...(frontendDir ? { dashboard: '/app/', doctorConsole: '/doctor/', mobileApp: '/m/', downloadApk: '/download/apk' } : {}),
      ...(landingDir ? { landing: '/' } : {}),
    };
    // Browsers send `Accept: text/html,…` — give them the landing page.
    // Anything else (supertest's `*/*`, curl, health probes) keeps the JSON.
    const wantsHtml = /text\/html/i.test(req.headers.accept || '');
    if (landingDir && wantsHtml) {
      res.sendFile(path.join(landingDir, 'index.html'));
    } else {
      res.json(meta);
    }
  });

  if (frontendDir) {
    // Dedicated mobile frontend (/m/)
    if (mobileDir) {
      app.get(['/m', '/m/', '/m/index.html'], (_req, res) => res.set('Cache-Control', 'no-store').redirect(302, '/app/'));
      app.use('/m', express.static(mobileDir, { index: false, maxAge: 0 }));
    }

    // express.static redirects /app → /app/ itself (directory redirect).
    app.use('/app', express.static(frontendDir, { index: 'index.html', maxAge: 0 }));

    // The doctor console is a SEPARATE frontend for a separate role. It lives
    // in frontend/doctor/ and reuses the patient app's design tokens/icons via
    // /app/… so the two consoles never drift apart visually.
    const doctorDir = path.join(frontendDir, 'doctor');
    if (fs.existsSync(path.join(doctorDir, 'index.html'))) {
      app.use('/doctor', express.static(doctorDir, { index: 'index.html', maxAge: 0 }));
    }
  }

  // /api is never cacheable — health data must not persist in browser/proxy caches.
  app.use('/api', apiNoStore(), buildApiRouter(container));

  // Landing assets at the root (/styles.css, /js/…, /vendor/…, /fonts/…,
  // /models/…). index:false — the root route above owns '/'.
  if (landingDir) {
    app.use('/', express.static(landingDir, { index: false, maxAge: 0 }));
  }

  app.use(notFoundHandler());
  app.use(errorHandler());
  return app;
}
