import { createHash, randomUUID } from 'node:crypto';
import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { DraftRepository, DraftRecord } from '@main/db/repositories/DraftRepository';
import type { GroupRepository } from '@main/db/repositories/GroupRepository';
import type { QueueRepository, QueueRecord } from '@main/db/repositories/QueueRepository';
import { AppError } from '@main/errors';
import { draftIdSchema, queueBatchSchema, queueFilterSchema, queueIdSchema } from '@shared/schemas';
import type { PlannerBucket, PlannerItem, PlannerSummary, QueueBatchActionInput, QueueBatchInput, QueueBatchRescheduleInput, QueueFilter, QueueItem, QueueOptions, QueuePreview, QueueTarget, QueueValidationIssue } from '@shared/types';
import { MediaStorageService } from './MediaStorageService';

export function buildSnapshotHash(draft: DraftRecord): string {
  const payload = { id: draft.id, title: draft.title, body: draft.body, linkUrl: draft.linkUrl ?? null, media: draft.media.map((media) => ({ id: media.id, type: media.type, originalName: media.originalName, mimeType: media.mimeType ?? null, fileSize: media.fileSize, sortOrder: media.sortOrder })) };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export class QueueService {
  constructor(private readonly queue: QueueRepository, private readonly drafts: DraftRepository, private readonly accounts: AccountRepository, private readonly groups: GroupRepository, private readonly media: MediaStorageService, private readonly audit: AuditLogRepository, private readonly notify: () => void) {}

  options(draftId: string, accountIds: string[]): QueueOptions {
    this.requireDraft(draftId); const accounts = [...new Set(accountIds)].map((id) => this.accounts.get(id)).filter((account): account is NonNullable<typeof account> => Boolean(account)).map((account) => ({ id: account.id, name: account.name, status: account.status, lastHealthStatus: account.lastHealthStatus }));
    const groupsByAccount: Record<string, ReturnType<GroupRepository['list']>> = {}; for (const account of accounts) groupsByAccount[account.id] = this.groups.forAccount(account.id).filter((group) => group.active);
    return { accounts, groupsByAccount };
  }

  preview(input: QueueBatchInput): QueuePreview {
    const parsed = queueBatchSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid queue batch.');
    const draft = this.requireDraft(parsed.data.draftId); const issues: QueueValidationIssue[] = []; const targets: QueuePreview['targets'] = []; const seen = new Set<string>(); const duplicateTargets: QueueTarget[] = [];
    if (draft.status !== 'READY') issues.push({ code: 'DRAFT_NOT_READY', message: 'Draft must be READY before it can be queued.' });
    if (!draft.body.trim() && !draft.linkUrl?.trim() && draft.media.length === 0) issues.push({ code: 'EMPTY_PUBLISH_CONTENT', message: 'Queue content must include body text, a link, or media.' });
    const hash = buildSnapshotHash(draft);
    for (const target of parsed.data.targets) {
      const key = `${target.accountId}:${target.groupId}`;
      if (seen.has(key)) { issues.push({ target, code: 'DUPLICATE_TARGET', message: 'The account/group target is repeated.' }); continue; }
      seen.add(key);
      const account = this.accounts.get(target.accountId); const group = this.groups.get(target.groupId);
      if (!account) { issues.push({ target, code: 'ACCOUNT_NOT_FOUND', message: 'Account does not exist.' }); continue; }
      if (!group) { issues.push({ target, code: 'GROUP_NOT_FOUND', message: 'Group does not exist.' }); continue; }
      if (!group.active) { issues.push({ target, code: 'GROUP_INACTIVE', message: 'Group is archived.' }); continue; }
      if (!this.groups.assignments(group.id).some((assignment) => assignment.id === account.id)) { issues.push({ target, code: 'INVALID_ASSIGNMENT', message: 'Account is not assigned to this group.' }); continue; }
      if (this.queue.hasDuplicate(draft.id, hash, account.id, group.id, parsed.data.scheduledAt)) duplicateTargets.push(target);
      targets.push({ ...target, accountName: account.name, groupName: group.name, groupUrl: group.normalizedUrl });
    }
    if (duplicateTargets.length) for (const target of duplicateTargets) issues.push({ target, code: 'DUPLICATE_QUEUE_ITEM', message: 'An active equivalent queue item already exists.' });
    return { draft: { id: draft.id, title: draft.title, body: draft.body, linkUrl: draft.linkUrl, media: draft.media.map((media) => ({ id: media.id, draftId: media.draftId, type: media.type, originalName: media.originalName, mimeType: media.mimeType, fileSize: media.fileSize, sortOrder: media.sortOrder, previewUrl: this.media.previewUrl(media.id), createdAt: media.createdAt })) }, targets, scheduledAt: parsed.data.scheduledAt, issues, duplicateTargets };
  }

  create(input: QueueBatchInput): QueueItem[] {
    const preview = this.preview(input); if (preview.issues.length) { if (preview.issues.some((issue) => issue.code === 'DUPLICATE_QUEUE_ITEM')) throw new AppError('DUPLICATE_QUEUE_ITEM', 'One or more equivalent active queue items already exist.'); throw new AppError('QUEUE_VALIDATION_FAILED', preview.issues.map((issue) => issue.message).join(' ')); }
    const draft = this.requireDraft(input.draftId); const hash = buildSnapshotHash(draft); const timestamp = new Date().toISOString();
    const rows = preview.targets.map((target) => ({ id: randomUUID(), draftId: draft.id, accountId: target.accountId, groupId: target.groupId, draftTitle: draft.title, body: draft.body, linkUrl: draft.linkUrl, accountName: target.accountName, groupName: target.groupName, groupUrl: target.groupUrl, snapshotHash: hash, scheduledAt: input.scheduledAt, media: draft.media.map((media) => ({ id: media.id, type: media.type, originalName: media.originalName, storedName: '', localPath: '', mimeType: media.mimeType, fileSize: media.fileSize, sortOrder: media.sortOrder })), createdAt: timestamp }));
    try {
      const created = this.queue.insertBatch(rows); this.auditSafe('QUEUE_CREATED', `Created ${created.length} queue item(s).`, JSON.stringify({ draftId: draft.id, count: created.length })); this.notifySafe(); return created.map((item) => this.publicItem(item));
    } catch (error) { if (String(error).toLowerCase().includes('unique')) throw new AppError('DUPLICATE_QUEUE_ITEM', 'An equivalent active queue item already exists.'); throw new AppError('QUEUE_VALIDATION_FAILED', 'Queue creation was rolled back.'); }
  }

  list(filter?: QueueFilter): QueueItem[] { const parsed = queueFilterSchema.safeParse(filter ?? {}); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid queue filter.'); return this.queue.list(parsed.data).map((item) => this.publicItem(item)); }
  get(id: string): QueueItem { const item = this.queue.get(this.validId(id)); if (!item) throw new AppError('QUEUE_ITEM_NOT_FOUND', 'Queue item not found.'); return this.publicItem(item); }
  pause(id: string): QueueItem { return this.transition(id, 'PAUSE'); }
  resume(id: string): QueueItem { return this.transition(id, 'RESUME'); }
  cancel(id: string): QueueItem { return this.transition(id, 'CANCEL'); }
  planner(now = new Date()): PlannerSummary {
    const conflictWindowMinutes = 15; const items = this.queue.list().filter((item) => ['PENDING', 'PAUSED'].includes(item.status)); const conflictIds = new Set<string>();
    const scheduledByAccount = new Map<string, QueueRecord[]>();
    for (const item of items) if (item.accountId && item.scheduledAt) { const list = scheduledByAccount.get(item.accountId) ?? []; list.push(item); scheduledByAccount.set(item.accountId, list); }
    for (const values of scheduledByAccount.values()) { values.sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!)); for (let index = 1; index < values.length; index++) if (new Date(values[index].scheduledAt!).getTime() - new Date(values[index - 1].scheduledAt!).getTime() <= conflictWindowMinutes * 60_000) { conflictIds.add(values[index].id); conflictIds.add(values[index - 1].id); } }
    const buckets: PlannerSummary['buckets'] = { TODAY: [], TOMORROW: [], LATER: [], UNSCHEDULED: [] }; const grouped = new Map<string, PlannerItem[]>();
    for (const item of items) { const bucket = plannerBucket(item.scheduledAt, now); const key = `${bucket}:${item.accountId ?? item.accountName}`; const list = grouped.get(key) ?? []; list.push({ ...this.publicItem(item), bucket, accountScheduleConflict: conflictIds.has(item.id) }); grouped.set(key, list); }
    for (const [key, values] of grouped) { const bucket = key.slice(0, key.indexOf(':')) as PlannerBucket; buckets[bucket].push({ accountId: values[0].accountId, accountName: values[0].accountName, items: values }); }
    for (const bucket of Object.values(buckets)) bucket.sort((a, b) => a.accountName.localeCompare(b.accountName));
    return { generatedAt: now.toISOString(), conflictWindowMinutes, buckets };
  }
  batchAction(input: QueueBatchActionInput): QueueItem[] { try { const items = this.queue.batchAction(input.queueIds, input.action).map((item) => this.publicItem(item)); this.auditSafe(`QUEUE_BATCH_${input.action}`, `${input.action.toLowerCase()} applied to ${items.length} queue item(s).`, JSON.stringify({ count: items.length })); this.notifySafe(); return items; } catch { throw new AppError('INVALID_STATE', 'Batch validation failed. No queue items were changed.'); } }
  batchReschedule(input: QueueBatchRescheduleInput): QueueItem[] { try { const items = this.queue.batchReschedule(input).map((item) => this.publicItem(item)); this.auditSafe('QUEUE_BATCH_RESCHEDULED', `Rescheduled ${items.length} queue item(s).`, JSON.stringify({ count: items.length, mode: input.mode })); this.notifySafe(); return items; } catch (error) { throw new AppError('INVALID_STATE', error instanceof Error ? error.message : 'Batch reschedule failed. No queue items were changed.'); } }
  async delete(id: string): Promise<void> { const item = this.get(id); let media; try { media = this.queue.deleteCancelled(item.id); } catch { throw new AppError('INVALID_STATE', 'Only cancelled queue items can be deleted.'); } await this.cleanupAssets(media.map((asset) => asset.id)); this.auditSafe('QUEUE_DELETED', 'Cancelled queue item deleted.', JSON.stringify({ queueId: item.id })); this.notifySafe(); }

  private transition(id: string, action: 'PAUSE' | 'RESUME' | 'CANCEL'): QueueItem { const item = this.queue.get(this.validId(id)); if (!item) throw new AppError('QUEUE_ITEM_NOT_FOUND', 'Queue item not found.'); let next: QueueRecord; const label = action === 'PAUSE' ? 'paused' : action === 'RESUME' ? 'resumed' : 'cancelled'; try { next = this.queue.updateState(item.id, action); } catch { throw new AppError('INVALID_STATE', `Queue item cannot be ${label} from ${item.status}.`); } this.auditSafe(action === 'PAUSE' ? 'QUEUE_PAUSED' : action === 'RESUME' ? 'QUEUE_RESUMED' : 'QUEUE_CANCELLED', `Queue item ${label}.`, JSON.stringify({ queueId: item.id })); this.notifySafe(); return this.publicItem(next); }
  private requireDraft(id: string): DraftRecord { const parsed = draftIdSchema.safeParse(id); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid draft id.'); const draft = this.drafts.get(parsed.data); if (!draft) throw new AppError('DRAFT_NOT_FOUND', 'Draft not found.'); return draft; }
  private validId(value: string): string { const parsed = queueIdSchema.safeParse(value); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid queue id.'); return parsed.data; }
  private publicItem(item: QueueRecord): QueueItem { return { ...item, media: item.media.map((media) => ({ id: media.id, type: media.type, originalName: media.originalName, mimeType: media.mimeType, fileSize: media.fileSize, sortOrder: media.sortOrder, previewUrl: this.media.previewUrl(media.id) })) }; }
  private async cleanupAssets(ids: string[]): Promise<void> { for (const id of ids) { if (this.drafts.mediaReferenceCount(id) !== 0) continue; const asset = this.drafts.mediaAsset(id); if (!asset) continue; try { await this.media.deleteManagedFile(asset.local_path); this.drafts.deleteAsset(id); } catch { /* preserve recoverable orphan metadata */ } } }
  private auditSafe(eventType: string, message: string, metadata: string): void { try { this.audit.add({ eventType, message, metadata }); } catch { /* best effort */ } }
  private notifySafe(): void { try { this.notify(); } catch { /* renderer may be closing */ } }
}

function plannerBucket(scheduledAt: string | undefined, now: Date): PlannerBucket {
  if (!scheduledAt) return 'UNSCHEDULED'; const target = new Date(scheduledAt); const today = localDay(now); const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  return localDay(target) === today ? 'TODAY' : localDay(target) === localDay(tomorrow) ? 'TOMORROW' : 'LATER';
}
function localDay(value: Date): string { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
