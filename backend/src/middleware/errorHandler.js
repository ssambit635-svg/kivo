import { ApiError } from '../common/errors.js';

export function notFoundHandler() {
  return (_req, res) => {
    res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' } });
  };
}

/**
 * Central error mapper. ApiError subclasses are serialized as-is;
 * multer errors are translated; anything unknown becomes a generic 500
 * and the stack never leaves the server.
 */
export function errorHandler() {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (err instanceof ApiError) {
      if (err.retryAfterSec) res.setHeader('Retry-After', String(err.retryAfterSec));
      return res.status(err.status).json({ ...err.toJSON(), requestId: req.requestId });
    }
    if (err && err.name === 'MulterError') {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({
        error: {
          code: err.code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'UPLOAD_ERROR',
          message: err.code === 'LIMIT_FILE_SIZE' ? 'Uploaded file is too large' : `Upload failed: ${err.message}`,
        },
        requestId: req.requestId,
      });
    }
    if (err && (err.type === 'entity.too.large' || err.name === 'PayloadTooLargeError')) {
      return res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
        requestId: req.requestId,
      });
    }
    if (err && err.name === 'SyntaxError' && 'body' in err) {
      return res.status(400).json({
        error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' },
        requestId: req.requestId,
      });
    }
    console.error(`[${req.requestId}] UNHANDLED:`, err);
    return res.status(500).json({
      error: { code: 'INTERNAL', message: 'Something went wrong on our side' },
      requestId: req.requestId,
    });
  };
}
