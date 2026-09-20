import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { makeTestContext } from '../helpers.js';

/**
 * Mobile surface: the dedicated phone frontend at /m/ and the direct APK
 * download the landing page, the patient dashboard and the phone shell all
 * link to.
 *
 * These are the URLs a judge taps on stage. Every one of them is served by the
 * backend (nothing here is a file the browser fetches by path), so a renamed
 * route or a missing build artifact shows up as a dead button rather than a
 * console error — which is why they are asserted over real HTTP instead of by
 * reading the filesystem.
 */
describe('mobile frontend + apk download', () => {
  let app;

  beforeAll(() => {
    app = makeTestContext().app;
  });

  describe('GET /m/ (dedicated mobile app)', () => {
    it('serves the phone shell', async () => {
      const res = await request(app).get('/m/');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('app-viewport');
      expect(res.text).toContain('kivo');
    });

    it('redirects the bare /m to the directory index', async () => {
      const res = await request(app).get('/m');
      expect([301, 302]).toContain(res.status);
      expect(res.headers.location).toBe('/m/');
    });

    it('serves its stylesheet and script', async () => {
      const css = await request(app).get('/m/mobile.css');
      expect(css.status).toBe(200);
      expect(css.headers['content-type']).toMatch(/text\/css/);

      const js = await request(app).get('/m/mobile.js');
      expect(js.status).toBe(200);
      expect(js.text).toContain('[data-goto-tab]');
    });

    it('is covered by the CSP that forbids inline handlers', async () => {
      const res = await request(app).get('/m/');
      const csp = res.headers['content-security-policy'] || '';
      expect(csp).toMatch(/script-src[^;]*'self'/);
      // script-src-attr 'none' is what silently kills an inline onclick, so the
      // markup side of that contract is asserted in the unit suite.
      expect(csp).toMatch(/script-src-attr\s+'none'/);
    });
  });

  describe('GET /download/apk (direct installer)', () => {
    it('streams the package as an attachment', async () => {
      const res = await request(app).get('/download/apk').responseType('blob');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
      expect(res.headers['content-disposition']).toMatch(/attachment;\s*filename="kivo\.apk"/);
      expect(Buffer.isBuffer(res.body) ? res.body.length : 0).toBeGreaterThan(10_000);
      // zip container signature — a truncated or placeholder file is not an apk
      expect(res.body.subarray(0, 2).toString('ascii')).toBe('PK');
      // APK signing block v2 magic check: "APK Sig Block 42"
      expect(res.body.toString('binary')).toContain('APK Sig Block 42');
    });

    it('is also reachable at /kivo.apk', async () => {
      const res = await request(app).get('/kivo.apk').responseType('blob');
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/kivo\.apk/);
    });

    it('does not turn the download route into a catch-all', async () => {
      const res = await request(app).get('/download/nothing-here');
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('every surface links to the mobile app and the installer', () => {
    it('advertises both in the service banner', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.mobileApp).toBe('/m/');
      expect(res.body.downloadApk).toBe('/download/apk');
    });

    it('the landing page offers the apk from the nav, the hero and the footer', async () => {
      const res = await request(app).get('/').set('Accept', 'text/html');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect((res.text.match(/href="\/download\/apk"/g) || []).length).toBeGreaterThanOrEqual(3);
      expect(res.text).toContain('href="/m/"');
    });

    it('the patient dashboard carries the download button', async () => {
      const res = await request(app).get('/app/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('href="/download/apk"');
    });

    it('the phone shell points its APK pill at the download endpoint', async () => {
      const res = await request(app).get('/m/');
      expect(res.text).toContain('href="/download/apk"');
    });
  });
});
