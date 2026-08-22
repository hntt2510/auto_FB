import { describe, expect, it, vi } from 'vitest';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { SettingsRepository } from '@main/db/repositories/SettingsRepository';
import { DEFAULT_PUBLISHING_SETTINGS, PublishingSettingsService } from './PublishingSettingsService';

describe('PublishingSettingsService', () => {
  it('defaults the engine off and validates bounded settings', () => {
    let value: string | undefined; const settings = { get: () => value, set: vi.fn((_key: string, next: string) => { value = next; }) }; const audit = { add: vi.fn() }; const changed = vi.fn(); const service = new PublishingSettingsService(settings as unknown as SettingsRepository, audit as unknown as AuditLogRepository, changed);
    expect(service.get()).toEqual(DEFAULT_PUBLISHING_SETTINGS);
    expect(() => service.update({ ...DEFAULT_PUBLISHING_SETTINGS, schedulerIntervalSeconds: 10 })).toThrow();
    expect(service.update({ ...DEFAULT_PUBLISHING_SETTINGS, enabled: true }).enabled).toBe(true); expect(audit.add).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'PUBLISH_ENGINE_ENABLED' })); expect(changed).toHaveBeenCalled();
  });
});
