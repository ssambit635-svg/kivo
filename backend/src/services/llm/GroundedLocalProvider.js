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
    switch (request.task) {
      case 'explain_report':
        return this.wrap(this.explainReport(request.data), request.data);
      case 'summarize_trends':
        return this.wrap(this.summarizeTrends(request.data), request.data);
      case 'doctor_summary':
        return this.wrap(this.doctorSummary(request.data), request.data);
      default:
        return this.wrap('Unsupported narration task.', request.data);
    }
  }

  wrap(text, data) {
    return {
      text,
      provider: this.name,
      deterministic: true,
      grounding: {
        valuesFrom: 'structured-validated-input',
        markerCount: data?.markers?.length ?? data?.trends?.length ?? 0,
        safetyNotice:
          'This explanation is informational only, derived strictly from values shown above. ' +
          'It is not a medical diagnosis.',
      },
    };
  }

  explainReport({ memberName, reportDate, markers }) {
    const lines = [];
    const dateStr = reportDate ? new Date(reportDate).toISOString().slice(0, 10) : 'the current report';
    lines.push(`Report explanation for ${memberName} (${dateStr}).`);
    lines.push('');

    const flagged = markers.filter((m) => m.status === 'high' || m.status === 'low');
    const normal = markers.filter((m) => m.status === 'normal');
    const unknown = markers.filter((m) => m.status === 'unknown');

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

  summarizeTrends({ memberName, trends }) {
    const lines = [];
    const moved = trends.filter((t) => t.meaningfulChange);
    lines.push(`Longitudinal summary for ${memberName} across ${trends.length} marker(s) with verified data.`);
    lines.push('');

    if (moved.length === 0) {
      lines.push('No meaningful changes were detected between the verified reports so far.');
      lines.push('Markers currently look stable relative to their recent history and reported ranges.');
    } else {
      lines.push(`${moved.length} marker(s) changed meaningfully since the first verified measurement:`);
      for (const t of moved) {
        const dirWord = t.direction === 'increasing' ? 'increased' : 'decreased';
        const pct = t.deltaPct != null ? ` (${t.deltaPct > 0 ? '+' : ''}${t.deltaPct}%)` : '';
        const transitions =
          t.statusTransitions.length > 0
            ? ` Status changed: ${t.statusTransitions.map((s) => `${s.from} → ${s.to}`).join(', ')}.`
            : '';
        lines.push(
          `• ${t.markerName}: ${dirWord} from ${t.points[0].value}${unit(t.unit)} (${shortDate(t.firstAt)}) ` +
            `to ${t.latestValue}${unit(t.unit)} (${shortDate(t.latestAt)})${pct}.${transitions}`,
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

  doctorSummary({ memberName, sections }) {
    const lines = [`Doctor-visit summary for ${memberName}.`, ''];
    for (const section of sections) {
      lines.push(`${section.title}`);
      for (const item of section.items) lines.push(`  • ${item}`);
      lines.push('');
    }
    lines.push(
      'This summary was assembled from user-entered and user-verified data to support — not ' +
        'replace — a consultation with a qualified healthcare professional.',
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
  return new Date(iso).toISOString().slice(0, 10);
}
function explainer(code) {
  const blurbs = {
    hba1c: 'HbA1c reflects average blood-sugar levels over roughly the past 2–3 months.',
    fasting_glucose: 'Fasting glucose measures blood sugar after at least 8 hours without food.',
    total_cholesterol: 'Total cholesterol sums several blood fats — interpret it together with its parts.',
    hdl: 'HDL is often called "good" cholesterol; higher values are generally protective.',
    ldl: 'LDL is often called "bad" cholesterol; persistently high values are linked to artery plaque buildup.',
    triglycerides: 'Triglycerides are a blood fat influenced by diet, alcohol and activity.',
    hemoglobin: 'Hemoglobin carries oxygen in red blood cells.',
    creatinine: 'Creatinine is a waste product used to gauge kidney filtration.',
    egfr: 'eGFR estimates how well the kidneys filter blood.',
    tsh: 'TSH is the main thyroid-regulating hormone.',
    vitamin_d: 'Vitamin D supports bone health and immune function.',
    vitamin_b12: 'Vitamin B12 supports nerves and red-blood-cell formation.',
    alt: 'ALT is a liver enzyme; elevations can signal liver stress.',
    ast: 'AST is a liver enzyme; elevations can signal liver or muscle stress.',
    platelets: 'Platelets help blood clot.',
    wbc: 'White blood cells are part of the immune system.',
  };
  return blurbs[code] || 'This is one of the markers measured in your report.';
}
