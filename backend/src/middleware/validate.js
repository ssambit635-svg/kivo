import { ValidationError } from '../common/errors.js';

/**
 * Zod request validation. Attach validators for body/query/params;
 * failures become a 400 with ALL issue paths so clients can mark fields.
 * Parsed data replaces the raw input (types coerced per schema).
 */
export function validate({ body = null, query = null, params = null } = {}) {
  return (req, _res, next) => {
    try {
      if (body) {
        const r = body.safeParse(req.body);
        if (!r.success) throw formatZodError(r.error);
        req.body = r.data;
      }
      if (query) {
        const r = query.safeParse(req.query);
        if (!r.success) throw formatZodError(r.error);
        assignParsed(req, 'query', r.data);
      }
      if (params) {
        const r = params.safeParse(req.params);
        if (!r.success) throw formatZodError(r.error);
        req.params = r.data;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Express defines lazy getters for some props (e.g. req.query); ESM strict
 *  mode throws on plain assignment, so we fall back to defineProperty. */
function assignParsed(obj, key, value) {
  try {
    obj[key] = value;
  } catch {
    Object.defineProperty(obj, key, { value, writable: true, configurable: true });
  }
}

function formatZodError(error) {
  return new ValidationError(
    'Request validation failed',
    error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
  );
}
