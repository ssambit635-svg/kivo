import { Router } from 'express';
import multer from 'multer';
import { validate } from '../middleware/validate.js';
import { authSchemas } from '../controllers/AuthController.js';
import { memberSchemas } from '../controllers/MemberController.js';
import { reportSchemas } from '../controllers/ReportController.js';
import { healthSchemas } from '../controllers/HealthIntelController.js';
import { adminSchemas } from '../controllers/AdminController.js';
import { intelligenceSchemas } from '../controllers/IntelligenceController.js';
import { reminderSchemas } from '../controllers/ReminderController.js';
import { askTwinSchemas } from '../controllers/AskTwinController.js';
import { careSchemas } from '../controllers/CareController.js';
import { doctorSchemas } from '../controllers/DoctorConsoleController.js';

/** Builds and wires every API route against the container. */
export function buildApiRouter(c) {
  const r = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: c.config.maxUploadBytes, files: 1 },
  });

  // Doctor shorts have their own (larger) cap — still one file, memory-buffered
  // because the service validates the mime type before anything touches disk.
  const videoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: c.config.maxVideoUploadBytes, files: 1 },
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
  // Health-twin endpoints are patient-only: a doctor account has no health
  // twin and must not use the patient API as a back door to someone's chart.
  const patientSecure = (method, path, ...handlers) =>
    r[method](path, c.authenticateMw, c.patientOnlyMw, ...handlers);
  // The doctor console is a separate surface with its own role gate.
  const doctorSecure = (method, path, ...handlers) =>
    r[method](path, c.authenticateMw, c.requireDoctorMw, ...handlers);

  secure('get', '/profile', (req, res) => res.json({ user: req.actor.toJSON() }));
  secure('get', '/profile/export', c.authController.exportMyData);
  secure('delete', '/profile', validate({ body: authSchemas.deleteAccount }), c.authController.deleteMe);

  // members
  patientSecure('get', '/members', c.memberController.list);
  patientSecure('post', '/members', validate({ body: memberSchemas.create }), c.memberController.create);
  patientSecure('get', '/members/:memberId', validate({ params: memberSchemas.memberParams }), c.memberController.get);
  patientSecure('patch', '/members/:memberId', validate({ params: memberSchemas.memberParams, body: memberSchemas.update }), c.memberController.update);
  patientSecure('delete', '/members/:memberId', validate({ params: memberSchemas.memberParams }), c.memberController.remove);
  patientSecure('get', '/members/:memberId/family-history', validate({ params: memberSchemas.memberParams }), c.memberController.familyHistory);
  patientSecure('get', '/members/:memberId/shares', validate({ params: memberSchemas.memberParams }), c.memberController.listShares);
  patientSecure('post', '/members/:memberId/shares', validate({ params: memberSchemas.memberParams, body: memberSchemas.share }), c.memberController.grantShare);
  patientSecure('delete', '/members/:memberId/shares/:granteeUserId', validate({ params: memberSchemas.revokeShareParams }), c.memberController.revokeShare);

  // reports
  patientSecure(
    'post',
    '/members/:memberId/reports',
    validate({ params: reportSchemas.memberParams }),
    upload.single('file'),
    c.reportController.ingest,
  );
  patientSecure(
    'get',
    '/members/:memberId/reports',
    validate({ params: reportSchemas.memberParams, query: reportSchemas.listQuery }),
    c.reportController.list,
  );
  patientSecure('get', '/reports/:reportId', validate({ params: reportSchemas.reportParams }), c.reportController.get);
  patientSecure('patch', '/reports/:reportId', validate({ params: reportSchemas.reportParams, body: reportSchemas.updateMeta }), c.reportController.updateMeta);
  patientSecure('delete', '/reports/:reportId', validate({ params: reportSchemas.reportParams }), c.reportController.remove);
  patientSecure('post', '/reports/:reportId/lab-results', validate({ params: reportSchemas.reportParams, body: reportSchemas.addLab }), c.reportController.addLabResult);
  patientSecure('patch', '/lab-results/:labId', validate({ params: reportSchemas.labParams, body: reportSchemas.updateLab }), c.reportController.updateLabResult);
  patientSecure('delete', '/lab-results/:labId', validate({ params: reportSchemas.labParams }), c.reportController.deleteLabResult);
  patientSecure('post', '/reports/:reportId/verify', validate({ params: reportSchemas.reportParams, body: reportSchemas.verify }), c.reportController.verify);
  patientSecure('post', '/reports/:reportId/unverify', validate({ params: reportSchemas.reportParams }), c.reportController.unverify);
  patientSecure('get', '/reports/:reportId/explanation', validate({ params: reportSchemas.reportParams }), c.reportController.explain);

  // observations
  patientSecure('post', '/members/:memberId/observations', validate({ params: healthSchemas.memberParams, body: healthSchemas.createObservation }), c.healthIntelController.createObservation);
  patientSecure('get', '/members/:memberId/observations', validate({ params: healthSchemas.memberParams, query: healthSchemas.listObservationsQuery }), c.healthIntelController.listObservations);
  patientSecure('delete', '/observations/:observationId', validate({ params: healthSchemas.observationParams }), c.healthIntelController.deleteObservation);

  // intelligence
  patientSecure('get', '/members/:memberId/trends', validate({ params: healthSchemas.memberParams, query: healthSchemas.trendsQuery }), c.healthIntelController.getTrends);
  patientSecure('post', '/members/:memberId/risk/diabetes', validate({ params: healthSchemas.memberParams, body: healthSchemas.riskAssess }), c.healthIntelController.assessRisk);
  patientSecure('get', '/members/:memberId/doctor-summary', validate({ params: healthSchemas.memberParams }), c.healthIntelController.getDoctorSummary);
  patientSecure('get', '/members/:memberId/health-score', validate({ params: healthSchemas.memberParams }), c.healthIntelController.getHealthScore);
  patientSecure('get', '/members/:memberId/milestones', validate({ params: healthSchemas.memberParams }), c.healthIntelController.getMilestones);
  patientSecure('get', '/members/:memberId/guidance', validate({ params: healthSchemas.memberParams }), c.healthIntelController.getGuidance);
  patientSecure('get', '/members/:memberId/medication-awareness', validate({ params: healthSchemas.memberParams }), c.healthIntelController.getMedicationAwareness);

  // reminders (§10.6 + §13: medication / checkup / follow-up / report-upload nudges)
  patientSecure('post', '/members/:memberId/reminders', validate({ params: reminderSchemas.memberParams, body: reminderSchemas.create }), c.reminderController.create);
  patientSecure('get', '/members/:memberId/reminders', validate({ params: reminderSchemas.memberParams, query: reminderSchemas.listQuery }), c.reminderController.list);
  patientSecure('get', '/members/:memberId/reminders/due', validate({ params: reminderSchemas.memberParams }), c.reminderController.due);
  patientSecure('patch', '/reminders/:reminderId', validate({ params: reminderSchemas.reminderParams, body: reminderSchemas.update }), c.reminderController.update);
  patientSecure('delete', '/reminders/:reminderId', validate({ params: reminderSchemas.reminderParams }), c.reminderController.remove);

  // personal health intelligence engine (ADD-ON — read-only computations + hypothetical scenarios)
  patientSecure('get', '/members/:memberId/intelligence', validate({ params: intelligenceSchemas.memberParams }), c.intelligenceController.getIntelligence);
  patientSecure('get', '/members/:memberId/intelligence/baseline', validate({ params: intelligenceSchemas.memberParams, query: intelligenceSchemas.baselineQuery }), c.intelligenceController.getBaseline);
  patientSecure('get', '/members/:memberId/intelligence/patterns', validate({ params: intelligenceSchemas.memberParams, query: intelligenceSchemas.patternsQuery }), c.intelligenceController.getPatterns);
  patientSecure('post', '/members/:memberId/intelligence/simulate', validate({ params: intelligenceSchemas.memberParams, body: intelligenceSchemas.simulate }), c.intelligenceController.simulate);
  patientSecure('post', '/members/:memberId/intelligence/scenarios', validate({ params: intelligenceSchemas.memberParams, body: intelligenceSchemas.scenarios }), c.intelligenceController.exploreScenarios);
  patientSecure('get', '/members/:memberId/intelligence/explanation', validate({ params: intelligenceSchemas.memberParams }), c.intelligenceController.explain);

  // Ask the Twin — grounded Q&A over the member's Digital Health Twin.
  // Read-only: same authorization surface as trends (owner/editor/viewer).
  patientSecure('post', '/members/:memberId/ask', validate({ params: askTwinSchemas.memberParams, body: askTwinSchemas.ask }), c.askTwinController.ask);
  patientSecure('get', '/members/:memberId/ask/suggestions', validate({ params: askTwinSchemas.memberParams }), c.askTwinController.suggestions);

  // ---------- care network: subscriptions, doctors, consultations, shorts ----------
  // Public catalog + directory (no user data is exposed on these paths).
  r.get('/public/plans', c.careController.plans);
  r.get('/public/doctors', validate({ query: careSchemas.doctorListQuery }), c.careController.directory);
  r.get('/public/doctors/specialties', c.careController.specialties);
  r.get('/public/doctors/:doctorId', validate({ params: careSchemas.doctorParams }), c.careController.doctorProfile);
  r.post('/doctor/apply', c.authRateLimiter.middleware(), validate({ body: doctorSchemas.apply }), c.doctorConsoleController.apply);
  // Signed, expiring media stream (the signature is the authorization).
  r.get('/media/videos/:videoId', validate({ params: careSchemas.videoParams }), c.careController.mediaStream);

  // patient side of the care network
  patientSecure('get', '/care/home', c.careController.home);
  patientSecure('get', '/care/plans', c.careController.plans);
  patientSecure('get', '/care/entitlements', c.careController.entitlements);
  patientSecure('post', '/care/subscription', validate({ body: careSchemas.subscribe }), c.careController.subscribe);
  patientSecure('delete', '/care/subscription', c.careController.cancelSubscription);
  patientSecure('get', '/care/payments', c.careController.payments);
  patientSecure('post', '/care/payments', validate({ body: careSchemas.paymentIntent }), c.careController.createIntent);
  patientSecure(
    'post',
    '/care/payments/:intentId/confirm',
    validate({ params: careSchemas.intentParams, body: careSchemas.confirmPayment }),
    c.careController.confirmIntent,
  );
  patientSecure('get', '/care/doctors', validate({ query: careSchemas.doctorListQuery }), c.careController.directory);
  patientSecure('get', '/care/doctors/specialties', c.careController.specialties);
  patientSecure('get', '/care/doctors/:doctorId', validate({ params: careSchemas.doctorParams }), c.careController.doctorProfile);
  patientSecure(
    'post',
    '/care/consultations',
    validate({ body: careSchemas.bookConsultation }),
    c.careController.bookConsultation,
  );
  patientSecure(
    'get',
    '/care/consultations',
    validate({ query: careSchemas.consultationListQuery }),
    c.careController.myConsultations,
  );
  patientSecure('get', '/care/consultations/:consultationId', validate({ params: careSchemas.consultationParams }), c.careController.myConsultation);
  patientSecure(
    'post',
    '/care/consultations/:consultationId/messages',
    validate({ params: careSchemas.consultationParams, body: careSchemas.message }),
    c.careController.postMessage,
  );
  patientSecure(
    'post',
    '/care/consultations/:consultationId/consent/revoke',
    validate({ params: careSchemas.consultationParams }),
    c.careController.revokeConsent,
  );
  patientSecure(
    'post',
    '/care/consultations/:consultationId/close',
    validate({ params: careSchemas.consultationParams }),
    c.careController.closeConsultation,
  );
  patientSecure('get', '/care/videos', validate({ query: careSchemas.videoFeedQuery }), c.careController.videoFeed);
  patientSecure('post', '/care/videos/:videoId/playback', validate({ params: careSchemas.videoParams }), c.careController.playback);
  patientSecure(
    'post',
    '/care/videos/:videoId/views',
    validate({ params: careSchemas.videoParams, body: careSchemas.watch }),
    c.careController.watch,
  );

  // doctor console
  doctorSecure('get', '/doctor/overview', c.doctorConsoleController.overview);
  // Onboarding trio: authenticated, but usable BEFORE activation (a pending
  // doctor must be able to finish verification) — the service enforces profile rules.
  secure('get', '/doctor/me', c.doctorConsoleController.me);
  secure('patch', '/doctor/profile', validate({ body: doctorSchemas.profileUpdate }), c.doctorConsoleController.updateProfile);
  secure('post', '/doctor/kyc/mock', validate({ body: doctorSchemas.mockKyc }), c.doctorConsoleController.mockKyc);
  secure('get', '/doctor/identity-card', c.doctorConsoleController.identityCard);
  doctorSecure('get', '/doctor/revenue-model', c.doctorConsoleController.revenueModel);
  doctorSecure('get', '/doctor/videos', c.doctorConsoleController.library);
  doctorSecure('get', '/doctor/videos/recommendable', c.doctorConsoleController.recommendable);
  doctorSecure(
    'post',
    '/doctor/videos',
    videoUpload.single('file'),
    validate({ body: doctorSchemas.videoCreate }),
    c.doctorConsoleController.publishVideo,
  );
  doctorSecure('patch', '/doctor/videos/:videoId', validate({ params: doctorSchemas.videoParams, body: doctorSchemas.videoUpdate }), c.doctorConsoleController.updateVideo);
  doctorSecure('delete', '/doctor/videos/:videoId', validate({ params: doctorSchemas.videoParams }), c.doctorConsoleController.archiveVideo);
  doctorSecure('get', '/doctor/consultations', validate({ query: doctorSchemas.inboxQuery }), c.doctorConsoleController.inbox);
  doctorSecure('get', '/doctor/consultations/:consultationId', validate({ params: doctorSchemas.consultationParams }), c.doctorConsoleController.consultation);
  doctorSecure('post', '/doctor/consultations/:consultationId/accept', validate({ params: doctorSchemas.consultationParams }), c.doctorConsoleController.acceptConsultation);
  doctorSecure('post', '/doctor/consultations/:consultationId/reply', validate({ params: doctorSchemas.consultationParams, body: doctorSchemas.reply }), c.doctorConsoleController.reply);
  doctorSecure('post', '/doctor/consultations/:consultationId/close', validate({ params: doctorSchemas.consultationParams }), c.doctorConsoleController.closeConsultation);
  doctorSecure('post', '/doctor/consultations/:consultationId/medicine-draft', validate({ params: doctorSchemas.consultationParams }), c.doctorConsoleController.draftMedicine);
  doctorSecure('post', '/doctor/consultations/:consultationId/medicine-plan/approve', validate({ params: doctorSchemas.consultationParams, body: doctorSchemas.approvePlan }), c.doctorConsoleController.approveMedicine);
  doctorSecure('post', '/doctor/consultations/:consultationId/medicine-plan/reject', validate({ params: doctorSchemas.consultationParams }), c.doctorConsoleController.rejectMedicine);
  doctorSecure('get', '/doctor/earnings', validate({ query: doctorSchemas.earningsQuery }), c.doctorConsoleController.earnings);

  // admin
  secure('get', '/admin/doctors', validate({ query: doctorSchemas.adminDoctorQuery }), c.careAdminController.listDoctors);
  secure('post', '/admin/doctors/:doctorId/status', validate({ params: doctorSchemas.adminDoctorParams, body: doctorSchemas.adminDoctorStatus }), c.careAdminController.setDoctorStatus);
  secure('post', '/admin/payouts/settle', validate({ body: doctorSchemas.settlePayouts }), c.careAdminController.settlePayouts);
  secure('get', '/admin/users', validate({ query: adminSchemas.listUsersQuery }), c.adminController.listUsers);
  secure('post', '/admin/users/:userId/status', validate({ params: adminSchemas.userParams, body: adminSchemas.setStatus }), c.adminController.setUserStatus);
  secure('get', '/admin/audit', validate({ query: adminSchemas.auditQuery }), c.adminController.listAudit);

  return r;
}
