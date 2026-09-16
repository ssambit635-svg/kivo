import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext, registerUser, auth, ingestAndVerify } from '../helpers.js';

/**
 * End-to-end API coverage for the three engagement widgets:
 *   1. Health Score Timeline     GET /api/members/:id/health-score
 *   2. Report Confidence Badge   badge on report list/get/ingest payloads
 *   3. Health Milestones         GET /api/members/:id/milestones
 *
 * Story arc: three reports (Jan/Mar/Jun) get progressively healthier, and
 * every widget reacts accordingly — the "living twin" feeling.
 */

const REPORT_JAN = [
  'CITY DIAGNOSTICS CENTER - DEMO LAB',
  'Patient: DEMO USER',
  'Report Date: 10-01-2026',
  'Test                        Result       Unit          Reference Range',
  'HbA1c                       6.4          %             (4.0 - 5.6)',
  'Fasting Blood Sugar         126          mg/dL         70 - 100',
  'Total Cholesterol           240          mg/dL         Reference: <200',
  'LDL Cholesterol             160          mg/dL         (50 - 100)',
  'Triglycerides               210          mg/dL         (30 - 150)',
  '----- END OF REPORT -----',
].join('\n');

const REPORT_MAR = [
  'CITY DIAGNOSTICS CENTER - DEMO LAB',
  'Patient: DEMO USER',
  'Report Date: 14-03-2026',
  'Test                        Result       Unit          Reference Range',
  'HbA1c                       6.1          %             (4.0 - 5.6)',
  'Fasting Blood Sugar         115          mg/dL         70 - 100',
  'Total Cholesterol           221          mg/dL         Reference: <200',
  'LDL Cholesterol             145          mg/dL         (50 - 100)',
  'Triglycerides               190          mg/dL         (30 - 150)',
  '----- END OF REPORT -----',
].join('\n');

const REPORT_JUN = [
  'CITY DIAGNOSTICS CENTER - DEMO LAB',
  'Patient: DEMO USER',
  'Report Date: 13-06-2026',
  'Test                        Result       Unit          Reference Range',
  'HbA1c                       5.5          %             (4.0 - 5.6)',
  'Fasting Blood Sugar         95           mg/dL         70 - 100',
  'Total Cholesterol           195          mg/dL         Reference: <200',
  'LDL Cholesterol             105          mg/dL         (50 - 100)',
  'Triglycerides               145          mg/dL         (30 - 150)',
  '----- END OF REPORT -----',
].join('\n');

let ctx, sess, memberId;

beforeAll(async () => {
  ctx = makeTestContext();
  sess = await registerUser(request, ctx.app, { email: 'engage@mt.test', displayName: 'Engage' });
  const members = await request(ctx.app).get('/api/members').set(auth(sess.accessToken));
  memberId = members.body.owned.find((m) => m.relationship === 'self').id;

  await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, REPORT_JAN, '2026-01-10');
  await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, REPORT_MAR, '2026-03-14');
  await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, REPORT_JUN, '2026-06-13');
});
afterAll(() => ctx.container.close());

describe('Health Score Timeline — GET /api/members/:id/health-score', () => {
  it('returns a snapshot per verified report: Jan → 33 | Mar → 40 | Jun → 92, ascending like the improving data', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/health-score`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    const { timeline, current } = res.body;

    expect(timeline).toHaveLength(3);
    expect(timeline.map((t) => t.label)).toEqual(['Jan 2026', 'Mar 2026', 'Jun 2026']);
    expect(timeline.map((t) => t.score)).toEqual([33, 40, 92]);
    expect(timeline.map((t) => t.delta)).toEqual([null, 7, 52]);

    expect(current.score).toBe(92);
    expect(current.band).toBe('strong');
    expect(current.delta).toBe(52);
    expect(current.outOfRangeCount).toBe(1);
  });

  it('every snapshot explains itself: per-marker breakdown with status + points + range source', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/health-score`).set(auth(sess.accessToken));
    const jan = res.body.timeline[0];
    expect(jan.markerCount).toBe(5);
    expect(jan.outOfRangeCount).toBe(5);
    expect(jan.drivers.length).toBeGreaterThan(0);

    const hba1c = jan.breakdown.find((b) => b.code === 'hba1c');
    expect(hba1c.status).toBe('high');
    expect(hba1c.points).toBe(45); // 14.3% above range → moderate penalty
    expect(hba1c.referenceRange.source).toBe('report'); // the report's own range wins

    const jun = res.body.timeline[2];
    const ldl = jun.breakdown.find((b) => b.code === 'ldl');
    expect(ldl.status).toBe('high'); // 105 vs <100 — mildly over
    expect(ldl.points).toBe(60);
    expect(jun.breakdown.filter((b) => b.status === 'normal')).toHaveLength(4);
  });

  it('ships methodology + medical-safety disclaimer INSIDE the payload (no bare scores possible)', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/health-score`).set(auth(sess.accessToken));
    expect(res.body.methodology.kind).toMatch(/in-range-share/);
    expect(res.body.methodology.rules.join(' ')).toMatch(/verified/i);
    expect(res.body.disclaimer).toMatch(/not a clinical score/i);
  });

  it('an unverified draft report never moves the score (the verification gate holds)', async () => {
    const draft = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .send({ text: 'HbA1c 14.0 % (4.0 - 5.6)\nFasting Blood Sugar 300 mg/dL 70 - 100', reportDate: '2026-09-01' });
    expect(draft.status).toBe(201);

    const res = await request(ctx.app).get(`/api/members/${memberId}/health-score`).set(auth(sess.accessToken));
    expect(res.body.timeline).toHaveLength(3);
    expect(res.body.current.score).toBe(92);

    await request(ctx.app).delete(`/api/reports/${draft.body.report.id}`).set(auth(sess.accessToken));
  });
});

describe('Health Milestones — GET /api/members/:id/milestones', () => {
  it('four of five earned right after verified reports; next-up is the doctor summary', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/milestones`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    const m = Object.fromEntries(res.body.milestones.map((x) => [x.key, x]));

    expect(res.body.total).toBe(5);
    expect(res.body.earned).toBe(4);
    expect(res.body.next.key).toBe('doctor_summary_generated');

    expect(m.first_report_added.achieved).toBe(true);
    expect(m.first_report_verified.achieved).toBe(true);
    expect(m.first_health_trend.achieved).toBe(true);
    expect(m.first_health_trend.achievedAt).toBe('2026-03-14'); // the 2nd verified hba1c point
    expect(m.three_month_history.achieved).toBe(true); // Jan 10 → Jun 13 = 154 days
    expect(m.three_month_history.achievedAt).toBe('2026-06-13');
    expect(m.doctor_summary_generated.achieved).toBe(false);

    // every milestone carries an icon key a frontend can map to real SVG art
    for (const x of res.body.milestones) expect(x.icon).toMatch(/^[a-z0-9-]+$/);
  });

  it('generating the doctor summary unlocks the last milestone (via the audited event)', async () => {
    const summary = await request(ctx.app).get(`/api/members/${memberId}/doctor-summary`).set(auth(sess.accessToken));
    expect(summary.status).toBe(200);

    const res = await request(ctx.app).get(`/api/members/${memberId}/milestones`).set(auth(sess.accessToken));
    expect(res.body.earned).toBe(5);
    expect(res.body.next).toBeNull();
    const done = res.body.milestones.find((x) => x.key === 'doctor_summary_generated');
    expect(done.achieved).toBe(true);
    expect(done.achievedAt).toBeTruthy();
  });
});

