import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLISHING_SETTINGS } from './PublishingSettingsService';

describe('RC 0.8.0 publishing safety invariant audit', () => {
  it('default execution mode is DRY_RUN', () => {
    expect(DEFAULT_PUBLISHING_SETTINGS.executionMode).toBe('DRY_RUN');
  });

  it('default canary mode is ON', () => {
    expect(DEFAULT_PUBLISHING_SETTINGS.canaryMode).toBe(true);
  });

  it('default engine is disabled', () => {
    expect(DEFAULT_PUBLISHING_SETTINGS.enabled).toBe(false);
  });

  it('default batch pacing is at least 60 seconds', () => {
    expect(DEFAULT_PUBLISHING_SETTINGS.batchPacingSeconds).toBeGreaterThanOrEqual(60);
  });

  it('default max concurrent accounts is bounded', () => {
    expect(DEFAULT_PUBLISHING_SETTINGS.maxConcurrentAccounts).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_PUBLISHING_SETTINGS.maxConcurrentAccounts).toBeLessThanOrEqual(5);
  });

  it('default session job limit prevents unbounded execution', () => {
    expect(DEFAULT_PUBLISHING_SETTINGS.maxJobsPerSchedulerSession).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_PUBLISHING_SETTINGS.maxJobsPerSchedulerSession).toBeLessThanOrEqual(50);
  });
});
