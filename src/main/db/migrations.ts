import type Database from 'better-sqlite3';

export const LATEST_SCHEMA_VERSION = 8;

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set<number>((db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((row) => row.version));
  // Commit 839cf21 introduced schema 8 exclusively for the reverted Warmup
  // Engine. Clean up those isolated tables only if the new Campaign Workspace
  // migration 8 hasn't been applied yet.
  const hasCampaignsTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='campaigns'").get());
  if (applied.has(8) && !hasCampaignsTable) {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS warmup_execution_logs; DROP TABLE IF EXISTS account_warmup_progress;');
      db.prepare('DELETE FROM schema_migrations WHERE version = 8').run();
    })();
    applied.delete(8);
  }
  const migrations: Array<[number, string]> = [
    [1, `
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        profile_name TEXT NOT NULL UNIQUE,
        profile_directory TEXT NOT NULL UNIQUE,
        proxy_enabled INTEGER NOT NULL DEFAULT 0 CHECK (proxy_enabled IN (0, 1)),
        proxy_host TEXT,
        proxy_port INTEGER,
        proxy_username TEXT,
        proxy_password_key TEXT,
        status TEXT NOT NULL DEFAULT 'STOPPED',
        last_health_status TEXT,
        last_opened_at TEXT,
        last_health_check_at TEXT,
        last_successful_login_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_updated_at ON accounts(updated_at);
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_account_id ON audit_logs(account_id);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `],
    [2, `
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        normalized_url TEXT NOT NULL UNIQUE,
        facebook_group_id TEXT,
        notes TEXT,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_groups_active_updated ON groups(active, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS group_tags (
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (group_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_group_tags_tag ON group_tags(tag, group_id);
      CREATE TABLE IF NOT EXISTS account_groups (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_account_groups_group ON account_groups(group_id, enabled);
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        link_url TEXT,
        status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'READY', 'ARCHIVED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_status_updated ON drafts(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_drafts_title ON drafts(title COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS media_assets (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('IMAGE', 'VIDEO')),
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL UNIQUE,
        local_path TEXT NOT NULL UNIQUE,
        mime_type TEXT,
        file_size INTEGER NOT NULL CHECK (file_size >= 0),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS draft_media (
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
        sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (draft_id, media_id),
        UNIQUE (draft_id, sort_order)
      );
      CREATE INDEX IF NOT EXISTS idx_draft_media_media ON draft_media(media_id);
      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY,
        draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        draft_title_snapshot TEXT NOT NULL,
        body_snapshot TEXT NOT NULL,
        link_url_snapshot TEXT,
        account_name_snapshot TEXT NOT NULL,
        group_name_snapshot TEXT NOT NULL,
        group_url_snapshot TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAUSED', 'CANCELLED')),
        scheduled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_queue_status_scheduled ON queue_items(status, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_queue_account_group ON queue_items(account_id, group_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_active_duplicate ON queue_items(draft_id, snapshot_hash, account_id, group_id, IFNULL(scheduled_at, '')) WHERE status IN ('PENDING', 'PAUSED');
      CREATE TABLE IF NOT EXISTS queue_item_media (
        queue_item_id TEXT NOT NULL REFERENCES queue_items(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
        type TEXT NOT NULL CHECK (type IN ('IMAGE', 'VIDEO')),
        original_name TEXT NOT NULL,
        mime_type TEXT,
        file_size INTEGER NOT NULL CHECK (file_size >= 0),
        sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
        PRIMARY KEY (queue_item_id, media_id),
        UNIQUE (queue_item_id, sort_order)
      );
      CREATE INDEX IF NOT EXISTS idx_queue_item_media_asset ON queue_item_media(media_id);
    `],
    [3, `
      PRAGMA defer_foreign_keys = ON;
      DROP INDEX IF EXISTS idx_queue_status_scheduled;
      DROP INDEX IF EXISTS idx_queue_account_group;
      DROP INDEX IF EXISTS idx_queue_active_duplicate;
      DROP INDEX IF EXISTS idx_queue_item_media_asset;
      ALTER TABLE queue_item_media RENAME TO queue_item_media_v2;
      ALTER TABLE queue_items RENAME TO queue_items_v2;

      CREATE TABLE queue_items (
        id TEXT PRIMARY KEY,
        draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        draft_title_snapshot TEXT NOT NULL,
        body_snapshot TEXT NOT NULL,
        link_url_snapshot TEXT,
        account_name_snapshot TEXT NOT NULL,
        group_name_snapshot TEXT NOT NULL,
        group_url_snapshot TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAUSED', 'RUNNING', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION', 'CANCELLED')),
        scheduled_at TEXT,
        execution_token TEXT,
        lease_started_at TEXT,
        attention_reason TEXT,
        submitted_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO queue_items (id, draft_id, account_id, group_id, draft_title_snapshot, body_snapshot, link_url_snapshot, account_name_snapshot, group_name_snapshot, group_url_snapshot, snapshot_hash, status, scheduled_at, created_at, updated_at)
        SELECT id, draft_id, account_id, group_id, draft_title_snapshot, body_snapshot, link_url_snapshot, account_name_snapshot, group_name_snapshot, group_url_snapshot, snapshot_hash, status, scheduled_at, created_at, updated_at FROM queue_items_v2;

      CREATE TABLE queue_item_media (
        queue_item_id TEXT NOT NULL REFERENCES queue_items(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
        type TEXT NOT NULL CHECK (type IN ('IMAGE', 'VIDEO')),
        original_name TEXT NOT NULL,
        mime_type TEXT,
        file_size INTEGER NOT NULL CHECK (file_size >= 0),
        sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
        PRIMARY KEY (queue_item_id, media_id),
        UNIQUE (queue_item_id, sort_order)
      );
      INSERT INTO queue_item_media SELECT * FROM queue_item_media_v2;
      DROP TABLE queue_item_media_v2;
      DROP TABLE queue_items_v2;

      CREATE INDEX idx_queue_status_scheduled ON queue_items(status, scheduled_at);
      CREATE INDEX idx_queue_account_status ON queue_items(account_id, status, scheduled_at);
      CREATE INDEX idx_queue_account_group ON queue_items(account_id, group_id, created_at DESC);
      CREATE UNIQUE INDEX idx_queue_active_duplicate ON queue_items(draft_id, snapshot_hash, account_id, group_id, IFNULL(scheduled_at, ''))
        WHERE status IN ('PENDING', 'PAUSED', 'RUNNING', 'SUBMITTED', 'NEEDS_ATTENTION');
      CREATE INDEX idx_queue_item_media_asset ON queue_item_media(media_id);

      CREATE TABLE publish_attempts (
        id TEXT PRIMARY KEY,
        queue_item_id TEXT NOT NULL REFERENCES queue_items(id) ON DELETE CASCADE,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
        status TEXT NOT NULL CHECK (status IN ('STARTING', 'COMPOSER_OPENED', 'CONTENT_FILLED', 'MEDIA_UPLOADED', 'SUBMITTING', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION')),
        error_code TEXT,
        error_message TEXT,
        diagnostic_path TEXT,
        diagnostic_created_at TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (queue_item_id, attempt_number)
      );
      CREATE INDEX idx_publish_attempts_queue ON publish_attempts(queue_item_id, attempt_number DESC);
      CREATE INDEX idx_publish_attempts_started ON publish_attempts(started_at DESC);
      CREATE INDEX idx_publish_attempts_status ON publish_attempts(status, started_at DESC);

      CREATE TABLE publish_attempt_events (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES publish_attempts(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        event_type TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (attempt_id, sequence)
      );
      CREATE INDEX idx_publish_attempt_events_attempt ON publish_attempt_events(attempt_id, sequence);

      CREATE TABLE publish_receipts (
        id TEXT PRIMARY KEY,
        queue_item_id TEXT NOT NULL REFERENCES queue_items(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES publish_attempts(id) ON DELETE CASCADE,
        result TEXT NOT NULL CHECK (result IN ('SUBMITTED', 'SUBMITTED_PENDING_APPROVAL', 'VERIFIED_PUBLISHED', 'UNKNOWN')),
        group_url TEXT NOT NULL,
        post_url TEXT,
        evidence TEXT,
        submitted_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_publish_receipts_queue ON publish_receipts(queue_item_id, submitted_at DESC);

      CREATE TABLE account_publish_blocks (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK (reason IN ('LOGIN_REQUIRED', 'CHECKPOINT')),
        message TEXT NOT NULL,
        blocked_at TEXT NOT NULL
      );
      CREATE INDEX idx_account_publish_blocks_reason ON account_publish_blocks(reason, blocked_at DESC);
    `],
    [4, `
      ALTER TABLE publish_attempts ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'LIVE' CHECK (execution_mode IN ('DRY_RUN', 'LIVE'));
      ALTER TABLE publish_attempts ADD COLUMN selector_version TEXT;
      ALTER TABLE publish_attempts ADD COLUMN preflight INTEGER NOT NULL DEFAULT 0 CHECK (preflight IN (0, 1));
      ALTER TABLE publish_receipts ADD COLUMN verification_source TEXT NOT NULL DEFAULT 'AUTOMATED' CHECK (verification_source IN ('AUTOMATED', 'OPERATOR'));
      ALTER TABLE publish_receipts ADD COLUMN verification_evidence TEXT;
      ALTER TABLE publish_receipts ADD COLUMN verified_at TEXT;

      DROP INDEX IF EXISTS idx_queue_active_duplicate;
      CREATE UNIQUE INDEX idx_queue_active_duplicate ON queue_items(draft_id, snapshot_hash, account_id, group_id, IFNULL(scheduled_at, ''))
        WHERE status IN ('PENDING', 'PAUSED', 'RUNNING', 'NEEDS_ATTENTION');

      CREATE TABLE publish_reconciliations (
        id TEXT PRIMARY KEY,
        queue_item_id TEXT NOT NULL REFERENCES queue_items(id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES publish_attempts(id) ON DELETE SET NULL,
        action TEXT NOT NULL CHECK (action IN ('MARK_SUBMITTED', 'MARK_VERIFIED')),
        evidence TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_publish_reconciliations_queue ON publish_reconciliations(queue_item_id, created_at DESC);

      CREATE TABLE selector_probes (
        id TEXT PRIMARY KEY,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        selector_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('FOUND', 'MISSING', 'AMBIGUOUS', 'NOT_TESTED')),
        details_json TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_selector_probes_target ON selector_probes(account_id, group_id, checked_at DESC);

      CREATE TABLE publish_preflights (
        id TEXT PRIMARY KEY,
        queue_item_id TEXT REFERENCES queue_items(id) ON DELETE SET NULL,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('DRY_RUN', 'LIVE')),
        selector_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'AMBIGUOUS')),
        details_json TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_publish_preflights_queue ON publish_preflights(queue_item_id, checked_at DESC);
    `],
    [5, `
      ALTER TABLE accounts ADD COLUMN proxy_protocol TEXT NOT NULL DEFAULT 'HTTP' CHECK (proxy_protocol IN ('HTTP', 'HTTPS', 'SOCKS5'));
      ALTER TABLE accounts ADD COLUMN proxy_status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (proxy_status IN ('NOT_CONFIGURED', 'UNTESTED', 'WORKING', 'FAILED'));
      ALTER TABLE accounts ADD COLUMN last_proxy_test_at TEXT;
      ALTER TABLE accounts ADD COLUMN last_proxy_test_ip TEXT;
      ALTER TABLE accounts ADD COLUMN last_proxy_latency_ms INTEGER CHECK (last_proxy_latency_ms IS NULL OR last_proxy_latency_ms >= 0);
      ALTER TABLE accounts ADD COLUMN last_proxy_error TEXT;
      UPDATE accounts SET proxy_status = CASE WHEN proxy_enabled = 1 THEN 'UNTESTED' ELSE 'NOT_CONFIGURED' END;
      CREATE INDEX idx_accounts_proxy_status ON accounts(proxy_status, last_proxy_test_at DESC);
    `],
    [6, `
      ALTER TABLE accounts ADD COLUMN onboarding_status TEXT NOT NULL DEFAULT 'NEW' CHECK (onboarding_status IN ('NEW', 'WARMING', 'READY', 'PAUSED'));
      ALTER TABLE accounts ADD COLUMN onboarding_started_at TEXT;
      ALTER TABLE accounts ADD COLUMN onboarding_plan_days INTEGER CHECK (onboarding_plan_days IS NULL OR onboarding_plan_days BETWEEN 1 AND 30);
      ALTER TABLE accounts ADD COLUMN onboarding_paused_reason TEXT;
      ALTER TABLE accounts ADD COLUMN onboarding_paused_from TEXT CHECK (onboarding_paused_from IS NULL OR onboarding_paused_from IN ('WARMING', 'READY'));
      ALTER TABLE accounts ADD COLUMN onboarding_notes TEXT;
      ALTER TABLE accounts ADD COLUMN last_manual_session_at TEXT;
      CREATE INDEX idx_accounts_onboarding_status ON accounts(onboarding_status, onboarding_started_at);

      CREATE TABLE account_onboarding_tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        day_number INTEGER NOT NULL CHECK (day_number BETWEEN 1 AND 30),
        sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
        task_type TEXT NOT NULL CHECK (task_type IN ('MANUAL_TASK', 'OPEN_FACEBOOK', 'OPEN_GROUP', 'HEALTH_CHECK')),
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE', 'SKIPPED')),
        completed_at TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (account_id, day_number, sort_order)
      );
      CREATE INDEX idx_onboarding_tasks_account_day ON account_onboarding_tasks(account_id, day_number, status, sort_order);
      CREATE INDEX idx_onboarding_tasks_completed ON account_onboarding_tasks(completed_at DESC);

      CREATE TABLE manual_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0)
      );
      CREATE INDEX idx_manual_sessions_account ON manual_sessions(account_id, started_at DESC);
      CREATE UNIQUE INDEX idx_manual_sessions_one_active ON manual_sessions(account_id) WHERE ended_at IS NULL;
    `],
    [7, `
      CREATE TABLE account_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        onboarding_day INTEGER NOT NULL CHECK (onboarding_day BETWEEN 1 AND 30),
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'INTERRUPTED')),
        target_duration_seconds INTEGER NOT NULL CHECK (target_duration_seconds BETWEEN 600 AND 3600),
        started_at TEXT NOT NULL,
        active_started_at TEXT,
        ended_at TEXT,
        duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
        completion_reason TEXT,
        ending_health_status TEXT CHECK (ending_health_status IS NULL OR ending_health_status IN ('READY', 'LOGIN_REQUIRED', 'CHECKPOINT', 'ERROR')),
        operator_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_account_sessions_account_started ON account_sessions(account_id, started_at DESC);
      CREATE INDEX idx_account_sessions_status_started ON account_sessions(status, started_at DESC);
      CREATE INDEX idx_account_sessions_day ON account_sessions(account_id, onboarding_day, status);
      CREATE UNIQUE INDEX idx_account_sessions_one_open ON account_sessions(account_id) WHERE status IN ('ACTIVE', 'PAUSED');
    `],
    [8, `
      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'QUEUED', 'ARCHIVED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_campaigns_status ON campaigns(status, updated_at DESC);

      CREATE TABLE campaign_variants (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE RESTRICT,
        label TEXT NOT NULL,
        sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        approved_snapshot_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_campaign_variants_campaign ON campaign_variants(campaign_id, sort_order ASC);
      CREATE INDEX idx_campaign_variants_draft ON campaign_variants(draft_id);

      CREATE TABLE campaign_plan_items (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        variant_id TEXT NOT NULL REFERENCES campaign_variants(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        scheduled_at TEXT,
        sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_campaign_plan_items_campaign ON campaign_plan_items(campaign_id, sort_order ASC);
      CREATE INDEX idx_campaign_plan_items_target ON campaign_plan_items(account_id, group_id);
      CREATE INDEX idx_campaign_plan_items_variant ON campaign_plan_items(variant_id);

      ALTER TABLE queue_items ADD COLUMN campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL;
      ALTER TABLE queue_items ADD COLUMN campaign_variant_id TEXT REFERENCES campaign_variants(id) ON DELETE SET NULL;
      CREATE INDEX idx_queue_items_campaign ON queue_items(campaign_id, campaign_variant_id);
    `]
  ];

  const insert = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  for (const [version, sql] of migrations) {
    if (applied.has(version)) continue;
    db.transaction(() => {
      db.exec(sql);
      insert.run(version, new Date().toISOString());
    })();
  }
}
