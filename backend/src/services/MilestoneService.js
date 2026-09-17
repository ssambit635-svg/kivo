import { daysBetween } from '../utils/time.js';

/**
 * Health Milestones (product widget: small achievements that make the
 * digital twin feel alive — "first report added", "3-month health history").
 *
 * Purely computed from data the system already owns: reports, verified lab
 * values, and the audit trail (the doctor-summary milestone is unlocked by
 * the audited `summary.doctor_generated` event). Nothing is stored and
 * nothing can be faked by a client — every `achievedAt` points at the real
 * event that earned it.
 *
 * Each definition carries an `icon` KEY (e.g. 'trophy', 'stethoscope') —
 * frontends map keys to their own SVG icon sets; no emojis are shipped.
 */

/** ~3 calendar months, in days (prototype constant). */
export const THREE_MONTHS_DAYS = 92;

export const MILESTONE_DEFS = [
  {
    key: 'first_report_added',
    title: 'First report added',
    description: 'You uploaded your first health report — the twin has its first memory.',
    icon: 'file-up',
    category: 'journey',
  },
  {
    key: 'first_report_verified',
    title: 'First report verified',
    description: 'You reviewed and confirmed extracted values — they now feed trends and risk estimates.',
    icon: 'badge-check',
    category: 'trust',
  },
  {
    key: 'first_health_trend',
    title: 'First health trend detected',
    description: 'A marker now has verified values across two or more reports — change over time is visible.',
    icon: 'trending-up',
    category: 'insight',
  },
  {
    key: 'doctor_summary_generated',
    title: 'Doctor summary generated',
    description: 'A visit-ready summary with trends and discussion points was prepared for your doctor.',
    icon: 'stethoscope',
    category: 'insight',
  },
  {
    key: 'three_month_history',
    title: '3-month health history',
    description: 'Your verified health data now spans three months — the twin can see real history.',
    icon: 'calendar-range',
    category: 'journey',
  },
];

export class MilestoneService {
  constructor({ reportRepository, labResultRepository, auditLogRepository }) {
    this.reports = reportRepository;
    this.labs = labResultRepository;
    this.auditLog = auditLogRepository;
  }

  /**
   * Evaluate every milestone for a member.
   * @returns {{memberId: string, earned: number, total: number, next: object|null, milestones: Array}}
   */
  evaluate(memberId) {
    let firstReport = null;
    let firstVerified = null;
    let firstTrendAt = null;
    let summaryEvent = null;
    let history = { spanDays: 0, crossedAt: null };
    try {
      if (memberId) {
        firstReport = this.reports.earliestForMember(memberId);
        firstVerified = this.reports.firstVerifiedForMember(memberId);
        firstTrendAt = this.firstTrendDetectedAt(memberId);
        summaryEvent = this.auditLog.firstForAction({
          action: 'summary.doctor_generated',
          resourceType: 'member',
          resourceId: memberId,
        });
        history = this.historySpan(memberId);
      }
    } catch {
      /* milestones degrade to locked rather than failing the request */
    }

    const facts = {
      first_report_added: { achieved: !!firstReport, achievedAt: firstReport?.created_at ?? null },
      first_report_verified: { achieved: !!firstVerified, achievedAt: firstVerified?.verified_at ?? null },
      first_health_trend: { achieved: firstTrendAt != null, achievedAt: firstTrendAt },
      doctor_summary_generated: {
        achieved: !!summaryEvent,
        achievedAt: summaryEvent?.created_at ?? null,
      },
      three_month_history: {
        achieved: history.crossedAt != null,
        achievedAt: history.crossedAt,
        progress: history.crossedAt
          ? { daysCovered: history.spanDays, requiredDays: THREE_MONTHS_DAYS }
          : { daysCovered: history.spanDays, requiredDays: THREE_MONTHS_DAYS },
      },
    };

    const milestones = MILESTONE_DEFS.map((def) => ({
      ...def,
      ...(facts[def.key] || { achieved: false, achievedAt: null }),
    }));
    const earned = milestones.filter((m) => m.achieved).length;

    return {
      memberId,
      earned,
      total: milestones.length,
      next: milestones.find((m) => !m.achieved) || null,
      milestones,
    };
  }

  /**
   * A "trend" exists once any marker has verified values in >= 2 reports.
   * The unlock moment is the SECOND point of the earliest such marker.
   */
  firstTrendDetectedAt(memberId) {
    try {
      const codes = this.labs.codesWithVerifiedData(memberId, 2) || [];
      let earliest = null;
      for (const code of codes) {
        try {
          const series = this.labs.seriesForMember(memberId, code) || [];
          if (series.length >= 2) {
            const secondAt = series[1]?.measured_at;
            if (secondAt && (earliest == null || secondAt < earliest)) earliest = secondAt;
          }
        } catch {
          continue;
        }
      }
      return earliest;
    } catch {
      return null;
    }
  }

  /** Span of verified health data + the exact date the 3-month mark was crossed. */
  historySpan(memberId) {
    try {
      const dates = (this.labs.verifiedMeasuredDates(memberId) || []).filter(Boolean);
      if (dates.length === 0) return { spanDays: 0, crossedAt: null };
      const first = dates[0];
      const spanDays = Math.floor(daysBetween(first, dates[dates.length - 1]));
      const crossed = dates.find((d) => daysBetween(first, d) >= THREE_MONTHS_DAYS) || null;
      return { spanDays: Number.isFinite(spanDays) ? Math.max(0, spanDays) : 0, crossedAt: crossed };
    } catch {
      return { spanDays: 0, crossedAt: null };
    }
  }
}
