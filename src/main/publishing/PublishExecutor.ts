import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { GroupRepository } from '@main/db/repositories/GroupRepository';
import type { PublishRepository } from '@main/db/repositories/PublishRepository';
import type { QueueRepository, QueueRecord } from '@main/db/repositories/QueueRepository';
import type { BrowserManager } from '@main/browser/BrowserManager';
import type { ProfileManager } from '@main/browser/ProfileManager';
import { AppError, sanitizeMessage } from '@main/errors';
import { normalizeFacebookGroupUrl } from '@shared/groupUrl';
import type { PreflightResult, PublishAttemptStatus, PublishingSettings, QueueStatus, SelectorProbeResult } from '@shared/types';
import { FacebookPublisher, type PublishMilestone } from './FacebookPublisher';
import { PublishingError } from './PublishingError';
import { PublishDiagnostics } from './PublishDiagnostics';
import type { LiveReadinessService } from './LiveReadinessService';

export const RECOVERABLE_PREFLIGHT_REASONS = new Set(['PREFLIGHT_MISSING', 'PREFLIGHT_EXPIRED', 'PREFLIGHT_SELECTOR_VERSION_MISMATCH']);

export type ExecutionOutcome = { started: boolean; finalStatus?: QueueStatus };

export class PublishExecutor {
  constructor(private readonly queue: QueueRepository, private readonly attempts: PublishRepository, private readonly accounts: AccountRepository, private readonly groups: GroupRepository, private readonly profiles: ProfileManager, private readonly browser: BrowserManager, private readonly publisher: FacebookPublisher, private readonly diagnostics: PublishDiagnostics, private readonly audit: AuditLogRepository, private readonly notify: () => void, private readonly readiness?: LiveReadinessService) {}

  get selectorVersion(): string { return this.publisher.selectorsVersion; }

