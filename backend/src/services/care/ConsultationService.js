import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors.js';
import { nowIso } from '../../utils/time.js';

export const DEFAULT_CONSENT_SCOPE = ['labs', 'trends', 'vitals', 'medications', 'risk', 'reports'];
export const CONSULTATION_STATUSES = [
  'payment_pending',
  'requested',
  'in_review',
  'answered',
  'closed',
  'cancelled',
];

/**
 * Async doctor consultation — the core of the paid tier.
 *
 * Flow:
 *   patient books ──▶ plan quota?  ──yes──▶ 'requested'  (₹0, pool pays doctor)
 *                        │no
 *                        └──▶ mock payment intent ──▶ 'requested' (70/30 split)
 *   doctor reads the one-screen brief (ONLY while the patient's consent grant
 *   is alive) → replies → optional doctor-approved medicine plan + shorts.
 *
 * Consent is a first-class object: it is created per consultation, scoped to
 * the data sections the patient ticked, expires on its own, and can be revoked
 * mid-flight — after which every doctor read fails immediately.
 */
export class ConsultationService {
  constructor({
    config,
    consultationRepository,
    doctorRepository,
    memberRepository,
    policyService,
    subscriptionService,
    payoutService,
    briefService,
    medicineService,
    auditService,
  }) {
    this.config = config;
    this.consultations = consultationRepository;
    this.doctors = doctorRepository;
    this.members = memberRepository;
    this.policy = policyService;
    this.subscriptions = subscriptionService;
    this.payouts = payoutService;
    this.brief = briefService;
    this.medicines = medicineService;
    this.audit = auditService;
  }

  // -------------------------------------------------------------- patient side
  book(actor, { memberId, doctorId, subject, question, shareHealthData = true }, ctx = {}) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertWrite(actor, member);

    const doctor = this.doctors.findById(doctorId);
    if (!doctor || doctor.status !== 'active') throw new NotFoundError('Doctor not found');

    const entitlements = this.subscriptions.entitlements(actor);
    const usePlanQuota = entitlements.active && entitlements.consultationsRemaining > 0;
    const feeInr = usePlanQuota ? 0 : doctor.consult_fee_inr;
    const scope = shareHealthData ? DEFAULT_CONSENT_SCOPE : [];
    const expiresAt = shareHealthData
      ? new Date(Date.now() + this.config.consentDefaultDays * 24 * 3600 * 1000).toISOString()
      : null;

    const consultation = this.consultations.create({
      memberId: member.id,
      patientUserId: actor.id,
      doctorId: doctor.id,
      subject,
      question,
      status: usePlanQuota ? 'requested' : 'payment_pending',
      feeInr,
      includedInPlan: usePlanQuota,
      consentScope: scope,
      consentExpiresAt: expiresAt,
    });

    let payment = null;
    if (!usePlanQuota) {
      payment = this.subscriptions.createIntent(actor, {
        purpose: 'consultation',
        consultationId: consultation.id,
        amountInr: feeInr,
      });
      this.consultations.update(consultation.id, { paymentIntentId: payment.id });
    }

    this.consultations.addMessage({
      consultationId: consultation.id,
      authorUserId: actor.id,
      authorRole: 'patient',
      kind: 'text',
      body: question,
      metadata: { subject },
    });
    this.consultations.addMessage({
      consultationId: consultation.id,
      authorRole: 'system',
      kind: 'status',
      body: usePlanQuota
        ? 'Booked from your Care+ plan (no payment needed).'
        : `Mock payment created for ₹${feeInr}. The doctor sees your request once it is paid.`,
      metadata: { includedInPlan: usePlanQuota, consentScope: scope, consentExpiresAt: expiresAt },
    });

    this.audit.record({
      userId: actor.id,
      action: 'consultation.booked',
      resourceType: 'consultation',
      resourceId: consultation.id,
      metadata: {
        doctorId: doctor.id,
        includedInPlan: usePlanQuota,
        consentScope: scope,
        feeInr,
      },
      ctx,
    });

