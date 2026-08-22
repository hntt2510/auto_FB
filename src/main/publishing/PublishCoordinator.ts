import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import type { PublishingRunResult, PublishingSettings } from '@shared/types';
import type { PublishExecutor } from './PublishExecutor';

export class PublishCoordinator {
  private accepting = true;
  private readonly accountTails = new Map<string, Promise<void>>();
  private readonly active = new Set<Promise<void>>();
  private readonly runningIds = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private activeSlots = 0;
  private readonly slotWaiters: Array<() => void> = [];

  constructor(private readonly queue: QueueRepository, private readonly executor: PublishExecutor) {}

  async run(queueIds: string[], settings: PublishingSettings): Promise<PublishingRunResult> {
    const unique = [...new Set(queueIds)]; const result: PublishingRunResult = { requested: unique.length, claimed: 0, completed: 0, skipped: 0 };
    if (!this.accepting) return { ...result, skipped: unique.length };
    const tasks = unique.map((id) => {
      const item = this.queue.get(id); if (!item?.accountId) { result.skipped++; return Promise.resolve(); }
      return this.enqueueAccount(item.accountId, async () => {
        await this.acquireSlot(settings.maxConcurrentAccounts);
        if (!this.accepting) { this.releaseSlot(); result.skipped++; return; }
        const controller = new AbortController(); this.controllers.set(id, controller); this.runningIds.add(id);
        try { const outcome = await this.executor.execute(id, settings, controller.signal); if (outcome === 'COMPLETED') { result.claimed++; result.completed++; } else result.skipped++; }
        finally { this.controllers.delete(id); this.runningIds.delete(id); this.releaseSlot(); }
      });
    });
    await Promise.all(tasks); return result;
  }

  running(): string[] { return [...this.runningIds]; }
  resumeAccepting(): void { this.accepting = true; }

  async stopAndDrain(timeoutMs: number): Promise<boolean> {
    this.accepting = false; for (const controller of this.controllers.values()) controller.abort();
    const drained = Promise.allSettled([...this.active]).then(() => true);
    return Promise.race([drained, new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
  }

  private enqueueAccount(accountId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.accountTails.get(accountId) ?? Promise.resolve(); const current = previous.catch(() => undefined).then(operation); const tail = current.then(() => undefined, () => undefined);
    this.accountTails.set(accountId, tail); this.active.add(tail); tail.finally(() => { this.active.delete(tail); if (this.accountTails.get(accountId) === tail) this.accountTails.delete(accountId); }); return current;
  }

  private async acquireSlot(max: number): Promise<void> {
    while (this.activeSlots >= max) await new Promise<void>((resolve) => this.slotWaiters.push(resolve)); this.activeSlots++;
  }
  private releaseSlot(): void { this.activeSlots--; this.slotWaiters.shift()?.(); }
}
