import { describe, expect, it, vi } from 'vitest';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { PublishingSettings } from '@shared/types';
import { PublishExecutor } from './PublishExecutor';
import { PublishingError } from './PublishingError';

const settings: PublishingSettings = { enabled: true, executionMode: 'LIVE', schedulerIntervalSeconds: 30, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600, maxJobsPerSchedulerSession: 20, batchPacingSeconds: 120 };
const item: QueueRecord = { id: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222', groupId: '33333333-3333-4333-8333-333333333333', draftTitle: 'Snapshot', body: 'Body', accountName: 'FB01', groupName: 'Group', groupUrl: 'https://www.facebook.com/groups/test', status: 'PENDING', media: [], snapshotHash: 'hash', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

function fixture(error: PublishingError) {
  const queue = { get: vi.fn(() => item), finishClaim: vi.fn(() => ({ ...item, status: 'NEEDS_ATTENTION' })) };
  const attempt = { id: '44444444-4444-4444-8444-444444444444', queueItemId: item.id, accountId: item.accountId, groupId: item.groupId, attemptNumber: 1, status: 'STARTING', diagnosticAvailable: false, startedAt: new Date().toISOString(), createdAt: new Date().toISOString(), events: [], irreversibleReached: error.afterSubmit };
  const attempts = { isBlocked: vi.fn(() => false), claim: vi.fn(() => ({ token: 'lease', attempt })), addEvent: vi.fn(), setAttemptStatus: vi.fn(), blockAccount: vi.fn(), createReceipt: vi.fn(), finalizeNeedsAttention: vi.fn(), finalizeFailure: vi.fn(), finalizeSuccess: vi.fn(), finalizeSubmission: vi.fn(), finalizeUnknown: vi.fn(), attempts: vi.fn(() => [{ ...attempt, irreversibleReached: error.afterSubmit }]), getAttempt: vi.fn(() => ({ ...attempt, irreversibleReached: error.afterSubmit })), setDiagnostic: vi.fn() };
  const accounts = { get: vi.fn(() => ({ id: item.accountId, name: 'FB01', profileDirectory: 'C:/profiles/fb01', proxyEnabled: true })), setHealth: vi.fn(), setProxyTest: vi.fn() }; const groups = { get: vi.fn(() => ({ id: item.groupId, active: true })), assignments: vi.fn(() => [{ id: item.accountId }]) }; const profiles = { assertControlledDirectory: vi.fn() }; const browser = { withAccountPage: vi.fn(async (_id: string, callback: (page: object) => Promise<unknown>) => callback({})) }; const publisher = { publish: vi.fn(async (): Promise<{ result: 'UNKNOWN'; evidence: string }> => { throw error; }) }; const diagnostics = { capture: vi.fn(async () => undefined) }; const audit = { add: vi.fn() };
  const readiness = { setSelectorVersion: vi.fn(), evaluate: vi.fn(async () => ({ ready: true, preflightId: 'pf-fixture' })) };
  const executor = new PublishExecutor(queue as never, attempts as never, accounts as never, groups as never, profiles as never, browser as never, publisher as never, diagnostics as never, audit as never, vi.fn(), readiness as never); return { executor, queue, attempts, accounts, diagnostics, publisher };
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
    await expect(value.executor.execute(item.id, dryRun)).resolves.toEqual({ started: false }); expect(value.attempts.claim).not.toHaveBeenCalled();
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

function liveReadinessFixture(readinessMock: { evaluate: any; setSelectorVersion?: any }, publishResult?: any) {
  const queue = { get: vi.fn(() => ({ ...item, status: 'PENDING' })) };
  const attempt = { id: '44444444-4444-4444-8444-444444444444', queueItemId: item.id, accountId: item.accountId, groupId: item.groupId, attemptNumber: 1, status: 'STARTING', diagnosticAvailable: false, startedAt: new Date().toISOString(), createdAt: new Date().toISOString(), events: [], irreversibleReached: false };
  const attempts = {
    isBlocked: vi.fn(() => false),
    claim: vi.fn(() => ({ token: 'lease', attempt })),
    addEvent: vi.fn(),
    setAttemptStatus: vi.fn(),
    blockAccount: vi.fn(),
    createReceipt: vi.fn(),
    finalizeNeedsAttention: vi.fn(),
    finalizeFailure: vi.fn(),
    finalizeSuccess: vi.fn(),
    finalizeSubmission: vi.fn(),
    finalizeUnknown: vi.fn(),
    attempts: vi.fn(() => [attempt]),
    getAttempt: vi.fn(() => attempt),
    setDiagnostic: vi.fn(),
    recordSelectorProbe: vi.fn(),
    recordPreflight: vi.fn(),
    latestPreflight: vi.fn()
  };
  const accounts = { get: vi.fn(() => ({ id: item.accountId, name: 'FB01', profileDirectory: 'C:/profiles/fb01', proxyEnabled: true })), setHealth: vi.fn(), setProxyTest: vi.fn() };
  const groups = { get: vi.fn(() => ({ id: item.groupId, active: true })), assignments: vi.fn(() => [{ id: item.accountId }]) };
  const profiles = { assertControlledDirectory: vi.fn() };
  const browser = { withAccountPage: vi.fn(async (_id: string, callback: (page: object) => Promise<unknown>) => callback({})) };
  const publisher = {
    selectorsVersion: '2026-08-v4',
    publish: vi.fn(async () => publishResult ?? { result: 'VERIFIED_PUBLISHED' as const, postUrl: 'https://fb.com/post/1', evidence: 'verified' }),
    preflight: vi.fn(async () => ({
      probe: { status: 'FOUND', session: { status: 'FOUND' }, group: { status: 'FOUND' }, composerTrigger: { status: 'FOUND' }, composerTextbox: { status: 'FOUND' }, postButton: { status: 'FOUND' }, mediaInput: { status: 'FOUND' } },
      contentObserved: true,
      filledContent: true
    }))
  };
  const diagnostics = { capture: vi.fn(async () => undefined), capturePreflight: vi.fn(async () => undefined) };
  const audit = { add: vi.fn() };
  const readiness = {
    setSelectorVersion: readinessMock.setSelectorVersion ?? vi.fn(),
    evaluate: readinessMock.evaluate
  };
  const executor = new PublishExecutor(
    queue as never,
    attempts as never,
    accounts as never,
    groups as never,
    profiles as never,
    browser as never,
    publisher as never,
    diagnostics as never,
    audit as never,
    vi.fn(),
    readiness as never
  );
  return { executor, queue, attempts, accounts, groups, publisher, readiness };
}

describe('PublishExecutor just-in-time readiness evaluation', () => {
  it('skips preflight refresh when live readiness is already satisfied', async () => {
    const evaluate = vi.fn().mockResolvedValue({ ready: true, preflightId: 'pf-1' });
    const harness = liveReadinessFixture({ evaluate });
    const result = await harness.executor.execute(item.id, settings);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(harness.publisher.preflight).not.toHaveBeenCalled();
    expect(harness.attempts.claim).toHaveBeenCalledTimes(1);
    expect(harness.publisher.publish).toHaveBeenCalledTimes(1);
    expect(result.started).toBe(true);
  });

  it('refreshes preflight just-in-time when expired and publishes after fresh PASS', async () => {
    const evaluate = vi.fn()
      .mockResolvedValueOnce({ ready: false, reasons: ['PREFLIGHT_EXPIRED'] })
      .mockResolvedValueOnce({ ready: true, preflightId: 'pf-refreshed' });
    const harness = liveReadinessFixture({ evaluate });
    const result = await harness.executor.execute(item.id, settings);

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(harness.publisher.preflight).toHaveBeenCalledTimes(1);
    expect(harness.attempts.claim).toHaveBeenCalledTimes(1);
    expect(harness.publisher.publish).toHaveBeenCalledTimes(1);
    expect(result.started).toBe(true);
  });

  it('fails closed with zero publish when JIT preflight fails', async () => {
    const evaluate = vi.fn()
      .mockResolvedValueOnce({ ready: false, reasons: ['PREFLIGHT_EXPIRED'] })
      .mockResolvedValueOnce({ ready: false, reasons: ['PREFLIGHT_MISSING'] });
    const harness = liveReadinessFixture({ evaluate });

    await expect(harness.executor.execute(item.id, settings)).rejects.toMatchObject({
      code: 'LIVE_READINESS_FAILED'
    });
    expect(harness.publisher.preflight).toHaveBeenCalledTimes(1);
    expect(harness.attempts.claim).not.toHaveBeenCalled();
    expect(harness.publisher.publish).not.toHaveBeenCalled();
  });

  it('fails closed immediately with zero publish when readiness contains non-recoverable reasons', async () => {
    const evaluate = vi.fn().mockResolvedValue({ ready: false, reasons: ['ACCOUNT_CHECKPOINT'] });
    const harness = liveReadinessFixture({ evaluate });

    await expect(harness.executor.execute(item.id, settings)).rejects.toMatchObject({
      code: 'LIVE_READINESS_FAILED'
    });
    expect(harness.publisher.preflight).not.toHaveBeenCalled();
    expect(harness.attempts.claim).not.toHaveBeenCalled();
    expect(harness.publisher.publish).not.toHaveBeenCalled();
  });

  it('drains without publish when shouldStop returns true before claim', async () => {
    const evaluate = vi.fn().mockResolvedValue({ ready: true, preflightId: 'pf-1' });
    const harness = liveReadinessFixture({ evaluate });

    const result = await harness.executor.execute(item.id, settings, undefined, () => true);
    expect(result).toEqual({ started: false });
    expect(harness.attempts.claim).not.toHaveBeenCalled();
    expect(harness.publisher.publish).not.toHaveBeenCalled();
  });

  it('drains without publish when cancellation signal is aborted during/after JIT preflight', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({ ready: false, reasons: ['PREFLIGHT_EXPIRED'] });
    const harness = liveReadinessFixture({ evaluate });
    const controller = new AbortController();
    harness.publisher.preflight.mockImplementation(async () => {
      controller.abort();
      return {
        probe: { status: 'FOUND', session: { status: 'FOUND' }, group: { status: 'FOUND' }, composerTrigger: { status: 'FOUND' }, composerTextbox: { status: 'FOUND' }, postButton: { status: 'FOUND' }, mediaInput: { status: 'FOUND' } },
        contentObserved: true,
        filledContent: true
      };
    });

    const result = await harness.executor.execute(item.id, settings, controller.signal);
    expect(result).toEqual({ started: false });
    expect(harness.attempts.claim).not.toHaveBeenCalled();
    expect(harness.publisher.publish).not.toHaveBeenCalled();
  });

  it('in canary mode, does not auto-refresh expired preflight and throws LIVE_READINESS_FAILED', async () => {
    const evaluate = vi.fn().mockResolvedValue({ ready: false, reasons: ['PREFLIGHT_EXPIRED'] });
    const harness = liveReadinessFixture({ evaluate });

    await expect(harness.executor.execute(item.id, { ...settings, canaryMode: true })).rejects.toMatchObject({
      code: 'LIVE_READINESS_FAILED'
    });
    expect(harness.publisher.preflight).not.toHaveBeenCalled();
    expect(harness.attempts.claim).not.toHaveBeenCalled();
    expect(harness.publisher.publish).not.toHaveBeenCalled();
  });

  it('fails closed with LIVE_READINESS_FAILED when readiness service is missing in LIVE mode even with canary off', async () => {
    const value = fixture(new PublishingError('SUBMIT_FAILED', 'Should not reach publisher.'));
    const unreadyExecutor = new PublishExecutor(
      value.queue as never,
      value.attempts as never,
      value.accounts as never,
      {} as never,
      {} as never,
      {} as never,
      value.publisher as never,
      value.diagnostics as never,
      {} as never,
      vi.fn(),
      undefined
    );
    await expect(unreadyExecutor.execute(item.id, { ...settings, canaryMode: false })).rejects.toMatchObject({
      code: 'LIVE_READINESS_FAILED'
    });
    expect(value.attempts.claim).not.toHaveBeenCalled();
    expect(value.publisher.publish).not.toHaveBeenCalled();
  });
});

