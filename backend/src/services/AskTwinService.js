import { LAB_DICTIONARY, aliasEntries } from './labs/labDictionary.js';

/**
 * Ask the Twin — grounded conversational Q&A over the Digital Health Twin
 * (demo narrative §17 step 7: "What changed in my health over the last year?").
 *
 * DESIGN RULES (identical to the rest of the AI pipeline):
 * - There is NO generative model here. A deterministic intent classifier maps
 *   the question onto one of a fixed set of intents; each intent assembles
 *   evidence from the EXISTING validated-data services (trends, risk model,
 *   baselines, anomalies, reports, observations) and the grounded-local
 *   narrator renders text from that structured evidence only.
 * - Every number in an answer is copied from computed evidence — the service
 *   can never invent a value, a study, a cause, or a diagnosis.
 * - Diagnosis-seeking questions are detected FIRST and always answered with a
 *   safety refusal + reframing ("I can't diagnose; here is what the recorded
 *   data shows"), never with condition language.
 * - Verified data only: every evidence source already enforces the
 *   verification gate, so unverified OCR drafts can never leak into answers.
 * - Total function: hostile or empty evidence degrades to a friendly
 *   "not enough recorded data yet" answer — it never throws.
 */

export const ASK_DISCLAIMER =
  'I am an information companion over your recorded, user-verified health data — not a doctor. ' +
  'Nothing I say is a diagnosis or medical advice. Please discuss persistent concerns with a ' +
  'qualified healthcare professional.';

export const MAX_QUESTION_LENGTH = 400;
export const MIN_QUESTION_LENGTH = 2;

