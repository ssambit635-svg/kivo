import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestContext } from '../helpers.js';
import { MILESTONE_DEFS, THREE_MONTHS_DAYS } from '../../src/services/MilestoneService.js';

/**
 * Milestone evaluation unit tests — real in-memory DB through repositories.
 * The five product milestones unlock strictly from real data events:
 * reports, verified lab values, the audit trail, and the verified-data span.
 */

let ctx, svc, reports, labs, members, auditLog, memberId, userId;

const byKey = (out, key) => out.milestones.find((m) => m.key === key);

function addVerifiedReport(reportDate, values) {
  const report = reports.create({ memberId, uploadedBy: userId, reportDate });
  for (const v of values) {
    labs.create({
      reportId: report.id,
      memberId,
      code: v.code,
      testName: v.code,
      value: v.value,
      unit: v.unit ?? null,
      refLow: v.refLow ?? null,
      refHigh: v.refHigh ?? null,
      measuredAt: reportDate,
      verified: 1,
    });
  }
  reports.markVerified(report.id);
  return report;
}

beforeAll(() => {
  ctx = makeTestContext();
  const c = ctx.container;
  svc = c.milestoneService;
  reports = c.reportRepository;
  labs = c.labResultRepository;
  members = c.memberRepository;
  auditLog = c.auditLogRepository;
  const user = c.userRepository.create({ email: 'mile@mt.test', displayName: 'Mile', passwordHash: c.passwordService.hash('T3st!Passw0rd#xx') });
  userId = user.id;
  memberId = members.create({ userId, name: 'Mile', relationship: 'self' }).id;
});
afterAll(() => ctx.container.close());

describe('MilestoneService — product definitions', () => {
  it('defines the five product milestones with icon keys (no emojis shipped)', () => {
    expect(MILESTONE_DEFS.map((d) => d.key)).toEqual([
      'first_report_added',
      'first_report_verified',
      'first_health_trend',
      'doctor_summary_generated',
      'three_month_history',
    ]);
    // eslint-disable-next-line no-control-regex
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const d of MILESTONE_DEFS) {
      expect(emoji.test(d.title)).toBe(false);
      expect(emoji.test(d.icon)).toBe(false);
      expect(d.icon).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('MilestoneService — fresh twin starts at zero', () => {
  it('nothing earned; next-up is the first report; history progress starts at 0 days', () => {
    const out = svc.evaluate(memberId);
    expect(out.earned).toBe(0);
    expect(out.total).toBe(5);
    expect(out.next.key).toBe('first_report_added');
    expect(out.milestones.every((m) => !m.achieved && m.achievedAt === null)).toBe(true);
    expect(byKey(out, 'three_month_history').progress).toEqual({ daysCovered: 0, requiredDays: THREE_MONTHS_DAYS });
  });
});

describe('MilestoneService — milestones unlock from real events, in order', () => {
  it('first (unverified) report → only "first_report_added" earns, anchored at its creation time', () => {
    const report = reports.create({ memberId, uploadedBy: userId, reportDate: '2026-01-10' });
    const out = svc.evaluate(memberId);
    expect(byKey(out, 'first_report_added').achieved).toBe(true);
    expect(byKey(out, 'first_report_added').achievedAt).toBe(report.created_at);
    expect(byKey(out, 'first_report_verified').achieved).toBe(false);
    expect(out.next.key).toBe('first_report_verified');
    expect(out.earned).toBe(1);
  });

  it('first verified report + two verified points of one marker → verified + trend milestones', () => {
    addVerifiedReport('2026-01-10', [{ code: 'hba1c', value: 5.9, unit: '%', refLow: 4.0, refHigh: 5.6 }]);
    let out = svc.evaluate(memberId);
    // only ONE point so far → trend needs two
    expect(byKey(out, 'first_health_trend').achieved).toBe(false);
    expect(byKey(out, 'first_report_verified').achieved).toBe(true);

    addVerifiedReport('2026-03-12', [{ code: 'hba1c', value: 5.5, unit: '%', refLow: 4.0, refHigh: 5.6 }]);
    out = svc.evaluate(memberId);
    const trend = byKey(out, 'first_health_trend');
    expect(trend.achieved).toBe(true);
    expect(trend.achievedAt).toBe('2026-03-12'); // the second data point IS the unlock moment
    expect(byKey(out, 'first_report_verified').achieved).toBe(true);

    // Jan 10 → Mar 12 = 61 days < 92 → still locked, with live progress
    const history = byKey(out, 'three_month_history');
    expect(history.achieved).toBe(false);
    expect(history.progress.daysCovered).toBe(61);
    expect(history.progress.requiredDays).toBe(THREE_MONTHS_DAYS);
    expect(out.earned).toBe(3);
  });

  it('doctor summary milestone comes from the AUDIT TRAIL (not a stored flag)', () => {
    let out = svc.evaluate(memberId);
    expect(byKey(out, 'doctor_summary_generated').achieved).toBe(false);

    auditLog.create({ userId, action: 'summary.doctor_generated', resourceType: 'member', resourceId: memberId });
    out = svc.evaluate(memberId);
    expect(byKey(out, 'doctor_summary_generated').achieved).toBe(true);
    expect(byKey(out, 'doctor_summary_generated').achievedAt).toBeTruthy();
  });

  it('a report 92+ days after the first data → 3-month history crosses; all 5 earned; next is null', () => {
    addVerifiedReport('2026-06-15', [{ code: 'hba1c', value: 5.3, unit: '%', refLow: 4.0, refHigh: 5.6 }]);
    const out = svc.evaluate(memberId);
    const history = byKey(out, 'three_month_history');
    expect(history.achieved).toBe(true);
    expect(history.achievedAt).toBe('2026-06-15'); // Jan 10 → Jun 15 = 156 days ≥ 92
    expect(out.earned).toBe(5);
    expect(out.next).toBeNull();
  });

  it('audit events are attributed per member — no cross-member leakage', () => {
    const other = members.create({ userId, name: 'Other', relationship: 'parent' });
    auditLog.create({ userId, action: 'summary.doctor_generated', resourceType: 'member', resourceId: other.id });
    const otherOut = svc.evaluate(other.id);
    expect(byKey(otherOut, 'doctor_summary_generated').achieved).toBe(true);
    expect(byKey(otherOut, 'first_report_added').achieved).toBe(false);
    expect(otherOut.earned).toBe(1);
    // …and our own member is unaffected by the foreign event
    expect(svc.evaluate(memberId).earned).toBe(5);
  });
});
