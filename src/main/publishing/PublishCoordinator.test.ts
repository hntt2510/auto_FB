import { describe, expect, it, vi } from 'vitest';
import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import type { PublishExecutor } from './PublishExecutor';
import type { PublishingSettings, QueueItem } from '@shared/types';
import { PublishCoordinator } from './PublishCoordinator';

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
});
