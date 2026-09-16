import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  makeTestContext,
  registerUser,
  auth,
  SAMPLE_REPORT_TEXT,
  ingestAndVerify,
} from '../helpers.js';

let ctx, sess, memberId;
beforeAll(async () => {
  ctx = makeTestContext();
  sess = await registerUser(request, ctx.app, { email: 'reports@mt.test', displayName: 'R' });
  const members = await request(ctx.app).get('/api/members').set(auth(sess.accessToken));
  memberId = members.body.owned.find((m) => m.relationship === 'self').id;
});
afterAll(() => ctx.container.close());

describe('report ingestion — the scan + verify safety flow', () => {
  let reportId;

  it('ingests plain-text report JSON and extracts 9 draft values', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .send({ text: SAMPLE_REPORT_TEXT });
    expect(res.status).toBe(201);
    expect(res.body.report.status).toBe('needs_review');
    expect(res.body.report.ocrProvider).toBe('plain-text');
    expect(res.body.report.reportDate).toBe('2026-03-12T00:00:00.000Z'); // detected from header
    expect(res.body.preview.extracted).toHaveLength(9);
    reportId = res.body.report.id;
  });

  it('SAFETY: every extracted value starts UNVERIFIED with confidence + raw line', async () => {
    const res = await request(ctx.app).get(`/api/reports/${reportId}`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(9);
    for (const r of res.body.results) {
      expect(r.verified).toBe(false);
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.rawLine).toBeTruthy();
    }
  });

  it('extraction kept the report\'s own reference ranges', async () => {
    const res = await request(ctx.app).get(`/api/reports/${reportId}`).set(auth(sess.accessToken));
    const hba1c = res.body.results.find((r) => r.code === 'hba1c');
    expect(hba1c.refLow).toBe(4.0);
    expect(hba1c.refHigh).toBe(5.6);
    const chol = res.body.results.find((r) => r.code === 'total_cholesterol');
    expect(chol.refHigh).toBe(200); // one-sided "<200" captured
  });

  it('user can CORRECT an extracted value before verifying (review step)', async () => {
    const res = await request(ctx.app).get(`/api/reports/${reportId}`).set(auth(sess.accessToken));
    const hba1c = res.body.results.find((r) => r.code === 'hba1c');
    const patched = await request(ctx.app)
      .patch(`/api/lab-results/${hba1c.id}`)
      .set(auth(sess.accessToken))
      .send({ value: 5.7 });
    expect(patched.status).toBe(200);
    const after = patched.body;
    expect(after.value).toBe(5.7);
  });

  it('user can add a missing value manually', async () => {
    const res = await request(ctx.app)
      .post(`/api/reports/${reportId}/lab-results`)
      .set(auth(sess.accessToken))
      .send({ code: 'vitamin_d', testName: 'Vitamin D (25-OH)', value: 18, unit: 'ng/mL', refLow: 30, refHigh: null });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('vitamin_d');
  });

  it('user can delete a bogus extraction', async () => {
    const add = await request(ctx.app)
      .post(`/api/reports/${reportId}/lab-results`)
      .set(auth(sess.accessToken))
      .send({ code: 'wbc', value: 6.0, unit: '10^3/µL' });
    const del = await request(ctx.app)
      .delete(`/api/lab-results/${add.body.id}`)
      .set(auth(sess.accessToken));
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
  });

  it('verify-promotes the report; all values become verified', async () => {
    const res = await request(ctx.app)
      .post(`/api/reports/${reportId}/verify`)
      .set(auth(sess.accessToken))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('verified');
    const detail = await request(ctx.app).get(`/api/reports/${reportId}`).set(auth(sess.accessToken));
    expect(detail.body.results.every((r) => r.verified)).toBe(true);
  });

  it('a verified report is IMMUTABLE until re-opened (409 REPORT_LOCKED)', async () => {
    const detail = await request(ctx.app).get(`/api/reports/${reportId}`).set(auth(sess.accessToken));
    const lab = detail.body.results[0];
    const edit = await request(ctx.app)
      .patch(`/api/lab-results/${lab.id}`)
      .set(auth(sess.accessToken))
      .send({ value: 99 });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('REPORT_LOCKED');

    const meta = await request(ctx.app)
      .patch(`/api/reports/${reportId}`)
      .set(auth(sess.accessToken))
      .send({ notes: 'x' });
    expect(meta.status).toBe(409);
  });

  it('unverify reopens review and re-verifying works again', async () => {
    const re = await request(ctx.app)
      .post(`/api/reports/${reportId}/unverify`)
      .set(auth(sess.accessToken));
    expect(re.body.status).toBe('needs_review');
    const detail = await request(ctx.app).get(`/api/reports/${reportId}`).set(auth(sess.accessToken));
    expect(detail.body.results.every((r) => !r.verified)).toBe(true);
    const again = await request(ctx.app)
      .post(`/api/reports/${reportId}/verify`)
      .set(auth(sess.accessToken))
      .send({});
    expect(again.body.status).toBe('verified');
  });

  it('unverify of an unverified report is a clean conflict', async () => {
    const r2 = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .send({ text: 'HbA1c 6.0 % (4.0 - 5.6)' });
    const res = await request(ctx.app)
      .post(`/api/reports/${r2.body.report.id}/unverify`)
      .set(auth(sess.accessToken));
    expect(res.status).toBe(409);
  });

  it('verifying an EMPTY report is rejected (nothing to trust)', async () => {
    const empty = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .send({ text: 'nothing medical here at all' });
    const res = await request(ctx.app)
      .post(`/api/reports/${empty.body.report.id}/verify`)
      .set(auth(sess.accessToken))
      .send({});
    expect(res.status).toBe(422);
  });
});

