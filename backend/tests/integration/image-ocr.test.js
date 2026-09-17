import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestContext, registerUser, auth, SAMPLE_REPORT_TEXT } from '../helpers.js';
import { OcrService, PlainTextOcrProvider, TesseractJsOcrProvider } from '../../src/services/ocr/OcrService.js';

/**
 * Image OCR — the flagship "point the phone at a paper lab report" path.
 *
 * Historically this path was untested-to-success: no image OCR engine was
 * installed, so image uploads fell into `ocr_failed` and two tests asserted
 * that failure as correct behaviour. These tests pin the opposite: a photo of
 * a lab report must ingest, extract, verify and feed the trend engine.
 *
 * The real Tesseract engine needs vendored language data (a ~4 MB binary that
 * is not committed), so the *engine* is injected. Everything downstream —
 * MIME allowlist, on-disk storage, extraction, drafts, verification gate,
 * trends, badges — is the genuine production pipeline.
 */

/** Deterministic image OCR engine: returns real report text for image MIMEs. */
class FakeImageOcrProvider {
  name = 'fake-image-ocr';
  calls = [];

  constructor({ text = SAMPLE_REPORT_TEXT, confidence = 0.94 } = {}) {
    this.text = text;
    this.confidence = confidence;
  }

  supports(mimeType) {
    return /^image\/(png|jpe?g|bmp|webp|tiff?)$/.test(mimeType || '');
  }

  async isAvailable() {
    return true;
  }

  async unavailabilityReason() {
    return null;
  }

  async extract({ buffer, mimeType }) {
    this.calls.push({ bytes: buffer.length, mimeType });
    return { text: this.text, confidence: this.confidence, provider: this.name };
  }
}

