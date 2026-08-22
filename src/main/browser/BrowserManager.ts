import type { BrowserContext, Page } from 'playwright';
import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import { AppError, sanitizeMessage } from '@main/errors';
import { AccountLockManager } from './AccountLockManager';
import { ProfileManager } from './ProfileManager';
import { SecretStore, SecretStoreError } from '@main/security/SecretStore';
import { SessionHealthService } from './SessionHealthService';
import type { AccountStatus, FacebookAccount, HealthCheckResult } from '@shared/types';
import { normalizeFacebookGroupUrl } from '@shared/groupUrl';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';

type RuntimeEntry = { context: BrowserContext; temporary: boolean; closing: boolean; finalized: boolean; startupFailure: boolean };
type LaunchOptions = Parameters<typeof import('playwright').chromium.launchPersistentContext>[1];
export type PersistentContextLauncher = (profileDirectory: string, options: LaunchOptions) => Promise<BrowserContext>;

export class BrowserManager {
  private readonly contexts = new Map<string, RuntimeEntry>();
  private readonly locks = new AccountLockManager();
  private readonly health = new SessionHealthService();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly launchPersistentContext: PersistentContextLauncher;
  private shuttingDown = false;

  constructor(
    private readonly accounts: AccountRepository,
    private readonly profiles: ProfileManager,
    private readonly secrets: SecretStore,
    private readonly audit: AuditLogRepository,
    private readonly notify: () => void,
    launcher?: PersistentContextLauncher
  ) {
    this.launchPersistentContext = launcher ?? ((profileDirectory, options) => this.launchWithPlaywright(profileDirectory, options));
  }

  isRunning(accountId: string): boolean { return this.contexts.has(accountId) || this.locks.isLocked(accountId); }
  getRuntimeState(accountId: string): AccountStatus { return this.contexts.get(accountId) ? 'RUNNING' : (this.accounts.get(accountId)?.status ?? 'STOPPED'); }

  async openAccount(accountId: string): Promise<FacebookAccount> {
    return this.enqueue(accountId, () => this.openAccountInternal(accountId));
  }

  async closeAccount(accountId: string): Promise<FacebookAccount> {
    return this.enqueue(accountId, () => this.closeAccountInternal(accountId));
  }

  private async openAccountInternal(accountId: string): Promise<FacebookAccount> {
    if (this.shuttingDown) throw new AppError('BROWSER_LAUNCH_FAILED', 'Browser manager is shutting down.');
    const account = this.requireAccount(accountId);
    if (this.contexts.has(accountId) || this.locks.isLocked(accountId)) throw new AppError('ACCOUNT_ALREADY_RUNNING', 'Account already running.');
    return this.launch(account, false);
  }

  private async closeAccountInternal(accountId: string): Promise<FacebookAccount> {
    const entry = this.contexts.get(accountId);
    if (!entry) {
      const account = this.requireAccount(accountId);
      if (account.status === 'STARTING' || account.status === 'RUNNING') this.accounts.setStatus(accountId, 'STOPPED');
      this.notifySafely();
      return this.requireAccount(accountId);
    }
    entry.closing = true;
    try { await entry.context.close(); }
    finally { await this.finalizeClose(accountId, entry, true); }
    return this.requireAccount(accountId);
  }

  async healthCheck(accountId: string): Promise<HealthCheckResult> {
    if (this.shuttingDown) throw new AppError('BROWSER_LAUNCH_FAILED', 'Browser manager is shutting down.');
    return this.enqueue(accountId, () => this.healthCheckInternal(accountId));
  }

  async navigateAccountPage(accountId: string, url: string): Promise<{ accountId: string; status: 'OPENED' | 'LOGIN_REQUIRED' | 'CHECKPOINT' | 'ERROR'; reason?: string }> {
    return this.enqueue(accountId, () => this.navigateAccountPageInternal(accountId, url));
  }

  async withAccountPage<T>(accountId: string, operation: (page: Page) => Promise<T>): Promise<T> {
    return this.enqueue(accountId, async () => {
      if (this.shuttingDown) throw new AppError('BROWSER_LAUNCH_FAILED', 'Browser manager is shutting down.');
      let entry = this.contexts.get(accountId);
      if (!entry) { await this.launch(this.requireAccount(accountId), false); entry = this.contexts.get(accountId); }
      if (!entry) throw new AppError('BROWSER_LAUNCH_FAILED', 'Unable to open the account browser.');
      const page = await entry.context.newPage();
      try { return await operation(page); }
      finally { if (!page.isClosed()) await page.close().catch(() => undefined); }
    });
  }

