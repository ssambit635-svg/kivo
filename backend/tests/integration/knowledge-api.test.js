import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext } from '../helpers.js';

/**
 * The clinical knowledge base is a public, read-only surface: it explains which
 * markers the app knows and where that knowledge came from. It must never leak
 * anything about a user, so it is asserted here to be reachable without a token
 * and to contain no user-shaped data.
 */
describe('GET /api/meta/knowledge — knowledge transparency', () => {
  let ctx;
  beforeAll(() => {
    ctx = makeTestContext();
  });
  afterAll(() => ctx.container.close());

  it('is public and reports the knowledge-base size', async () => {
    const res = await request(ctx.app).get('/api/meta/knowledge');
    expect(res.status).toBe(200);
    expect(res.body.stats.markers).toBeGreaterThan(1000);
    expect(res.body.stats.loincCoverage).toBeGreaterThan(0.95);
    expect(res.body.stats.panels).toBeGreaterThan(10);
  });

  it('names every source with its pinned commit and licence', async () => {
    const res = await request(ctx.app).get('/api/meta/knowledge');
    expect(res.body.sources.length).toBeGreaterThanOrEqual(3);
    for (const s of res.body.sources) {
      expect(s.repo).toBeTruthy();
      expect(s.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(s.licence).toBeTruthy();
    }
    expect(res.body.sourcesNote).toMatch(/no patient records/i);
  });

  it('publishes the calibration status and the range policy', async () => {
    const res = await request(ctx.app).get('/api/meta/knowledge');
    expect(res.body.calibration.active).toBe(true);
    expect(res.body.calibration.intendedUse).toMatch(/never a clinical decision/i);
    expect(res.body.rangePolicy).toMatch(/reference range printed on the user's own report/i);
    expect(res.body.disclaimer).toMatch(/not a diagnosis/i);
  });

  it('carries no user or patient fields', async () => {
    const res = await request(ctx.app).get('/api/meta/knowledge');
    const flat = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ['patient id', 'memberid', 'email', 'patient_id', 'mrn']) {
      expect(flat).not.toContain(forbidden);
    }
  });

  it('keeps the lab dictionary small by default and complete on request', async () => {
    const core = await request(ctx.app).get('/api/meta/lab-dictionary');
    const all = await request(ctx.app).get('/api/meta/lab-dictionary?tier=all');
    expect(core.status).toBe(200);
    expect(all.status).toBe(200);
    expect(Object.keys(core.body.markers).length).toBeGreaterThan(100);
    expect(Object.keys(all.body.markers).length).toBeGreaterThan(Object.keys(core.body.markers).length);
    // every generated marker must state that it has no invented range
    const generated = Object.values(all.body.markers).find((m) => m.tier !== 'core' && m.valueKind === 'numeric');
    expect(generated.typicalRange).toBeNull();
    expect(generated.rangeSource).toBe('report-only');
  });
});
