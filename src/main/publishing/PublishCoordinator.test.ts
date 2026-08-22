import { describe, expect, it, vi } from 'vitest';
import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import type { PublishExecutor } from './PublishExecutor';
import type { PublishingSettings, QueueItem } from '@shared/types';
import { PublishCoordinator } from './PublishCoordinator';

const settings: PublishingSettings = { enabled: true, executionMode: 'LIVE', schedulerIntervalSeconds: 30, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600 };
function item(id: string, accountId: string): QueueItem { return { id, accountId, groupId: crypto.randomUUID(), draftTitle: id, body: '', accountName: accountId, groupName: 'Group', groupUrl: 'https://www.facebook.com/groups/test', status: 'PENDING', media: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }

describe('PublishCoordinator concurrency', () => {
  it('serializes jobs for the same account', async () => {
    const items = new Map([['one', item('one', 'account')], ['two', item('two', 'account')]]); let active = 0; let max = 0;
    const executor = { execute: vi.fn(async () => { active++; max = Math.max(max, active); await new Promise((resolve) => setTimeout(resolve, 10)); active--; return 'COMPLETED' as const; }) };
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as unknown as QueueRepository, executor as unknown as PublishExecutor);
    const result = await coordinator.run(['one', 'two'], settings); expect(max).toBe(1); expect(result.completed).toBe(2);
  });

  it('allows different accounts up to the global limit', async () => {
    const items = new Map([['one', item('one', 'a')], ['two', item('two', 'b')]]); let active = 0; let max = 0;
    const executor = { execute: vi.fn(async () => { active++; max = Math.max(max, active); await new Promise((resolve) => setTimeout(resolve, 10)); active--; return 'COMPLETED' as const; }) };
    const coordinator = new PublishCoordinator({ get: (id: string) => items.get(id) } as unknown as QueueRepository, executor as unknown as PublishExecutor);
    await coordinator.run(['one', 'two'], settings); expect(max).toBe(2);
  });
});
