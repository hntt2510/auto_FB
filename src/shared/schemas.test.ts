import { describe, expect, it } from 'vitest';
import { accountSessionNavigationSchema, accountSessionSettingsSchema, createAccountSchema, publishingSettingsSchema, updateAccountSchema } from './schemas';

describe('account schemas', () => {
  it('accepts direct and authenticated fixed proxy accounts', () => {
    expect(createAccountSchema.safeParse({ name: 'FB01', profileName: 'fb01', proxyEnabled: false }).success).toBe(true);
    expect(createAccountSchema.safeParse({ name: 'FB02', profileName: 'fb02', proxyEnabled: true, proxyHost: '127.0.0.1', proxyPort: 8080, proxyUsername: 'user', proxyPassword: 'secret' }).success).toBe(true);
    expect(createAccountSchema.safeParse({ name: 'FB03', profileName: 'fb03', proxyEnabled: true, proxyProtocol: 'SOCKS5', proxyHost: 'proxy.example.com', proxyPort: 1080 }).success).toBe(true);
  });

  it('rejects proxy control characters and unsupported protocols while preserving opaque usernames', () => {
    expect(createAccountSchema.safeParse({ name: 'FB', profileName: 'fb', proxyEnabled: true, proxyProtocol: 'FTP', proxyHost: 'host', proxyPort: 80 }).success).toBe(false);
    expect(createAccountSchema.safeParse({ name: 'FB', profileName: 'fb', proxyEnabled: true, proxyHost: 'host\r\nInjected', proxyPort: 80 }).success).toBe(false);
    const parsed = createAccountSchema.parse({ name: 'FB', profileName: 'fb', proxyEnabled: true, proxyHost: 'host', proxyPort: 80, proxyUsername: '  provider-zone-us-session-123  ', proxyPassword: 'secret' });
    if (!parsed.proxyEnabled) throw new Error('Expected proxy account.');
    expect(parsed.proxyUsername).toBe('provider-zone-us-session-123');
  });

  it('rejects invalid ports, missing proxy host, and incomplete credentials', () => {
    expect(createAccountSchema.safeParse({ name: 'FB', profileName: 'fb', proxyEnabled: true, proxyHost: 'host', proxyPort: 70000 }).success).toBe(false);
    expect(createAccountSchema.safeParse({ name: 'FB', profileName: 'fb', proxyEnabled: true, proxyPort: 80 }).success).toBe(false);
    expect(createAccountSchema.safeParse({ name: 'FB', profileName: 'fb', proxyEnabled: true, proxyHost: 'host', proxyPort: 80, proxyUsername: 'user' }).success).toBe(false);
  });

  it('does not allow a password without a username on update', () => {
    expect(updateAccountSchema.safeParse({ accountId: '00000000-0000-0000-0000-000000000000', name: 'FB', proxyEnabled: true, proxyHost: 'host', proxyPort: 80, proxyPassword: 'secret' }).success).toBe(false);
  });
  it('defaults and bounds the scheduler session safety cap', () => { const base = { enabled: false, executionMode: 'DRY_RUN', schedulerIntervalSeconds: 30, maxConcurrentAccounts: 2, videoUploadTimeoutSeconds: 600, canaryMode: true }; expect(publishingSettingsSchema.parse(base).maxJobsPerSchedulerSession).toBe(20); expect(publishingSettingsSchema.safeParse({ ...base, maxJobsPerSchedulerSession: 0 }).success).toBe(false); expect(publishingSettingsSchema.safeParse({ ...base, maxJobsPerSchedulerSession: 101 }).success).toBe(false); });
  it('bounds account session targets and confines operator URLs to Facebook', () => { const id = '00000000-0000-4000-8000-000000000000'; expect(accountSessionSettingsSchema.safeParse({ targetDurationMinutes: 30 }).success).toBe(true); expect(accountSessionSettingsSchema.safeParse({ targetDurationMinutes: 9 }).success).toBe(false); expect(accountSessionSettingsSchema.safeParse({ targetDurationMinutes: 61 }).success).toBe(false); expect(accountSessionNavigationSchema.safeParse({ accountId: id, destination: 'URL', url: 'https://www.facebook.com/profile.php?id=1' }).success).toBe(true); expect(accountSessionNavigationSchema.safeParse({ accountId: id, destination: 'URL', url: 'https://facebook.com.evil.example/' }).success).toBe(false); expect(accountSessionNavigationSchema.safeParse({ accountId: id, destination: 'URL' }).success).toBe(false); });
});
