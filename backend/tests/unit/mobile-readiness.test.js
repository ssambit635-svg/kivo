import { describe, it, expect } from 'vitest';
import { Config } from '../../src/config/Config.js';
import { OcrService } from '../../src/services/ocr/OcrService.js';

/**
 * Mobile-readiness guards (iQOO hackathon demo):
 * - native app shells (Capacitor/Ionic) + phone-on-LAN origins must pass CORS in dev
 * - production stays strict (explicit CORS_ORIGINS only)
 * - PDFs fail OCR with PDF-specific guidance, not image-OCR setup steps
 */
describe('mobile readiness', () => {
  const dev = new Config({ NODE_ENV: 'development' });

  it('allows native-app shell origins in non-production', () => {
    expect(dev.isOriginAllowed('capacitor://localhost')).toBe(true);
    expect(dev.isOriginAllowed('ionic://localhost')).toBe(true);
    expect(dev.isOriginAllowed('capacitor://my-app')).toBe(true);
  });

  it('allows private-LAN origins in non-production (phone demo over wifi)', () => {
    expect(dev.isOriginAllowed('http://192.168.1.10:8080')).toBe(true);
    expect(dev.isOriginAllowed('http://10.0.0.5:8080')).toBe(true);
    expect(dev.isOriginAllowed('http://172.20.0.2:8080')).toBe(true);
  });

  it('still rejects random public origins in non-production', () => {
    expect(dev.isOriginAllowed('https://evil.example.com')).toBe(false);
    expect(dev.isOriginAllowed('http://8.8.8.8:8080')).toBe(false);
  });

  it('allows non-browser clients (no Origin header)', () => {
    expect(dev.isOriginAllowed(undefined)).toBe(true);
    expect(dev.isOriginAllowed(null)).toBe(true);
  });

  it('is strict in production: only explicit CORS_ORIGINS', () => {
    const prod = new Config({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), CORS_ORIGINS: 'https://app.example.com' });
    expect(prod.isOriginAllowed('https://app.example.com')).toBe(true);
    expect(prod.isOriginAllowed('capacitor://localhost')).toBe(false);
    expect(prod.isOriginAllowed('http://192.168.1.10:8080')).toBe(false);
    expect(prod.isOriginAllowed('http://localhost:3000')).toBe(false);
  });

  it('defaults MAX_UPLOAD_MB to 10 for phone photos (overridable)', () => {
    expect(new Config({ NODE_ENV: 'development' }).maxUploadBytes).toBe(10 * 1024 * 1024);
    expect(new Config({ NODE_ENV: 'development', MAX_UPLOAD_MB: '5' }).maxUploadBytes).toBe(5 * 1024 * 1024);
  });

  it('rejects scanned PDFs (no text layer) with PDF-specific guidance', async () => {
    const ocr = new OcrService();
    await expect(ocr.extractText({ buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf' }))
      .rejects.toThrow(/no readable text layer.*paste it into the upload dialog/s);
    await ocr.close();
  });

  it('reads digital PDFs with a text layer (best-effort, no dependency)', async () => {
    const { buildDigitalPdf } = await import('./pdf-ocr.fixture.js');
    const ocr = new OcrService();
    const out = await ocr.extractText({ buffer: buildDigitalPdf(), mimeType: 'application/pdf' });
    expect(out.provider).toBe('pdf-text');
    expect(out.text).toMatch(/Glucose/);
    expect(out.text).toMatch(/126/);
    await ocr.close();
  });
});
