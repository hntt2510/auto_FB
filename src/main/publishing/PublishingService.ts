import { randomUUID } from 'node:crypto';
import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { GroupRepository } from '@main/db/repositories/GroupRepository';
import type { PublishRepository } from '@main/db/repositories/PublishRepository';
import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import { AppError } from '@main/errors';
import { queueIdSchema } from '@shared/schemas';
import type { HealthCheckResult, PublishAttempt, PublishingEngineStatus, PublishingRunResult, RequeueInput, QueueItem } from '@shared/types';
import type { MediaStorageService } from '@main/services/MediaStorageService';
import type { PublishCoordinator } from './PublishCoordinator';
import type { PublishDiagnostics } from './PublishDiagnostics';
import type { PublishScheduler } from './PublishScheduler';
import type { PublishingSettingsService } from './PublishingSettingsService';

export class PublishingService {
  constructor(private readonly queue: QueueRepository, private readonly attemptsRepository: PublishRepository, private readonly accounts: AccountRepository, private readonly groups: GroupRepository, private readonly media: MediaStorageService, private readonly coordinator: PublishCoordinator, private readonly scheduler: PublishScheduler, private readonly settings: PublishingSettingsService, private readonly diagnostics: PublishDiagnostics, private readonly audit: AuditLogRepository, private readonly notify: () => void) {}

  recover(): number { const count = this.attemptsRepository.recoverRunning('Application stopped during previous publish attempt. Confirm Facebook state before retrying.'); if (count) this.notifySafe(); return count; }
  status(): PublishingEngineStatus { const running = this.coordinator.running().map((id) => this.queue.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => this.publicItem(item)); return { settings: this.settings.get(), schedulerRunning: this.scheduler.isRunning(), tickRunning: this.scheduler.isTicking(), running, blockedAccounts: this.attemptsRepository.blocks(), recentAttempts: this.attemptsRepository.recent(30), dueCount: this.queue.due(new Date().toISOString()).length }; }
  run(queueId: string): Promise<PublishingRunResult> { return this.coordinator.run([this.validId(queueId)], this.settings.get()); }
  runSelected(queueIds: string[]): Promise<PublishingRunResult> { return this.coordinator.run(queueIds.map((id) => this.validId(id)), this.settings.get()); }
  runDue(): Promise<PublishingRunResult> { return this.scheduler.runDue(); }
  attempts(queueId: string): PublishAttempt[] { const id = this.validId(queueId); if (!this.queue.get(id)) throw new AppError('QUEUE_ITEM_NOT_FOUND', 'Queue item not found.'); return this.attemptsRepository.attempts(id); }

  retry(queueId: string, acknowledgeDuplicateRisk: boolean): QueueItem {
    const id = this.validId(queueId); const item = this.queue.get(id); if (!item) throw new AppError('QUEUE_ITEM_NOT_FOUND', 'Queue item not found.');
    const latest = this.attemptsRepository.attempts(id)[0]; if (latest?.irreversibleReached && !acknowledgeDuplicateRisk) throw new AppError('INVALID_REQUEST', 'Retry may create a duplicate Facebook post. Explicit acknowledgement is required.');
    try { const updated = this.queue.retry(id); this.auditSafe(item.accountId, 'PUBLISH_RETRY_REQUESTED', 'Queue item prepared for an explicit retry.', id); this.notifySafe(); return this.publicItem(updated); } catch { throw new AppError('INVALID_STATE', 'Queue item cannot be retried from its current state.'); }
  }

  requeue(input: RequeueInput): QueueItem {
    const source = this.queue.get(this.validId(input.queueId)); if (!source) throw new AppError('QUEUE_ITEM_NOT_FOUND', 'Queue item not found.');
    const account = source.accountId ? this.accounts.get(source.accountId) : undefined; const group = source.groupId ? this.groups.get(source.groupId) : undefined;
    if (!account || !group || !group.active || !this.groups.assignments(group.id).some((value) => value.id === account.id)) throw new AppError('INVALID_ASSIGNMENT', 'The original account/group target is no longer eligible.');
    const timestamp = new Date().toISOString();
    try { const item = this.queue.requeue(source.id, randomUUID(), input.scheduledAt, timestamp); this.auditSafe(account.id, 'QUEUE_REQUEUED', 'Queue snapshot requeued as a new item.', item.id); this.notifySafe(); return this.publicItem(item); }
    catch (error) { if (String(error).toLowerCase().includes('unique')) throw new AppError('DUPLICATE_QUEUE_ITEM', 'An equivalent active queue item already exists.'); throw new AppError('INVALID_STATE', 'Queue item cannot be requeued.'); }
  }

  resolve(queueId: string): QueueItem { const id = this.validId(queueId); try { const item = this.queue.resolveAttention(id); this.auditSafe(item.accountId, 'PUBLISH_ATTENTION_RESOLVED', 'Attention item marked submitted without claiming verified publication.', id); this.notifySafe(); return this.publicItem(item); } catch { throw new AppError('INVALID_STATE', 'Only attention items can be resolved.'); } }
  async openDiagnostic(attemptId: string): Promise<void> { const id = this.validId(attemptId); const path = this.attemptsRepository.diagnosticPath(id); if (!path) throw new AppError('INVALID_REQUEST', 'No diagnostic is available for this attempt.'); await this.diagnostics.open(path); }
  handleHealthResult(result: HealthCheckResult): void { if (result.status === 'READY' && this.attemptsRepository.clearBlock(result.accountId)) { this.auditSafe(result.accountId, 'ACCOUNT_PUBLISHING_RESUMED', 'Publishing resumed after a successful health check.', result.accountId); this.notifySafe(); } }

  private validId(value: string): string { const parsed = queueIdSchema.safeParse(value); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid identifier.'); return parsed.data; }
  private publicItem(item: ReturnType<QueueRepository['get']> extends infer T ? NonNullable<T> : never): QueueItem { return { ...item, media: item.media.map((asset) => ({ id: asset.id, type: asset.type, originalName: asset.originalName, mimeType: asset.mimeType, fileSize: asset.fileSize, sortOrder: asset.sortOrder, previewUrl: this.media.previewUrl(asset.id) })) }; }
  private auditSafe(accountId: string | undefined, eventType: string, message: string, queueId: string): void { try { this.audit.add({ accountId, eventType, message, metadata: JSON.stringify({ queueId }) }); } catch { /* best effort */ } }
  private notifySafe(): void { try { this.notify(); } catch { /* renderer may be closing */ } }
}