/** Intent catalogue — order is the precedence order. */
const INTENT_RULES = [
  {
    id: 'diagnosis_request',
    label: 'Diagnosis questions (safety)',
    // "do I have" only counts as diagnosis-seeking when followed by a
    // condition word — otherwise "how many reports do I have?" would refuse.
    pattern:
      /\b(do\s+i\s+have\s+(?:cancer|diabetes|pre[-\s]?diabetes|hypertension|high|low|elevated|abnormal|borderline|a\s+(?:disease|condition|illness)|an?\s+(?:tumor|tumour|clot|infection)|something\s+(?:wrong|serious|bad)|anything\s+(?:wrong|serious))|am\s+i\s+(?:diabetic|pre[-\s]?diabetic|sick|ill|healthy|okay|ok)|diagnos(?:e|is|ed)|what\s+(?:disease|illness|condition)\b|\bhave\s+(?:cancer|diabetes|hypertension)\b|\bcancer\b|\btumou?r\b)\b/i,
  },
  {
    id: 'greeting',
    label: 'Greeting',
    pattern: /^\s*(hi|hello|hey|yo|good\s+(morning|afternoon|evening)|namaste|hola)\b[\s!.,?]*$/i,
  },
  {
    id: 'capabilities',
    label: 'What can the twin do',
    pattern: /\b(what\s+can\s+you\s+(do|answer|tell)|help\s+me|capabilit|\bhelp\b|what\s+do\s+you\s+know\s+about\s+me)\b/i,
  },
  {
    id: 'thanks',
    label: 'Thanks',
    pattern: /^\s*(thanks|thank\s+you|thx|ty|great|nice|cool|awesome)\b[\s!.,?]*$/i,
  },
  {
    id: 'risk',
    label: 'Risk awareness',
    pattern: /\b(risk|chances?\s+of|likelihood|probab|how\s+likely|predispos)\b/i,
  },
  {
    id: 'medications',
    label: 'Medication awareness',
    pattern: /\b(medicat\w*|medicin\w*|meds\b|drugs?\b|pills?\b|tablets?\b|dosage|prescriptions?)\b/i,
  },
  {
    id: 'doctor',
    label: 'Doctor-visit preparation',
    pattern: /\b(doctor|physician|appointment|clinic\s+visit|consult|check[-\s]?up|health\s+visit)\b/i,
  },
  {
    id: 'guidance',
    label: 'Lifestyle guidance',
    pattern: /\b(what\s+should\s+i\s+do|advice|recommend|improve|diet\b|nutrition|lifestyle|exercise|work[-\s]?out|eat\b|sleep\s+better|how\s+can\s+i)\b/i,
  },
  {
    id: 'score',
    label: 'Health score',
    pattern: /\b(health\s+score|my\s+score|current\s+score|how\s+am\s+i\s+doing|how\s+is\s+my\s+health|how\s+healthy\s+am\s+i|overall\s+state)\b/i,
  },
  {
    id: 'baseline',
    label: 'Personal baseline',
    pattern: /\b(baseline|normal\s+for\s+me|my\s+(?:typical|usual|normal)|what\s+is\s+typical\s+for\s+me)\b/i,
  },
  {
    id: 'anomaly',
    label: 'Detected shifts',
    pattern: /\b(unusual|anything\s+(?:odd|weird|strange|off|abnormal)|anomal|\bshifts?\b|spikes?\b|sudden(?:ly)?|drop(?:ped)?\b|jump(?:ed)?\b)\b/i,
  },
  {
    id: 'patterns',
    label: 'Patterns & associations',
    pattern: /\b(patterns?|connect(?:ed|ion)?|relat(?:ed|ion|ionships?)|correlat|move\s+together|go\s+together|associat)\b/i,
  },
  {
    id: 'milestones',
    label: 'Milestones',
    pattern: /\b(milestones?|achievements?|badges?|progress)\b/i,
  },
  {
    id: 'changes',
    label: 'What changed over time',
    // NB: ordered BEFORE 'reports' — "what changed since my first report?"
    // is a change question that merely mentions a report.
    pattern:
      /\b(what('| |’)s\s+changed|what\s+changed|changed\s+(?:in|since|over|recently)|has\s+(?:anything|my)\b[^?]*\bchanged|differences?\b|compar|trending|getting\s+(?:better|worse)|worsen|improv(?:ed|ing|ement)|over\s+time|since\s+(?:my\s+)?(?:first|last|previous)\b)\b/i,
  },
  {
    id: 'reports',
    label: 'Reports & records',
    pattern: /\b(how\s+many\s+reports|my\s+reports|reports?\b|uploads?|records?\b|what\s+do\s+you\s+have\s+on\s+file)\b/i,
  },
];

/** Marker names/aliases worth surfacing in follow-ups (curated core first). */
const FOLLOWUP_MARKER_HINTS = ['hba1c', 'fastingGlucose', 'ldl', 'hdl', 'triglycerides', 'totalCholesterol'];

export class AskTwinService {
  constructor({
    trendService,
    riskModelService,
    reportRepository,
    labResultRepository,
    observationRepository,
    intelligenceOrchestrator,
    healthScoreService,
    milestoneService,
    doctorSummaryService,
    guidanceService,
    medicationAwarenessService,
    llmGateway,
    policyService,
    auditService,
  }) {
    this.trends = trendService;
    this.risk = riskModelService;
    this.reports = reportRepository;
    this.labs = labResultRepository;
    this.observations = observationRepository;
    this.intelligence = intelligenceOrchestrator;
    this.healthScore = healthScoreService;
    this.milestones = milestoneService;
    this.doctorSummaries = doctorSummaryService;
    this.guidance = guidanceService;
    this.medicationAwareness = medicationAwarenessService;
    this.llm = llmGateway;
    this.policy = policyService;
    this.audit = auditService;
    this.aliasIndex = buildAliasIndex();
  }

  /**
   * Deterministic intent classification. Pure + total: any string in, a valid
   * classification out. Marker detection runs over the canonical dictionary
   * aliases (longest first) so "fasting glucose" wins over "glucose".
   */
  classifyIntent(rawQuestion) {
    const question = typeof rawQuestion === 'string' ? rawQuestion : '';
    const matchedCodes = this.matchMarkers(question);

    let intent = 'unknown';
    for (const rule of INTENT_RULES) {
      if (rule.pattern.test(question)) {
        intent = rule.id;
        break;
      }
    }

    // An explicitly named marker makes the answer about THAT marker unless a
    // stronger intent already claimed the question (risk/diagnosis/meds/...).
    const markerIsPrimary =
      matchedCodes.length > 0 && ['unknown', 'changes', 'baseline', 'anomaly'].includes(intent);
    if (markerIsPrimary) intent = 'marker';

    const rule = INTENT_RULES.find((r) => r.id === intent);
    const label = rule ? rule.label : intent === 'marker' ? 'Specific marker' : 'General question';
    return { intent, intentLabel: label, matchedCodes };
  }

  matchMarkers(question) {
    if (typeof question !== 'string' || !question.trim()) return [];
    const text = ` ${question.toLowerCase().replace(/\s+/g, ' ')} `;
    const hits = [];
    for (const { code, alias } of this.aliasIndex) {
      if (hits.length >= 3) break; // never answer more than 3 markers at once
      if (hits.includes(code)) continue;
      const needle = ` ${alias.toLowerCase().replace(/\s+/g, ' ')} `;
      // word-boundary match on the normalized question
      if (text.includes(needle) || new RegExp(`\\b${escapeRegExp(alias.toLowerCase())}\\b`, 'i').test(question)) {
        hits.push(code);
      }
    }
    return hits;
  }

  /**
   * Answer a question about a member's twin. `actor` must already have read
   * access enforced by the caller through the same policy path as trends.
   * Never throws — every evidence source is individually guarded.
   */
  async ask(actor, memberId, rawQuestion, ctx = {}) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertRead(actor, member);

    const question = typeof rawQuestion === 'string' ? rawQuestion.trim().replace(/\s+/g, ' ') : '';
    const { intent, intentLabel, matchedCodes } = this.classifyIntent(question);
    const evidence = await this.gatherEvidence(member, intent, matchedCodes, actor);

    const narration = await this.llm.narrate('ask_twin', {
      memberName: member.name,
      question,
      intent,
      matchedCodes,
      evidence,
    });

    const response = {
      question,
      intent,
      intentLabel,
      matchedMarkers: matchedCodes.map((code) => ({
        code,
        name: LAB_DICTIONARY[code]?.name || code,
      })),
      answer: narration.text,
      evidence,
      followUps: this.followUpsFor(intent, evidence),
      grounding: {
        ...(narration.grounding || {}),
        provider: narration.provider,
        deterministic: true,
        valuesFrom: 'structured-validated-input',
        safetyNotice: ASK_DISCLAIMER,
      },
      safetyNote: ASK_DISCLAIMER,
    };

    // Audit the event WITHOUT storing the question text itself: the audit
    // trail must stay free of free-form health narratives (privacy-by-design).
    // Best-effort: an audit outage must never break the answer path.
    try {
      this.audit.record({
        userId: actor.id,
        action: 'ask.question',
        resourceType: 'member',
        resourceId: member.id,
        outcome: 'success',
        metadata: { intent, matchedCodes, questionLength: question.length },
        ctx,
      });
    } catch {
      /* audit is advisory — never crash the request path */
    }

    return response;
  }

  /** Deterministic follow-up suggestions, shaped by what the data supports. */
  async suggestions(actor, memberId) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertRead(actor, member);
    const evidence = await this.gatherEvidence(member, 'capabilities', []);
    const ds = evidence.dataSummary || {};
    const out = [];
    if ((ds.verifiedReportCount || 0) >= 2) {
      out.push('What has changed in my health since my first report?');
    }
    const firstMarker = Array.isArray(evidence.trends) && evidence.trends.length > 0 ? evidence.trends[0] : null;
    if (firstMarker?.markerName) {
      out.push(`How is my ${firstMarker.markerName} trending?`);
    }
    out.push('What is my current risk estimate and what drives it?');
    if ((ds.verifiedLabCount || 0) > 0) {
      out.push('Anything unusual in my recent readings?');
    }
    out.push('What should I discuss at my next doctor visit?');
    out.push('What can you tell me about my records?');
    return { member: { id: member.id, name: member.name }, suggestions: out.slice(0, 6), dataSummary: ds };
  }

  // ---------------------------------------------------------------------
  // Evidence assembly — every field below comes from an existing validated
  // service; each block is individually guarded so a partial outage degrades
  // instead of failing the answer.
  // ---------------------------------------------------------------------

  async gatherEvidence(member, intent, matchedCodes, actor = null) {
    const memberId = member?.id ?? null;
    const evidence = { dataSummary: this.safe(() => this.dataSummary(memberId), {}) };

    if (['changes', 'marker', 'unknown', 'capabilities', 'diagnosis_request'].includes(intent)) {
      evidence.trends = this.safe(() => this.trends.analyzeMember(memberId) || [], []);
    }
    if (intent === 'marker' && matchedCodes.length > 0) {
      evidence.markers = matchedCodes.map((code) =>
        this.safe(() => {
          const pts = this.labs.seriesForMember(memberId, code) || [];
          return this.trends.analyze(code, pts);
        }, { code, message: 'This marker could not be analyzed right now.' }),
      );
    }
    if (['risk', 'diagnosis_request', 'capabilities', 'unknown'].includes(intent)) {
      evidence.risk = this.safe(() => this.risk.assess(member, {}), null);
    }
    if (['baseline', 'anomaly', 'patterns', 'diagnosis_request'].includes(intent)) {
      evidence.intelligence = this.safe(() => this.intelligence.getEvidence(member), null);
    }
    if (intent === 'score') {
      evidence.healthScore = this.safe(() => this.healthScore.timelineFor(memberId), null);
    }
    if (intent === 'milestones') {
      evidence.milestones = this.safe(() => this.milestones.evaluate(memberId), null);
    }
    if (intent === 'doctor') {
      evidence.doctorSummary = await this.safeAsync(() => this.doctorSummaries.build(member), null);
    }
    if (intent === 'guidance') {
      evidence.guidance = await this.safeAsync(
        () => (actor ? this.guidance.forMember(actor, memberId) : Promise.resolve(null)),
        null,
      );
    }
    if (intent === 'medications') {
      evidence.medicationCount = this.safe(
        () => this.observations.listForMember(memberId, { kind: 'medication', pageSize: 100 })?.total ?? 0,
        0,
      );
      evidence.medicationAwareness = this.safe(
        () => (actor && this.medicationAwareness ? this.medicationAwareness.forMember(actor, memberId) : null),
        null,
      );
    }
    return evidence;
  }

  dataSummary(memberId) {
    const reportsPage = this.reports.listByMember(memberId, { page: 1, pageSize: 100 }) || { items: [], total: 0 };
    const items = reportsPage.items || [];
    const verifiedReports = items.filter((r) => r.status === 'verified');
    const draftReports = items.filter((r) => r.status !== 'verified');
    const codes = this.labs.codesWithVerifiedData(memberId, 1) || [];
    const observations = this.observations.listForMember(memberId, { pageSize: 1 }) || { total: 0 };
    return {
      reportCount: reportsPage.total ?? items.length,
      verifiedReportCount: verifiedReports.length,
      draftReportCount: draftReports.length,
      verifiedMarkerCount: codes.length,
      observationCount: observations.total ?? 0,
    };
  }

  followUpsFor(intent, evidence) {
    const out = [];
    const ds = evidence?.dataSummary || {};
    if (intent === 'greeting' || intent === 'capabilities' || intent === 'unknown' || intent === 'thanks') {
      if ((ds.verifiedReportCount || 0) >= 2) out.push('What has changed in my health since my first report?');
      out.push('What is my current risk estimate and what drives it?');
      out.push('What should I discuss at my next doctor visit?');
      return out;
    }
    if (intent === 'diagnosis_request') {
      out.push('What does my recorded data actually show?');
      out.push('What is my current risk estimate and what drives it?');
      return out;
    }
    if (intent === 'risk') {
      out.push('What has changed in my health over time?');
      out.push('What should I discuss at my next doctor visit?');
      return out;
    }
    if (intent === 'changes' || intent === 'marker') {
      out.push('What is my current risk estimate and what drives it?');
      out.push('Anything unusual in my recent readings?');
      return out;
    }
    if (intent === 'doctor') {
      out.push('What has changed in my health since my first report?');
      return out;
    }
    if (intent === 'anomaly' || intent === 'baseline' || intent === 'patterns') {
      out.push('What has changed in my health over time?');
      out.push('What is my current risk estimate and what drives it?');
      return out;
    }
    if (intent === 'medications') {
      out.push('What should I discuss at my next doctor visit?');
      return out;
    }
    if (intent === 'guidance') {
      out.push('What is my current risk estimate and what drives it?');
      return out;
    }
    if (intent === 'score') {
      out.push('What has changed in my health over time?');
      return out;
    }
    if (intent === 'reports') {
      const firstMarker = Array.isArray(evidence?.trends) && evidence.trends[0]?.markerName;
      if (firstMarker) out.push(`How is my ${firstMarker} trending?`);
      return out;
    }
    if (intent === 'milestones') {
      out.push('How is my health score trending?');
      return out;
    }
    return out;
  }

  safe(fn, fallback) {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  }

  async safeAsync(fn, fallback) {
    try {
      const v = await fn();
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  }
}

/** Longest-first alias index across the whole dictionary (aliases + code + name). */
function buildAliasIndex() {
  const entries = [];
  const seen = new Set();
  try {
    for (const { code, alias } of aliasEntries()) {
      const key = `${code}:${alias.toLowerCase().trim()}`;
      if (seen.has(key) || alias.trim().length < 2) continue;
      seen.add(key);
      entries.push({ code, alias: alias.trim() });
    }
    // Code + display names are also fair question material ("how is hba1c?").
    for (const [code, def] of Object.entries(LAB_DICTIONARY)) {
      if (!def || def.valueKind === 'qualitative') continue;
      for (const name of [code, def.name]) {
        if (typeof name !== 'string' || name.trim().length < 3) continue;
        const key = `${code}:${name.toLowerCase().trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ code, alias: name.trim() });
      }
    }
    entries.sort((a, b) => b.alias.length - a.alias.length);
  } catch {
    /* degraded dictionary → no marker matching; intents still work */
  }
  return entries;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { FOLLOWUP_MARKER_HINTS };
