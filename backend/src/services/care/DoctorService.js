import { randomInt } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../common/errors.js';
import { newId } from '../../utils/id.js';
import { SPECIALTIES, SPECIALTY_KEYS, defaultHeadline } from './catalog.js';

const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no look-alikes (l/1/o/0)

function randomCode(length, alphabet) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(0, alphabet.length)];
  return out;
}

function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || `doctor-${randomCode(6, SLUG_ALPHABET)}`;
}

/**
 * Doctor identity lifecycle: apply → (mock) KYC → verified profile → the
 * public "Dr X · specialist" card patients see.
 *
 * Role handling is intentionally server-side: applying never lets a caller
 * pick their own role. The `doctor` role is granted by the platform when the
 * profile becomes active and is revoked when it is suspended, and every
 * request re-reads roles from the DB.
 */
export class DoctorService {
  constructor({
    config,
    doctorRepository,
    videoRepository,
    consultationRepository,
    userRepository,
    roleRepository,
    passwordService,
    authService,
    policyService,
    auditService,
    certificateService = null,
  }) {
    this.config = config;
    this.certificates = certificateService;
    this.doctors = doctorRepository;
    this.videos = videoRepository;
    this.consultations = consultationRepository;
    this.users = userRepository;
    this.roles = roleRepository;
    this.passwords = passwordService;
    this.auth = authService;
    this.policy = policyService;
    this.audit = auditService;
  }

  get kycMode() {
    return this.config.doctorKycMode; // 'mock' in this build — always labelled in the UI
  }

  // ----------------------------------------------------------------- apply
  /**
   * Self-serve doctor onboarding WITHOUT a certificate document: the typed
   * registration number is checked (format + uniqueness) and recorded as a
   * `registration_no_only` certificate verdict. In demo mode the profile is
   * activated immediately so the hackathon flow needs no queue — production
   * (DOCTOR_AUTO_APPROVE=false) leaves it pending for the admin to review.
   */
  apply(payload, ctx = {}) {
    const { user, doctor, autoApprove } = this.createAccount(payload, ctx);
    // Demo mode records the registration number as the certificate verdict, so
    // the doctor can sign in with that number right away. Production keeps the
    // profile pending until an admin reviews it.
    const verdict = this.certificates
      ? this.certificates.checkRegistrationNo({
          registrationNo: doctor.registration_no,
          profileRegistrationNo: doctor.registration_no,
        })
      : null;
    if (verdict) this.recordCertificate(doctor.id, verdict, payload);
    if (autoApprove) {
      this.doctors.setKyc(doctor.id, {
        status: 'mock_verified',
        ref: `MOCK-KYC-${randomCode(8, SLUG_ALPHABET).toUpperCase()}`,
      });
      this.doctors.setStatus(doctor.id, 'active');
      this.roles.grant(user.id, 'doctor', { grantedBy: null });
    }
    return this.finishApplication({ user, doctor, certificate: verdict, ctx });
  }

  /**
   * The sign-up path the doctor console actually uses: the same account
   * creation, but with the medical council certificate attached, and activation
   * driven by the certificate check rather than by demo convenience.
   */
  async applyWithCertificate(payload, file, ctx = {}) {
    const { user, doctor } = this.createAccount(payload, ctx);
    const verdict = await this.certificates.verifyDocument({
      file,
      registrationNo: payload.registrationNo,
      registrationCouncil: payload.registrationCouncil || null,
      fullName: payload.displayName,
      profileRegistrationNo: doctor.registration_no,
    });
    this.recordCertificate(doctor.id, verdict, payload, { userId: user.id, ctx });
    // Only a verified certificate may activate a profile — and only when demo
    // auto-approval is on. A rejected document leaves the account pending with
    // the reasons attached, ready for a corrected upload.
    if (verdict.status === 'verified' && this.config.doctorAutoApprove) {
      this.doctors.setKyc(doctor.id, { status: 'mock_verified', ref: verdict.ref });
      this.doctors.setStatus(doctor.id, 'active');
      this.roles.grant(user.id, 'doctor', { grantedBy: null });
    }
    return this.finishApplication({ user, doctor, certificate: verdict, ctx });
  }

