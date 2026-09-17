import { ValidationError } from '../common/errors.js';

const ALLOWED_KINDS = new Set(['weight', 'bp', 'activity', 'sleep', 'symptom', 'note', 'medication']);

/**
 * User observations/journal entries (weight, blood pressure, activity,
 * sleep, symptoms, medications). Lightweight by design; the risk model
 * reads weight/BP/activity from here.
 */
export class ObservationService {
  constructor({ observationRepository, policyService, auditService }) {
    this.obs = observationRepository;
    this.policy = policyService;
    this.audit = auditService;
  }

  create(actor, memberId, data, ctx = {}) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertWrite(actor, member);
    if (!ALLOWED_KINDS.has(data.kind)) {
      throw new ValidationError(`kind must be one of: ${[...ALLOWED_KINDS].join(', ')}`);
    }
    this.validatePayload(data.kind, data.payload || {});
    const row = this.obs.create({
      memberId,
      createdBy: actor.id,
      kind: data.kind,
      payload: data.payload || {},
      source: data.source || 'manual',
      observedAt: data.observedAt || null,
    });
    this.audit.record({ userId: actor.id, action: 'observation.create', resourceType: 'observation', resourceId: row.id, ctx });
    return row.toJSON();
  }

  list(actor, memberId, query) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertRead(actor, member);
    const { items, total, page, pageSize } = this.obs.listForMember(memberId, query);
    return { items: items.map((o) => o.toJSON()), total, page, pageSize };
  }

  remove(actor, observationId, ctx = {}) {
    const { observation } = this.policy.loadObservationWithAccess(actor, this.obs, observationId, { write: true });
    this.obs.delete(observation.id);
    this.audit.record({ userId: actor.id, action: 'observation.delete', resourceType: 'observation', resourceId: observationId, ctx });
    return { deleted: true };
  }

  validatePayload(kind, p) {
    const payload = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    const num = (x) => typeof x === 'number' && Number.isFinite(x);
    // Rebind for the switch below.
    p = payload;
    switch (kind) {
      case 'weight':
        if (!num(p.weightKg) || p.weightKg <= 0 || p.weightKg > 500) {
          throw new ValidationError('payload.weightKg must be a plausible number (0–500)');
        }
        break;
      case 'bp':
        if (!num(p.systolic) || !num(p.diastolic) || p.systolic < 40 || p.systolic > 300 || p.diastolic < 20 || p.diastolic > 200) {
          throw new ValidationError('payload must contain plausible systolic (40–300) and diastolic (20–200) values');
        }
        break;
      case 'activity':
        if (p.minutesPerWeek != null && (!num(p.minutesPerWeek) || p.minutesPerWeek < 0 || p.minutesPerWeek > 5000)) {
          throw new ValidationError('payload.minutesPerWeek must be between 0 and 5000');
        }
        break;
      case 'sleep':
        if (p.hours != null && (!num(p.hours) || p.hours < 0 || p.hours > 24)) {
          throw new ValidationError('payload.hours must be between 0 and 24');
        }
        break;
      default:
        break; // symptom / note / medication are free-form-ish
    }
  }
}
