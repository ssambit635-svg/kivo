import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext, registerUser, auth } from '../helpers.js';
import { OcrService, PlainTextOcrProvider, PdfTextOcrProvider } from '../../src/services/ocr/OcrService.js';
import { buildDigitalPdf } from '../unit/pdf-ocr.fixture.js';

let ctx, sess, memberId;
beforeAll(async () => {
  // deterministic OCR set: plain-text + PDF (no network-dependent Tesseract probe)
  ctx = makeTestContext({}, { ocrService: new OcrService([new PlainTextOcrProvider(), new PdfTextOcrProvider()]) });
  sess = await registerUser(request, ctx.app, { email: 'pdf@mt.test', displayName: 'Pdf' });
  const members = await request(ctx.app).get('/api/members').set(auth(sess.accessToken));
  memberId = members.body.owned.find((m) => m.relationship === 'self').id;
});
afterAll(() => ctx.container.close());

describe('PDF report ingestion (§6.1)', () => {
  it('digital PDF → text layer → extracted drafts → verify → trends', async () => {
    const ingest = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .attach('file', buildDigitalPdf(), { filename: 'report.pdf', contentType: 'application/pdf' });
    expect(ingest.status).toBe(201);
    expect(ingest.body.report.status).toBe('needs_review');
    expect(ingest.body.report.ocrProvider).toBe('pdf-text');
    expect(ingest.body.preview.extracted.length).toBeGreaterThanOrEqual(2);

    const reportId = ingest.body.report.id;
    const verify = await request(ctx.app).post(`/api/reports/${reportId}/verify`).set(auth(sess.accessToken)).send({});
    expect(verify.status).toBe(200);

    const trends = await request(ctx.app)
      .get(`/api/members/${memberId}/trends?code=hba1c`)
      .set(auth(sess.accessToken));
    // single point: analysis exists even before a second report enables direction
    expect(trends.status).toBe(200);
    expect(trends.body.code).toBe('hba1c');
  });

  it('scanned PDF (no text layer) fails gracefully with paste-text guidance', async () => {
    const scanned = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF', 'latin1');
    const ingest = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .attach('file', scanned, { filename: 'scan.pdf', contentType: 'application/pdf' });
    expect(ingest.status).toBe(201);
    expect(ingest.body.report.status).toBe('ocr_failed');
    expect(ingest.body.preview.needsManualEntry).toBe(true);
    expect(ingest.body.preview.note).toMatch(/paste the report text/i);
    expect(ingest.body.preview.note).not.toMatch(/ocr:setup|npm |tesseract/i);
    expect(ingest.body.report.badge.level).toBe('ocr_issue');
  });

  it('non-PDF bytes with a PDF mime type never crash the pipeline', async () => {
    const ingest = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(sess.accessToken))
      .attach('file', Buffer.from('definitely not a pdf \x00\x01\x02'), { filename: 'evil.pdf', contentType: 'application/pdf' });
    expect(ingest.status).toBe(201);
    expect(['ocr_failed', 'needs_review']).toContain(ingest.body.report.status);
  });
});
