import { describe, expect, it } from 'vitest';
import { parseProxyInput, previewProxyImport, proxyServerUrl } from './proxy';

describe('proxy input parser', () => {
  it.each([
    ['127.0.0.1:8080', { proxyProtocol: 'HTTP', proxyHost: '127.0.0.1', proxyPort: 8080 }],
    ['proxy.example.com:9000:user:pass', { proxyProtocol: 'HTTP', proxyHost: 'proxy.example.com', proxyPort: 9000, proxyUsername: 'user', proxyPassword: 'pass' }],
    ['user:pass@proxy.example.com:9000', { proxyProtocol: 'HTTP', proxyHost: 'proxy.example.com', proxyPort: 9000, proxyUsername: 'user', proxyPassword: 'pass' }],
    ['http://proxy.example.com:8080', { proxyProtocol: 'HTTP', proxyHost: 'proxy.example.com', proxyPort: 8080 }],
    ['http://user:pass@proxy.example.com:8080', { proxyProtocol: 'HTTP', proxyHost: 'proxy.example.com', proxyPort: 8080, proxyUsername: 'user', proxyPassword: 'pass' }],
    ['https://proxy.example.com:8443', { proxyProtocol: 'HTTPS', proxyHost: 'proxy.example.com', proxyPort: 8443 }],
    ['socks5://proxy.example.com:1080', { proxyProtocol: 'SOCKS5', proxyHost: 'proxy.example.com', proxyPort: 1080 }],
    ['[2001:db8::1]:1080', { proxyProtocol: 'HTTP', proxyHost: '2001:db8::1', proxyPort: 1080 }]
  ] as const)('parses %s deterministically', (input, expected) => expect(parseProxyInput(input)).toEqual(expected));

  it('preserves opaque provider usernames except surrounding whitespace', () => {
    expect(parseProxyInput('proxy.example.com:9000:  customer-zone-us-session-abc_123  :secret')).toMatchObject({ proxyUsername: 'customer-zone-us-session-abc_123' });
    expect(parseProxyInput('http://provider%2Fzone:secret@proxy.example.com:9000')).toMatchObject({ proxyUsername: 'provider%2Fzone' });
  });

  it.each(['', 'host', 'host:0', 'host:65536', 'host:not-a-port', 'host:9000:user', 'user@host:9000', 'ftp://host:21', 'http://host:8080/path', 'http://host:8080?x=1', 'host:8080/path', 'host:8080\r\nother:80', 'http://user@host:8080'])('rejects malformed or unsafe input: %s', (input) => {
    expect(() => parseProxyInput(input)).toThrow();
  });

  it('builds protocol-specific IPv4 and IPv6 server URLs', () => {
    expect(proxyServerUrl('HTTP', 'proxy.example.com', 80)).toBe('http://proxy.example.com:80');
    expect(proxyServerUrl('HTTPS', 'proxy.example.com', 443)).toBe('https://proxy.example.com:443');
    expect(proxyServerUrl('SOCKS5', '2001:db8::1', 1080)).toBe('socks5://[2001:db8::1]:1080');
  });

  it('previews multiline input without returning plaintext passwords', () => {
    const password = 'SECRET_PASSWORD';
    const preview = previewProxyImport(`proxy.example.com:9000:user:${password}\nbad input`);
    expect(preview).toMatchObject({ valid: 1, invalid: 1 });
    expect(JSON.stringify(preview)).not.toContain(password);
    expect(preview.rows[0]).toMatchObject({ status: 'VALID', proxy: { hasPassword: true } });
  });
});
