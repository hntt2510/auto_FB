import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { GroupRepository } from '@main/db/repositories/GroupRepository';
import type { MediaStorageService } from '@main/services/MediaStorageService';
import type { PublishRepository } from '@main/db/repositories/PublishRepository';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { LiveReadiness, LiveReadinessReason, PublishingSettings } from '@shared/types';
import { FACEBOOK_SELECTORS_VERSION } from './selectors/facebookSelectors';

export const CANARY_PREFLIGHT_TTL_MS = 30 * 60 * 1000;

export class LiveReadinessService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly groups: GroupRepository,
    private readonly attempts: PublishRepository,
    private readonly media: MediaStorageService
  ) { this.selectorVersion = FACEBOOK_SELECTORS_VERSION; }

  async evaluate(queueItem: QueueRecord, settings: PublishingSettings, now = Date.now()): Promise<LiveReadiness> {
    const reasons: LiveReadinessReason[] = [];
    if (!settings.enabled) reasons.push('ENGINE_DISABLED');
    if (settings.executionMode !== 'LIVE') reasons.push('NOT_LIVE_MODE');
    if (!queueItem.accountId || !queueItem.groupId) {
      reasons.push('ASSIGNMENT_MISSING');
      return { ready: false, reasons };
    }

    const account = this.accounts.get(queueItem.accountId);
    const group = this.groups.get(queueItem.groupId);
    if (!account) reasons.push('ASSIGNMENT_MISSING');
    if (!group || !group.active) reasons.push('GROUP_INACTIVE');
    if (account) {
      if (this.attempts.isBlocked(account.id) || account.status === 'ERROR') reasons.push('ACCOUNT_BLOCKED');
      if (account.lastHealthStatus === 'LOGIN_REQUIRED' || account.status === 'LOGIN_REQUIRED') reasons.push('ACCOUNT_LOGIN_REQUIRED');
      if (account.lastHealthStatus === 'CHECKPOINT' || account.status === 'CHECKPOINT') reasons.push('ACCOUNT_CHECKPOINT');
    }
    if (group && account && !this.groups.assignments(group.id).some((assignment) => assignment.id === account.id)) reasons.push('ASSIGNMENT_MISSING');

    for (const asset of queueItem.media) {
      try { await this.media.validateManagedFile(asset.localPath, asset.type); }
      catch { reasons.push('MEDIA_INVALID'); break; }
    }

    const preflight = this.attempts.latestPreflight(queueItem.id);
    if (!preflight || preflight.status !== 'PASSED') reasons.push('PREFLIGHT_MISSING');
    else {
      const checkedAt = Date.parse(preflight.checkedAt);
      if (!Number.isFinite(checkedAt) || now - checkedAt > CANARY_PREFLIGHT_TTL_MS) reasons.push('PREFLIGHT_EXPIRED');
      if (preflight.selectorVersion !== this.selectorVersion) reasons.push('PREFLIGHT_SELECTOR_VERSION_MISMATCH');
      if (preflight.snapshotHash !== queueItem.snapshotHash) reasons.push('PREFLIGHT_SNAPSHOT_MISMATCH');
    }

    if (reasons.length || !preflight) return { ready: false, reasons: [...new Set(reasons)] };
    return { ready: true, preflightId: preflight.id };
  }

  private selectorVersion = '';

  setSelectorVersion(version: string): void { this.selectorVersion = version; }
}

export type LiveReadinessEvaluator = Pick<LiveReadinessService, 'evaluate'>;
