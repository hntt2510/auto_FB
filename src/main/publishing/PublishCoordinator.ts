import { randomUUID } from 'node:crypto';
import type { QueueRepository, QueueRecord } from '@main/db/repositories/QueueRepository';
import type { PublishBatchLane, PublishBatchRuntime, PublishBatchSource, PublishingRunResult, PublishingSettings } from '@shared/types';
import type { ExecutionOutcome, PublishExecutor } from './PublishExecutor';

export function canContinueAccountLane(outcome: ExecutionOutcome): boolean {
  if (!outcome.started) return false;
  return outcome.finalStatus === 'SUCCEEDED' || outcome.finalStatus === 'SUBMITTED';
}

export type PublishPacingRuntime = { now: () => number; wait: (milliseconds: number, signal: AbortSignal) => Promise<void> };
const productionRuntime: PublishPacingRuntime = {
  now: () => Date.now(),
  wait: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => { clearTimeout(timer); done(abortError()); };
    function done(error?: Error) { signal.removeEventListener('abort', onAbort); if (error) reject(error); else resolve(); }
    signal.addEventListener('abort', onAbort, { once: true });
  })
};

type Batch = { id: string; source: PublishBatchSource; settings: PublishingSettings; result: PublishingRunResult; startedAt: number; state: PublishBatchRuntime['state']; stopAfter: boolean; stopped: boolean; interrupted: boolean; reason?: string; endedAt?: number; lanes: Map<string, Lane>; workers: Set<Promise<void>> };
type Lane = { accountId: string; accountName: string; items: QueueRecord[]; index: number; processed: number; state: PublishBatchLane['state']; current?: QueueRecord; cooldownUntil?: number; blocked: boolean; cooldown?: AbortController };

export class PublishCoordinator {
  private readonly lastAttemptFinishedAt = new Map<string, number>();
  private readonly activeAttemptControllers = new Map<string, AbortController>();
  private readonly slotWaiters: Array<() => void> = [];
  private activeSlots = 0;
  private batch?: Batch;
  private lastBatch?: PublishBatchRuntime;

  constructor(private readonly queue: QueueRepository, private readonly executor: PublishExecutor, private readonly onChanged: () => void = () => undefined, private readonly runtime: PublishPacingRuntime = productionRuntime, private readonly onLifecycle: (event: 'PUBLISH_BATCH_STARTED' | 'PUBLISH_BATCH_COMPLETED' | 'PUBLISH_BATCH_STOPPED', batch: PublishBatchRuntime) => void = () => undefined) {}

  isBusy(): boolean { return Boolean(this.batch && ['RUNNING', 'COOLDOWN', 'STOPPING'].includes(this.batch.state)); }
  resumeAccepting(): void { /* Explicit starts are accepted whenever no batch is active. */ }
  running(): string[] { return [...this.activeAttemptControllers.keys()]; }
  status(): PublishBatchRuntime | undefined { return this.batch ? this.snapshot(this.batch) : this.lastBatch; }

  async run(queueIds: string[], settings: PublishingSettings, source: PublishBatchSource = 'MANUAL'): Promise<PublishingRunResult> {
    if (this.isBusy()) throw new Error('PUBLISHING_BUSY');
    const items = queueIds.map((id) => this.queue.get(id)).filter((item): item is QueueRecord => Boolean(item?.accountId));
    const result: PublishingRunResult = { requested: queueIds.length, claimed: 0, completed: 0, skipped: queueIds.length - items.length };
    const batch: Batch = { id: randomUUID(), source, settings, result, startedAt: this.runtime.now(), state: 'RUNNING', stopAfter: false, stopped: false, interrupted: false, lanes: new Map(), workers: new Set() };
    for (const item of items) {
      const lane = batch.lanes.get(item.accountId!) ?? { accountId: item.accountId!, accountName: item.accountName, items: [], index: 0, processed: 0, state: 'RUNNING', blocked: false };
      lane.items.push(item); batch.lanes.set(lane.accountId, lane);
    }
    this.batch = batch; this.lastBatch = undefined; this.lifecycle('PUBLISH_BATCH_STARTED', this.snapshot(batch)); this.changed();
    for (const lane of batch.lanes.values()) {
      const worker = this.runLane(batch, lane); batch.workers.add(worker); void worker.finally(() => batch.workers.delete(worker));
    }
    await Promise.allSettled([...batch.workers]);
    if (batch.stopped || batch.interrupted || batch.stopAfter) { batch.state = 'INTERRUPTED'; batch.reason ??= batch.stopAfter ? 'STOP_AFTER_CURRENT' : 'PUBLISHING_STOPPED'; }
    else batch.state = 'COMPLETED';
    batch.endedAt = this.runtime.now(); this.lastBatch = this.snapshot(batch); this.lifecycle(batch.state === 'COMPLETED' ? 'PUBLISH_BATCH_COMPLETED' : 'PUBLISH_BATCH_STOPPED', this.lastBatch); if (this.batch === batch) this.batch = undefined; this.changed();
    return { ...result };
  }

