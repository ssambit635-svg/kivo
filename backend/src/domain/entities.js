/** Small row-backed domain entities kept together: Report, LabResult, Observation, RefreshToken, AuditEvent. */

export class Report {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new Report(row) : null;
  }

  get isVerified() {
    return this.status === 'verified';
  }

  toJSON({ includeOcrText = false } = {}) {
    return {
      id: this.id,
      memberId: this.member_id,
      uploadedBy: this.uploaded_by,
      originalName: this.original_name,
      mimeType: this.mime_type,
      status: this.status,
      ocrProvider: this.ocr_provider,
      ocrConfidence: this.ocr_confidence,
      ocrError: this.ocr_error,
      reportDate: this.report_date,
      notes: this.notes,
      createdAt: this.created_at,
      updatedAt: this.updated_at,
      verifiedAt: this.verified_at,
      ...(includeOcrText ? { ocrText: this.ocr_text } : {}),
    };
  }
}

export class LabResult {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new LabResult(row) : null;
  }

  /** Range status using the ranges stored on the row (report's own). */
  statusFromStoredRange() {
    if (this.value == null) return 'unknown';
    if (this.ref_high != null && this.value > this.ref_high) return 'high';
    if (this.ref_low != null && this.value < this.ref_low) return 'low';
    if (this.ref_high != null || this.ref_low != null) return 'normal';
    return 'unknown';
  }

  toJSON() {
    return {
      id: this.id,
      reportId: this.report_id,
      memberId: this.member_id,
      code: this.code,
      testName: this.test_name,
      value: this.value,
      valueText: this.value_text,
      unit: this.unit,
      refLow: this.ref_low,
      refHigh: this.ref_high,
      status: this.statusFromStoredRange(),
      confidence: this.confidence,
      rawLine: this.raw_line,
      measuredAt: this.measured_at,
      verified: !!this.verified,
      // Review aids from the clinical knowledge layer. A flagged row is still a
      // draft: the flag tells the user to look at the raw line, nothing more.
      suspicious: !!this.suspicious,
      suspiciousReason: this.suspicious_reason ?? null,
      loinc: this.loinc ?? null,
      panel: this.panel ?? null,
      rangeSource: this.range_source ?? null,
      heuristicConfidence: this.heuristic_confidence ?? null,
      needsAttention: !this.verified && !!this.suspicious,
      createdAt: this.created_at,
      updatedAt: this.updated_at,
    };
  }
}

export class Observation {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new Observation(row) : null;
  }

  get data() {
    try {
      return JSON.parse(this.payload || '{}');
    } catch {
      return {};
    }
  }

  toJSON() {
    return {
      id: this.id,
      memberId: this.member_id,
      kind: this.kind,
      payload: this.data,
      source: this.source,
      observedAt: this.observed_at,
      createdAt: this.created_at,
    };
  }
}

export class RefreshToken {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new RefreshToken(row) : null;
  }

  get isRevoked() {
    return this.revoked_at != null;
  }

  get isExpired() {
    return new Date(this.expires_at).getTime() <= Date.now();
  }

  get isUsable() {
    return !this.isRevoked && !this.isExpired;
  }
}

export class AuditEvent {
  constructor(row) {
    Object.assign(this, row);
  }

  static fromRow(row) {
    return row ? new AuditEvent(row) : null;
  }

  toJSON() {
    let metadata = {};
    try {
      metadata = JSON.parse(this.metadata || '{}');
    } catch {
      /* keep {} */
    }
    return {
      id: this.id,
      userId: this.user_id,
      action: this.action,
      resourceType: this.resource_type,
      resourceId: this.resource_id,
      outcome: this.outcome,
      ip: this.actor_ip,
      userAgent: this.user_agent,
      metadata,
      createdAt: this.created_at,
    };
  }
}
