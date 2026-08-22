import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { SettingsRepository } from '@main/db/repositories/SettingsRepository';
import { AppError } from '@main/errors';
import { publishingSettingsSchema } from '@shared/schemas';
import type { PublishingSettings } from '@shared/types';

const KEY = 'publishing:settings';
export const DEFAULT_PUBLISHING_SETTINGS: PublishingSettings = { enabled: false, schedulerIntervalSeconds: 30, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600 };

export class PublishingSettingsService {
  constructor(private readonly settings: SettingsRepository, private readonly audit: AuditLogRepository, private readonly onChanged: (settings: PublishingSettings) => void) {}

  get(): PublishingSettings {
    const value = this.settings.get(KEY); if (!value) return DEFAULT_PUBLISHING_SETTINGS;
    try { const parsed = publishingSettingsSchema.safeParse(JSON.parse(value)); return parsed.success ? parsed.data : DEFAULT_PUBLISHING_SETTINGS; } catch { return DEFAULT_PUBLISHING_SETTINGS; }
  }

  update(input: PublishingSettings): PublishingSettings {
    const parsed = publishingSettingsSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid publishing settings.');
    const previous = this.get(); this.settings.set(KEY, JSON.stringify(parsed.data));
    if (previous.enabled !== parsed.data.enabled) this.audit.add({ eventType: parsed.data.enabled ? 'PUBLISH_ENGINE_ENABLED' : 'PUBLISH_ENGINE_DISABLED', message: `Publishing engine ${parsed.data.enabled ? 'enabled' : 'disabled'}.` });
    this.onChanged(parsed.data); return parsed.data;
  }
}
