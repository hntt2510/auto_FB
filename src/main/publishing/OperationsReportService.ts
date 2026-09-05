import { dialog } from 'electron';
import { writeFile } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import type { AccountRepository } from '@main/db/repositories/AccountRepository';
import type { PublishRepository } from '@main/db/repositories/PublishRepository';
import type { QueueRepository } from '@main/db/repositories/QueueRepository';
import type { GroupRepository } from '@main/db/repositories/GroupRepository';
import type { DraftRepository } from '@main/db/repositories/DraftRepository';
import type { CampaignRepository } from '@main/db/repositories/CampaignRepository';
import type { PublishingSettingsService } from './PublishingSettingsService';
import type { PublishScheduler } from './PublishScheduler';
import { LATEST_SCHEMA_VERSION } from '@main/db/migrations';
import { checkDatabaseIntegrity, type DatabaseIntegrityReport } from '@main/services/DatabaseIntegrityService';

export type SanitizedOperationsReport = {
  appVersion: string;
  actualAppVersion: string;
  databaseVersion: number;
  actualSchemaVersion: number;
  schemaVersionOk: boolean;
  selectorVersion: string;
  platform: string;
  publishingMode: string;
  schedulerState: string;
  schedulerRuntimeState: string;
  accountCount: number;
  groupCount: number;
  draftCount: number;
  campaignCounts: Record<string, number>;
  queueCounts: Record<string, number>;
  counts: {
    accounts: number;
    groups: number;
    drafts: number;
    campaigns: Record<string, number>;
    queue: Record<string, number>;
  };
  dbIntegrity: DatabaseIntegrityReport;
  generatedAt: string;
  accounts: Array<{ id: string; name: string; status: string; lastHealthStatus?: string }>;
  publishing: { enabled: boolean; executionMode: string; canaryMode: boolean; requireReadyAccounts: boolean; schedulerIntervalSeconds: number; maxConcurrentAccounts: number; batchPacingSeconds: number; schedulerState: string; backlogCount: number; sessionCompleted: number; sessionLimit: number };
  queue: { counts: Record<string, number>; recent: Array<{ id: string; title: string; accountName: string; groupName: string; status: string; scheduledAt?: string; campaignName?: string }> };
  recentAttempts: Array<{ id: string; queueItemId: string; status: string; errorCode?: string; executionMode: string; selectorVersion?: string }>;
  recentSelectorProbes: Array<{ id?: string; accountId: string; groupId: string; status: string; selectorVersion: string; checkedAt: string }>;
};

export class OperationsReportService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly queue: QueueRepository,
    private readonly attempts: PublishRepository,
    private readonly settings: PublishingSettingsService,
    private readonly selectorVersion: string,
    private readonly appVersion = '1.0.0',
    private readonly scheduler?: PublishScheduler,
    private readonly groups?: GroupRepository,
    private readonly drafts?: DraftRepository,
    private readonly campaigns?: CampaignRepository,
    private readonly db?: Database.Database
  ) {}

  build(): SanitizedOperationsReport {
    const accountRows = this.accounts.list();
    const queueRows = this.queue.list();
    const queueCounts: Record<string, number> = {};
    for (const item of queueRows) queueCounts[item.status] = (queueCounts[item.status] ?? 0) + 1;

    let groupCount = this.groups ? this.groups.list().length : 0;
    let draftCount = this.drafts ? this.drafts.list().length : 0;
    const campaignCounts: Record<string, number> = {
      DRAFT: 0,
      IN_REVIEW: 0,
      APPROVED: 0,
      APPROVAL_STALE: 0,
      COMMITTED: 0,
      ARCHIVED: 0
    };

    if (this.campaigns) {
      for (const campaign of this.campaigns.list()) {
        campaignCounts[campaign.status] = (campaignCounts[campaign.status] ?? 0) + 1;
      }
    } else if (this.db) {
      try {
        const rows = this.db.prepare('SELECT status, COUNT(*) as count FROM campaigns GROUP BY status').all() as Array<{ status: string; count: number }>;
        for (const row of rows) campaignCounts[row.status] = row.count;
      } catch {
        /* best effort */
      }
    }

    if (!this.groups && this.db) {
      try {
        groupCount = (this.db.prepare('SELECT COUNT(*) as count FROM groups').get() as { count: number })?.count ?? 0;
      } catch {
        /* best effort */
      }
    }

    if (!this.drafts && this.db) {
      try {
        draftCount = (this.db.prepare('SELECT COUNT(*) as count FROM drafts').get() as { count: number })?.count ?? 0;
      } catch {
        /* best effort */
      }
    }

    const dbIntegrity: DatabaseIntegrityReport = this.db
      ? checkDatabaseIntegrity(this.db)
      : {
          integrityOk: true,
          schemaVersionOk: true,
          integrityDetail: 'ok',
          foreignKeyViolations: 0,
          schemaVersion: LATEST_SCHEMA_VERSION,
          expectedSchemaVersion: LATEST_SCHEMA_VERSION,
          expectedTables: [],
          missingTables: [],
          checkedAt: new Date().toISOString()
        };

    const pubSettings = this.settings.get();
    const schedulerRuntimeState = this.scheduler?.runtimeState() ?? 'DISARMED';
    const publishingMode = pubSettings.executionMode;

    const counts = {
      accounts: accountRows.length,
      groups: groupCount,
      drafts: draftCount,
      campaigns: campaignCounts,
      queue: queueCounts
    };

    return {
      appVersion: this.appVersion,
      actualAppVersion: this.appVersion,
      databaseVersion: dbIntegrity.schemaVersion,
      actualSchemaVersion: dbIntegrity.schemaVersion,
      schemaVersionOk: dbIntegrity.schemaVersionOk,
      selectorVersion: this.selectorVersion,
      platform: process.platform,
      publishingMode,
      schedulerState: schedulerRuntimeState,
      schedulerRuntimeState,
      accountCount: accountRows.length,
      groupCount,
      draftCount,
      campaignCounts,
      queueCounts,
      counts,
      dbIntegrity,
      generatedAt: new Date().toISOString(),
      accounts: accountRows.map((account) => ({ id: account.id, name: account.name, status: account.status, lastHealthStatus: account.lastHealthStatus })),
      publishing: {
        enabled: pubSettings.enabled,
        executionMode: pubSettings.executionMode,
        canaryMode: pubSettings.canaryMode !== false,
        requireReadyAccounts: pubSettings.requireReadyAccounts === true,
        schedulerIntervalSeconds: pubSettings.schedulerIntervalSeconds,
        maxConcurrentAccounts: pubSettings.maxConcurrentAccounts,
        batchPacingSeconds: pubSettings.batchPacingSeconds,
        schedulerState: schedulerRuntimeState,
        backlogCount: this.queue.dueCount(new Date().toISOString()),
        sessionCompleted: this.scheduler?.completedThisSession() ?? 0,
        sessionLimit: pubSettings.maxJobsPerSchedulerSession ?? 20
      },
      queue: { counts: queueCounts, recent: queueRows.slice(0, 25).map((item) => ({ id: item.id, title: item.draftTitle, accountName: item.accountName, groupName: item.groupName, status: item.status, scheduledAt: item.scheduledAt, campaignName: item.campaignName })) },
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
