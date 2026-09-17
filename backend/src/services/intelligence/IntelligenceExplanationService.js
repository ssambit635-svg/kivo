/**
 * Intelligence Explanation Service (ADD-ON): turns the deterministic
 * intelligence evidence package into grounded human-readable narration via
 * the EXISTING LlmGateway. The LLM never computes numbers — it only
 * narrates the structured evidence it is handed; every figure in the
 * explanation is copied from the evidence package.
 */
export class IntelligenceExplanationService {
  constructor({ intelligenceOrchestrator, llmGateway }) {
    this.intelligence = intelligenceOrchestrator;
    this.llm = llmGateway;
  }

  async explain(member) {
    const evidence = this.intelligence.getEvidence(member);
    const narration = await this.llm.narrate('explain_intelligence', {
      memberName: evidence.memberName,
      dataSummary: evidence.dataSummary,
      cards: evidence.summaryCards.map((c) => ({
        title: c.title,
        headline: c.headline,
        detail: c.detail,
        level: c.level,
      })),
      baselines: evidence.baselines.baselines.map((b) => ({
        label: b.label,
        unit: b.unit,
        observationCount: b.observationCount,
        mean: b.mean,
        latestValue: b.latest.value,
        latestAt: b.latest.at,
        deviationZ: b.latest.deviationZ,
        status: b.status,
        summary: b.summary,
      })),
      findings: evidence.anomalies.findings.map((f) => ({
        type: f.type,
        severity: f.severity,
        markers: f.markers,
        method: f.method,
        interpretation: f.interpretation,
      })),
      edges: evidence.graph.edges.slice(0, 6).map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type,
        strength: e.strength,
        note: e.note,
      })),
      risk: {
        percent: evidence.risk.result.percent,
        band: evidence.risk.result.band,
        completeness: evidence.risk.result.completeness,
      },
      uncertainty: evidence.uncertainty,
    });
    return {
      memberId: member.id,
      generatedAt: new Date().toISOString(),
      explanation: narration,
      evidence,
    };
  }
}
