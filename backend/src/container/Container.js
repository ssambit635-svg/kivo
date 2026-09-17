import { Config } from '../config/Config.js';
import { Database } from '../db/Database.js';
import { RateLimiter } from '../middleware/rateLimit.js';
import { authenticate } from '../middleware/authenticate.js';

import { UserRepository } from '../repositories/UserRepository.js';
import { RefreshTokenRepository } from '../repositories/RefreshTokenRepository.js';
import { MemberRepository } from '../repositories/MemberRepository.js';
import { ReportRepository } from '../repositories/ReportRepository.js';
import { LabResultRepository } from '../repositories/LabResultRepository.js';
import { ObservationRepository } from '../repositories/ObservationRepository.js';
import { AuditLogRepository } from '../repositories/AuditLogRepository.js';

import { PasswordService } from '../services/PasswordService.js';
import { TokenService } from '../services/TokenService.js';
import { AuthService } from '../services/AuthService.js';
import { AuditService } from '../services/AuditService.js';
import { PolicyService } from '../services/PolicyService.js';
import { MemberService } from '../services/MemberService.js';
import { ReportService } from '../services/ReportService.js';
import { ObservationService } from '../services/ObservationService.js';
import { TrendService } from '../services/TrendService.js';
import { RiskModelService } from '../services/RiskModelService.js';
import { DoctorSummaryService } from '../services/DoctorSummaryService.js';
import { HealthScoreService } from '../services/HealthScoreService.js';
import { MilestoneService } from '../services/MilestoneService.js';
import { AdminService } from '../services/AdminService.js';
import { LabExtractionService } from '../services/labs/LabExtractionService.js';
import { knowledgeReport } from '../knowledge/report.js';
import { OcrService } from '../services/ocr/OcrService.js';
import { LlmGateway } from '../services/llm/LlmGateway.js';
import { PersonalBaselineService } from '../services/intelligence/PersonalBaselineService.js';
import { TemporalAnomalyService } from '../services/intelligence/TemporalAnomalyService.js';
import { HealthPatternGraphService } from '../services/intelligence/HealthPatternGraphService.js';
import { CounterfactualTwinService } from '../services/intelligence/CounterfactualTwinService.js';
import { IntelligenceOrchestratorService } from '../services/intelligence/IntelligenceOrchestratorService.js';
import { IntelligenceExplanationService } from '../services/intelligence/IntelligenceExplanationService.js';

import { AuthController } from '../controllers/AuthController.js';
import { MemberController } from '../controllers/MemberController.js';
import { ReportController } from '../controllers/ReportController.js';
import { HealthIntelController } from '../controllers/HealthIntelController.js';
import { AdminController } from '../controllers/AdminController.js';
import { IntelligenceController } from '../controllers/IntelligenceController.js';

/**
 * Dependency-injection container — manual, explicit, test-friendly.
 * Tests may pass overrides for any edge (e.g. a fake OCR provider).
 */
