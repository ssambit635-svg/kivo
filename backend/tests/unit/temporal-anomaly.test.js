import { describe, it, expect } from 'vitest';
import { TemporalAnomalyService, ANOMALY_DISCLAIMER } from '../../src/services/intelligence/TemporalAnomalyService.js';

function makeSvc(labRows = [], obsByKind = {}) {
  return new TemporalAnomalyService({
    labResultRepository: { verifiedValuesForMember: () => labRows },
    observationRepository: {
      listForMember: (memberId, { kind, pageSize }) => {
        const items = (obsByKind[kind] || []).map((o, i) => ({ id: `ob-${kind}-${i}`, ...o }));
        return { items: items.slice(0, pageSize), total: items.length, page: 1, pageSize };
      },
    },
  });
}

const member = { id: 'm1', name: 'T', dob: '1980-01-01', height_cm: null, updated_at: '2026-01-01', familyHistory: {} };
const lab = (code, value, measured_at) => ({
  id: `lr-${code}-${measured_at}`, code, test_name: code, value, unit: 'x', confidence: 0.9, measured_at,
});
const D = (m) => `2026-0${m}-15`;

describe('TemporalAnomalyService — single-signal detectors', () => {
  it('flags a sudden shift with transparent method/score/threshold', () => {
    const svc = makeSvc([
      lab('hba1c', 5.4, D(1)), lab('hba1c', 5.5, D(2)), lab('hba1c', 5.4, D(3)),
      lab('hba1c', 5.5, D(4)), lab('hba1c', 9.8, D(5)),
    ]);
    const r = svc.analyze(member);
    const f = r.findings.find((x) => x.type === 'sudden_shift');
    expect(f).toBeDefined();
    expect(f.severity).toBe('watch');
    expect(f.method).toMatch(/robust z-score/);
    expect(f.score).toBeGreaterThanOrEqual(f.threshold);
    expect(f.evidence.length).toBeGreaterThan(0);
    expect(f.interpretation).toMatch(/personal deviation/);
  });

  it('flags gradual drift', () => {
    const svc = makeSvc([100, 105, 110, 115, 120, 125].map((v, i) => lab('x', v, D(i + 1))));
    const r = svc.analyze(member);
    expect(r.findings.some((x) => x.type === 'gradual_drift')).toBe(true);
  });

  it('detects a change point between stable regimes', () => {
    const svc = makeSvc([100, 101, 99, 100, 102, 130, 131, 129, 130].map((v, i) => lab('x', v, `2026-01-${String(i + 1).padStart(2, '0')}`)));
    const r = svc.analyze(member);
    const f = r.findings.find((x) => x.type === 'change_point');
    expect(f).toBeDefined();
    expect(f.score).toBeGreaterThanOrEqual(1.5);
  });

  it('reports long measurement gaps as data_gap (high confidence, date-derived)', () => {
    const svc = makeSvc([lab('hba1c', 5.4, '2025-01-01'), lab('hba1c', 5.5, '2025-09-01')]);
    const r = svc.analyze(member);
    const f = r.findings.find((x) => x.type === 'data_gap');
    expect(f).toBeDefined();
    expect(f.score).toBeGreaterThan(180);
    expect(f.confidence.level).toBe('high');
  });

  it('a single measurement yields no shift findings (insufficient data, no fabrication)', () => {
    const svc = makeSvc([lab('hba1c', 9.9, D(1))]);
    const r = svc.analyze(member);
    expect(r.findings.filter((x) => x.type !== 'data_gap')).toHaveLength(0);
  });
});

describe('TemporalAnomalyService — multivariate reasoning', () => {
  it('detects coordinated movement across signals in the same window', () => {
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
    const r = svc.analyze(member);
    const f = r.findings.find((x) => x.type === 'multivariate_shift');
    expect(f).toBeDefined();
    expect(f.signals.length).toBeGreaterThanOrEqual(2);
    expect(f.interpretation).toMatch(/does not show|not as a shared cause/i);
  });

  it('flags divergent movement within one signal group as conflicting (not error)', () => {
    const svc = makeSvc([
      // hba1c shifts up recently…
      lab('hba1c', 5.2, D(1)), lab('hba1c', 5.3, D(2)), lab('hba1c', 5.2, D(3)),
      lab('hba1c', 6.4, D(4)), lab('hba1c', 6.5, D(5)), lab('hba1c', 6.4, D(6)),
      // …while fasting glucose shifts down over the same window
      lab('fasting_glucose', 120, D(1)), lab('fasting_glucose', 121, D(2)), lab('fasting_glucose', 119, D(3)),
      lab('fasting_glucose', 88, D(4)), lab('fasting_glucose', 87, D(5)), lab('fasting_glucose', 89, D(6)),
    ]);
    const r = svc.analyze(member);
    const f = r.findings.find((x) => x.type === 'conflicting_measurements');
    expect(f).toBeDefined();
    expect(f.interpretation).toMatch(/different measurement|timing/i);
  });

  it('flags a latest snapshot that is unusual relative to personal history', () => {
    const svc = makeSvc([
      lab('hba1c', 5.0, D(1)), lab('hba1c', 5.0, D(2)), lab('hba1c', 5.0, D(3)),
      lab('hba1c', 5.0, D(4)), lab('hba1c', 5.0, D(5)), lab('hba1c', 6.5, D(6)),
      lab('ldl', 100, D(1)), lab('ldl', 100, D(2)), lab('ldl', 100, D(3)),
      lab('ldl', 100, D(4)), lab('ldl', 100, D(5)), lab('ldl', 160, D(6)),
    ]);
    const r = svc.analyze(member);
    const f = r.findings.find((x) => x.type === 'unusual_combination');
    expect(f).toBeDefined();
    expect(f.score).toBeGreaterThanOrEqual(2.0);
    expect(f.interpretation).toMatch(/personal history/);
  });
});

describe('TemporalAnomalyService — severity cap + safety', () => {
  it('severity is only ever informational or watch', () => {
    const svc = makeSvc([
      lab('hba1c', 5.4, D(1)), lab('hba1c', 5.5, D(2)), lab('hba1c', 9.8, D(3)), lab('hba1c', 12.1, D(4)),
    ]);
    const r = svc.analyze(member);
    expect(r.findings.length).toBeGreaterThan(0);
    for (const f of r.findings) {
      expect(['informational', 'watch']).toContain(f.severity);
    }
  });

  it('SAFETY: disclaimer present; no causation or diagnostic claims', () => {
    const svc = makeSvc([
      lab('hba1c', 5.4, D(1)), lab('hba1c', 5.5, D(2)), lab('hba1c', 5.4, D(3)), lab('hba1c', 9.8, D(4)),
    ]);
    const r = svc.analyze(member);
    expect(r.disclaimer).toBe(ANOMALY_DISCLAIMER);
    // Strip the disclaimer's own explicitly-negated phrases, then require
    // no affirmative causal/diagnostic claim to remain.
    const text = JSON.stringify(r)
      .replace(/not evidence that one caused the other/gi, '')
      .replace(/not as a shared cause/gi, '')
      .replace(/does not show/gi, '');
    expect(text).not.toMatch(/you have/i);
    expect(text).not.toMatch(/diagnos/i);
    expect(text).not.toMatch(/caused/i);
    expect(text).not.toMatch(/proves/i);
  });
});
