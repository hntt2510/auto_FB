import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn() } }));

import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { ProfileManager } from '@main/browser/ProfileManager';
import type { SecretStore } from '@main/security/SecretStore';
import type { FacebookAccount } from '@shared/types';
import { AccountService } from './AccountService';

const accountId = '11111111-1111-4111-8111-111111111111';

function makeAccount(overrides: Partial<FacebookAccount> = {}): FacebookAccount {
  const now = new Date().toISOString();
  return { id: accountId, name: 'FB01', profileName: 'fb01', profileDirectory: 'C:/profiles/fb01', proxyEnabled: true,
    proxyHost: 'proxy.example.com', proxyPort: 8080, proxyUsername: 'user', proxyPasswordKey: 'old-key', status: 'STOPPED',
    createdAt: now, updatedAt: now, ...overrides };
}

function setup(updateResult?: (fields: Record<string, unknown>) => FacebookAccount) {
  let current = makeAccount();
  const storedSecrets = new Map<string, string>([['old-key', 'old-password']]);
  let sequence = 0;
  const accounts = {
    normalizeRuntimeStatuses: vi.fn(),
    get: vi.fn(() => current),
    updateProxyAndName: vi.fn((_: string, fields: Record<string, unknown>) => {
      const next = updateResult ? updateResult(fields) : { ...current, ...fields } as FacebookAccount;
      current = next;
      return next;
    }),
    delete: vi.fn()
  };
  const secrets = {
    set: vi.fn((value: string) => { const key = `new-key-${++sequence}`; storedSecrets.set(key, value); return key; }),
    get: vi.fn((key: string) => storedSecrets.get(key)),
    delete: vi.fn((key?: string) => { if (key) storedSecrets.delete(key); })
  };
  const profiles = { createProfile: vi.fn(), deleteProfile: vi.fn(), assertControlledDirectory: vi.fn() };
  const audit = { add: vi.fn() };
  const service = new AccountService(accounts as unknown as AccountRepository, audit as unknown as AuditLogRepository,
    profiles as unknown as ProfileManager, secrets as unknown as SecretStore, vi.fn());
  return { service, accounts, secrets, storedSecrets, profiles, audit };
}

const baseUpdate = { accountId, name: 'FB01', proxyEnabled: true as const, proxyHost: 'proxy.example.com', proxyPort: 8080 };

describe('AccountService secret/database consistency', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves the old authenticated proxy when disabling proxy DB update fails', async () => {
    const fixture = setup();
    fixture.accounts.updateProxyAndName.mockImplementation(() => { throw new Error('simulated database failure'); });
    let error: unknown;
    try { await fixture.service.update({ accountId, name: 'FB01', proxyEnabled: false }); } catch (caught) { error = caught; }
    expect(error).toHaveProperty('code', 'DATABASE_ERROR');
    expect(fixture.storedSecrets.get('old-key')).toBe('old-password');
    expect(fixture.accounts.updateProxyAndName).toHaveBeenCalledWith(accountId, expect.objectContaining({ proxyEnabled: false, proxyPasswordKey: undefined }));
    expect(fixture.secrets.delete).not.toHaveBeenCalled();
  });

  it('cleans a staged replacement secret while retaining the old one after DB failure', async () => {
    const fixture = setup();
    fixture.accounts.updateProxyAndName.mockImplementation(() => { throw new Error('simulated database failure'); });
    let error: unknown;
    try { await fixture.service.update({ ...baseUpdate, proxyUsername: 'user', proxyPassword: 'new-password' }); } catch (caught) { error = caught; }
    expect(error).toHaveProperty('code', 'DATABASE_ERROR');
    expect(fixture.storedSecrets.get('old-key')).toBe('old-password');
    expect(fixture.storedSecrets.get('new-key-1')).toBeUndefined();
    expect(fixture.secrets.delete).toHaveBeenCalledWith('new-key-1');
  });

  it('switches to a new password key before removing the old key on success', async () => {
    const fixture = setup();
    const result = await fixture.service.update({ ...baseUpdate, proxyUsername: 'user', proxyPassword: 'new-password' });
    expect(fixture.accounts.updateProxyAndName).toHaveBeenCalledWith(accountId, expect.objectContaining({ proxyPasswordKey: 'new-key-1' }));
    expect(fixture.storedSecrets.get('new-key-1')).toBe('new-password');
    expect(fixture.storedSecrets.get('old-key')).toBeUndefined();
    expect(result.proxyPasswordKey).toBeUndefined();
  });

  it('removes proxy credentials from the DB before deleting the old secret', async () => {
    const fixture = setup();
    await fixture.service.update(baseUpdate);
    expect(fixture.accounts.updateProxyAndName).toHaveBeenCalledWith(accountId, expect.objectContaining({ proxyUsername: undefined, proxyPasswordKey: undefined }));
    expect(fixture.storedSecrets.get('old-key')).toBeUndefined();
  });

  it('preserves the old secret and profile when account DB deletion fails', async () => {
    const fixture = setup();
    fixture.accounts.delete.mockImplementation(() => { throw new Error('simulated database failure'); });
    let error: unknown;
    try { await fixture.service.delete({ accountId, deleteProfile: true }); } catch (caught) { error = caught; }
    expect(error).toHaveProperty('code', 'DATABASE_ERROR');
    expect(fixture.storedSecrets.get('old-key')).toBe('old-password');
    expect(fixture.secrets.delete).not.toHaveBeenCalled();
    expect(fixture.profiles.deleteProfile).not.toHaveBeenCalled();
  });

  it('keeps the committed DB deletion when profile cleanup fails', async () => {
    const fixture = setup();
    fixture.profiles.deleteProfile.mockImplementation(() => { throw new Error('profile busy'); });
    await fixture.service.delete({ accountId, deleteProfile: true });
    expect(fixture.accounts.delete).toHaveBeenCalledWith(accountId);
    expect(fixture.secrets.delete).toHaveBeenCalledWith('old-key');
    expect(fixture.audit.add).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ACCOUNT_DELETED', message: expect.stringContaining('manual review') }));
  });
});
