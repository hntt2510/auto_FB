import type Database from 'better-sqlite3';
import type { AccountStatus, FacebookAccount, HealthStatus } from '@shared/types';

type AccountRow = {
  id: string; name: string; profile_name: string; profile_directory: string; proxy_enabled: number;
  proxy_host: string | null; proxy_port: number | null; proxy_username: string | null; proxy_password_key: string | null;
  status: AccountStatus; last_health_status: HealthStatus | null; last_opened_at: string | null;
  last_health_check_at: string | null; last_successful_login_at: string | null; last_error: string | null;
  created_at: string; updated_at: string;
};

function mapAccount(row: AccountRow): FacebookAccount {
  return {
    id: row.id, name: row.name, profileName: row.profile_name, profileDirectory: row.profile_directory,
    proxyEnabled: Boolean(row.proxy_enabled), proxyHost: row.proxy_host ?? undefined, proxyPort: row.proxy_port ?? undefined,
    proxyUsername: row.proxy_username ?? undefined, proxyPasswordKey: row.proxy_password_key ?? undefined,
    status: row.status, lastHealthStatus: row.last_health_status ?? undefined, lastOpenedAt: row.last_opened_at ?? undefined,
    lastHealthCheckAt: row.last_health_check_at ?? undefined, lastSuccessfulLoginAt: row.last_successful_login_at ?? undefined,
    lastError: row.last_error ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export type AccountInsert = Omit<FacebookAccount, 'status' | 'lastHealthStatus' | 'lastOpenedAt' | 'lastHealthCheckAt' | 'lastSuccessfulLoginAt' | 'lastError' | 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string };

export class AccountRepository {
  constructor(private readonly db: Database.Database) {}

  list(): FacebookAccount[] {
    return (this.db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all() as AccountRow[]).map(mapAccount);
  }

  get(id: string): FacebookAccount | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
    return row ? mapAccount(row) : undefined;
  }

  getByProfileName(profileName: string): FacebookAccount | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE profile_name = ?').get(profileName) as AccountRow | undefined;
    return row ? mapAccount(row) : undefined;
  }

  insert(account: AccountInsert): FacebookAccount {
    this.db.prepare(`INSERT INTO accounts
      (id, name, profile_name, profile_directory, proxy_enabled, proxy_host, proxy_port, proxy_username, proxy_password_key, status, created_at, updated_at)
      VALUES (@id, @name, @profileName, @profileDirectory, @proxyEnabled, @proxyHost, @proxyPort, @proxyUsername, @proxyPasswordKey, 'STOPPED', @createdAt, @updatedAt)`)
      .run({
        id: account.id, name: account.name, profileName: account.profileName, profileDirectory: account.profileDirectory,
        proxyEnabled: account.proxyEnabled ? 1 : 0, proxyHost: account.proxyHost ?? null, proxyPort: account.proxyPort ?? null,
        proxyUsername: account.proxyUsername ?? null, proxyPasswordKey: account.proxyPasswordKey ?? null,
        createdAt: account.createdAt, updatedAt: account.updatedAt
      });
    return this.get(account.id)!;
  }

  updateProxyAndName(id: string, fields: { name: string; proxyEnabled: boolean; proxyHost?: string; proxyPort?: number; proxyUsername?: string; proxyPasswordKey?: string }): FacebookAccount {
    this.db.prepare(`UPDATE accounts SET name = @name, proxy_enabled = @proxyEnabled, proxy_host = @proxyHost,
      proxy_port = @proxyPort, proxy_username = @proxyUsername, proxy_password_key = @proxyPasswordKey,
      updated_at = @updatedAt WHERE id = @id`)
      .run({ id, name: fields.name, proxyEnabled: fields.proxyEnabled ? 1 : 0, proxyHost: fields.proxyHost ?? null,
        proxyPort: fields.proxyPort ?? null, proxyUsername: fields.proxyUsername ?? null, proxyPasswordKey: fields.proxyPasswordKey ?? null,
        updatedAt: new Date().toISOString() });
    return this.get(id)!;
  }

  setStatus(id: string, status: AccountStatus, lastError?: string): void {
    this.db.prepare('UPDATE accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, lastError ?? null, new Date().toISOString(), id);
  }

  setOpened(id: string, openedAt: string): void {
    this.db.prepare('UPDATE accounts SET status = ?, last_opened_at = ?, last_error = NULL, updated_at = ? WHERE id = ?').run('RUNNING', openedAt, new Date().toISOString(), id);
  }

  setHealth(id: string, status: HealthStatus, checkedAt: string, reason?: string): void {
    this.db.prepare(`UPDATE accounts SET last_health_status = ?, last_health_check_at = ?, last_error = ?,
      last_successful_login_at = CASE WHEN ? = 'READY' THEN ? ELSE last_successful_login_at END,
      status = CASE WHEN status IN ('STARTING', 'RUNNING') THEN status ELSE 'STOPPED' END, updated_at = ? WHERE id = ?`)
      .run(status, checkedAt, reason ?? null, status, checkedAt, checkedAt, id);
  }

  normalizeRuntimeStatuses(): void {
    this.db.prepare("UPDATE accounts SET status = 'STOPPED', updated_at = ? WHERE status IN ('STARTING', 'RUNNING')").run(new Date().toISOString());
  }

  delete(id: string): void { this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id); }
}
