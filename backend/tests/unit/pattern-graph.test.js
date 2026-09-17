import { describe, it, expect } from 'vitest';
import { HealthPatternGraphService, GRAPH_DISCLAIMER, RELATIONSHIP_LEGEND } from '../../src/services/intelligence/HealthPatternGraphService.js';
import { RiskModelService } from '../../src/services/RiskModelService.js';

function makeSvc(labRows = [], obsByKind = {}) {
  const labResultRepository = {
    verifiedValuesForMember: () => labRows,
    latestForMember: (memberId, code) => {
      const rows = labRows.filter((r) => r.code === code).sort((a, b) => (a.measured_at < b.measured_at ? 1 : -1));
      return rows[0] || null;
    },
  };
  const observationRepository = {
    listForMember: (memberId, { kind, pageSize }) => {
      const items = (obsByKind[kind] || []).map((o, i) => ({ id: `ob-${kind}-${i}`, ...o }));
      return { items: items.slice(0, pageSize), total: items.length, page: 1, pageSize };
    },
    latestOfKind: (memberId, kind) => {
      const items = (obsByKind[kind] || []).map((o, i) => ({ id: `ob-${kind}-${i}`, ...o }));
      return items.sort((a, b) => (a.observed_at < b.observed_at ? 1 : -1))[0] || null;
    },
  };
  const riskModelService = new RiskModelService({ labResultRepository, observationRepository });
  return new HealthPatternGraphService({ labResultRepository, observationRepository, riskModelService });
}

const member = { id: 'm1', name: 'T', dob: '1980-01-01', height_cm: 170, updated_at: '2026-01-01', familyHistory: { diabetes: false } };
const lab = (code, value, measured_at) => ({
  id: `lr-${code}-${measured_at}`, code, test_name: code, value, unit: 'x', confidence: 0.9, measured_at,
});
const D = (m) => `2026-0${m}-15`;

describe('HealthPatternGraphService — data-derived graph', () => {
  it('creates one node per recorded signal, with baseline state', () => {
    const svc = makeSvc([lab('hba1c', 5.4, D(1)), lab('hba1c', 5.5, D(2)), lab('hba1c', 5.4, D(3))]);
    const g = svc.build(member);
    const node = g.nodes.find((n) => n.id === 'lab:hba1c');
    expect(node).toBeDefined();
    expect(node.pointCount).toBe(3);
    expect(node.baselineMean).toBeCloseTo(5.433, 2);
    expect(node.latestValue).toBe(5.4);
  });

  it('finds STATISTICAL_ASSOCIATION between co-moving histories (Pearson)', () => {
    const svc = makeSvc(
      [150, 170, 190, 210].map((v, i) => lab('triglycerides', v, D(i + 1))),
      { weight: [70, 73, 76, 79].map((w, i) => ({ observed_at: D(i + 1), data: { weightKg: w } })) },
    );
    const g = svc.build(member);
    const e = g.edges.find((x) => x.type === 'STATISTICAL_ASSOCIATION');
    expect(e).toBeDefined();
    expect(e.strength).toBeGreaterThanOrEqual(0.5);
    expect(e.evidence.join(' ')).toMatch(/time-aligned/i);
    expect(e.note).toMatch(/not evidence of causation/i);
  });

  it('does not invent correlation for sparse overlaps (UNKNOWN examples instead)', () => {
    const svc = makeSvc([lab('hba1c', 5.4, D(1)), lab('ldl', 100, D(6))]);
    const g = svc.build(member);
    expect(g.edges.filter((x) => x.type === 'STATISTICAL_ASSOCIATION')).toHaveLength(0);
    expect(g.unknownPairExamples.length).toBeGreaterThan(0);
    expect(g.unknownPairExamples[0].type).toBe('UNKNOWN');
  });

  it('emits MODEL_CONTRIBUTION edges from the existing risk model (faithful readout)', () => {
    const svc = makeSvc(
      [
        lab('hba1c', 6.8, D(1)), lab('fasting_glucose', 150, D(1)),
        lab('hdl', 40, D(1)), lab('triglycerides', 200, D(1)),
      ],
      { weight: [{ observed_at: D(1), data: { weightKg: 90 } }] },
    );
    const g = svc.build(member);
    const modelNode = g.nodes.find((n) => n.type === 'model');
    expect(modelNode).toBeDefined();
    expect(modelNode.band).toBeDefined();
    const medges = g.edges.filter((x) => x.type === 'MODEL_CONTRIBUTION');
    expect(medges.length).toBeGreaterThan(0);
    for (const e of medges) {
      expect(e.target).toBe(modelNode.id);
      expect(e.note).toMatch(/describes the model, not the body/i);
    }
  });

  it('TEMPORAL_ASSOCIATION edges mirror multivariate shift findings', () => {
    const svc = makeSvc(
      [
        lab('triglycerides', 150, D(1)), lab('triglycerides', 152, D(2)),
        lab('triglycerides', 151, D(3)), lab('triglycerides', 149, D(4)),
        lab('triglycerides', 200, D(5)), lab('triglycerides', 205, D(6)), lab('triglycerides', 198, D(7)),
      ],
      {
        weight: [70, 70, 71, 70, 76, 77, 76].map((w, i) => ({ observed_at: D(i + 1), data: { weightKg: w } })),
      },
    );
    const g = svc.build(member);
    const temporal = g.edges.filter((x) => x.type === 'TEMPORAL_ASSOCIATION');
    expect(temporal.length).toBeGreaterThan(0);
    expect(temporal[0].timeWindow.from).toBeDefined();
    expect(temporal[0].note).toMatch(/timing overlap, nothing more/i);
  });
});

describe('HealthPatternGraphService — legend + safety', () => {
  it('legend documents all five relationship types as non-causal', () => {
    expect(Object.keys(RELATIONSHIP_LEGEND)).toEqual(
      expect.arrayContaining(['OBSERVED', 'TEMPORAL_ASSOCIATION', 'STATISTICAL_ASSOCIATION', 'MODEL_CONTRIBUTION', 'UNKNOWN']),
    );
    const svc = makeSvc([]);
    const g = svc.build(member);
    expect(g.disclaimer).toBe(GRAPH_DISCLAIMER);
    expect(g.disclaimer).toMatch(/association is not causation/i);
  });

  it('empty history yields an empty graph, never a hardcoded fake one', () => {
    const svc = makeSvc([]);
    const g = svc.build(member);
    expect(g.edges).toHaveLength(0);
    expect(g.nodes.filter((n) => n.type === 'signal')).toHaveLength(0);
    expect(g.consideredPairs).toBe(0);
  });
});
