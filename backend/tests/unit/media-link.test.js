import { describe, it, expect, beforeEach } from 'vitest';
import { Config } from '../../src/config/Config.js';
import { MediaLinkService } from '../../src/services/care/MediaLinkService.js';
import { ForbiddenError, NotFoundError } from '../../src/common/errors.js';

/** Signed playback links: unguessable, expiring, path-safe. */

let media, config;

beforeEach(() => {
  config = new Config({
    NODE_ENV: 'test',
    JWT_SECRET: 'media-test-secret',
    VIDEO_DIR: '/tmp/medtwin-media-test',
  });
  media = new MediaLinkService({ config });
});

describe('playback link signing', () => {
  it('signs a link bound to one video and one user', () => {
    const link = media.sign({ videoId: 'v1', userId: 'u1' });
    expect(link.url).toContain('/api/media/videos/v1?');
    const params = new URLSearchParams(link.url.split('?')[1]);
    expect(media.verify({ videoId: 'v1', userId: 'u1', exp: params.get('exp'), sig: params.get('sig') })).toBe(true);
  });

  it('rejects a link re-pointed at another video or another user', () => {
    const link = media.sign({ videoId: 'v1', userId: 'u1' });
    const params = new URLSearchParams(link.url.split('?')[1]);
    expect(media.verify({ videoId: 'v2', userId: 'u1', exp: params.get('exp'), sig: params.get('sig') })).toBe(false);
    expect(media.verify({ videoId: 'v1', userId: 'u2', exp: params.get('exp'), sig: params.get('sig') })).toBe(false);
  });

  it('expires on its own', () => {
    const link = media.sign({ videoId: 'v1', userId: 'u1', ttlSec: 30, now: Date.now() - 60_000 });
    const params = new URLSearchParams(link.url.split('?')[1]);
    expect(media.verify({ videoId: 'v1', userId: 'u1', exp: params.get('exp'), sig: params.get('sig') })).toBe(false);
  });

  it('caps the requested TTL instead of trusting the caller', () => {
    const link = media.sign({ videoId: 'v1', userId: 'u1', ttlSec: 999999 });
    expect(link.ttlSec).toBe(999999); // echoed back…
    const exp = Number(new URLSearchParams(link.url.split('?')[1]).get('exp'));
    expect(exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3600); // …but clamped
  });
});

describe('file resolution', () => {
  it('refuses to serve a path outside the media directory', () => {
    expect(() => media.resolveFile('../../etc/passwd')).toThrowError(ForbiddenError);
  });

  it('reports a missing file as not found', () => {
    expect(() => media.resolveFile('nope.mp4')).toThrowError(NotFoundError);
  });
});

describe('range parsing', () => {
  it('returns the whole file when no range is asked for', () => {
    const r = media.resolveRange({ size: 1000, rangeHeader: null });
    expect(r).toMatchObject({ start: 0, end: 999, length: 1000, partial: false });
  });

  it('honours a normal byte range and a suffix range', () => {
    expect(media.resolveRange({ size: 1000, rangeHeader: 'bytes=100-199' })).toMatchObject({ start: 100, end: 199, length: 100, partial: true });
    expect(media.resolveRange({ size: 1000, rangeHeader: 'bytes=-200' })).toMatchObject({ start: 800, end: 999, length: 200 });
  });

  it('flags an unsatisfiable range instead of crashing', () => {
    expect(media.resolveRange({ size: 1000, rangeHeader: 'bytes=5000-6000' }).invalid).toBe(true);
  });
});
