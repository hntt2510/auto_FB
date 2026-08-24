import { randomUUID } from 'node:crypto';
import { shell } from 'electron';
import { accountIdSchema, createAccountSchema, deleteAccountSchema, proxyImportSchema, proxyTestSchema, updateAccountSchema } from '@shared/schemas';
import type { AccountOperationsSummary, CreateAccountInput, DeleteAccountInput, FacebookAccount, HealthCheckResult, LogFilter, ProxyImportPreview, ProxyTestInput, ProxyTestResult, UpdateAccountInput, AuditLog } from '@shared/types';
import { AccountRepository } from '@main/db/repositories/AccountRepository';
import { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import { SecretStore, SecretStoreError } from '@main/security/SecretStore';
import { BrowserManager } from '@main/browser/BrowserManager';
import { ProfileManager, ProfilePathError } from '@main/browser/ProfileManager';
import { AppError } from '@main/errors';
import { ProxyTestService } from '@main/proxy/ProxyTestService';
import { previewProxyImport } from '@shared/proxy';

export class AccountService {
  readonly browser: BrowserManager;
  private healthObserver?: (result: HealthCheckResult) => void;
  private readonly proxyTester: ProxyTestService;

  constructor(
    private readonly accounts: AccountRepository,
    private readonly audit: AuditLogRepository,
    private readonly profiles: ProfileManager,
    private readonly secrets: SecretStore,
    private readonly onChanged: () => void,
    proxyTester?: ProxyTestService
  ) {
    this.accounts.normalizeRuntimeStatuses();
    this.browser = new BrowserManager(accounts, profiles, secrets, audit, onChanged);
    this.proxyTester = proxyTester ?? new ProxyTestService();
  }

  list(): FacebookAccount[] { return this.accounts.list().map(publicAccount); }
  operations(): AccountOperationsSummary[] { return this.accounts.operations(); }
  logs(filter?: LogFilter): AuditLog[] { return this.audit.list(filter); }

  create(input: CreateAccountInput): FacebookAccount {
    const parsed = createAccountSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid account data.');
    const data = parsed.data;
    let profileDirectory: string;
    try { profileDirectory = this.profiles.createProfile(data.profileName); }
    catch (error) { throw new AppError('DUPLICATE_PROFILE', error instanceof ProfilePathError ? error.message : 'Unable to create profile directory.'); }
    let passwordKey: string | undefined;
    let account: FacebookAccount;
    try {
      if (data.proxyEnabled && data.proxyPassword) passwordKey = this.secrets.set(data.proxyPassword);
      const timestamp = new Date().toISOString();
      account = this.accounts.insert({ id: randomUUID(), name: data.name, profileName: data.profileName, profileDirectory,
        proxyEnabled: data.proxyEnabled, proxyProtocol: data.proxyEnabled ? data.proxyProtocol : 'HTTP', proxyHost: data.proxyEnabled ? data.proxyHost : undefined, proxyPort: data.proxyEnabled ? data.proxyPort : undefined,
        proxyUsername: data.proxyEnabled ? data.proxyUsername : undefined, proxyPasswordKey: passwordKey, createdAt: timestamp, updatedAt: timestamp });
    } catch (error) {
      this.secrets.delete(passwordKey);
      this.profiles.deleteProfile(profileDirectory);
      if (error instanceof AppError) throw error;
      throw new AppError('DATABASE_ERROR', 'Unable to save the account.');
    }
    // Audit and renderer notification must never roll back a committed account
    // or delete its profile/secret after the database row exists.
    try { this.audit.add({ accountId: account.id, eventType: 'ACCOUNT_CREATED', message: `Account ${account.name} created.` }); } catch { /* best-effort audit */ }
    this.notifyChanged();
    return publicAccount(account);
  }

  update(input: UpdateAccountInput): FacebookAccount {
    const parsed = updateAccountSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid account data.');
    const data = parsed.data;
    const current = this.require(data.accountId);
    if (this.browser.isRunning(data.accountId)) throw new AppError('ACCOUNT_RUNNING', 'Close this account browser before changing proxy settings.');
    const oldKey = current.proxyPasswordKey;
    let key = oldKey;
    let newKey: string | undefined;
    let oldKeyToDelete: string | undefined;
    let dbUpdated = false;
    try {
      if (!data.proxyEnabled) {
        key = undefined;
        oldKeyToDelete = oldKey;
      } else {
        if (!data.proxyHost || !data.proxyPort) throw new AppError('INVALID_REQUEST', 'Proxy host and port are required.');
        if (data.clearProxyPassword) { key = undefined; oldKeyToDelete = oldKey; }
        if (data.proxyPassword) {
          // Always stage a new key. The old secret remains usable until the
          // account row has successfully switched to the new key.
          newKey = this.secrets.set(data.proxyPassword);
          key = newKey;
          oldKeyToDelete = oldKey;
        }
        if (!data.proxyUsername && key) { key = undefined; oldKeyToDelete = oldKey; }
        if (data.proxyUsername && !key) throw new AppError('INVALID_REQUEST', 'Proxy password is required for an authenticated proxy.');
      }
      const resetProxyStatus = current.proxyEnabled !== data.proxyEnabled || current.proxyProtocol !== data.proxyProtocol || current.proxyHost !== data.proxyHost || current.proxyPort !== data.proxyPort || current.proxyUsername !== data.proxyUsername || Boolean(data.proxyPassword) || Boolean(data.clearProxyPassword);
      const account = this.accounts.updateProxyAndName(data.accountId, { name: data.name, proxyEnabled: data.proxyEnabled, proxyProtocol: data.proxyEnabled ? data.proxyProtocol : 'HTTP', resetProxyStatus,
        proxyHost: data.proxyEnabled ? data.proxyHost : undefined, proxyPort: data.proxyEnabled ? data.proxyPort : undefined,
        proxyUsername: data.proxyEnabled ? data.proxyUsername : undefined, proxyPasswordKey: key });
      dbUpdated = true;
      if (oldKeyToDelete && oldKeyToDelete !== key) {
        try { this.secrets.delete(oldKeyToDelete); } catch { /* orphaned ciphertext is safer than a stale DB reference */ }
      }
      try { this.audit.add({ accountId: account.id, eventType: 'ACCOUNT_UPDATED', message: `Account ${account.name} updated.` }); } catch { /* best-effort audit */ }
      this.notifyChanged();
      return publicAccount(account);
    } catch (error) {
      if (newKey && !dbUpdated) {
        try { this.secrets.delete(newKey); } catch { /* cleanup failure leaves an unreferenced secret */ }
      }
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
    if (this.accounts.hasActiveQueueItems(account.id)) throw new AppError('ENTITY_IN_USE', 'Cancel or remove active queue items before deleting this account.');
    // Remove the DB row first. If that fails, the account, profile, and secret
    // remain fully recoverable. Cleanup after commit is deliberately best effort.
    try { this.accounts.delete(account.id); }
    catch { throw new AppError('DATABASE_ERROR', 'Unable to delete the account record.'); }
    let cleanupWarning = false;
    try { this.secrets.delete(account.proxyPasswordKey); } catch { cleanupWarning = true; }
    if (parsed.data.deleteProfile) {
      try { this.profiles.deleteProfile(account.profileDirectory); }
      catch { cleanupWarning = true; }
    }
    const message = parsed.data.deleteProfile
      ? cleanupWarning ? 'Account record deleted; profile or secret cleanup requires manual review.' : 'Account and profile deleted.'
      : cleanupWarning ? 'Account record deleted; secret cleanup requires manual review.' : 'Account record deleted; profile preserved.';
    try { this.audit.add({ accountId: account.id, eventType: 'ACCOUNT_DELETED', message }); } catch { /* best-effort audit */ }
    this.notifyChanged();
  }

  async open(accountId: string): Promise<FacebookAccount> { const id = this.validId(accountId); return publicAccount(await this.browser.openAccount(id)); }
  async close(accountId: string): Promise<FacebookAccount> { const id = this.validId(accountId); return publicAccount(await this.browser.closeAccount(id)); }
  async healthCheck(accountId: string): Promise<HealthCheckResult> { const result = await this.browser.healthCheck(this.validId(accountId)); this.healthObserver?.(result); return result; }
  setHealthObserver(observer: (result: HealthCheckResult) => void): void { this.healthObserver = observer; }

  previewProxyImport(text: string): ProxyImportPreview { const parsed = proxyImportSchema.safeParse({ text }); if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Proxy import text is too large or invalid.'); return previewProxyImport(parsed.data.text); }

  async testProxy(input: ProxyTestInput): Promise<ProxyTestResult> {
    const parsed = proxyTestSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid proxy test configuration.'); const data = parsed.data;
    let password = data.proxyPassword; let account: FacebookAccount | undefined;
    if (data.accountId) {
      account = this.require(data.accountId);
      if (!password && data.proxyUsername) {
        if (!account.proxyPasswordKey || account.proxyUsername !== data.proxyUsername) throw new AppError('INVALID_REQUEST', 'A password is required for these proxy credentials.');
        try { password = this.secrets.get(account.proxyPasswordKey); } catch (error) { if (error instanceof SecretStoreError) throw new AppError(error.code, error.message); throw error; }
      }
    }
    const result = await this.proxyTester.test({ proxyProtocol: data.proxyProtocol, proxyHost: data.proxyHost, proxyPort: data.proxyPort, proxyUsername: data.proxyUsername }, password);
    const matchesSaved = Boolean(account?.proxyEnabled && !data.proxyPassword && account.proxyProtocol === data.proxyProtocol && account.proxyHost === data.proxyHost && account.proxyPort === data.proxyPort && account.proxyUsername === data.proxyUsername);
    if (account && matchesSaved) { this.accounts.setProxyTest(account.id, result); this.notifyChanged(); }
    try { this.audit.add({ accountId: account?.id, eventType: result.success ? 'PROXY_TEST_SUCCEEDED' : 'PROXY_TEST_FAILED', message: result.success ? 'Proxy connectivity test succeeded.' : 'Proxy connectivity test failed.', metadata: JSON.stringify({ protocol: data.proxyProtocol, host: data.proxyHost, port: data.proxyPort, latencyMs: result.latencyMs, ip: result.ip, errorCode: result.errorCode }) }); } catch { /* best effort */ }
    return result;
  }

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

  private notifyChanged(): void {
    try { this.onChanged(); } catch { /* renderer shutdown must not undo committed state */ }
  }
}

function publicAccount(account: FacebookAccount): FacebookAccount {
  return { ...account, proxyPasswordKey: undefined, proxyPasswordSaved: Boolean(account.proxyPasswordKey) };
}
