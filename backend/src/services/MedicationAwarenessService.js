const DISCLAIMER =
  'These are discussion topics assembled from medications you entered and your verified lab values. This is NOT a ' +
  'drug-interaction check, NOT a side-effect assessment, and NOT medical advice. Never start, stop or change a ' +
  'medication because of this screen — always discuss medication questions with your doctor or pharmacist.';

/**
 * Medication & lab awareness (§10.4 of the product spec).
 *
 * Deliberately narrow: this product has no drug-interaction database, so it
 * claims none. What it CAN do honestly is place user-entered medications next
 * to the latest verified values and say: "this combination may warrant
 * discussion with a healthcare professional." Every topic uses that safe
 * framing — never a directive, never a stop/change recommendation.
 */
export class MedicationAwarenessService {
  constructor({ labResultRepository, observationRepository, policyService }) {
    this.labs = labResultRepository;
    this.observations = observationRepository;
    this.policy = policyService;
  }

  forMember(actor, memberId) {
    const { member } = this.policy.loadMemberWithAccess(actor, memberId);
    this.policy.assertRead(actor, member);

    let meds = [];
    try {
      meds = this.observations.listForMember(memberId, { kind: 'medication', pageSize: 50 }).items
        .map((o) => o.toJSON())
        .map((o) => ({
          name: o.payload?.name ? String(o.payload.name).slice(0, 120) : null,
          dose: o.payload?.dose ? String(o.payload.dose).slice(0, 120) : null,
          observedAt: o.observedAt,
        }))
        .filter((m) => m.name);
    } catch {
      meds = [];
    }

    let verified = [];
    try {
      verified = this.labs.verifiedValuesForMember(memberId) || [];
    } catch {
      verified = [];
    }

    // Latest verified value per marker.
    const latestByCode = new Map();
    for (const row of verified) {
      if (!row || !row.code || row.value == null || !Number.isFinite(Number(row.value))) continue;
      latestByCode.set(row.code, row); // rows are ASC — last write wins
    }

    const outOfRange = [];
    for (const row of latestByCode.values()) {
      const status = rangeStatus(row);
      if (status === 'high' || status === 'low') {
        outOfRange.push({
          code: row.code,
          name: row.test_name || row.code,
          value: row.value,
          unit: row.unit,
          status,
          range: { low: row.ref_low ?? null, high: row.ref_high ?? null },
          measuredAt: row.measured_at,
        });
      }
    }

    const topics = [];
    if (meds.length === 0) {
      topics.push({
        kind: 'no-medications',
        title: 'No medications recorded',
        body: 'You have not recorded any medications for this member, so there is nothing to review alongside the labs. If you take regular medicines, recording them (name + dose) lets this screen flag discussion topics.',
      });
    } else if (latestByCode.size === 0) {
      for (const med of meds.slice(0, 20)) {
        topics.push({
          kind: 'no-labs-yet',
          title: `${displayMed(med)} — no verified labs yet`,
          body: `You recorded ${displayMed(med)}, but there are no verified lab values to review alongside it yet. Verify a report and this screen will place them side by side. This combination may warrant discussion with a healthcare professional.`,
          medication: med,
        });
      }
    } else if (outOfRange.length === 0) {
      topics.push({
        kind: 'labs-in-range',
        title: 'Recorded values sit within their ranges',
        body: `You recorded ${meds.length} medication(s) and the latest verified values sit within their reference ranges. Keep both lists current — and remember this screen is not an interaction check.`,
        medications: meds.slice(0, 20),
      });
    } else {
      for (const med of meds.slice(0, 20)) {
        for (const lab of outOfRange.slice(0, 10)) {
          topics.push({
            kind: 'medication-lab-topic',
            title: `${displayMed(med)} alongside ${lab.name}`,
            body:
              `You recorded ${displayMed(med)} and your latest verified ${lab.name} is ${lab.value}${lab.unit ? ` ${lab.unit}` : ''} ` +
              `(${lab.status === 'high' ? 'above' : 'below'} its reference range). This combination may warrant discussion with a healthcare professional.`,
            medication: med,
            lab,
          });
        }
      }
    }

    return {
      memberId,
      generatedAt: new Date().toISOString(),
      medications: meds.slice(0, 20),
      latestOutOfRangeLabs: outOfRange.slice(0, 20),
      verifiedLabCount: latestByCode.size,
      topics: topics.slice(0, 60),
      notAnInteractionCheck: true,
      disclaimer: DISCLAIMER,
    };
  }
}

function displayMed(med) {
  return med.dose ? `${med.name} (${med.dose})` : med.name;
}

function rangeStatus(row) {
  try {
    if (typeof row.statusFromStoredRange === 'function') {
      const s = row.statusFromStoredRange();
      if (s === 'high' || s === 'low' || s === 'normal') return s;
      return 'unknown';
    }
    if (row.ref_high != null && row.value > row.ref_high) return 'high';
    if (row.ref_low != null && row.value < row.ref_low) return 'low';
    if (row.ref_high != null || row.ref_low != null) return 'normal';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
