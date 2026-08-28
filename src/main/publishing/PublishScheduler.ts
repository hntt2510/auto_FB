import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import type { PublishCoordinator } from './PublishCoordinator';
import type { PublishingSettingsService } from './PublishingSettingsService';
import type { PublishingRunResult, SchedulerArmPreview, SchedulerRuntimeState, SchedulerStopReason } from '@shared/types';

export class PublishScheduler {
  private timer?: NodeJS.Timeout;
  private started = false;
  private state: SchedulerRuntimeState = 'DISARMED';
  private ticking = false;
  private sessionCompleted = 0;
  private stopReason?: SchedulerStopReason;

  constructor(private readonly queue: QueueRepository, private readonly coordinator: PublishCoordinator, private readonly settings: PublishingSettingsService, private readonly onChanged: () => void, private readonly accountReady: (accountId: string) => boolean = () => true) {}

  start(): void { if (this.started) return; this.started = true; this.state = 'DISARMED'; this.stopReason = undefined; this.onChangedSafe(); }
  stop(): void { this.started = false; this.transitionDisarmed('APPLICATION_SHUTDOWN'); }
  reconfigure(): void { if (!this.started) return; this.clearTimer(); const settings = this.settings.get(); if (this.state === 'ARMED' && (!settings.enabled || settings.executionMode !== 'LIVE' || settings.canaryMode !== false)) { this.transitionDisarmed('OPERATOR_DISARMED'); return; } if (this.state === 'ARMED' && this.sessionCompleted >= (settings.maxJobsPerSchedulerSession ?? 20)) { this.transitionDisarmed('SESSION_JOB_LIMIT_REACHED'); return; } if (this.state === 'ARMED') this.schedule(); this.onChangedSafe(); }
  isRunning(): boolean { return this.started; }
  isArmed(): boolean { return this.state === 'ARMED'; }
  isTicking(): boolean { return this.ticking; }
  runtimeState(): SchedulerRuntimeState { return this.state; }
  reason(): SchedulerStopReason | undefined { return this.stopReason; }
  completedThisSession(): number { return this.sessionCompleted; }

  preview(now = new Date().toISOString()): SchedulerArmPreview {
    const due = this.queue.dueSummary(now); const settings = this.settings.get();
    return { dueJobs: due.count, overdueJobs: due.count, oldestOverdueAt: due.oldest, accountsInvolved: due.accounts, groupsInvolved: due.groups, executionMode: settings.executionMode, canaryMode: settings.canaryMode !== false, sessionLimit: settings.maxJobsPerSchedulerSession ?? 20 };
  }

  arm(acknowledgeOverdue = false): void {
    if (this.state !== 'DISARMED') throw new Error('Scheduler must be disarmed before it can be armed.');
    const settings = this.settings.get(); const preview = this.preview();
    if (!settings.enabled) throw new Error('Publishing engine must be enabled before arming the scheduler.');
    if (settings.executionMode !== 'LIVE') throw new Error('Scheduler requires LIVE execution mode.');
    if (settings.canaryMode !== false) throw new Error('Canary mode disables the scheduler. Run one item explicitly.');
    if (preview.overdueJobs > 0 && !acknowledgeOverdue) throw new Error('Overdue backlog requires acknowledgement (' + preview.overdueJobs + ').');
    this.state = 'ARMED'; this.sessionCompleted = 0; this.stopReason = undefined; this.clearTimer(); if (this.started) this.schedule(); this.onChangedSafe();
  }

  disarm(reason: SchedulerStopReason = 'OPERATOR_DISARMED'): void { this.transitionDisarmed(reason); }
  beginStopping(): void { if (this.state !== 'ARMED') throw new Error('Only an armed scheduler can stop after current work.'); this.state = 'STOPPING'; this.clearTimer(); this.onChangedSafe(); }
  completeStopping(): void { if (this.state !== 'STOPPING') throw new Error('Scheduler is not stopping.'); this.transitionDisarmed('STOP_AFTER_CURRENT'); }
  failStopping(reason: Extract<SchedulerStopReason, 'STOP_DRAIN_TIMEOUT' | 'STOP_DRAIN_FAILED'>): void { if (this.state !== 'STOPPING') throw new Error('Scheduler is not stopping.'); this.transitionDisarmed(reason); }

  async runDue(): Promise<PublishingRunResult> {
    const settings = this.settings.get(); const limit = Math.max(0, (settings.maxJobsPerSchedulerSession ?? 20) - this.sessionCompleted); const allDue = this.queue.due(new Date().toISOString()); const eligible = settings.requireReadyAccounts ? allDue.filter((item) => Boolean(item.accountId && this.accountReady(item.accountId))) : allDue;
    if (this.state !== 'ARMED' || settings.canaryMode !== false || settings.executionMode !== 'LIVE' || !settings.enabled || limit === 0) return { requested: allDue.length, claimed: 0, completed: 0, skipped: allDue.length };
    if (this.coordinator.isBusy()) return { requested: allDue.length, claimed: 0, completed: 0, skipped: allDue.length };
    const selected = eligible.slice(0, limit).map((item) => item.id); const result = await this.coordinator.run(selected, settings, 'SCHEDULER'); this.recordCompleted(result.completed);
    return { ...result, requested: allDue.length, skipped: result.skipped + Math.max(0, allDue.length - selected.length) };
  }

  private schedule(): void { if (!this.started || this.state !== 'ARMED') return; this.timer = setTimeout(() => { void this.tick(); }, this.settings.get().schedulerIntervalSeconds * 1000); }
  private async tick(): Promise<void> { if (!this.started || this.state !== 'ARMED') return; if (this.ticking) { this.schedule(); return; } this.ticking = true; this.onChangedSafe(); try { if (this.state === 'ARMED') await this.runDue(); } finally { this.ticking = false; this.onChangedSafe(); if (this.state === 'ARMED') this.schedule(); } }
  private recordCompleted(count: number): void { this.sessionCompleted += count; const limit = this.settings.get().maxJobsPerSchedulerSession ?? 20; if (this.sessionCompleted >= limit) this.transitionDisarmed('SESSION_JOB_LIMIT_REACHED'); else this.onChangedSafe(); }
  private transitionDisarmed(reason: SchedulerStopReason): void { this.state = 'DISARMED'; this.stopReason = reason; this.clearTimer(); this.onChangedSafe(); }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private onChangedSafe(): void { try { this.onChanged(); } catch { /* renderer may be closing */ } }
}
