import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import type { PublishCoordinator } from './PublishCoordinator';
import type { PublishingSettingsService } from './PublishingSettingsService';
import { PublishScheduler } from './PublishScheduler';

afterEach(() => vi.useRealTimers());

describe('PublishScheduler', () => {
  it('does nothing while the engine is disabled', async () => {
    vi.useFakeTimers(); const coordinator = { run: vi.fn() }; const scheduler = new PublishScheduler({ due: vi.fn(() => [{ id: 'due' }]) } as unknown as QueueRepository, coordinator as unknown as PublishCoordinator, { get: () => ({ enabled: false, executionMode: 'LIVE', schedulerIntervalSeconds: 30, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600 }) } as PublishingSettingsService, vi.fn());
    scheduler.start(); await vi.advanceTimersByTimeAsync(30000); expect(coordinator.run).not.toHaveBeenCalled(); scheduler.stop();
  });

  it('does not overlap scheduler ticks while execution is pending', async () => {
    vi.useFakeTimers(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const coordinator = { run: vi.fn(async () => gate) }; const scheduler = new PublishScheduler({ due: vi.fn(() => [{ id: 'due' }]) } as unknown as QueueRepository, coordinator as unknown as PublishCoordinator, { get: () => ({ enabled: true, executionMode: 'LIVE', schedulerIntervalSeconds: 30, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600 }) } as PublishingSettingsService, vi.fn());
    scheduler.start(); await vi.advanceTimersByTimeAsync(30000); expect(coordinator.run).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(90000); expect(coordinator.run).toHaveBeenCalledTimes(1); release(); await Promise.resolve(); scheduler.stop();
  });

  it('does not claim due work in dry-run mode', async () => {
    const coordinator = { run: vi.fn() }; const scheduler = new PublishScheduler({ due: vi.fn(() => [{ id: 'due' }]) } as unknown as QueueRepository, coordinator as unknown as PublishCoordinator, { get: () => ({ enabled: true, executionMode: 'DRY_RUN', schedulerIntervalSeconds: 30, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600 }) } as PublishingSettingsService, vi.fn());
    await expect(scheduler.runDue()).resolves.toEqual({ requested: 1, claimed: 0, completed: 0, skipped: 1 }); expect(coordinator.run).not.toHaveBeenCalled();
  });
});
