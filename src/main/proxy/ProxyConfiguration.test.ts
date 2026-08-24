import { describe, expect, it, vi } from 'vitest';
import type { FacebookAccount } from '@shared/types';
import type { SecretStore } from '@main/security/SecretStore';
import { buildPlaywrightProxy, buildProxyOptions, sanitizeProxyError } from './ProxyConfiguration';

function account(protocol: FacebookAccount['proxyProtocol']): FacebookAccount {
  return { id: '11111111-1111-4111-8111-111111111111', name: 'Proxy account', profileName: 'proxy-account', profileDirectory: 'C:/profiles/proxy-account', proxyEnabled: true, proxyProtocol: protocol, proxyHost: 'proxy.example.com', proxyPort: 9000, proxyUsername: 'provider-zone-us', proxyPasswordKey: 'opaque-key', proxyStatus: 'UNTESTED', status: 'STOPPED', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}

describe('Playwright proxy configuration', () => {
  it.each([['HTTP', 'http://proxy.example.com:9000'], ['HTTPS', 'https://proxy.example.com:9000'], ['SOCKS5', 'socks5://proxy.example.com:9000']] as const)('maps %s and loads credentials separately', (protocol, server) => {
    const get = vi.fn(() => 'SECRET_PASSWORD'); const secrets = { get } as unknown as SecretStore;
    expect(buildPlaywrightProxy(account(protocol), secrets)).toEqual({ server, username: 'provider-zone-us', password: 'SECRET_PASSWORD' });
    expect(get).toHaveBeenCalledWith('opaque-key');
  });

  it('does not load credentials for an unauthenticated proxy', () => {
    const get = vi.fn(); const secrets = { get } as unknown as SecretStore;
    expect(buildPlaywrightProxy({ ...account('HTTP'), proxyUsername: undefined, proxyPasswordKey: undefined }, secrets)).toEqual({ server: 'http://proxy.example.com:9000' });
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects incomplete credentials', () => {
    expect(() => buildProxyOptions({ proxyProtocol: 'HTTP', proxyHost: 'host', proxyPort: 80, proxyUsername: 'user' })).toThrow(/incomplete/i);
  });

  it('sanitizes credential URLs and supplied secret strings', () => {
    const sanitized = sanitizeProxyError(new Error('connect http://username:SECRET_PASSWORD@host:1234 failed SECRET_PASSWORD'), ['SECRET_PASSWORD']);
    expect(sanitized).not.toContain('username');
    expect(sanitized).not.toContain('SECRET_PASSWORD');
    expect(sanitized).toContain('[credentials]');
  });
});
