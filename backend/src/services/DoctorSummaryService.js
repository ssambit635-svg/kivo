/**
 * Doctor-visit preparation (product feature 10.2). Compiles RECENT,
 * user-verified data + trend output + the risk prototype into a concise
 * structured summary, with rule-based discussion points. Assists
 * communication — it never assesses instead of the doctor.
 */
export class DoctorSummaryService {
  constructor({ reportRepository, labResultRepository, observationRepository, trendService, riskModelService, llmGateway }) {
    this.reports = reportRepository;
    this.labs = labResultRepository;
    this.observations = observationRepository;
    this.trends = trendService;
    this.risk = riskModelService;
    this.llm = llmGateway;
  }

  async build(member) {
    const recentReports = this.reports
      .listByMember(member.id, { page: 1, pageSize: 3 })
      .items.map((r) => r.toJSON());

    const trendList = this.trends.analyzeMember(member.id);
    const risk = this.risk.assess(member);

    const abnormalNow = [];
    for (const t of trendList) {
      if (t.latestStatus === 'high' || t.latestStatus === 'low') {
        abnormalNow.push(
          `${t.markerName}: latest ${t.latestValue}${t.unit ? ` ${t.unit}` : ''} (${t.latestStatus} vs reference ${this.rangeStr(t)})`,
        );
      }
    }

    const changed = trendList
      .filter((t) => t.meaningfulChange)
      .map(
        (t) =>
          `${t.markerName}: ${t.direction} since ${this.short(t.firstAt)} ` +
          `(${t.deltaPct != null ? `${t.deltaPct > 0 ? '+' : ''}${t.deltaPct}%` : 'n/a'})${t.statusTransitions.length ? ', status change: ' + t.statusTransitions.map((s) => `${s.from}→${s.to}`).join('; ') : ''}`,
      );

    const meds = this.observations.listForMember(member.id, { kind: 'medication', pageSize: 20 }).items
      .map((o) => o.toJSON())
      .map((o) => (o.payload?.name ? `${o.payload.name}${o.payload.dose ? ` (${o.payload.dose})` : ''}` : null))
      .filter(Boolean);

    const sections = [
      {
        title: 'Patient',
        items: [
          `Name: ${member.name}${member.age != null ? `, age ${member.age}` : ''}${member.sex ? `, sex ${member.sex}` : ''}`,
          member.heightCm != null ? `Height: ${member.heightCm} cm` : null,
        ].filter(Boolean),
      },
      {
        title: 'Recent reports',
        items: recentReports.length
          ? recentReports.map(
              (r) => `${this.short(r.reportDate || r.createdAt)} — ${r.originalName || 'report'} (${r.status})`,
            )
          : ['No reports uploaded yet.'],
      },
      {
        title: 'Values currently outside reference range',
        items: abnormalNow.length ? abnormalNow : ['None detected in the latest verified values.'],
      },
      {
        title: 'Notable changes across reports',
        items: changed.length ? changed : ['No meaningful changes detected so far.'],
      },
      {
        title: 'Medications (as entered by the user)',
        items: meds.length ? meds : ['None recorded.'],
      },
      {
        title: 'Risk-awareness estimate (prototype, not a diagnosis)',
        items: [
          `Type-2 diabetes risk estimate: ${risk.result.percent}% (${risk.result.band}) — model ${risk.result.model.id} v${risk.result.model.version}, completeness ${Math.round(risk.result.completeness * 100)}%.`,
          ...risk.result.contributingFactors.slice(0, 3).map(
            (f) => `Top factor: ${f.label} = ${f.value}${f.unit ? ` ${f.unit}` : ''} — ${f.effectOnEstimate} the estimate.`,
          ),
        ],
      },
      {
        title: 'Suggested discussion points',
        items: this.discussionPoints({ trendList, risk: risk.result, abnormalCount: abnormalNow.length }),
      },
    ];

    const narration = await this.llm.narrate('doctor_summary', { memberName: member.name, sections });

    return {
      generatedAt: new Date().toISOString(),
      sections,
      narrative: narration,
      disclaimers: [
        'This summary was generated from user-entered and user-verified data only.',
        'It supports communication with a healthcare professional and does not replace clinical assessment.',
        risk.result.disclaimer,
      ],
    };
  }

  discussionPoints({ trendList, risk, abnormalCount }) {
    const points = [];
    for (const t of trendList) {
      if (t.statusTransitions.some((s) => s.to === 'high' || s.to === 'low')) {
        points.push(
          `${t.markerName} crossed the reference range on ${this.short(t.statusTransitions[0].at)} — ask whether follow-up testing is needed.`,
        );
      }
    }
    if (risk.band === 'elevated' || risk.band === 'high') {
      points.push(
        'The prototype diabetes risk estimate is above the typical band — worth reviewing with the doctor alongside fasting glucose/HbA1c history.',
      );
    }
    if (abnormalCount > 0 && points.length === 0) {
      points.push('Several values are outside the reference range — worth a review even without obvious symptoms.');
    }
    if (points.length === 0) {
      points.push('Values look broadly stable — consider confirming the routine check-up schedule.');
    }
    return points;
  }

  rangeStr(t) {
    const { low, high } = t.referenceRange || {};
    if (low != null && high != null) return `${low}–${high}`;
    if (high != null) return `below ${high}`;
    if (low != null) return `above ${low}`;
    return 'n/a';
  }

  short(iso) {
    return iso ? new Date(iso).toISOString().slice(0, 10) : 'unknown date';
  }
}
