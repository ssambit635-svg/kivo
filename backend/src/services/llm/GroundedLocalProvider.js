import { LAB_DICTIONARY } from '../labs/labDictionary.js';

/**
 * GroundedLocalProvider — the cost-free LLM substitute.
 *
 * It is deliberately NOT a generative model. It narrates *only* from the
 * validated, structured JSON it is given (marker values, ranges, trends,
 * model contributions). Every number it emits is copied from its input;
 * it can never invent a value, a study, or a diagnosis. Sentence safety
 * rules from the product spec (no "you have diabetes", always "outside
 * the reference range shown on your report ... discuss with a qualified
 * healthcare professional") are hard-coded into the templates.
 */
export class GroundedLocalProvider {
  name = 'grounded-local';
  deterministic = true;

  /**
   * @param {{task: string, data: object}} request strictly structured input
   * @returns {{text: string, provider: string, deterministic: true, grounding: object}}
   */
  async generate(request) {
    // Narration must never throw: callers treat it as advisory text.
    try {
      const task = request?.task;
      const data = request?.data && typeof request.data === 'object' ? request.data : {};
      switch (task) {
        case 'explain_report':
          return this.wrap(this.explainReport(data), data);
        case 'summarize_trends':
          return this.wrap(this.summarizeTrends(data), data);
        case 'doctor_summary':
          return this.wrap(this.doctorSummary(data), data);
        case 'explain_intelligence':
          return this.wrap(this.explainIntelligence(data), data);
        case 'lifestyle_guidance':
          return this.wrap(this.lifestyleGuidance(data), data);
        default:
          return this.wrap('Unsupported narration task.', data);
      }
    } catch {
      return {
        text: 'An automatic explanation is temporarily unavailable — the structured values shown alongside it are complete.',
        provider: this.name,
        deterministic: true,
        grounding: { valuesFrom: 'structured-validated-input', markerCount: 0 },
      };
    }
  }

  wrap(text, data) {
    let count = 0;
    try {
      count = data?.markers?.length ?? data?.trends?.length ?? data?.items?.length ?? 0;
      if (!Number.isFinite(Number(count))) count = 0;
    } catch {
      count = 0;
    }
    return {
      text: typeof text === 'string' && text ? text : 'Explanation unavailable.',
      provider: this.name,
      deterministic: true,
      grounding: {
        valuesFrom: 'structured-validated-input',
        markerCount: count,
        safetyNotice:
          'This explanation is informational only, derived strictly from values shown above. ' +
          'It is not a medical diagnosis.',
      },
    };
  }

  explainReport({ memberName, reportDate, markers } = {}) {
    const lines = [];
    const list = Array.isArray(markers) ? markers : [];
    const dateStr = safeDate(reportDate, 'the current report');
    lines.push(`Report explanation for ${memberName || 'you'} (${dateStr}).`);
    lines.push('');

    const flagged = list.filter((m) => m && (m.status === 'high' || m.status === 'low'));
    const normal = list.filter((m) => m && m.status === 'normal');
    const unknown = list.filter((m) => m && m.status !== 'high' && m.status !== 'low' && m.status !== 'normal');

    for (const m of flagged) {
      const direction = m.status === 'high' ? 'above' : 'below';
      lines.push(
        `• ${m.testName}: ${fmt(m.value)}${unit(m.unit)} is ${direction} the reference range ` +
          `shown on this report (${rangeStr(m)}). ${explainer(m.code)} ` +
          `A single out-of-range value has many possible causes; if it persists, it is worth ` +
          `discussing with a qualified healthcare professional.`,
      );
    }
    for (const m of normal) {
      lines.push(
        `• ${m.testName}: ${fmt(m.value)}${unit(m.unit)} — within the reference range shown on this report (${rangeStr(m)}).`,
      );
    }
    for (const m of unknown) {
      lines.push(
        `• ${m.testName}: ${fmt(m.value)}${unit(m.unit)} — no reference range was captured for this test, ` +
          `so it cannot be compared automatically.`,
      );
    }
    lines.push('');
    lines.push(
      'Reminder: this explanation describes how the values compare with the reference ranges on ' +
        'the report itself. It does not diagnose any condition.',
    );
    return lines.join('\n');
  }

