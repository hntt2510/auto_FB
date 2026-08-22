import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { GroupRepository } from '@main/db/repositories/GroupRepository';
import type { PublishRepository } from '@main/db/repositories/PublishRepository';
import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import type { BrowserManager } from '@main/browser/BrowserManager';
import type { ProfileManager } from '@main/browser/ProfileManager';
import { sanitizeMessage } from '@main/errors';
import { normalizeFacebookGroupUrl } from '@shared/groupUrl';
import type { PublishAttemptStatus, PublishingSettings } from '@shared/types';
import { FacebookPublisher, type PublishMilestone } from './FacebookPublisher';
import { PublishingError } from './PublishingError';
import { PublishDiagnostics } from './PublishDiagnostics';

export type ExecutionOutcome = 'COMPLETED' | 'SKIPPED';

export class PublishExecutor {
  constructor(private readonly queue: QueueRepository, private readonly attempts: PublishRepository, private readonly accounts: AccountRepository, private readonly groups: GroupRepository, private readonly profiles: ProfileManager, private readonly browser: BrowserManager, private readonly publisher: FacebookPublisher, private readonly diagnostics: PublishDiagnostics, private readonly audit: AuditLogRepository, private readonly notify: () => void) {}

  async execute(queueItemId: string, settings: PublishingSettings, signal?: AbortSignal): Promise<ExecutionOutcome> {
    const before = this.queue.get(queueItemId); if (!before || before.status !== 'PENDING' || !before.accountId || this.attempts.isBlocked(before.accountId)) return 'SKIPPED';
    const claim = this.attempts.claim(queueItemId); if (!claim) return 'SKIPPED';
    const { token, attempt } = claim; const item = this.queue.get(queueItemId)!; const claimState = { finished: false };
    const finishClaim = (status: 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'NEEDS_ATTENTION', reason?: string): void => {
      if (claimState.finished) return;
      try {
        if (reason === undefined) this.queue.finishClaim(item.id, token, status);
        else this.queue.finishClaim(item.id, token, status, reason);
        claimState.finished = true;
      }
      catch (error) {
        const current = this.queue.get(item.id);
        if (current?.status === status) { claimState.finished = true; return; }
        throw error;
      }
    };
    this.auditSafe(item.accountId, 'PUBLISH_STARTED', 'Publishing attempt claimed.', item.id);
    try {
      const account = item.accountId ? this.accounts.get(item.accountId) : undefined; const group = item.groupId ? this.groups.get(item.groupId) : undefined;
      if (!account || !group || !group.active || !this.groups.assignments(group.id).some((assigned) => assigned.id === account.id)) throw new PublishingError('GROUP_UNAVAILABLE', 'The account/group assignment is no longer valid.');
      normalizeFacebookGroupUrl(item.groupUrl); try { this.profiles.assertControlledDirectory(account.profileDirectory); } catch { throw new PublishingError('GROUP_UNAVAILABLE', 'The account profile is no longer available for publishing.'); }
      if (this.attempts.isBlocked(account.id)) throw new PublishingError('ACCOUNT_CHECKPOINT', 'Publishing is paused for this account.');
      const result = await this.browser.withAccountPage(account.id, async (page) => {
        try { return await this.publisher.publish(page, item, settings, (event) => this.recordMilestone(attempt.id, event), signal); }
        catch (error) {
          const publishing = error instanceof PublishingError ? error : new PublishingError('BROWSER_CLOSED', 'The browser closed during publishing.', this.irreversible(attempt.id));
          if (!['ACCOUNT_LOGIN_REQUIRED', 'ACCOUNT_CHECKPOINT'].includes(publishing.code)) { const path = await this.diagnostics.capture(page, attempt.id, publishing.code); if (path) this.attempts.setDiagnostic(attempt.id, path); }
          throw publishing;
        }
      });
      this.attempts.createReceipt(item.id, attempt.id, result.result, item.groupUrl, result.postUrl, result.evidence);
      if (result.result === 'VERIFIED_PUBLISHED') { this.attempts.addEvent(attempt.id, 'VERIFIED', result.evidence); this.attempts.setAttemptStatus(attempt.id, 'SUCCEEDED', undefined, undefined, true); finishClaim('SUCCEEDED'); this.auditSafe(account.id, 'PUBLISH_SUCCEEDED', 'Facebook publication was verified.', item.id); }
      else if (result.result === 'UNKNOWN') { this.attempts.setAttemptStatus(attempt.id, 'NEEDS_ATTENTION', 'SUBMISSION_UNKNOWN', result.evidence, true); finishClaim('NEEDS_ATTENTION', 'Submission result is unknown. Confirm Facebook state before retrying.'); this.auditSafe(account.id, 'PUBLISH_NEEDS_ATTENTION', 'Facebook submission result requires manual review.', item.id); }
      else { this.attempts.addEvent(attempt.id, 'SUBMITTED', result.evidence); this.attempts.setAttemptStatus(attempt.id, 'SUBMITTED', undefined, undefined, true); finishClaim('SUBMITTED'); this.auditSafe(account.id, 'PUBLISH_SUBMITTED', result.result === 'SUBMITTED_PENDING_APPROVAL' ? 'Facebook submission is pending group approval.' : 'Facebook accepted the submission interaction.', item.id); }
      return 'COMPLETED';
    } catch (error) {
      const publishing = error instanceof PublishingError ? error : new PublishingError('BROWSER_CLOSED', 'Publishing stopped unexpectedly.', this.irreversible(attempt.id));
      const message = sanitizeMessage(publishing.message); const security = publishing.code === 'ACCOUNT_LOGIN_REQUIRED' || publishing.code === 'ACCOUNT_CHECKPOINT'; const ambiguous = publishing.afterSubmit || this.irreversible(attempt.id) || security || publishing.code === 'GROUP_UNAVAILABLE' || publishing.code === 'MEDIA_FILE_MISSING';
      if (item.accountId && security) {
        const health = publishing.code === 'ACCOUNT_LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : 'CHECKPOINT'; this.accounts.setHealth(item.accountId, health, new Date().toISOString(), message); this.attempts.blockAccount(item.accountId, item.accountName, health, message); this.auditSafe(item.accountId, 'ACCOUNT_PUBLISHING_PAUSED', message, item.id);
      }
      if (ambiguous) {
        if ((publishing.afterSubmit || this.irreversible(attempt.id)) && !this.attempts.attempts(item.id).find((value) => value.id === attempt.id)?.receipt) this.attempts.createReceipt(item.id, attempt.id, 'UNKNOWN', item.groupUrl, undefined, message);
        this.attempts.setAttemptStatus(attempt.id, 'NEEDS_ATTENTION', publishing.code, message, true); finishClaim('NEEDS_ATTENTION', message); this.auditSafe(item.accountId, 'PUBLISH_NEEDS_ATTENTION', message, item.id);
      } else {
        this.attempts.setAttemptStatus(attempt.id, 'FAILED', publishing.code, message, true); finishClaim('FAILED', message); this.auditSafe(item.accountId, 'PUBLISH_FAILED', message, item.id);
      }
      return 'COMPLETED';
    } finally { this.notifySafe(); }
  }

  private recordMilestone(attemptId: string, event: PublishMilestone): void {
    this.attempts.addEvent(attemptId, event);
    const status: Partial<Record<PublishMilestone, PublishAttemptStatus>> = { COMPOSER_OPENED: 'COMPOSER_OPENED', CONTENT_FILLED: 'CONTENT_FILLED', MEDIA_UPLOADED: 'MEDIA_UPLOADED', SUBMITTING: 'SUBMITTING' };
    if (status[event]) this.attempts.setAttemptStatus(attemptId, status[event]!);
  }

  private irreversible(attemptId: string): boolean { return this.attempts.getAttempt(attemptId)?.irreversibleReached ?? false; }
  private auditSafe(accountId: string | undefined, eventType: string, message: string, queueId: string): void { try { this.audit.add({ accountId, eventType, message, metadata: JSON.stringify({ queueId }) }); } catch { /* best effort */ } }
  private notifySafe(): void { try { this.notify(); } catch { /* renderer may be closing */ } }
}
