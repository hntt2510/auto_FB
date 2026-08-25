import type Database from 'better-sqlite3';
import type { ManualSession, OnboardingStatus, WarmUpTask, WarmUpTaskStatus, WarmUpTaskType } from '@shared/types';

type TaskRow = { id: string; account_id: string; day_number: number; sort_order: number; task_type: WarmUpTaskType; group_id: string | null; group_name: string | null; title: string; description: string; status: WarmUpTaskStatus; completed_at: string | null; note: string | null; created_at: string; updated_at: string };
type SessionRow = { id: string; account_id: string; started_at: string; ended_at: string | null; duration_seconds: number | null };
export type OnboardingState = { status: OnboardingStatus; startedAt?: string; planDays?: number; pausedReason?: string; pausedFrom?: 'WARMING' | 'READY'; notes?: string; lastManualSessionAt?: string };
export type NewWarmUpTask = { id: string; accountId: string; dayNumber: number; sortOrder: number; type: WarmUpTaskType; title: string; description: string };

export class OnboardingRepository {
  constructor(private readonly db: Database.Database) {}

  state(accountId: string): OnboardingState | undefined {
    const row = this.db.prepare('SELECT onboarding_status, onboarding_started_at, onboarding_plan_days, onboarding_paused_reason, onboarding_paused_from, onboarding_notes, last_manual_session_at FROM accounts WHERE id = ?').get(accountId) as { onboarding_status: OnboardingStatus; onboarding_started_at: string | null; onboarding_plan_days: number | null; onboarding_paused_reason: string | null; onboarding_paused_from: 'WARMING' | 'READY' | null; onboarding_notes: string | null; last_manual_session_at: string | null } | undefined;
    return row ? { status: row.onboarding_status, startedAt: row.onboarding_started_at ?? undefined, planDays: row.onboarding_plan_days ?? undefined, pausedReason: row.onboarding_paused_reason ?? undefined, pausedFrom: row.onboarding_paused_from ?? undefined, notes: row.onboarding_notes ?? undefined, lastManualSessionAt: row.last_manual_session_at ?? undefined } : undefined;
  }

