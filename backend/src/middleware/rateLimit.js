import { TooManyRequestsError } from '../common/errors.js';

/**
 * In-memory fixed-window rate limiter (zero-cost, no Redis needed for the
 * MVP; swap store for Redis in multi-instance production). Key = IP +
 * bucket name, so the auth bucket never starves the general API bucket.
 */
export class RateLimiter {
  constructor({ windowMs, max, name = 'global', keyFn = null }) {
    this.windowMs = windowMs;
    this.max = max;
    this.name = name;
    this.keyFn = keyFn;
    this.hits = new Map();
    // opportunistic cleanup so the map can't grow unbounded
    this.sweepEvery = Math.max(windowMs, 60_000);
    this.lastSweep = Date.now();
  }

  key(req) {
    return this.keyFn ? this.keyFn(req) : `${this.name}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
  }

  sweep(now) {
    if (now - this.lastSweep < this.sweepEvery) return;
    for (const [k, v] of this.hits) {
      if (v.resetAt <= now) this.hits.delete(k);
    }
    this.lastSweep = now;
  }

  middleware() {
    return (req, res, next) => {
      const now = Date.now();
      this.sweep(now);
      const key = this.key(req);
      const entry = this.hits.get(key) || { count: 0, resetAt: now + this.windowMs };
      if (now >= entry.resetAt) {
        entry.count = 0;
        entry.resetAt = now + this.windowMs;
      }
      entry.count += 1;
      this.hits.set(key, entry);

      res.setHeader('X-RateLimit-Limit', String(this.max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, this.max - entry.count)));
      if (entry.count > this.max) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        return next(new TooManyRequestsError('Rate limit exceeded — slow down', retryAfter));
      }
      return next();
    };
  }

  reset() {
    this.hits.clear();
  }
}