describe('Report Confidence Badge — derived badge on report payloads', () => {
  it('verified reports carry the green "verified" badge on the list endpoint', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/reports`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.badge).toBeDefined();
      expect(item.badge.level).toBe('verified');
      expect(item.badge.label).toBe('Verified');
      expect(item.badge.tone).toBe('green');
      expect(item.badge.icon).toBe('shield-check');
    }
  });

  it('a fresh OCR draft gets the amber "needs_review" badge (list + single get)', async () => {
    const ingest = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .send({ text: 'HbA1c 5.8 % (4.0 - 5.6)' });
    expect(ingest.status).toBe(201);
    expect(ingest.body.report.badge.level).toBe('needs_review');
    expect(ingest.body.report.badge.icon).toBe('alert-triangle');

    const single = await request(ctx.app).get(`/api/reports/${ingest.body.report.id}`).set(auth(sess.accessToken));
    expect(single.body.badge.level).toBe('needs_review'); // single get spreads the report at top level

    await request(ctx.app).delete(`/api/reports/${ingest.body.report.id}`).set(auth(sess.accessToken));
  });

  it('an unreadable upload (image file, no OCR engine in this env) → red "ocr_issue" badge', async () => {
    // Minimal PNG magic bytes — no image OCR provider is installed in this
    // cost-free test env, so the pipeline must fail loudly into ocr_failed.
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
    const ingest = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .attach('file', fakePng, { filename: 'scan.png', contentType: 'image/png' });
    expect(ingest.status).toBe(201);
    expect(ingest.body.report.status).toBe('ocr_failed');
    expect(ingest.body.report.badge.level).toBe('ocr_issue');
    expect(ingest.body.report.badge.tone).toBe('red');
    expect(ingest.body.report.badge.icon).toBe('scan-line');
    expect(ingest.body.report.badge.ocrError).toBeTruthy();

    const list = await request(ctx.app)
      .get(`/api/members/${memberId}/reports?status=ocr_failed`)
      .set(auth(sess.accessToken));
    expect(list.body.items[0].badge.level).toBe('ocr_issue');

    await request(ctx.app).delete(`/api/reports/${ingest.body.report.id}`).set(auth(sess.accessToken));
  });
});

describe('Authorization for the new widgets', () => {
  it('a shared VIEWER can read health score + milestones (read-level members only)', async () => {
    const viewer = await registerUser(request, ctx.app, { email: 'viewer-engage@mt.test', displayName: 'Viewer' });
    const grant = await request(ctx.app)
      .post(`/api/members/${memberId}/shares`)
      .set(auth(sess.accessToken))
      .send({ granteeEmail: 'viewer-engage@mt.test', permission: 'viewer' });
    expect(grant.status).toBe(201);

    for (const path of ['health-score', 'milestones']) {
      const res = await request(ctx.app).get(`/api/members/${memberId}/${path}`).set(auth(viewer.accessToken));
      expect(res.status).toBe(200);
    }
  });

  it('strangers get existence-hiding 404s on both endpoints', async () => {
    const stranger = await registerUser(request, ctx.app, { email: 'stranger-engage@mt.test', displayName: 'Stranger' });
    for (const path of ['health-score', 'milestones']) {
      const res = await request(ctx.app).get(`/api/members/${memberId}/${path}`).set(auth(stranger.accessToken));
      expect(res.status).toBe(404);
    }
  });

  it('unauthenticated calls are rejected', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/health-score`);
    expect(res.status).toBe(401);
  });
});