  /** Shared tail: session + the doctor/certificate payload every client reads. */
  finishApplication({ user, doctor, certificate, ctx }) {
    const fresh = this.doctors.findById(doctor.id);
    const session = this.auth.issueSession(user, ctx, { familyId: newId() });
    return {
      ...session,
      doctor: fresh.toJSON(),
      certificate: certificate || fresh.certificate,
      requiresCertificate: !fresh.isCertificateVerified,
      activated: fresh.status === 'active',
      certificatePolicy: this.certificates ? this.certificates.policy : null,
    };
  }

  /**
   * Persists a certificate verdict (metadata + sha256 only) and audits it.
   * Used by sign-up, by the console's verification screen and by sign-in
   * helpers, so every path leaves the same shape behind.
   */
  recordCertificate(doctorId, verdict, payload = {}, { userId = null, ctx = {} } = {}) {
    const stored = this.doctors.setCertificate(doctorId, {
      status: verdict.status,
      ref: verdict.ref,
      sha256: verdict.meta?.sha256 || null,
      fileName: verdict.meta?.fileName || null,
      mime: verdict.meta?.mime || null,
      bytes: verdict.meta?.bytes ?? null,
      checks: verdict.checks || [],
      method: verdict.method || null,
      reason: verdict.reason || null,
      council: payload.registrationCouncil || null,
      no: payload.certificateNo || null,
    });
    this.audit.record({
      userId,
      action: 'doctor.certificate_checked',
      resourceType: 'doctor_profile',
      resourceId: doctorId,
      outcome: verdict.status === 'verified' ? 'success' : 'failure',
      metadata: { method: verdict.method, status: verdict.status, reason: verdict.reason || null },
      ctx,
    });
    return stored;
  }

  /**
   * Certificate upload from the console (or right after sign-in): checks the
   * document, records the verdict and — in demo mode — activates a doctor whose
   * certificate checks out.
   */
  async verifyCertificate(actor, { file, registrationNo = null, certificateNo = null } = {}, ctx = {}) {
    const doctor = this.requireProfile(actor);
    const verdict = await this.certificates.verifyDocument({
      file,
      registrationNo: registrationNo || certificateNo || doctor.registration_no,
      fullName: doctor.full_name,
      profileRegistrationNo: doctor.registration_no,
    });
    this.recordCertificate(doctor.id, verdict, { certificateNo }, { userId: actor.id, ctx });

    let activated = false;
    if (verdict.status === 'verified') {
      if (this.config.doctorAutoApprove && doctor.status !== 'suspended') {
        this.doctors.setKyc(doctor.id, { status: 'mock_verified', ref: verdict.ref });
        this.doctors.setStatus(doctor.id, 'active');
        this.roles.grant(actor.id, 'doctor', { grantedBy: null });
        activated = true;
      }
    }
    const fresh = this.doctors.findById(doctor.id);
    return {
      doctor: fresh.toJSON(),
      certificate: fresh.certificate,
      verification: verdict,
      activated,
      mode: this.kycMode,
    };
  }

  /** Certificate upload rules + current verdict, for the verification screen. */
  certificateStatus(actor) {
    const doctor = this.doctors.findByUserId(actor.id);
    return {
      doctor: doctor ? doctor.toJSON() : null,
      certificate: doctor ? doctor.certificate : null,
      policy: this.certificates ? this.certificates.policy : null,
      mode: this.kycMode,
    };
  }

  /**
   * Creates the account + professional profile. Never grants a role —
   * activation is a separate, audited decision (certificate check, admin
   * approval, or the demo auto-approve in `apply`).
   */
  createAccount(payload, ctx = {}) {
    const {
      email,
      displayName,
      password,
      specialty,
      headline = null,
      subSpecialties = [],
      qualifications = [],
      registrationNo,
      registrationCouncil = null,
      experienceYears = 0,
      languages = ['English'],
      clinicName = null,
      city = null,
      bio = null,
      consultFeeInr = 0,
    } = payload;

    if (!SPECIALTY_KEYS.includes(specialty)) {
      throw new ValidationError('Unknown specialty', [
        { path: 'specialty', message: `Must be one of: ${SPECIALTY_KEYS.join(', ')}` },
      ]);
    }
    const policy = this.passwords.validatePolicy(password, { email });
    if (!policy.ok) {
      throw new ValidationError('Password does not meet security requirements', policy.errors);
    }
    if (this.users.emailExists(email)) {
      throw new ConflictError('An account with this email already exists', 'EMAIL_IN_USE');
    }
    if (this.doctors.registrationExists(registrationNo)) {
      throw new ConflictError('This medical registration number is already on file', 'REGISTRATION_IN_USE');
    }

    const autoApprove = this.config.doctorAutoApprove;
    const user = this.users.create({
      email,
      displayName,
      passwordHash: this.passwords.hash(password),
      role: 'user', // admin flag stays platform-controlled
    });

    const slug = this.uniqueSlug(displayName);
    const doctor = this.doctors.create({
      userId: user.id,
      slug,
      fullName: displayName,
      headline: headline || defaultHeadline(specialty),
      specialty,
      subSpecialties,
      qualifications,
      registrationNo,
      registrationCouncil,
      experienceYears,
      languages,
      clinicName,
      city,
      bio,
      consultFeeInr,
      status: 'pending_verification',
      identityCardNo: this.uniqueCardNo(),
    });

    this.audit.record({
      userId: user.id,
      action: 'doctor.applied',
      resourceType: 'doctor_profile',
      resourceId: doctor.id,
      metadata: { specialty, autoApproved: autoApprove, kycMode: this.kycMode },
      ctx,
    });

    return { user, doctor, autoApprove };
  }

