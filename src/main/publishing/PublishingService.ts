import { randomUUID } from 'node:crypto';
import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { GroupRepository } from '@main/db/repositories/GroupRepository';
import type { PublishRepository } from '@main/db/repositories/PublishRepository';
import type { QueueRepository, QueueRecord } from '@main/db/repositories/QueueRepository';
import { AppError } from '@main/errors';
import { queueIdSchema } from '@shared/schemas';
import type { HealthCheckResult, LiveReadiness, PreflightResult, PublishAttempt, PublishBatchPreview, PublishingEngineStatus, PublishingReadiness, PublishingRunResult, ReconciliationRecord, RequeueInput, QueueItem, SelectorProbeResult } from '@shared/types';
import type { MediaStorageService } from '@main/services/MediaStorageService';
import type { PublishCoordinator } from './PublishCoordinator';
import type { PublishDiagnostics } from './PublishDiagnostics';
import type { PublishExecutor } from './PublishExecutor';
import type { PublishScheduler } from './PublishScheduler';
import type { PublishingSettingsService } from './PublishingSettingsService';
import type { LiveReadinessService } from './LiveReadinessService';
import type { OperationsReportService } from './OperationsReportService';

export class PublishingService {
  constructor(private readonly queue: QueueRepository, private readonly attemptsRepository: PublishRepository, private readonly accounts: AccountRepository, private readonly groups: GroupRepository, private readonly media: MediaStorageService, private readonly executor: PublishExecutor, private readonly coordinator: PublishCoordinator, private readonly scheduler: PublishScheduler, private readonly settings: PublishingSettingsService, private readonly diagnostics: PublishDiagnostics, private readonly audit: AuditLogRepository, private readonly notify: () => void, private readonly readiness?: LiveReadinessService, private readonly report?: OperationsReportService) {}

