import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const handlers = vi.hoisted(() => new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: { sender: { id: number } }, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) }, BrowserWindow: { getAllWindows: () => [] } }));

import type { OnboardingService } from '@main/services/OnboardingService';
import { registerOnboardingIpc } from './onboarding.ipc';

describe('onboarding IPC safety', () => {
  beforeEach(() => handlers.clear());
  it('rejects unauthorized senders on every onboarding channel', async () => { const cleanup = registerOnboardingIpc({} as OnboardingService, () => new Set([1])); try { expect(handlers.size).toBe(12); for (const handler of handlers.values()) await expect(handler({ sender: { id: 99 } }, {})).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED_IPC' } }); } finally { cleanup(); } });
  it('rejects malformed plan, task, notes, and session payloads before services run', async () => {
    const service = { start: vi.fn(), updateTask: vi.fn(), updateNotes: vi.fn(), startSession: vi.fn() } as unknown as OnboardingService; const cleanup = registerOnboardingIpc(service, () => new Set([1]));
    try {
      await expect(handlers.get('onboarding:start')!({ sender: { id: 1 } }, { accountId: 'bad', templateId: 'AUTO_LIKE' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      await expect(handlers.get('onboarding:update-task')!({ sender: { id: 1 } }, { taskId: 'bad', title: '', description: '', type: 'AUTO_COMMENT' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      await expect(handlers.get('onboarding:notes')!({ sender: { id: 1 } }, { accountId: 'bad', notes: 'x'.repeat(4001) })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      await expect(handlers.get('onboarding:start-session')!({ sender: { id: 1 } }, 'bad')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      expect(service.start).not.toHaveBeenCalled(); expect(service.updateTask).not.toHaveBeenCalled(); expect(service.updateNotes).not.toHaveBeenCalled(); expect(service.startSession).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
  it('introduces no Facebook auto-interaction channels or action definitions', () => {
    const sources = ['src/main/ipc/onboarding.ipc.ts', 'src/main/services/OnboardingService.ts', 'src/shared/types.ts'].map((path) => readFileSync(join(process.cwd(), path), 'utf8')).join('\n');
    for (const forbidden of ['AUTO_LIKE', 'AUTO_COMMENT', 'AUTO_FRIEND_REQUEST', 'AUTO_FOLLOW', 'AUTO_MESSAGE', 'SCROLL_FEED']) expect(sources).not.toContain(forbidden);
    expect(sources).toContain("'MANUAL_TASK' | 'OPEN_FACEBOOK' | 'OPEN_GROUP' | 'HEALTH_CHECK'");
  });
});
