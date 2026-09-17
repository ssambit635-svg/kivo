import { Router } from 'express';
import multer from 'multer';
import { validate } from '../middleware/validate.js';
import { authSchemas } from '../controllers/AuthController.js';
import { memberSchemas } from '../controllers/MemberController.js';
import { reportSchemas } from '../controllers/ReportController.js';
import { healthSchemas } from '../controllers/HealthIntelController.js';
import { adminSchemas } from '../controllers/AdminController.js';
import { intelligenceSchemas } from '../controllers/IntelligenceController.js';

/** Builds and wires every API route against the container. */
export function buildApiRouter(c) {
  const r = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: c.config.maxUploadBytes, files: 1 },
  });

  // ---------- system ----------
  r.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: c.config.appVersion, uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() });
  });
  // The lab dictionary is public (read-only knowledge, no user data): clients
  // render ranges and names from it. `?tier=all` exposes the full catalogue.
  r.get('/meta/lab-dictionary', (req, res) =>
    res.json({ markers: c.extractionService.dictionary({ tier: req.query.tier === 'all' ? 'all' : 'core' }) }),
  );
  // Transparency surface: exactly what the clinical knowledge base contains,
  // where it came from (commit pin + licence), and how the extraction
  // confidence was calibrated. No patient data, no user data.
  r.get('/meta/knowledge', (_req, res) => res.json(c.knowledgeReport ? c.knowledgeReport() : { stats: null }));

  // ---------- auth (strict rate limit bucket) ----------
  const auth = Router();
  auth.use(c.authRateLimiter.middleware());
  auth.post('/register', validate({ body: authSchemas.register }), c.authController.register);
  auth.post('/login', validate({ body: authSchemas.login }), c.authController.login);
  auth.post('/refresh', validate({ body: authSchemas.refresh }), c.authController.refresh);
  auth.post('/logout', validate({ body: authSchemas.logout }), c.authController.logout);
  auth.post('/logout-all', c.authenticateMw, c.authController.logoutAll);
  auth.post('/change-password', c.authenticateMw, validate({ body: authSchemas.changePassword }), c.authController.changePassword);
  auth.get('/me', c.authenticateMw, c.authController.me);
  r.use('/auth', auth);

  // ---------- authenticated API ----------
  // Auth is attached PER ROUTE (not as a blanket router.use) so that
  // unknown paths fall through to the 404 handler instead of 401.
  const secure = (method, path, ...handlers) => r[method](path, c.authenticateMw, ...handlers);

  secure('get', '/profile', (req, res) => res.json({ user: req.actor.toJSON() }));

  // members
  secure('get', '/members', c.memberController.list);
  secure('post', '/members', validate({ body: memberSchemas.create }), c.memberController.create);
  secure('get', '/members/:memberId', validate({ params: memberSchemas.memberParams }), c.memberController.get);
  secure('patch', '/members/:memberId', validate({ params: memberSchemas.memberParams, body: memberSchemas.update }), c.memberController.update);
  secure('delete', '/members/:memberId', validate({ params: memberSchemas.memberParams }), c.memberController.remove);
  secure('get', '/members/:memberId/shares', validate({ params: memberSchemas.memberParams }), c.memberController.listShares);
  secure('post', '/members/:memberId/shares', validate({ params: memberSchemas.memberParams, body: memberSchemas.share }), c.memberController.grantShare);
  secure('delete', '/members/:memberId/shares/:granteeUserId', validate({ params: memberSchemas.revokeShareParams }), c.memberController.revokeShare);

  // reports
  secure(
    'post',
    '/members/:memberId/reports',
    validate({ params: reportSchemas.memberParams }),
    upload.single('file'),
    c.reportController.ingest,
  );
  secure(
    'get',
    '/members/:memberId/reports',
    validate({ params: reportSchemas.memberParams, query: reportSchemas.listQuery }),
    c.reportController.list,
  );
  secure('get', '/reports/:reportId', validate({ params: reportSchemas.reportParams }), c.reportController.get);
  secure('patch', '/reports/:reportId', validate({ params: reportSchemas.reportParams, body: reportSchemas.updateMeta }), c.reportController.updateMeta);
  secure('delete', '/reports/:reportId', validate({ params: reportSchemas.reportParams }), c.reportController.remove);
  secure('post', '/reports/:reportId/lab-results', validate({ params: reportSchemas.reportParams, body: reportSchemas.addLab }), c.reportController.addLabResult);
  secure('patch', '/lab-results/:labId', validate({ params: reportSchemas.labParams, body: reportSchemas.updateLab }), c.reportController.updateLabResult);
  secure('delete', '/lab-results/:labId', validate({ params: reportSchemas.labParams }), c.reportController.deleteLabResult);
  secure('post', '/reports/:reportId/verify', validate({ params: reportSchemas.reportParams, body: reportSchemas.verify }), c.reportController.verify);
  secure('post', '/reports/:reportId/unverify', validate({ params: reportSchemas.reportParams }), c.reportController.unverify);
  secure('get', '/reports/:reportId/explanation', validate({ params: reportSchemas.reportParams }), c.reportController.explain);

  // observations
  secure('post', '/members/:memberId/observations', validate({ params: healthSchemas.memberParams, body: healthSchemas.createObservation }), c.healthIntelController.createObservation);
  secure('get', '/members/:memberId/observations', validate({ params: healthSchemas.memberParams, query: healthSchemas.listObservationsQuery }), c.healthIntelController.listObservations);
  secure('delete', '/observations/:observationId', validate({ params: healthSchemas.observationParams }), c.healthIntelController.deleteObservation);

  // intelligence
  secure('get', '/members/:memberId/trends', validate({ params: healthSchemas.memberParams, query: healthSchemas.trendsQuery }), c.healthIntelController.getTrends);
  secure('post', '/members/:memberId/risk/diabetes', validate({ params: healthSchemas.memberParams, body: healthSchemas.riskAssess }), c.healthIntelController.assessRisk);
  secure('get', '/members/:memberId/doctor-summary', validate({ params: healthSchemas.memberParams }), c.healthIntelController.getDoctorSummary);
  secure('get', '/members/:memberId/health-score', validate({ params: healthSchemas.memberParams }), c.healthIntelController.getHealthScore);
  secure('get', '/members/:memberId/milestones', validate({ params: healthSchemas.memberParams }), c.healthIntelController.getMilestones);

  // personal health intelligence engine (ADD-ON — read-only computations + hypothetical scenarios)
  secure('get', '/members/:memberId/intelligence', validate({ params: intelligenceSchemas.memberParams }), c.intelligenceController.getIntelligence);
  secure('get', '/members/:memberId/intelligence/baseline', validate({ params: intelligenceSchemas.memberParams, query: intelligenceSchemas.baselineQuery }), c.intelligenceController.getBaseline);
  secure('get', '/members/:memberId/intelligence/patterns', validate({ params: intelligenceSchemas.memberParams, query: intelligenceSchemas.patternsQuery }), c.intelligenceController.getPatterns);
  secure('post', '/members/:memberId/intelligence/simulate', validate({ params: intelligenceSchemas.memberParams, body: intelligenceSchemas.simulate }), c.intelligenceController.simulate);
  secure('post', '/members/:memberId/intelligence/scenarios', validate({ params: intelligenceSchemas.memberParams, body: intelligenceSchemas.scenarios }), c.intelligenceController.exploreScenarios);
  secure('get', '/members/:memberId/intelligence/explanation', validate({ params: intelligenceSchemas.memberParams }), c.intelligenceController.explain);

  // admin
  secure('get', '/admin/users', validate({ query: adminSchemas.listUsersQuery }), c.adminController.listUsers);
  secure('post', '/admin/users/:userId/status', validate({ params: adminSchemas.userParams, body: adminSchemas.setStatus }), c.adminController.setUserStatus);
  secure('get', '/admin/audit', validate({ query: adminSchemas.auditQuery }), c.adminController.listAudit);

  return r;
}