/** A minimal but structurally valid PNG header + junk payload. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
  Buffer.alloc(64, 0x42),
]);

describe('image report ingest (photo of a lab report)', () => {
  let ctx;
  let imageProvider;
  let accessToken;
  let memberId;

  beforeAll(async () => {
    imageProvider = new FakeImageOcrProvider();
    ctx = makeTestContext({}, { ocrService: new OcrService([new PlainTextOcrProvider(), imageProvider]) });
    const reg = await registerUser(request, ctx.app, { email: 'photo@medtwin.test' });
    accessToken = reg.accessToken;
    const members = await request(ctx.app).get('/api/members').set(auth(accessToken));
    memberId = members.body.owned.find((m) => m.relationship === 'self').id;
  });

  afterAll(() => ctx.container.close());

  it('ingests an image upload and EXTRACTS markers (not ocr_failed)', async () => {
    const res = await request(ctx.app)
      .post(`/api/members/${memberId}/reports`)
      .set(auth(accessToken))
      .attach('file', PNG_BYTES, { filename: 'scan.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.report.status).toBe('needs_review');
    expect(res.body.report.mimeType).toBe('image/png');
    expect(res.body.report.ocrProvider).toBe('fake-image-ocr');
    expect(res.body.preview.needsManualEntry).toBeFalsy();
    expect(res.body.preview.extracted.length).toBeGreaterThan(0);
    expect(imageProvider.calls).toHaveLength(1);
    expect(imageProvider.calls[0].mimeType).toBe('image/png');
  });

  it('stores extracted values as UNVERIFIED drafts (the safety gate)', async () => {
    const list = await request(ctx.app).get(`/api/members/${memberId}/reports`).set(auth(accessToken));
    const report = list.body.items[0];
    expect(report.status).toBe('needs_review');
    expect(report.badge.level).toBe('needs_review');
    expect(report.badge.tone).toBe('amber');

    const detail = await request(ctx.app).get(`/api/reports/${report.id}`).set(auth(accessToken));
    expect(detail.body.results.length).toBeGreaterThan(0);
    expect(detail.body.results.every((l) => l.verified === false)).toBe(true);
    // Extraction must be real structured data, not a blob of OCR text.
    const hba1c = detail.body.results.find((l) => l.code === 'hba1c');
    expect(hba1c).toBeTruthy();
    expect(hba1c.value).toBe(5.9);
    expect(hba1c.refHigh).toBe(5.6);
    expect(hba1c.status).toBe('high');
  });

  it('preserves OCR confidence on the report', async () => {
    const list = await request(ctx.app).get(`/api/members/${memberId}/reports`).set(auth(accessToken));
    expect(list.body.items[0].ocrConfidence).toBeCloseTo(0.94, 5);
  });

  it('verified image-sourced values feed trends and the health score', async () => {
    const list = await request(ctx.app).get(`/api/members/${memberId}/reports`).set(auth(accessToken));
    const reportId = list.body.items[0].id;

    const verify = await request(ctx.app).post(`/api/reports/${reportId}/verify`).set(auth(accessToken)).send({});
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('verified'); // verify returns the report itself

    const score = await request(ctx.app).get(`/api/members/${memberId}/health-score`).set(auth(accessToken));
    expect(score.status).toBe(200);
    expect(score.body.timeline.length).toBe(1);
    expect(score.body.timeline[0].score).toBeGreaterThan(0);

    const after = await request(ctx.app).get(`/api/members/${memberId}/reports`).set(auth(accessToken));
    expect(after.body.items[0].badge.level).toBe('verified');
    expect(after.body.items[0].badge.tone).toBe('green');
  });

  it('still degrades gracefully when no image engine is available', async () => {
    const bare = makeTestContext({}, { ocrService: new OcrService([new PlainTextOcrProvider()]) });
    try {
      const reg = await registerUser(request, bare.app, { email: 'noimg@medtwin.test' });
      const m = await request(bare.app).get('/api/members').set(auth(reg.accessToken));
      const mid = m.body.owned.find((x) => x.relationship === 'self').id;
      const res = await request(bare.app)
        .post(`/api/members/${mid}/reports`)
        .set(auth(reg.accessToken))
        .attach('file', PNG_BYTES, { filename: 'scan.png', contentType: 'image/png' });

      expect(res.status).toBe(201); // never a 500
      expect(res.body.report.status).toBe('ocr_failed');
      expect(res.body.report.badge.level).toBe('ocr_issue');
      expect(res.body.preview.needsManualEntry).toBe(true);
    } finally {
      bare.container.close();
    }
  });
});

describe('TesseractJsOcrProvider availability (the real engine)', () => {
  it('supports image MIME types and not text', () => {
    const p = new TesseractJsOcrProvider();
    expect(p.supports('image/jpeg')).toBe(true);
    expect(p.supports('image/png')).toBe(true);
    expect(p.supports('image/webp')).toBe(true);
    expect(p.supports('image/tiff')).toBe(true);
    expect(p.supports('text/plain')).toBe(false);
    expect(p.supports('application/pdf')).toBe(false);
  });

  it('is UNAVAILABLE with an actionable reason when language data is absent', async () => {
    const missing = path.join(os.tmpdir(), `mt-nolang-${Date.now()}`);
    const p = new TesseractJsOcrProvider({ langDir: missing });
    expect(p.resolveLocalLangData()).toBeNull();
    // Hermetic: simulate the offline venue (no CDN to fall back to) no
    // matter whether THIS machine has internet — without the stub this
    // test passes offline and fails online (CDN reachable ⇒ available).
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('offline (stubbed for test)');
    };
    try {
      expect(await p.isAvailable()).toBe(false);
      const reason = await p.unavailabilityReason();
      expect(reason).toBeTruthy();
      // Must tell the operator how to fix it, not just that it failed.
      expect(reason).toMatch(/ocr:setup/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('falls back to the CDN when reachable (online laptop, nothing vendored)', async () => {
    const p = new TesseractJsOcrProvider({ langDir: '/nonexistent' });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true });
    try {
      expect(await p.isAvailable()).toBe(true);
      expect(await p.unavailabilityReason()).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('becomes AVAILABLE and points langPath at LOCAL data once vendored (offline-capable)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-lang-'));
    try {
      fs.writeFileSync(path.join(dir, 'eng.traineddata.gz'), Buffer.from('vendored-placeholder'));
      const p = new TesseractJsOcrProvider({ langDir: dir });
      expect(p.resolveLocalLangData()).toEqual({ file: path.join(dir, 'eng.traineddata.gz'), gzip: true });
      expect(p.langOptions()).toEqual({ langPath: dir, gzip: true });
      expect(await p.isAvailable()).toBe(true);

      const svc = new OcrService([new PlainTextOcrProvider(), p]);
      expect((await svc.providerFor('image/jpeg'))?.name).toBe('tesseract.js');
      expect((await svc.providerFor('image/png'))?.name).toBe('tesseract.js');
      expect((await svc.providerFor('text/plain'))?.name).toBe('plain-text');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers an uncompressed vendored file and sets gzip:false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-lang2-'));
    try {
      fs.writeFileSync(path.join(dir, 'eng.traineddata'), Buffer.from('x'));
      const p = new TesseractJsOcrProvider({ langDir: dir });
      expect(p.langOptions()).toEqual({ langPath: dir, gzip: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caches the CDN availability verdict so repeat scans do not re-probe the network', async () => {
    // Probing on every upload would make an offline venue fail slowly instead
    // of instantly. First call probes; the second must reuse the verdict.
    // Hermetic: stub the network (offline) from the START so the verdict is
    // deterministic with or without internet on this machine.
    const p = new TesseractJsOcrProvider({ langDir: '/nonexistent', probeTtlMs: 60_000 });
    expect(p._probe).toBeNull();
    let probed = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      probed += 1;
      throw new Error('offline (stubbed for test)');
    };
    try {
      const first = await p.unavailabilityReason();
      expect(first).toBeTruthy();
      expect(p._probe).not.toBeNull();
      expect(probed).toBe(1);

      const second = await p.unavailabilityReason();
      expect(second).toBe(first);
      expect(probed).toBe(1); // cached — no second network round trip
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('surfaces every candidate reason via diagnose()', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('offline (stubbed for test)');
    };
    try {
      const svc = new OcrService([new PlainTextOcrProvider(), new TesseractJsOcrProvider({ langDir: '/nonexistent' })]);
      const reasons = await svc.diagnose('image/jpeg');
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toMatch(/^tesseract\.js:/);
      expect(reasons[0]).toMatch(/ocr:setup/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('close() is safe when no worker was ever created', async () => {
    const svc = new OcrService([new PlainTextOcrProvider(), new TesseractJsOcrProvider({ langDir: '/nonexistent' })]);
    await expect(svc.close()).resolves.toBeUndefined();
  });
});

describe('TesseractJsOcrProvider runtime failures (the real engine, failing)', () => {
  it('wraps worker failures — which reject with plain STRINGS — in an actionable Error', async () => {
    // tesseract.js rejects recognize() with `err.toString()` from the worker
    // script, NOT an Error object. A naive `err.message` read on that shape
    // is `undefined`, which used to surface as an empty preview note and a
    // badge without ocrError on online machines (where the engine is
    // "available" via the CDN and actually attempts the scan).
    const p = new TesseractJsOcrProvider({ langDir: '/nonexistent' });
    p.worker = async () => ({
      recognize: async () => {
        throw 'Error: Error attempting to read image.';
      },
    });
    const err = await p.extract({ buffer: Buffer.from([1, 2, 3]) }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('OCR_UNAVAILABLE');
    expect(err.message).toMatch(/attempting to read image/);
    expect(err.message).toMatch(/ocr:setup|paste the report text/i);
  });

  it('wraps engine STARTUP failures the same way (e.g. language download died)', async () => {
    const p = new TesseractJsOcrProvider({ langDir: '/nonexistent' });
    p.worker = async () => {
      throw new Error('fetch failed');
    };
    const err = await p.extract({ buffer: Buffer.from([1, 2, 3]) }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/failed to start/);
    expect(err.message).toMatch(/ocr:setup|paste the report text/i);
  });

  it('fails FAST when engine startup stalls (flaky CDN) instead of hanging the scan', async () => {
    const p = new TesseractJsOcrProvider({ langDir: '/nonexistent', workerTimeoutMs: 50 });
    p._createWorker = () => new Promise(() => {}); // never settles, like a stalled download
    const start = Date.now();
    const err = await p.extract({ buffer: Buffer.from([1, 2, 3]) }).catch((e) => e);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/timed out/);
    expect(err.message).toMatch(/ocr:setup|paste the report text/i);
    // the dead worker slot is released so a later scan can retry
    expect(p._workerPromise).toBeNull();
  });

  it('an image engine failing with a non-Error still yields ocr_failed WITH guidance (no crash, no empty note)', async () => {
    // End-to-end guard for the online-machine crash: whatever the engine
    // throws, ingest must land in ocr_failed with a defined note and a red
    // badge carrying ocrError — never an undefined note or a lost report.
    class StringRejectingOcrProvider {
      name = 'string-rejector';
      supports(mimeType) {
        return /^image\//.test(mimeType || '');
      }
      async isAvailable() {
        return true;
      }
      async unavailabilityReason() {
        return null;
      }
      async extract() {
        throw 'Error: Error attempting to read image.';
      }
    }
    const ctx2 = makeTestContext(
      {},
      { ocrService: new OcrService([new PlainTextOcrProvider(), new StringRejectingOcrProvider()]) },
    );
    try {
      const reg = await registerUser(request, ctx2.app, { email: 'strfail@medtwin.test' });
      const m = await request(ctx2.app).get('/api/members').set(auth(reg.accessToken));
      const mid = m.body.owned.find((x) => x.relationship === 'self').id;
      const res = await request(ctx2.app)
        .post(`/api/members/${mid}/reports`)
        .set(auth(reg.accessToken))
        .attach('file', PNG_BYTES, { filename: 'scan.png', contentType: 'image/png' });
      expect(res.status).toBe(201); // never a 500
      expect(res.body.report.status).toBe('ocr_failed');
      expect(res.body.preview.needsManualEntry).toBe(true);
      expect(res.body.preview.note).toBeTruthy();
      expect(res.body.preview.note).toMatch(/attempting to read image/);
      expect(res.body.report.badge.level).toBe('ocr_issue');
      expect(res.body.report.badge.tone).toBe('red');
      expect(res.body.report.badge.ocrError).toBeTruthy();
    } finally {
      ctx2.container.close();
    }
  });
});