  startPlan(accountId: string, days: number, tasks: NewWarmUpTask[], timestamp: string): void {
    this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE accounts SET onboarding_status = 'WARMING', onboarding_started_at = ?, onboarding_plan_days = ?, onboarding_paused_reason = NULL, onboarding_paused_from = NULL, updated_at = ? WHERE id = ? AND onboarding_status = 'NEW'").run(timestamp, days, timestamp, accountId);
      if (!changed.changes) throw new Error('Account onboarding must be NEW before a plan starts.');
      this.db.prepare('DELETE FROM account_onboarding_tasks WHERE account_id = ?').run(accountId);
      const insert = this.db.prepare(`INSERT INTO account_onboarding_tasks (id, account_id, day_number, sort_order, task_type, title, description, status, created_at, updated_at) VALUES (@id, @accountId, @dayNumber, @sortOrder, @type, @title, @description, 'PENDING', @timestamp, @timestamp)`);
      for (const task of tasks) insert.run({ ...task, timestamp });
    })();
  }

  pause(accountId: string, reason: string, timestamp: string): boolean {
    return Boolean(this.db.prepare("UPDATE accounts SET onboarding_paused_from = onboarding_status, onboarding_status = 'PAUSED', onboarding_paused_reason = ?, updated_at = ? WHERE id = ? AND onboarding_status IN ('WARMING', 'READY')").run(reason, timestamp, accountId).changes);
  }

  resume(accountId: string, timestamp: string): boolean {
    return Boolean(this.db.prepare("UPDATE accounts SET onboarding_status = COALESCE(onboarding_paused_from, 'WARMING'), onboarding_paused_reason = NULL, onboarding_paused_from = NULL, updated_at = ? WHERE id = ? AND onboarding_status = 'PAUSED'").run(timestamp, accountId).changes);
  }

  markReady(accountId: string, timestamp: string): boolean {
    return Boolean(this.db.prepare("UPDATE accounts SET onboarding_status = 'READY', onboarding_paused_reason = NULL, onboarding_paused_from = NULL, updated_at = ? WHERE id = ? AND onboarding_status = 'WARMING'").run(timestamp, accountId).changes);
  }

  updateNotes(accountId: string, notes: string, timestamp: string): boolean { return Boolean(this.db.prepare('UPDATE accounts SET onboarding_notes = ?, updated_at = ? WHERE id = ?').run(notes || null, timestamp, accountId).changes); }

  tasks(accountId: string): WarmUpTask[] { return (this.db.prepare('SELECT t.*, g.name AS group_name FROM account_onboarding_tasks t LEFT JOIN groups g ON g.id = t.group_id WHERE t.account_id = ? ORDER BY t.day_number, t.sort_order').all(accountId) as TaskRow[]).map(mapTask); }
  task(id: string): WarmUpTask | undefined { const row = this.db.prepare('SELECT t.*, g.name AS group_name FROM account_onboarding_tasks t LEFT JOIN groups g ON g.id = t.group_id WHERE t.id = ?').get(id) as TaskRow | undefined; return row ? mapTask(row) : undefined; }
  updateTask(id: string, title: string, description: string, groupId: string | undefined, timestamp: string): WarmUpTask | undefined { this.db.prepare('UPDATE account_onboarding_tasks SET title = ?, description = ?, group_id = ?, updated_at = ? WHERE id = ?').run(title, description, groupId ?? null, timestamp, id); return this.task(id); }
  setTaskStatus(id: string, status: WarmUpTaskStatus, note: string | undefined, timestamp: string): WarmUpTask | undefined { this.db.prepare("UPDATE account_onboarding_tasks SET status = ?, completed_at = CASE WHEN ? = 'PENDING' THEN NULL ELSE ? END, note = ?, updated_at = ? WHERE id = ?").run(status, status, timestamp, note ?? null, timestamp, id); return this.task(id); }
  completeSystemTasks(accountId: string, dayNumber: number, types: WarmUpTaskType[], timestamp: string): number {
    if (!types.length) return 0;
    const placeholders = types.map(() => '?').join(', ');
    return this.db.prepare(`UPDATE account_onboarding_tasks SET status = 'DONE', completed_at = ?, note = 'Completed from an observable local session event.', updated_at = ? WHERE account_id = ? AND day_number = ? AND status = 'PENDING' AND task_type IN (${placeholders})`).run(timestamp, timestamp, accountId, dayNumber, ...types).changes;
  }
  completeDailySessionTask(accountId: string, dayNumber: number, timestamp: string): number {
    return this.db.prepare("UPDATE account_onboarding_tasks SET status = 'DONE', completed_at = ?, note = 'Daily account session target reached.', updated_at = ? WHERE account_id = ? AND day_number = ? AND status = 'PENDING' AND task_type = 'MANUAL_TASK' AND lower(title) LIKE '%session%'").run(timestamp, timestamp, accountId, dayNumber).changes;
  }
  recordSessionEnd(accountId: string, timestamp: string): void { this.db.prepare('UPDATE accounts SET last_manual_session_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, accountId); }

  sessions(accountId: string, limit = 20): ManualSession[] { return (this.db.prepare('SELECT * FROM manual_sessions WHERE account_id = ? ORDER BY started_at DESC LIMIT ?').all(accountId, limit) as SessionRow[]).map(mapSession); }
  activeSession(accountId: string): ManualSession | undefined { const row = this.db.prepare('SELECT * FROM manual_sessions WHERE account_id = ? AND ended_at IS NULL').get(accountId) as SessionRow | undefined; return row ? mapSession(row) : undefined; }
  startSession(id: string, accountId: string, timestamp: string): ManualSession { this.db.prepare('INSERT INTO manual_sessions (id, account_id, started_at) VALUES (?, ?, ?)').run(id, accountId, timestamp); return this.activeSession(accountId)!; }
  stopSession(accountId: string, timestamp: string): ManualSession | undefined {
    return this.db.transaction(() => {
      const active = this.activeSession(accountId); if (!active) return undefined;
      const duration = Math.max(0, Math.floor((Date.parse(timestamp) - Date.parse(active.startedAt)) / 1000));
      this.db.prepare('UPDATE manual_sessions SET ended_at = ?, duration_seconds = ? WHERE id = ? AND ended_at IS NULL').run(timestamp, duration, active.id);
      this.db.prepare('UPDATE accounts SET last_manual_session_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, accountId);
      return this.sessions(accountId, 1)[0];
    })();
  }
}

export function onboardingDay(startedAt?: string, planDays?: number, now = new Date()): number | undefined { if (!startedAt || !planDays) return undefined; const elapsed = Math.max(0, now.getTime() - Date.parse(startedAt)); return Math.min(planDays, Math.floor(elapsed / 86_400_000) + 1); }
function mapTask(row: TaskRow): WarmUpTask { return { id: row.id, accountId: row.account_id, dayNumber: row.day_number, sortOrder: row.sort_order, type: row.task_type, groupId: row.group_id ?? undefined, groupName: row.group_name ?? undefined, title: row.title, description: row.description, status: row.status, completedAt: row.completed_at ?? undefined, note: row.note ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapSession(row: SessionRow): ManualSession { return { id: row.id, accountId: row.account_id, startedAt: row.started_at, endedAt: row.ended_at ?? undefined, durationSeconds: row.duration_seconds ?? undefined }; }