describe('uploads (multipart) with real files', () => {
  it('accepts a .txt file upload', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .attach('file', Buffer.from('Hemoglobin 13.8 g/dL (12 - 16)', 'utf8'), 'report.txt');
    expect(res.status).toBe(201);
    expect(res.body.preview.extracted.length).toBeGreaterThan(0);
    expect(res.body.report.originalName).toBe('report.txt');
  });

  it('reports without a provider-supported type go to ocr_failed with guidance — no crash', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), 'scan.png');
    expect(res.status).toBe(201);
    expect(res.body.report.status).toBe('ocr_failed');
    expect(res.body.preview.needsManualEntry).toBe(true);
    expect(res.body.preview.note).toMatch(/plain-text/i);
  });

  it('rejects disallowed MIME types (415)', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .attach('file', Buffer.from('MZ123'), { filename: 'evil.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(415);
  });

  it('rejects files over the size limit (413)', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 'a');
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .attach('file', big, 'huge.txt');
    expect(res.status).toBe(413);
  });

  it('requires either a file or text (400)', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('report listing, scoping & deletion', () => {
  it('lists only the requesting member\'s reports, newest first, with counts', async () => {
    const res = await request(ctx.app).get(`/api/members/${memberId}/reports?page=1&pageSize=5`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
    expect(res.body.items[0]).toHaveProperty('labResultCount');
    for (const r of res.body.items) expect(r.memberId).toBe(memberId);
  });

  it('supports status filtering', async () => {
    const res = await request(ctx.app)
      .get(`/api/members/${memberId}/reports?status=verified`)
      .set(auth(sess.accessToken));
    expect(res.body.items.every((r) => r.status === 'verified')).toBe(true);
  });

  it('another user cannot list my reports (404)', async () => {
    const other = await registerUser(request, ctx.app, { email: 'nosy@mt.test' });
    const res = await request(ctx.app).get(`/api/members/${memberId}/reports`).set(auth(other.accessToken));
    expect(res.status).toBe(404);
  });

  it('deleting a report cascades its lab results', async () => {
    const { reportId } = await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, 'TSH 2.0 uIU/mL (0.4 - 4.0)');
    const del = await request(ctx.app).delete(`/api/reports/${reportId}`).set(auth(sess.accessToken));
    expect(del.status).toBe(200);
    const rows = ctx.container.labResultRepository.listByReport(reportId);
    expect(rows).toHaveLength(0);
  });
});

describe('grounded report explanation (Layer 6)', () => {
  it('narrates strictly from the stored values, with safety language, for verified data', async () => {
    const { reportId } = await ingestAndVerify(request, ctx.app, sess.accessToken, memberId, SAMPLE_REPORT_TEXT, '2026-03-12');
    const res = await request(ctx.app).get(`/api/reports/${reportId}/explanation`).set(auth(sess.accessToken));
    expect(res.status).toBe(200);
    const { explanation } = res.body;
    expect(explanation.provider).toBe('grounded-local');
    expect(explanation.text).toContain('5.9'); // grounded: actual stored value shows up
    expect(explanation.text).toContain('HbA1c');
    expect(explanation.text).toMatch(/reference range shown on this report/i);
    expect(explanation.text).toMatch(/qualified healthcare professional/i);
    expect(explanation.text).not.toMatch(/you have diabetes/i);
    expect(explanation.grounding.safetyNotice).toMatch(/not a medical diagnosis/i);
  });

  it('explanation requires read access', async () => {
    const other = await registerUser(request, ctx.app, { email: 'nosy2@mt.test' });
    const reports = await request(ctx.app).get(`/api/members/${memberId}/reports`).set(auth(sess.accessToken));
    const res = await request(ctx.app)
      .get(`/api/reports/${reports.body.items[0].id}/explanation`)
      .set(auth(other.accessToken));
    expect(res.status).toBe(404);
  });
});
