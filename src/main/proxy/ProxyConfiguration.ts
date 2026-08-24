import type { FacebookAccount, ProxyConfigurationInput, ProxyProtocol } from '@shared/types';
import { proxyServerUrl } from '@shared/proxy';
import type { SecretStore } from '@main/security/SecretStore';
import { AppError } from '@main/errors';

export type PlaywrightProxyOptions = { server: string; username?: string; password?: string };

export function buildProxyOptions(input: Pick<ProxyConfigurationInput, 'proxyProtocol' | 'proxyHost' | 'proxyPort' | 'proxyUsername'>, password?: string): PlaywrightProxyOptions {
  const username = input.proxyUsername?.trim(); if (Boolean(username) !== Boolean(password)) throw new AppError('PROXY_AUTH_FAILED', 'Proxy credentials are incomplete.');
  return { server: proxyServerUrl(input.proxyProtocol, input.proxyHost, input.proxyPort), ...(username ? { username, password } : {}) };
}

export function buildPlaywrightProxy(account: FacebookAccount, secrets: SecretStore): PlaywrightProxyOptions | undefined {
  if (!account.proxyEnabled) return undefined; if (!account.proxyHost || !account.proxyPort) throw new AppError('INVALID_REQUEST', 'Proxy host and port are required.');
  const protocol: ProxyProtocol = account.proxyProtocol ?? 'HTTP'; const username = account.proxyUsername?.trim();
  if (Boolean(username) !== Boolean(account.proxyPasswordKey)) throw new AppError('PROXY_AUTH_FAILED', 'Proxy credentials are incomplete.');
  const password = account.proxyPasswordKey ? secrets.get(account.proxyPasswordKey) : undefined;
  return buildProxyOptions({ proxyProtocol: protocol, proxyHost: account.proxyHost, proxyPort: account.proxyPort, proxyUsername: username }, password);
}

export function sanitizeProxyError(error: unknown, secrets: Array<string | undefined> = []): string {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/\b(?:https?|socks5):\/\/[^\s/@:]+:[^\s/@]+@/gi, (match) => match.slice(0, match.indexOf('://') + 3) + '[credentials]@');
  for (const secret of secrets.filter((value): value is string => Boolean(value))) message = message.split(secret).join('[redacted]');
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}
