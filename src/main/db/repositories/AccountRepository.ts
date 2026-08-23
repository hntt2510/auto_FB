import type Database from 'better-sqlite3';
import type { AccountOperationsSummary, AccountStatus, FacebookAccount, HealthStatus, OperationalHealthStatus, PublishingBlock } from '@shared/types';

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

  hasActiveQueueItems(id: string): boolean {
    const row = this.db.prepare("SELECT 1 AS present FROM queue_items WHERE account_id = ? AND status IN ('PENDING', 'PAUSED', 'RUNNING', 'NEEDS_ATTENTION') LIMIT 1").get(id) as { present: number } | undefined;
    return Boolean(row);
  }

  operations(): AccountOperationsSummary[] {
    type Row = AccountRow & { block_reason: PublishingBlock['reason'] | null; block_message: string | null; blocked_at: string | null; last_success: string | null; last_failure: string | null; pending_queue: number; due_queue: number; needs_attention: number };
    const now = new Date().toISOString();
    const rows = this.db.prepare(`SELECT a.*, b.reason AS block_reason, b.message AS block_message, b.blocked_at,
      (SELECT MAX(completed_at) FROM queue_items q WHERE q.account_id = a.id AND q.status = 'SUCCEEDED') AS last_success,
      (SELECT MAX(COALESCE(completed_at, updated_at)) FROM queue_items q WHERE q.account_id = a.id AND q.status IN ('FAILED','NEEDS_ATTENTION')) AS last_failure,
      (SELECT COUNT(*) FROM queue_items q WHERE q.account_id = a.id AND q.status IN ('PENDING','PAUSED')) AS pending_queue,
      (SELECT COUNT(*) FROM queue_items q WHERE q.account_id = a.id AND q.status = 'PENDING' AND q.scheduled_at IS NOT NULL AND q.scheduled_at <= ?) AS due_queue,
      (SELECT COUNT(*) FROM queue_items q WHERE q.account_id = a.id AND q.status = 'NEEDS_ATTENTION') AS needs_attention
      FROM accounts a LEFT JOIN account_publish_blocks b ON b.account_id = a.id ORDER BY a.created_at`).all(now) as Row[];
    return rows.map((row) => {
      const facebookSession: OperationalHealthStatus = row.block_reason ? 'BLOCKED' : row.last_health_status === 'READY' ? 'READY' : row.last_health_status === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : row.last_health_status === 'CHECKPOINT' ? 'CHECKPOINT' : row.last_error?.toLowerCase().includes('proxy') ? 'PROXY_ERROR' : row.status === 'ERROR' || row.last_health_status === 'ERROR' ? 'BROWSER_ERROR' : 'UNKNOWN';
      return { accountId: row.id, accountName: row.name, browser: row.status, facebookSession, publishingBlock: row.block_reason ? { accountId: row.id, accountName: row.name, reason: row.block_reason, message: row.block_message!, blockedAt: row.blocked_at! } : undefined, proxyConfigured: Boolean(row.proxy_enabled), lastSuccessfulPublish: row.last_success ?? undefined, lastFailure: row.last_failure ?? undefined, pendingQueue: row.pending_queue, dueQueue: row.due_queue, needsAttention: row.needs_attention };
    });
  }

  delete(id: string): void { this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id); }
}
