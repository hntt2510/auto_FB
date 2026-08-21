import type Database from 'better-sqlite3';
import type { AuditLog, LogFilter } from '@shared/types';

type LogRow = { id: string; account_id: string | null; account_name: string | null; event_type: string; message: string; metadata: string | null; created_at: string };

export class AuditLogRepository {
  constructor(private readonly db: Database.Database) {}

  add(entry: Omit<AuditLog, 'id' | 'createdAt' | 'accountName'> & { id?: string; createdAt?: string }): AuditLog {
    const id = entry.id ?? crypto.randomUUID();
    const createdAt = entry.createdAt ?? new Date().toISOString();
    this.db.prepare('INSERT INTO audit_logs (id, account_id, event_type, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, entry.accountId ?? null, entry.eventType, entry.message, entry.metadata ?? null, createdAt);
    return { id, accountId: entry.accountId, eventType: entry.eventType, message: entry.message, metadata: entry.metadata, createdAt };
  }

  list(filter: LogFilter = {}): AuditLog[] {
    const conditions: string[] = [];
    const params: Record<string, string> = {};
    if (filter.accountId) { conditions.push('l.account_id = @accountId'); params.accountId = filter.accountId; }
    if (filter.eventType) { conditions.push('l.event_type = @eventType'); params.eventType = filter.eventType; }
    if (filter.from) { conditions.push('l.created_at >= @from'); params.from = filter.from; }
    if (filter.to) { conditions.push('l.created_at <= @to'); params.to = filter.to; }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT l.*, a.name AS account_name FROM audit_logs l LEFT JOIN accounts a ON a.id = l.account_id ${where} ORDER BY l.created_at DESC LIMIT 1000`).all(params) as LogRow[]).map((row) => ({
      id: row.id, accountId: row.account_id ?? undefined, accountName: row.account_name ?? undefined, eventType: row.event_type,
      message: row.message, metadata: row.metadata ?? undefined, createdAt: row.created_at
    }));
  }
}
