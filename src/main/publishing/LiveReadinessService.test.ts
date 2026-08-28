import { describe, expect, it, vi } from 'vitest';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { PublishingSettings } from '@shared/types';
import { LiveReadinessService } from './LiveReadinessService';
import { FACEBOOK_SELECTORS_VERSION } from './selectors/facebookSelectors';

const accountId = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
const queueItem: QueueRecord = { id: '33333333-3333-4333-8333-333333333333', accountId, groupId, draftTitle: 'Snapshot', body: 'Body', accountName: 'FB01', groupName: 'Group', groupUrl: 'https://www.facebook.com/groups/demo', status: 'PENDING', media: [], snapshotHash: 'hash', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const settings: PublishingSettings = { enabled: true, executionMode: 'LIVE', schedulerIntervalSeconds: 30, maxConcurrentAccounts: 1, videoUploadTimeoutSeconds: 600, maxJobsPerSchedulerSession: 20, batchPacingSeconds: 120, canaryMode: true };

describe('LiveReadinessService', () => {
  it('allows only a fresh matching preflight', async () => {
    const accounts = { get: vi.fn(() => ({ id: accountId, status: 'STOPPED', lastHealthStatus: 'READY' })) };
    const groups = { get: vi.fn(() => ({ id: groupId, active: true })), assignments: vi.fn(() => [{ id: accountId }]) };
    const attempts = { isBlocked: vi.fn(() => false), latestPreflight: vi.fn(() => ({ id: 'preflight', checkedAt: new Date().toISOString(), selectorVersion: FACEBOOK_SELECTORS_VERSION, snapshotHash: 'hash', status: 'PASSED' })) };
    const media = { validateManagedFile: vi.fn(async () => queueItem.media) };
    const service = new LiveReadinessService(accounts as never, groups as never, attempts as never, media as never);
    await expect(service.evaluate(queueItem, settings)).resolves.toEqual({ ready: true, preflightId: 'preflight' });
    attempts.latestPreflight.mockReturnValue({ id: 'old', checkedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(), selectorVersion: FACEBOOK_SELECTORS_VERSION, snapshotHash: 'other', status: 'PASSED' });
    const result = await service.evaluate(queueItem, settings);
    expect(result).toEqual({ ready: false, reasons: expect.arrayContaining(['PREFLIGHT_EXPIRED', 'PREFLIGHT_SNAPSHOT_MISMATCH']) });
  });

  it('rejects disabled engines and missing assignments', async () => {
    const accounts = { get: vi.fn(() => undefined) };
    const groups = { get: vi.fn(() => undefined), assignments: vi.fn(() => []) };
    const attempts = { isBlocked: vi.fn(() => false), latestPreflight: vi.fn(() => undefined) };
    const media = { validateManagedFile: vi.fn() };
    const service = new LiveReadinessService(accounts as never, groups as never, attempts as never, media as never);
    const result = await service.evaluate(queueItem, { ...settings, enabled: false });
    expect(result).toEqual({ ready: false, reasons: expect.arrayContaining(['ENGINE_DISABLED', 'ASSIGNMENT_MISSING', 'PREFLIGHT_MISSING']) });
  });
});
