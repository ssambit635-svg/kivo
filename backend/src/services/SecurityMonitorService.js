import { TooManyRequestsError } from '../common/errors.js';

/**
 * SecurityMonitorService — automated abuse detection & response.
 *
 * The rate limiter defends each bucket (auth vs global). This monitor adds a
 * CROSS-ENDPOINT defense: it counts AUTHENTICATION / AUTHORIZATION failures
 * (401, 403) per client IP across the whole API. An IP that racks up many
 * failures in a window — invalid tokens, forged CORS origins, denied policy
 * probes, CORS-smuggling attempts — is AUTOMATICALLY blocked for a cooldown
 * period, and the block is written to the audit trail (`security.ip_blocked`).
 *
 * Design rules:
 * - Deterministic + in-memory: zero-cost, no external service (single-node
 *   MVP; swap the store for Redis in multi-instance production).
 * - Counts 401/403 ONLY. Validation errors (400), misses (404) and rate-limit
 *   rejections (429) are NOT failures — honest clients and UIs produce those,
 *   and counting 429 would create a self-reinforcing block loop.
 * - Blocks auto-expire; a blocked request answers 429 with Retry-After and is
 *   itself never counted.
 * - Monitoring can only ever DENY traffic; it can never grant access, so a
 *   monitor fault degrades to "no extra blocking", never to weaker auth.
 */
export class SecurityMonitorService {
  constructor({ config, auditService }) {
    const m = config?.securityMonitor || {};
    this.enabled = m.enabled !== false;
    this.windowMs = Number.isFinite(Number(m.windowMs)) ? Number(m.windowMs) : 5 * 60 * 1000;
    this.maxFailures = Number.isFinite(Number(m.maxFailures)) ? Number(m.maxFailures) : 60;
    this.blockMs = Number.isFinite(Number(m.blockMs)) ? Number(m.blockMs) : 15 * 60 * 1000;
    this.audit = auditService || null;
    this.failures = new Map(); // ip -> { count, windowResetAt }
    this.blocks = new Map(); // ip -> blockedUntil
    this.lastSweep = Date.now();
  }

  sweep(now) {
    if (now - this.lastSweep < Math.max(this.windowMs, 60_000)) return;
    this.lastSweep = now;
    for (const [ip, until] of this.blocks) if (until <= now) this.blocks.delete(ip);
    for (const [ip, e] of this.failures) if (e.windowResetAt <= now) this.failures.delete(ip);
  }

  ipOf(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  isBlocked(ip, now = Date.now()) {
    const until = this.blocks.get(ip);
    if (until == null) return false;
    if (until <= now) {
      this.blocks.delete(ip);
      return false;
    }
    return true;
  }

  /** Express middleware: deny blocked IPs before anything else runs. */
  middleware() {
    return (req, res, next) => {
      if (!this.enabled) return next();
      const now = Date.now();
      this.sweep(now);
      const ip = this.ipOf(req);
      if (this.isBlocked(ip, now)) {
        const retryAfter = Math.ceil((this.blocks.get(ip) - now) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        return next(new TooManyRequestsError('Too many failed security checks — temporarily blocked', retryAfter));
      }
      // Record the outcome once the response is finished (401/403 only).
      res.on('finish', () => {
        try {
          if (res.statusCode === 401 || res.statusCode === 403) this.recordFailure(ip, res.statusCode);
        } catch {
          /* monitoring never breaks the request path */
        }
      });
      return next();
    };
  }

  recordFailure(ip, status) {
    if (!this.enabled || !ip || ip === 'unknown') return;
    const now = Date.now();
    let entry = this.failures.get(ip);
    if (!entry || entry.windowResetAt <= now) {
      entry = { count: 0, windowResetAt: now + this.windowMs };
    }
    entry.count += 1;
    this.failures.set(ip, entry);

    if (entry.count > this.maxFailures && !this.isBlocked(ip, now)) {
      const until = now + this.blockMs;
      this.blocks.set(ip, until);
      this.failures.delete(ip); // the block supersedes the counter
      try {
        this.audit?.record({
          userId: null,
          action: 'security.ip_blocked',
          resourceType: 'ip',
          resourceId: ip,
          outcome: 'success',
          metadata: { failures: entry.count, lastStatus: status, blockMs: this.blockMs, automated: true },
          ctx: { ip },
        });
      } catch {
        /* audit is advisory */
      }
    }
  }

  /** Test/ops introspection. */
  stats() {
    const now = Date.now();
    return {
      enabled: this.enabled,
      trackedFailureIps: this.failures.size,
      blockedIps: [...this.blocks.entries()].filter(([, until]) => until > now).length,
    };
  }

  reset() {
    this.failures.clear();
    this.blocks.clear();
  }
}
