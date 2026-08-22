import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import type { PublishCoordinator } from './PublishCoordinator';
import type { PublishingSettingsService } from './PublishingSettingsService';
import type { PublishingRunResult } from '@shared/types';

export class PublishScheduler {
  private timer?: NodeJS.Timeout;
  private started = false;
  private ticking = false;

  constructor(private readonly queue: QueueRepository, private readonly coordinator: PublishCoordinator, private readonly settings: PublishingSettingsService, private readonly onChanged: () => void) {}

  start(): void { if (this.started) return; this.started = true; this.schedule(); this.onChangedSafe(); }
  stop(): void { this.started = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.onChangedSafe(); }
  reconfigure(): void { if (!this.started) return; if (this.timer) clearTimeout(this.timer); this.schedule(); this.onChangedSafe(); }
  isRunning(): boolean { return this.started; }
  isTicking(): boolean { return this.ticking; }

  async runDue(): Promise<PublishingRunResult> { const due = this.queue.due(new Date().toISOString()).map((item) => item.id); return this.coordinator.run(due, this.settings.get()); }

  private schedule(): void {
    if (!this.started) return; this.timer = setTimeout(() => { void this.tick(); }, this.settings.get().schedulerIntervalSeconds * 1000);
  }

  private async tick(): Promise<void> {
    if (!this.started) return; if (this.ticking) { this.schedule(); return; }
    this.ticking = true; this.onChangedSafe();
    try { const settings = this.settings.get(); if (settings.enabled) { const due = this.queue.due(new Date().toISOString()).map((item) => item.id); if (due.length) await this.coordinator.run(due, settings); } }
    finally { this.ticking = false; this.onChangedSafe(); this.schedule(); }
  }

  private onChangedSafe(): void { try { this.onChanged(); } catch { /* renderer may be closing */ } }
}
