import { chromium } from "playwright";
import { existsSync } from "node:fs";
import type { AccountRepository } from "@main/db/repositories/AccountRepository";
import type { WarmupRepository } from "@main/db/repositories/WarmupRepository";
import type { ProfileManager } from "@main/browser/ProfileManager";
import { AppError } from "@main/errors";
import { WarmupEngine } from "./WarmupEngine";
import { buildPlaywrightProxy } from "@main/proxy/ProxyConfiguration";
import type { SecretStore } from "@main/security/SecretStore";
import type { WarmupConfig, WarmupExecutionLog, WarmupListLogsInput, WarmupProgress, WarmupStartInput } from "@shared/types";
import { DEFAULT_WARMUP_CONFIG } from "@shared/types";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";

export class WarmupService {
  /** accountId -> abort flag */
  private readonly running = new Map<string, { abort: boolean }>();

  constructor(
    private readonly warmup: WarmupRepository,
    private readonly accounts: AccountRepository,
    private readonly profiles: ProfileManager,
    private readonly secrets: SecretStore,
    private readonly notify: () => void
  ) {}

  getProgress(accountId: string): WarmupProgress | null {
    return this.warmup.get(accountId) ?? null;
  }

  listAll(): WarmupProgress[] {
    return this.warmup.listAll();
  }

  updateConfig(accountId: string, config: Partial<WarmupConfig>): WarmupProgress {
    this.requireAccount(accountId);
    return this.warmup.updateConfig(accountId, config);
  }

  getLogs(input: WarmupListLogsInput): WarmupExecutionLog[] {
    return this.warmup.getLogs(input.accountId, input.runId, input.limit);
  }

  async start(input: WarmupStartInput): Promise<WarmupProgress> {
    const account = this.requireAccount(input.accountId);
    if (this.running.has(account.id)) throw new AppError("ACCOUNT_ALREADY_RUNNING", "A warmup session is already running for this account.");

    const config: WarmupConfig = { ...DEFAULT_WARMUP_CONFIG, ...(this.warmup.get(account.id)?.config ?? {}), ...(input.config ?? {}) };
    // Ensure record exists
    this.warmup.upsert(account.id, config);

    const signal = { abort: false };
    this.running.set(account.id, signal);
    const progress = this.warmup.setStatus(account.id, "RUNNING");
    this.notify();

    // Resolve group URLs for workspace tabs
    const groupUrls: string[] = [];
    const configWithGroups: WarmupConfig & { groupUrls?: string[] } = { ...config, groupUrls };

    // Run in background
    const engine = new WarmupEngine(
      account.id,
      configWithGroups,
      this.warmup,
      {
        onLog: (entry) => {
          this.warmup.addLog(entry);
          this.notify();
        },
        onAborted: () => signal.abort,
      },
      async () => {
        this.profiles.assertControlledDirectory(account.profileDirectory);
        const options: Parameters<typeof chromium.launchPersistentContext>[1] = {
          headless: config.headless,
          viewport: null,
        };
        if (account.proxyEnabled) {
          options.proxy = buildPlaywrightProxy(account, this.secrets);
        }
        const bundledPath = chromium.executablePath();
        const unpackedPath = bundledPath.replace("app.asar", "app.asar.unpacked");
        if (unpackedPath !== bundledPath && existsSync(unpackedPath)) options.executablePath = unpackedPath;
        return chromium.launchPersistentContext(account.profileDirectory, options);
      }
    );

    void engine.run().then(() => {
      this.running.delete(account.id);
      const finalStatus = signal.abort ? "IDLE" : "DONE";
      try { this.warmup.setStatus(account.id, finalStatus); } catch { /* best-effort */ }
      this.notify();
    }).catch((error) => {
      this.running.delete(account.id);
      const msg = error instanceof Error ? error.message : String(error);
      try { this.warmup.setStatus(account.id, "ERROR", msg); } catch { /* best-effort */ }
      this.notify();
    });

    return progress;
  }

  stop(accountId: string): WarmupProgress {
    const signal = this.running.get(accountId);
    if (signal) signal.abort = true;
    const progress = this.warmup.get(accountId);
    if (!progress) throw new AppError("ACCOUNT_NOT_FOUND", "No warmup record found.");
    if (!signal) return this.warmup.setStatus(accountId, "IDLE");
    return progress;
  }

  pause(accountId: string): WarmupProgress {
    const progress = this.warmup.get(accountId);
    if (!progress) throw new AppError("ACCOUNT_NOT_FOUND", "No warmup record found.");
    if (progress.status !== "RUNNING") throw new AppError("INVALID_STATE", "Only a running warmup session can be paused.");
    const signal = this.running.get(accountId);
    if (signal) signal.abort = true; // pausing stops the current run; resume will restart
    return this.warmup.setStatus(accountId, "PAUSED");
  }

  async resume(accountId: string): Promise<WarmupProgress> {
    const progress = this.warmup.get(accountId);
    if (!progress) throw new AppError("ACCOUNT_NOT_FOUND", "No warmup record found.");
    if (progress.status !== "PAUSED") throw new AppError("INVALID_STATE", "Only a paused warmup session can be resumed.");
    return this.start({ accountId, config: progress.config });
  }

  isRunning(accountId: string): boolean {
    return this.running.has(accountId);
  }

  private requireAccount(accountId: string) {
    const account = this.accounts.get(accountId);
    if (!account) throw new AppError("ACCOUNT_NOT_FOUND", "Account not found.");
    return account;
  }
}
