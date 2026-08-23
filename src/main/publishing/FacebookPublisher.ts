import type { Page } from 'playwright';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { PublishingSettings } from '@shared/types';
import { MediaStorageService } from '@main/services/MediaStorageService';
import { FacebookComposerAdapter, type PostSubmitObservationMilestone, type PreflightDiagnosticCapture, type SubmissionEvidence } from './FacebookComposerAdapter';
import type { PreflightResult } from '@shared/types';
import { PublishingError } from './PublishingError';
import { FacebookMediaUploader } from './FacebookMediaUploader';

export type PublishMilestone = 'ACCOUNT_READY' | 'GROUP_OPENED' | 'COMPOSER_OPENED' | 'CONTENT_FILLED' | 'MEDIA_VALIDATED' | 'MEDIA_UPLOADED' | 'SUBMITTING' | PostSubmitObservationMilestone;

export class FacebookPublisher {
  private readonly mediaUploader: FacebookMediaUploader;
  constructor(private readonly adapter: FacebookComposerAdapter, private readonly media: MediaStorageService) { this.mediaUploader = new FacebookMediaUploader(adapter, media); }

  get selectorsVersion(): string { return this.adapter.selectorsVersion; }

  async publish(page: Page, item: QueueRecord, settings: PublishingSettings, milestone: (event: PublishMilestone, detail?: string) => void, signal?: AbortSignal): Promise<SubmissionEvidence> {
    this.assertNotCancelled(signal); milestone('ACCOUNT_READY');
    const prepared = await this.mediaUploader.prepare(item); const paths = prepared.paths; if (paths.length) milestone('MEDIA_VALIDATED');
    try { await this.adapter.openGroup(page, item.groupUrl); }
    catch (error) {
      if (!(error instanceof PublishingError) || error.code !== 'NETWORK_ERROR') throw error;
      this.assertNotCancelled(signal); await this.adapter.openGroup(page, item.groupUrl);
    }
    milestone('GROUP_OPENED'); this.assertNotCancelled(signal); const baseline = await this.adapter.captureBaseline(page, item.body);
    const composer = await this.adapter.openComposer(page); milestone('COMPOSER_OPENED');
    await this.adapter.fillContent(composer, item.body, item.linkUrl); milestone('CONTENT_FILLED'); this.assertNotCancelled(signal);
    if (paths.length) { await this.mediaUploader.upload(page, paths, item.media.some((asset) => asset.type === 'VIDEO'), settings.videoUploadTimeoutSeconds, composer.container); milestone('MEDIA_UPLOADED'); }
    this.assertNotCancelled(signal);
    return this.adapter.submit(page, composer, baseline, item.groupUrl, () => milestone('SUBMITTING'), (event, detail) => milestone(event, detail));
  }

  async preflight(page: Page, item: QueueRecord, fillContent = false, settings?: PublishingSettings, captureDiagnostic?: PreflightDiagnosticCapture): Promise<PreflightResult> {
    if (settings && item.media.some((asset) => asset.type === 'VIDEO') && (!Number.isInteger(settings.videoUploadTimeoutSeconds) || settings.videoUploadTimeoutSeconds < 60)) throw new PublishingError('MEDIA_UPLOAD_TIMEOUT', 'Video readiness timeout is invalid.');
    const prepared = await this.mediaUploader.prepare(item);
    const result = await this.adapter.preflight(page, item, fillContent, captureDiagnostic);
    const mediaRequired = item.media.length > 0; const mediaInputFound = result.probe.mediaInput.status === 'FOUND';
    const mediaReport = { ...prepared.report, items: prepared.report.items.map((item) => ({ ...item, facebookMediaInput: mediaRequired ? mediaInputFound ? 'FOUND' as const : 'MISSING' as const : 'NOT_TESTED' as const })) };
    return { ...result.probe, queueItemId: item.id, snapshotHash: item.snapshotHash, accountReady: result.probe.session.status === 'FOUND', groupOpened: result.probe.group.status === 'FOUND', composerFound: result.probe.composerTrigger.status === 'FOUND', textboxFound: result.probe.composerTextbox.status === 'FOUND', mediaInputFound, mediaRequired, mediaValidated: mediaReport.ready, mediaReport, postButtonFound: result.probe.postButton.status === 'FOUND', passed: result.probe.status === 'FOUND' && mediaReport.ready && (!mediaRequired || mediaInputFound), filledContent: result.filledContent };
  }

  private assertNotCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new PublishingError('EXECUTION_CANCELLED', 'Publishing execution was cancelled.'); }
}
