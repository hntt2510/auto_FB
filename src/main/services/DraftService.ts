import { randomUUID } from 'node:crypto';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { DraftRepository, DraftMediaRecord, DraftRecord } from '@main/db/repositories/DraftRepository';
import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import { AppError } from '@main/errors';
import { draftFilterSchema, draftIdSchema, draftInputSchema, draftStatusSchema, mediaRemoveSchema, mediaReorderSchema } from '@shared/schemas';
import type { Draft, DraftFilter, DraftInput, DraftMedia, DraftStatus, MediaReorderInput } from '@shared/types';
import { MediaStorageService } from './MediaStorageService';

export class DraftService {
  constructor(private readonly drafts: DraftRepository, private readonly queue: QueueRepository, private readonly media: MediaStorageService, private readonly audit: AuditLogRepository, private readonly notify: () => void) {}

  list(filter?: DraftFilter): Draft[] { const parsed = draftFilterSchema.safeParse(filter ?? {}); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid draft filter.'); return this.drafts.list(parsed.data).map((draft) => this.publicDraft(draft)); }
  get(draftId: string): Draft { const draft = this.drafts.get(this.validId(draftId)); if (!draft) throw new AppError('DRAFT_NOT_FOUND', 'Draft not found.'); return this.publicDraft(draft); }

  create(input: DraftInput): Draft { const data = this.parseInput(input); const draft = this.drafts.insert(randomUUID(), data, new Date().toISOString()); this.auditSafe('DRAFT_CREATED', `Draft ${draft.title} created.`, draft.id); this.notifySafe(); return this.publicDraft(draft); }
  update(draftId: string, input: DraftInput): Draft { const id = this.validId(draftId); this.get(id); const draft = this.drafts.update(id, this.parseInput(input)); this.auditSafe('DRAFT_UPDATED', `Draft ${draft.title} updated.`, draft.id); this.notifySafe(); return this.publicDraft(draft); }
  duplicate(draftId: string): Draft { const source = this.drafts.get(this.validId(draftId)); if (!source) throw new AppError('DRAFT_NOT_FOUND', 'Draft not found.'); const draft = this.drafts.duplicate(source, randomUUID(), new Date().toISOString()); this.auditSafe('DRAFT_CREATED', `Draft ${draft.title} duplicated.`, draft.id); this.notifySafe(); return this.publicDraft(draft); }

  setStatus(draftId: string, status: DraftStatus): Draft {
    const parsed = draftStatusSchema.safeParse({ draftId, status }); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid draft status.');
    const current = this.drafts.get(parsed.data.draftId); if (!current) throw new AppError('DRAFT_NOT_FOUND', 'Draft not found.');
    const draft = this.drafts.setStatus(parsed.data.draftId, status); this.auditSafe(status === 'READY' ? 'DRAFT_READY' : status === 'ARCHIVED' ? 'DRAFT_ARCHIVED' : 'DRAFT_UPDATED', `Draft ${draft.title} marked ${status}.`, draft.id); this.notifySafe(); return this.publicDraft(draft);
  }

  async delete(draftId: string): Promise<void> {
    const id = this.validId(draftId); const draft = this.drafts.get(id); if (!draft) throw new AppError('DRAFT_NOT_FOUND', 'Draft not found.');
    if (this.queue.hasActiveForDraft(id)) throw new AppError('ENTITY_IN_USE', 'Cancel or remove active queue items before deleting this draft.');
    try {
      const assetIds = this.drafts.delete(id);
      await this.cleanupAssets(assetIds);
      this.auditSafe('DRAFT_DELETED', `Draft ${draft.title} deleted.`, id); this.notifySafe();
    } catch (error) {
      if (String(error).toLowerCase().includes('foreign key')) {
        throw new AppError('ENTITY_IN_USE', 'Draft cannot be deleted because it is referenced by a campaign.');
      }
      throw error;
    }
  }

  async addMedia(draftId: string): Promise<DraftMedia | undefined> {
    const id = this.validId(draftId); const draft = this.drafts.get(id); if (!draft) throw new AppError('DRAFT_NOT_FOUND', 'Draft not found.');
    const file = await this.media.chooseAndCopy(); if (!file) return undefined;
    try {
      const media = this.drafts.insertAssetAndAttach(file, id, draft.media.length, new Date().toISOString());
      this.auditSafe('MEDIA_ADDED', `Media added to draft ${draft.title}.`, id); this.notifySafe(); return this.publicMedia(media);
    } catch (error) {
      await this.media.deleteManagedFile(file.localPath).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError('DATABASE_ERROR', 'Unable to save media metadata.');
    }
  }

  async removeMedia(draftId: string, mediaId: string): Promise<void> {
    const parsed = mediaRemoveSchema.safeParse({ draftId, mediaId }); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid media request.');
    const result = this.drafts.removeMedia(parsed.data.draftId, parsed.data.mediaId); if (!result) throw new AppError('MEDIA_NOT_FOUND', 'Media is not attached to this draft.');
    await this.cleanupAssets([result.assetId]); this.auditSafe('MEDIA_REMOVED', 'Draft media removed.', parsed.data.draftId); this.notifySafe();
  }

  reorderMedia(input: MediaReorderInput): Draft {
    const parsed = mediaReorderSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid media order.');
    const current = this.drafts.get(parsed.data.draftId); if (!current) throw new AppError('DRAFT_NOT_FOUND', 'Draft not found.');
    const existing = new Set(current.media.map((media) => media.id)); if (existing.size !== parsed.data.mediaIds.length || parsed.data.mediaIds.some((id) => !existing.has(id))) throw new AppError('INVALID_REQUEST', 'Media order does not match the draft.');
    this.drafts.reorderMedia(parsed.data.draftId, parsed.data.mediaIds); this.notifySafe(); return this.publicDraft(this.drafts.get(parsed.data.draftId)!);
  }

  private async cleanupAssets(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (this.drafts.mediaReferenceCount(id) !== 0) continue;
      const asset = this.drafts.mediaAsset(id); if (!asset) continue;
      try { await this.media.deleteManagedFile(asset.local_path); this.drafts.deleteAsset(id); } catch { /* preserve orphan metadata for recoverable cleanup */ }
    }
  }
  private publicDraft(draft: DraftRecord): Draft { return { ...draft, media: draft.media.map((media) => this.publicMedia(media)) }; }
  private publicMedia(media: DraftMediaRecord): DraftMedia { return { id: media.id, draftId: media.draftId, type: media.type, originalName: media.originalName, mimeType: media.mimeType, fileSize: media.fileSize, sortOrder: media.sortOrder, previewUrl: this.media.previewUrl(media.id), createdAt: media.createdAt }; }
  private parseInput(input: DraftInput): DraftInput { const parsed = draftInputSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid draft.'); return parsed.data; }
  private validId(value: string): string { const parsed = draftIdSchema.safeParse(value); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid draft id.'); return parsed.data; }
  private auditSafe(eventType: string, message: string, draftId: string): void { try { this.audit.add({ eventType, message, metadata: JSON.stringify({ draftId }) }); } catch { /* best effort */ } }
  private notifySafe(): void { try { this.notify(); } catch { /* renderer may be closing */ } }
}
