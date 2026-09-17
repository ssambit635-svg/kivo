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
    const safeMember = member && typeof member === 'object' ? member : { id: null, name: 'Unknown' };
    let recentReports = [];
    try {
      recentReports = safeMember.id
        ? this.reports.listByMember(safeMember.id, { page: 1, pageSize: 3 }).items.map((r) => r.toJSON())
        : [];
    } catch {
      recentReports = [];
    }

    let trendList = [];
    try {
      trendList = safeMember.id ? this.trends.analyzeMember(safeMember.id) || [] : [];
    } catch {
      trendList = [];
    }
    let risk = null;
    try {
      risk = this.risk.assess(safeMember);
    } catch {
      risk = null;
    }

    const abnormalNow = [];
    for (const t of trendList || []) {
      try {
        if (!t) continue;
        if (t.latestStatus === 'high' || t.latestStatus === 'low') {
          abnormalNow.push(
            `${t.markerName}: latest ${t.latestValue}${t.unit ? ` ${t.unit}` : ''} (${t.latestStatus} vs reference ${this.rangeStr(t)})`,
          );
        }
      } catch {
        continue;
      }
    }

    const changed = (trendList || [])
      .filter((t) => t && t.meaningfulChange)
      .map((t) => {
        try {
          const transitions = Array.isArray(t.statusTransitions) ? t.statusTransitions : [];
          return (
            `${t.markerName}: ${t.direction} since ${this.short(t.firstAt)} ` +
            `(${t.deltaPct != null ? `${t.deltaPct > 0 ? '+' : ''}${t.deltaPct}%` : 'n/a'})${transitions.length ? `, status change: ${transitions.map((s) => `${s.from}→${s.to}`).join('; ')}` : ''}`
          );
        } catch {
          return `${t?.markerName || 'A marker'}: change detected (details unavailable).`;
        }
      });

    let meds = [];
    try {
      meds = safeMember.id
        ? this.observations.listForMember(safeMember.id, { kind: 'medication', pageSize: 20 }).items
          .map((o) => o.toJSON())
          .map((o) => (o.payload?.name ? `${o.payload.name}${o.payload.dose ? ` (${o.payload.dose})` : ''}` : null))
          .filter(Boolean)
        : [];
    } catch {
      meds = [];
    }

    const riskItems = (() => {
      try {
        if (!risk?.result) return ['Risk estimate unavailable for this member right now.'];
        const r = risk.result;
        const factors = Array.isArray(r.contributingFactors) ? r.contributingFactors.slice(0, 3) : [];
        return [
          `Type-2 diabetes risk estimate: ${r.percent}% (${r.band}) — model ${r.model.id} v${r.model.version}, completeness ${Math.round(r.completeness * 100)}%.`,
          ...factors.map(
            (f) => `Top factor: ${f.label} = ${f.value}${f.unit ? ` ${f.unit}` : ''} — ${f.effectOnEstimate} the estimate.`,
          ),
        ];
      } catch {
        return ['Risk estimate unavailable for this member right now.'];
      }
    })();

    let discussion = [];
    try {
      discussion = this.discussionPoints({ trendList, risk: risk?.result || null, abnormalCount: abnormalNow.length });
    } catch {
      discussion = ['Values look broadly stable — consider confirming the routine check-up schedule.'];
    }

    const sections = [
      {
        title: 'Patient',
        items: [
          `Name: ${safeMember.name}${safeMember.age != null ? `, age ${safeMember.age}` : ''}${safeMember.sex ? `, sex ${safeMember.sex}` : ''}`,
          safeMember.heightCm != null ? `Height: ${safeMember.heightCm} cm` : null,
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
        items: riskItems,
      },
      {
        title: 'Suggested discussion points',
        items: discussion.length ? discussion : ['Values look broadly stable — consider confirming the routine check-up schedule.'],
      },
    ];

    let narration;
    try {
      narration = await this.llm.narrate('doctor_summary', { memberName: safeMember.name, sections });
    } catch {
      narration = {
        text: `Visit summary for ${safeMember.name}: ${recentReports.length} recent report(s), ${abnormalNow.length} value(s) outside reference range, ${changed.length} notable change(s). Automatic narration is temporarily unavailable — the sections above are complete.`,
        provider: 'fallback',
        deterministic: true,
        grounding: { valuesFrom: 'structured-validated-input' },
      };
    }

    return {
      generatedAt: new Date().toISOString(),
      sections,
      narrative: narration,
      disclaimers: [
        'This summary was generated from user-entered and user-verified data only.',
        'It supports communication with a healthcare professional and does not replace clinical assessment.',
        risk?.result?.disclaimer || 'Risk estimates are prototype outputs, not medical diagnoses.',
      ],
    };
  }

  discussionPoints({ trendList, risk, abnormalCount }) {
    const points = [];
    for (const t of trendList || []) {
      try {
        const transitions = Array.isArray(t?.statusTransitions) ? t.statusTransitions : [];
        if (transitions.some((s) => s && (s.to === 'high' || s.to === 'low'))) {
          points.push(
            `${t.markerName} crossed the reference range on ${this.short(transitions[0].at)} — ask whether follow-up testing is needed.`,
          );
        }
      } catch {
        continue;
      }
    }
    if (risk && (risk.band === 'elevated' || risk.band === 'high')) {
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
    try {
      const { low, high } = t?.referenceRange || {};
      if (low != null && high != null) return `${low}–${high}`;
      if (high != null) return `below ${high}`;
      if (low != null) return `above ${low}`;
      return 'n/a';
    } catch {
      return 'n/a';
    }
  }

  short(iso) {
    try {
      if (!iso) return 'unknown date';
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) return 'unknown date';
      return new Date(t).toISOString().slice(0, 10);
    } catch {
      return 'unknown date';
    }
  }
}
