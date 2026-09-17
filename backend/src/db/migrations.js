/**
 * Schema migrations. Idempotent and ordered. New migrations are appended
 * with increasing version numbers; we track applied versions in
 * schema_migrations so existing databases upgrade cleanly.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'core-schema',
    sql: `
      CREATE TABLE users (
        id                     TEXT PRIMARY KEY,
        email                  TEXT NOT NULL UNIQUE,
        display_name           TEXT NOT NULL,
        password_hash          TEXT NOT NULL,
        role                   TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
        status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
        failed_login_attempts  INTEGER NOT NULL DEFAULT 0,
        lockout_until          TEXT,
        token_version          INTEGER NOT NULL DEFAULT 1,
        last_login_at          TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );

      CREATE TABLE refresh_tokens (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash       TEXT NOT NULL UNIQUE,
        family_id        TEXT NOT NULL,
        device_label     TEXT,
        created_at       TEXT NOT NULL,
        expires_at       TEXT NOT NULL,
        revoked_at       TEXT,
        replaced_by      TEXT,
        last_used_at     TEXT,
        ip               TEXT,
        user_agent       TEXT
      );
      CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);
      CREATE INDEX idx_refresh_family ON refresh_tokens(family_id);

      -- A member belongs to exactly one owner account. Sharing to other
      -- accounts happens through member_shares (least-privilege grants).
      CREATE TABLE members (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name                TEXT NOT NULL,
        relationship        TEXT NOT NULL DEFAULT 'other',
        dob                 TEXT,
        sex                 TEXT CHECK (sex IN ('male','female','other') OR sex IS NULL),
        height_cm           REAL,
        family_history      TEXT NOT NULL DEFAULT '{}', -- JSON
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX idx_members_user ON members(user_id);

      CREATE TABLE member_shares (
        member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission    TEXT NOT NULL CHECK (permission IN ('viewer','editor')),
        created_at    TEXT NOT NULL,
        PRIMARY KEY (member_id, user_id)
      );
      CREATE INDEX idx_shares_user ON member_shares(user_id);

      CREATE TABLE reports (
        id               TEXT PRIMARY KEY,
        member_id        TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        uploaded_by      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        original_name    TEXT,
        mime_type        TEXT,
        storage_path     TEXT,
        status           TEXT NOT NULL DEFAULT 'uploaded'
                           CHECK (status IN ('uploaded','ocr_failed','needs_review','verified')),
        ocr_text         TEXT,
        ocr_provider     TEXT,
        ocr_confidence   REAL,
        ocr_error        TEXT,
        report_date      TEXT,
        notes            TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        verified_at      TEXT
      );
      CREATE INDEX idx_reports_member ON reports(member_id);

      -- One row per laboratory measurement belonging to a report.
      -- verified=0 rows NEVER participate in trends/risk — the scan→verify
      -- safety rule from the product spec is enforced in queries, not in memory.
      CREATE TABLE lab_results (
        id            TEXT PRIMARY KEY,
        report_id     TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        code          TEXT NOT NULL,          -- canonical marker code, e.g. 'hba1c'
        test_name     TEXT NOT NULL,          -- human-readable name
        value         REAL,
        value_text    TEXT,
        unit          TEXT,
        ref_low       REAL,
        ref_high      REAL,
        confidence    REAL,
        raw_line      TEXT,
        measured_at   TEXT NOT NULL,
        verified      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_labs_report ON lab_results(report_id);
      CREATE INDEX idx_labs_member_code ON lab_results(member_id, code, measured_at);

      CREATE TABLE observations (
        id           TEXT PRIMARY KEY,
        member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        created_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,           -- weight | bp | activity | sleep | symptom | note | medication
        payload      TEXT NOT NULL,           -- JSON
        source       TEXT NOT NULL DEFAULT 'manual',
        observed_at  TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_obs_member ON observations(member_id, kind, observed_at);

      CREATE TABLE audit_log (
        id            TEXT PRIMARY KEY,
        user_id       TEXT,
        actor_ip      TEXT,
        user_agent    TEXT,
        action        TEXT NOT NULL,
        resource_type TEXT,
        resource_id   TEXT,
        outcome       TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','failure')),
        metadata      TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_audit_user ON audit_log(user_id, created_at);
      CREATE INDEX idx_audit_action ON audit_log(action, created_at);
    `,
  },
  {
    version: 2,
    name: 'lab-review-signals',
    sql: `
      -- Signals produced by the clinical knowledge layer when a report is read:
      -- whether the value is physically implausible (usually an OCR misread),
      -- and the marker's LOINC identity + panel for grouping in the UI. They are
      -- review aids on a DRAFT row: nothing here changes trend/risk inputs, which
      -- still read verified rows only.
      ALTER TABLE lab_results ADD COLUMN suspicious INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE lab_results ADD COLUMN suspicious_reason TEXT;
      ALTER TABLE lab_results ADD COLUMN loinc TEXT;
      ALTER TABLE lab_results ADD COLUMN panel TEXT;
      ALTER TABLE lab_results ADD COLUMN heuristic_confidence REAL;
      ALTER TABLE lab_results ADD COLUMN range_source TEXT;
    `,
  },
  {
    version: 3,
    name: 'reminders-and-consent',
    sql: `
      -- Health reminders (§10.6 / §13 of the product spec): medication,
      -- check-up, follow-up and report-upload nudges. Owned by the member's
      -- data (cascade on member delete); the /due query powers in-app and
      -- notification-style prompts without any external push service.
      CREATE TABLE reminders (
        id                   TEXT PRIMARY KEY,
        member_id            TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        created_by           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind                 TEXT NOT NULL,
        title                TEXT NOT NULL,
        notes                TEXT,
        due_at               TEXT NOT NULL,
        repeat_interval_days INTEGER,
        status               TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','done','dismissed')),
        snoozed_until        TEXT,
        completed_at         TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX idx_reminders_member ON reminders(member_id, status, due_at);

      -- Explicit processing consent (§14): recorded at registration, travels
      -- with the data export, and is shown on the profile.
      ALTER TABLE users ADD COLUMN consented_at TEXT;
      ALTER TABLE users ADD COLUMN consent_version TEXT;
      UPDATE users SET consented_at = created_at, consent_version = '1.0'
        WHERE consented_at IS NULL;
    `,
  },
];

export function runMigrations(database) {
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    database.all('SELECT version FROM schema_migrations').map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    database.transaction(() => {
      database.exec(m.sql);
      database.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        m.version,
        m.name,
        new Date().toISOString(),
      );
    });
  }
}
