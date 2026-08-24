import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: { sender: { id: number } }, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) },
  BrowserWindow: { getAllWindows: () => [] }
}));

import type { AccountService } from '@main/services/AccountService';
import { registerIpc } from './accounts.ipc';

describe('account proxy IPC authorization and validation', () => {
  beforeEach(() => handlers.clear());

  it('rejects unauthorized senders on the new proxy channels', async () => {
    const cleanup = registerIpc({} as AccountService, () => new Set([1]));
    try {
      expect(handlers.size).toBe(12);
      for (const channel of ['accounts:test-proxy', 'accounts:proxy-import-preview']) {
        await expect(handlers.get(channel)!({ sender: { id: 99 } }, {})).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED_IPC' } });
      }
    } finally { cleanup(); }
  });

  it('rejects malformed proxy payloads before calling the service', async () => {
    const service = { testProxy: vi.fn(), previewProxyImport: vi.fn() } as unknown as AccountService; const cleanup = registerIpc(service, () => new Set([1]));
    try {
      await expect(handlers.get('accounts:test-proxy')!({ sender: { id: 1 } }, { proxyProtocol: 'FTP', proxyHost: '', proxyPort: 70000 })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      await expect(handlers.get('accounts:proxy-import-preview')!({ sender: { id: 1 } }, { text: 'x'.repeat(256_001) })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      expect(service.testProxy).not.toHaveBeenCalled(); expect(service.previewProxyImport).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
});
