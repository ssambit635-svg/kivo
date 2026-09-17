import { ageFromDob } from '../../utils/time.js';

/**
 * The one-screen clinical brief — the answer to "patients' info can be seen
 * very easily by a doc without wasting time asking 10 questions".
 *
 * It compiles ONLY user-verified data (the same trust gate as trends/risk:
 * OCR drafts never reach this screen), plus the doctor-visit summary and the
 * trend + risk engines, into a fixed shape a doctor can read in ~20 seconds:
 *
 *   problems → changed markers → vitals → current medicines → risk flags →
 *   the handful of things the chart genuinely cannot tell you.
 *
 * The last block is deliberate: instead of making a doctor interrogate the
 * patient for facts we already hold, it lists only the real gaps
 * (allergies, symptom duration, family history, adherence).
 */
export class ClinicalBriefService {
  constructor({
    memberRepository,
    labResultRepository,
    observationRepository,
    reportRepository,
    trendService,
    riskModelService,
    doctorSummaryService,
  }) {
    this.members = memberRepository;
    this.labs = labResultRepository;
    this.observations = observationRepository;
    this.reports = reportRepository;
    this.trends = trendService;
    this.risk = riskModelService;
    this.summary = doctorSummaryService;
  }

  async build(member, { scope = null } = {}) {
    const allowed = Array.isArray(scope) && scope.length > 0 ? new Set(scope) : null;
    const can = (section) => !allowed || allowed.has(section);

    const brief = {
      generatedAt: new Date().toISOString(),
      member: {
        id: member.id,
        name: member.name,
        relationship: member.relationship,
        age: member.dob ? ageFromDob(member.dob) : null,
        sex: member.sex || null,
        heightCm: member.height_cm ?? null,
      },
      consentScope: allowed ? [...allowed] : ['labs', 'trends', 'vitals', 'medications', 'risk', 'reports'],
      activeProblems: [],
      changedSinceLastReport: [],
      vitals: {},
      medications: [],
      riskFlags: [],
      recentReports: [],
      gapsToAsk: [],
      provenance: {
        source: 'user-verified records only',
        rule: 'OCR drafts (verified = 0) are excluded from this brief by construction.',
        trendEngine: 'personal trend analysis over verified lab results',
      },
      disclaimers: [
        'This brief is a structured summary of what the patient recorded and verified — it is not a diagnosis.',
        'Values come from the patient’s own reports; reference ranges are the ones printed on those reports where present.',
      ],
    };

    // ---- active problems: latest verified value out of range -------------
    if (can('labs')) {
      let latest = [];
      try {
        latest = this.labs.verifiedValuesForMember(member.id) || [];
      } catch {
        latest = [];
      }
      const latestByCode = new Map();
      for (const row of latest) {
        if (!row || !row.code || row.value == null) continue;
        latestByCode.set(row.code, row); // ASC order → last wins
      }
      for (const row of latestByCode.values()) {
        const status = rangeStatus(row);
        if (status === 'high' || status === 'low') {
          brief.activeProblems.push({
            code: row.code,
            name: row.test_name || row.code,
            value: row.value,
            unit: row.unit || null,
            status,
            reference: { low: row.ref_low ?? null, high: row.ref_high ?? null },
            measuredAt: row.measured_at,
            panel: row.panel || null,
          });
        }
      }
      brief.activeProblems.sort((a, b) => (b.measuredAt || '').localeCompare(a.measuredAt || ''));
    }

    // ---- what changed since the first verified report ---------------------
    if (can('trends')) {
      let trendList = [];
      try {
        trendList = this.trends.analyzeMember(member.id) || [];
      } catch {
        trendList = [];
      }
      brief.changedSinceLastReport = trendList
        .filter((t) => t && t.meaningfulChange)
        .slice(0, 12)
        .map((t) => ({
          code: t.code,
          name: t.markerName,
          direction: t.direction,
          deltaPct: t.deltaPct ?? null,
          from: { value: t.firstValue, at: t.firstAt },
          to: { value: t.latestValue, unit: t.unit || null, at: t.latestAt, status: t.latestStatus },
          statusTransitions: Array.isArray(t.statusTransitions)
            ? t.statusTransitions.map((s) => `${s.from}→${s.to}`)
            : [],
        }));
    }

    // ---- vitals ----------------------------------------------------------
    if (can('vitals')) {
      const obs = (kind) => {
        try {
          const row = this.observations.latestOfKind(member.id, kind);
          return row ? row.data || row.toJSON?.().payload : null;
        } catch {
          return null;
        }
      };
      const weight = obs('weight');
      const bp = obs('bp');
      const activity = obs('activity');
      const sleep = obs('sleep');
      const weightKg = num(weight?.weightKg);
      const heightCm = num(member.height_cm);
      brief.vitals = {
        weightKg,
        bmi: weightKg != null && heightCm ? Number((weightKg / (heightCm / 100) ** 2).toFixed(1)) : null,
        bp: bp ? { systolic: num(bp.systolic), diastolic: num(bp.diastolic) } : null,
        activityMinutesPerWeek: num(activity?.minutesPerWeek),
        sleepHours: num(sleep?.hours),
      };
    }

    // ---- current medicines (as recorded by the patient) -------------------
    if (can('medications')) {
      try {
        brief.medications = this.observations
          .listForMember(member.id, { kind: 'medication', pageSize: 30 })
          .items.map((o) => o.toJSON())
          .map((o) => ({
            name: o.payload?.name ? String(o.payload.name).slice(0, 120) : null,
            dose: o.payload?.dose ? String(o.payload.dose).slice(0, 120) : null,
            since: o.observedAt,
          }))
          .filter((m) => m.name);
      } catch {
        brief.medications = [];
      }
    }

    // ---- risk prototype (probability, never a diagnosis) ------------------
    if (can('risk')) {
      try {
        const risk = this.risk.assess(member);
        if (risk) {
          brief.riskFlags.push({
            id: risk.model?.id || 'risk',
            label: 'Type-2 diabetes risk (prototype)',
            band: risk.band,
            percent: risk.percent,
            completeness: risk.completeness,
            confidenceNote: risk.confidenceNote,
            topFactors: (risk.contributingFactors || []).slice(0, 4).map((f) => f.label || f.key || String(f)),
          });
        }
      } catch {
        /* risk is best-effort — a brief without it is still useful */
      }
    }

    // ---- recent reports (verified only) ----------------------------------
    if (can('reports')) {
      try {
        brief.recentReports = this.reports
          .listByMember(member.id, { page: 1, pageSize: 3 })
          .items.map((r) => r.toJSON())
          .filter((r) => r.status === 'verified')
          .map((r) => ({
            id: r.id,
            reportDate: r.reportDate || r.createdAt,
            verifiedAt: r.verifiedAt,
            originalName: r.originalName || null,
          }));
      } catch {
        brief.recentReports = [];
      }
    }

    // ---- only the gaps a chart truly cannot answer ------------------------
    brief.gapsToAsk = this.gaps(brief, member, can);

    // The existing doctor-visit summary adds discussion points; keep it as a
    // nested object so both representations stay available on one screen.
    if (can('summary') || can('labs')) {
      try {
        brief.discussionPoints = await this.summary.build(member);
      } catch {
        brief.discussionPoints = null;
      }
    }
    return brief;
  }

