import { BaseRepository } from './BaseRepository.js';
import { DoctorProfile } from '../domain/care.js';

/**
 * Doctor identities. NOTE: this repository only ever holds professional
 * profile data — no patient data, no credentials, no KYC documents (the mock
 * KYC stores a reference string, nothing more).
 */
export class DoctorRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'doctor_profiles';
  }

  create({
    userId,
    slug,
    fullName,
    headline,
    specialty,
    subSpecialties = [],
    qualifications = [],
    registrationNo,
    registrationCouncil = null,
    experienceYears = 0,
    languages = [],
    clinicName = null,
    city = null,
    bio = null,
    consultFeeInr = 0,
    status = 'pending_verification',
    identityCardNo,
  }) {
    const id = this.id();
    const now = this.now();
    this.db.run(
      `INSERT INTO doctor_profiles (
         id, user_id, slug, full_name, headline, specialty, sub_specialties, qualifications,
         registration_no, registration_council, experience_years, languages, clinic_name, city,
         bio, consult_fee_inr, status, kyc_status, identity_card_no, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started', ?, ?, ?)`,
      id,
      userId,
      slug,
      fullName,
      headline,
      specialty,
      JSON.stringify(subSpecialties),
      JSON.stringify(qualifications),
      registrationNo,
      registrationCouncil,
      experienceYears,
      JSON.stringify(languages),
      clinicName,
      city,
      bio,
      consultFeeInr,
      status,
      identityCardNo,
      now,
      now,
    );
    return this.findById(id);
  }

  findById(id) {
    return DoctorProfile.fromRow(this.db.get('SELECT * FROM doctor_profiles WHERE id = ?', id));
  }

  findByUserId(userId) {
    return DoctorProfile.fromRow(
      this.db.get('SELECT * FROM doctor_profiles WHERE user_id = ?', userId),
    );
  }

  findBySlug(slug) {
    return DoctorProfile.fromRow(
      this.db.get('SELECT * FROM doctor_profiles WHERE slug = ?', String(slug).toLowerCase()),
    );
  }

  slugExists(slug) {
    return !!this.db.get('SELECT 1 AS ok FROM doctor_profiles WHERE slug = ? LIMIT 1', slug);
  }

  registrationExists(registrationNo) {
    return !!this.db.get(
      'SELECT 1 AS ok FROM doctor_profiles WHERE registration_no = ? LIMIT 1',
      registrationNo,
    );
  }

  identityCardExists(cardNo) {
    return !!this.db.get(
      'SELECT 1 AS ok FROM doctor_profiles WHERE identity_card_no = ? LIMIT 1',
      cardNo,
    );
  }

  /** Whitelisted column map — keeps update() free of dynamic keys from callers. */
  static UPDATABLE = {
    fullName: 'full_name',
    headline: 'headline',
    specialty: 'specialty',
    subSpecialties: 'sub_specialties',
    qualifications: 'qualifications',
    registrationCouncil: 'registration_council',
    experienceYears: 'experience_years',
    languages: 'languages',
    clinicName: 'clinic_name',
    city: 'city',
    bio: 'bio',
    consultFeeInr: 'consult_fee_inr',
  };

  update(id, fields) {
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(DoctorRepository.UPDATABLE)) {
      if (!(key in fields) || fields[key] === undefined) continue;
      const value = Array.isArray(fields[key]) ? JSON.stringify(fields[key]) : fields[key];
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (sets.length === 0) return this.findById(id);
    sets.push('updated_at = ?');
    params.push(this.now(), id);
    this.db.run(`UPDATE doctor_profiles SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.findById(id);
  }

  setStatus(id, status) {
    this.db.run(
      'UPDATE doctor_profiles SET status = ?, updated_at = ? WHERE id = ?',
      status,
      this.now(),
      id,
    );
    return this.findById(id);
  }

  setKyc(id, { status, ref = null }) {
    this.db.run(
      `UPDATE doctor_profiles SET kyc_status = ?, kyc_ref = ?, kyc_verified_at = ?, updated_at = ?
       WHERE id = ?`,
      status,
      ref,
      status === 'mock_verified' ? this.now() : null,
      this.now(),
      id,
    );
    return this.findById(id);
  }

  bumpCounter(id, column, by = 1) {
    if (!['video_count', 'consult_count'].includes(column)) return;
    this.db.run(
      `UPDATE doctor_profiles SET ${column} = MAX(0, ${column} + ?), updated_at = ? WHERE id = ?`,
      by,
      this.now(),
      id,
    );
  }

  setRating(id, { average, count }) {
    this.db.run(
      'UPDATE doctor_profiles SET rating_avg = ?, rating_count = ?, updated_at = ? WHERE id = ?',
      average,
      count,
      this.now(),
      id,
    );
  }

  list({ specialty = null, city = null, q = null, status = 'active', page = 1, pageSize = 20 } = {}) {
    const params = [];
    let where = '1=1';
    if (status) {
      where += ' AND status = ?';
      params.push(status);
    }
    if (specialty) {
      where += ' AND specialty = ?';
      params.push(specialty);
    }
    if (city) {
      where += ' AND LOWER(city) = ?';
      params.push(String(city).toLowerCase());
    }
    if (q) {
      where += ' AND (LOWER(full_name) LIKE ? OR LOWER(headline) LIKE ? OR LOWER(specialty) LIKE ? OR LOWER(COALESCE(city, \'\')) LIKE ?)';
      const needle = `%${String(q).toLowerCase()}%`;
      params.push(needle, needle, needle, needle);
    }
    const total = this.count(where, params);
    const rows = this.db.all(
      `SELECT * FROM doctor_profiles WHERE ${where}
       ORDER BY (status = 'active') DESC, rating_avg DESC, video_count DESC, full_name ASC
       LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      (page - 1) * pageSize,
    );
    return { items: rows.map(DoctorProfile.fromRow), total, page, pageSize };
  }

  /** Distinct specialties present in the directory (for filter chips). */
  specialties() {
    return this.db
      .all(
        `SELECT specialty, COUNT(*) AS doctors FROM doctor_profiles
         WHERE status = 'active' GROUP BY specialty ORDER BY doctors DESC, specialty ASC`,
      )
      .map((r) => ({ specialty: r.specialty, doctors: r.doctors }));
  }
}
