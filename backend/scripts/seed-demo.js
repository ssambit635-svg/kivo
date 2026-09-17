#!/usr/bin/env node
/**
 * Demo seed — builds the demo journey from the product spec end-to-end:
 *
 *   demo@medtwin.dev / Dem0!MedTwin#2026        (patient app, /app)
 *   dr.mohan@medtwin.dev / MedTwin!Doctor#2026  (doctor console, /doctor)
 *   ├── 3 synthetic lab reports (Jan → Mar → Jun, clearly improving)
 *   ├── all extracted values USER-VERIFIED (the trust gate)
 *   ├── lifestyle observations (weight / bp / activity)
 *   ├── doctor summary generated once (audited → unlocks that milestone)
 *   ├── the care plan catalogue (free / care_monthly / care_yearly)
 *   └── one verified doctor + two published shorts (one free preview)
 *
 * Result: GET /health-score shows a real rising timeline, /milestones shows
 * 5/5 earned, and every report carries a confidence badge.
 *
 * Safe to re-run: exits with a notice when the demo account already exists.
 * Usage:  node scripts/seed-demo.js
 */
import { Container } from '../src/container/Container.js';

const EMAIL = 'demo@medtwin.dev';
const PASSWORD = 'Dem0!MedTwin#2026';
const NAME = 'Demo User';

// Doctor demo — the "doc Mohan Charan is a bone specialist" identity card.
const DOCTOR_EMAIL = 'dr.mohan@medtwin.dev';
const DOCTOR_PASSWORD = 'MedTwin!Doctor#2026';

const REPORT_JAN = [
  'CITY DIAGNOSTICS CENTER - DEMO LAB',
  'Patient: DEMO USER                  Age/Gender: 42/M',
  'Report Date: 10-01-2026',
  'Test                        Result       Unit          Reference Range',
  'HbA1c                       6.4          %             (4.0 - 5.6)',
  'Fasting Blood Sugar         126          mg/dL         70 - 100',
  'Total Cholesterol           240          mg/dL         Reference: <200',
  'HDL Cholesterol             38           mg/dL         (40 - 60)',
  'LDL Cholesterol             160          mg/dL         (50 - 100)',
  'Triglycerides               210          mg/dL         (30 - 150)',
  'Hemoglobin                  14.1         g/dL          (12 - 16)',
  'Creatinine                  1.1          mg/dL         (0.7 - 1.3)',
  '----- END OF REPORT -----',
].join('\n');

const REPORT_MAR = [
  'CITY DIAGNOSTICS CENTER - DEMO LAB',
  'Patient: DEMO USER                  Age/Gender: 42/M',
  'Report Date: 14-03-2026',
  'Test                        Result       Unit          Reference Range',
  'HbA1c                       6.1          %             (4.0 - 5.6)',
  'Fasting Blood Sugar         115          mg/dL         70 - 100',
  'Total Cholesterol           221          mg/dL         Reference: <200',
  'HDL Cholesterol             41           mg/dL         (40 - 60)',
  'LDL Cholesterol             145          mg/dL         (50 - 100)',
  'Triglycerides               190          mg/dL         (30 - 150)',
  'Hemoglobin                  14.3         g/dL          (12 - 16)',
  'Creatinine                  1.0          mg/dL         (0.7 - 1.3)',
  '----- END OF REPORT -----',
].join('\n');

const REPORT_JUN = [
  'CITY DIAGNOSTICS CENTER - DEMO LAB',
  'Patient: DEMO USER                  Age/Gender: 42/M',
  'Report Date: 13-06-2026',
  'Test                        Result       Unit          Reference Range',
  'HbA1c                       5.5          %             (4.0 - 5.6)',
  'Fasting Blood Sugar         95           mg/dL         70 - 100',
  'Total Cholesterol           195          mg/dL         Reference: <200',
  'HDL Cholesterol             48           mg/dL         (40 - 60)',
  'LDL Cholesterol             105          mg/dL         (50 - 100)',
  'Triglycerides               145          mg/dL         (30 - 150)',
  'Hemoglobin                  14.6         g/dL          (12 - 16)',
  'Creatinine                  1.0          mg/dL         (0.7 - 1.3)',
  '----- END OF REPORT -----',
].join('\n');

