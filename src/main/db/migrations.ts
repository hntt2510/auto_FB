import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set<number>((db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((row) => row.version));
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
