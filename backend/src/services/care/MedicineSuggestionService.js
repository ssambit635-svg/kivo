import { ValidationError, NotFoundError } from '../../common/errors.js';
import {
  MEDICINE_DRAFT_RULES,
  MEDICINE_DRAFT_DISCLAIMER,
  MEDICINE_ACKNOWLEDGEMENTS,
} from './catalog.js';

const RULES_VERSION = 'care-med-draft/1.0.0';

/**
 * "AI suggests the medicine, the doctor owns the decision."
 *
 * This service reads the patient's VERIFIED values and drafts the therapy
 * classes that are commonly discussed for each out-of-range marker — with the
 * evidence, the follow-up work and the cautions attached, and with NO dose,
 * NO frequency, and NO "take this" language anywhere.
 *
 * Nothing leaves the console until a doctor edits or approves it AND ticks the
 * safety acknowledgements (allergies, interactions, organ function, and an
 * explicit "I decide the dose myself" confirmation).
 */
export class MedicineSuggestionService {
  constructor({ consultationRepository, labResultRepository, observationRepository, auditService }) {
    this.consultations = consultationRepository;
    this.labs = labResultRepository;
    this.observations = observationRepository;
    this.audit = auditService;
  }

  /** Build the draft from verified data only — this is a pure computation. */
  draftForMember(member) {
    const verified = (() => {
      try {
        return this.labs.verifiedValuesForMember(member.id) || [];
      } catch {
        return [];
      }
    })();

    const latestByCode = new Map();
    const skippedSuspicious = [];
    for (const row of verified) {
      if (!row || !row.code || row.value == null || !Number.isFinite(Number(row.value))) continue;
      if (row.suspicious) {
        skippedSuspicious.push({ code: row.code, name: row.test_name || row.code });
        continue;
      }
      latestByCode.set(row.code, row);
    }

    const currentMeds = (() => {
      try {
        return this.observations
          .listForMember(member.id, { kind: 'medication', pageSize: 50 })
          .items.map((o) => o.toJSON())
          .map((o) => String(o.payload?.name || '').trim())
          .filter(Boolean);
      } catch {
        return [];
      }
    })();
    const medHaystack = currentMeds.join(' | ').toLowerCase();

    const items = [];
    for (const rule of MEDICINE_DRAFT_RULES) {
      const row = latestByCode.get(rule.code);
      if (!row) continue;
      const value = Number(row.value);
      if (!rule.trigger(value)) continue;

      const duplicate = rule.exampleAgents.find((agent) => medHaystack.includes(agent.toLowerCase()));
      items.push({
        id: `${rule.code}`,
        markerCode: rule.code,
        markerName: row.test_name || rule.code,
        latestValue: value,
        unit: row.unit || null,
        measuredAt: row.measured_at,
        severity: rule.severity,
        label: rule.label,
        suggestedClass: rule.suggestedClass,
        exampleAgents: rule.exampleAgents,
        rationale: rule.rationale,
        cautions: [...rule.cautions, ...this.memberCautions(member)],
        followUp: { markerCodes: rule.followUpCodes || [], reviewInDays: rule.reviewInDays || 90 },
        possibleDuplicate: duplicate ? { agent: duplicate, recordedAs: currentMeds.find((m) => m.toLowerCase().includes(duplicate.toLowerCase())) } : null,
        doseIncluded: false,
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      rulesVersion: RULES_VERSION,
      aiGenerated: true,
      requiresDoctorApproval: true,
      patientVisible: false,
      items,
      currentMedications: currentMeds,
      skipped: {
        suspiciousOcrValues: skippedSuspicious,
        note: skippedSuspicious.length
          ? 'These markers were excluded: the reading was flagged as a probable OCR misread.'
          : null,
      },
      considerations: this.memberCautions(member),
      dataBasis: {
        verifiedMarkersConsidered: latestByCode.size,
        rulesEvaluated: MEDICINE_DRAFT_RULES.length,
        note: 'Drafted from user-verified values only. Unverified OCR drafts are never used.',
      },
      disclaimers: [MEDICINE_DRAFT_DISCLAIMER],
      acknowledgementsRequired: MEDICINE_ACKNOWLEDGEMENTS,
    };
  }

  memberCautions(member) {
    const cautions = [];
    const age = member.age;
    if (age != null && age >= 65) {
      cautions.push('Age 65+: review renal/hepatic dosing and polypharmacy before any new medicine.');
    }
    if (member.sex === 'female' && age != null && age >= 12 && age <= 50) {
      cautions.push('Confirm pregnancy/lactation status — it changes almost every choice below.');
    }
    return cautions;
  }

  /** Persist (or refresh) the draft attached to a consultation. */
  refreshDraft(doctor, consultation, member, ctx = {}) {
    const draft = this.draftForMember(member);
    const existing = this.consultations.findLatestMedicinePlan(consultation.id);
    if (existing && existing.status === 'approved') {
      return existing.toJSON(); // never overwrite an approved plan
    }
    if (existing) {
      const updated = this.consultations.updateMedicinePlan(existing.id, {
        status: 'draft',
        finalItems: [],
        doctorNote: null,
        acknowledgements: [],
      });
      // Store the refreshed AI draft alongside the row.
      this.consultations.db.run(
        'UPDATE medicine_plans SET ai_draft = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(draft),
        new Date().toISOString(),
        existing.id,
      );
      return this.consultations.findMedicinePlanById(updated.id).toJSON();
    }
    const created = this.consultations.createMedicinePlan({
      consultationId: consultation.id,
      memberId: member.id,
      doctorId: doctor.id,
      aiDraft: draft,
      status: 'draft',
    });
    this.audit.record({
      userId: doctor.user_id,
      action: 'doctor.medicine_draft_generated',
      resourceType: 'medicine_plan',
      resourceId: created.id,
      metadata: { items: draft.items.length, rulesVersion: RULES_VERSION },
      ctx,
    });
    return created.toJSON();
  }

  /**
   * Doctor approval. Requires the full acknowledgement checklist and stores the
   * doctor's OWN final list — the AI draft stays frozen next to it for audit.
   */
  approve(doctor, consultation, payload, ctx = {}) {
    const plan = this.consultations.findLatestMedicinePlan(consultation.id);
    if (!plan) throw new NotFoundError('No medicine draft exists for this consultation yet');
    if (plan.status === 'approved') {
      throw new ValidationError('This medicine plan is already approved');
    }

    const acknowledged = new Set((payload.acknowledgements || []).map((a) => String(a)));
    const missing = MEDICINE_ACKNOWLEDGEMENTS.filter((a) => !acknowledged.has(a.key)).map((a) => a.key);
    if (missing.length > 0) {
      throw new ValidationError(
        'Tick every safety check before sending a medicine plan to the patient',
        missing.map((key) => ({ path: 'acknowledgements', message: `Missing acknowledgement: ${key}`, code: 'ACK_REQUIRED' })),
      );
    }

    const items = (payload.items || []).map((item, index) => ({
      code: String(item.code || `item-${index + 1}`).slice(0, 64),
      name: String(item.name || '').slice(0, 160) || null,
      decision: ['keep', 'edit', 'skip'].includes(item.decision) ? item.decision : 'edit',
      product: item.product ? String(item.product).slice(0, 160) : null,
      instructions: item.instructions ? String(item.instructions).slice(0, 500) : null,
      note: item.note ? String(item.note).slice(0, 500) : null,
    }));
    if (items.length > 12) throw new ValidationError('Too many items — keep the plan focused');

    const finalItems = items.filter((i) => i.decision !== 'skip');
    const updated = this.consultations.updateMedicinePlan(plan.id, {
      status: 'approved',
      finalItems,
      doctorNote: payload.doctorNote ? String(payload.doctorNote).slice(0, 2000) : null,
      acknowledgements: [...acknowledged],
    });

    this.audit.record({
      userId: doctor.user_id,
      action: 'doctor.medicine_plan_approved',
      resourceType: 'medicine_plan',
      resourceId: plan.id,
      metadata: { items: finalItems.length, acknowledgements: [...acknowledged] },
      ctx,
    });
    return updated.toJSON();
  }

  reject(doctor, consultation, ctx = {}) {
    const plan = this.consultations.findLatestMedicinePlan(consultation.id);
    if (!plan) throw new NotFoundError('No medicine draft exists for this consultation yet');
    const updated = this.consultations.updateMedicinePlan(plan.id, {
      status: 'rejected',
      finalItems: [],
      doctorNote: 'Draft rejected by the doctor — no medicine advice was shared with the patient.',
      acknowledgements: [],
    });
    this.audit.record({
      userId: doctor.user_id,
      action: 'doctor.medicine_plan_rejected',
      resourceType: 'medicine_plan',
      resourceId: plan.id,
      ctx,
    });
    return updated.toJSON();
  }

  /** Patient-visible projection: approved items only, never the raw AI draft. */
  approvedForPatient(consultation) {
    const plan = this.consultations.findLatestMedicinePlan(consultation.id);
    if (!plan || plan.status !== 'approved') return null;
    const data = plan.toJSON();
    return {
      status: 'approved',
      approvedAt: data.approvedAt,
      doctorNote: data.doctorNote,
      items: data.finalItems,
      // Draft internals (AI rationale, example agents, follow-up codes) are
      // deliberately NOT exposed to patients: they are clinical scaffolding.
      disclaimer:
        'This plan was written and approved by your doctor. Follow it exactly as instructed and ask your doctor or ' +
        'pharmacist before changing anything.',
    };
  }
}

export { RULES_VERSION as MEDICINE_RULES_VERSION };