async function main() {
  const c = new Container(); // default config → data/medtwin.db (same file the server uses)

  if (c.userRepository.emailExists(EMAIL)) {
    console.log(`demo account already exists (${EMAIL}) — nothing to do.`);
    console.log(`login: ${EMAIL} / ${PASSWORD}`);
    c.close();
    return;
  }

  // 1) account + self member (same pattern as scripts/create-admin.js)
  const user = c.userRepository.create({
    email: EMAIL,
    displayName: NAME,
    passwordHash: c.passwordService.hash(PASSWORD),
  });
  const member = c.memberRepository.create({
    userId: user.id,
    name: NAME,
    relationship: 'self',
    dob: '1984-02-20',
    sex: 'male',
    heightCm: 176,
    familyHistory: { diabetes: true },
  });

  // 2) the scan → verify journey for three reports
  for (const [text, reportDate] of [
    [REPORT_JAN, '2026-01-10'],
    [REPORT_MAR, '2026-03-14'],
    [REPORT_JUN, '2026-06-13'],
  ]) {
    const { report, preview } = await c.reportService.ingest(user, member.id, { text, reportDate });
    await c.reportService.verify(user, report.id, {});
    console.log(`report ${reportDate}: ${preview.extracted?.length ?? 0} values extracted + verified`);
  }

  // 3) lifestyle observations feeding the risk model
  const obs = [
    ['weight', { weightKg: 84 }, '2026-01-10'],
    ['weight', { weightKg: 79 }, '2026-06-13'],
    ['bp', { systolic: 134, diastolic: 86 }, '2026-01-10'],
    ['bp', { systolic: 124, diastolic: 80 }, '2026-06-13'],
    ['activity', { minutesPerWeek: 45 }, '2026-01-10'],
    ['activity', { minutesPerWeek: 170 }, '2026-06-13'],
    ['medication', { name: 'Vitamin D3', dose: '1000 IU daily' }, '2026-03-14'],
  ];
  for (const [kind, payload, observedAt] of obs) {
    c.observationService.create(user, member.id, { kind, payload, observedAt });
  }

  // 4) doctor summary once (build + audit exactly like the HTTP endpoint does)
  await c.doctorSummaryService.build(member);
  c.auditService.record({ userId: user.id, action: 'summary.doctor_generated', resourceType: 'member', resourceId: member.id });

  // 5) one draft left unverified so the "needs review" badge is visible too
  await c.reportService.ingest(user, member.id, {
    text: [
      'CITY DIAGNOSTICS CENTER - DEMO LAB',
      'Report Date: 05-09-2026',
      'HbA1c                       5.4          %             (4.0 - 5.6)',
      'Fasting Blood Sugar         92           mg/dL         70 - 100',
    ].join('\n'),
    reportDate: '2026-09-05',
  });

  // 6) the care plan catalogue (idempotent upsert)
  c.subscriptionService.ensureCatalog();
  console.log('care plans: free / care_monthly (₹199) / care_yearly (₹1499) ready');

  // 7) a verified doctor + two shorts, so the console and the Care tab have content
  if (c.userRepository.emailExists(DOCTOR_EMAIL)) {
    console.log(`doctor account already exists (${DOCTOR_EMAIL}) — leaving it as is.`);
  } else {
    const { doctor } = c.doctorService.apply(
      {
        email: DOCTOR_EMAIL,
        displayName: 'Dr Mohan Charan',
        password: DOCTOR_PASSWORD,
        specialty: 'orthopaedics',
        headline: 'Bone & joint specialist',
        qualifications: ['MBBS', 'MS Orthopaedics'],
        registrationNo: 'MCI-DEMO-4471',
        registrationCouncil: 'Maharashtra Medical Council',
        experienceYears: 12,
        languages: ['English', 'Hindi', 'Marathi'],
        clinicName: 'Charan Bone & Joint Clinic',
        city: 'Pune',
        bio: 'Knees, backs, fractures and sports injuries. I explain the scan before I explain the medicine.',
        consultFeeInr: 400,
      },
      { ip: 'seed', userAgent: 'seed-demo' },
    );
    // apply() returns the JSON view; the entity is what the services take.
    const doctorEntity = c.doctorRepository.findByUserId(doctor.userId);
    const shorts = [
      {
        title: 'Knee pain: three red flags',
        summary: 'When knee pain needs a scan instead of a massage.',
        topic: 'orthopaedics',
        keyPoints: ['Locking or giving way', 'Night pain that wakes you', 'Swelling that will not settle in a week'],
        tags: ['knee', 'pain', 'red flags'],
        durationSec: 45,
        isPreview: true,
        status: 'published',
      },
      {
        title: 'Sitting all day: the 20-minute back rule',
        summary: 'Why your lower back stiffens at a desk and what to do about it.',
        topic: 'orthopaedics',
        keyPoints: ['Stand every 20 minutes', 'Hips above knees', 'Walk 2 minutes, not 10'],
        tags: ['back', 'desk', 'posture'],
        durationSec: 58,
        isPreview: false,
        status: 'published',
      },
    ];
    for (const short of shorts) {
      c.videoService.publish(doctorEntity, short, null, { ip: 'seed', userAgent: 'seed-demo' });
    }
    console.log(`doctor seeded: ${DOCTOR_EMAIL} / ${DOCTOR_PASSWORD} (${doctor.identityCardNo}, status ${doctor.status}, 2 shorts)`);
  }

  const score = c.healthScoreService.timelineFor(member.id);
  const miles = c.milestoneService.evaluate(member.id);
  console.log('\nseed complete:');
  console.log(`  patient login  ${EMAIL} / ${PASSWORD}          → open /app/`);
  console.log(`  doctor login   ${DOCTOR_EMAIL} / ${DOCTOR_PASSWORD} → open /doctor/`);
  console.log(`  score timeline ${score.timeline.map((s) => `${s.label} → ${s.score}`).join(' | ')}`);
  console.log(`  milestones     ${miles.earned}/${miles.total} earned (next: ${miles.next?.key ?? 'none'})`);
  c.close();
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
