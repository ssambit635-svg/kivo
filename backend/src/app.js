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
    cors({
      origin(origin, cb) {
        if (container.config.isOriginAllowed(origin)) return cb(null, true);
        return cb(new ForbiddenError(`Origin '${origin}' is not allowed by CORS policy`, 'CORS_DENIED'));
      },
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      maxAge: 600,
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

  app.get('/', (_req, res) => {
    res.json({
      name: 'MedTwin AI Backend',
      version: container.config.appVersion,
      docs: 'See backend/README.md',
      health: '/api/health',
      ...(frontendDir ? { dashboard: '/app/' } : {}),
    });
  });

  if (frontendDir) {
    // express.static redirects /app → /app/ itself (directory redirect).
    app.use('/app', express.static(frontendDir, { index: 'index.html', maxAge: '5m' }));
  }

  // /api is never cacheable — health data must not persist in browser/proxy caches.
  app.use('/api', apiNoStore(), buildApiRouter(container));

  app.use(notFoundHandler());
  app.use(errorHandler());
  return app;
}
