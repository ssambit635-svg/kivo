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
  {
    version: 4,
    name: 'doctor-network-and-subscriptions',
    sql: `
      -- ============================================================
      -- RBAC: roles are granted by the platform, never self-declared.
      -- users.role keeps its legacy meaning (admin vs non-admin); this
      -- table carries the product roles a console is built around.
      -- ============================================================
      CREATE TABLE user_roles (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK (role IN ('patient','doctor','admin')),
        status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
        granted_by TEXT,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (user_id, role)
      );
      CREATE INDEX idx_user_roles_role ON user_roles(role, status);

      -- ============================================================
      -- Doctor identity. A doctor profile is a credential-bound public
      -- identity ("Dr Mohan Charan — bone & joint specialist") with a
      -- mock KYC record. Patient data is NEVER reachable from here:
      -- that requires an explicit consultation consent grant below.
      -- ============================================================
      CREATE TABLE doctor_profiles (
        id                    TEXT PRIMARY KEY,
        user_id               TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        slug                  TEXT NOT NULL UNIQUE,
        full_name             TEXT NOT NULL,
        headline              TEXT NOT NULL,            -- "Bone & joint specialist"
        specialty             TEXT NOT NULL,            -- canonical key from the specialty catalog
        sub_specialties       TEXT NOT NULL DEFAULT '[]',  -- JSON array
        qualifications        TEXT NOT NULL DEFAULT '[]',  -- JSON array
        registration_no       TEXT NOT NULL,
        registration_council  TEXT,
        experience_years      INTEGER NOT NULL DEFAULT 0 CHECK (experience_years BETWEEN 0 AND 70),
        languages             TEXT NOT NULL DEFAULT '[]',  -- JSON array
        clinic_name           TEXT,
        city                  TEXT,
        bio                   TEXT,
        consult_fee_inr       INTEGER NOT NULL DEFAULT 0 CHECK (consult_fee_inr BETWEEN 0 AND 100000),
        status                TEXT NOT NULL DEFAULT 'pending_verification'
                                CHECK (status IN ('pending_verification','active','suspended')),
        -- MOCK verification (hackathon): no real KYC/registry check happens.
        kyc_status            TEXT NOT NULL DEFAULT 'not_started'
                                CHECK (kyc_status IN ('not_started','mock_verified','rejected')),
        kyc_ref               TEXT,
        kyc_verified_at       TEXT,
        identity_card_no      TEXT NOT NULL UNIQUE,     -- MT-DOC-XXXXXXXX
        rating_avg            REAL NOT NULL DEFAULT 0,
        rating_count          INTEGER NOT NULL DEFAULT 0,
        video_count           INTEGER NOT NULL DEFAULT 0,
        consult_count         INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX idx_doctor_status ON doctor_profiles(status, specialty);

      -- ============================================================
      -- Subscription catalog + mock billing. No gateway is contacted:
      -- every payment row is explicitly flagged as mock.
      -- ============================================================
      CREATE TABLE subscription_plans (
        id                        TEXT PRIMARY KEY,
        code                      TEXT NOT NULL UNIQUE,
        name                      TEXT NOT NULL,
        tagline                   TEXT,
        price_inr                 INTEGER NOT NULL CHECK (price_inr >= 0),
        interval                  TEXT NOT NULL CHECK (interval IN ('month','year')),
        consultations_per_month   INTEGER NOT NULL DEFAULT 0,
        video_access              TEXT NOT NULL CHECK (video_access IN ('preview','full')),
        features                  TEXT NOT NULL DEFAULT '[]',   -- JSON array of display strings
        is_active                 INTEGER NOT NULL DEFAULT 1,
        sort_order                INTEGER NOT NULL DEFAULT 0,
        created_at                TEXT NOT NULL,
        updated_at                TEXT NOT NULL
      );

      CREATE TABLE subscriptions (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id            TEXT NOT NULL REFERENCES subscription_plans(id),
        status             TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','expired','cancelled')),
        started_at         TEXT NOT NULL,
        current_period_end TEXT NOT NULL,
        auto_renew         INTEGER NOT NULL DEFAULT 0,
        cancelled_at       TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX idx_subscriptions_user ON subscriptions(user_id, status, current_period_end);

      -- MOCK payment intents. provider is always 'mock-gateway'; no PAN,
      -- no UPI credentials are ever stored — only the chosen method label.
      CREATE TABLE payment_intents (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose         TEXT NOT NULL CHECK (purpose IN ('subscription','consultation')),
        plan_id         TEXT REFERENCES subscription_plans(id),
        consultation_id TEXT,
        amount_inr      INTEGER NOT NULL CHECK (amount_inr >= 0),
        currency        TEXT NOT NULL DEFAULT 'INR',
        provider        TEXT NOT NULL DEFAULT 'mock-gateway',
        provider_ref    TEXT,
        method          TEXT CHECK (method IN ('upi','card','netbanking','wallet') OR method IS NULL),
        status          TEXT NOT NULL DEFAULT 'created'
                          CHECK (status IN ('created','succeeded','failed','refunded')),
        failure_reason  TEXT,
        is_mock         INTEGER NOT NULL DEFAULT 1,
        metadata        TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL,
        completed_at    TEXT
      );
      CREATE INDEX idx_payment_user ON payment_intents(user_id, status, created_at);

      -- Revenue ledger: every paise is attributed (doctor share, video-pool
      -- share, platform fee). Month-period statements are computed from here.
      CREATE TABLE payout_ledger (
        id                    TEXT PRIMARY KEY,
        doctor_id             TEXT REFERENCES doctor_profiles(id) ON DELETE SET NULL,
        payment_intent_id     TEXT REFERENCES payment_intents(id) ON DELETE SET NULL,
        consultation_id       TEXT,
        entry_type            TEXT NOT NULL
                                CHECK (entry_type IN ('consult_share','video_pool_share','video_pool_accrual','consult_pool_accrual','platform_fee')),
        amount_paise          INTEGER NOT NULL,
        period                TEXT NOT NULL,           -- YYYY-MM
        description           TEXT,
        status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
        created_at            TEXT NOT NULL
      );
      CREATE INDEX idx_ledger_doctor_period ON payout_ledger(doctor_id, period);
      CREATE INDEX idx_ledger_period_type ON payout_ledger(period, entry_type);

      -- ============================================================
      -- Async doctor consultation. The patient books, the doctor answers
      -- with the full chart in front of them. Payment is mock.
      -- ============================================================
      CREATE TABLE consultations (
        id                 TEXT PRIMARY KEY,
        member_id          TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        patient_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        doctor_id          TEXT NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
        subject            TEXT NOT NULL,
        question           TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'payment_pending'
                             CHECK (status IN ('payment_pending','requested','in_review','answered','closed','cancelled')),
        fee_inr            INTEGER NOT NULL DEFAULT 0,
        included_in_plan   INTEGER NOT NULL DEFAULT 0,
        payment_intent_id  TEXT REFERENCES payment_intents(id) ON DELETE SET NULL,
        consent_scope      TEXT NOT NULL DEFAULT '[]',   -- JSON array of granted data scopes
        consent_granted_at TEXT,
        consent_expires_at TEXT,
        doctor_reply       TEXT,
        doctor_replied_at  TEXT,
        closed_at          TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX idx_consult_doctor ON consultations(doctor_id, status, created_at);
      CREATE INDEX idx_consult_patient ON consultations(patient_user_id, status, created_at);
      CREATE INDEX idx_consult_member ON consultations(member_id, created_at);

      CREATE TABLE consultation_messages (
        id              TEXT PRIMARY KEY,
        consultation_id TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
        author_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
        author_role     TEXT NOT NULL CHECK (author_role IN ('patient','doctor','system')),
        kind            TEXT NOT NULL
                          CHECK (kind IN ('text','medicine_plan','video_link','care_note','status')),
        body            TEXT NOT NULL,
        metadata        TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_consult_messages ON consultation_messages(consultation_id, created_at);

      -- AI-drafted medicine suggestions for a consultation. They are drafts
      -- ONLY: nothing reaches the patient until a doctor edits/approves and
      -- the acknowledgements are recorded here.
      CREATE TABLE medicine_plans (
        id                TEXT PRIMARY KEY,
        consultation_id   TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
        member_id         TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        doctor_id         TEXT NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
        status            TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','approved','rejected')),
        ai_draft          TEXT NOT NULL DEFAULT '{}',   -- JSON: suggestions + evidence
        final_items       TEXT NOT NULL DEFAULT '[]',   -- JSON: what the doctor actually approved
        doctor_note       TEXT,
        acknowledgements  TEXT NOT NULL DEFAULT '[]',   -- JSON: safety checklist ticked by the doctor
        approved_at       TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX idx_medplans_consult ON medicine_plans(consultation_id);

      -- Scoped, expiring patient-data consent for ONE doctor and ONE member.
      -- Every doctor read of a chart is checked against this table.
      CREATE TABLE doctor_access_grants (
        id              TEXT PRIMARY KEY,
        doctor_id       TEXT NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
        member_id       TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        consultation_id TEXT REFERENCES consultations(id) ON DELETE CASCADE,
        scope           TEXT NOT NULL DEFAULT '[]',   -- JSON array
        granted_by      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        granted_at      TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        revoked_at      TEXT
      );
      CREATE INDEX idx_grants_doctor_member ON doctor_access_grants(doctor_id, member_id, revoked_at);

      -- ============================================================
      -- Short-video library ("Doubt shorts"). media_kind 'upload' stores a
      -- file served through an HMAC-signed, expiring URL; 'note' is a
      -- caption-style short (key points) that needs no binary asset.
      -- ============================================================
      CREATE TABLE doctor_videos (
        id                   TEXT PRIMARY KEY,
        doctor_id            TEXT NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
        title                TEXT NOT NULL,
        summary              TEXT,
        topic                TEXT NOT NULL,
        tags                 TEXT NOT NULL DEFAULT '[]',
        key_points           TEXT NOT NULL DEFAULT '[]',
        duration_sec         INTEGER NOT NULL DEFAULT 45 CHECK (duration_sec BETWEEN 5 AND 600),
        language             TEXT NOT NULL DEFAULT 'en',
        media_kind           TEXT NOT NULL DEFAULT 'note' CHECK (media_kind IN ('note','upload')),
        media_path           TEXT,
        media_mime           TEXT,
        media_bytes          INTEGER,
        is_preview           INTEGER NOT NULL DEFAULT 0,
        status               TEXT NOT NULL DEFAULT 'published'
                               CHECK (status IN ('draft','published','archived')),
        view_count           INTEGER NOT NULL DEFAULT 0,
        watch_seconds_total  INTEGER NOT NULL DEFAULT 0,
        published_at         TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX idx_videos_feed ON doctor_videos(status, topic, published_at);
      CREATE INDEX idx_videos_doctor ON doctor_videos(doctor_id, status);

      -- One row per watch session. Feeds both doctor analytics and the
      -- monthly video-pool payout split (paid per watched second).
      CREATE TABLE video_views (
        id              TEXT PRIMARY KEY,
        video_id        TEXT NOT NULL REFERENCES doctor_videos(id) ON DELETE CASCADE,
        doctor_id       TEXT NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
        user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
        member_id       TEXT REFERENCES members(id) ON DELETE SET NULL,
        seconds_watched INTEGER NOT NULL DEFAULT 0,
        completed       INTEGER NOT NULL DEFAULT 0,
        period          TEXT NOT NULL,     -- YYYY-MM, so payouts never re-scan raw dates
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_views_video ON video_views(video_id, created_at);
      CREATE INDEX idx_views_doctor_period ON video_views(doctor_id, period);
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
