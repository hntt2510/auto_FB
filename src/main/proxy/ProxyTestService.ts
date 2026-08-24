import type { APIRequestContext, APIResponse } from 'playwright';
import type { ProxyConfigurationInput, ProxyTestResult } from '@shared/types';
import { buildProxyOptions, sanitizeProxyError, type PlaywrightProxyOptions } from './ProxyConfiguration';

type RequestFactory = (options: { proxy: PlaywrightProxyOptions; ignoreHTTPSErrors: boolean }) => Promise<APIRequestContext>;
const DEFAULT_ENDPOINTS = ['https://api.ipify.org?format=json', 'https://icanhazip.com/'];

export class ProxyTestService {
  constructor(private readonly endpoints = DEFAULT_ENDPOINTS, private readonly timeoutMs = 12_000, private readonly factory?: RequestFactory) {}

  async test(input: Omit<ProxyConfigurationInput, 'proxyPassword'>, password?: string): Promise<ProxyTestResult> {
    const testedAt = new Date().toISOString(); const started = Date.now(); let context: APIRequestContext | undefined;
    try {
      const proxy = buildProxyOptions(input, password); const create = this.factory ?? (async (options) => (await import('playwright')).request.newContext(options)); context = await create({ proxy, ignoreHTTPSErrors: false });
      let lastError: unknown; const deadline = Date.now() + this.timeoutMs;
      for (const endpoint of this.endpoints.slice(0, 2)) {
        const remaining = deadline - Date.now(); if (remaining <= 0) break;
        try { const response = await context.get(endpoint, { timeout: remaining }); if (!response.ok()) throw responseError(response); const ip = extractIp(await response.text()); if (!ip) throw new Error('IP echo response did not contain a valid IP address.'); return { success: true, latencyMs: Date.now() - started, ip, testedAt }; }
        catch (error) { lastError = error; const classified = classifyProxyError(error); if (classified === 'PROXY_AUTH_FAILED' || classified === 'PROXY_UNSUPPORTED') break; }
      }
      const code = classifyProxyError(lastError); return { success: false, latencyMs: Date.now() - started, errorCode: code, message: proxyErrorMessage(code), testedAt };
    } catch (error) { const code = classifyProxyError(error); return { success: false, latencyMs: Date.now() - started, errorCode: code, message: proxyErrorMessage(code), testedAt }; }
    finally { await context?.dispose().catch(() => undefined); }
  }
}

export function classifyProxyError(error: unknown): NonNullable<ProxyTestResult['errorCode']> {
  const message = sanitizeProxyError(error).toLowerCase();
  if (/407|proxy authentication|proxy_auth|authentication required|err_invalid_auth_credentials/.test(message)) return 'PROXY_AUTH_FAILED';
  if (/timeout|timed out|etimedout/.test(message)) return 'PROXY_TIMEOUT';
  if (/enotfound|err_name_not_resolved|dns|name resolution/.test(message)) return 'PROXY_DNS_FAILED';
  if (/unsupported|not supported|unknown scheme|err_no_supported_proxies/.test(message)) return 'PROXY_UNSUPPORTED';
  if (/proxy|econnrefused|connection|tunnel|socket|network/.test(message)) return 'PROXY_CONNECTION_FAILED';
  return 'PROXY_TEST_FAILED';
}

function proxyErrorMessage(code: NonNullable<ProxyTestResult['errorCode']>): string { return ({ PROXY_AUTH_FAILED: 'Proxy authentication failed.', PROXY_TIMEOUT: 'Proxy test timed out.', PROXY_DNS_FAILED: 'Proxy DNS resolution failed.', PROXY_UNSUPPORTED: 'Proxy protocol is unsupported.', PROXY_CONNECTION_FAILED: 'Proxy connection failed.', PROXY_TEST_FAILED: 'Proxy test failed.' } as const)[code]; }
function responseError(response: APIResponse): Error { return new Error(response.status() === 407 ? 'Proxy authentication required (407).' : `IP echo request failed (${response.status()}).`); }
function extractIp(body: string): string | undefined { let candidate = body.trim(); try { const value = JSON.parse(candidate) as { ip?: unknown; origin?: unknown }; candidate = typeof value.ip === 'string' ? value.ip : typeof value.origin === 'string' ? value.origin.split(',')[0].trim() : ''; } catch { /* plain text endpoint */ } return isIp(candidate) ? candidate : undefined; }
function isIp(value: string): boolean { if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return value.split('.').every((part) => Number(part) <= 255); if (!value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return false; try { return new URL(`http://[${value}]:1`).hostname.length > 0; } catch { return false; } }
