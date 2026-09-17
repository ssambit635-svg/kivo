import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestContext } from '../helpers.js';
import { MEDICINE_ACKNOWLEDGEMENTS } from '../../src/services/care/catalog.js';

/**
 * The two AI-adjacent surfaces a clinician relies on:
 *   • the medicine DRAFT — suggestions only, never doses, never patient-visible
 *   • the clinical BRIEF — verified data only, scoped by patient consent
 */

let ctx, member, doctor, patient, consultation, medicines, brief, reports;

function addLab({ reportId, code, testName, value, unit, refLow, refHigh, verified = 1, suspicious = 0, measuredAt = '2026-03-12T00:00:00.000Z' }) {
  return ctx.container.labResultRepository.create({
    reportId,
    memberId: member.id,
    code,
    testName,
    value,
    unit,
    refLow,
    refHigh,
    measuredAt,
    verified,
    suspicious,
  });
}

beforeAll(() => {
  ctx = makeTestContext();
  medicines = ctx.container.medicineSuggestionService;
  brief = ctx.container.clinicalBriefService;
  reports = ctx.container.reportRepository;

  const hash = ctx.container.passwordService.hash('Str0ng!Passw0rd#2026');
  patient = ctx.container.userRepository.create({ email: 'mb-patient@mt.test', displayName: 'MB Patient', passwordHash: hash });
  member = ctx.container.memberRepository.create({
    userId: patient.id,
    name: 'MB Patient',
    relationship: 'self',
    dob: '1958-04-04', // 68 → elderly caution
    sex: 'male',
    heightCm: 170,
    familyHistory: { diabetes: 'father' },
  });

  const docUser = ctx.container.userRepository.create({ email: 'mb-doc@mt.test', displayName: 'Dr MB', passwordHash: hash });
  doctor = ctx.container.doctorRepository.create({
    userId: docUser.id,
    slug: 'dr-mb',
    fullName: 'Dr MB',
    headline: 'Bone & joint specialist',
    specialty: 'orthopaedics',
    registrationNo: 'MCI-123',
    status: 'active',
    identityCardNo: 'MT-DOC-MB',
    consultFeeInr: 300,
  });

  const report = reports.create({
    memberId: member.id,
    uploadedBy: patient.id,
    originalName: 'labs.pdf',
    status: 'verified',
    verifiedAt: '2026-03-12T00:00:00.000Z',
  });
  const reportId = report.id;
  addLab({ reportId, code: 'hba1c', testName: 'HbA1c', value: 7.1, unit: '%', refLow: 4, refHigh: 5.6 });
  addLab({ reportId, code: 'ldl', testName: 'LDL Cholesterol', value: 168, unit: 'mg/dL', refLow: 50, refHigh: 100 });
  addLab({ reportId, code: 'creatinine', testName: 'Creatinine', value: 1.6, unit: 'mg/dL', refLow: 0.7, refHigh: 1.3 });
  // An unverified OCR draft with a wild value — it must be invisible to both features.
  addLab({ reportId, code: 'triglycerides', testName: 'Triglycerides', value: 999, unit: 'mg/dL', refLow: 30, refHigh: 150, verified: 0 });
  // A verified but OCR-suspicious reading — excluded from drafting.
  addLab({ reportId, code: 'hemoglobin', testName: 'Hemoglobin', value: 4.2, unit: 'g/dL', refLow: 12, refHigh: 16, suspicious: 1 });

  ctx.container.observationRepository.create({
    memberId: member.id,
    createdBy: patient.id,
    kind: 'medication',
    payload: { name: 'Metformin 500', dose: '1-0-1' },
  });
  ctx.container.observationRepository.create({
    memberId: member.id,
    createdBy: patient.id,
    kind: 'bp',
    payload: { systolic: 148, diastolic: 92 },
  });
  ctx.container.observationRepository.create({
    memberId: member.id,
    createdBy: patient.id,
    kind: 'weight',
    payload: { weightKg: 78 },
  });

  consultation = ctx.container.consultationRepository.create({
    memberId: member.id,
    patientUserId: patient.id,
    doctorId: doctor.id,
    subject: 'Sugar and kidney values',
    question: 'My sugar and creatinine are both high — what should I do next?',
    status: 'requested',
    feeInr: 300,
    consentScope: ['labs', 'trends', 'vitals', 'medications', 'risk', 'reports'],
    consentExpiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
});
afterAll(() => ctx.container.close());

describe('AI medicine draft', () => {
  it('drafts therapy classes from out-of-range verified values, with cautions and no dose', () => {
    const draft = medicines.draftForMember(member);
    expect(draft.aiGenerated).toBe(true);
    expect(draft.requiresDoctorApproval).toBe(true);
    expect(draft.patientVisible).toBe(false);
    const codes = draft.items.map((i) => i.markerCode);
    expect(codes).toContain('hba1c');
    expect(codes).toContain('ldl');
    expect(codes).toContain('creatinine');
    for (const item of draft.items) {
      expect(item.doseIncluded).toBe(false);
      expect(item.cautions.length).toBeGreaterThan(0);
      expect(item.rationale.length).toBeGreaterThan(20);
      expect(JSON.stringify(item)).not.toMatch(/\d+\s?(mg|mcg|ml)\b/i);
    }
    // renal impairment must not turn into a new prescription suggestion
    expect(draft.items.find((i) => i.markerCode === 'creatinine').suggestedClass).toMatch(/No drug suggestion/i);
  });

  it('never uses an unverified OCR draft value', () => {
    const draft = medicines.draftForMember(member);
    expect(draft.items.map((i) => i.markerCode)).not.toContain('triglycerides');
    const serialized = JSON.stringify(draft);
    expect(serialized).not.toContain('999');
  });

  it('excludes OCR-suspicious readings and says so', () => {
    const draft = medicines.draftForMember(member);
    expect(draft.items.map((i) => i.markerCode)).not.toContain('hemoglobin');
    expect(draft.skipped.suspiciousOcrValues.map((s) => s.code)).toContain('hemoglobin');
    expect(draft.skipped.note).toMatch(/OCR/i);
  });

  it('flags a possible duplicate against the recorded medication list', () => {
    const draft = medicines.draftForMember(member);
    const hba1c = draft.items.find((i) => i.markerCode === 'hba1c');
    expect(hba1c.possibleDuplicate).toBeTruthy();
    expect(hba1c.possibleDuplicate.agent).toBe('metformin');
  });

  it('adds age-related cautions for an elderly patient', () => {
    const draft = medicines.draftForMember(member);
    expect(draft.considerations.join(' ')).toMatch(/65\+/);
  });

  it('keeps every draft strictly doctor-facing until it is approved', () => {
    const saved = medicines.refreshDraft(doctor, consultation, member);
    expect(saved.status).toBe('draft');
    expect(medicines.approvedForPatient(consultation)).toBeNull();
  });

  it('refuses approval without the safety checklist, then accepts a full one', () => {
    expect(() =>
      medicines.approve(doctor, consultation, { items: [{ code: 'hba1c', decision: 'keep' }], acknowledgements: ['allergies'] }),
    ).toThrowError(/safety check/i);

    const approved = medicines.approve(doctor, consultation, {
      items: [{ code: 'hba1c', decision: 'edit', product: 'Metformin class', instructions: 'After food, review in 3 months' }],
      doctorNote: 'Continue current therapy with a review.',
      acknowledgements: MEDICINE_ACKNOWLEDGEMENTS.map((a) => a.key),
    });
    expect(approved.status).toBe('approved');
    const patientView = medicines.approvedForPatient(consultation);
    expect(patientView.items).toHaveLength(1);
    expect(patientView).not.toHaveProperty('aiDraft');
    expect(JSON.stringify(patientView)).not.toMatch(/rationale|exampleAgents|followUp/);
  });
});

describe('clinical brief', () => {
  it('compiles verified-only problems, vitals, medicines and risk in one screen', async () => {
    const built = await brief.build(member, { scope: ['labs', 'trends', 'vitals', 'medications', 'risk', 'reports'] });
    expect(built.provenance.source).toMatch(/user-verified/i);
    expect(built.member.age).toBeGreaterThan(60);
    expect(built.activeProblems.map((p) => p.code)).toEqual(expect.arrayContaining(['hba1c', 'ldl', 'creatinine']));
    expect(built.activeProblems.map((p) => p.code)).not.toContain('triglycerides'); // unverified draft
    expect(built.vitals.bmi).toBeGreaterThan(20);
    expect(built.vitals.bp.systolic).toBe(148);
    expect(built.medications.map((m) => m.name)).toContain('Metformin 500');
    expect(built.gapsToAsk.length).toBeLessThanOrEqual(6);
    expect(built.gapsToAsk.map((g) => g.key)).toContain('allergies');
    expect(built.gapsToAsk.map((g) => g.key)).not.toContain('family_history'); // already recorded
  });

  it('honours a narrowed consent scope', async () => {
    const built = await brief.build(member, { scope: ['labs'] });
    expect(built.activeProblems.length).toBeGreaterThan(0);
    expect(built.vitals).toEqual({});
    expect(built.medications).toEqual([]);
    expect(built.recentReports).toEqual([]);
    expect(built.riskFlags).toEqual([]);
  });
});
