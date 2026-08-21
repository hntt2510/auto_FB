import { randomUUID } from 'node:crypto';
import { shell } from 'electron';
import { accountIdSchema, createAccountSchema, deleteAccountSchema, updateAccountSchema } from '@shared/schemas';
import type { CreateAccountInput, DeleteAccountInput, FacebookAccount, HealthCheckResult, LogFilter, UpdateAccountInput, AuditLog } from '@shared/types';
import { AccountRepository } from '@main/db/repositories/AccountRepository';
import { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import { SecretStore, SecretStoreError } from '@main/security/SecretStore';
import { BrowserManager } from '@main/browser/BrowserManager';
import { ProfileManager, ProfilePathError } from '@main/browser/ProfileManager';
import { AppError } from '@main/errors';

export class AccountService {
  readonly browser: BrowserManager;

  constructor(
    private readonly accounts: AccountRepository,
    private readonly audit: AuditLogRepository,
    private readonly profiles: ProfileManager,
    private readonly secrets: SecretStore,
    private readonly onChanged: () => void
  ) {
    this.accounts.normalizeRuntimeStatuses();
    this.browser = new BrowserManager(accounts, profiles, secrets, audit, onChanged);
  }

  list(): FacebookAccount[] { return this.accounts.list().map(publicAccount); }
  logs(filter?: LogFilter): AuditLog[] { return this.audit.list(filter); }

  create(input: CreateAccountInput): FacebookAccount {
    const parsed = createAccountSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid account data.');
    const data = parsed.data;
    let profileDirectory: string;
    try { profileDirectory = this.profiles.createProfile(data.profileName); }
    catch (error) { throw new AppError('DUPLICATE_PROFILE', error instanceof ProfilePathError ? error.message : 'Unable to create profile directory.'); }
    let passwordKey: string | undefined;
    try {
      if (data.proxyEnabled && data.proxyPassword) passwordKey = this.secrets.set(data.proxyPassword);
      const timestamp = new Date().toISOString();
      const account = this.accounts.insert({ id: randomUUID(), name: data.name, profileName: data.profileName, profileDirectory,
        proxyEnabled: data.proxyEnabled, proxyHost: data.proxyEnabled ? data.proxyHost : undefined, proxyPort: data.proxyEnabled ? data.proxyPort : undefined,
        proxyUsername: data.proxyEnabled ? data.proxyUsername : undefined, proxyPasswordKey: passwordKey, createdAt: timestamp, updatedAt: timestamp });
      this.audit.add({ accountId: account.id, eventType: 'ACCOUNT_CREATED', message: `Account ${account.name} created.` });
      this.onChanged();
      return publicAccount(account);
    } catch (error) {
      this.secrets.delete(passwordKey);
      this.profiles.deleteProfile(profileDirectory);
      if (error instanceof AppError) throw error;
      throw new AppError('DATABASE_ERROR', 'Unable to save the account.');
    }
  }

  update(input: UpdateAccountInput): FacebookAccount {
    const parsed = updateAccountSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid account data.');
    const data = parsed.data;
    const current = this.require(data.accountId);
    if (this.browser.isRunning(data.accountId)) throw new AppError('ACCOUNT_RUNNING', 'Close the account before editing it.');
    let key = current.proxyPasswordKey;
    try {
      if (!data.proxyEnabled) {
        this.secrets.delete(key); key = undefined;
      } else {
        if (!data.proxyHost || !data.proxyPort) throw new AppError('INVALID_REQUEST', 'Proxy host and port are required.');
        if (data.clearProxyPassword) { this.secrets.delete(key); key = undefined; }
        if (data.proxyPassword) key = this.secrets.set(data.proxyPassword, key);
        if (!data.proxyUsername && key) { this.secrets.delete(key); key = undefined; }
        if (data.proxyUsername && !key) throw new AppError('INVALID_REQUEST', 'Proxy password is required for an authenticated proxy.');
      }
      const account = this.accounts.updateProxyAndName(data.accountId, { name: data.name, proxyEnabled: data.proxyEnabled,
        proxyHost: data.proxyEnabled ? data.proxyHost : undefined, proxyPort: data.proxyEnabled ? data.proxyPort : undefined,
        proxyUsername: data.proxyEnabled ? data.proxyUsername : undefined, proxyPasswordKey: key });
      this.audit.add({ accountId: account.id, eventType: 'ACCOUNT_UPDATED', message: `Account ${account.name} updated.` });
      this.onChanged();
      return publicAccount(account);
    } catch (error) {
      if (error instanceof SecretStoreError) throw new AppError(error.code, error.message);
      if (error instanceof AppError) throw error;
      throw new AppError('DATABASE_ERROR', 'Unable to update the account.');
    }
  }

  async delete(input: DeleteAccountInput): Promise<void> {
    const parsed = deleteAccountSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid delete request.');
    const account = this.require(parsed.data.accountId);
    if (this.browser.isRunning(account.id)) throw new AppError('ACCOUNT_RUNNING', 'Close the account before deleting it.');
    if (parsed.data.deleteProfile) {
      try { this.profiles.deleteProfile(account.profileDirectory); }
      catch (error) { throw new AppError('PROFILE_DELETE_FAILED', error instanceof Error ? error.message : 'Unable to delete the profile directory.'); }
    }
    this.secrets.delete(account.proxyPasswordKey);
    this.accounts.delete(account.id);
    this.audit.add({ accountId: account.id, eventType: 'ACCOUNT_DELETED', message: parsed.data.deleteProfile ? 'Account and profile deleted.' : 'Account record deleted; profile preserved.' });
    this.onChanged();
  }

  async open(accountId: string): Promise<FacebookAccount> { const id = this.validId(accountId); return publicAccount(await this.browser.openAccount(id)); }
  async close(accountId: string): Promise<FacebookAccount> { const id = this.validId(accountId); return publicAccount(await this.browser.closeAccount(id)); }
  async healthCheck(accountId: string): Promise<HealthCheckResult> { return this.browser.healthCheck(this.validId(accountId)); }

  async openProfileFolder(accountId: string): Promise<void> {
    const account = this.require(this.validId(accountId));
    this.profiles.assertControlledDirectory(account.profileDirectory);
    const error = await shell.openPath(account.profileDirectory);
    if (error) throw new AppError('INVALID_PROFILE_PATH', 'Unable to open the profile folder.');
  }

  private require(id: string): FacebookAccount {
    const account = this.accounts.get(id);
    if (!account) throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.');
    return account;
  }

  private validId(id: string): string {
    const parsed = accountIdSchema.safeParse(id);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Invalid account id.');
    return parsed.data;
  }
}

function publicAccount(account: FacebookAccount): FacebookAccount {
  return { ...account, proxyPasswordKey: undefined };
}
