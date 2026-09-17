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
        case 'ask_twin':
          return this.wrap(this.askTwin(data), data);
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

  /**
   * Ask-the-Twin narration. Renders one of a fixed set of intent answers
   * strictly from the structured evidence object — every number, name, date
   * and band below is copied from that evidence; nothing is computed or
   * invented here. Diagnosis-seeking questions always get the safety
   * refusal + reframe, never condition language.
   */
  askTwin({ memberName, intent, evidence } = {}) {
    const name = memberName || 'you';
    const ev = evidence && typeof evidence === 'object' ? evidence : {};
    const ds = ev.dataSummary && typeof ev.dataSummary === 'object' ? ev.dataSummary : {};
    const lines = [];
    const footer =
      'Reminder: I speak only from your recorded, user-verified data. I cannot diagnose anything — ' +
      'please discuss persistent concerns with a qualified healthcare professional.';

    const recordLine = () =>
      `I currently hold ${ds.verifiedReportCount ?? 0} verified report(s) and ` +
      `${ds.draftReportCount ?? 0} awaiting review, covering ${ds.verifiedMarkerCount ?? 0} marker(s), ` +
      `plus ${ds.observationCount ?? 0} journal observation(s).`;

    switch (intent) {
      case 'greeting':
        lines.push(`Hello ${name}! I am your Digital Health Twin — a structured memory of your recorded health data.`);
        lines.push(recordLine());
        lines.push('Ask me what changed over time, about a specific marker, your risk estimate, or what to discuss with your doctor.');
        break;

      case 'thanks':
        lines.push(`You are welcome, ${name}. I am here whenever you want to review your recorded health data.`);
        break;

      case 'capabilities':
        lines.push(`Here is what I can tell you about, ${name}, based on what is on file.`);
        lines.push('');
        lines.push(recordLine());
        lines.push('');
        lines.push('You can ask me things like:');
        lines.push('• “What has changed in my health since my first report?”');
        lines.push('• “How is my HbA1c trending?” (any recorded marker works)');
        lines.push('• “What is my risk estimate and what drives it?”');
        lines.push('• “Anything unusual in my recent readings?”');
        lines.push('• “What should I discuss at my next doctor visit?”');
        lines.push('');
        lines.push('Every answer I give is built only from the recorded, verified values above — I never guess or invent numbers.');
        break;

      case 'diagnosis_request':
        lines.push(`I cannot diagnose any condition, ${name} — and I will not guess at one. That is a job for a qualified healthcare professional.`);
        lines.push('What I CAN do is show you what your recorded, verified data actually says:');
        lines.push('');
        this.pushChangeBullets(lines, ev);
        this.pushRiskBlock(lines, ev);
        lines.push(footer);
        return lines.join('\n');

      case 'risk':
        lines.push(`Risk awareness for ${name}:`);
        lines.push('');
        this.pushRiskBlock(lines, ev);
        lines.push(footer);
        return lines.join('\n');

      case 'marker': {
        const list = Array.isArray(ev.markers) ? ev.markers.filter(Boolean) : [];
        if (list.length === 0) {
          lines.push(`I could not analyze that marker from your recorded data, ${name}. ${recordLine()}`);
          break;
        }
        for (const m of list) {
          if (!m || Array.isArray(m.points) && m.points.length === 0) {
            lines.push(`• ${m?.markerName || m?.code || 'That marker'}: no verified measurements recorded yet — verify a report containing it to start its trend.`);
            continue;
          }
          const dirWord = m.direction === 'increasing' ? 'increasing' : m.direction === 'decreasing' ? 'decreasing' : 'stable';
          const pct = m.deltaPct != null && Number.isFinite(Number(m.deltaPct)) ? ` (${m.deltaPct > 0 ? '+' : ''}${m.deltaPct}%)` : '';
          const statusWord = m.latestStatus === 'high' ? 'above' : m.latestStatus === 'low' ? 'below' : m.latestStatus === 'normal' ? 'within' : 'not comparable to';
          lines.push(
            `• ${m.markerName || m.code}: latest verified value ${fmt(m.latestValue)}${unit(m.unit)} on ${shortDate(m.latestAt)} — ` +
              `${dirWord} across ${m.pointCount} measurement(s)${pct}, and ${statusWord} the reference range ${rangeStr(m)}.`,
          );
          if (Array.isArray(m.statusTransitions) && m.statusTransitions.length > 0) {
            lines.push(`  Status crossings over time: ${m.statusTransitions.map((s) => `${s.from} → ${s.to}`).join(', ')}.`);
          }
          if (m.interpretation) lines.push(`  Reading: ${m.interpretation}`);
        }
        break;
      }

      case 'changes':
        lines.push(`Longitudinal changes for ${name}:`);
        lines.push('');
        this.pushChangeBullets(lines, ev);
        break;

      case 'score': {
        const hs = ev.healthScore && typeof ev.healthScore === 'object' ? ev.healthScore : null;
        const current = hs?.current;
        if (!current || current.score == null) {
          lines.push(`No health score yet, ${name} — it appears once you have at least one verified report. ${recordLine()}`);
        } else {
          const delta = current.delta != null ? ` (${current.delta > 0 ? '+' : ''}${current.delta} vs the previous snapshot)` : '';
          lines.push(
            `Your latest health snapshot is ${current.score}/100 (${current.band || 'n/a'}) as of ${shortDate(current.at)}${delta}, ` +
              `based on ${current.markerCount ?? 0} marker(s), ${current.outOfRangeCount ?? 0} of them outside their reported range.`,
          );
          lines.push('This is a transparent summary of recorded values against their ranges — not a clinical score.');
        }
        break;
      }

      case 'baseline': {
        const intel = ev.intelligence && typeof ev.intelligence === 'object' ? ev.intelligence : null;
        const baselines = intel?.baselines?.baselines;
        if (!Array.isArray(baselines) || baselines.length === 0) {
          lines.push(`Not enough verified data yet to describe your personal baselines, ${name}. ${recordLine()}`);
        } else {
          lines.push(`Your personal baselines (what is typical for YOU, not a population):`);
          for (const b of baselines.filter(Boolean).slice(0, 5)) {
            lines.push(`• ${b.summary || b.label || 'A recorded signal'}`);
          }
          const level = intel?.baselines?.overallConfidence?.level;
          if (level) lines.push(`Baseline confidence: ${level}.`);
        }
        break;
      }

      case 'anomaly': {
        const intel = ev.intelligence && typeof ev.intelligence === 'object' ? ev.intelligence : null;
        const findings = Array.isArray(intel?.anomalies?.findings) ? intel.anomalies.findings : [];
        if (findings.length === 0) {
          lines.push(`I found no notable shifts in your recorded history, ${name}. Stability is itself useful information.`);
        } else {
          lines.push(`Shifts I detected in your recorded data:`);
          for (const f of findings.filter(Boolean).slice(0, 5)) {
            lines.push(`• [${f.severity || 'note'}] ${f.interpretation || 'A change was noted.'}`);
          }
        }
        break;
      }

      case 'patterns': {
        const intel = ev.intelligence && typeof ev.intelligence === 'object' ? ev.intelligence : null;
        const edges = Array.isArray(intel?.graph?.edges) ? intel.graph.edges : [];
        if (edges.length === 0) {
          lines.push(`Not enough overlapping recorded signals yet to describe patterns, ${name}. ${recordLine()}`);
        } else {
          lines.push('Observed associations between your recorded signals:');
          for (const e of edges.filter(Boolean).slice(0, 5)) {
            lines.push(
              `• ${e.source || '?'} ↔ ${e.target || '?'}: ${e.type || 'association'}` +
                `${e.strength == null ? '' : ` (strength ${e.strength})`}. Observed association only — not proof of cause.`,
            );
          }
        }
        break;
      }

      case 'medications': {
        const awareness = ev.medicationAwareness && typeof ev.medicationAwareness === 'object' ? ev.medicationAwareness : null;
        const count = Number.isFinite(Number(ev.medicationCount)) ? ev.medicationCount : awareness?.medications?.length ?? 0;
        if (!count || count === 0) {
          lines.push(`You have not recorded any medication observations yet, ${name}. Add them as journal entries of kind “medication”.`);
        } else {
          lines.push(`You have ${count} medication observation(s) on record.`);
          const topics = Array.isArray(awareness?.topics) ? awareness.topics : [];
          if (topics.length > 0) {
            lines.push('Topics your recorded medications and verified lab values raise for a professional conversation:');
            for (const t of topics.slice(0, 5)) lines.push(`• ${t.title || t.topic || 'A discussion topic.'}`);
          }
        }
        lines.push('I never recommend starting, stopping, or changing any medication — that decision belongs to your clinician.');
        break;
      }

      case 'guidance': {
        const g = ev.guidance && typeof ev.guidance === 'object' ? ev.guidance : null;
        const items = Array.isArray(g?.items) ? g.items.filter(Boolean) : [];
        if (items.length === 0) {
          lines.push(`Not enough recorded context yet for personalized general-information notes, ${name}. ${recordLine()}`);
        } else {
          lines.push(`General-information notes grounded in your recorded values (not medical advice):`);
          for (const item of items.slice(0, 6)) {
            lines.push(`• ${item.title || 'Note'}: ${item.body || ''}`.trim());
          }
        }
        break;
      }

      case 'doctor': {
        const summary = ev.doctorSummary && typeof ev.doctorSummary === 'object' ? ev.doctorSummary : null;
        const sections = Array.isArray(summary?.sections) ? summary.sections : [];
        if (sections.length === 0) {
          lines.push(`Not enough verified data yet to prepare a doctor-visit summary, ${name}. ${recordLine()}`);
        } else {
          lines.push(`Prepared for your next consultation, ${name} — key points from your verified records:`);
          for (const s of sections.slice(0, 6)) {
            const items = Array.isArray(s.items) ? s.items : [];
            if (items.length === 0) continue;
            lines.push(`${s.title || 'Section'}`);
            for (const item of items.slice(0, 4)) lines.push(`  • ${item}`);
          }
          lines.push('The full summary (with discussion points) is available on the Doctor Summary screen.');
        }
        break;
      }

      case 'reports':
        lines.push(`Your records, ${name}:`);
        lines.push(
          `• ${ds.reportCount ?? 0} report(s) in total — ${ds.verifiedReportCount ?? 0} verified, ${ds.draftReportCount ?? 0} awaiting your review.`,
        );
        lines.push(`• ${ds.verifiedMarkerCount ?? 0} marker(s) with verified values, and ${ds.observationCount ?? 0} journal observation(s).`);
        lines.push('Only values you verify are ever used in my trends, scores and risk estimates.');
        break;

      case 'milestones': {
        const ms = ev.milestones && typeof ev.milestones === 'object' ? ev.milestones : null;
        if (!ms || !Array.isArray(ms.milestones)) {
          lines.push(`Milestones are unavailable right now, ${name}.`);
        } else {
          lines.push(`Milestones for ${name}: ${ms.earned ?? 0} of ${ms.total ?? 0} earned.`);
          for (const m of ms.milestones.filter(Boolean)) {
            lines.push(`• ${m.achieved ? 'Earned' : 'Locked'} — ${m.title || m.key}${m.achievedAt ? ` (${shortDate(m.achievedAt)})` : ''}`);
          }
          if (ms.next && !ms.next.achieved) lines.push(`Next up: ${ms.next.title || ms.next.key}.`);
        }
        break;
      }

      default:
        lines.push(`I want to answer precisely, ${name}, but I could not map that question to something in your records.`);
        lines.push(recordLine());
        lines.push('Try asking about changes over time, a specific marker (e.g. “How is my HbA1c trending?”), your risk estimate, or your next doctor visit.');
        break;
    }

    lines.push('');
    lines.push(footer);
    return lines.join('\n');
  }

  /** Shared bullet block: meaningful verified changes (copied from trends). */
  pushChangeBullets(lines, ev) {
    const trends = Array.isArray(ev.trends) ? ev.trends.filter(Boolean) : [];
    const moved = trends.filter((t) => t.meaningfulChange);
    if (trends.length === 0) {
      lines.push('• No verified marker series yet — upload and verify a report to start the timeline.');
      return;
    }
    if (moved.length === 0) {
      lines.push(`• Across ${trends.length} tracked marker(s), nothing changed meaningfully between your verified reports — values look stable relative to their history.`);
      return;
    }
    lines.push(`${moved.length} marker(s) changed meaningfully across your verified reports:`);
    for (const t of moved.slice(0, 5)) {
      const dirWord = t.direction === 'increasing' ? 'up' : t.direction === 'decreasing' ? 'down' : 'changed';
      const pct = t.deltaPct != null && Number.isFinite(Number(t.deltaPct)) ? ` (${t.deltaPct > 0 ? '+' : ''}${t.deltaPct}%)` : '';
      const firstVal = Array.isArray(t.points) && t.points.length ? t.points[0]?.value : null;
      lines.push(
        `• ${t.markerName || t.code}: ${fmt(firstVal)} → ${fmt(t.latestValue)}${unit(t.unit)}, ${dirWord}${pct} ` +
          `between ${shortDate(t.firstAt)} and ${shortDate(t.latestAt)}.`,
      );
    }
  }

  /** Shared block: prototype risk estimate (copied from the risk model output). */
  pushRiskBlock(lines, ev) {
    const risk = ev.risk && typeof ev.risk === 'object' ? ev.risk : null;
    const result = risk?.result && typeof risk.result === 'object' ? risk.result : null;
    if (!result || result.percent == null) {
      lines.push('• No prototype risk estimate is available right now — it computes from verified labs plus profile data (age, height/weight, blood pressure, activity, family history).');
      return;
    }
    const completeness = Number.isFinite(Number(result.completeness)) ? Math.round(result.completeness * 100) : 0;
    lines.push(
      `• The transparent prototype model estimates ${result.percent}% (${result.band || 'unknown band'}) with ${completeness}% data completeness. ${result.confidenceNote || ''}`,
    );
    const factors = Array.isArray(result.contributingFactors) ? result.contributingFactors : [];
    if (factors.length > 0) {
      lines.push('Largest contributors (signed model effect):');
      for (const f of factors.slice(0, 3)) {
        lines.push(
          `  – ${f.label}: ${fmt(f.value)}${f.unit ? ` ${f.unit}` : ''} — ${f.effectOnEstimate || 'neutral'} the estimate.`,
        );
      }
    }
    lines.push('This is a model-based risk-awareness figure, not a diagnosis and not clinically validated.');
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
