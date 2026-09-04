import { describe, expect, it, vi } from 'vitest';
import type { LiveReadiness, LiveReadinessReason, PublishingRunResult, PublishingSettings, QueueStatus } from '@shared/types';
import { PublishingService } from './PublishingService';
import { PublishCoordinator } from './PublishCoordinator';

function uuid(num: number): string {
  return `11111111-2222-4000-8000-${String(num).padStart(12, '0')}`;
}

function makeQueueItem(id: string, accountId: string, groupName: string) {
  return {
    id,
    draftId: uuid(900),
    accountId,
    groupId: uuid(800),
    draftTitle: `Post to ${groupName}`,
    body: 'Continuous publishing test content',
    accountName: 'Test Account',
    groupName,
    groupUrl: `https://www.facebook.com/groups/${groupName.toLowerCase()}`,
    status: 'PENDING' as QueueStatus,
    media: [],
    snapshotHash: `hash-${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

describe('Runtime QA Scenarios (Section 20)', () => {
  it('Scenario A: 3 same-account items with PREFLIGHT_MISSING -> Prepare & Run -> SUBMITTED, SUBMITTED, SUCCEEDED -> all execute, status preserved, COMPLETED', async () => {
    const accId = uuid(10);
    const id1 = uuid(1);
    const id2 = uuid(2);
    const id3 = uuid(3);

    const items = new Map([
      [id1, makeQueueItem(id1, accId, 'GroupA')],
      [id2, makeQueueItem(id2, accId, 'GroupB')],
      [id3, makeQueueItem(id3, accId, 'GroupC')]
    ]);

    const readinessState = new Map<string, { ready: boolean; reasons: LiveReadinessReason[] }>([
      [id1, { ready: false, reasons: ['PREFLIGHT_MISSING'] }],
      [id2, { ready: false, reasons: ['PREFLIGHT_MISSING'] }],
      [id3, { ready: false, reasons: ['PREFLIGHT_MISSING'] }]
    ]);

    const preflightCalls: string[] = [];
    const executionCalls: string[] = [];

    const plannedOutcomes = ['SUBMITTED' as const, 'SUBMITTED' as const, 'SUCCEEDED' as const];
    let outcomeIndex = 0;

    const executor = {
      selectorVersion: '2026-08-v4',
      preflight: vi.fn(async (item: any): Promise<any> => {
        preflightCalls.push(item.id);
        readinessState.set(item.id, { ready: true, reasons: [] });
        return {
          id: `pf-${item.id}`,
          status: 'PASSED' as const,
          queueItemId: item.id,
          accountId: item.accountId,
          groupId: item.groupId,
          selectorVersion: '2026-08-v4',
          checkedAt: new Date().toISOString()
        };
      }),
      execute: vi.fn(async (queueItemId: string): Promise<any> => {
        executionCalls.push(queueItemId);
        const finalStatus = plannedOutcomes[outcomeIndex++];
        const rec = items.get(queueItemId)!;
        rec.status = finalStatus;
        return { started: true, finalStatus };
      })
    };

    const coordinator = new PublishCoordinator(
      { get: (id: string) => items.get(id) } as never,
      executor as never,
      () => undefined,
      { now: () => Date.now(), wait: async () => undefined }
    );

    const settings: PublishingSettings = {
      enabled: true,
      executionMode: 'LIVE',
      canaryMode: false,
      schedulerIntervalSeconds: 30,
      maxConcurrentAccounts: 2,
      videoUploadTimeoutSeconds: 600,
      maxJobsPerSchedulerSession: 20,
      batchPacingSeconds: 1
    };

    const readinessService = {
      setSelectorVersion: vi.fn(),
      evaluate: vi.fn(async (item: any): Promise<LiveReadiness> => {
        const state = readinessState.get(item.id);
        if (state && !state.ready) return { ready: false, reasons: state.reasons };
        return { ready: true, preflightId: `pf-${item.id}` };
      })
    };

    const service = new PublishingService(
      { get: (id: string) => items.get(id) } as never,
      { blocks: () => [], recent: () => [], recentProbes: () => [] } as never,
      { get: (id: string) => ({ id, name: 'Test Account', profileDirectory: '/profiles/test', status: 'ACTIVE' }) } as never,
      { get: () => ({ active: true }), assignments: () => [{ id: accId }] } as never,
      { previewUrl: () => '' } as never,
      executor as never,
      coordinator,
      { isRunning: () => false, runtimeState: () => 'DISARMED' as const } as never,
      { get: () => settings } as never,
      {} as never,
      { add: () => undefined } as never,
      () => undefined,
      readinessService as never
    );

    // 1. Check initial preview shows needPreparation
    const initialPreview = await service.previewBatch([id1, id2, id3]);
    expect(initialPreview.ready).toBe(0);
    expect(initialPreview.needPreparation).toBe(3);
    expect(initialPreview.canPrepare).toBe(true);

    // 2. Prepare & Run Batch
    const result = await service.prepareAndRunBatch([id1, id2, id3]);

    // 3. Preflights ran sequentially for all 3
    expect(preflightCalls).toEqual([id1, id2, id3]);

    // 4. All 3 executed
    expect(executionCalls).toEqual([id1, id2, id3]);
    expect(result.requested).toBe(3);
    expect(result.completed).toBe(3);
    expect(result.skipped).toBe(0);

    // 5. Final queue states remain: SUBMITTED, SUBMITTED, SUCCEEDED
    expect(items.get(id1)?.status).toBe('SUBMITTED');
    expect(items.get(id2)?.status).toBe('SUBMITTED');
    expect(items.get(id3)?.status).toBe('SUCCEEDED');

    // 6. Batch finished as COMPLETED
    expect(coordinator.status()?.state).toBe('COMPLETED');
  });

  it('Scenario B: item1 -> NEEDS_ATTENTION -> item2/item3 never execute, batch INTERRUPTED', async () => {
    const accId = uuid(10);
    const id1 = uuid(1);
    const id2 = uuid(2);
    const id3 = uuid(3);

    const items = new Map([
      [id1, makeQueueItem(id1, accId, 'GroupA')],
      [id2, makeQueueItem(id2, accId, 'GroupB')],
      [id3, makeQueueItem(id3, accId, 'GroupC')]
    ]);

    const executionCalls: string[] = [];

    const executor = {
      selectorVersion: '2026-08-v4',
      preflight: vi.fn(),
      execute: vi.fn(async (queueItemId: string): Promise<any> => {
        executionCalls.push(queueItemId);
        const rec = items.get(queueItemId)!;
        rec.status = 'NEEDS_ATTENTION';
        return { started: true, finalStatus: 'NEEDS_ATTENTION' as const };
      })
    };

    const coordinator = new PublishCoordinator(
      { get: (id: string) => items.get(id) } as never,
      executor as never,
      () => undefined,
      { now: () => Date.now(), wait: async () => undefined }
    );

    const settings: PublishingSettings = {
      enabled: true,
      executionMode: 'LIVE',
      canaryMode: false,
      schedulerIntervalSeconds: 30,
      maxConcurrentAccounts: 2,
      videoUploadTimeoutSeconds: 600,
      maxJobsPerSchedulerSession: 20,
      batchPacingSeconds: 1
    };

    const readinessService = {
      setSelectorVersion: vi.fn(),
      evaluate: vi.fn(async (): Promise<LiveReadiness> => ({ ready: true, preflightId: 'pf-ok' }))
    };

    const service = new PublishingService(
      { get: (id: string) => items.get(id) } as never,
      { blocks: () => [], recent: () => [], recentProbes: () => [] } as never,
      { get: (id: string) => ({ id, name: 'Test Account', profileDirectory: '/profiles/test', status: 'ACTIVE' }) } as never,
      { get: () => ({ active: true }), assignments: () => [{ id: accId }] } as never,
      { previewUrl: () => '' } as never,
      executor as never,
      coordinator,
      { isRunning: () => false, runtimeState: () => 'DISARMED' as const } as never,
      { get: () => settings } as never,
      {} as never,
      { add: () => undefined } as never,
      () => undefined,
      readinessService as never
    );

    const result = await service.prepareAndRunBatch([id1, id2, id3]);

    // Item 1 executed, items 2 and 3 NEVER executed
    expect(executionCalls).toEqual([id1]);
    expect(result.requested).toBe(3);
    expect(result.completed).toBe(1);
    expect(result.skipped).toBe(2);

    // Items 2 and 3 remain PENDING
    expect(items.get(id1)?.status).toBe('NEEDS_ATTENTION');
    expect(items.get(id2)?.status).toBe('PENDING');
    expect(items.get(id3)?.status).toBe('PENDING');

    // Batch interrupted
    expect(coordinator.status()?.state).toBe('INTERRUPTED');
    expect(coordinator.status()?.reason).toBe('ACCOUNT_CHAIN_NEEDS_ATTENTION');
  });

  it('Scenario C: one item has non-recoverable readiness issue -> zero LIVE executions occur', async () => {
    const accId = uuid(10);
    const id1 = uuid(1);
    const id2 = uuid(2);
    const id3 = uuid(3);

    const items = new Map([
      [id1, makeQueueItem(id1, accId, 'GroupA')],
      [id2, makeQueueItem(id2, accId, 'GroupB')],
      [id3, makeQueueItem(id3, accId, 'GroupC')]
    ]);

    const executionCalls: string[] = [];

    const executor = {
      selectorVersion: '2026-08-v4',
      preflight: vi.fn(),
      execute: vi.fn(async (queueItemId: string): Promise<any> => {
        executionCalls.push(queueItemId);
        return { started: true, finalStatus: 'SUCCEEDED' as const };
      })
    };

    const coordinator = new PublishCoordinator(
      { get: (id: string) => items.get(id) } as never,
      executor as never,
      () => undefined,
      { now: () => Date.now(), wait: async () => undefined }
    );

    const settings: PublishingSettings = {
      enabled: true,
      executionMode: 'LIVE',
      canaryMode: false,
      schedulerIntervalSeconds: 30,
      maxConcurrentAccounts: 2,
      videoUploadTimeoutSeconds: 600,
      maxJobsPerSchedulerSession: 20,
      batchPacingSeconds: 1
    };

    const readinessService = {
      setSelectorVersion: vi.fn(),
      evaluate: vi.fn(async (item: any): Promise<LiveReadiness> => {
        if (item.id === id2) {
          return { ready: false, reasons: ['MEDIA_INVALID'] };
        }
        return { ready: false, reasons: ['PREFLIGHT_MISSING'] };
      })
    };

    const service = new PublishingService(
      { get: (id: string) => items.get(id) } as never,
      { blocks: () => [], recent: () => [], recentProbes: () => [] } as never,
      { get: (id: string) => ({ id, name: 'Test Account', profileDirectory: '/profiles/test', status: 'ACTIVE' }) } as never,
      { get: () => ({ active: true }), assignments: () => [{ id: accId }] } as never,
      { previewUrl: () => '' } as never,
      executor as never,
      coordinator,
      { isRunning: () => false, runtimeState: () => 'DISARMED' as const } as never,
      { get: () => settings } as never,
      {} as never,
      { add: () => undefined } as never,
      () => undefined,
      readinessService as never
    );

    // Initial preview shows canPrepare is false due to nonRecoverable: 1
    const preview = await service.previewBatch([id1, id2, id3]);
    expect(preview.nonRecoverable).toBe(1);
    expect(preview.canPrepare).toBe(false);

    // prepareAndRunBatch rejects with BATCH_NOT_READY
    await expect(service.prepareAndRunBatch([id1, id2, id3])).rejects.toMatchObject({
      code: 'BATCH_NOT_READY'
    });

    // Zero preflights or LIVE executions occurred
    expect(executor.preflight).not.toHaveBeenCalled();
    expect(executionCalls).toHaveLength(0);
  });
});