    const saved = this.consultations.findById(consultation.id);
    return {
      consultation: saved.toJSON(),
      doctor: doctor.toPublicJSON(),
      payment: payment ? payment.toJSON() : null,
      entitlements: this.subscriptions.entitlements(actor),
      consent: {
        scope,
        expiresAt,
        revocable: true,
        note: 'Your chart is shared with this doctor only for this consultation, only for the sections you allowed, and you can revoke it any time.',
      },
    };
  }

  /** Flip a paid consultation to 'requested' — called after a mock payment settles. */
  onPaymentSettled(intent, ctx = {}) {
    if (!intent || intent.purpose !== 'consultation' || !intent.consultation_id) return null;
    const consultation = this.consultations.findById(intent.consultation_id);
    if (!consultation) return null;
    if (consultation.status !== 'payment_pending') return consultation.toJSON();
    this.consultations.addMessage({
      consultationId: consultation.id,
      authorRole: 'system',
      kind: 'status',
      body: `Mock payment confirmed (${intent.provider_ref}). The doctor has been notified.`,
      metadata: { mock: true, providerRef: intent.provider_ref },
    });
    const updated = this.consultations.update(consultation.id, { status: 'requested' });
    this.audit.record({
      userId: consultation.patient_user_id,
      action: 'consultation.payment_confirmed',
      resourceType: 'consultation',
      resourceId: consultation.id,
      metadata: { mock: true },
      ctx,
    });
    return updated.toJSON();
  }

  listMine(actor, { page = 1, pageSize = 20 } = {}) {
    const result = this.consultations.listForPatient(actor.id, { page, pageSize });
    return {
      items: result.items.map((c) => this.decorateForPatient(c)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  getMine(actor, consultationId) {
    const consultation = this.loadForPatient(actor, consultationId);
    const messages = this.consultations.listMessages(consultation.id);
    const linkedVideoIds = messages
      .filter((m) => m.kind === 'video_link')
      .flatMap((m) => (Array.isArray(m.metadata?.videoIds) ? m.metadata.videoIds : []));
    return {
      ...this.decorateForPatient(consultation),
      messages: messages.map((m) => this.projectMessage(m, 'patient')),
      medicinePlan: this.medicines.approvedForPatient(consultation),
      recommendedVideos: messages
        .filter((m) => m.kind === 'video_link')
        .flatMap((m) => m.metadata?.videos || [])
        .filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i),
      linkedVideoIds,
      consent: this.consentState(consultation),
    };
  }

  revokeConsent(actor, consultationId, ctx = {}) {
    const consultation = this.loadForPatient(actor, consultationId);
    const revoked = this.consultations.revokeByConsultation(consultation.id, { memberId: consultation.member_id });
    this.consultations.addMessage({
      consultationId: consultation.id,
      authorRole: 'system',
      kind: 'status',
      body: 'You revoked chart access for this doctor. They can no longer open your records for this consultation.',
      metadata: { revokedGrants: revoked },
    });
    this.audit.record({
      userId: actor.id,
      action: 'consultation.consent_revoked',
      resourceType: 'consultation',
      resourceId: consultation.id,
      metadata: { revokedGrants: revoked },
      ctx,
    });
    return { revoked: true, revokedGrants: revoked, consent: this.consentState(this.consultations.findById(consultation.id)) };
  }

  closeMine(actor, consultationId, ctx = {}) {
    const consultation = this.loadForPatient(actor, consultationId);
    if (consultation.status === 'closed') return this.decorateForPatient(consultation);
    const updated = this.consultations.update(consultation.id, { status: 'closed', closedAt: nowIso() });
    this.audit.record({
      userId: actor.id,
      action: 'consultation.closed',
      resourceType: 'consultation',
      resourceId: consultation.id,
      metadata: { by: 'patient' },
      ctx,
    });
    return this.decorateForPatient(updated);
  }

  addPatientMessage(actor, consultationId, body, ctx = {}) {
    const consultation = this.loadForPatient(actor, consultationId);
    if (['closed', 'cancelled'].includes(consultation.status)) {
      throw new ConflictError('This consultation is closed', 'CONSULTATION_CLOSED');
    }
    const message = this.consultations.addMessage({
      consultationId: consultation.id,
      authorUserId: actor.id,
      authorRole: 'patient',
      kind: 'text',
      body,
    });
    return this.projectMessage(message, 'patient');
  }

  // --------------------------------------------------------------- doctor side
  inbox(doctor, { status = null, page = 1, pageSize = 20 } = {}) {
    const result = this.consultations.listForDoctor(doctor.id, { status, page, pageSize });
    return {
      items: result.items.map((c) => {
        const grant = this.activeGrant(doctor, c.member_id);
        return {
          ...c.toJSON(),
          member: this.memberCard(c.member_id),
          chartAccess: grant
            ? { granted: true, scope: grant.scope, expiresAt: grant.expires_at }
            : { granted: false, scope: [], expiresAt: null, reason: 'no active consent' },
        };
      }),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  /**
   * The doctor's workspace for one consultation: brief + thread + medicine
   * draft. Chart data is only attached while consent is alive; the thread and
   * the patient's own words stay visible either way (they wrote to the doctor).
   */
  async getForDoctor(doctor, consultationId, ctx = {}) {
    const consultation = this.loadForDoctor(doctor, consultationId);
    const member = this.members.findById(consultation.member_id);
    const grant = this.activeGrant(doctor, consultation.member_id);

    let brief = null;
    if (grant && member) {
      brief = await this.brief.build(member, { scope: grant.scope });
      this.audit.record({
        userId: doctor.user_id,
        action: 'doctor.chart_viewed',
        resourceType: 'member',
        resourceId: member.id,
        metadata: { consultationId: consultation.id, scope: grant.scope },
        ctx,
      });
    }

    const messages = this.consultations.listMessages(consultation.id);
    const existingPlan = this.consultations.findLatestMedicinePlan(consultation.id);
    return {
      consultation: consultation.toJSON(),
      member: this.memberCard(consultation.member_id),
      chartAccess: grant
        ? { granted: true, scope: grant.scope, expiresAt: grant.expires_at }
        : {
            granted: false,
            scope: [],
            expiresAt: null,
            reason: grant === null ? 'The patient has not shared their chart (or revoked it).' : 'Consent expired.',
          },
      brief,
      messages: messages.map((m) => this.projectMessage(m, 'doctor')),
      medicinePlan: existingPlan ? existingPlan.toJSON() : null,
      summaryLine: brief ? this.summaryLine(brief) : null,
    };
  }

  accept(doctor, consultationId, ctx = {}) {
    const consultation = this.loadForDoctor(doctor, consultationId);
    if (['closed', 'cancelled', 'answered', 'payment_pending'].includes(consultation.status)) {
      throw new ConflictError('This consultation can no longer be accepted', 'CONSULTATION_NOT_OPEN');
    }
    if (consultation.status === 'in_review') return consultation.toJSON();
    const updated = this.consultations.update(consultation.id, { status: 'in_review' });
    this.consultations.addMessage({
      consultationId: consultation.id,
      authorUserId: doctor.user_id,
      authorRole: 'doctor',
      kind: 'status',
      body: 'Doctor has opened your case and is reviewing your records.',
    });
    this.audit.record({
      userId: doctor.user_id,
      action: 'consultation.accepted',
      resourceType: 'consultation',
      resourceId: consultation.id,
      ctx,
    });
    return updated.toJSON();
  }

  reply(doctor, consultationId, { body, videoIds = [] }, ctx = {}) {
    const consultation = this.loadForDoctor(doctor, consultationId);
    if (!this.activeGrant(doctor, consultation.member_id)) {
      throw new ForbiddenError(
        'The patient has not shared their chart (or revoked consent), so a clinical reply cannot be sent.',
        'CONSENT_REQUIRED',
      );
    }
    const message = this.consultations.addMessage({
      consultationId: consultation.id,
      authorUserId: doctor.user_id,
      authorRole: 'doctor',
      kind: 'text',
      body,
    });

    if (Array.isArray(videoIds) && videoIds.length > 0) {
      const videos = this.attachVideos(doctor, videoIds);
      if (videos.length > 0) {
        this.consultations.addMessage({
          consultationId: consultation.id,
          authorUserId: doctor.user_id,
          authorRole: 'doctor',
          kind: 'video_link',
          body: 'Doctor attached shorts for you to watch.',
          metadata: {
            videoIds: videos.map((v) => v.id),
            videos: videos.map((v) => ({
              id: v.id,
              title: v.title,
              topic: v.topic,
              durationSec: v.duration_sec,
              isPreview: !!v.is_preview,
            })),
          },
        });
      }
    }

    const updated = this.consultations.update(consultation.id, {
      doctorReply: body,
      doctorRepliedAt: nowIso(),
      status: 'answered',
    });
    if (consultation.included_in_plan) {
      this.payouts.recordPlanFundedConsultation({ doctor, consultation: updated });
    }
    this.doctors.bumpCounter(doctor.id, 'consult_count', 1);
    this.audit.record({
      userId: doctor.user_id,
      action: 'consultation.answered',
      resourceType: 'consultation',
      resourceId: consultation.id,
      metadata: { videos: Array.isArray(videoIds) ? videoIds.length : 0 },
      ctx,
    });
    return { consultation: updated.toJSON(), message: this.projectMessage(message, 'doctor') };
  }

  closeByDoctor(doctor, consultationId, ctx = {}) {
    const consultation = this.loadForDoctor(doctor, consultationId);
    const updated = this.consultations.update(consultation.id, { status: 'closed', closedAt: nowIso() });
    this.audit.record({
      userId: doctor.user_id,
      action: 'consultation.closed',
      resourceType: 'consultation',
      resourceId: consultation.id,
      metadata: { by: 'doctor' },
      ctx,
    });
    return updated.toJSON();
  }

  // ------------------------------------------------------------------ internal
  /** Member entity behind a consultation (used by the console controller). */
  memberFor(consultation) {
    return this.members.findById(consultation.member_id);
  }

  /** Mirror an approved medicine plan into the thread, doctor-attributed. */
  recordMedicinePlan(doctor, consultation, plan, ctx = {}) {
    const message = this.consultations.addMessage({
      consultationId: consultation.id,
      authorUserId: doctor.user_id,
      authorRole: 'doctor',
      kind: 'medicine_plan',
      body: plan.doctorNote || 'Doctor-approved medicine plan shared.',
      metadata: { planId: plan.id, items: plan.finalItems.length },
    });
    this.audit.record({
      userId: doctor.user_id,
      action: 'consultation.medicine_plan_shared',
      resourceType: 'consultation',
      resourceId: consultation.id,
      metadata: { planId: plan.id },
      ctx,
    });
    return this.projectMessage(message, 'doctor');
  }

  attachVideos(doctor, videoIds) {
    const out = [];
    for (const id of videoIds.slice(0, 3)) {
      const video = this.consultations.db.get('SELECT * FROM doctor_videos WHERE id = ?', id);
      if (!video || video.doctor_id !== doctor.id || video.status !== 'published') {
        throw new NotFoundError('One of the selected shorts is not available');
      }
      out.push(video);
    }
    return out;
  }

  loadForPatient(actor, consultationId) {
    const consultation = this.consultations.findById(consultationId);
    if (!consultation || consultation.patient_user_id !== actor.id) {
      throw new NotFoundError('Consultation not found');
    }
    return consultation;
  }

  loadForDoctor(doctor, consultationId) {
    const consultation = this.consultations.findById(consultationId);
    if (!consultation || consultation.doctor_id !== doctor.id) {
      throw new NotFoundError('Consultation not found');
    }
    return consultation;
  }

  activeGrant(doctor, memberId) {
    return this.consultations.findActiveGrant({
      doctorId: doctor.id,
      memberId,
      nowIso: nowIso(),
    });
  }

  consentState(consultation) {
    const grants = this.consultations.listGrantsForMember(consultation.member_id, { activeOnly: false });
    const grant = grants.find((g) => g.consultationId === consultation.id) || null;
    if (!grant) {
      return { granted: false, revoked: false, scope: [], expiresAt: null, note: 'No chart data was shared.' };
    }
    return {
      granted: grant.active,
      revoked: !!grant.revokedAt,
      scope: grant.scope,
      expiresAt: grant.expiresAt,
      note: grant.active
        ? 'Your chart is visible to this doctor for the sections you allowed.'
        : grant.revokedAt
          ? 'You revoked this doctor’s access to your chart.'
          : 'This consent has expired.',
    };
  }

  memberCard(memberId) {
    const member = this.members.findById(memberId);
    if (!member) return null;
    // Minimal identity for the queue — the full brief arrives separately and
    // only with consent. No owner email, no account data.
    return {
      id: member.id,
      name: member.name,
      relationship: member.relationship,
      age: member.age,
      sex: member.sex,
    };
  }

  decorateForPatient(consultation) {
    const doctor = this.doctors.findById(consultation.doctor_id);
    return {
      ...consultation.toJSON(),
      doctor: doctor ? doctor.toPublicJSON() : null,
      consent: this.consentState(consultation),
      needsPayment: consultation.status === 'payment_pending',
    };
  }

  projectMessage(message, audience) {
    const meta = (typeof message?.metadata === 'string' ? safeParseJson(message.metadata) : message?.metadata) || {};
    return {
      id: message.id,
      authorRole: message.authorRole || message.author_role,
      kind: message.kind,
      body: message.body,
      createdAt: message.createdAt || message.created_at,
      videos: message.kind === 'video_link' ? meta.videos || [] : undefined,
      ...(audience === 'doctor' && message.kind === 'status' ? { meta: { includedInPlan: meta.includedInPlan ?? null } } : {}),
    };
  }

  /** One-line scan for the queue: problems, medicines, risk band. */
  summaryLine(brief) {
    const problems = brief.activeProblems.slice(0, 3).map((p) => `${p.name} ${p.value}${p.unit ? ` ${p.unit}` : ''} (${p.status})`);
    return {
      headline: brief.member.age != null
        ? `${brief.member.name}, ${brief.member.age}${brief.member.sex ? `/${brief.member.sex[0].toUpperCase()}` : ''}`
        : brief.member.name,
      problems,
      problemCount: brief.activeProblems.length,
      medicines: brief.medications.map((m) => m.name),
      riskBand: brief.riskFlags[0]?.band ?? null,
      changedCount: brief.changedSinceLastReport.length,
      gaps: brief.gapsToAsk.map((g) => g.ask),
    };
  }

  assertValidBody(body) {
    if (!body || String(body).trim().length < 2) throw new ValidationError('Message is empty');
    return String(body).trim();
  }
}

function safeParseJson(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
