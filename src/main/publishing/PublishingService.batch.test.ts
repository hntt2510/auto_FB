import { describe, expect, it, vi } from 'vitest';
import type { LiveReadiness, LiveReadinessReason, PublishingRunResult, PublishingSettings } from '@shared/types';
import { PublishingService } from './PublishingService';

function uuid(num: number): string {
  return `00000000-0000-4000-8000-${String(num).padStart(12, '0')}`;
}

function makeItem(id: string, accountId = uuid(999), groupName = 'Group 1'): any {
  return {
    id,
    draftId: uuid(888),
    accountId,
    groupId: uuid(777),
    draftTitle: 'Test Draft',
    body: 'Hello world',
    accountName: accountId,
    groupName,
    groupUrl: 'https://www.facebook.com/groups/test',
    status: 'PENDING',
    media: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createHarness(options?: {
  canaryMode?: boolean;
  enabled?: boolean;
  executionMode?: 'LIVE' | 'DRY_RUN';
  isBusy?: boolean;
}) {
  const currentSettings: PublishingSettings = {
    enabled: options?.enabled ?? true,
    executionMode: options?.executionMode ?? 'LIVE',
    canaryMode: options?.canaryMode ?? false,
    schedulerIntervalSeconds: 30,
    maxConcurrentAccounts: 2,
    videoUploadTimeoutSeconds: 600,
    maxJobsPerSchedulerSession: 20,
    batchPacingSeconds: 120
  };

  const queueMap = new Map<string, any>();
  const readinessMap = new Map<string, { ready: boolean; reasons: LiveReadinessReason[] }>();

  const queue = {
    get: vi.fn((id: string) => queueMap.get(id)),
    dueCount: vi.fn(() => 0),
    due: vi.fn(() => [])
  };

  const attemptsRepository = {
    blocks: vi.fn(() => []),
    recent: vi.fn(() => []),
    recentProbes: vi.fn(() => []),
    recoverRunning: vi.fn(() => 0)
  };

  const accounts = {
    get: vi.fn((id: string) => ({ id, name: id, profileDirectory: `/profiles/${id}`, status: 'ACTIVE' }))
  };

  const groups = {
    get: vi.fn((id: string) => ({ id, name: 'Group 1', active: true, normalizedUrl: 'https://www.facebook.com/groups/test' })),
    assignments: vi.fn(() => [{ id: uuid(999) }])
  };

  const media = {
    previewUrl: vi.fn((id: string) => `http://media/${id}`)
  };

  let preflightsActive = 0;
  let maxConcurrentPreflights = 0;
  const preflightLog: string[] = [];

  const executor = {
    selectorVersion: '2026-08-v4',
    preflight: vi.fn(async (item: any): Promise<any> => {
      preflightsActive++;
      maxConcurrentPreflights = Math.max(maxConcurrentPreflights, preflightsActive);
      preflightLog.push(item.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      preflightsActive--;
      readinessMap.set(item.id, { ready: true, reasons: [] });
      return {
        id: `pf-${item.id}`,
        status: 'PASSED' as const,
        queueItemId: item.id,
        accountId: item.accountId,
        groupId: item.groupId,
        selectorVersion: '2026-08-v4',
        checkedAt: new Date().toISOString()
      };
    })
  };

  const runLog: string[][] = [];
  const coordinator = {
    isBusy: vi.fn(() => options?.isBusy ?? false),
    running: vi.fn(() => []),
    status: vi.fn(() => undefined),
    resumeAccepting: vi.fn(),
    run: vi.fn(async (ids: string[]): Promise<PublishingRunResult> => {
      runLog.push([...ids]);
      return { requested: ids.length, claimed: ids.length, completed: ids.length, skipped: 0 };
    })
  };

  const scheduler = {
    isRunning: vi.fn(() => false),
    isArmed: vi.fn(() => false),
    runtimeState: vi.fn(() => 'DISARMED' as const),
    reason: vi.fn(() => undefined),
    completedThisSession: vi.fn(() => 0),
    preview: vi.fn(() => ({})),
    isTicking: vi.fn(() => false),
    runDue: vi.fn()
  };

  const settingsService = {
    get: vi.fn(() => currentSettings)
  };

  const diagnostics = {
    open: vi.fn(),
    delete: vi.fn()
  };

  const audit = {
    add: vi.fn()
  };

  const notify = vi.fn();

  const readinessService = {
    setSelectorVersion: vi.fn(),
    evaluate: vi.fn(async (item: any): Promise<LiveReadiness> => {
      const state = readinessMap.get(item.id);
      if (state) {
        return state.ready ? { ready: true, preflightId: `pf-${item.id}` } : { ready: false, reasons: state.reasons };
      }
      return { ready: false, reasons: ['PREFLIGHT_MISSING'] };
    })
  };

  const service = new PublishingService(
    queue as never,
    attemptsRepository as never,
    accounts as never,
    groups as never,
    media as never,
    executor as never,
    coordinator as never,
    scheduler as never,
    settingsService as never,
    diagnostics as never,
    audit as never,
    notify,
    readinessService as never
  );

  return {
    service,
    queueMap,
    readinessMap,
    executor,
    coordinator,
    runLog,
    preflightLog,
    getMaxConcurrentPreflights: () => maxConcurrentPreflights
  };
}

describe('PublishingService batch preparation (Section 18 requirements)', () => {
  it('1. all fresh PASSED -> no preflight rerun -> batch starts', async () => {
    const harness = createHarness();
    const id1 = uuid(1);
    const id2 = uuid(2);
    harness.queueMap.set(id1, makeItem(id1));
    harness.queueMap.set(id2, makeItem(id2));
    harness.readinessMap.set(id1, { ready: true, reasons: [] });
    harness.readinessMap.set(id2, { ready: true, reasons: [] });

    const result = await harness.service.prepareAndRunBatch([id1, id2]);
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.coordinator.run).toHaveBeenCalledTimes(1);
    expect(harness.runLog).toEqual([[id1, id2]]);
    expect(result.completed).toBe(2);
  });

  it('2. PREFLIGHT_MISSING only -> Prepare & Run performs preflight -> readiness refreshed -> batch starts after PASS', async () => {
    const harness = createHarness();
    const id1 = uuid(1);
    const id2 = uuid(2);
    harness.queueMap.set(id1, makeItem(id1));
    harness.queueMap.set(id2, makeItem(id2));
    harness.readinessMap.set(id1, { ready: false, reasons: ['PREFLIGHT_MISSING'] });
    harness.readinessMap.set(id2, { ready: false, reasons: ['PREFLIGHT_MISSING'] });

    const result = await harness.service.prepareAndRunBatch([id1, id2]);
    expect(harness.executor.preflight).toHaveBeenCalledTimes(2);
    expect(harness.coordinator.run).toHaveBeenCalledTimes(1);
    expect(harness.runLog).toEqual([[id1, id2]]);
    expect(result.completed).toBe(2);
  });

  it('3. PREFLIGHT_EXPIRED -> preflight refreshed', async () => {
    const harness = createHarness();
    const id1 = uuid(1);
    harness.queueMap.set(id1, makeItem(id1));
    harness.readinessMap.set(id1, { ready: false, reasons: ['PREFLIGHT_EXPIRED'] });

    const preview = await harness.service.prepareBatch([id1]);
    expect(harness.executor.preflight).toHaveBeenCalledWith(harness.queueMap.get(id1), expect.anything(), true);
    expect(preview.ready).toBe(1);
    expect(preview.blocked).toBe(0);
  });

  it('4. selector-version mismatch -> preflight refreshed', async () => {
    const harness = createHarness();
    const id1 = uuid(1);
    harness.queueMap.set(id1, makeItem(id1));
    harness.readinessMap.set(id1, { ready: false, reasons: ['PREFLIGHT_SELECTOR_VERSION_MISMATCH'] });

    const preview = await harness.service.prepareBatch([id1]);
    expect(harness.executor.preflight).toHaveBeenCalledWith(harness.queueMap.get(id1), expect.anything(), true);
    expect(preview.ready).toBe(1);
    expect(preview.blocked).toBe(0);
  });

  it('5. MEDIA_INVALID -> preparation does not start publishing', async () => {
    const harness = createHarness();
    const id1 = uuid(1);
    const id2 = uuid(2);
    harness.queueMap.set(id1, makeItem(id1));
    harness.queueMap.set(id2, makeItem(id2));
    harness.readinessMap.set(id1, { ready: false, reasons: ['PREFLIGHT_MISSING'] });
    harness.readinessMap.set(id2, { ready: false, reasons: ['MEDIA_INVALID'] });

    await expect(harness.service.prepareAndRunBatch([id1, id2])).rejects.toMatchObject({
      code: 'BATCH_NOT_READY'
    });
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.coordinator.run).not.toHaveBeenCalled();
  });

  it('6. CHECKPOINT -> preparation does not start publishing', async () => {
    const harness = createHarness();
    const id1 = uuid(1);
    harness.queueMap.set(id1, makeItem(id1));
    harness.readinessMap.set(id1, { ready: false, reasons: ['ACCOUNT_CHECKPOINT'] });

    await expect(harness.service.prepareAndRunBatch([id1])).rejects.toMatchObject({
      code: 'BATCH_NOT_READY'
    });
    expect(harness.executor.preflight).not.toHaveBeenCalled();
    expect(harness.coordinator.run).not.toHaveBeenCalled();
  });

  it('7. one preflight fails -> zero LIVE items execute', async () => {
    const harness = createHarness();
    const id1 = uuid(1);
    const id2 = uuid(2);
    harness.queueMap.set(id1, makeItem(id1));
    harness.queueMap.set(id2, makeItem(id2));
    harness.readinessMap.set(id1, { ready: false, reasons: ['PREFLIGHT_MISSING'] });
    harness.readinessMap.set(id2, { ready: false, reasons: ['PREFLIGHT_MISSING'] });

    harness.executor.preflight.mockImplementation(async (item: any): Promise<any> => {
      if (item.id === id2) {
        harness.readinessMap.set(id2, { ready: false, reasons: ['PREFLIGHT_MISSING'] });
        return {
          id: `pf-${item.id}`,
          status: 'FAILED' as const,
          queueItemId: item.id,
          accountId: item.accountId,
          groupId: item.groupId,
          selectorVersion: '2026-08-v4',
          checkedAt: new Date().toISOString()
        };
      }
      harness.readinessMap.set(item.id, { ready: true, reasons: [] });
      return {
        id: `pf-${item.id}`,
        status: 'PASSED' as const,
        queueItemId: item.id,
        accountId: item.accountId,
        groupId: item.groupId,
        selectorVersion: '2026-08-v4',
        checkedAt: new Date().toISOString()
      };
    });

    await expect(harness.service.prepareAndRunBatch([id1, id2])).rejects.toMatchObject({
      code: 'BATCH_NOT_READY'
    });
    expect(harness.coordinator.run).not.toHaveBeenCalled();
  });

  it('8. same-account preflights never overlap', async () => {
    const harness = createHarness();
    const accId = uuid(999);
    const id1 = uuid(1);
    const id2 = uuid(2);
    const id3 = uuid(3);
    harness.queueMap.set(id1, makeItem(id1, accId));
    harness.queueMap.set(id2, makeItem(id2, accId));
    harness.queueMap.set(id3, makeItem(id3, accId));

    await harness.service.prepareBatch([id1, id2, id3]);
    expect(harness.getMaxConcurrentPreflights()).toBe(1);
    expect(harness.preflightLog).toEqual([id1, id2, id3]);
  });

  it('9. Canary ON still rejects multi-item LIVE batch', async () => {
    const harness = createHarness({ canaryMode: true });
    const id1 = uuid(1);
    const id2 = uuid(2);
    harness.queueMap.set(id1, makeItem(id1));
    harness.queueMap.set(id2, makeItem(id2));

    await expect(harness.service.prepareBatch([id1, id2])).rejects.toMatchObject({
      code: 'CANARY_LIMIT'
    });
    await expect(harness.service.prepareAndRunBatch([id1, id2])).rejects.toMatchObject({
      code: 'CANARY_LIMIT'
    });
  });

  it('10. batch maximum 20 still enforced', async () => {
    const harness = createHarness();
    const ids: string[] = [];
    for (let i = 1; i <= 21; i++) {
      const id = uuid(i);
      ids.push(id);
      harness.queueMap.set(id, makeItem(id));
    }

    await expect(harness.service.prepareBatch(ids)).rejects.toMatchObject({
      code: 'BATCH_LIMIT'
    });
    await expect(harness.service.prepareAndRunBatch(ids)).rejects.toMatchObject({
      code: 'BATCH_LIMIT'
    });
  });
});
