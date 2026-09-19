/**
 * Row-backed domain entities for the care network (doctor console +
 * subscriptions + consultations + short videos). Kept together like
 * `entities.js`; each `toJSON()` is the ONLY sanctioned outward shape, so a
 * DB column can never leak by accident (e.g. media paths, internal flags).
 */

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export class DoctorProfile {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new DoctorProfile(row) : null;
  }

  get isActive() {
    return this.status === 'active';
  }

  get isVerified() {
    // MOCK KYC: "verified" here means the demo KYC step was completed, and it
    // is always rendered with a MOCK badge in the UI — never as a real
    // medical-registration check.
    return this.status === 'active' && this.kyc_status === 'mock_verified';
  }

  /** Public identity — this is what patients (and the shareable card) see. */
  toPublicJSON() {
    return {
      id: this.id,
      slug: this.slug,
      fullName: this.full_name,
      headline: this.headline,
      specialty: this.specialty,
      subSpecialties: parseJson(this.sub_specialties, []),
      qualifications: parseJson(this.qualifications, []),
      experienceYears: this.experience_years,
      languages: parseJson(this.languages, []),
      clinicName: this.clinic_name,
      city: this.city,
      bio: this.bio,
      consultFeeInr: this.consult_fee_inr,
      status: this.status,
      rating: { average: this.rating_avg, count: this.rating_count },
      videoCount: this.video_count,
      consultCount: this.consult_count,
      verified: this.isVerified,
      verification: {
        mode: 'mock',
        label: 'Demo verification',
        registrationCouncil: this.registration_council || null,
      },
      identityCardNo: this.identity_card_no,
      memberSince: this.created_at,
    };
  }

  /** Doctor-console view — adds compliance/account fields, still no secrets. */
  toJSON() {
    return {
      ...this.toPublicJSON(),
      userId: this.user_id,
      registrationNo: this.registration_no,
      kyc: {
        status: this.kyc_status,
        ref: this.kyc_ref,
        verifiedAt: this.kyc_verified_at,
        mode: 'mock',
      },
      createdAt: this.created_at,
      updatedAt: this.updated_at,
    };
  }
}

export class SubscriptionPlan {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new SubscriptionPlan(row) : null;
  }

  toJSON() {
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      tagline: this.tagline,
      priceInr: this.price_inr,
      interval: this.interval,
      consultationsPerMonth: this.consultations_per_month,
      videoAccess: this.video_access,
      features: parseJson(this.features, []),
      sortOrder: this.sort_order,
    };
  }
}

export class Subscription {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new Subscription(row) : null;
  }

  get isActive() {
    return this.status === 'active' && new Date(this.current_period_end).getTime() > Date.now();
  }

  toJSON(plan = null) {
    return {
      id: this.id,
      planId: this.plan_id,
      plan: plan ? plan.toJSON() : null,
      status: this.status,
      active: this.isActive,
      startedAt: this.started_at,
      currentPeriodEnd: this.current_period_end,
      autoRenew: !!this.auto_renew,
      cancelledAt: this.cancelled_at,
    };
  }
}

export class PaymentIntent {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new PaymentIntent(row) : null;
  }

  toJSON() {
    return {
      id: this.id,
      purpose: this.purpose,
      planId: this.plan_id ?? null,
      consultationId: this.consultation_id ?? null,
      amountInr: this.amount_inr,
      currency: this.currency,
      provider: this.provider,
      providerRef: this.provider_ref ?? null,
      method: this.method ?? null,
      status: this.status,
      failureReason: this.failure_reason ?? null,
      // Unmissable in every client: no real money moves in this build.
      mode: 'mock',
      mockNotice: 'Demo checkout: no card, UPI or bank detail is ever collected and no money moves.',
      createdAt: this.created_at,
      completedAt: this.completed_at ?? null,
    };
  }
}

export class Consultation {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new Consultation(row) : null;
  }

  toJSON() {
    return {
      id: this.id,
      memberId: this.member_id,
      patientUserId: this.patient_user_id,
      doctorId: this.doctor_id,
      subject: this.subject,
      question: this.question,
      status: this.status,
      feeInr: this.fee_inr,
      includedInPlan: !!this.included_in_plan,
      paymentIntentId: this.payment_intent_id ?? null,
      consent: {
        scope: parseJson(this.consent_scope, []),
        grantedAt: this.consent_granted_at ?? null,
        expiresAt: this.consent_expires_at ?? null,
      },
      doctorReply: this.doctor_reply ?? null,
      doctorRepliedAt: this.doctor_replied_at ?? null,
      closedAt: this.closed_at ?? null,
      createdAt: this.created_at,
      updatedAt: this.updated_at,
    };
  }
}

export class MedicinePlan {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new MedicinePlan(row) : null;
  }

  toJSON() {
    return {
      id: this.id,
      consultationId: this.consultation_id,
      memberId: this.member_id,
      doctorId: this.doctor_id,
      status: this.status,
      aiDraft: parseJson(this.ai_draft, {}),
      finalItems: parseJson(this.final_items, []),
      doctorNote: this.doctor_note ?? null,
      acknowledgements: parseJson(this.acknowledgements, []),
      approvedAt: this.approved_at ?? null,
      createdAt: this.created_at,
      updatedAt: this.updated_at,
    };
  }
}

export class DoctorVideo {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new DoctorVideo(row) : null;
  }

  /** Catalogue card. `locked` is decided by the caller's entitlements. */
  toJSON({ doctor = null, locked = false, includeMedia = false } = {}) {
    return {
      id: this.id,
      doctorId: this.doctor_id,
      doctor: doctor ? doctor.toPublicJSON() : null,
      title: this.title,
      summary: this.summary,
      topic: this.topic,
      tags: parseJson(this.tags, []),
      keyPoints: parseJson(this.key_points, []),
      durationSec: this.duration_sec,
      language: this.language,
      mediaKind: this.media_kind,
      isPreview: !!this.is_preview,
      status: this.status,
      viewCount: this.view_count,
      publishedAt: this.published_at,
      createdAt: this.created_at,
      locked,
      ...(includeMedia ? { media: { mime: this.media_mime, bytes: this.media_bytes } } : {}),
    };
  }
}