  private async navigateAccountPageInternal(accountId: string, url: string): Promise<{ accountId: string; status: 'OPENED' | 'LOGIN_REQUIRED' | 'CHECKPOINT' | 'ERROR'; reason?: string }> {
    if (this.shuttingDown) throw new AppError('BROWSER_LAUNCH_FAILED', 'Browser manager is shutting down.');
    const normalized = normalizeFacebookGroupUrl(url).normalizedUrl;
    let entry = this.contexts.get(accountId);
    if (!entry) { await this.launch(this.requireAccount(accountId), false); entry = this.contexts.get(accountId); }
    if (!entry) throw new AppError('BROWSER_LAUNCH_FAILED', 'Unable to open the account browser.');
    const page = await entry.context.newPage();
    try {
      await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const classification = await this.health.classify(page);
      if (classification.status === 'LOGIN_REQUIRED' || classification.status === 'CHECKPOINT') {
        const checkedAt = new Date().toISOString(); this.accounts.setHealth(accountId, classification.status, checkedAt, classification.reason);
        return { accountId, status: classification.status, reason: classification.reason };
      }
      if (classification.status === 'ERROR') { const checkedAt = new Date().toISOString(); this.accounts.setHealth(accountId, 'ERROR', checkedAt, classification.reason); return { accountId, status: 'ERROR', reason: classification.reason }; }
      return { accountId, status: 'OPENED' };
    } catch (error) {
      const reason = sanitizeMessage(error instanceof Error ? error.message : 'Facebook group could not be reached.');
      this.accounts.setHealth(accountId, 'ERROR', new Date().toISOString(), reason);
      return { accountId, status: 'ERROR', reason };
    }
  }

  private async healthCheckInternal(accountId: string): Promise<HealthCheckResult> {
    if (this.shuttingDown) throw new AppError('BROWSER_LAUNCH_FAILED', 'Browser manager is shutting down.');
    const account = this.requireAccount(accountId);
    let entry = this.contexts.get(accountId);
    let temporary = false;
    if (!entry) {
      await this.launch(account, true);
      entry = this.contexts.get(accountId);
      temporary = true;
    }
    if (!entry) throw new AppError('BROWSER_LAUNCH_FAILED', 'Unable to start the profile for a health check.');
    let result: HealthCheckResult;
    try {
      const page = await this.getPage(entry.context);
      try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (error) {
        const reason = sanitizeMessage(error instanceof Error ? error.message : 'Facebook could not be reached.');
        result = { accountId, status: 'ERROR', checkedAt: new Date().toISOString(), reason: `Facebook could not be reached: ${reason}` };
        this.accounts.setHealth(accountId, result.status, result.checkedAt, result.reason);
        this.auditSafely({ accountId, eventType: 'SESSION_HEALTH', message: `${result.status}: ${result.reason}` });
        return result;
      }
      let classification;
      try {
        classification = await this.health.classify(page);
      } catch (error) {
        const reason = sanitizeMessage(error instanceof Error ? error.message : 'Facebook page inspection failed.');
        result = { accountId, status: 'ERROR', checkedAt: new Date().toISOString(), reason: `Facebook page inspection failed: ${reason}` };
        this.accounts.setHealth(accountId, result.status, result.checkedAt, result.reason);
        this.auditSafely({ accountId, eventType: 'SESSION_HEALTH', message: `${result.status}: ${result.reason}` });
        return result;
      }
      result = { accountId, status: classification.status, checkedAt: new Date().toISOString(), reason: classification.reason };
      this.accounts.setHealth(accountId, result.status, result.checkedAt, result.reason);
      this.auditSafely({ accountId, eventType: 'SESSION_HEALTH', message: result.reason ? `${result.status}: ${result.reason}` : result.status });
      return result;
    } finally {
      this.notifySafely();
      if (temporary && this.contexts.has(accountId)) await this.closeAccountInternal(accountId);
    }
  }

  async closeAll(): Promise<void> {
    this.shuttingDown = true;
    const ids = new Set([...this.operations.keys(), ...this.contexts.keys()]);
    await Promise.allSettled([...ids].map((id) => this.enqueue(id, () => this.closeAccountInternal(id))));
    // Any lock left here is an invariant violation, but clearing it is safe
    // only after every queued lifecycle operation has settled.
    this.locks.clear();
  }

  async abortRunningContexts(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled([...this.contexts.values()].map((entry) => { entry.closing = true; return entry.context.close(); }));
  }