  summarizeTrends({ memberName, trends } = {}) {
    const lines = [];
    const list = Array.isArray(trends) ? trends.filter(Boolean) : [];
    const moved = list.filter((t) => t.meaningfulChange);
    lines.push(`Longitudinal summary for ${memberName || 'you'} across ${list.length} marker(s) with verified data.`);
    lines.push('');

    if (moved.length === 0) {
      lines.push('No meaningful changes were detected between the verified reports so far.');
      lines.push('Markers currently look stable relative to their recent history and reported ranges.');
    } else {
      lines.push(`${moved.length} marker(s) changed meaningfully since the first verified measurement:`);
      for (const t of moved) {
        const dirWord = t.direction === 'increasing' ? 'increased' : t.direction === 'decreasing' ? 'decreased' : 'changed';
        const pct = t.deltaPct != null && Number.isFinite(Number(t.deltaPct)) ? ` (${t.deltaPct > 0 ? '+' : ''}${t.deltaPct}%)` : '';
        const transitions = Array.isArray(t.statusTransitions) && t.statusTransitions.length > 0
          ? ` Status changed: ${t.statusTransitions.map((s) => `${s.from} → ${s.to}`).join(', ')}.`
          : '';
        const firstVal = Array.isArray(t.points) && t.points.length ? t.points[0]?.value : null;
        lines.push(
          `• ${t.markerName || t.code || 'A marker'}: ${dirWord} from ${fmt(firstVal)}${unit(t.unit)} (${shortDate(t.firstAt)}) ` +
            `to ${fmt(t.latestValue)}${unit(t.unit)} (${shortDate(t.latestAt)})${pct}.${transitions}`,
        );
      }
    }
    lines.push('');
    lines.push(
      'These are observed changes in recorded values, not a diagnosis. Persistent movement outside ' +
        'reference ranges is a good reason to speak with a qualified healthcare professional.',
    );
    return lines.join('\n');
  }

  /**
   * Narrates a Personal Health Intelligence evidence package. Every number,
   * label, date and band below is copied from the structured input — this
   * method performs no computation and invents no values. Association is
   * always framed as non-causal; nothing here is a diagnosis.
   */
  explainIntelligence({ memberName, dataSummary, cards, baselines, findings, edges, risk, uncertainty } = {}) {
    const lines = [];
    const name = memberName || 'you';
    const ds = dataSummary && typeof dataSummary === 'object' ? dataSummary : {};
    const unc = uncertainty && typeof uncertainty === 'object' ? uncertainty : {};
    lines.push(`Personal Health Intelligence summary for ${name}.`);
    lines.push('');
    lines.push(
      `This summary is grounded in ${ds.signalCount ?? 0} recorded signal(s) ` +
        `(${ds.verifiedLabCount ?? 0} verified lab values, ${ds.observationCount ?? 0} observations). ` +
        `Overall intelligence confidence is ${unc.level || 'unknown'}.`,
    );
    lines.push('');

    const cardList = Array.isArray(cards) ? cards : [];
    const baselineCard = cardList.find((c) => c && c.title === 'Personal Baseline');
    if (baselineCard) {
      lines.push('PERSONAL BASELINE');
      lines.push(baselineCard.headline || 'Baseline unavailable.');
      for (const d of (Array.isArray(baselineCard.detail) ? baselineCard.detail : []).slice(0, 4)) lines.push(`• ${d}`);
      lines.push('');
    } else if (Array.isArray(baselines) && baselines.length > 0) {
      lines.push('PERSONAL BASELINE');
      for (const b of baselines.filter(Boolean).slice(0, 4)) lines.push(`• ${b.summary || 'Baseline unavailable.'}`);
      lines.push('');
    }

    const findingList = Array.isArray(findings) ? findings.filter(Boolean) : [];
    if (findingList.length > 0) {
      lines.push('DETECTED SHIFTS');
      for (const f of findingList.slice(0, 4)) {
        lines.push(`• [${f.severity || 'note'}] ${f.interpretation || 'A shift was noted.'}`);
      }
      lines.push('');
    } else {
      lines.push('DETECTED SHIFTS');
      lines.push('• No notable shifts were detected in the recorded history.');
      lines.push('');
    }

    const edgeList = Array.isArray(edges) ? edges.filter(Boolean) : [];
    if (edgeList.length > 0) {
      lines.push('HEALTH PATTERNS');
      for (const e of edgeList.slice(0, 4)) {
        lines.push(
          `• ${e.source || '?'} and ${e.target || '?'}: ${e.type || 'association'} (strength ${e.strength == null ? 'n/a' : e.strength}). ` +
            `This is an observed association, not proof that one caused the other.`,
        );
      }
      lines.push('');
    }

    lines.push('MODEL CONTEXT');
    if (risk && typeof risk === 'object') {
      const completeness = Number.isFinite(Number(risk.completeness)) ? Math.round(risk.completeness * 100) : 0;
      lines.push(
        `The existing prototype risk estimate stands at ${risk.percent ?? 'n/a'}% (${risk.band || 'unknown'}) with ` +
          `${completeness}% data completeness. This is a model-based figure ` +
          `over recorded inputs — not a prediction about any person.`,
      );
    } else {
      lines.push('No prototype risk estimate is available for this member right now.');
    }
    lines.push('');

    lines.push('CONFIDENCE');
    for (const r of (Array.isArray(unc.reasons) ? unc.reasons : []).slice(0, 4)) lines.push(`• ${r}`);
    lines.push('');
    lines.push(
      'Reminder: this intelligence summary describes patterns in recorded values — personal ' +
        'baselines, historical shifts, and associations between signals. It does not diagnose ' +
        'any condition — this is not a diagnosis — it does not claim causation, and it does not ' +
        'replace discussion with a qualified healthcare professional.',
    );
    return lines.join('\n');
  }

