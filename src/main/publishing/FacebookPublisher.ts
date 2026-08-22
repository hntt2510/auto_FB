import type { Page } from 'playwright';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { PublishingSettings } from '@shared/types';
import { AppError } from '@main/errors';
import { MediaStorageService } from '@main/services/MediaStorageService';
import { FacebookComposerAdapter, type SubmissionEvidence } from './FacebookComposerAdapter';
import type { PreflightResult } from '@shared/types';
import { PublishingError } from './PublishingError';

export type PublishMilestone = 'ACCOUNT_READY' | 'GROUP_OPENED' | 'COMPOSER_OPENED' | 'CONTENT_FILLED' | 'MEDIA_UPLOADED' | 'SUBMITTING' | 'POST_CLICKED';

export class FacebookPublisher {
  constructor(private readonly adapter: FacebookComposerAdapter, private readonly media: MediaStorageService) {}

  get selectorsVersion(): string { return this.adapter.selectorsVersion; }

  async publish(page: Page, item: QueueRecord, settings: PublishingSettings, milestone: (event: PublishMilestone) => void, signal?: AbortSignal): Promise<SubmissionEvidence> {
    this.assertNotCancelled(signal); milestone('ACCOUNT_READY');
    const paths = await this.validateMedia(item);
    try { await this.adapter.openGroup(page, item.groupUrl); }
    catch (error) {
      if (!(error instanceof PublishingError) || error.code !== 'NETWORK_ERROR') throw error;
      this.assertNotCancelled(signal); await this.adapter.openGroup(page, item.groupUrl);
    }
    milestone('GROUP_OPENED'); this.assertNotCancelled(signal); const baseline = await this.adapter.captureBaseline(page, item.body);
    const composer = await this.adapter.openComposer(page); milestone('COMPOSER_OPENED');
    await this.adapter.fillContent(composer, item.body, item.linkUrl); milestone('CONTENT_FILLED'); this.assertNotCancelled(signal);
    if (paths.length) { await this.adapter.uploadMedia(page, paths, item.media.some((asset) => asset.type === 'VIDEO'), settings.videoUploadTimeoutSeconds, composer.container); milestone('MEDIA_UPLOADED'); }
    this.assertNotCancelled(signal);
    const result = await this.adapter.submit(page, composer, baseline, item.groupUrl, () => milestone('SUBMITTING')); milestone('POST_CLICKED'); return result;
  }

  async preflight(page: Page, item: QueueRecord, fillContent = false): Promise<PreflightResult> {
    await this.validateMedia(item);
    const result = await this.adapter.preflight(page, item, fillContent);
    return { ...result.probe, queueItemId: item.id, accountReady: result.probe.session.status === 'FOUND', groupOpened: result.probe.group.status === 'FOUND', composerFound: result.probe.composerTrigger.status === 'FOUND', textboxFound: result.probe.composerTextbox.status === 'FOUND', mediaInputFound: result.probe.mediaInput.status === 'FOUND', postButtonFound: result.probe.postButton.status === 'FOUND', passed: result.probe.status === 'FOUND', filledContent: result.filledContent };
  }

  private async validateMedia(item: QueueRecord): Promise<string[]> {
    const ordered = item.media.slice().sort((a, b) => a.sortOrder - b.sortOrder); const paths: string[] = [];
    for (const asset of ordered) { try { paths.push(await this.media.validateManagedFile(asset.localPath, asset.type)); } catch (error) { if (error instanceof AppError) throw new PublishingError('MEDIA_FILE_MISSING', 'A snapshotted media file is missing or invalid.'); throw error; } }
    return paths;
  }

  private assertNotCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new PublishingError('EXECUTION_CANCELLED', 'Publishing execution was cancelled.'); }
}
