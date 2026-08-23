import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueRepository } from "@main/db/repositories/QueueRepository";
import type { PublishCoordinator } from "./PublishCoordinator";
import type { PublishingSettingsService } from "./PublishingSettingsService";
import { PublishScheduler } from "./PublishScheduler";
import type { PublishingSettings } from "@shared/types";

afterEach(() => vi.useRealTimers());

const live: PublishingSettings = {
  enabled: true,
  executionMode: "LIVE" as const,
  schedulerIntervalSeconds: 30,
  maxConcurrentAccounts: 2,
  videoUploadTimeoutSeconds: 600,
  maxJobsPerSchedulerSession: 20,
  canaryMode: false,
};
function harness(overdue = 0, overrides: Partial<typeof live> = {}) {
  const due = Array.from({ length: overdue }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }));
  const queue = {
    due: vi.fn(() => due),
    dueSummary: vi.fn(() => ({
      count: overdue,
      oldest: overdue ? "2026-01-01T00:00:00.000Z" : undefined,
      accounts: overdue ? 2 : 0,
      groups: overdue ? 3 : 0,
    })),
  };
  const coordinator = {
    run: vi.fn(async (ids: string[]) => ({
      requested: ids.length,
      claimed: ids.length,
      completed: ids.length,
      skipped: 0,
    })),
  };
  const current: PublishingSettings = { ...live, ...overrides };
  const settings = { get: () => current };
  const scheduler = new PublishScheduler(
    queue as unknown as QueueRepository,
    coordinator as unknown as PublishCoordinator,
    settings as PublishingSettingsService,
    vi.fn(),
  );
  return { scheduler, queue, coordinator, current };
}

describe("PublishScheduler operational state machine", () => {
  it("always starts DISARMED and claims no backlog before explicit arm", async () => {
    vi.useFakeTimers();
    const { scheduler, coordinator } = harness(20);
    scheduler.start();
    expect(scheduler.runtimeState()).toBe("DISARMED");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(coordinator.run).not.toHaveBeenCalled();
  });
  it("rejects invalid arm conditions and requires overdue acknowledgement", () => {
    expect(() =>
      harness(0, { executionMode: "DRY_RUN" }).scheduler.arm(),
    ).toThrow(/LIVE/);
    expect(() => harness(0, { canaryMode: true }).scheduler.arm()).toThrow(
      /Canary/,
    );
    expect(() => harness(0, { enabled: false }).scheduler.arm()).toThrow(
      /enabled/,
    );
    const { scheduler } = harness(2);
    expect(() => scheduler.arm()).toThrow(/acknowledgement/);
    scheduler.arm(true);
    expect(scheduler.runtimeState()).toBe("ARMED");
    expect(() => scheduler.arm(true)).toThrow(/disarmed/);
  });
  it("transitions ARMED to STOPPING to DISARMED", () => {
    const { scheduler } = harness();
    scheduler.arm();
    scheduler.beginStopping();
    expect(scheduler.runtimeState()).toBe("STOPPING");
    expect(() => scheduler.arm()).toThrow();
    scheduler.completeStopping();
    expect(scheduler.runtimeState()).toBe("DISARMED");
    expect(scheduler.reason()).toBe("STOP_AFTER_CURRENT");
  });
  it("disarms when persisted settings become unsafe", () => { const { scheduler, current } = harness(); scheduler.start(); scheduler.arm(); current.canaryMode = true; scheduler.reconfigure(); expect(scheduler.runtimeState()).toBe("DISARMED"); expect(scheduler.reason()).toBe("OPERATOR_DISARMED"); });
  it("does not overlap scheduler ticks while execution is pending", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { scheduler, coordinator } = harness();
    coordinator.run.mockImplementation(async () => {
      await gate;
      return { requested: 1, claimed: 1, completed: 1, skipped: 0 };
    });
    scheduler.start();
    scheduler.arm();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(coordinator.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(coordinator.run).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    scheduler.stop();
  });
  it("caps a scheduler session and leaves excess jobs pending", async () => {
    const { scheduler, coordinator } = harness(4, {
      maxJobsPerSchedulerSession: 3,
    });
    scheduler.start();
    scheduler.arm(true);
    const result = await scheduler.runDue();
    expect(coordinator.run).toHaveBeenCalledWith(
      expect.arrayContaining([expect.any(String)]),
      expect.any(Object),
    );
    expect(coordinator.run.mock.calls[0][0]).toHaveLength(3);
    expect(result).toEqual({
      requested: 4,
      claimed: 3,
      completed: 3,
      skipped: 1,
    });
    expect(scheduler.runtimeState()).toBe("DISARMED");
    expect(scheduler.reason()).toBe("SESSION_JOB_LIMIT_REACHED");
    expect(scheduler.completedThisSession()).toBe(3);
  });
});