  blockAccount(accountId: string, reason = 'ACCOUNT_BLOCKED'): void {
    const batch = this.batch; const lane = batch?.lanes.get(accountId); if (!batch || !lane) return;
    lane.blocked = true; lane.state = 'BLOCKED'; lane.cooldown?.abort(); batch.interrupted = true; batch.reason ??= reason; this.changed();
  }

  async stopAndDrain(timeoutMs: number): Promise<boolean> {
    const batch = this.batch; if (!batch) return true;
    batch.stopped = true; batch.interrupted = true; batch.reason = 'PUBLISHING_STOPPED'; batch.state = 'INTERRUPTED';
    for (const lane of batch.lanes.values()) lane.cooldown?.abort();
    for (const controller of this.activeAttemptControllers.values()) controller.abort();
    this.wakeSlotWaiters(); this.changed(); return this.drain(batch, timeoutMs);
  }

  async stopAfterCurrent(timeoutMs: number): Promise<boolean> {
    const batch = this.batch; if (!batch) return true;
    batch.stopAfter = true; batch.interrupted = true; batch.reason = 'STOP_AFTER_CURRENT'; batch.state = 'STOPPING';
    for (const lane of batch.lanes.values()) lane.cooldown?.abort();
    this.wakeSlotWaiters(); this.changed(); return this.drain(batch, timeoutMs);
  }

  private async runLane(batch: Batch, lane: Lane): Promise<void> {
    while (lane.index < lane.items.length) {
      const item = lane.items[lane.index++];
      if (!this.canStart(batch, lane)) { this.skip(batch, lane, lane.items.length - lane.index + 1); return; }
      const previous = this.lastAttemptFinishedAt.get(lane.accountId);
      const remaining = previous === undefined ? 0 : Math.max(0, batch.settings.batchPacingSeconds * 1000 - (this.runtime.now() - previous));
      if (remaining) {
        lane.state = 'COOLDOWN'; lane.cooldownUntil = this.runtime.now() + remaining; lane.cooldown = new AbortController(); batch.state = 'COOLDOWN'; this.changed();
        try { await this.runtime.wait(remaining, lane.cooldown.signal); }
        catch { if (!this.canStart(batch, lane)) { this.skip(batch, lane, lane.items.length - lane.index + 1); return; } }
        finally { lane.cooldown = undefined; lane.cooldownUntil = undefined; }
      }
      if (!this.canStart(batch, lane)) { this.skip(batch, lane, lane.items.length - lane.index + 1); return; }
      const acquired = await this.acquireSlot(batch, lane);
      if (!acquired || !this.canStart(batch, lane)) { if (acquired) this.releaseSlot(); this.skip(batch, lane, lane.items.length - lane.index + 1); return; }
      const controller = new AbortController(); this.activeAttemptControllers.set(item.id, controller); lane.current = item; lane.state = 'RUNNING'; batch.state = 'RUNNING'; this.changed();
      try {
        const outcome = await this.executor.execute(item.id, batch.settings, controller.signal);
        if (!outcome.started) { this.skip(batch, lane, lane.items.length - lane.index + 1); return; }
        batch.result.claimed++; batch.result.completed++; lane.processed++; this.lastAttemptFinishedAt.set(lane.accountId, this.runtime.now());
        if (!canContinueAccountLane(outcome)) { lane.blocked = true; lane.state = 'BLOCKED'; batch.interrupted = true; batch.reason ??= `ACCOUNT_CHAIN_${outcome.finalStatus ?? 'STOPPED'}`; this.skip(batch, lane, lane.items.length - lane.index); return; }
      } catch {
        lane.blocked = true; lane.state = 'BLOCKED'; batch.interrupted = true; batch.reason ??= 'ACCOUNT_CHAIN_ERROR'; this.skip(batch, lane, lane.items.length - lane.index + 1); return;
      } finally { this.activeAttemptControllers.delete(item.id); lane.current = undefined; this.releaseSlot(); this.changed(); }
      if (lane.index >= lane.items.length) lane.state = 'COMPLETED';
    }
  }

