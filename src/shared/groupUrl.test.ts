import { describe, expect, it } from 'vitest';
import { normalizeFacebookGroupUrl, normalizeTags, parseGroupImportLine } from './groupUrl';

describe('Facebook group URL helpers', () => {
  it('canonicalizes numeric and slug group URLs', () => {
    expect(normalizeFacebookGroupUrl('https://www.facebook.com/groups/123456789/?utm_source=x')).toEqual({ normalizedUrl: 'https://www.facebook.com/groups/123456789', identifier: '123456789', facebookGroupId: '123456789' });
    expect(normalizeFacebookGroupUrl('https://facebook.com/groups/examplegroup#about').normalizedUrl).toBe('https://www.facebook.com/groups/examplegroup');
  });
  it('rejects deceptive, unrelated, and malformed URLs', () => {
    for (const url of ['https://facebook.com.attacker.com/groups/1', 'https://fakefacebook.com/groups/1', 'not-a-url', 'https://facebook.com/pages/1', 'https://facebook.com/groups/1/extra']) expect(() => normalizeFacebookGroupUrl(url)).toThrow();
  });
  it('parses import rows and normalizes tags', () => {
    expect(parseGroupImportLine('Laptop VN | https://facebook.com/groups/laptop').name).toBe('Laptop VN');
    expect(normalizeTags([' Sales ', 'sales', '', 'VN'])).toEqual(['sales', 'vn']);
  });
});
