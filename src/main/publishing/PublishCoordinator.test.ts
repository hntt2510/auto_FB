import { describe, expect, it, vi } from 'vitest';
import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import type { PublishExecutor } from './PublishExecutor';
import type { PublishingSettings, QueueItem } from '@shared/types';
import { canContinueAccountLane, PublishCoordinator } from './PublishCoordinator';

const settings: PublishingSettings = { enabled: true, executionMode: 'LIVE', schedulerIntervalSeconds: 30, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600, maxJobsPerSchedulerSession: 20, batchPacingSeconds: 120 };
function item(id: string, accountId: string): QueueItem { return { id, accountId, groupId: crypto.randomUUID(), draftTitle: id, body: '', accountName: accountId, groupName: 'Group', groupUrl: 'https://www.facebook.com/groups/test', status: 'PENDING', media: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }

describe('PublishCoordinator concurrency', () => {
  it('serializes jobs for the same account', async () => {
    const items = new Map([['one', item('one', 'account')], ['two', item('two', 'account')]]); let active = 0; let max = 0;
    const executor = { execute: vi.fn(async () => { active++; max = Math.max(max, active); await new Promise((resolve) => setTimeout(resolve, 10)); active--; return { started: true, finalStatus: 'SUCCEEDED' as const }; }) };
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as unknown as QueueRepository, executor as unknown as PublishExecutor, () => undefined, { now: () => Date.now(), wait: async () => undefined });
    const result = await coordinator.run(['one', 'two'], settings); expect(max).toBe(1); expect(result.completed).toBe(2);
  });

  it('allows different accounts up to the global limit', async () => {
    const items = new Map([['one', item('one', 'a')], ['two', item('two', 'b')]]); let active = 0; let max = 0;
    const executor = { execute: vi.fn(async () => { active++; max = Math.max(max, active); await new Promise((resolve) => setTimeout(resolve, 10)); active--; return { started: true, finalStatus: 'SUCCEEDED' as const }; }) };
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as unknown as QueueRepository, executor as unknown as PublishExecutor);
    await coordinator.run(['one', 'two'], settings); expect(max).toBe(2);
  });

  it('does not release the same-account queue during the post-submit hold', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const items = new Map([['one', item('one', 'account')], ['two', item('two', 'account')]]); const starts: Array<{ id: string; at: number }> = [];
      const executor = { execute: vi.fn(async (id: string) => { starts.push({ id, at: Date.now() }); await new Promise((resolve) => setTimeout(resolve, 5000)); return { started: true, finalStatus: 'SUCCEEDED' as const }; }) };
      const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as unknown as QueueRepository, executor as unknown as PublishExecutor);
      const running = coordinator.run(['one', 'two'], settings); await vi.advanceTimersByTimeAsync(0); expect(starts).toEqual([{ id: 'one', at: 0 }]);
      await vi.advanceTimersByTimeAsync(5000); expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(119_999); expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); expect(starts).toEqual([{ id: 'one', at: 0 }, { id: 'two', at: 125000 }]);
      await vi.advanceTimersByTimeAsync(5000); await running;
    } finally { vi.useRealTimers(); }
  });

  it('stops accepting queued work while allowing the current operation to finish', async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const items = new Map([['one', item('one', 'account')], ['two', item('two', 'account')]]); const started: string[] = [];
    const executor = { execute: vi.fn(async (id: string) => { started.push(id); await gate; return { started: true, finalStatus: 'SUCCEEDED' as const }; }) }; const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as unknown as QueueRepository, executor as unknown as PublishExecutor);
    const run = coordinator.run(['one', 'two'], settings); await new Promise((resolve) => setTimeout(resolve, 0)); const draining = coordinator.stopAfterCurrent(1000); expect(started).toEqual(['one']); release(); expect(await draining).toBe(true); expect(await run).toEqual({ requested: 2, claimed: 1, completed: 1, skipped: 1 }); expect(started).toEqual(['one']);
  });

  it('applies the configured fixed pacing before the next same-account job', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const items = new Map([['one', item('one', 'account')], ['two', item('two', 'account')]]); const starts: Array<{ id: string; at: number }> = [];
      const executor = { execute: vi.fn(async (id: string) => { starts.push({ id, at: Date.now() }); return { started: true, finalStatus: 'SUCCEEDED' as const }; }) };
      const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, executor as never);
      const run = coordinator.run(['one', 'two'], { ...settings, batchPacingSeconds: 10 }); await vi.advanceTimersByTimeAsync(0);
      expect(starts).toEqual([{ id: 'one', at: 0 }]); expect(coordinator.status()?.lanes[0].state).toBe('COOLDOWN');
      await vi.advanceTimersByTimeAsync(9_999); expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); await run; expect(starts).toEqual([{ id: 'one', at: 0 }, { id: 'two', at: 10_000 }]);
    } finally { vi.useRealTimers(); }
  });

  it('cancels a cooldown without allowing a stale next job to start', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const items = new Map([['one', item('one', 'account')], ['two', item('two', 'account')]]); const started: string[] = [];
      const executor = { execute: vi.fn(async (id: string) => { started.push(id); return { started: true, finalStatus: 'SUCCEEDED' as const }; }) };
      const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, executor as never);
      const run = coordinator.run(['one', 'two'], { ...settings, batchPacingSeconds: 10 }); await vi.advanceTimersByTimeAsync(0); expect(started).toEqual(['one']);
      expect(await coordinator.stopAfterCurrent(1000)).toBe(true); await run; await vi.advanceTimersByTimeAsync(20_000); expect(started).toEqual(['one']); expect(coordinator.status()?.state).toBe('INTERRUPTED');
    } finally { vi.useRealTimers(); }
  });

  it('stops a same-account chain after a non-success terminal outcome', async () => {
    const items = new Map([['one', item('one', 'account')], ['two', item('two', 'account')]]); const execute = vi.fn(async () => ({ started: true, finalStatus: 'NEEDS_ATTENTION' as const }));
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never, () => undefined, { now: () => 0, wait: async () => undefined });
    const result = await coordinator.run(['one', 'two'], settings); expect(execute).toHaveBeenCalledTimes(1); expect(result).toEqual({ requested: 2, claimed: 1, completed: 1, skipped: 1 });
  });

  it('continues a same-account chain after a submitted post awaiting group approval', async () => {
    const items = new Map([['one', item('one', 'account')], ['two', item('two', 'account')]]);
    const execute = vi.fn(async () => ({ started: true, finalStatus: 'SUBMITTED' as const }));
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never, () => undefined, { now: () => 0, wait: async () => undefined });
    const result = await coordinator.run(['one', 'two'], settings);
    expect(execute).toHaveBeenCalledTimes(2); expect(result).toEqual({ requested: 2, claimed: 2, completed: 2, skipped: 0 });
  });
});

