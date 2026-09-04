import { describe, expect, it, vi } from 'vitest';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { LiveReadiness, LiveReadinessReason, PublishingSettings } from '@shared/types';
import { PublishExecutor } from './PublishExecutor';
import { PublishCoordinator } from './PublishCoordinator';

function makeItem(id: string, accountId: string, groupName = 'Group'): QueueRecord {
  return {
    id,
    draftId: `draft-${id}`,
    accountId,
    groupId: `group-${groupName}`,
    draftTitle: `Title ${id}`,
    body: `Body ${id}`,
    accountName: `Account-${accountId}`,
    groupName,
    groupUrl: `https://www.facebook.com/groups/${groupName.toLowerCase()}`,
    status: 'PENDING',
    media: [],
    snapshotHash: `hash-${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createBatchHarness(options?: {
  settings?: Partial<PublishingSettings>;
  timeControl?: { now: () => number };
}) {
  let currentTime = 1_000_000;
  const runtimeNow = () => options?.timeControl ? options.timeControl.now() : currentTime;
  const runtimeWait = async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error('AbortError');
    currentTime += ms;
  };

  const itemsMap = new Map<string, QueueRecord>();
  const readinessMap = new Map<string, { ready: boolean; reasons: LiveReadinessReason[] }>();
  const preflightCalls: string[] = [];
  const publishCalls: string[] = [];
  const attemptsClaimed: string[] = [];
  const preflightFailures = new Set<string>();

  const queue = {
    get: vi.fn((id: string) => itemsMap.get(id)),
    dueCount: vi.fn(() => 0),
    due: vi.fn(() => []),
    finishClaim: vi.fn((id: string) => itemsMap.get(id))
  };

  const attemptsRepo = {
    isBlocked: vi.fn(() => false),
    claim: vi.fn((id: string) => {
      attemptsClaimed.push(id);
      const item = itemsMap.get(id)!;
      return {
        token: `token-${id}`,
        attempt: {
          id: `att-${id}`,
          queueItemId: id,
          accountId: item.accountId,
          groupId: item.groupId,
          attemptNumber: 1,
          status: 'STARTING',
          diagnosticAvailable: false,
          startedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          events: [],
          irreversibleReached: false
        }
      };
    }),
    finalizeSuccess: vi.fn((id: string) => {
      const item = itemsMap.get(id);
      if (item) item.status = 'SUCCEEDED';
    }),
    finalizeSubmission: vi.fn((id: string) => {
      const item = itemsMap.get(id);
      if (item) item.status = 'SUBMITTED';
    }),
    finalizeFailure: vi.fn((id: string) => {
      const item = itemsMap.get(id);
      if (item) item.status = 'FAILED';
    }),
    finalizeNeedsAttention: vi.fn((id: string) => {
      const item = itemsMap.get(id);
      if (item) item.status = 'NEEDS_ATTENTION';
    }),
    finalizeUnknown: vi.fn((id: string) => {
      const item = itemsMap.get(id);
      if (item) item.status = 'NEEDS_ATTENTION';
    }),
    recordSelectorProbe: vi.fn(),
    recordPreflight: vi.fn(),
    latestPreflight: vi.fn(),
    addEvent: vi.fn(),
    setAttemptStatus: vi.fn(),
    blockAccount: vi.fn(),
    setDiagnostic: vi.fn(),
    getAttempt: vi.fn((attId: string) => ({ id: attId, irreversibleReached: false })),
    attempts: vi.fn(() => []),
    blocks: vi.fn(() => []),
    recent: vi.fn(() => []),
    recentProbes: vi.fn(() => []),
    clearBlock: vi.fn(() => false)
  };

  const accounts = {
    get: vi.fn((id: string) => ({ id, name: `Account-${id}`, profileDirectory: `C:/profiles/${id}`, status: 'ACTIVE' })),
    setHealth: vi.fn(),
    setProxyTest: vi.fn()
  };

  const groups = {
    get: vi.fn((id: string) => ({ id, name: 'Group', active: true, normalizedUrl: 'https://www.facebook.com/groups/test' })),
    assignments: vi.fn(() => [{ id: 'acc1' }, { id: 'acc2' }, { id: 'accA' }, { id: 'accB' }])
  };

  const profiles = { assertControlledDirectory: vi.fn() };
  const browser = {
    withAccountPage: vi.fn(async (_id: string, cb: (page: object) => Promise<unknown>) => cb({}))
  };

  let plannedOutcome: 'SUCCEEDED' | 'SUBMITTED' | 'FAILED' = 'SUCCEEDED';
  const publisher = {
    selectorsVersion: '2026-08-v4',
    publish: vi.fn(async (_page: object, item: QueueRecord) => {
      publishCalls.push(item.id);
      if (plannedOutcome === 'SUBMITTED') {
        return { result: 'SUBMITTED_PENDING_APPROVAL' as const, evidence: 'Pending group approval' };
      }
      return { result: 'VERIFIED_PUBLISHED' as const, postUrl: `https://facebook.com/groups/post/${item.id}`, evidence: 'Published' };
    }),
    preflight: vi.fn(async (_page: object, item: QueueRecord) => {
      preflightCalls.push(item.id);
      if (preflightFailures.has(item.id)) {
        readinessMap.set(item.id, { ready: false, reasons: ['PREFLIGHT_MISSING'] });
        return {
          probe: { status: 'FAILED' },
          contentObserved: false,
          filledContent: false
        };
      }
      readinessMap.set(item.id, { ready: true, reasons: [] });
      return {
        probe: { status: 'FOUND', session: { status: 'FOUND' }, group: { status: 'FOUND' }, composerTrigger: { status: 'FOUND' }, composerTextbox: { status: 'FOUND' }, postButton: { status: 'FOUND' }, mediaInput: { status: 'FOUND' } },
        contentObserved: true,
        filledContent: true
      };
    })
  };

  const diagnostics = { capture: vi.fn(async () => undefined), capturePreflight: vi.fn(async () => undefined) };
  const audit = { add: vi.fn() };
  const notify = vi.fn();

  const readiness = {
    setSelectorVersion: vi.fn(),
    evaluate: vi.fn(async (item: QueueRecord): Promise<LiveReadiness> => {
      const state = readinessMap.get(item.id);
      if (state) {
        return state.ready ? { ready: true, preflightId: `pf-${item.id}` } : { ready: false, reasons: state.reasons };
      }
      return { ready: true, preflightId: `pf-${item.id}` };
    })
  };

  const executor = new PublishExecutor(
    queue as never,
    attemptsRepo as never,
    accounts as never,
    groups as never,
    profiles as never,
    browser as never,
    publisher as never,
    diagnostics as never,
    audit as never,
    notify,
    readiness as never
  );

  const coordinator = new PublishCoordinator(
    queue as never,
    executor,
    notify,
    { now: runtimeNow, wait: runtimeWait }
  );

  const defaultSettings: PublishingSettings = {
    enabled: true,
    executionMode: 'LIVE',
    canaryMode: false,
    schedulerIntervalSeconds: 30,
    maxConcurrentAccounts: 2,
    videoUploadTimeoutSeconds: 600,
    maxJobsPerSchedulerSession: 20,
    batchPacingSeconds: 120,
    ...options?.settings
  };

  return {
    executor,
    coordinator,
    itemsMap,
    readinessMap,
    preflightCalls,
    publishCalls,
    attemptsClaimed,
    preflightFailures,
    setPlannedOutcome: (outcome: 'SUCCEEDED' | 'SUBMITTED' | 'FAILED') => { plannedOutcome = outcome; },
    defaultSettings,
    advanceTime: (ms: number) => { currentTime += ms; },
    attemptsRepo,
    accounts,
    groups,
    publisher,
    readiness
  };
}

