import { describe, expect, it, vi } from 'vitest';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { PublishingSettings } from '@shared/types';
import { PublishExecutor } from './PublishExecutor';
import { PublishingError } from './PublishingError';

const settings: PublishingSettings = { enabled: true, executionMode: 'LIVE', schedulerIntervalSeconds: 30, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600, maxJobsPerSchedulerSession: 20 };
const item: QueueRecord = { id: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222', groupId: '33333333-3333-4333-8333-333333333333', draftTitle: 'Snapshot', body: 'Body', accountName: 'FB01', groupName: 'Group', groupUrl: 'https://www.facebook.com/groups/test', status: 'PENDING', media: [], snapshotHash: 'hash', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

function fixture(error: PublishingError) {
  const queue = { get: vi.fn(() => item), finishClaim: vi.fn(() => ({ ...item, status: 'NEEDS_ATTENTION' })) };
  const attempt = { id: '44444444-4444-4444-8444-444444444444', queueItemId: item.id, accountId: item.accountId, groupId: item.groupId, attemptNumber: 1, status: 'STARTING', diagnosticAvailable: false, startedAt: new Date().toISOString(), createdAt: new Date().toISOString(), events: [], irreversibleReached: error.afterSubmit };
  const attempts = { isBlocked: vi.fn(() => false), claim: vi.fn(() => ({ token: 'lease', attempt })), addEvent: vi.fn(), setAttemptStatus: vi.fn(), blockAccount: vi.fn(), createReceipt: vi.fn(), finalizeNeedsAttention: vi.fn(), finalizeFailure: vi.fn(), finalizeSuccess: vi.fn(), finalizeSubmission: vi.fn(), finalizeUnknown: vi.fn(), attempts: vi.fn(() => [{ ...attempt, irreversibleReached: error.afterSubmit }]), getAttempt: vi.fn(() => ({ ...attempt, irreversibleReached: error.afterSubmit })), setDiagnostic: vi.fn() };
  const accounts = { get: vi.fn(() => ({ id: item.accountId, name: 'FB01', profileDirectory: 'C:/profiles/fb01', proxyEnabled: true })), setHealth: vi.fn(), setProxyTest: vi.fn() }; const groups = { get: vi.fn(() => ({ id: item.groupId, active: true })), assignments: vi.fn(() => [{ id: item.accountId }]) }; const profiles = { assertControlledDirectory: vi.fn() }; const browser = { withAccountPage: vi.fn(async (_id: string, callback: (page: object) => Promise<unknown>) => callback({})) }; const publisher = { publish: vi.fn(async (): Promise<{ result: 'UNKNOWN'; evidence: string }> => { throw error; }) }; const diagnostics = { capture: vi.fn(async () => undefined) }; const audit = { add: vi.fn() };
  const executor = new PublishExecutor(queue as never, attempts as never, accounts as never, groups as never, profiles as never, browser as never, publisher as never, diagnostics as never, audit as never, vi.fn()); return { executor, queue, attempts, accounts, diagnostics, publisher };
}

describe('PublishExecutor safety boundary', () => {
  it('opens the account circuit and requires attention on checkpoint', async () => {
    const value = fixture(new PublishingError('ACCOUNT_CHECKPOINT', 'Manual user action required.')); await value.executor.execute(item.id, settings);
    expect(value.accounts.setHealth).toHaveBeenCalledWith(item.accountId, 'CHECKPOINT', expect.any(String), expect.any(String)); expect(value.attempts.blockAccount).toHaveBeenCalled(); expect(value.attempts.finalizeNeedsAttention).toHaveBeenCalledWith(item.id, 'lease', expect.any(String), expect.any(String), undefined); expect(value.diagnostics.capture).not.toHaveBeenCalled();
  });

  it('records unknown receipt and never retries after the Post boundary', async () => {
    const value = fixture(new PublishingError('SUBMISSION_UNKNOWN', 'Connection lost after Post.', true)); await value.executor.execute(item.id, settings);
    expect(value.attempts.finalizeNeedsAttention).toHaveBeenCalledWith(item.id, 'lease', expect.any(String), expect.any(String), expect.objectContaining({ result: 'UNKNOWN', groupUrl: item.groupUrl }));
  });

  it('never claims a queue item in dry-run mode', async () => {
    const value = fixture(new PublishingError('SUBMIT_FAILED', 'Dry run should stop before Post.')); const dryRun = { ...settings, executionMode: 'DRY_RUN' as const };
    await expect(value.executor.execute(item.id, dryRun)).resolves.toBe('SKIPPED'); expect(value.attempts.claim).not.toHaveBeenCalled();
  });

  it('moves an evidence-free post-submit result to NEEDS_ATTENTION', async () => {
    const value = fixture(new PublishingError('SUBMISSION_UNKNOWN', 'No evidence.', true)); value.publisher.publish.mockImplementation(async () => ({ result: 'UNKNOWN' as const, evidence: 'No conclusive evidence after observation.' }));
    await value.executor.execute(item.id, settings); expect(value.attempts.finalizeUnknown).toHaveBeenCalledWith(item.id, 'lease', expect.any(String), item.groupUrl, 'No conclusive evidence after observation.');
  });

  it('marks fixed-proxy health failed on a pre-submit network failure without switching network', async () => {
    const value = fixture(new PublishingError('NETWORK_ERROR', 'Facebook group navigation failed.')); await value.executor.execute(item.id, settings);
    expect(value.accounts.setProxyTest).toHaveBeenCalledWith(item.accountId, expect.objectContaining({ success: false, errorCode: 'PROXY_CONNECTION_FAILED' }));
    expect(value.attempts.finalizeFailure).toHaveBeenCalledWith(item.id, 'lease', expect.any(String), 'NETWORK_ERROR', expect.any(String));
  });
});
