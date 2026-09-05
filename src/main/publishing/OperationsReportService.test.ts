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
});