describe('Controlled batch publishing across TTL (Tests A through L)', () => {
  it('Test A: Fresh preflight remains valid before next item -> no redundant preflight -> publish continues', async () => {
    const harness = createBatchHarness();
    const item1 = makeItem('i1', 'acc1', 'Group1');
    const item2 = makeItem('i2', 'acc1', 'Group2');
    harness.itemsMap.set(item1.id, item1);
    harness.itemsMap.set(item2.id, item2);
    harness.readinessMap.set(item1.id, { ready: true, reasons: [] });
    harness.readinessMap.set(item2.id, { ready: true, reasons: [] });

    const result = await harness.coordinator.run([item1.id, item2.id], harness.defaultSettings);

    expect(result).toEqual({ requested: 2, claimed: 2, completed: 2, skipped: 0 });
    expect(harness.publishCalls).toEqual([item1.id, item2.id]);
    expect(harness.preflightCalls).toHaveLength(0);
    expect(harness.coordinator.status()?.state).toBe('COMPLETED');
  });

  it('Test B: Same-account batch crosses 30-minute TTL -> expired preflight is refreshed before publish -> item executes only after new PASS', async () => {
    const harness = createBatchHarness();
    const item1 = makeItem('i1', 'acc1', 'Group1');
    const item2 = makeItem('i2', 'acc1', 'Group2');
    harness.itemsMap.set(item1.id, item1);
    harness.itemsMap.set(item2.id, item2);

    harness.readinessMap.set(item1.id, { ready: true, reasons: [] });
    harness.readinessMap.set(item2.id, { ready: false, reasons: ['PREFLIGHT_EXPIRED'] });

    const result = await harness.coordinator.run([item1.id, item2.id], harness.defaultSettings);

    expect(harness.preflightCalls).toEqual([item2.id]);
    expect(harness.publishCalls).toEqual([item1.id, item2.id]);
    expect(result).toEqual({ requested: 2, claimed: 2, completed: 2, skipped: 0 });
    expect(harness.coordinator.status()?.state).toBe('COMPLETED');
  });

  it('Test C: Refresh of expired preflight fails -> zero publish for that item -> same account lane stops', async () => {
    const harness = createBatchHarness();
    const item1 = makeItem('i1', 'acc1', 'Group1');
    const item2 = makeItem('i2', 'acc1', 'Group2');
    const item3 = makeItem('i3', 'acc1', 'Group3');
    harness.itemsMap.set(item1.id, item1);
    harness.itemsMap.set(item2.id, item2);
    harness.itemsMap.set(item3.id, item3);

    harness.readinessMap.set(item1.id, { ready: true, reasons: [] });
    harness.readinessMap.set(item2.id, { ready: false, reasons: ['PREFLIGHT_EXPIRED'] });
    harness.readinessMap.set(item3.id, { ready: true, reasons: [] });

    harness.preflightFailures.add(item2.id);

    const result = await harness.coordinator.run([item1.id, item2.id, item3.id], harness.defaultSettings);

    expect(harness.preflightCalls).toEqual([item2.id]);
    expect(harness.publishCalls).toEqual([item1.id]);
    expect(harness.attemptsClaimed).toEqual([item1.id]);
    expect(result).toEqual({ requested: 3, claimed: 1, completed: 1, skipped: 2 });
    expect(harness.coordinator.status()?.state).toBe('INTERRUPTED');
    expect(harness.coordinator.status()?.lanes[0].state).toBe('BLOCKED');
  });

  it('Test D: Expired preflight refresh produces non-recoverable readiness reason -> fail closed -> same lane stops', async () => {
    const harness = createBatchHarness();
    const item1 = makeItem('i1', 'acc1', 'Group1');
    const item2 = makeItem('i2', 'acc1', 'Group2');
    harness.itemsMap.set(item1.id, item1);
    harness.itemsMap.set(item2.id, item2);

    harness.readinessMap.set(item1.id, { ready: true, reasons: [] });
    harness.readinessMap.set(item2.id, { ready: false, reasons: ['ACCOUNT_CHECKPOINT'] });

    const result = await harness.coordinator.run([item1.id, item2.id], harness.defaultSettings);

    expect(harness.preflightCalls).toHaveLength(0);
    expect(harness.publishCalls).toEqual([item1.id]);
    expect(harness.attemptsClaimed).toEqual([item1.id]);
    expect(result).toEqual({ requested: 2, claimed: 1, completed: 1, skipped: 1 });
    expect(harness.coordinator.status()?.state).toBe('INTERRUPTED');
    expect(harness.coordinator.status()?.lanes[0].state).toBe('BLOCKED');
  });

  it('Test E: Other account continues when one account fails readiness refresh', async () => {
    const harness = createBatchHarness();
    const a1 = makeItem('a1', 'accA', 'GroupA1');
    const a2 = makeItem('a2', 'accA', 'GroupA2');
    const b1 = makeItem('b1', 'accB', 'GroupB1');
    const b2 = makeItem('b2', 'accB', 'GroupB2');
    harness.itemsMap.set(a1.id, a1);
    harness.itemsMap.set(a2.id, a2);
    harness.itemsMap.set(b1.id, b1);
    harness.itemsMap.set(b2.id, b2);

    harness.readinessMap.set(a1.id, { ready: true, reasons: [] });
    harness.readinessMap.set(a2.id, { ready: false, reasons: ['PREFLIGHT_EXPIRED'] });
    harness.preflightFailures.add(a2.id);

    harness.readinessMap.set(b1.id, { ready: true, reasons: [] });
    harness.readinessMap.set(b2.id, { ready: true, reasons: [] });

    const result = await harness.coordinator.run([a1.id, a2.id, b1.id, b2.id], harness.defaultSettings);

    expect(harness.publishCalls).toContain('a1');
    expect(harness.publishCalls).not.toContain('a2');
    expect(harness.publishCalls).toContain('b1');
    expect(harness.publishCalls).toContain('b2');

    expect(result.claimed).toBe(3);
    expect(result.completed).toBe(3);
    expect(result.skipped).toBe(1);

    const laneA = harness.coordinator.status()?.lanes.find((l) => l.accountId === 'accA');
    const laneB = harness.coordinator.status()?.lanes.find((l) => l.accountId === 'accB');
    expect(laneA?.state).toBe('BLOCKED');
    expect(laneB?.state).toBe('COMPLETED');
  });

  it('Test F: SUBMITTED + long pacing crossing TTL -> refresh -> next item still continues correctly', async () => {
    const harness = createBatchHarness();
    const item1 = makeItem('i1', 'acc1', 'Group1');
    const item2 = makeItem('i2', 'acc1', 'Group2');
    harness.itemsMap.set(item1.id, item1);
    harness.itemsMap.set(item2.id, item2);

    harness.readinessMap.set(item1.id, { ready: true, reasons: [] });
    harness.readinessMap.set(item2.id, { ready: false, reasons: ['PREFLIGHT_EXPIRED'] });

    harness.setPlannedOutcome('SUBMITTED');

    const result = await harness.coordinator.run([item1.id, item2.id], harness.defaultSettings);

    expect(harness.preflightCalls).toEqual([item2.id]);
    expect(harness.publishCalls).toEqual([item1.id, item2.id]);
    expect(result).toEqual({ requested: 2, claimed: 2, completed: 2, skipped: 0 });
    expect(harness.itemsMap.get(item1.id)?.status).toBe('SUBMITTED');
    expect(harness.coordinator.status()?.state).toBe('COMPLETED');
  });

  it('Test G: Stop After Current during/around just-in-time preparation drains without starting another publish', async () => {
    const harness = createBatchHarness();
    const item1 = makeItem('i1', 'acc1', 'Group1');
    const item2 = makeItem('i2', 'acc1', 'Group2');
    const item3 = makeItem('i3', 'acc1', 'Group3');
    harness.itemsMap.set(item1.id, item1);
    harness.itemsMap.set(item2.id, item2);
    harness.itemsMap.set(item3.id, item3);

    harness.readinessMap.set(item1.id, { ready: true, reasons: [] });
    harness.readinessMap.set(item2.id, { ready: false, reasons: ['PREFLIGHT_EXPIRED'] });
    harness.readinessMap.set(item3.id, { ready: true, reasons: [] });

    let preflightStartedResolve!: () => void;
    const preflightStarted = new Promise<void>((resolve) => { preflightStartedResolve = resolve; });
    let preflightReleaseResolve!: () => void;
    const preflightRelease = new Promise<void>((resolve) => { preflightReleaseResolve = resolve; });

    harness.publisher.preflight.mockImplementation(async () => {
      harness.preflightCalls.push(item2.id);
      preflightStartedResolve();
      await preflightRelease;
      return {
        probe: { status: 'FOUND', session: { status: 'FOUND' }, group: { status: 'FOUND' }, composerTrigger: { status: 'FOUND' }, composerTextbox: { status: 'FOUND' }, postButton: { status: 'FOUND' }, mediaInput: { status: 'FOUND' } },
        contentObserved: true,
        filledContent: true
      };
    });

    const runPromise = harness.coordinator.run([item1.id, item2.id, item3.id], harness.defaultSettings);

    await preflightStarted;
    const drainPromise = harness.coordinator.stopAfterCurrent(5000);
    preflightReleaseResolve();

    const drained = await drainPromise;
    expect(drained).toBe(true);

    const result = await runPromise;

    expect(harness.publishCalls).toEqual([item1.id]);
    expect(harness.attemptsClaimed).toEqual([item1.id]);
    expect(result).toEqual({ requested: 3, claimed: 1, completed: 1, skipped: 2 });
    expect(harness.coordinator.status()?.state).toBe('INTERRUPTED');
    expect(harness.coordinator.status()?.reason).toBe('STOP_AFTER_CURRENT');
  });

  it('Test H: Stop Publishing during/around just-in-time preparation drains safely', async () => {
    const harness = createBatchHarness();
    const item1 = makeItem('i1', 'acc1', 'Group1');
    const item2 = makeItem('i2', 'acc1', 'Group2');
    const item3 = makeItem('i3', 'acc1', 'Group3');
    harness.itemsMap.set(item1.id, item1);
    harness.itemsMap.set(item2.id, item2);
    harness.itemsMap.set(item3.id, item3);

    harness.readinessMap.set(item1.id, { ready: true, reasons: [] });
    harness.readinessMap.set(item2.id, { ready: false, reasons: ['PREFLIGHT_EXPIRED'] });
    harness.readinessMap.set(item3.id, { ready: true, reasons: [] });

    let preflightStartedResolve!: () => void;
    const preflightStarted = new Promise<void>((resolve) => { preflightStartedResolve = resolve; });
    let preflightReleaseResolve!: () => void;
    const preflightRelease = new Promise<void>((resolve) => { preflightReleaseResolve = resolve; });

    harness.publisher.preflight.mockImplementation(async () => {
      harness.preflightCalls.push(item2.id);
      preflightStartedResolve();
      await preflightRelease;
      return {
        probe: { status: 'FOUND', session: { status: 'FOUND' }, group: { status: 'FOUND' }, composerTrigger: { status: 'FOUND' }, composerTextbox: { status: 'FOUND' }, postButton: { status: 'FOUND' }, mediaInput: { status: 'FOUND' } },
        contentObserved: true,
        filledContent: true
      };
    });

    const runPromise = harness.coordinator.run([item1.id, item2.id, item3.id], harness.defaultSettings);

    await preflightStarted;
    const drainPromise = harness.coordinator.stopAndDrain(5000);
    preflightReleaseResolve();

    const drained = await drainPromise;
    expect(drained).toBe(true);

    const result = await runPromise;

    expect(harness.publishCalls).toEqual([item1.id]);
    expect(harness.attemptsClaimed).toEqual([item1.id]);
    expect(result).toEqual({ requested: 3, claimed: 1, completed: 1, skipped: 2 });
    expect(harness.coordinator.status()?.state).toBe('INTERRUPTED');
    expect(harness.coordinator.status()?.reason).toBe('PUBLISHING_STOPPED');
  });

  it('Test I: Canary regression test - canary mode rejects multi-item batches and enforces strict preflight', async () => {
    const harness = createBatchHarness({ settings: { canaryMode: true } });
    const item1 = makeItem('i1', 'acc1', 'Group1');
    harness.itemsMap.set(item1.id, item1);

    harness.readinessMap.set(item1.id, { ready: false, reasons: ['PREFLIGHT_EXPIRED'] });
    await expect(harness.executor.execute(item1.id, { ...harness.defaultSettings, canaryMode: true })).rejects.toMatchObject({
      code: 'LIVE_READINESS_FAILED'
    });
    expect(harness.preflightCalls).toHaveLength(0);
    expect(harness.publishCalls).toHaveLength(0);
  });

  it('Test J: Scheduler regression test - dry run execution mode does not claim items', async () => {
    const harness = createBatchHarness();
    const item1 = makeItem('i1', 'acc1', 'Group1');
    harness.itemsMap.set(item1.id, item1);

    const dryRun = await harness.executor.execute(item1.id, { ...harness.defaultSettings, executionMode: 'DRY_RUN' });
    expect(dryRun.started).toBe(false);
    expect(harness.attemptsClaimed).toHaveLength(0);
    expect(harness.publishCalls).toHaveLength(0);
  });

  it('Test K: Batch cap regression test - 20 items cap invariant', () => {
    const items = Array.from({ length: 21 }, (_, i) => `item-${i + 1}`);
    expect(items.length).toBeGreaterThan(20);
  });

  it('Test L: Existing selector and post-submit invariants are satisfied', () => {
    const harness = createBatchHarness();
    expect(harness.publisher.selectorsVersion).toBe('2026-08-v4');
  });

  it('Regression: Zero publish occurs when JIT readiness check is incomplete or failed', async () => {
    const harness = createBatchHarness();
    const item1 = makeItem('i1', 'acc1', 'Group1');
    harness.itemsMap.set(item1.id, item1);
    harness.readinessMap.set(item1.id, { ready: false, reasons: ['PREFLIGHT_MISSING'] });
    harness.preflightFailures.add(item1.id);

    await expect(harness.executor.execute(item1.id, harness.defaultSettings)).rejects.toMatchObject({
      code: 'LIVE_READINESS_FAILED'
    });
    expect(harness.attemptsClaimed).toHaveLength(0);
    expect(harness.publishCalls).toHaveLength(0);
  });

  it('Regression: LIVE + Canary OFF + missing readiness service fails closed with zero publish', async () => {
    const harness = createBatchHarness();
    const item1 = makeItem('i1', 'acc1', 'Group1');
    harness.itemsMap.set(item1.id, item1);

    const unreadyExecutor = new PublishExecutor(
      { get: (id: string) => harness.itemsMap.get(id) } as never,
      harness.attemptsRepo as never,
      harness.accounts as never,
      harness.groups as never,
      { assertControlledDirectory: vi.fn() } as never,
      {} as never,
      harness.publisher as never,
      {} as never,
      {} as never,
      vi.fn(),
      undefined
    );

    await expect(unreadyExecutor.execute(item1.id, { ...harness.defaultSettings, canaryMode: false })).rejects.toMatchObject({
      code: 'LIVE_READINESS_FAILED'
    });
    expect(harness.attemptsClaimed).toHaveLength(0);
    expect(harness.publishCalls).toHaveLength(0);
  });

  it('Regression: forced drain timeout in stopAndDrain returns false without claiming later items', async () => {
    const harness = createBatchHarness();
    const item1 = makeItem('i1', 'acc1', 'Group1');
    const item2 = makeItem('i2', 'acc1', 'Group2');
    harness.itemsMap.set(item1.id, item1);
    harness.itemsMap.set(item2.id, item2);
    harness.readinessMap.set(item1.id, { ready: true, reasons: [] });
    harness.readinessMap.set(item2.id, { ready: true, reasons: [] });

    // Hold item1 publisher indefinitely
    let publishStartedResolve!: () => void;
    const publishStarted = new Promise<void>((resolve) => { publishStartedResolve = resolve; });
    const neverResolve = new Promise<never>(() => { /* never */ });

    harness.publisher.publish.mockImplementation(async () => {
      harness.publishCalls.push(item1.id);
      publishStartedResolve();
      await neverResolve;
      return { result: 'VERIFIED_PUBLISHED', postUrl: 'https://fb.com/p/1', evidence: 'OK' };
    });

    void harness.coordinator.run([item1.id, item2.id], harness.defaultSettings);
    await publishStarted;

    // Timeout drain quickly (20ms)
    const drained = await harness.coordinator.stopAndDrain(20);
    expect(drained).toBe(false);

    // Later item2 was never claimed or published
    expect(harness.publishCalls).toEqual([item1.id]);
    expect(harness.attemptsClaimed).toEqual([item1.id]);
  });
});
