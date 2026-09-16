import { randomUUID } from 'node:crypto';

/** Correlation id per request: echoed to client, included in error responses and audit metadata. */
export function requestId() {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    req.requestId = typeof incoming === 'string' && incoming.length <= 64 ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  };
}
