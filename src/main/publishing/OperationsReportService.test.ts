import { describe, expect, it } from 'vitest';
import { OperationsReportService } from './OperationsReportService';

describe('sanitized operations report proxy regression', () => {
  it('does not export proxy username, password key, or credential URL', () => {
    const account = { id: '11111111-1111-4111-8111-111111111111', name: 'Account', status: 'STOPPED', proxyEnabled: true, proxyProtocol: 'HTTP', proxyHost: 'host', proxyPort: 8080, proxyUsername: 'PROXY_USERNAME', proxyPasswordKey: 'SECRET_PASSWORD_KEY', proxyStatus: 'WORKING' };
    const service = new OperationsReportService({ list: () => [account] } as never, { list: () => [], dueCount: () => 0 } as never, { recent: () => [], recentProbes: () => [] } as never, { get: () => ({ enabled: false, executionMode: 'DRY_RUN', canaryMode: true, schedulerIntervalSeconds: 30, maxConcurrentAccounts: 1, videoUploadTimeoutSeconds: 600, maxJobsPerSchedulerSession: 20 }) } as never, '2026-08-v4');
    const serialized = JSON.stringify(service.build());
    for (const forbidden of ['PROXY_USERNAME', 'SECRET_PASSWORD_KEY', 'http://PROXY_USERNAME:SECRET_PASSWORD@host:8080']) expect(serialized).not.toContain(forbidden);
  });
});