  private async launch(account: FacebookAccount, temporary: boolean): Promise<FacebookAccount> {
    if (!this.locks.acquire(account.id)) throw new AppError('ACCOUNT_ALREADY_RUNNING', 'Account already running.');
    this.accounts.setStatus(account.id, 'STARTING');
    this.notifySafely();
    let entry: RuntimeEntry | undefined;
    try {
      this.profiles.assertControlledDirectory(account.profileDirectory);
      const options: LaunchOptions = { headless: false, viewport: null };
      if (account.proxyEnabled) {
        if (!account.proxyHost || !account.proxyPort) throw new AppError('INVALID_REQUEST', 'Proxy host and port are required.');
        options.proxy = { server: `http://${account.proxyHost}:${account.proxyPort}` };
        if (account.proxyUsername) {
          options.proxy.username = account.proxyUsername;
          if (!account.proxyPasswordKey) throw new AppError('PROXY_AUTH_FAILED', 'Proxy credentials are incomplete.');
          try { options.proxy.password = this.secrets.get(account.proxyPasswordKey); }
          catch (error) {
            if (error instanceof SecretStoreError) throw new AppError(error.code, error.message);
            throw error;
          }
        }
      }
      const context = await this.launchPersistentContext(account.profileDirectory, options);
      entry = { context, temporary, closing: false, finalized: false, startupFailure: false };
      this.contexts.set(account.id, entry);
      context.on('close', () => { void this.finalizeClose(account.id, entry!, !entry!.startupFailure); });
      const page = await this.getPage(context);
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      this.accounts.setOpened(account.id, new Date().toISOString());
      this.auditSafely({ accountId: account.id, eventType: 'BROWSER_STARTED', message: temporary ? 'Persistent browser started for health check.' : 'Persistent browser started.' });
      this.notifySafely();
      return this.requireAccount(account.id);
    } catch (error) {
      if (entry) {
        entry.startupFailure = true;
        entry.closing = true;
        await entry.context.close().catch(() => undefined);
        await this.finalizeClose(account.id, entry, false);
      } else {
        this.locks.release(account.id);
      }
      const appError = error instanceof AppError ? error : new AppError(this.isProxyError(error) ? 'PROXY_AUTH_FAILED' : 'BROWSER_LAUNCH_FAILED', this.isProxyError(error) ? 'Proxy connection or authentication failed.' : `Unable to launch ${account.name}.`);
      try { this.accounts.setStatus(account.id, 'ERROR', appError.message); } catch { /* preserve process if persistence is unavailable */ }
      this.auditSafely({ accountId: account.id, eventType: 'BROWSER_ERROR', message: appError.message });
      this.notifySafely();
      throw appError;
    }
  }

  private async finalizeClose(accountId: string, entry: RuntimeEntry, writeAudit: boolean): Promise<void> {
    if (entry.finalized) return;
    entry.finalized = true;
    if (this.contexts.get(accountId) === entry) this.contexts.delete(accountId);
    this.locks.release(accountId);
    try {
      let account: FacebookAccount | undefined;
      try { account = this.accounts.get(accountId); } catch { account = undefined; }
      if (account && !entry.startupFailure) {
        try { this.accounts.setStatus(accountId, 'STOPPED'); } catch { /* best-effort status persistence during shutdown */ }
        if (writeAudit) this.auditSafely({ accountId, eventType: 'BROWSER_CLOSED', message: 'Persistent browser closed.' });
      }
    } finally {
      this.notifySafely();
    }
  }

  private async getPage(context: BrowserContext): Promise<Page> {
    const pages = context.pages();
    return pages[0] ?? context.newPage();
  }

  private async launchWithPlaywright(profileDirectory: string, options: LaunchOptions): Promise<BrowserContext> {
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';
    return (await import('playwright')).chromium.launchPersistentContext(profileDirectory, options);
  }

  private enqueue<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(accountId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.operations.set(accountId, tail);
    tail.then(() => { if (this.operations.get(accountId) === tail) this.operations.delete(accountId); });
    return current;
  }

  private auditSafely(entry: { accountId?: string; eventType: string; message: string }): void {
    try { this.audit.add(entry); } catch { /* audit failure must not break browser lifecycle */ }
  }

  private notifySafely(): void {
    try { this.notify(); } catch { /* renderer shutdown must not reject lifecycle promises */ }
  }

  private requireAccount(accountId: string): FacebookAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.');
    return account;
  }

  private isProxyError(error: unknown): boolean {
    return /proxy|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|407/i.test(error instanceof Error ? error.message : String(error));
  }
}