  async execute(queueItemId: string, settings: PublishingSettings, signal?: AbortSignal, shouldStop?: () => boolean): Promise<ExecutionOutcome> {
    const before = this.queue.get(queueItemId); if (!before || before.status !== 'PENDING' || !before.accountId || settings.executionMode !== 'LIVE') return { started: false };
    if (signal?.aborted || shouldStop?.()) return { started: false };
    if (!this.readiness) throw new AppError('LIVE_READINESS_FAILED', 'Live readiness service is unavailable. Run a fresh preflight first.');
    this.readiness.setSelectorVersion(this.publisher.selectorsVersion);
    if (settings.canaryMode === true) {
      const live = await this.readiness.evaluate(before, settings);
      if (!live.ready) throw new AppError('LIVE_READINESS_FAILED', 'Live canary is not ready: ' + live.reasons.join(', ') + '.');
    } else {
      let live = await this.readiness.evaluate(before, settings);
      if (!live.ready) {
        const onlyRecoverable = live.reasons.length > 0 && live.reasons.every((r) => RECOVERABLE_PREFLIGHT_REASONS.has(r));
        if (onlyRecoverable) {
          if (signal?.aborted || shouldStop?.()) return { started: false };
          try {
            await this.preflight(before, settings, true, signal);
          } catch {
            // Failure will be captured by re-evaluating readiness below
          }
          if (signal?.aborted || shouldStop?.()) return { started: false };
          live = await this.readiness.evaluate(before, settings);
        }
        if (!live.ready) {
          throw new AppError('LIVE_READINESS_FAILED', 'Live readiness blocked: ' + live.reasons.join(', ') + '.');
        }
      }
    }
    if (signal?.aborted || shouldStop?.()) return { started: false };
    if (this.attempts.isBlocked(before.accountId)) return { started: false };
    const claim = this.attempts.claim(queueItemId, { executionMode: settings.executionMode, selectorVersion: this.publisher.selectorsVersion }); if (!claim) return { started: false };
    const { token, attempt } = claim; const item = this.queue.get(queueItemId)!; let finalized = false;
    this.auditSafe(item.accountId, 'PUBLISH_STARTED', 'Publishing attempt claimed.', item.id);
    try {
      const account = item.accountId ? this.accounts.get(item.accountId) : undefined; const group = item.groupId ? this.groups.get(item.groupId) : undefined;
      if (!account || !group || !group.active || !this.groups.assignments(group.id).some((assigned) => assigned.id === account.id)) throw new PublishingError('GROUP_UNAVAILABLE', 'The account/group assignment is no longer valid.');
      normalizeFacebookGroupUrl(item.groupUrl); try { this.profiles.assertControlledDirectory(account.profileDirectory); } catch { throw new PublishingError('GROUP_UNAVAILABLE', 'The account profile is no longer available for publishing.'); }
      if (this.attempts.isBlocked(account.id)) throw new PublishingError('ACCOUNT_CHECKPOINT', 'Publishing is paused for this account.');
      const result = await this.browser.withAccountPage(account.id, async (page) => {
        try { return await this.publisher.publish(page, item, settings, (event, detail) => this.recordMilestone(attempt.id, event, detail), signal); }
        catch (error) {
          const publishing = error instanceof PublishingError ? error : new PublishingError('BROWSER_CLOSED', 'The browser closed during publishing.', this.irreversible(attempt.id));
          if (!['ACCOUNT_LOGIN_REQUIRED', 'ACCOUNT_CHECKPOINT'].includes(publishing.code)) { const path = await this.diagnostics.capture(page, attempt.id, publishing.code); if (path) this.attempts.setDiagnostic(attempt.id, path); }
          throw publishing;
        }
      });
      if (result.result === 'VERIFIED_PUBLISHED' && result.postUrl) { this.attempts.finalizeSuccess(item.id, token, attempt.id, item.groupUrl, result.postUrl, result.evidence); finalized = true; this.auditSafe(account.id, 'PUBLISH_SUCCEEDED', 'Facebook publication was verified.', item.id); }
      else if (result.result === 'VERIFIED_PUBLISHED') { this.attempts.finalizeUnknown(item.id, token, attempt.id, item.groupUrl, 'Facebook reported success without an observed post URL.'); finalized = true; this.auditSafe(account.id, 'PUBLISH_NEEDS_ATTENTION', 'Facebook reported success without a verifiable post URL.', item.id); }
      else if (result.result === 'UNKNOWN') { this.attempts.finalizeUnknown(item.id, token, attempt.id, item.groupUrl, result.evidence); finalized = true; this.auditSafe(account.id, 'PUBLISH_NEEDS_ATTENTION', 'Facebook submission result requires manual review.', item.id); }
      else { this.attempts.finalizeSubmission(item.id, token, attempt.id, item.groupUrl, result.result, result.evidence); finalized = true; this.auditSafe(account.id, 'PUBLISH_SUBMITTED', result.result === 'SUBMITTED_PENDING_APPROVAL' ? 'Facebook submission is pending group approval.' : 'Facebook accepted the submission interaction.', item.id); }
      return { started: true, finalStatus: this.queue.get(item.id)?.status };
    } catch (error) {
      if (finalized) return { started: true, finalStatus: this.queue.get(item.id)?.status };
      const publishing = error instanceof PublishingError ? error : new PublishingError('BROWSER_CLOSED', 'Publishing stopped unexpectedly.', this.irreversible(attempt.id));
      const message = sanitizeMessage(publishing.message); const security = publishing.code === 'ACCOUNT_LOGIN_REQUIRED' || publishing.code === 'ACCOUNT_CHECKPOINT'; const ambiguous = publishing.afterSubmit || this.irreversible(attempt.id) || security || publishing.code === 'GROUP_UNAVAILABLE' || publishing.code === 'MEDIA_FILE_MISSING';
      if (item.accountId && publishing.code === 'NETWORK_ERROR' && this.accounts.get(item.accountId)?.proxyEnabled) {
        try { this.accounts.setProxyTest(item.accountId, { success: false, errorCode: 'PROXY_CONNECTION_FAILED', message: 'Network operation through the fixed proxy failed.', testedAt: new Date().toISOString() }); } catch { /* queue failure remains authoritative */ }
      }
      if (item.accountId && security) { const health = publishing.code === 'ACCOUNT_LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : 'CHECKPOINT'; this.accounts.setHealth(item.accountId, health, new Date().toISOString(), message); this.attempts.blockAccount(item.accountId, item.accountName, health, message); this.auditSafe(item.accountId, 'ACCOUNT_PUBLISHING_PAUSED', message, item.id); }
      if (ambiguous) { const receipt = publishing.afterSubmit || this.irreversible(attempt.id) ? { result: 'UNKNOWN' as const, groupUrl: item.groupUrl, evidence: message } : undefined; this.attempts.finalizeNeedsAttention(item.id, token, attempt.id, message, receipt); finalized = true; this.auditSafe(item.accountId, 'PUBLISH_NEEDS_ATTENTION', message, item.id); }
      else { this.attempts.finalizeFailure(item.id, token, attempt.id, publishing.code, message); finalized = true; this.auditSafe(item.accountId, 'PUBLISH_FAILED', message, item.id); }
      return { started: true, finalStatus: this.queue.get(item.id)?.status };
    } finally { this.notifySafe(); }
  }

  async preflight(item: QueueRecord, settings: PublishingSettings, fillContent = false, signal?: AbortSignal): Promise<PreflightResult> {
    if (signal?.aborted) throw new PublishingError('EXECUTION_CANCELLED', 'Publishing execution was cancelled.');
    void settings;
    const account = item.accountId ? this.accounts.get(item.accountId) : undefined; const group = item.groupId ? this.groups.get(item.groupId) : undefined;
    if (!account || !group || !group.active || !item.accountId || !item.groupId) throw new PublishingError('GROUP_UNAVAILABLE', 'The account/group target is no longer available.');
    this.profiles.assertControlledDirectory(account.profileDirectory);
    const result = await this.browser.withAccountPage(account.id, (page) => this.publisher.preflight(page, item, fillContent, settings, async (activePage, status) => this.diagnostics.capturePreflight(activePage, item.id, status), signal));
    this.attempts.recordSelectorProbe(result);
    const preflight = { ...result, filledContent: fillContent ? Boolean(result.contentObserved) : false };
    this.attempts.recordPreflight(preflight); this.notifySafe(); return preflight;
  }

  async probe(item: QueueRecord): Promise<SelectorProbeResult> { const result = await this.preflight(item, { enabled: false, executionMode: 'DRY_RUN', schedulerIntervalSeconds: 30, maxConcurrentAccounts: 1, videoUploadTimeoutSeconds: 60, maxJobsPerSchedulerSession: 20, batchPacingSeconds: 120 }, false); return result; }

  private recordMilestone(attemptId: string, event: PublishMilestone, detail?: string): void { this.attempts.addEvent(attemptId, event, detail); const status: Partial<Record<PublishMilestone, PublishAttemptStatus>> = { COMPOSER_OPENED: 'COMPOSER_OPENED', CONTENT_FILLED: 'CONTENT_FILLED', MEDIA_UPLOADED: 'MEDIA_UPLOADED', SUBMITTING: 'SUBMITTING' }; if (status[event]) this.attempts.setAttemptStatus(attemptId, status[event]!); }
  private irreversible(attemptId: string): boolean { return this.attempts.getAttempt(attemptId)?.irreversibleReached ?? false; }
  private auditSafe(accountId: string | undefined, eventType: string, message: string, queueId: string): void { try { this.audit.add({ accountId, eventType, message, metadata: JSON.stringify({ queueId }) }); } catch { /* best effort */ } }
  private notifySafe(): void { try { this.notify(); } catch { /* renderer may be closing */ } }
}
