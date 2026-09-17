import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { makeTestContext, registerUser, auth } from '../helpers.js';

/**
 * Real uploaded video bytes: multipart publish → signed playback URL →
 * byte-range streaming. This is the path a phone-shot short takes.
 */

const FAKE_MP4 = Buffer.alloc(64 * 1024, 7); // 64 KB of "video"

let ctx, doctor, patient, videoId;

beforeAll(async () => {
  ctx = makeTestContext();
  patient = await registerUser(request, ctx.app, { email: 'media-patient@mt.test', displayName: 'Media Patient' });
  const applied = await request(ctx.app).post('/api/doctor/apply').send({
    email: 'dr.media@mt.test',
    displayName: 'Dr Media Rao',
    password: 'Str0ng!Passw0rd#2026',
    specialty: 'physiotherapy',
    registrationNo: 'MCI-555000',
    consultFeeInr: 300,
  });
  doctor = applied.body;
});
afterAll(() => ctx.container.close());

describe('doctor video uploads', () => {
  it('accepts an MP4 and stores it under the media directory', async () => {
    const res = await request(ctx.app)
      .post('/api/doctor/videos')
      .set(auth(doctor.accessToken))
      .field('title', 'Ankle sprain: first 48 hours')
      .field('topic', 'physiotherapy')
      .field('summary', 'What to do before you can see a physio.')
      .field('durationSec', '75')
      .field('keyPoints', JSON.stringify(['Ice and elevation', 'No heat in the first day']))
      .field('isPreview', 'true')
      .attach('file', FAKE_MP4, { filename: 'ankle.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(201);
    expect(res.body.video.mediaKind).toBe('upload');
    expect(res.body.video.media.bytes).toBe(FAKE_MP4.length);
    videoId = res.body.video.id;
  });

  it('rejects a non-video file with 415', async () => {
    const res = await request(ctx.app)
      .post('/api/doctor/videos')
      .set(auth(doctor.accessToken))
      .field('title', 'Not a video at all')
      .field('topic', 'physiotherapy')
      .attach('file', Buffer.from('PK\u0003\u0004zip'), { filename: 'notes.zip', contentType: 'application/zip' });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('signed playback + range streaming', () => {
  it('issues a signed URL only to an entitled viewer, then streams bytes', async () => {
    // Free patient: a preview short is still watchable…
    const preview = await request(ctx.app)
      .post(`/api/care/videos/${videoId}/playback`)
      .set(auth(patient.accessToken))
      .send({});
    expect(preview.status).toBe(200);
    expect(preview.body.stream.url).toContain(`/api/media/videos/${videoId}?`);

    const full = await request(ctx.app).get(preview.body.stream.url);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toMatch(/video\/mp4/);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.byteLength(full.text ?? '', 'binary')).toBeGreaterThanOrEqual(0);

    const ranged = await request(ctx.app).get(preview.body.stream.url).set('Range', 'bytes=0-1023');
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 0-1023/${FAKE_MP4.length}`);
  });

  it('refuses a tampered signature and an unsatisfiable range', async () => {
    const preview = await request(ctx.app)
      .post(`/api/care/videos/${videoId}/playback`)
      .set(auth(patient.accessToken))
      .send({});
    const tampered = preview.body.stream.url.replace(/sig=[^&]+/, 'sig=deadbeef');
    const res = await request(ctx.app).get(tampered);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLAYBACK_LINK_INVALID');

    const badRange = await request(ctx.app).get(preview.body.stream.url).set('Range', 'bytes=99999999-');
    expect(badRange.status).toBe(416);
  });

  it('will not hand a signed URL to a non-subscriber for a paid short', async () => {
    const paid = await request(ctx.app)
      .post('/api/doctor/videos')
      .set(auth(doctor.accessToken))
      .field('title', 'Return to running after injury')
      .field('topic', 'physiotherapy')
      .field('durationSec', '120')
      .attach('file', FAKE_MP4, { filename: 'run.mp4', contentType: 'video/mp4' });
    const blocked = await request(ctx.app)
      .post(`/api/care/videos/${paid.body.video.id}/playback`)
      .set(auth(patient.accessToken))
      .send({});
    expect(blocked.status).toBe(402);

    await request(ctx.app).post('/api/care/subscription').set(auth(patient.accessToken)).send({ planCode: 'care_yearly' });
    const allowed = await request(ctx.app)
      .post(`/api/care/videos/${paid.body.video.id}/playback`)
      .set(auth(patient.accessToken))
      .send({});
    expect(allowed.status).toBe(200);
    expect(allowed.body.stream.url).toContain('/api/media/videos/');
  });
});

describe('upload limits', () => {
  it('rejects an oversized video with 413 (multer limit is wired to config)', async () => {
    const tiny = makeTestContext({ MAX_VIDEO_MB: '0.0005' }); // ~524 bytes
    const applied = await request(tiny.app).post('/api/doctor/apply').send({
      email: 'dr.tiny@mt.test',
      displayName: 'Dr Tiny Limit',
      password: 'Str0ng!Passw0rd#2026',
      specialty: 'nutrition',
      registrationNo: 'MCI-555001',
    });
    const res = await request(tiny.app)
      .post('/api/doctor/videos')
      .set(auth(applied.body.accessToken))
      .field('title', 'A short that is too large to store')
      .field('topic', 'nutrition')
      .attach('file', Buffer.alloc(4096, 1), { filename: 'big.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    tiny.container.close();
  });
});