  private canStart(batch: Batch, lane: Lane): boolean { return this.batch === batch && !batch.stopped && !batch.stopAfter && !lane.blocked; }
  private skip(batch: Batch, lane: Lane, count: number): void { if (!count) return; lane.processed += count; batch.result.skipped += count; if (lane.state !== 'BLOCKED') lane.state = batch.stopAfter || batch.stopped ? 'STOPPED' : 'BLOCKED'; this.changed(); }
  private async acquireSlot(batch: Batch, lane: Lane): Promise<boolean> { while (this.activeSlots >= batch.settings.maxConcurrentAccounts && this.canStart(batch, lane)) await new Promise<void>((resolve) => this.slotWaiters.push(resolve)); if (!this.canStart(batch, lane)) return false; this.activeSlots++; return true; }
  private releaseSlot(): void { if (this.activeSlots > 0) this.activeSlots--; this.slotWaiters.shift()?.(); }
  private wakeSlotWaiters(): void { while (this.slotWaiters.length) this.slotWaiters.shift()!(); }
  private async drain(batch: Batch, timeoutMs: number): Promise<boolean> { const drained = Promise.allSettled([...batch.workers]).then(() => true); return Promise.race([drained, new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))]); }
  private snapshot(batch: Batch): PublishBatchRuntime {
    const lanes: PublishBatchLane[] = [...batch.lanes.values()].map((lane) => ({ accountId: lane.accountId, accountName: lane.accountName, total: lane.items.length, processed: lane.processed, state: lane.state, currentQueueId: lane.current?.id, currentGroupName: lane.current?.groupName, nextQueueId: lane.items[lane.index]?.id, nextGroupName: lane.items[lane.index]?.groupName, cooldownUntil: lane.cooldownUntil ? new Date(lane.cooldownUntil).toISOString() : undefined, remainingSeconds: lane.cooldownUntil ? Math.max(0, Math.ceil((lane.cooldownUntil - this.runtime.now()) / 1000)) : undefined }));
    const currentLane = lanes.find((lane) => lane.state === 'RUNNING'); const cooldownLane = lanes.find((lane) => lane.state === 'COOLDOWN'); const lane = currentLane ?? cooldownLane;
    return { id: batch.id, source: batch.source, state: batch.state, requested: batch.result.requested, claimed: batch.result.claimed, completed: batch.result.completed, skipped: batch.result.skipped, processed: lanes.reduce((total, value) => total + value.processed, 0), startedAt: new Date(batch.startedAt).toISOString(), endedAt: batch.endedAt ? new Date(batch.endedAt).toISOString() : undefined, reason: batch.reason, current: currentLane?.currentQueueId ? { queueId: currentLane.currentQueueId, accountId: currentLane.accountId, accountName: currentLane.accountName, groupName: currentLane.currentGroupName } : undefined, next: lane?.nextQueueId ? { queueId: lane.nextQueueId, accountId: lane.accountId, accountName: lane.accountName, groupName: lane.nextGroupName } : undefined, lanes };
  }
  private changed(): void { try { this.onChanged(); } catch { /* renderer may be closing */ } }
  private lifecycle(event: 'PUBLISH_BATCH_STARTED' | 'PUBLISH_BATCH_COMPLETED' | 'PUBLISH_BATCH_STOPPED', batch: PublishBatchRuntime): void { try { this.onLifecycle(event, batch); } catch { /* audit must not alter execution */ } }
}

function abortError(): Error { const error = new Error('Pacing cancelled.'); error.name = 'AbortError'; return error; }
