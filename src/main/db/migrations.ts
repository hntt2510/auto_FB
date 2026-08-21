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
