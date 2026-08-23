import type { Locator, Page } from 'playwright';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { MediaPreflightReport } from '@shared/types';
import { MediaStorageService } from '@main/services/MediaStorageService';
import { PublishingError } from './PublishingError';
import type { FacebookComposerAdapter } from './FacebookComposerAdapter';

export type UploadReadinessState = 'FILES_SELECTED' | 'PREVIEW_APPEARED' | 'PROCESSING' | 'READY';

export class FacebookMediaUploader {
  constructor(private readonly adapter: FacebookComposerAdapter, private readonly storage: MediaStorageService) {}

  async prepare(item: QueueRecord): Promise<{ paths: string[]; report: MediaPreflightReport }> {
    const ordered = item.media.slice().sort((a, b) => a.sortOrder - b.sortOrder); const report = await this.storage.preflightReport(ordered);
    if (!report.ready) throw new PublishingError('MEDIA_FILE_MISSING', 'A snapshotted media file is missing, unsafe, or invalid.');
    return { paths: ordered.map((asset) => this.storage.assertManagedPath(asset.localPath)), report };
  }

  async upload(page: Page, paths: string[], hasVideo: boolean, timeoutSeconds: number, container: Locator): Promise<UploadReadinessState> {
    if (!paths.length) return 'READY';
    try { await this.adapter.uploadMedia(page, paths, hasVideo, timeoutSeconds, container); return 'READY'; }
    catch (error) { if (error instanceof PublishingError) throw error; throw new PublishingError('MEDIA_UPLOAD_FAILED', 'Facebook media upload did not become ready.'); }
  }
}