export class Container {
  constructor({ config = new Config(), ocrService = null } = {}) {
    this.config = config;

    // --- infrastructure ---
    this.db = new Database(config.dbPath);
    this.globalRateLimiter = new RateLimiter({ ...config.rateLimitGlobal, name: 'global' });
    this.authRateLimiter = new RateLimiter({ ...config.rateLimitAuth, name: 'auth' });

    // --- repositories ---
    this.userRepository = new UserRepository(this.db);
    this.refreshTokenRepository = new RefreshTokenRepository(this.db);
    this.memberRepository = new MemberRepository(this.db);
    this.reportRepository = new ReportRepository(this.db);
    this.labResultRepository = new LabResultRepository(this.db);
    this.observationRepository = new ObservationRepository(this.db);
    this.auditLogRepository = new AuditLogRepository(this.db);

    // --- core services ---
    this.passwordService = new PasswordService(config);
    this.tokenService = new TokenService(config);
    this.auditService = new AuditService(this.auditLogRepository);
    this.policyService = new PolicyService(this.memberRepository);
    this.authService = new AuthService({
      config,
      userRepository: this.userRepository,
      refreshTokenRepository: this.refreshTokenRepository,
      memberRepository: this.memberRepository,
      passwordService: this.passwordService,
      tokenService: this.tokenService,
      auditService: this.auditService,
    });
    this.authService.selfTest();

    // --- AI layer (cost-free, deterministic) ---
    this.ocrService = ocrService || new OcrService();
    this.extractionService = new LabExtractionService();
    // Public transparency surface for the clinical knowledge base (read-only,
    // no user data) — served by GET /api/meta/knowledge.
    this.knowledgeReport = () => knowledgeReport();
    this.llmGateway = new LlmGateway(config.llmProvider);
    this.trendService = new TrendService(this.labResultRepository);
    this.riskModelService = new RiskModelService({
      labResultRepository: this.labResultRepository,
      observationRepository: this.observationRepository,
    });
    this.doctorSummaryService = new DoctorSummaryService({
      reportRepository: this.reportRepository,
      labResultRepository: this.labResultRepository,
      observationRepository: this.observationRepository,
      trendService: this.trendService,
      riskModelService: this.riskModelService,
      llmGateway: this.llmGateway,
    });
    this.healthScoreService = new HealthScoreService({
      labResultRepository: this.labResultRepository,
      reportRepository: this.reportRepository,
    });
    this.milestoneService = new MilestoneService({
      reportRepository: this.reportRepository,
      labResultRepository: this.labResultRepository,
      auditLogRepository: this.auditLogRepository,
    });

    // --- Personal Health Intelligence Engine (ADD-ON: read-only, CPU-only) ---
    this.personalBaselineService = new PersonalBaselineService({
      labResultRepository: this.labResultRepository,
      observationRepository: this.observationRepository,
    });
    this.temporalAnomalyService = new TemporalAnomalyService({
      labResultRepository: this.labResultRepository,
      observationRepository: this.observationRepository,
    });
    this.healthPatternGraphService = new HealthPatternGraphService({
      labResultRepository: this.labResultRepository,
      observationRepository: this.observationRepository,
      riskModelService: this.riskModelService,
    });
    this.counterfactualTwinService = new CounterfactualTwinService({
      labResultRepository: this.labResultRepository,
      observationRepository: this.observationRepository,
      riskModelService: this.riskModelService,
    });
    this.intelligenceOrchestratorService = new IntelligenceOrchestratorService({
      labResultRepository: this.labResultRepository,
      observationRepository: this.observationRepository,
      riskModelService: this.riskModelService,
    });
    this.intelligenceExplanationService = new IntelligenceExplanationService({
      intelligenceOrchestrator: this.intelligenceOrchestratorService,
      llmGateway: this.llmGateway,
    });

    // --- domain services ---
    this.memberService = new MemberService({
      memberRepository: this.memberRepository,
      userRepository: this.userRepository,
      policyService: this.policyService,
      auditService: this.auditService,
    });
    this.reportService = new ReportService({
      config,
      reportRepository: this.reportRepository,
      labResultRepository: this.labResultRepository,
      policyService: this.policyService,
      ocrService: this.ocrService,
      extractionService: this.extractionService,
      llmGateway: this.llmGateway,
      auditService: this.auditService,
    });
    this.observationService = new ObservationService({
      observationRepository: this.observationRepository,
      policyService: this.policyService,
      auditService: this.auditService,
    });
    this.adminService = new AdminService({
      userRepository: this.userRepository,
      refreshTokenRepository: this.refreshTokenRepository,
      auditLogRepository: this.auditLogRepository,
      policyService: this.policyService,
      auditService: this.auditService,
    });

    // --- controllers + middleware factories ---
    this.authController = new AuthController(this.authService);
    this.memberController = new MemberController(this.memberService);
    this.reportController = new ReportController(this.reportService);
    this.healthIntelController = new HealthIntelController({
      trendService: this.trendService,
      riskModelService: this.riskModelService,
      observationService: this.observationService,
      doctorSummaryService: this.doctorSummaryService,
      healthScoreService: this.healthScoreService,
      milestoneService: this.milestoneService,
      policyService: this.policyService,
      llmGateway: this.llmGateway,
      auditService: this.auditService,
    });
    this.adminController = new AdminController(this.adminService);
    this.intelligenceController = new IntelligenceController({
      orchestratorService: this.intelligenceOrchestratorService,
      counterfactualService: this.counterfactualTwinService,
      explanationService: this.intelligenceExplanationService,
      policyService: this.policyService,
    });

    this.authenticateMw = authenticate({
      tokenService: this.tokenService,
      authService: this.authService,
    });
  }

  close() {
    this.db.close();
  }

  /** Async teardown — releases the cached Tesseract worker, then the DB. */
  async shutdown() {
    await this.ocrService.close();
    this.close();
  }
}
