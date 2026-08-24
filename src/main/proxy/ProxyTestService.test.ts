import { describe, expect, it, vi } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { classifyProxyError, ProxyTestService } from './ProxyTestService';

const proxy = { proxyProtocol: 'HTTP' as const, proxyHost: 'proxy.example.com', proxyPort: 8080, proxyUsername: 'user' };
function response(body: string, status = 200): APIResponse { return { ok: () => status >= 200 && status < 300, status: () => status, text: async () => body } as unknown as APIResponse; }
function context(get: ReturnType<typeof vi.fn>) { const dispose = vi.fn(async () => undefined); return { value: { get, dispose } as unknown as APIRequestContext, dispose }; }

describe('ProxyTestService', () => {
  it('uses an isolated request context, returns outbound IP/latency, and disposes it', async () => {
    const request = context(vi.fn(async () => response('{"ip":"203.0.113.10"}'))); const factory = vi.fn(async (options: unknown) => { void options; return request.value; });
    const result = await new ProxyTestService(['https://ip.test/json'], 12_000, factory).test(proxy, 'SECRET_PASSWORD');
    expect(result).toMatchObject({ success: true, ip: '203.0.113.10' }); expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(factory).toHaveBeenCalledWith({ proxy: { server: 'http://proxy.example.com:8080', username: 'user', password: 'SECRET_PASSWORD' }, ignoreHTTPSErrors: false });
    expect(request.value.get).toHaveBeenCalledWith('https://ip.test/json', expect.objectContaining({ timeout: expect.any(Number) }));
    expect(factory.mock.calls[0][0]).not.toHaveProperty('storageState'); expect(request.dispose).toHaveBeenCalledTimes(1);
  });

  it('falls back to the second endpoint', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('network failed')).mockResolvedValueOnce(response('198.51.100.7')); const request = context(get);
    const result = await new ProxyTestService(['https://first.test', 'https://second.test'], 12_000, async () => request.value).test({ ...proxy, proxyUsername: undefined });
    expect(result).toMatchObject({ success: true, ip: '198.51.100.7' }); expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Proxy authentication required (407)', 'PROXY_AUTH_FAILED'],
    ['request ETIMEDOUT', 'PROXY_TIMEOUT'],
    ['getaddrinfo ENOTFOUND proxy.example.com', 'PROXY_DNS_FAILED'],
    ['unsupported socks proxy', 'PROXY_UNSUPPORTED'],
    ['ERR_PROXY_CONNECTION_FAILED', 'PROXY_CONNECTION_FAILED']
  ] as const)('classifies %s as %s', (message, code) => expect(classifyProxyError(new Error(message))).toBe(code));

  it('returns only a stable sanitized failure message', async () => {
    const secret = 'SECRET_PASSWORD'; const request = context(vi.fn(async () => { throw new Error(`connect http://username:${secret}@host:1234 proxy failed`); }));
    const result = await new ProxyTestService(['https://ip.test'], 12_000, async () => request.value).test(proxy, secret);
    expect(result).toMatchObject({ success: false, errorCode: 'PROXY_CONNECTION_FAILED', message: 'Proxy connection failed.' });
    expect(JSON.stringify(result)).not.toContain('username'); expect(JSON.stringify(result)).not.toContain(secret);
  });
});