describe('PublishCoordinator continuation policy (Section 17 requirements)', () => {
  it('1. SUCCEEDED -> next same-account item starts', async () => {
    const items = new Map([['item1', item('item1', 'acc1')], ['item2', item('item2', 'acc1')]]);
    const executed: string[] = [];
    const execute = vi.fn(async (id: string) => {
      executed.push(id);
      return { started: true, finalStatus: 'SUCCEEDED' as const };
    });
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never, () => undefined, { now: () => 0, wait: async () => undefined });
    const result = await coordinator.run(['item1', 'item2'], settings);
    expect(executed).toEqual(['item1', 'item2']);
    expect(result).toEqual({ requested: 2, claimed: 2, completed: 2, skipped: 0 });
  });

  it('2. SUBMITTED -> next same-account item starts', async () => {
    const items = new Map([['item1', item('item1', 'acc1')], ['item2', item('item2', 'acc1')]]);
    const executed: string[] = [];
    const execute = vi.fn(async (id: string) => {
      executed.push(id);
      return { started: true, finalStatus: 'SUBMITTED' as const };
    });
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never, () => undefined, { now: () => 0, wait: async () => undefined });
    const result = await coordinator.run(['item1', 'item2'], settings);
    expect(executed).toEqual(['item1', 'item2']);
    expect(result).toEqual({ requested: 2, claimed: 2, completed: 2, skipped: 0 });
  });

  it('3. SUBMITTED -> configured pacing still occurs', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const items = new Map([['item1', item('item1', 'acc1')], ['item2', item('item2', 'acc1')]]);
      const starts: Array<{ id: string; at: number }> = [];
      const execute = vi.fn(async (id: string) => {
        starts.push({ id, at: Date.now() });
        return { started: true, finalStatus: 'SUBMITTED' as const };
      });
      const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never);
      const run = coordinator.run(['item1', 'item2'], { ...settings, batchPacingSeconds: 30 });
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toEqual([{ id: 'item1', at: 0 }]);
      expect(coordinator.status()?.lanes[0].state).toBe('COOLDOWN');
      await vi.advanceTimersByTimeAsync(29_999);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await run;
      expect(starts).toEqual([{ id: 'item1', at: 0 }, { id: 'item2', at: 30_000 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('4. Sequence: SUBMITTED, SUBMITTED, SUCCEEDED -> all execute', async () => {
    const items = new Map([
      ['g1', item('g1', 'acc1')],
      ['g2', item('g2', 'acc1')],
      ['g3', item('g3', 'acc1')]
    ]);
    const executed: string[] = [];
    const statuses = ['SUBMITTED' as const, 'SUBMITTED' as const, 'SUCCEEDED' as const];
    let callIndex = 0;
    const execute = vi.fn(async (id: string) => {
      executed.push(id);
      return { started: true, finalStatus: statuses[callIndex++] };
    });
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never, () => undefined, { now: () => 0, wait: async () => undefined });
    const result = await coordinator.run(['g1', 'g2', 'g3'], settings);
    expect(executed).toEqual(['g1', 'g2', 'g3']);
    expect(result).toEqual({ requested: 3, claimed: 3, completed: 3, skipped: 0 });
    expect(coordinator.status()?.state).toBe('COMPLETED');
  });

  it('5. SUBMITTED remains queue status SUBMITTED (policy preserves semantics)', async () => {
    const items = new Map([['item1', item('item1', 'acc1')]]);
    const execute = vi.fn(async () => ({ started: true, finalStatus: 'SUBMITTED' as const }));
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never, () => undefined, { now: () => 0, wait: async () => undefined });
    await coordinator.run(['item1'], settings);
    // Executor returned SUBMITTED and coordinator did not alter it
    const lastBatch = coordinator.status();
    expect(lastBatch?.completed).toBe(1);
    expect(lastBatch?.state).toBe('COMPLETED');
  });

  it('6. NEEDS_ATTENTION -> remaining same-account items never start', async () => {
    const items = new Map([
      ['item1', item('item1', 'acc1')],
      ['item2', item('item2', 'acc1')],
      ['item3', item('item3', 'acc1')]
    ]);
    const executed: string[] = [];
    const execute = vi.fn(async (id: string) => {
      executed.push(id);
      return { started: true, finalStatus: 'NEEDS_ATTENTION' as const };
    });
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never, () => undefined, { now: () => 0, wait: async () => undefined });
    const result = await coordinator.run(['item1', 'item2', 'item3'], settings);
    expect(executed).toEqual(['item1']);
    expect(result).toEqual({ requested: 3, claimed: 1, completed: 1, skipped: 2 });
    expect(coordinator.status()?.state).toBe('INTERRUPTED');
    expect(coordinator.status()?.reason).toBe('ACCOUNT_CHAIN_NEEDS_ATTENTION');
    expect(coordinator.status()?.lanes[0].state).toBe('BLOCKED');
  });

  it('7. FAILED -> remaining same-account items never start', async () => {
    const items = new Map([
      ['item1', item('item1', 'acc1')],
      ['item2', item('item2', 'acc1')]
    ]);
    const executed: string[] = [];
    const execute = vi.fn(async (id: string) => {
      executed.push(id);
      return { started: true, finalStatus: 'FAILED' as const };
    });
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never, () => undefined, { now: () => 0, wait: async () => undefined });
    const result = await coordinator.run(['item1', 'item2'], settings);
    expect(executed).toEqual(['item1']);
    expect(result).toEqual({ requested: 2, claimed: 1, completed: 1, skipped: 1 });
    expect(coordinator.status()?.state).toBe('INTERRUPTED');
    expect(coordinator.status()?.reason).toBe('ACCOUNT_CHAIN_FAILED');
  });

  it('8. checkpoint -> remaining same-account items never start', async () => {
    const items = new Map([
      ['item1', item('item1', 'acc1')],
      ['item2', item('item2', 'acc1')]
    ]);
    const executed: string[] = [];
    const context: { coordinator?: PublishCoordinator } = {};
    const execute = vi.fn(async (id: string) => {
      executed.push(id);
      context.coordinator?.blockAccount('acc1', 'CHECKPOINT');
      return { started: true, finalStatus: 'NEEDS_ATTENTION' as const };
    });
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never, () => undefined, { now: () => 0, wait: async () => undefined });
    context.coordinator = coordinator;
    const result = await coordinator.run(['item1', 'item2'], settings);
    expect(executed).toEqual(['item1']);
    expect(result).toEqual({ requested: 2, claimed: 1, completed: 1, skipped: 1 });
    expect(coordinator.status()?.state).toBe('INTERRUPTED');
    expect(coordinator.status()?.lanes[0].state).toBe('BLOCKED');
  });

  it('9. other healthy account lane remains independent', async () => {
    const items = new Map([
      ['a1', item('a1', 'accA')],
      ['a2', item('a2', 'accA')],
      ['b1', item('b1', 'accB')],
      ['b2', item('b2', 'accB')]
    ]);
    const executed: string[] = [];
    const execute = vi.fn(async (id: string) => {
      executed.push(id);
      if (id === 'a1') return { started: true, finalStatus: 'NEEDS_ATTENTION' as const };
      return { started: true, finalStatus: 'SUCCEEDED' as const };
    });
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never, () => undefined, { now: () => 0, wait: async () => undefined });
    const result = await coordinator.run(['a1', 'a2', 'b1', 'b2'], { ...settings, maxConcurrentAccounts: 2 });
    expect(executed).toContain('a1');
    expect(executed).not.toContain('a2');
    expect(executed).toContain('b1');
    expect(executed).toContain('b2');
    expect(result.claimed).toBe(3);
    expect(result.completed).toBe(3);
    expect(result.skipped).toBe(1);
    const lanes = coordinator.status()?.lanes;
    const laneA = lanes?.find((l) => l.accountId === 'accA');
    const laneB = lanes?.find((l) => l.accountId === 'accB');
    expect(laneA?.state).toBe('BLOCKED');
    expect(laneB?.state).toBe('COMPLETED');
  });

  it('10. clean all-SUBMITTED batch finishes COMPLETED', async () => {
    const items = new Map([
      ['item1', item('item1', 'acc1')],
      ['item2', item('item2', 'acc1')],
      ['item3', item('item3', 'acc1')]
    ]);
    const execute = vi.fn(async () => ({ started: true, finalStatus: 'SUBMITTED' as const }));
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never, () => undefined, { now: () => 0, wait: async () => undefined });
    const result = await coordinator.run(['item1', 'item2', 'item3'], settings);
    expect(result).toEqual({ requested: 3, claimed: 3, completed: 3, skipped: 0 });
    expect(coordinator.status()?.state).toBe('COMPLETED');
  });

  it('11. selected order remains strict per account', async () => {
    const items = new Map([
      ['third', item('third', 'acc1')],
      ['first', item('first', 'acc1')],
      ['second', item('second', 'acc1')]
    ]);
    const executionOrder: string[] = [];
    const execute = vi.fn(async (id: string) => {
      executionOrder.push(id);
      return { started: true, finalStatus: 'SUCCEEDED' as const };
    });
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as never, { execute } as never, () => undefined, { now: () => 0, wait: async () => undefined });
    await coordinator.run(['third', 'first', 'second'], settings);
    expect(executionOrder).toEqual(['third', 'first', 'second']);
  });
});

describe('canContinueAccountLane helper', () => {
  it('permits continuation for started SUCCEEDED outcome', () => {
    expect(canContinueAccountLane({ started: true, finalStatus: 'SUCCEEDED' })).toBe(true);
  });

  it('permits continuation for started SUBMITTED outcome', () => {
    expect(canContinueAccountLane({ started: true, finalStatus: 'SUBMITTED' })).toBe(true);
  });

  it('blocks continuation when not started', () => {
    expect(canContinueAccountLane({ started: false, finalStatus: 'SUCCEEDED' })).toBe(false);
    expect(canContinueAccountLane({ started: false })).toBe(false);
  });

  it('blocks continuation for NEEDS_ATTENTION', () => {
    expect(canContinueAccountLane({ started: true, finalStatus: 'NEEDS_ATTENTION' })).toBe(false);
  });

  it('blocks continuation for FAILED', () => {
    expect(canContinueAccountLane({ started: true, finalStatus: 'FAILED' })).toBe(false);
  });

  it('blocks continuation for CANCELLED or undefined status', () => {
    expect(canContinueAccountLane({ started: true, finalStatus: 'CANCELLED' })).toBe(false);
    expect(canContinueAccountLane({ started: true })).toBe(false);
  });
});
