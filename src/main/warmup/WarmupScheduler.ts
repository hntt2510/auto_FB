import type { AccountRepository } from "@main/db/repositories/AccountRepository";
import type { WarmupRepository } from "@main/db/repositories/WarmupRepository";
import type { WarmupService } from "./WarmupService";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_CONCURRENT = 2;

export class WarmupScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly warmupRepo: WarmupRepository,
    private readonly accounts: AccountRepository,
    private readonly service: WarmupService,
    private readonly intervalMs = DEFAULT_INTERVAL_MS
  ) {}

  start(): void {
    if (this.timer) return;
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Force an immediate tick (e.g. after app launch). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const allAccounts = this.accounts.list?.() ?? [];
      // Only WARMING accounts that have a warmup record set to IDLE or DONE
      const candidates = allAccounts.filter((a) => a.onboardingStatus === "WARMING");
      let launched = 0;
      for (const account of candidates) {
        if (launched >= MAX_CONCURRENT) break;
        if (this.service.isRunning(account.id)) continue;
        const progress = this.warmupRepo.get(account.id);
        if (progress && !["IDLE", "DONE", "ERROR"].includes(progress.status)) continue;
        try {
          await this.service.start({ accountId: account.id });
          launched++;
        } catch { /* skip failed accounts */ }
      }
    } finally {
      this.running = false;
    }
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        this.scheduleNext();
      });
    }, this.intervalMs);
  }
}
