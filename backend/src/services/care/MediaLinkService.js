import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ForbiddenError, NotFoundError } from '../../common/errors.js';

/**
 * Expiring playback links for paid video content.
 *
 * A `<video src>` element cannot send an Authorization header, so a bearer
 * token in the query string would be the obvious shortcut — and the wrong
 * one: tokens end up in logs, history and referrers. Instead we sign a
 * short-lived, user-bound grant:
 *
 *   /api/media/videos/:id?v=1&uid=<user>&exp=<unix>&sig=<hmac>
 *
 * The signature covers video + user + expiry, so a link cannot be forwarded
 * to a non-subscriber, and it dies on its own within `videoTtlSec`.
 */
export class MediaLinkService {
  constructor({ config }) {
    this.config = config;
    this.secret = config.mediaSigningSecret;
  }

  sign({ videoId, userId, ttlSec = this.config.videoTtlSec, now = Date.now() }) {
    const exp = Math.floor(now / 1000) + Math.max(30, Math.min(3600, ttlSec));
    const payload = `${videoId}.${userId}.${exp}`;
    const sig = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return {
      url: `/api/media/videos/${videoId}?v=1&uid=${encodeURIComponent(userId)}&exp=${exp}&sig=${sig}`,
      expiresAt: new Date(exp * 1000).toISOString(),
      ttlSec: ttlSec,
    };
  }

  verify({ videoId, userId, exp, sig }) {
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || !sig) return false;
    if (expNum * 1000 < Date.now()) return false;
    const expected = createHmac('sha256', this.secret)
      .update(`${videoId}.${userId}.${expNum}`)
      .digest('base64url');
    const a = Buffer.from(String(sig));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Resolve an absolute file path for a stored video, refusing anything that
   * escapes the configured video directory (path traversal via DB tampering
   * would otherwise let a signed link read arbitrary files).
   */
  resolveFile(relativePath) {
    if (!relativePath) throw new NotFoundError('Video file not found');
    const root = path.resolve(this.config.videoDir);
    const resolved = path.resolve(root, relativePath);
    if (!resolved.startsWith(root + path.sep)) {
      throw new ForbiddenError('Refusing to serve a file outside the media directory', 'MEDIA_PATH_ESCAPE');
    }
    if (!fs.existsSync(resolved)) throw new NotFoundError('Video file not found');
    return resolved;
  }

  /**
   * Minimal single-range reader for <video> seeking. Returns the byte window
   * and the HTTP headers the controller should send.
   */
  resolveRange({ size, rangeHeader }) {
    const total = Number(size) || 0;
    if (!rangeHeader) return { start: 0, end: Math.max(0, total - 1), length: total, partial: false };
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (!match) return { start: 0, end: Math.max(0, total - 1), length: total, partial: false };
    const [, rawStart, rawEnd] = match;
    let start = rawStart === '' ? null : Number(rawStart);
    let end = rawEnd === '' ? null : Number(rawEnd);
    if (start === null && end === null) return { start: 0, end: Math.max(0, total - 1), length: total, partial: false };
    if (start === null) {
      // suffix range: last N bytes
      start = Math.max(0, total - end);
      end = total - 1;
    } else if (end === null || end >= total) {
      end = total - 1;
    }
    if (start > end || start >= total) {
      return { invalid: true, total };
    }
    return { start, end, length: end - start + 1, partial: true, total };
  }
}
