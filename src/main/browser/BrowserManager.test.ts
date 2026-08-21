import { describe, expect, it, vi } from 'vitest';
import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { SecretStore } from '@main/security/SecretStore';
import type { ProfileManager } from './ProfileManager';
import type { FacebookAccount } from '@shared/types';
import { BrowserManager, type PersistentContextLauncher } from './BrowserManager';

const accountId = '22222222-2222-4222-8222-222222222222';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeContext() {
  let closeHandler: (() => void) | undefined;
  let closed = false;
  const page = { goto: vi.fn(async () => undefined) };
  const context = {
    pages: () => [page],
    on: vi.fn((_event: string, handler: () => void) => { closeHandler = handler; }),
    close: vi.fn(async () => { if (!closed) { closed = true; closeHandler?.(); } })
  };
  return { context, page, triggerClose: () => { if (!closed) { closed = true; closeHandler?.(); } } };
}

function fixture(launcher: PersistentContextLauncher) {
  let account: FacebookAccount = { id: accountId, name: 'FB01', profileName: 'fb01', profileDirectory: 'C:/profiles/fb01', proxyEnabled: false, status: 'STOPPED', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const accounts = {
    get: vi.fn(() => account),
    setStatus: vi.fn((_id: string, status: FacebookAccount['status']) => { account = { ...account, status }; }),
    setOpened: vi.fn((_id: string, openedAt: string) => { account = { ...account, status: 'RUNNING', lastOpenedAt: openedAt }; }),
    setHealth: vi.fn(),
    list: vi.fn(() => [account])
  };
  const audit = { add: vi.fn() };
  const profiles = { assertControlledDirectory: vi.fn() };
  const manager = new BrowserManager(accounts as unknown as AccountRepository, profiles as unknown as ProfileManager, {} as SecretStore, audit as unknown as AuditLogRepository, vi.fn(), launcher);
  return { manager, accounts, audit, profiles };
}

describe('BrowserManager lifecycle serialization', () => {
  it('rejects concurrent OPEN calls without launching two contexts', async () => {
    const gate = deferred<ReturnType<typeof makeContext>['context']>();
    const launcher = vi.fn(async () => gate.promise) as unknown as PersistentContextLauncher;
    const { manager } = fixture(launcher);
    const first = manager.openAccount(accountId);
    const second = manager.openAccount(accountId);
    await vi.waitFor(() => expect(launcher).toHaveBeenCalledTimes(1));
    const runtime = makeContext(); gate.resolve(runtime.context);
    await first;
    await expect(second).rejects.toMatchObject({ code: 'ACCOUNT_ALREADY_RUNNING' });
    await manager.closeAccount(accountId);
  });

  it('queues CLOSE behind an in-flight STARTING launch', async () => {
    const gate = deferred<ReturnType<typeof makeContext>['context']>();
    const launcher = vi.fn(async () => gate.promise) as unknown as PersistentContextLauncher;
    const { manager } = fixture(launcher);
    const opening = manager.openAccount(accountId);
    await vi.waitFor(() => expect(launcher).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = manager.closeAccount(accountId).then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    const runtime = makeContext(); gate.resolve(runtime.context);
    await opening; await closing;
    expect(runtime.context.close).toHaveBeenCalledTimes(1);
    expect(manager.isRunning(accountId)).toBe(false);
  });

  it('supports OPEN then CLOSE then OPEN as separate serialized lifecycles', async () => {
    const first = makeContext(); const second = makeContext();
    const launchMock = vi.fn(async () => launchMock.mock.calls.length === 1 ? first.context as never : second.context as never);
    const launcher = launchMock as unknown as PersistentContextLauncher;
    const { manager } = fixture(launcher);
    await manager.openAccount(accountId); await manager.closeAccount(accountId); await manager.openAccount(accountId);
    expect(launcher).toHaveBeenCalledTimes(2); expect(manager.isRunning(accountId)).toBe(true);
    await manager.closeAccount(accountId);
  });

  it('releases lifecycle state after launch failure so a later OPEN can retry', async () => {
    let fail = true; const runtime = makeContext();
    const launcher = vi.fn(async () => { if (fail) throw new Error('launch failed'); return runtime.context as never; }) as unknown as PersistentContextLauncher;
    const { manager } = fixture(launcher);
    await expect(manager.openAccount(accountId)).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_FAILED' });
    expect(manager.isRunning(accountId)).toBe(false); fail = false;
    await manager.openAccount(accountId); expect(manager.isRunning(accountId)).toBe(true); await manager.closeAccount(accountId);
  });

  it('finalizes exactly once when context close and explicit close both occur', async () => {
    const runtime = makeContext(); const { manager, audit } = fixture(async () => runtime.context as never);
    await manager.openAccount(accountId); runtime.triggerClose(); await manager.closeAccount(accountId);
    expect(audit.add.mock.calls.filter(([entry]) => entry.eventType === 'BROWSER_CLOSED')).toHaveLength(1);
    expect(manager.isRunning(accountId)).toBe(false);
  });

  it('waits for a pending launch before closeAll clears locks', async () => {
    const gate = deferred<ReturnType<typeof makeContext>['context']>();
    const launcher = vi.fn(async () => gate.promise) as unknown as PersistentContextLauncher;
    const { manager } = fixture(launcher);
    const opening = manager.openAccount(accountId); await vi.waitFor(() => expect(launcher).toHaveBeenCalledTimes(1));
    const shutdown = manager.closeAll(); let settled = false; void shutdown.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    const runtime = makeContext(); gate.resolve(runtime.context); await opening; await shutdown;
    expect(runtime.context.close).toHaveBeenCalledTimes(1); expect(manager.isRunning(accountId)).toBe(false);
  });
});