  /**
   * A doctor should not have to ask for facts the app already holds. This list
   * contains ONLY what is genuinely missing — and nothing a chart can answer.
   */
  gaps(brief, member, can) {
    const gaps = [];
    if (!member.family_history || Object.keys(member.familyHistory || {}).length === 0) {
      gaps.push({ key: 'family_history', ask: 'Family history (diabetes, heart disease, cancer)?', why: 'Not recorded on the profile.' });
    }
    if (brief.medications.length === 0) {
      gaps.push({ key: 'medications', ask: 'Are you taking any medicines, supplements or Ayurvedic products right now?', why: 'Nothing recorded in the medication log — this is the biggest blind spot for interactions.' });
    }
    gaps.push({ key: 'allergies', ask: 'Any known drug allergies or reactions?', why: 'Allergies are not part of the structured record.' });
    gaps.push({ key: 'symptoms', ask: 'How long have the current symptoms lasted, and what makes them better or worse?', why: 'Symptom timeline is free-text and often incomplete.' });
    if (can('vitals') && !brief.vitals.bp) {
      gaps.push({ key: 'bp', ask: 'Do you have a recent BP reading?', why: 'No BP recorded — it changes cardiovascular decisions.' });
    }
    if (brief.activeProblems.length === 0 && brief.recentReports.length === 0) {
      gaps.push({ key: 'records', ask: 'Do you have a recent report to upload?', why: 'No verified report on file yet — the brief is running on the profile alone.' });
    }
    gaps.push({ key: 'adherence', ask: 'Are you able to take medicines regularly, and any side effects so far?', why: 'Adherence history is not captured anywhere and changes the plan.' });
    return gaps.slice(0, 6);
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rangeStatus(row) {
  const value = Number(row.value);
  if (!Number.isFinite(value)) return 'unknown';
  const low = row.ref_low == null ? null : Number(row.ref_low);
  const high = row.ref_high == null ? null : Number(row.ref_high);
  if (low == null && high == null) return 'unknown';
  if (low != null && value < low) return 'low';
  if (high != null && value > high) return 'high';
  return 'normal';
}
