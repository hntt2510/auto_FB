import type { Page } from 'playwright';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { PublishingSettings } from '@shared/types';
import { AppError } from '@main/errors';
import { MediaStorageService } from '@main/services/MediaStorageService';
import { FacebookComposerAdapter, type SubmissionEvidence } from './FacebookComposerAdapter';
import { PublishingError } from './PublishingError';

export type PublishMilestone = 'ACCOUNT_READY' | 'GROUP_OPENED' | 'COMPOSER_OPENED' | 'CONTENT_FILLED' | 'MEDIA_UPLOADED' | 'SUBMITTING' | 'POST_CLICKED';

export class FacebookPublisher {
  constructor(private readonly adapter: FacebookComposerAdapter, private readonly media: MediaStorageService) {}

  async publish(page: Page, item: QueueRecord, settings: PublishingSettings, milestone: (event: PublishMilestone) => void, signal?: AbortSignal): Promise<SubmissionEvidence> {
    this.assertNotCancelled(signal); milestone('ACCOUNT_READY');
    try { await this.adapter.openGroup(page, item.groupUrl); }
    catch (error) {
      if (!(error instanceof PublishingError) || error.code !== 'NETWORK_ERROR') throw error;
      this.assertNotCancelled(signal); await this.adapter.openGroup(page, item.groupUrl);
    }
    milestone('GROUP_OPENED'); this.assertNotCancelled(signal);
    const textbox = await this.adapter.openComposer(page); milestone('COMPOSER_OPENED');
    await this.adapter.fillContent(textbox, item.body, item.linkUrl); milestone('CONTENT_FILLED'); this.assertNotCancelled(signal);
    const ordered = item.media.slice().sort((a, b) => a.sortOrder - b.sortOrder); const paths: string[] = [];
    for (const asset of ordered) {
      try { paths.push(await this.media.validateManagedFile(asset.localPath, asset.type)); }
      catch (error) { if (error instanceof AppError) throw new PublishingError('MEDIA_FILE_MISSING', 'A snapshotted media file is missing or invalid.'); throw error; }
    }
    if (paths.length) { await this.adapter.uploadMedia(page, paths, ordered.some((asset) => asset.type === 'VIDEO'), settings.videoUploadTimeoutSeconds); milestone('MEDIA_UPLOADED'); }
    this.assertNotCancelled(signal);
    const result = await this.adapter.submit(page, () => milestone('SUBMITTING')); milestone('POST_CLICKED'); return result;
  }

  private assertNotCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new PublishingError('EXECUTION_CANCELLED', 'Publishing execution was cancelled.'); }
}
