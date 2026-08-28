import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { SettingsRepository } from '@main/db/repositories/SettingsRepository';
import { AppError } from '@main/errors';
import { publishingSettingsSchema, publishingSettingsUpdateSchema } from '@shared/schemas';
import type { PublishingSettings, PublishingSettingsUpdate } from '@shared/types';

const KEY = 'publishing:settings';
export const DEFAULT_PUBLISHING_SETTINGS: PublishingSettings = { enabled: false, executionMode: 'DRY_RUN', schedulerIntervalSeconds: 30, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600, maxJobsPerSchedulerSession: 20, batchPacingSeconds: 120, canaryMode: true, requireReadyAccounts: false };

export class PublishingSettingsService {
  constructor(private readonly settings: SettingsRepository, private readonly audit: AuditLogRepository, private readonly onChanged: (settings: PublishingSettings) => void) {}

  get(): PublishingSettings {
    const value = this.settings.get(KEY); if (!value) return DEFAULT_PUBLISHING_SETTINGS;
    try { const parsed = publishingSettingsSchema.safeParse({ executionMode: 'DRY_RUN', ...JSON.parse(value) }); return parsed.success ? parsed.data : DEFAULT_PUBLISHING_SETTINGS; } catch { return DEFAULT_PUBLISHING_SETTINGS; }
  }

  /** Reset only the runtime engine switch on startup. Mode and guardrails persist. */
  resetEngineOnStartup(): PublishingSettings {
    const current = this.get();
    if (!current.enabled) return current;
    const next = { ...current, enabled: false };
    this.settings.set(KEY, JSON.stringify(next));
    return next;
  }

  update(input: PublishingSettingsUpdate): PublishingSettings {
    const parsed = publishingSettingsUpdateSchema.safeParse(input); if (!parsed.success) throw new AppError('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid publishing settings.');
    const previous = this.get(); if (previous.executionMode !== 'LIVE' && parsed.data.executionMode === 'LIVE' && !parsed.data.confirmLive) throw new AppError('INVALID_REQUEST', 'Explicit confirmation is required before enabling LIVE execution.');
    const settings = { ...parsed.data }; delete settings.confirmLive; this.settings.set(KEY, JSON.stringify(settings));
    if (previous.enabled !== settings.enabled) this.audit.add({ eventType: settings.enabled ? 'PUBLISH_ENGINE_ENABLED' : 'PUBLISH_ENGINE_DISABLED', message: `Publishing engine ${settings.enabled ? 'enabled' : 'disabled'}.` });
    if (previous.executionMode !== settings.executionMode) this.audit.add({ eventType: 'PUBLISH_EXECUTION_MODE_CHANGED', message: `Publishing execution mode changed to ${settings.executionMode}.` });
    this.onChanged(settings); return settings;
  }
}
