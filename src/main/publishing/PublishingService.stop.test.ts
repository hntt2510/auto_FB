import { describe, expect, it, vi } from 'vitest';
import type { SchedulerRuntimeState, SchedulerStopReason } from '@shared/types';
import { PublishingService } from './PublishingService';

function harness(drain: () => Promise<boolean>) {
  let state: SchedulerRuntimeState = 'ARMED'; let reason: SchedulerStopReason | undefined;
  const scheduler = {
    beginStopping: vi.fn(() => { state = 'STOPPING'; }),
    completeStopping: vi.fn(() => { state = 'DISARMED'; reason = 'STOP_AFTER_CURRENT'; }),
    failStopping: vi.fn((value: SchedulerStopReason) => { state = 'DISARMED'; reason = value; }),
    runtimeState: vi.fn(() => state), reason: vi.fn(() => reason), isArmed: vi.fn(() => state === 'ARMED'), isRunning: vi.fn(() => true), completedThisSession: vi.fn(() => 0), preview: vi.fn(() => ({ dueJobs: 0, overdueJobs: 0, accountsInvolved: 0, groupsInvolved: 0, executionMode: 'LIVE', canaryMode: false, sessionLimit: 20 })), isTicking: vi.fn(() => false)
  };
  const coordinator = { stopAfterCurrent: vi.fn(drain), resumeAccepting: vi.fn(), running: vi.fn(() => []) };
  const queue = { dueCount: vi.fn(() => 0), get: vi.fn() }; const attempts = { blocks: vi.fn(() => []), recent: vi.fn(() => []), recentProbes: vi.fn(() => []) };
  const settings = { get: vi.fn(() => ({ enabled: true, executionMode: 'LIVE', schedulerIntervalSeconds: 30, maxConcurrentAccounts: 1, videoUploadTimeoutSeconds: 600, maxJobsPerSchedulerSession: 20, canaryMode: false })) };
  const audit = { add: vi.fn() };
  const service = new PublishingService(queue as never, attempts as never, {} as never, {} as never, {} as never, { selectorVersion: 'test' } as never, coordinator as never, scheduler as never, settings as never, {} as never, audit as never, vi.fn());
  return { service, scheduler, coordinator, audit };
}

describe('PublishingService stop-after-current recovery', () => {
  it('disarms deliberately and resumes coordinator acceptance after a successful drain', async () => {
    const value = harness(async () => true); const status = await value.service.stopAfterCurrent();
    expect(status.schedulerState).toBe('DISARMED'); expect(status.schedulerReason).toBe('STOP_AFTER_CURRENT');
    expect(value.coordinator.resumeAccepting).toHaveBeenCalledTimes(1); expect(value.audit.add).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'PUBLISH_SCHEDULER_STOP_AFTER_CURRENT' }));
  });

  it('leaves DISARMED with a timeout reason and resumes acceptance', async () => {
    const value = harness(async () => false);
    await expect(value.service.stopAfterCurrent()).rejects.toMatchObject({ code: 'PUBLISHING_STOPPED' });
    expect(value.scheduler.runtimeState()).toBe('DISARMED'); expect(value.scheduler.reason()).toBe('STOP_DRAIN_TIMEOUT'); expect(value.coordinator.resumeAccepting).toHaveBeenCalledTimes(1);
  });

  it('leaves DISARMED with a failure reason and resumes acceptance when drain throws', async () => {
    const value = harness(async () => { throw new Error('drain exploded'); });
    await expect(value.service.stopAfterCurrent()).rejects.toMatchObject({ code: 'PUBLISHING_STOPPED', message: 'Publishing drain failed while stopping after current work.' });
    expect(value.scheduler.runtimeState()).toBe('DISARMED'); expect(value.scheduler.reason()).toBe('STOP_DRAIN_FAILED'); expect(value.coordinator.resumeAccepting).toHaveBeenCalledTimes(1);
  });
});
