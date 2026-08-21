export type NormalizedGroupUrl = { normalizedUrl: string; identifier: string; facebookGroupId?: string };

export function normalizeFacebookGroupUrl(input: string): NormalizedGroupUrl {
  let parsed: URL;
  try { parsed = new URL(input.trim()); } catch { throw new Error('Invalid Facebook group URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Facebook group URL must use HTTP or HTTPS.');
  if (!['facebook.com', 'www.facebook.com'].includes(parsed.hostname.toLowerCase())) throw new Error('URL must use facebook.com.');
  if (parsed.username || parsed.password || parsed.port) throw new Error('Facebook group URL contains unsupported credentials or port.');
  const match = parsed.pathname.match(/^\/groups\/([A-Za-z0-9][A-Za-z0-9._-]*)\/?$/i);
  if (!match) throw new Error('URL must point to a Facebook group.');
  const identifier = match[1];
  return { normalizedUrl: `https://www.facebook.com/groups/${identifier}`, identifier, facebookGroupId: /^\d+$/.test(identifier) ? identifier : undefined };
}

export function parseGroupImportLine(line: string): { name?: string; url: string } {
  const trimmed = line.trim();
  if (!trimmed) throw new Error('Empty line.');
  const separator = trimmed.indexOf('|');
  if (separator < 0) return { url: trimmed };
  const name = trimmed.slice(0, separator).trim();
  const url = trimmed.slice(separator + 1).trim();
  if (!name || !url) throw new Error('Use Group Name | URL.');
  return { name, url };
}

export function normalizeTags(tags: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of tags) {
    const tag = value.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag); result.push(tag);
  }
  return result.slice(0, 30);
}
