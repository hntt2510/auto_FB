import type Database from 'better-sqlite3';
import type { AccountSession, AccountSessionCompletionReason, AccountSessionStatus, DailySessionProgress, HealthStatus } from '@shared/types';

type SessionRow = { id: string; account_id: string; onboarding_day: number; status: AccountSessionStatus; target_duration_seconds: number; started_at: string; active_started_at: string | null; ended_at: string | null; duration_seconds: number; completion_reason: AccountSessionCompletionReason | null; ending_health_status: HealthStatus | null; operator_note: string | null; created_at: string; updated_at: string };

export class AccountSessionRepository {
  constructor(private readonly db: Database.Database) {}

  active(accountId: string): AccountSession | undefined {
    const row = this.db.prepare("SELECT * FROM account_sessions WHERE account_id = ? AND status IN ('ACTIVE', 'PAUSED') ORDER BY started_at DESC LIMIT 1").get(accountId) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  get(id: string): AccountSession | undefined { const row = this.db.prepare('SELECT * FROM account_sessions WHERE id = ?').get(id) as SessionRow | undefined; return row ? mapSession(row) : undefined; }

  list(accountId: string, limit = 50): AccountSession[] {
    return (this.db.prepare('SELECT * FROM account_sessions WHERE account_id = ? ORDER BY started_at DESC LIMIT ?').all(accountId, limit) as SessionRow[]).map(mapSession);
  }

  openSessions(): AccountSession[] { return (this.db.prepare("SELECT * FROM account_sessions WHERE status IN ('ACTIVE', 'PAUSED') ORDER BY started_at").all() as SessionRow[]).map(mapSession); }

  start(input: { id: string; accountId: string; onboardingDay: number; targetDurationSeconds: number; timestamp: string }): AccountSession {
    this.db.prepare(`INSERT INTO account_sessions (id, account_id, onboarding_day, status, target_duration_seconds, started_at, active_started_at, duration_seconds, created_at, updated_at)
      VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, 0, ?, ?)`).run(input.id, input.accountId, input.onboardingDay, input.targetDurationSeconds, input.timestamp, input.timestamp, input.timestamp, input.timestamp);
    return this.get(input.id)!;
  }

  pause(accountId: string, timestamp: string): AccountSession | undefined {
    return this.db.transaction(() => {
      const current = this.active(accountId); if (!current || current.status !== 'ACTIVE') return undefined;
      this.db.prepare("UPDATE account_sessions SET status = 'PAUSED', duration_seconds = duration_seconds + MAX(0, unixepoch(?) - unixepoch(active_started_at)), active_started_at = NULL, updated_at = ? WHERE id = ? AND status = 'ACTIVE'").run(timestamp, timestamp, current.id);
      return this.get(current.id);
    })();
  }

  resume(accountId: string, timestamp: string): AccountSession | undefined {
    const current = this.active(accountId); if (!current || current.status !== 'PAUSED') return undefined;
    const changed = this.db.prepare("UPDATE account_sessions SET status = 'ACTIVE', active_started_at = ?, updated_at = ? WHERE id = ? AND status = 'PAUSED'").run(timestamp, timestamp, current.id);
    return changed.changes ? this.get(current.id) : undefined;
  }

  finish(accountId: string, status: Extract<AccountSessionStatus, 'COMPLETED' | 'INTERRUPTED'>, reason: AccountSessionCompletionReason, endingHealthStatus: HealthStatus | undefined, operatorNote: string | undefined, timestamp: string): AccountSession | undefined {
    return this.db.transaction(() => {
      const current = this.active(accountId); if (!current) return undefined;
      this.db.prepare(`UPDATE account_sessions SET status = ?,
        duration_seconds = duration_seconds + CASE WHEN status = 'ACTIVE' AND active_started_at IS NOT NULL THEN MAX(0, unixepoch(?) - unixepoch(active_started_at)) ELSE 0 END,
        active_started_at = NULL, ended_at = ?, completion_reason = ?, ending_health_status = ?, operator_note = ?, updated_at = ?
        WHERE id = ? AND status IN ('ACTIVE', 'PAUSED')`).run(status, timestamp, timestamp, reason, endingHealthStatus ?? null, operatorNote?.trim() || null, timestamp, current.id);
      return this.get(current.id);
    })();
  }

  recoverAbandoned(timestamp: string): number {
    return this.db.prepare(`UPDATE account_sessions SET status = 'INTERRUPTED',
      duration_seconds = duration_seconds + CASE WHEN status = 'ACTIVE' AND active_started_at IS NOT NULL THEN MAX(0, unixepoch(?) - unixepoch(active_started_at)) ELSE 0 END,
      active_started_at = NULL, ended_at = ?, completion_reason = 'APPLICATION_RESTART', updated_at = ?
      WHERE status IN ('ACTIVE', 'PAUSED')`).run(timestamp, timestamp, timestamp).changes;
  }

  dailyProgress(accountId: string, planDays: number, targetDurationSeconds: number, now: string): DailySessionProgress[] {
    const rows = this.db.prepare(`SELECT onboarding_day,
      SUM(duration_seconds + CASE WHEN status = 'ACTIVE' AND active_started_at IS NOT NULL THEN MAX(0, unixepoch(?) - unixepoch(active_started_at)) ELSE 0 END) AS duration
      FROM account_sessions WHERE account_id = ? GROUP BY onboarding_day`).all(now, accountId) as Array<{ onboarding_day: number; duration: number }>;
    const totals = new Map(rows.map((row) => [row.onboarding_day, row.duration]));
    return Array.from({ length: planDays }, (_, index) => { const durationSeconds = totals.get(index + 1) ?? 0; return { dayNumber: index + 1, durationSeconds, targetDurationSeconds, completed: durationSeconds >= targetDurationSeconds }; });
  }

  dashboard(from: string, to: string, now: string): { sessionsToday: number; activeNow: number; minutesToday: number; dailyTargetsCompleted: number } {
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN started_at >= ? AND started_at < ? THEN 1 ELSE 0 END) AS sessions_today,
      SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_now,
      SUM(CASE WHEN started_at >= ? AND started_at < ? THEN duration_seconds + CASE WHEN status = 'ACTIVE' AND active_started_at IS NOT NULL THEN MAX(0, unixepoch(?) - unixepoch(active_started_at)) ELSE 0 END ELSE 0 END) AS seconds_today
      FROM account_sessions`).get(from, to, from, to, now) as Record<string, number | null>;
    const targets = (this.db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT account_id, onboarding_day, SUM(duration_seconds + CASE WHEN status = 'ACTIVE' AND active_started_at IS NOT NULL THEN MAX(0, unixepoch(?) - unixepoch(active_started_at)) ELSE 0 END) AS elapsed, MAX(target_duration_seconds) AS target
      FROM account_sessions WHERE started_at >= ? AND started_at < ? GROUP BY account_id, onboarding_day HAVING elapsed >= target
    )`).get(now, from, to) as { count: number }).count;
    return { sessionsToday: row.sessions_today ?? 0, activeNow: row.active_now ?? 0, minutesToday: Math.floor((row.seconds_today ?? 0) / 60), dailyTargetsCompleted: targets };
  }
}

function mapSession(row: SessionRow): AccountSession { return { id: row.id, accountId: row.account_id, onboardingDay: row.onboarding_day, status: row.status, targetDurationSeconds: row.target_duration_seconds, startedAt: row.started_at, activeStartedAt: row.active_started_at ?? undefined, endedAt: row.ended_at ?? undefined, durationSeconds: row.duration_seconds, completionReason: row.completion_reason ?? undefined, endingHealthStatus: row.ending_health_status ?? undefined, operatorNote: row.operator_note ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at }; }
