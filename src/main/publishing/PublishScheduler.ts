import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import type { PublishCoordinator } from './PublishCoordinator';
import type { PublishingSettingsService } from './PublishingSettingsService';
import type { PublishingRunResult } from '@shared/types';

export class PublishScheduler {
  private timer?: NodeJS.Timeout;
  private started = false;
  private armed: boolean;
  private ticking = false;

  constructor(private readonly queue: QueueRepository, private readonly coordinator: PublishCoordinator, private readonly settings: PublishingSettingsService, private readonly onChanged: () => void, startArmed?: boolean) { this.armed = startArmed ?? this.settings.get().canaryMode !== true; }

  start(): void { if (this.started) return; this.started = true; if (this.armed) this.schedule(); this.onChangedSafe(); }
  stop(): void { this.started = false; this.armed = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.onChangedSafe(); }
  reconfigure(): void { if (!this.started) return; if (this.timer) clearTimeout(this.timer); this.schedule(); this.onChangedSafe(); }
  isRunning(): boolean { return this.started; }
  isArmed(): boolean { return this.armed; }
  isTicking(): boolean { return this.ticking; }
  arm(acknowledgeOverdue = false): void {
    const settings = this.settings.get();
    const overdue = typeof this.queue.dueCount === 'function' ? this.queue.dueCount(new Date().toISOString()) : this.queue.due(new Date().toISOString()).length;
    if (settings.executionMode === 'LIVE' && settings.canaryMode === true) throw new Error('Canary mode disables the scheduler. Run one item explicitly.');
    if (overdue > 0 && !acknowledgeOverdue) throw new Error('Overdue backlog requires acknowledgement (' + overdue + ').');
    this.armed = true; if (this.started) this.schedule(); this.onChangedSafe();
  }
  disarm(): void { this.armed = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.onChangedSafe(); }

  async runDue(): Promise<PublishingRunResult> { const due = this.queue.due(new Date().toISOString()).map((item) => item.id); const settings = this.settings.get(); if (!this.armed || settings.canaryMode === true || settings.executionMode !== 'LIVE') return { requested: due.length, claimed: 0, completed: 0, skipped: due.length }; return this.coordinator.run(due, settings); }

  private schedule(): void {
    if (!this.started || !this.armed) return; this.timer = setTimeout(() => { void this.tick(); }, this.settings.get().schedulerIntervalSeconds * 1000);
  }

  private async tick(): Promise<void> {
    if (!this.started || !this.armed) return; if (this.ticking) { this.schedule(); return; }
    this.ticking = true; this.onChangedSafe();
    try { const settings = this.settings.get(); if (this.armed && settings.canaryMode !== true && settings.enabled && settings.executionMode === 'LIVE') { const due = this.queue.due(new Date().toISOString()).map((item) => item.id); if (due.length) await this.coordinator.run(due, settings); } }
    finally { this.ticking = false; this.onChangedSafe(); this.schedule(); }
  }

  private onChangedSafe(): void { try { this.onChanged(); } catch { /* renderer may be closing */ } }
}