  recover(): number { const count = this.attemptsRepository.recoverRunning('Application stopped during previous publish attempt. Confirm Facebook state before retrying.'); if (count) this.notifySafe(); return count; }
  status(): PublishingEngineStatus {
    const running = this.coordinator.running().map((id) => this.queue.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => this.publicItem(item)); const settings = this.settings.get(); const probes = this.attemptsRepository.recentProbes(20); const readiness: PublishingReadiness = this.attemptsRepository.blocks().length ? 'DEGRADED' : settings.executionMode === 'LIVE' && settings.enabled ? 'LIVE_ENABLED' : probes.some((probe) => probe.status === 'FOUND') ? 'PREFLIGHT_READY' : 'NOT_READY';
    const dueCount = typeof this.queue.dueCount === 'function' ? this.queue.dueCount(new Date().toISOString()) : this.queue.due(new Date().toISOString()).length;
    const schedulerArmed = typeof this.scheduler.isArmed === 'function' ? this.scheduler.isArmed() : false;
    return { settings, schedulerRunning: this.scheduler.isRunning(), schedulerArmed, schedulerState: this.scheduler.runtimeState(), schedulerReason: this.scheduler.reason(), sessionCompleted: this.scheduler.completedThisSession(), sessionLimit: settings.maxJobsPerSchedulerSession ?? 20, armPreview: this.scheduler.preview(), tickRunning: this.scheduler.isTicking(), running, blockedAccounts: this.attemptsRepository.blocks(), recentAttempts: this.attemptsRepository.recent(30), dueCount, overdueCount: dueCount, selectorVersion: this.executor.selectorVersion, readiness, recentProbes: probes, batch: typeof this.coordinator.status === 'function' ? this.coordinator.status() : undefined };
  }
  run(queueId: string): Promise<PublishingRunResult> { return this.runMany([this.validId(queueId)]); }
  async previewBatch(queueIds: string[]): Promise<PublishBatchPreview> { return this.batchPreview(queueIds.map((id) => this.validId(id))); }
  async runSelected(queueIds: string[]): Promise<PublishingRunResult> {
    const ids = [...new Set(queueIds.map((id) => this.validId(id)))]; const settings = this.settings.get();
    if (ids.length > 20) throw new AppError('BATCH_LIMIT', 'A controlled explicit batch is limited to 20 items.');
    if (settings.executionMode === 'LIVE' && settings.canaryMode === true && ids.length > 1) throw new AppError('CANARY_LIMIT', 'Canary mode allows one queue item per explicit run.');
    if (this.coordinator.isBusy()) throw new AppError('PUBLISHING_BUSY', 'A controlled publishing batch is already running.');
    if (settings.executionMode === 'LIVE' && ids.length > 1) { const preview = await this.batchPreview(ids); if (preview.blocked) throw new AppError('BATCH_NOT_READY', `Controlled batch has ${preview.blocked} item(s) that require operator attention.`); }
    return this.runMany(ids, 'MANUAL');
  }
  runDue(): Promise<PublishingRunResult> { const settings = this.settings.get(); if (settings.executionMode === 'LIVE' && settings.canaryMode === true) throw new AppError('CANARY_LIMIT', 'Canary mode disables Run Due. Run one item explicitly.'); return this.scheduler.runDue(); }
  async preflight(queueId: string): Promise<PreflightResult> { const item = this.rawQueue(queueId); if (!['PENDING', 'PAUSED'].includes(item.status)) throw new AppError('INVALID_STATE', 'Only pending or paused queue items can be preflighted.'); const result = await this.executor.preflight(item, this.settings.get(), true); this.notifySafe(); return result; }
  async probe(accountId: string, groupId: string): Promise<SelectorProbeResult> { const account = this.accounts.get(accountId); const group = this.groups.get(groupId); if (!account || !group || !group.active) throw new AppError('GROUP_UNAVAILABLE', 'Account or active group not found.'); if (!this.groups.assignments(groupId).some((assignment) => assignment.id === accountId)) throw new AppError('INVALID_ASSIGNMENT', 'Account is not assigned to this group.'); const item = { id: randomUUID(), accountId, groupId, draftTitle: 'Selector probe', body: '', accountName: account.name, groupName: group.name, groupUrl: group.normalizedUrl, status: 'PENDING' as const, media: [], snapshotHash: 'probe', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; return this.executor.probe(item); }
  attempts(queueId: string): PublishAttempt[] { const id = this.validId(queueId); if (!this.queue.get(id)) throw new AppError('QUEUE_ITEM_NOT_FOUND', 'Queue item not found.'); return this.attemptsRepository.attempts(id); }
  retry(queueId: string, acknowledgeDuplicateRisk: boolean): QueueItem { const id = this.validId(queueId); const item = this.requireQueue(id); const latest = this.attemptsRepository.attempts(id)[0]; if (latest?.irreversibleReached && !acknowledgeDuplicateRisk) throw new AppError('INVALID_REQUEST', 'Retry may create a duplicate Facebook post. Explicit acknowledgement is required.'); try { const updated = this.queue.retry(id); this.auditSafe(item.accountId, 'PUBLISH_RETRY_REQUESTED', 'Queue item prepared for an explicit retry.', id); this.notifySafe(); return this.publicItem(updated); } catch { throw new AppError('INVALID_STATE', 'Queue item cannot be retried from its current state.'); } }
  requeue(input: RequeueInput): QueueItem { const source = this.requireQueue(input.queueId); const account = source.accountId ? this.accounts.get(source.accountId) : undefined; const group = source.groupId ? this.groups.get(source.groupId) : undefined; if (!account || !group || !group.active || !this.groups.assignments(group.id).some((value) => value.id === account.id)) throw new AppError('INVALID_ASSIGNMENT', 'The original account/group target is no longer eligible.'); const timestamp = new Date().toISOString(); try { const item = this.queue.requeue(source.id, randomUUID(), input.scheduledAt, timestamp); this.auditSafe(account.id, 'QUEUE_REQUEUED', 'Queue snapshot requeued as a new item.', item.id); this.notifySafe(); return this.publicItem(item); } catch (error) { if (String(error).toLowerCase().includes('unique')) throw new AppError('DUPLICATE_QUEUE_ITEM', 'An equivalent active queue item already exists.'); throw new AppError('INVALID_STATE', 'Queue item cannot be requeued.'); } }
  resolve(queueId: string): QueueItem { return this.markSubmitted(queueId); }
  markSubmitted(queueId: string): QueueItem { const item = this.requireQueue(queueId); try { this.attemptsRepository.markSubmitted(item.id, 'MANUAL_CONFIRMATION'); this.auditSafe(item.accountId, 'PUBLISH_MANUALLY_MARKED_SUBMITTED', 'Operator reconciled the submission as submitted; public publication remains unverified.', item.id); this.notifySafe(); return this.publicItem(this.queue.get(item.id)!); } catch { throw new AppError('INVALID_STATE', 'Only attention items can be marked submitted.'); } }
  markVerified(queueId: string, evidence?: string): QueueItem { const detail = evidence?.trim(); if (!detail || detail.length > 500) throw new AppError('INVALID_REQUEST', 'Operator evidence is required and must be 500 characters or fewer.'); const item = this.requireQueue(queueId); try { this.attemptsRepository.markVerified(item.id, detail); this.auditSafe(item.accountId, 'PUBLISH_MANUALLY_VERIFIED', 'Operator manually verified publication.', item.id); this.notifySafe(); return this.publicItem(this.queue.get(item.id)!); } catch { throw new AppError('INVALID_STATE', 'Only submitted or attention items with an attempt can be manually verified.'); } }
  reconciliations(queueId: string): ReconciliationRecord[] { const id = this.validId(queueId); return this.attemptsRepository.reconciliations(id); }
  async openDiagnostic(attemptId: string): Promise<void> { const id = this.validId(attemptId); const path = this.attemptsRepository.diagnosticPath(id); if (!path) throw new AppError('INVALID_REQUEST', 'No diagnostic is available for this attempt.'); await this.diagnostics.open(path); }
  async openPreflightDiagnostic(queueId: string): Promise<void> { const id = this.validId(queueId); if (!this.queue.get(id)) throw new AppError('QUEUE_ITEM_NOT_FOUND', 'Queue item not found.'); const path = this.attemptsRepository.preflightDiagnosticPath(id); if (!path) throw new AppError('INVALID_REQUEST', 'No preflight diagnostic is available.'); await this.diagnostics.open(path); }
  async deleteDiagnostic(attemptId: string): Promise<void> { const id = this.validId(attemptId); const path = this.attemptsRepository.diagnosticPath(id); if (!path) throw new AppError('INVALID_REQUEST', 'No diagnostic is available for this attempt.'); await this.diagnostics.delete(path); this.attemptsRepository.clearDiagnostic(id); this.notifySafe(); }
  handleHealthResult(result: HealthCheckResult): void { if (result.status === 'READY' && this.attemptsRepository.clearBlock(result.accountId)) { this.auditSafe(result.accountId, 'ACCOUNT_PUBLISHING_RESUMED', 'Publishing resumed after a successful health check.', result.accountId); this.notifySafe(); } else if (result.status !== 'READY') { this.coordinator.blockAccount(result.accountId, result.status); } }
  async evaluateLiveReadiness(queueId: string): Promise<LiveReadiness> { const item = this.rawQueue(queueId); if (!this.readiness) return { ready: false, reasons: ['PREFLIGHT_MISSING'] }; this.readiness.setSelectorVersion(this.executor.selectorVersion); return this.readiness.evaluate(item, this.settings.get()); }
  armScheduler(acknowledgeOverdue = false): PublishingEngineStatus { try { this.scheduler.arm(acknowledgeOverdue); } catch (error) { const message = error instanceof Error ? error.message : 'Scheduler could not be armed.'; const lower = message.toLowerCase(); throw new AppError(lower.includes('canary') ? 'CANARY_LIMIT' : lower.includes('overdue') ? 'OVERDUE_BACKLOG_ACK_REQUIRED' : 'SCHEDULER_INVALID_STATE', message); } this.coordinator.resumeAccepting(); this.auditSafe(undefined, 'PUBLISH_SCHEDULER_ARMED', 'Scheduler armed for this application session.'); this.notifySafe(); return this.status(); }
  disarmScheduler(): PublishingEngineStatus { this.scheduler.disarm(); this.auditSafe(undefined, 'PUBLISH_SCHEDULER_DISARMED', 'Scheduler disarmed.'); this.notifySafe(); return this.status(); }
  async stopPublishing(): Promise<PublishingEngineStatus> { this.scheduler.disarm(); await this.coordinator.stopAndDrain(20000); this.auditSafe(undefined, 'PUBLISHING_STOPPED', 'Publishing stopped and scheduler disarmed.'); this.notifySafe(); return this.status(); }
  async stopAfterCurrent(): Promise<PublishingEngineStatus> {
    const schedulerStopping = this.scheduler.runtimeState() === 'ARMED';
    if (!schedulerStopping && !this.coordinator.isBusy()) throw new AppError('PUBLISHING_STOPPED', 'No controlled publishing batch is active.');
    if (schedulerStopping) { try { this.scheduler.beginStopping(); } catch (error) { throw new AppError('SCHEDULER_INVALID_STATE', error instanceof Error ? error.message : 'Scheduler is not armed.'); } }
    try {
      const drained = await this.coordinator.stopAfterCurrent(20_000);
      if (!drained) {
        if (schedulerStopping) this.scheduler.failStopping('STOP_DRAIN_TIMEOUT');
        throw new AppError('PUBLISHING_STOPPED', 'Current publishing operations did not drain before the safety timeout.');
      }
      if (schedulerStopping) this.scheduler.completeStopping();
      this.auditSafe(undefined, 'PUBLISH_SCHEDULER_STOP_AFTER_CURRENT', 'Scheduler stopped after current operations completed.');
      this.notifySafe();
      return this.status();
    } catch (error) {
      if (schedulerStopping && this.scheduler.runtimeState() === 'STOPPING') this.scheduler.failStopping('STOP_DRAIN_FAILED');
      throw error instanceof AppError ? error : new AppError('PUBLISHING_STOPPED', 'Publishing drain failed while stopping after current work.');
    } finally {
      this.coordinator.resumeAccepting();
    }
  }
  async exportReport(): Promise<string | undefined> { if (!this.report) throw new AppError('INVALID_STATE', 'Operations report is unavailable.'); return this.report.chooseAndExport(); }

  private async runMany(ids: string[], source: 'MANUAL' | 'SCHEDULER' = 'MANUAL'): Promise<PublishingRunResult> { const unique = [...new Set(ids)]; if (this.settings.get().executionMode === 'DRY_RUN') { for (const id of unique) await this.preflight(id); return { requested: unique.length, claimed: 0, completed: 0, skipped: unique.length }; } try { return await this.coordinator.run(unique, this.settings.get(), source); } catch (error) { if (error instanceof Error && error.message === 'PUBLISHING_BUSY') throw new AppError('PUBLISHING_BUSY', 'A controlled publishing batch is already running.'); throw error; } }
  private async batchPreview(ids: string[]): Promise<PublishBatchPreview> {
    const settings = this.settings.get(); const items = ids.map((id) => this.queue.get(id)); const issues: PublishBatchPreview['items'] = [];
    for (let index = 0; index < ids.length; index++) {
      const item = items[index]; const reasons: string[] = [];
      if (!item || item.status !== 'PENDING') reasons.push('QUEUE_NOT_PENDING');
      if (!settings.enabled) reasons.push('ENGINE_DISABLED');
      if (settings.executionMode !== 'LIVE') reasons.push('NOT_LIVE_MODE');
      if (settings.canaryMode === true && ids.length > 1) reasons.push('CANARY_LIMIT');
      if (!item) { issues.push({ queueId: ids[index], reasons }); continue; }
      if (!this.readiness) reasons.push('PREFLIGHT_MISSING'); else { this.readiness.setSelectorVersion(this.executor.selectorVersion); const readiness = await this.readiness.evaluate(item, settings); if (!readiness.ready) reasons.push(...readiness.reasons); }
      issues.push({ queueId: item.id, accountId: item.accountId ?? undefined, accountName: item.accountName, groupName: item.groupName, reasons: [...new Set(reasons)] });
    }
    const readyItems = issues.filter((item) => !item.reasons.length); const accountCounts = new Map<string, number>(); for (const item of readyItems) if (item.accountId) accountCounts.set(item.accountId, (accountCounts.get(item.accountId) ?? 0) + 1);
    return { requested: ids.length, ready: readyItems.length, blocked: issues.length - readyItems.length, accountCount: new Set(issues.map((item) => item.accountId).filter(Boolean)).size, groupCount: new Set(issues.map((item) => item.groupName).filter(Boolean)).size, batchPacingSeconds: settings.batchPacingSeconds, minimumPacingSeconds: Math.max(0, ...[...accountCounts.values()].map((count) => (count - 1) * settings.batchPacingSeconds)), items: issues };
  }
  private requireQueue(value: string): QueueItem { const item = this.queue.get(this.validId(value)); if (!item) throw new AppError('QUEUE_ITEM_NOT_FOUND', 'Queue item not found.'); return this.publicItem(item); }
  private validId(value: string): string { const parsed = queueIdSchema.safeParse(value); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid identifier.'); return parsed.data; }
  private rawQueue(value: string): QueueRecord { const item = this.queue.get(this.validId(value)); if (!item) throw new AppError('QUEUE_ITEM_NOT_FOUND', 'Queue item not found.'); return item; }
  private publicItem(item: ReturnType<QueueRepository['get']> extends infer T ? NonNullable<T> : never): QueueItem { return { ...item, media: item.media.map((asset) => ({ id: asset.id, type: asset.type, originalName: asset.originalName, mimeType: asset.mimeType, fileSize: asset.fileSize, sortOrder: asset.sortOrder, previewUrl: this.media.previewUrl(asset.id) })) }; }
  private auditSafe(accountId: string | undefined, eventType: string, message: string, queueId?: string): void { try { this.audit.add({ accountId, eventType, message, metadata: JSON.stringify(queueId ? { queueId } : {}) }); } catch { /* best effort */ } }
  private notifySafe(): void { try { this.notify(); } catch { /* renderer may be closing */ } }
}
