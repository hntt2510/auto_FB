import { dialog } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { PublishRepository } from '@main/db/repositories/PublishRepository';
import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import type { PublishingSettingsService } from './PublishingSettingsService';
import type { PublishScheduler } from './PublishScheduler';
import { LATEST_SCHEMA_VERSION } from '@main/db/migrations';

export type SanitizedOperationsReport = {
  appVersion: string;
  databaseVersion: number;
  selectorVersion: string;
  generatedAt: string;
  accounts: Array<{ id: string; name: string; status: string; lastHealthStatus?: string }>;
  publishing: { enabled: boolean; executionMode: string; canaryMode: boolean; requireReadyAccounts: boolean; schedulerIntervalSeconds: number; maxConcurrentAccounts: number; schedulerState: string; backlogCount: number; sessionCompleted: number; sessionLimit: number };
  queue: { counts: Record<string, number>; recent: Array<{ id: string; title: string; accountName: string; groupName: string; status: string; scheduledAt?: string }> };
  recentAttempts: Array<{ id: string; queueItemId: string; status: string; errorCode?: string; executionMode: string; selectorVersion?: string }>;
  recentSelectorProbes: Array<{ id?: string; accountId: string; groupId: string; status: string; selectorVersion: string; checkedAt: string }>;
};

export class OperationsReportService {
  constructor(private readonly accounts: AccountRepository, private readonly queue: QueueRepository, private readonly attempts: PublishRepository, private readonly settings: PublishingSettingsService, private readonly selectorVersion: string, private readonly appVersion = '1.0.0', private readonly scheduler?: PublishScheduler) {}

  build(): SanitizedOperationsReport {
    const accountRows = this.accounts.list();
    const queueRows = this.queue.list();
    const counts: Record<string, number> = {};
    for (const item of queueRows) counts[item.status] = (counts[item.status] ?? 0) + 1;
    return {
      appVersion: this.appVersion,
      databaseVersion: LATEST_SCHEMA_VERSION,
      selectorVersion: this.selectorVersion,
      generatedAt: new Date().toISOString(),
      accounts: accountRows.map((account) => ({ id: account.id, name: account.name, status: account.status, lastHealthStatus: account.lastHealthStatus })),
      publishing: ((value) => ({ enabled: value.enabled, executionMode: value.executionMode, canaryMode: value.canaryMode !== false, requireReadyAccounts: value.requireReadyAccounts === true, schedulerIntervalSeconds: value.schedulerIntervalSeconds, maxConcurrentAccounts: value.maxConcurrentAccounts, schedulerState: this.scheduler?.runtimeState() ?? 'DISARMED', backlogCount: this.queue.dueCount(new Date().toISOString()), sessionCompleted: this.scheduler?.completedThisSession() ?? 0, sessionLimit: value.maxJobsPerSchedulerSession ?? 20 }))(this.settings.get()),
      queue: { counts, recent: queueRows.slice(0, 25).map((item) => ({ id: item.id, title: item.draftTitle, accountName: item.accountName, groupName: item.groupName, status: item.status, scheduledAt: item.scheduledAt })) },
      recentAttempts: this.attempts.recent(25).map((attempt) => ({ id: attempt.id, queueItemId: attempt.queueItemId, status: attempt.status, errorCode: attempt.errorCode, executionMode: attempt.executionMode, selectorVersion: attempt.selectorVersion })),
      recentSelectorProbes: this.attempts.recentProbes(25).map((probe) => ({ id: probe.id, accountId: probe.accountId, groupId: probe.groupId, status: probe.status, selectorVersion: probe.selectorVersion, checkedAt: probe.checkedAt }))
    };
  }

  async chooseAndExport(): Promise<string | undefined> {
    const result = await dialog.showSaveDialog({ title: 'Export sanitized operations report', defaultPath: 'facebook-ops-report.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return undefined;
    await writeFile(result.filePath, JSON.stringify(this.build(), null, 2), 'utf8');
    return result.filePath;
  }
}
