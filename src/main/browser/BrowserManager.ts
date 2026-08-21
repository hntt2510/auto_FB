import type { BrowserContext, Page } from 'playwright';
import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import { AppError, sanitizeMessage } from '@main/errors';
import { AccountLockManager } from './AccountLockManager';
import { ProfileManager } from './ProfileManager';
import { SecretStore, SecretStoreError } from '@main/security/SecretStore';
import { SessionHealthService } from './SessionHealthService';
import type { AccountStatus, FacebookAccount, HealthCheckResult } from '@shared/types';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';

type RuntimeEntry = { context: BrowserContext; temporary: boolean; closing: boolean; finalized: boolean; startupFailure: boolean };

export class BrowserManager {
  private readonly contexts = new Map<string, RuntimeEntry>();
  private readonly locks = new AccountLockManager();
  private readonly health = new SessionHealthService();

  constructor(
    private readonly accounts: AccountRepository,
    private readonly profiles: ProfileManager,
    private readonly secrets: SecretStore,
    private readonly audit: AuditLogRepository,
    private readonly notify: () => void
  ) {}

  isRunning(accountId: string): boolean { return this.contexts.has(accountId); }
  getRuntimeState(accountId: string): AccountStatus { return this.contexts.get(accountId) ? 'RUNNING' : (this.accounts.get(accountId)?.status ?? 'STOPPED'); }

  async openAccount(accountId: string): Promise<FacebookAccount> {
    const account = this.requireAccount(accountId);
    if (this.contexts.has(accountId) || this.locks.isLocked(accountId)) throw new AppError('ACCOUNT_ALREADY_RUNNING', 'Account already running.');
    return this.launch(account, false);
  }

  async closeAccount(accountId: string): Promise<FacebookAccount> {
    const entry = this.contexts.get(accountId);
    if (!entry) {
      this.locks.release(accountId);
      const account = this.requireAccount(accountId);
      if (account.status === 'STARTING' || account.status === 'RUNNING') this.accounts.setStatus(accountId, 'STOPPED');
      this.notify();
      return this.requireAccount(accountId);
    }
    entry.closing = true;
    try { await entry.context.close(); }
    finally { await this.finalizeClose(accountId, entry, true); }
    return this.requireAccount(accountId);
  }

  async healthCheck(accountId: string): Promise<HealthCheckResult> {
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
        this.audit.add({ accountId, eventType: 'SESSION_HEALTH', message: `${result.status}: ${result.reason}` });
        return result;
      }
      let classification;
      try {
        classification = await this.health.classify(page);
      } catch (error) {
        const reason = sanitizeMessage(error instanceof Error ? error.message : 'Facebook page inspection failed.');
        result = { accountId, status: 'ERROR', checkedAt: new Date().toISOString(), reason: `Facebook page inspection failed: ${reason}` };
        this.accounts.setHealth(accountId, result.status, result.checkedAt, result.reason);
        this.audit.add({ accountId, eventType: 'SESSION_HEALTH', message: `${result.status}: ${result.reason}` });
        return result;
      }
      result = { accountId, status: classification.status, checkedAt: new Date().toISOString(), reason: classification.reason };
      this.accounts.setHealth(accountId, result.status, result.checkedAt, result.reason);
      this.audit.add({ accountId, eventType: 'SESSION_HEALTH', message: result.reason ? `${result.status}: ${result.reason}` : result.status });
      return result;
    } finally {
      this.notify();
      if (temporary && this.contexts.has(accountId)) await this.closeAccount(accountId);
    }
  }

  async closeAll(): Promise<void> {
    const ids = [...this.contexts.keys()];
    await Promise.allSettled(ids.map((id) => this.closeAccount(id)));
    this.locks.clear();
  }

  private async launch(account: FacebookAccount, temporary: boolean): Promise<FacebookAccount> {
    if (!this.locks.acquire(account.id)) throw new AppError('ACCOUNT_ALREADY_RUNNING', 'Account already running.');
    this.accounts.setStatus(account.id, 'STARTING');
    this.notify();
    let entry: RuntimeEntry | undefined;
    try {
      this.profiles.assertControlledDirectory(account.profileDirectory);
      const chromium = await this.getChromium();
      const options: Parameters<typeof import('playwright').chromium.launchPersistentContext>[1] = { headless: false, viewport: null };
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
      const context = await chromium.launchPersistentContext(account.profileDirectory, options);
      entry = { context, temporary, closing: false, finalized: false, startupFailure: false };
      this.contexts.set(account.id, entry);
      context.on('close', () => { void this.finalizeClose(account.id, entry!, !entry!.startupFailure); });
      const page = await this.getPage(context);
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      this.accounts.setOpened(account.id, new Date().toISOString());
      this.audit.add({ accountId: account.id, eventType: 'BROWSER_STARTED', message: temporary ? 'Persistent browser started for health check.' : 'Persistent browser started.' });
      this.notify();
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
      this.accounts.setStatus(account.id, 'ERROR', appError.message);
      this.audit.add({ accountId: account.id, eventType: 'BROWSER_ERROR', message: appError.message });
      this.notify();
      throw appError;
    }
  }

  private async finalizeClose(accountId: string, entry: RuntimeEntry, writeAudit: boolean): Promise<void> {
    if (entry.finalized) return;
    entry.finalized = true;
    if (this.contexts.get(accountId) === entry) this.contexts.delete(accountId);
    this.locks.release(accountId);
    const account = this.accounts.get(accountId);
    if (account && !entry.startupFailure) {
      this.accounts.setStatus(accountId, 'STOPPED');
      if (writeAudit) this.audit.add({ accountId, eventType: 'BROWSER_CLOSED', message: 'Persistent browser closed.' });
    }
    this.notify();
  }

  private async getPage(context: BrowserContext): Promise<Page> {
    const pages = context.pages();
    return pages[0] ?? context.newPage();
  }

  private async getChromium(): Promise<typeof import('playwright').chromium> {
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';
    return (await import('playwright')).chromium;
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
