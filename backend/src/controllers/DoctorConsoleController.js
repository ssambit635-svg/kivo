import { z } from 'zod';
import { ctxFromReq } from '../services/AuditService.js';
import { SPECIALTY_KEYS, MEDICINE_ACKNOWLEDGEMENTS } from '../services/care/catalog.js';

const uuid = z.string().uuid();
const ACK_KEYS = MEDICINE_ACKNOWLEDGEMENTS.map((a) => a.key);

/** Multipart fields arrive as strings — accept JSON arrays or comma lists. */
const stringList = z.preprocess((value) => {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  const raw = String(value).trim();
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [raw];
    } catch {
      return [raw];
    }
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}, z.array(z.string().trim().min(1).max(80)).max(10));

const boolish = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return value;
}, z.boolean());

export const doctorSchemas = {
  apply: z.object({
    email: z.string().trim().toLowerCase().email('Valid email required').max(254),
    displayName: z.string().trim().min(1).max(120),
    password: z.string().min(12, 'Password must be at least 12 characters').max(128),
    specialty: z.enum(SPECIALTY_KEYS),
    headline: z.string().trim().min(3).max(120).optional(),
    subSpecialties: stringList.optional(),
    qualifications: stringList.optional(),
    registrationNo: z.string().trim().min(4).max(40),
    registrationCouncil: z.string().trim().max(120).optional(),
    experienceYears: z.coerce.number().int().min(0).max(70).default(0),
    languages: stringList.optional(),
    clinicName: z.string().trim().max(160).optional(),
    city: z.string().trim().max(80).optional(),
    bio: z.string().trim().max(1500).optional(),
    consultFeeInr: z.coerce.number().int().min(0).max(100000).default(0),
  }),
  profileUpdate: z
    .object({
      fullName: z.string().trim().min(1).max(120).optional(),
      headline: z.string().trim().min(3).max(120).optional(),
      specialty: z.enum(SPECIALTY_KEYS).optional(),
      subSpecialties: stringList.optional(),
      qualifications: stringList.optional(),
      registrationCouncil: z.string().trim().max(120).optional(),
      experienceYears: z.coerce.number().int().min(0).max(70).optional(),
      languages: stringList.optional(),
      clinicName: z.string().trim().max(160).optional(),
      city: z.string().trim().max(80).optional(),
      bio: z.string().trim().max(1500).optional(),
      consultFeeInr: z.coerce.number().int().min(0).max(100000).optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'At least one field is required' }),
  mockKyc: z.object({ ref: z.string().trim().max(60).optional() }).default({}),
  videoCreate: z.object({
    title: z.string().trim().min(6).max(160),
    summary: z.string().trim().max(1200).optional(),
    topic: z.enum(SPECIALTY_KEYS),
    tags: stringList.optional(),
    keyPoints: stringList.optional(),
    durationSec: z.coerce.number().int().min(5).max(600).default(45),
    language: z.string().trim().min(2).max(12).default('en'),
    isPreview: boolish.default(false),
    status: z.enum(['draft', 'published']).default('published'),
  }),
  videoUpdate: z
    .object({
      title: z.string().trim().min(6).max(160).optional(),
      summary: z.string().trim().max(1200).optional(),
      topic: z.enum(SPECIALTY_KEYS).optional(),
      tags: stringList.optional(),
      keyPoints: stringList.optional(),
      durationSec: z.coerce.number().int().min(5).max(600).optional(),
      language: z.string().trim().min(2).max(12).optional(),
      isPreview: boolish.optional(),
      status: z.enum(['draft', 'published', 'archived']).optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'At least one field is required' }),
  videoParams: z.object({ videoId: uuid }),
  consultationParams: z.object({ consultationId: uuid }),
  inboxQuery: z.object({
    status: z.enum(['requested', 'in_review', 'answered', 'closed', 'cancelled', 'payment_pending']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  }),
  reply: z.object({
    body: z.string().trim().min(5).max(3000),
    videoIds: z.array(uuid).max(3).default([]),
  }),
  approvePlan: z.object({
    items: z
      .array(
        z.object({
          code: z.string().trim().min(1).max(64),
          name: z.string().trim().max(160).optional(),
          decision: z.enum(['keep', 'edit', 'skip']).default('edit'),
          product: z.string().trim().max(160).nullish(),
          instructions: z.string().trim().max(500).nullish(),
          note: z.string().trim().max(500).nullish(),
        }),
      )
      .max(12)
      .default([]),
    doctorNote: z.string().trim().max(2000).nullish(),
    acknowledgements: z.array(z.enum(ACK_KEYS)).default([]),
  }),
  earningsQuery: z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
  adminDoctorQuery: z.object({
    status: z.enum(['pending_verification', 'active', 'suspended']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }),
  adminDoctorParams: z.object({ doctorId: uuid }),
  adminDoctorStatus: z.object({ status: z.enum(['pending_verification', 'active', 'suspended']) }),
  settlePayouts: z.object({
    period: z.string().regex(/^\d{4}-\d{2}$/),
    force: z.boolean().default(false),
  }),
};

/**
 * Doctor console API. Identity, verification, the consultation workspace
 * (brief + reply + AI-draft medicine review) and the shorts studio.
 */
export class DoctorConsoleController {
  constructor({ doctorService, consultationService, medicineService, videoService, payoutService }) {
    this.doctors = doctorService;
    this.consultations = consultationService;
    this.medicines = medicineService;
    this.videos = videoService;
    this.payouts = payoutService;
  }

  // -------------------------------------------------------------- onboarding
  /** Public: a doctor applies for an account (never self-assigns a role). */
  apply = (req, res, next) => {
    try {
      res.status(201).json(this.doctors.apply(req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  me = (req, res, next) => {
    try {
      res.json({ doctor: this.doctors.me(req.actor) });
    } catch (e) {
      next(e);
    }
  };

  overview = (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      res.json(this.doctors.overview(doctor));
    } catch (e) {
      next(e);
    }
  };

  updateProfile = (req, res, next) => {
    try {
      res.json({ doctor: this.doctors.updateProfile(req.actor, req.body, ctxFromReq(req)) });
    } catch (e) {
      next(e);
    }
  };

  /** MOCK KYC — always reported with mode: 'mock' so no client can mistake it. */
  mockKyc = (req, res, next) => {
    try {
      res.json({
        doctor: this.doctors.completeMockKyc(req.actor, { ...req.body, ctx: ctxFromReq(req) }),
        verification: {
          mode: 'mock',
          notice:
            'Demo verification only: no medical council registry, no document upload and no third-party KYC check ' +
            'happened. Replace this with a real verification integration before any real patient uses the platform.',
        },
      });
    } catch (e) {
      next(e);
    }
  };

  identityCard = (req, res, next) => {
    try {
      const doctor = this.doctors.requireProfile(req.actor);
      const publicProfile = doctor.status === 'active' ? doctor.toPublicJSON() : doctor.toJSON();
      res.json({
        card: {
          ...publicProfile,
          specialtyLabel: publicProfile.headline,
          verifyUrl: `/api/public/doctors/${doctor.slug}`,
          qrPayload: `kivo://doctor/${doctor.slug}`,
          issuedAt: doctor.created_at,
          verificationMode: 'mock',
        },
      });
    } catch (e) {
      next(e);
    }
  };

  revenueModel = (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      const statement = this.payouts.doctorStatement(doctor, { period: null, autoSettle: true });
      res.json({ revenueModel: statement.revenueModel, payoutNote: statement.payoutNote });
    } catch (e) {
      next(e);
    }
  };

  // ----------------------------------------------------------------- videos
  library = (req, res, next) => {
    try {
      res.json(this.videos.doctorLibrary(this.doctors.requireActiveDoctor(req.actor)));
    } catch (e) {
      next(e);
    }
  };

  recommendable = (req, res, next) => {
    try {
      res.json({ videos: this.videos.recommendable(this.doctors.requireActiveDoctor(req.actor)) });
    } catch (e) {
      next(e);
    }
  };

  publishVideo = (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      res.status(201).json({ video: this.videos.publish(doctor, req.body, req.file || null, ctxFromReq(req)) });
    } catch (e) {
      next(e);
    }
  };

  updateVideo = (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      res.json({ video: this.videos.update(doctor, req.params.videoId, req.body, ctxFromReq(req)) });
    } catch (e) {
      next(e);
    }
  };

  archiveVideo = (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      res.json(this.videos.archive(doctor, req.params.videoId, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  // ---------------------------------------------------------- consultations
  inbox = (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      res.json(this.consultations.inbox(doctor, req.query));
    } catch (e) {
      next(e);
    }
  };

  consultation = async (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      res.json(await this.consultations.getForDoctor(doctor, req.params.consultationId, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  acceptConsultation = (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      res.json({ consultation: this.consultations.accept(doctor, req.params.consultationId, ctxFromReq(req)) });
    } catch (e) {
      next(e);
    }
  };

  reply = (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      res.status(201).json(this.consultations.reply(doctor, req.params.consultationId, req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  closeConsultation = (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      res.json({ consultation: this.consultations.closeByDoctor(doctor, req.params.consultationId, ctxFromReq(req)) });
    } catch (e) {
      next(e);
    }
  };

  // ------------------------------------------------------- medicine preview
  draftMedicine = async (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      const ctx = ctxFromReq(req);
      const consultation = this.consultations.loadForDoctor(doctor, req.params.consultationId);
      const grant = this.consultations.activeGrant(doctor, consultation.member_id);
      if (!grant) {
        return res.status(403).json({
          error: {
            code: 'CONSENT_REQUIRED',
            message: 'The patient has not shared their chart for this consultation, so no draft can be generated.',
          },
          requestId: req.requestId,
        });
      }
      const member = this.consultations.memberFor(consultation);
      res.json({ medicinePlan: this.medicines.refreshDraft(doctor, consultation, member, ctx) });
    } catch (e) {
      next(e);
    }
  };

  approveMedicine = (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      const consultation = this.consultations.loadForDoctor(doctor, req.params.consultationId);
      const ctx = ctxFromReq(req);
      const plan = this.medicines.approve(doctor, consultation, req.body, ctx);
      const message = this.consultations.recordMedicinePlan(doctor, consultation, plan, ctx);
      res.json({ medicinePlan: plan, message });
    } catch (e) {
      next(e);
    }
  };

  rejectMedicine = (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      const consultation = this.consultations.loadForDoctor(doctor, req.params.consultationId);
      res.json({ medicinePlan: this.medicines.reject(doctor, consultation, ctxFromReq(req)) });
    } catch (e) {
      next(e);
    }
  };

  // --------------------------------------------------------------- earnings
  earnings = (req, res, next) => {
    try {
      const doctor = this.doctors.requireActiveDoctor(req.actor);
      res.json(this.payouts.doctorStatement(doctor, { period: req.query.period || null, autoSettle: true, ctx: ctxFromReq(req) }));
    } catch (e) {
      next(e);
    }
  };
}

/** Admin surfaces for the network (verification queue + payout settlement). */
export class CareAdminController {
  constructor({ doctorService, payoutService, policyService }) {
    this.doctors = doctorService;
    this.payouts = payoutService;
    this.policy = policyService;
  }

  listDoctors = (req, res, next) => {
    try {
      res.json(this.doctors.adminList(req.actor, req.query));
    } catch (e) {
      next(e);
    }
  };

  setDoctorStatus = (req, res, next) => {
    try {
      res.json({ doctor: this.doctors.adminSetStatus(req.actor, req.params.doctorId, req.body.status, ctxFromReq(req)) });
    } catch (e) {
      next(e);
    }
  };

  settlePayouts = (req, res, next) => {
    try {
      this.policy.assertAdmin(req.actor);
      res.json({ result: this.payouts.settleVideoPool(req.body.period, { force: req.body.force, ctx: ctxFromReq(req) }) });
    } catch (e) {
      next(e);
    }
  };
}
