import { describe, expect, it } from 'vitest';
import { OperationsReportService } from './OperationsReportService';

describe('sanitized operations report proxy regression', () => {
  it('does not export proxy username, password key, or credential URL', () => {
    const account = { id: '11111111-1111-4111-8111-111111111111', name: 'Account', status: 'STOPPED', proxyEnabled: true, proxyProtocol: 'HTTP', proxyHost: 'host', proxyPort: 8080, proxyUsername: 'PROXY_USERNAME', proxyPasswordKey: 'SECRET_PASSWORD_KEY', proxyStatus: 'WORKING' };
    const service = new OperationsReportService({ list: () => [account] } as never, { list: () => [], dueCount: () => 0 } as never, { recent: () => [], recentProbes: () => [] } as never, { get: () => ({ enabled: false, executionMode: 'DRY_RUN', canaryMode: true, schedulerIntervalSeconds: 30, maxConcurrentAccounts: 1, videoUploadTimeoutSeconds: 600, maxJobsPerSchedulerSession: 20 }) } as never, '2026-08-v4');
    const serialized = JSON.stringify(service.build());
    for (const forbidden of ['PROXY_USERNAME', 'SECRET_PASSWORD_KEY', 'http://PROXY_USERNAME:SECRET_PASSWORD@host:8080']) expect(serialized).not.toContain(forbidden);
  });

  it('includes platform and surfaces campaign provenance in queue recent items', () => {
    const queueItem = { id: 'q-1', draftTitle: 'Post 1', accountName: 'Acc 1', groupName: 'Grp 1', status: 'PENDING', scheduledAt: undefined, campaignName: 'Spring Sale 2026', body: 'SECRET_DRAFT_BODY_SHOULD_NOT_LEAK' };
    const service = new OperationsReportService({ list: () => [] } as never, { list: () => [queueItem], dueCount: () => 0 } as never, { recent: () => [], recentProbes: () => [] } as never, { get: () => ({ enabled: false, executionMode: 'DRY_RUN', canaryMode: true, schedulerIntervalSeconds: 30, maxConcurrentAccounts: 1, videoUploadTimeoutSeconds: 600, maxJobsPerSchedulerSession: 20 }) } as never, '2026-08-v4', '0.8.0');
    const report = service.build();
    expect(report.appVersion).toBe('0.8.0');
    expect(report.platform).toBe(process.platform);
    expect(report.queue.recent[0].campaignName).toBe('Spring Sale 2026');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('SECRET_DRAFT_BODY_SHOULD_NOT_LEAK');
  });

  it('populates authoritative diagnostics summary with version, platform, mode, counts, and dbIntegrity', () => {
    const account = { id: 'acc-1', name: 'Account 1', status: 'READY' };
    const queueItem1 = { id: 'q-1', draftTitle: 'Draft 1', accountName: 'Account 1', groupName: 'Group 1', status: 'PENDING' };
    const queueItem2 = { id: 'q-2', draftTitle: 'Draft 2', accountName: 'Account 1', groupName: 'Group 2', status: 'SUBMITTED' };
    const group = { id: 'grp-1', name: 'Group 1' };
    const draft = { id: 'drf-1', title: 'Draft 1' };
    const campaign1 = { id: 'cmp-1', name: 'Camp 1', status: 'APPROVED' };
    const campaign2 = { id: 'cmp-2', name: 'Camp 2', status: 'DRAFT' };

    const mockDb = {
      pragma: (pragmaSql: string) => (pragmaSql.includes('integrity_check') ? 'ok' : []),
      prepare: (sql: string) => {
        if (sql.includes('schema_migrations')) {
          return { get: () => ({ version: 8 }) };
        }
        if (sql.includes('sqlite_master')) {
          return {
            all: () => [
              { name: 'schema_migrations' }, { name: 'accounts' }, { name: 'groups' },
              { name: 'account_groups' }, { name: 'drafts' }, { name: 'draft_media' },
              { name: 'media_assets' }, { name: 'queue_items' }, { name: 'queue_item_media' },
              { name: 'publish_attempts' }, { name: 'publish_attempt_events' },
              { name: 'publish_receipts' }, { name: 'publish_reconciliations' },
              { name: 'publish_preflights' }, { name: 'audit_logs' }, { name: 'settings' },
              { name: 'account_onboarding_tasks' }, { name: 'account_sessions' },
              { name: 'campaigns' }, { name: 'campaign_variants' }, { name: 'campaign_plan_items' }
            ]
          };
        }
        return { get: () => ({ count: 0 }), all: () => [] };
      }
    };

    const schedulerMock = {
      runtimeState: () => 'ARMED' as const,
      completedThisSession: () => 3
    };

    const service = new OperationsReportService(
      { list: () => [account] } as never,
      { list: () => [queueItem1, queueItem2], dueCount: () => 1 } as never,
      { recent: () => [], recentProbes: () => [] } as never,
      { get: () => ({ enabled: true, executionMode: 'LIVE', canaryMode: false, schedulerIntervalSeconds: 60, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600, maxJobsPerSchedulerSession: 15, batchPacingSeconds: 120, requireReadyAccounts: true }) } as never,
      '2026-08-v4',
      '0.8.0',
      schedulerMock as never,
      { list: () => [group] } as never,
      { list: () => [draft] } as never,
      { list: () => [campaign1, campaign2] } as never,
      mockDb as never
    );

    const report = service.build();
    expect(report.actualAppVersion).toBe('0.8.0');
    expect(report.appVersion).toBe('0.8.0');
    expect(report.actualSchemaVersion).toBe(8);
    expect(report.databaseVersion).toBe(8);
    expect(report.schemaVersionOk).toBe(true);
    expect(report.platform).toBe(process.platform);
    expect(report.selectorVersion).toBe('2026-08-v4');
    expect(report.publishingMode).toBe('LIVE');
    expect(report.schedulerState).toBe('ARMED');
    expect(report.schedulerRuntimeState).toBe('ARMED');

    // Counts
    expect(report.accountCount).toBe(1);
    expect(report.groupCount).toBe(1);
    expect(report.draftCount).toBe(1);
    expect(report.campaignCounts).toEqual({
      DRAFT: 1,
      IN_REVIEW: 0,
      APPROVED: 1,
      APPROVAL_STALE: 0,
      COMMITTED: 0,
      ARCHIVED: 0
    });
    expect(report.queueCounts).toEqual({
      PENDING: 1,
      SUBMITTED: 1
    });
    expect(report.counts).toEqual({
      accounts: 1,
      groups: 1,
      drafts: 1,
      campaigns: {
        DRAFT: 1,
        IN_REVIEW: 0,
        APPROVED: 1,
        APPROVAL_STALE: 0,
        COMMITTED: 0,
        ARCHIVED: 0
      },
      queue: {
        PENDING: 1,
        SUBMITTED: 1
      }
    });

    // DB Integrity
    expect(report.dbIntegrity).toBeDefined();
    expect(report.dbIntegrity.integrityOk).toBe(true);
    expect(report.dbIntegrity.schemaVersionOk).toBe(true);
    expect(report.dbIntegrity.foreignKeyViolations).toBe(0);
    expect(report.dbIntegrity.missingTables).toEqual([]);
  });
});
