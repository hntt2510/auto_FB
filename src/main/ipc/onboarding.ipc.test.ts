import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const handlers = vi.hoisted(() => new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: { sender: { id: number } }, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) }, BrowserWindow: { getAllWindows: () => [] } }));

import type { OnboardingService } from '@main/services/OnboardingService';
import type { AccountSessionService } from '@main/services/AccountSessionService';
import { registerOnboardingIpc } from './onboarding.ipc';

describe('onboarding IPC safety', () => {
  beforeEach(() => handlers.clear());
  it('rejects unauthorized senders on every onboarding channel', async () => { const cleanup = registerOnboardingIpc({} as OnboardingService, {} as AccountSessionService, () => new Set([1])); try { expect(handlers.size).toBe(21); for (const handler of handlers.values()) await expect(handler({ sender: { id: 99 } }, {})).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED_IPC' } }); } finally { cleanup(); } });
  it('rejects malformed plan, task, notes, and session payloads before services run', async () => {
    const service = { start: vi.fn(), updateTask: vi.fn(), updateNotes: vi.fn(), startSession: vi.fn() } as unknown as OnboardingService; const cleanup = registerOnboardingIpc(service, {} as AccountSessionService, () => new Set([1]));
    try {
      await expect(handlers.get('onboarding:start')!({ sender: { id: 1 } }, { accountId: 'bad', templateId: 'AUTO_LIKE' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      await expect(handlers.get('onboarding:update-task')!({ sender: { id: 1 } }, { taskId: 'bad', title: '', description: '', type: 'AUTO_COMMENT' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      await expect(handlers.get('onboarding:notes')!({ sender: { id: 1 } }, { accountId: 'bad', notes: 'x'.repeat(4001) })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      await expect(handlers.get('onboarding:start-session')!({ sender: { id: 1 } }, 'bad')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      expect(service.start).not.toHaveBeenCalled(); expect(service.updateTask).not.toHaveBeenCalled(); expect(service.updateNotes).not.toHaveBeenCalled(); expect(service.startSession).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
  it('rejects malformed account-session settings, URLs, and lifecycle payloads', async () => {
    const sessions = { start: vi.fn(), navigate: vi.fn(), updateSettings: vi.fn(), end: vi.fn() } as unknown as AccountSessionService; const cleanup = registerOnboardingIpc({} as OnboardingService, sessions, () => new Set([1]));
    try {
      await expect(handlers.get('onboarding:start-assisted-session')!({ sender: { id: 1 } }, { accountId: 'bad', targetDurationMinutes: 5 })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      await expect(handlers.get('onboarding:navigate-session')!({ sender: { id: 1 } }, { accountId: '11111111-1111-4111-8111-111111111111', destination: 'URL', url: 'https://facebook.com.evil.example/profile' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      await expect(handlers.get('onboarding:update-session-settings')!({ sender: { id: 1 } }, { targetDurationMinutes: 61 })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      expect(sessions.start).not.toHaveBeenCalled(); expect(sessions.navigate).not.toHaveBeenCalled(); expect(sessions.updateSettings).not.toHaveBeenCalled(); expect(sessions.end).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
  it('introduces no Facebook auto-interaction channels or action definitions', () => {
    const sources = ['src/main/ipc/onboarding.ipc.ts', 'src/main/services/OnboardingService.ts', 'src/main/services/AccountSessionService.ts', 'src/shared/types.ts'].map((path) => readFileSync(join(process.cwd(), path), 'utf8')).join('\n');
    for (const forbidden of ['AUTO_LIKE', 'AUTO_COMMENT', 'AUTO_FRIEND_REQUEST', 'AUTO_FOLLOW', 'AUTO_MESSAGE', 'SCROLL_FEED', 'feedViewed', 'reelsViewed', 'confirmedLikes']) expect(sources).not.toContain(forbidden);
    expect(sources).toContain("'MANUAL_TASK' | 'OPEN_FACEBOOK' | 'OPEN_GROUP' | 'HEALTH_CHECK'");
  });
});