  doctorSummary({ memberName, sections } = {}) {
    const lines = [`Doctor-visit summary for ${memberName || 'you'}.`, ''];
    for (const section of (Array.isArray(sections) ? sections : []).filter(Boolean)) {
      lines.push(`${section.title || 'Section'}`);
      for (const item of (Array.isArray(section.items) ? section.items : []).slice(0, 30)) lines.push(`  • ${item}`);
      lines.push('');
    }
    lines.push(
      'This summary was assembled from user-entered and user-verified data to support — not ' +
        'replace — a consultation with a qualified healthcare professional.',
    );
    return lines.join('\n');
  }

  lifestyleGuidance({ memberName, items } = {}) {
    const lines = [`General lifestyle information for ${memberName || 'you'}.`, ''];
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (list.length === 0) {
      lines.push('Not enough recorded information yet to personalize this section — it will grow as verified reports and observations are added.');
    } else {
      for (const item of list.slice(0, 12)) {
        lines.push(`• ${item.title || 'Note'}: ${item.body || ''}`.trim());
        if (item.why) lines.push(`  Why this appears: ${item.why}`);
      }
    }
    lines.push('');
    lines.push(
      'These are general-information notes based only on the recorded values listed above — not medical advice, ' +
        'not a diet plan, and not a treatment recommendation. Please discuss any change with a qualified healthcare professional.',
    );
    return lines.join('\n');
  }
}

function fmt(v) {
  return v == null ? 'n/a' : String(v);
}
function unit(u) {
  return u ? ` ${u}` : '';
}
function rangeStr(m) {
  if (m.refLow != null && m.refHigh != null) return `${m.refLow}–${m.refHigh}${unit(m.unit)}`;
  if (m.refHigh != null) return `below ${m.refHigh}${unit(m.unit)}`;
  if (m.refLow != null) return `above ${m.refLow}${unit(m.unit)}`;
  return 'no reference range captured';
}
function shortDate(iso) {
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return 'unknown date';
    return new Date(t).toISOString().slice(0, 10);
  } catch {
    return 'unknown date';
  }
}
function safeDate(iso, fallback) {
  if (!iso) return fallback;
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return fallback;
    return new Date(t).toISOString().slice(0, 10);
  } catch {
    return fallback;
  }
}
function explainer(code) {
  // Patient-education text comes from the knowledge base (curated narratives
  // authored in-house, plus the structural fallback). Nothing here is generated:
  // the sentence is either the marker's own curated narrative or a neutral
  // "compare it against your report's range" statement.
  const def = LAB_DICTIONARY[code];
  const narrative = def?.narrative;
  if (narrative) {
    const related = (def.related ?? [])
      .map((c) => LAB_DICTIONARY[c]?.name)
      .filter(Boolean)
      .slice(0, 3);
    return related.length
      ? `${narrative} It is usually read together with ${related.join(', ')}.`
      : narrative;
  }
  if (def?.name) {
    return `${def.name} is one of the markers measured in this report; compare it against the reference range printed alongside it.`;
  }
  return 'This is one of the markers measured in your report.';
}
