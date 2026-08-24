import type { ParsedProxyInput, ProxyImportPreview, ProxyProtocol } from './types';

const SCHEMES: Record<string, ProxyProtocol> = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' };

export class ProxyParseError extends Error { constructor(message: string) { super(message); this.name = 'ProxyParseError'; } }

export function parseProxyInput(raw: string): ParsedProxyInput {
  if (typeof raw !== 'string' || !raw.trim()) throw new ProxyParseError('Proxy input is required.');
  if (raw.length > 4096 || /[\r\n\0]/.test(raw)) throw new ProxyParseError('Proxy input contains forbidden characters.');
  const value = raw.trim();
  if (value.includes('://')) return parseUrlProxy(value);
  if (/[/?#]/.test(value)) throw new ProxyParseError('Proxy input cannot contain a path, query, or fragment.');
  const at = value.lastIndexOf('@');
  if (at >= 0) {
    if (value.indexOf('@') !== at) throw new ProxyParseError('Proxy credentials are malformed.');
    const credentials = parseCredentials(value.slice(0, at)); const target = parseHostPort(value.slice(at + 1));
    return { proxyProtocol: 'HTTP', ...target, ...credentials };
  }
  const target = splitPlain(value);
  return { proxyProtocol: 'HTTP', proxyHost: target.host, proxyPort: target.port, ...(target.username ? { proxyUsername: target.username, proxyPassword: target.password } : {}) };
}

export function previewProxyImport(text: string): ProxyImportPreview {
  if (typeof text !== 'string' || text.length > 256_000) throw new ProxyParseError('Proxy import text is too large.');
  const result: ProxyImportPreview = { valid: 0, invalid: 0, rows: [] };
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try { const parsed = parseProxyInput(line); result.valid++; result.rows.push({ line: index + 1, display: proxyEndpointLabel(parsed), status: 'VALID', proxy: { proxyProtocol: parsed.proxyProtocol, proxyHost: parsed.proxyHost, proxyPort: parsed.proxyPort, proxyUsername: parsed.proxyUsername, hasPassword: Boolean(parsed.proxyPassword) } }); }
    catch (error) { result.invalid++; result.rows.push({ line: index + 1, display: 'Invalid proxy input', status: 'INVALID', reason: error instanceof Error ? error.message : 'Invalid proxy input.' }); }
  });
  return result;
}

export function proxyServerUrl(protocol: ProxyProtocol, host: string, port: number): string {
  const scheme = protocol.toLowerCase(); const normalizedHost = normalizeHost(host); validatePort(port); return `${scheme}://${isIpv6(normalizedHost) ? `[${normalizedHost}]` : normalizedHost}:${port}`;
}

export function proxyEndpointLabel(value: Pick<ParsedProxyInput, 'proxyProtocol' | 'proxyHost' | 'proxyPort'>): string { return `${value.proxyProtocol} ${isIpv6(value.proxyHost) ? `[${value.proxyHost}]` : value.proxyHost}:${value.proxyPort}`; }

function parseUrlProxy(value: string): ParsedProxyInput {
  let url: URL; try { url = new URL(value); } catch { throw new ProxyParseError('Proxy URL is malformed.'); }
  const protocol = SCHEMES[url.protocol.slice(0, -1).toLowerCase()]; if (!protocol) throw new ProxyParseError('Proxy scheme is unsupported.');
  if (!url.hostname) throw new ProxyParseError('Proxy host is required.'); if (!url.port) throw new ProxyParseError('Proxy port is required.');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new ProxyParseError('Proxy URL cannot contain a path, query, or fragment.');
  const username = url.username.trim(); const password = decode(url.password);
  if (Boolean(username) !== Boolean(password)) throw new ProxyParseError('Proxy username and password must be supplied together.');
  return { proxyProtocol: protocol, proxyHost: normalizeHost(url.hostname), proxyPort: validatePort(Number(url.port)), ...(username ? { proxyUsername: username, proxyPassword: password } : {}) };
}

function splitPlain(value: string): { host: string; port: number; username?: string; password?: string } {
  if (value.startsWith('[')) {
    const end = value.indexOf(']'); if (end < 0 || value[end + 1] !== ':') throw new ProxyParseError('IPv6 proxy input is malformed.');
    const host = normalizeHost(value.slice(1, end)); const rest = value.slice(end + 2).split(':'); if (rest.length !== 1 && rest.length < 3) throw new ProxyParseError('Proxy credentials are incomplete.');
    const port = validatePort(Number(rest[0])); if (rest.length === 1) return { host, port }; const username = rest[1].trim(); const password = rest.slice(2).join(':'); validateCredentialPair(username, password); return { host, port, username, password };
  }
  const parts = value.split(':'); if (parts.length !== 2 && parts.length < 4) throw new ProxyParseError('Use host:port or host:port:username:password.');
  const host = normalizeHost(parts[0]); const port = validatePort(Number(parts[1])); if (parts.length === 2) return { host, port };
  const username = parts[2].trim(); const password = parts.slice(3).join(':'); validateCredentialPair(username, password); return { host, port, username, password };
}

function parseHostPort(value: string): { proxyHost: string; proxyPort: number } { const parsed = splitPlain(value); if (parsed.username) throw new ProxyParseError('Proxy credentials are malformed.'); return { proxyHost: parsed.host, proxyPort: parsed.port }; }
function parseCredentials(value: string): { proxyUsername: string; proxyPassword: string } { const separator = value.indexOf(':'); if (separator <= 0) throw new ProxyParseError('Proxy credentials are incomplete.'); const username = value.slice(0, separator).trim(); const password = value.slice(separator + 1); validateCredentialPair(username, password); return { proxyUsername: username, proxyPassword: password }; }
function validateCredentialPair(username: string, password: string): void { if (!username || !password || /[\r\n\0]/.test(username + password)) throw new ProxyParseError('Proxy username and password must be supplied together.'); if (username.length > 1024 || password.length > 4096) throw new ProxyParseError('Proxy credentials are too long.'); }
function normalizeHost(value: string): string { const host = value.trim().replace(/^\[|\]$/g, ''); if (!host || host.length > 255 || /\s|[@/?#\\]/.test(host)) throw new ProxyParseError('Proxy host is invalid.'); if (host.includes(':') && !isIpv6(host)) throw new ProxyParseError('Proxy host is invalid.'); return host.toLowerCase(); }
function validatePort(port: number): number { if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProxyParseError('Proxy port must be between 1 and 65535.'); return port; }
function decode(value: string): string { try { return decodeURIComponent(value); } catch { throw new ProxyParseError('Proxy credentials contain invalid encoding.'); } }
function isIpv6(value: string): boolean { if (!value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return false; try { return new URL(`http://[${value}]:1`).hostname.length > 0; } catch { return false; } }
