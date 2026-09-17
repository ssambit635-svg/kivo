/**
 * Typed error hierarchy — the single source of truth for HTTP error
 * semantics across the whole backend. Controllers/services throw these;
 * the errorHandler middleware maps them to responses. Internal details
 * never leak to clients.
 */
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export class ValidationError extends ApiError {
  constructor(message = 'Validation failed', details) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
    super(401, code, message);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
    super(403, code, message);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends ApiError {
  constructor(message = 'Conflict with current state', code = 'CONFLICT') {
    super(409, code, message);
  }
}

export class PayloadTooLargeError extends ApiError {
  constructor(message = 'Payload too large') {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

/** Paid entitlement required — semantically distinct from a permission error. */
export class PaymentRequiredError extends ApiError {
  constructor(message = 'This content needs an active subscription', code = 'PAYMENT_REQUIRED') {
    super(402, code, message);
  }
}

export class UnsupportedMediaError extends ApiError {
  constructor(message = 'Unsupported media type') {
    super(415, 'UNSUPPORTED_MEDIA_TYPE', message);
  }
}

export class UnprocessableError extends ApiError {
  constructor(message = 'Unprocessable request', code = 'UNPROCESSABLE') {
    super(422, code, message);
  }
}

export class TooManyRequestsError extends ApiError {
  constructor(message = 'Too many requests, slow down', retryAfterSec = 60) {
    super(429, 'RATE_LIMITED', message);
    this.retryAfterSec = retryAfterSec;
  }
}

export class ServiceUnavailableError extends ApiError {
  constructor(message = 'Service temporarily unavailable', code = 'SERVICE_UNAVAILABLE') {
    super(503, code, message);
  }
}

export class OcrUnavailableError extends ServiceUnavailableError {
  constructor(message) {
    super(message || 'OCR provider unavailable for this file type', 'OCR_UNAVAILABLE');
  }
}
