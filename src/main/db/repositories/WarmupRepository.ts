import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { WarmupConfig, WarmupExecutionLog, WarmupPhase, WarmupProgress, WarmupStatus } from "@shared/types";
import { DEFAULT_WARMUP_CONFIG } from "@shared/types";

type ProgressRow = {
  id: string;
  account_id: string;
  status: string;
  total_duration_seconds: number;
  last_run_at: string | null;
  last_error: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
};

type LogRow = {
  id: string;
  account_id: string;
  run_id: string;
  phase: string;
  action: string;
  detail: string | null;
  duration_ms: number | null;
  ok: number;
  created_at: string;
};

function rowToProgress(row: ProgressRow): WarmupProgress {
  let config: WarmupConfig = { ...DEFAULT_WARMUP_CONFIG };
  try { config = { ...config, ...JSON.parse(row.config_json) }; } catch { /* use defaults */ }
  return {
    id: row.id,
    accountId: row.account_id,
    status: row.status as WarmupStatus,
    totalDurationSeconds: row.total_duration_seconds,
    lastRunAt: row.last_run_at ?? undefined,
    lastError: row.last_error ?? undefined,
    config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLog(row: LogRow): WarmupExecutionLog {
  return {
    id: row.id,
    accountId: row.account_id,
    runId: row.run_id,
    phase: row.phase as WarmupPhase,
    action: row.action,
    detail: row.detail ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    ok: row.ok === 1,
    createdAt: row.created_at,
  };
}

export class WarmupRepository {
  constructor(private readonly db: Database.Database) {}

  get(accountId: string): WarmupProgress | undefined {
    const row = this.db.prepare("SELECT * FROM account_warmup_progress WHERE account_id = ?").get(accountId) as ProgressRow | undefined;
    return row ? rowToProgress(row) : undefined;
  }

  listAll(): WarmupProgress[] {
    const rows = this.db.prepare("SELECT * FROM account_warmup_progress ORDER BY updated_at DESC").all() as ProgressRow[];
    return rows.map(rowToProgress);
  }

  upsert(accountId: string, config: WarmupConfig): WarmupProgress {
    const now = new Date().toISOString();
    const existing = this.get(accountId);
    if (existing) {
      this.db.prepare("UPDATE account_warmup_progress SET config_json = ?, updated_at = ? WHERE account_id = ?").run(JSON.stringify(config), now, accountId);
      return this.get(accountId)!;
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO account_warmup_progress (id, account_id, status, total_duration_seconds, config_json, created_at, updated_at) VALUES (?, ?, 'IDLE', 0, ?, ?, ?)").run(id, accountId, JSON.stringify(config), now, now);
    return this.get(accountId)!;
  }

  setStatus(accountId: string, status: WarmupStatus, lastError?: string): WarmupProgress {
    const now = new Date().toISOString();
    if (!this.get(accountId)) throw new Error("No warmup record for account " + accountId);
    this.db.prepare("UPDATE account_warmup_progress SET status = ?, last_error = ?, last_run_at = CASE WHEN ? = 'RUNNING' THEN ? ELSE last_run_at END, updated_at = ? WHERE account_id = ?").run(status, lastError ?? null, status, now, now, accountId);
    return this.get(accountId)!;
  }

  addDuration(accountId: string, seconds: number): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE account_warmup_progress SET total_duration_seconds = total_duration_seconds + ?, updated_at = ? WHERE account_id = ?").run(Math.max(0, Math.round(seconds)), now, accountId);
  }

  updateConfig(accountId: string, config: Partial<WarmupConfig>): WarmupProgress {
    const existing = this.get(accountId);
    const merged: WarmupConfig = { ...(existing?.config ?? { ...DEFAULT_WARMUP_CONFIG }), ...config };
    return this.upsert(accountId, merged);
  }

  addLog(entry: Omit<WarmupExecutionLog, "id" | "createdAt">): WarmupExecutionLog {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO warmup_execution_logs (id, account_id, run_id, phase, action, detail, duration_ms, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, entry.accountId, entry.runId, entry.phase, entry.action, entry.detail ?? null, entry.durationMs ?? null, entry.ok ? 1 : 0, now);
    return { ...entry, id, createdAt: now };
  }

  getLogs(accountId: string, runId?: string, limit = 100): WarmupExecutionLog[] {
    if (runId) {
      const rows = this.db.prepare("SELECT * FROM warmup_execution_logs WHERE account_id = ? AND run_id = ? ORDER BY created_at LIMIT ?").all(accountId, runId, limit) as LogRow[];
      return rows.map(rowToLog);
    }
    const rows = this.db.prepare("SELECT * FROM warmup_execution_logs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?").all(accountId, limit) as LogRow[];
    return rows.map(rowToLog);
  }
}
