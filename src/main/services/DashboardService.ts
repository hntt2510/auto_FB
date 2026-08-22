import type Database from 'better-sqlite3';
import type { DashboardSummary } from '@shared/types';
import { QueueRepository } from '@main/db/repositories/QueueRepository';
import { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { PublishingSettingsService } from '@main/publishing/PublishingSettingsService';

export class DashboardService {
  private readonly queue: QueueRepository;
  private readonly audit: AuditLogRepository;
  constructor(private readonly db: Database.Database, private readonly settings?: PublishingSettingsService) { this.queue = new QueueRepository(db); this.audit = new AuditLogRepository(db); }

  summary(): DashboardSummary {
    const accountRows = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN last_health_status = 'READY' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN last_health_status = 'LOGIN_REQUIRED' THEN 1 ELSE 0 END) AS login_required,
      SUM(CASE WHEN last_health_status = 'CHECKPOINT' THEN 1 ELSE 0 END) AS checkpoint,
      SUM(CASE WHEN last_health_status = 'ERROR' OR status = 'ERROR' THEN 1 ELSE 0 END) AS error FROM accounts`).get() as Record<string, number | null>;
    const groups = this.db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active FROM groups').get() as Record<string, number | null>;
    const drafts = this.db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'READY' THEN 1 ELSE 0 END) AS ready FROM drafts").get() as Record<string, number | null>;
    const now = new Date().toISOString(); const today = `${now.slice(0, 10)}T00:00:00.000Z`; const queue = this.db.prepare("SELECT SUM(CASE WHEN status IN ('PENDING', 'PAUSED', 'RUNNING', 'NEEDS_ATTENTION') THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN scheduled_at IS NOT NULL AND scheduled_at <= ? AND status = 'PENDING' THEN 1 ELSE 0 END) AS due, SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled, SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) AS running, SUM(CASE WHEN status = 'SUCCEEDED' AND completed_at >= ? THEN 1 ELSE 0 END) AS succeeded_today, SUM(CASE WHEN status = 'FAILED' AND completed_at >= ? THEN 1 ELSE 0 END) AS failed_today, SUM(CASE WHEN status = 'NEEDS_ATTENTION' THEN 1 ELSE 0 END) AS needs_attention FROM queue_items").get(now, today, today) as Record<string, number | null>;
    return { accounts: { total: accountRows.total ?? 0, ready: accountRows.ready ?? 0, loginRequired: accountRows.login_required ?? 0, checkpoint: accountRows.checkpoint ?? 0, error: accountRows.error ?? 0 }, groups: { active: groups.active ?? 0, total: groups.total ?? 0 }, drafts: { ready: drafts.ready ?? 0, total: drafts.total ?? 0 }, queue: { active: queue.active ?? 0, due: queue.due ?? 0, cancelled: queue.cancelled ?? 0 }, publishing: { enabled: this.settings?.get().enabled ?? false, running: queue.running ?? 0, succeededToday: queue.succeeded_today ?? 0, failedToday: queue.failed_today ?? 0, needsAttention: queue.needs_attention ?? 0 }, recentQueue: this.queue.list({}).slice(0, 5).map((item) => ({ ...item, media: item.media.map((media) => ({ id: media.id, type: media.type, originalName: media.originalName, mimeType: media.mimeType, fileSize: media.fileSize, sortOrder: media.sortOrder, previewUrl: `app-media://asset/${encodeURIComponent(media.id)}` })) })), recentLogs: this.audit.list({}).slice(0, 10) };
  }
}
