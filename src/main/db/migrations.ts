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