  uniqueSlug(name) {
    const base = slugify(name);
    if (!this.doctors.slugExists(base)) return base;
    for (let i = 0; i < 8; i += 1) {
      const candidate = `${base}-${randomCode(4, SLUG_ALPHABET)}`;
      if (!this.doctors.slugExists(candidate)) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  uniqueCardNo() {
    for (let i = 0; i < 10; i += 1) {
      const candidate = `MT-DOC-${randomCode(8, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789')}`;
      if (!this.doctors.identityCardExists(candidate)) return candidate;
    }
    return `MT-DOC-${newId().slice(0, 8).toUpperCase()}`;
  }

  // ------------------------------------------------------------- lifecycle
  /** MOCK KYC: records a reference and flips the profile live. Nothing is verified. */
  completeMockKyc(actor, { ref = null, ctx = {} } = {}) {
    const doctor = this.requireProfile(actor);
    const kycRef = ref || `MOCK-KYC-${randomCode(8, SLUG_ALPHABET).toUpperCase()}`;
    // A live profile must always be able to pass the sign-in gate, so the
    // registration number goes on record as the certificate verdict here too.
    if (this.certificates && !doctor.isCertificateVerified) {
      this.recordCertificate(
        doctor.id,
        this.certificates.checkRegistrationNo({
          registrationNo: doctor.registration_no,
          profileRegistrationNo: doctor.registration_no,
        }),
        {},
        { userId: actor.id, ctx },
      );
    }
    this.doctors.setKyc(doctor.id, { status: 'mock_verified', ref: kycRef });
    const activated = this.doctors.setStatus(doctor.id, 'active');
    this.roles.grant(actor.id, 'doctor', { grantedBy: null });
    this.audit.record({
      userId: actor.id,
      action: 'doctor.kyc_mock_verified',
      resourceType: 'doctor_profile',
      resourceId: doctor.id,
      metadata: { mode: 'mock', ref: kycRef },
      ctx,
    });
    return activated.toJSON();
  }

  requireProfile(actor) {
    const doctor = this.doctors.findByUserId(actor.id);
    if (!doctor) throw new NotFoundError('No doctor profile on this account');
    return doctor;
  }

  /** Every doctor-console request passes through here (role + status + KYC). */
  requireActiveDoctor(actor) {
    const doctor = this.doctors.findByUserId(actor.id);
    if (!doctor) {
      throw new ForbiddenError('Doctor access required', 'DOCTOR_PROFILE_REQUIRED');
    }
    if (doctor.status === 'suspended') {
      throw new ForbiddenError('This doctor profile is suspended', 'DOCTOR_SUSPENDED');
    }
    if (doctor.status !== 'active') {
      throw new ForbiddenError(
        'Complete verification to use the doctor console',
        'DOCTOR_VERIFICATION_PENDING',
      );
    }
    return doctor;
  }

  me(actor) {
    const doctor = this.doctors.findByUserId(actor.id);
    return doctor ? doctor.toJSON() : null;
  }

  updateProfile(actor, fields, ctx = {}) {
    const doctor = this.requireProfile(actor);
    if (fields.specialty && !SPECIALTY_KEYS.includes(fields.specialty)) {
      throw new ValidationError('Unknown specialty');
    }
    const updated = this.doctors.update(doctor.id, fields);
    this.audit.record({
      userId: actor.id,
      action: 'doctor.profile_updated',
      resourceType: 'doctor_profile',
      resourceId: doctor.id,
      metadata: { fields: Object.keys(fields) },
      ctx,
    });
    return updated.toJSON();
  }

  // ---------------------------------------------------------------- public
  publicProfile(idOrSlug) {
    const doctor = this.doctors.findBySlug(idOrSlug) || this.doctors.findById(idOrSlug);
    if (!doctor || doctor.status !== 'active') throw new NotFoundError('Doctor not found');
    return doctor.toPublicJSON();
  }

  directory({ specialty = null, city = null, q = null, page = 1, pageSize = 20 } = {}) {
    const result = this.doctors.list({ specialty, city, q, status: 'active', page, pageSize });
    return {
      items: result.items.map((d) => d.toPublicJSON()),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      specialties: this.specialties(),
      verification: {
        mode: 'mock',
        label: 'Demo verification',
        note: 'Hackathon build — doctor verification and payments are simulated; no real registry or gateway is contacted.',
      },
    };
  }

  specialties() {
    const counts = new Map(this.doctors.specialties().map((s) => [s.specialty, s.doctors]));
    return Object.entries(SPECIALTIES).map(([key, meta]) => ({
      key,
      label: meta.label,
      blurb: meta.blurb,
      doctors: counts.get(key) || 0,
    }));
  }

  // ----------------------------------------------------------------- admin
  adminList(actor, { status = null, page = 1, pageSize = 50 } = {}) {
    this.policy.assertAdmin(actor);
    const result = this.doctors.list({ status, page, pageSize });
    return {
      items: result.items.map((d) => d.toJSON()),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  adminSetStatus(actor, doctorId, status, ctx = {}) {
    this.policy.assertAdmin(actor);
    if (!['pending_verification', 'active', 'suspended'].includes(status)) {
      throw new ValidationError('Unsupported doctor status');
    }
    const doctor = this.doctors.findById(doctorId);
    if (!doctor) throw new NotFoundError('Doctor not found');
    const updated = this.doctors.setStatus(doctorId, status);
    if (status === 'active') {
      if (updated.kyc_status !== 'mock_verified') {
        this.doctors.setKyc(doctorId, { status: 'mock_verified', ref: `MOCK-KYC-ADMIN-${randomCode(6, SLUG_ALPHABET).toUpperCase()}` });
      }
      // An admin activating a profile is itself a review: record it as the
      // certificate verdict so the doctor can pass the sign-in gate.
      if (this.certificates && !updated.isCertificateVerified) {
        const verdict = this.certificates.checkRegistrationNo({
          registrationNo: updated.registration_no,
          profileRegistrationNo: updated.registration_no,
        });
        this.recordCertificate(
          doctorId,
          { ...verdict, method: 'admin_review', mode: 'mock' },
          {},
          { userId: actor.id, ctx },
        );
      }
      this.roles.grant(doctor.user_id, 'doctor', { grantedBy: actor.id });
    } else {
      this.roles.revoke(doctor.user_id, 'doctor');
    }
    this.audit.record({
      userId: actor.id,
      action: 'admin.doctor_status_changed',
      resourceType: 'doctor_profile',
      resourceId: doctorId,
      metadata: { status },
      ctx,
    });
    return this.doctors.findById(doctorId).toJSON();
  }

  /** Doctor-side dashboard numbers (their own, never another doctor's). */
  overview(doctor) {
    const inbox = this.consultations.countForDoctor(doctor.id, { statuses: ['requested'] });
    const inReview = this.consultations.countForDoctor(doctor.id, { statuses: ['in_review'] });
    const answered = this.consultations.countForDoctor(doctor.id, { statuses: ['answered', 'closed'] });
    const watch = this.videos.watchSecondsForDoctor(doctor.id);
    return {
      doctor: doctor.toJSON(),
      queue: { requested: inbox, inReview, answered, total: this.consultations.countForDoctor(doctor.id) },
      reach: { views: watch.views, watchSeconds: watch.seconds, videosPublished: doctor.video_count },
      topVideos: this.videos.topVideosForDoctor(doctor.id),
      verification: {
        status: doctor.status,
        kycStatus: doctor.kyc_status,
        mode: 'mock',
        label: doctor.isVerified ? 'Demo verification' : 'Verification pending',
      },
    };
  }
}
