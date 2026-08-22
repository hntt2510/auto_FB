import { describe, expect, it, vi } from 'vitest';
import type { Locator } from 'playwright';
import { FacebookComposerAdapter, candidateContentMatches, correlateNewPostUrl, hasPublishableContent, normalizePostCandidateUrl, probePostButton } from './FacebookComposerAdapter';

describe('FacebookComposerAdapter content handling', () => {
  it('preserves Unicode and appends a missing link once', async () => {
    const fill = vi.fn(async () => undefined); const textbox = { fill } as unknown as Locator; const adapter = new FacebookComposerAdapter();
    await adapter.fillContent(textbox, 'Xin chào 🇻🇳\nDòng hai', 'https://example.com/a');
    expect(fill).toHaveBeenCalledWith('Xin chào 🇻🇳\nDòng hai\n\nhttps://example.com/a');
  });

  it('does not duplicate a link already present in the snapshot body', async () => {
    const fill = vi.fn(async () => undefined); const textbox = { fill } as unknown as Locator; const adapter = new FacebookComposerAdapter();
    await adapter.fillContent(textbox, 'Visit https://example.com/a today', 'https://example.com/a');
    expect(fill).toHaveBeenCalledWith('Visit https://example.com/a today');
  });

  it('ignores an old post URL that remains on the group page', () => {
    const oldUrl = 'https://www.facebook.com/groups/demo/posts/10';
    expect(correlateNewPostUrl([oldUrl], [oldUrl], 'https://www.facebook.com/groups/demo')).toBeUndefined();
  });

  it('accepts only a newly observed correlated group post URL', () => {
    const oldUrl = 'https://www.facebook.com/groups/demo/posts/10'; const newUrl = 'https://www.facebook.com/groups/demo/posts/11';
    expect(correlateNewPostUrl([oldUrl, newUrl], [oldUrl], 'https://www.facebook.com/groups/demo')).toBe(newUrl);
    expect(correlateNewPostUrl(['https://www.facebook.com/groups/other/posts/11'], [oldUrl], 'https://www.facebook.com/groups/demo')).toBeUndefined();
  });

  it('canonicalizes tracking variants of the same post', () => {
    expect(normalizePostCandidateUrl('https://www.facebook.com/groups/demo/posts/10?__cft__=tracking#fragment')).toBe('https://www.facebook.com/groups/demo/posts/10');
    expect(correlateNewPostUrl(['https://www.facebook.com/groups/demo/posts/10?__cft__=new'], ['https://www.facebook.com/groups/demo/posts/10'], 'https://www.facebook.com/groups/demo')).toBeUndefined();
  });

  it('requires candidate-scoped content correlation', () => {
    expect(candidateContentMatches('Completely unrelated content', 'A post about a very specific launch announcement')).toBe(false);
    expect(candidateContentMatches('A post about a very specific launch announcement with more text', 'A post about a very specific launch announcement')).toBe(true);
    expect(candidateContentMatches('', 'A post')).toBe(false);
  });

  it('rejects an empty publish snapshot', () => {
    expect(hasPublishableContent({ body: '', linkUrl: undefined, media: [] })).toBe(false);
    expect(hasPublishableContent({ body: 'Body', linkUrl: undefined, media: [] })).toBe(true);
    expect(hasPublishableContent({ body: '', linkUrl: undefined, media: [{ id: 'media' }] as never })).toBe(true);
  });

  it('waits for Post to enable after content fill without clicking it', async () => {
    let enabled = false; const click = vi.fn(); const button = { isVisible: vi.fn(async () => true), isEnabled: vi.fn(async () => enabled), click } as unknown as Locator;
    const fill = vi.fn(async () => { enabled = true; }); await fill();
    await expect(probePostButton([button], true)).resolves.toMatchObject({ status: 'FOUND', enabled: true }); expect(click).not.toHaveBeenCalled();
  });

  it('reports disabled and ambiguous Post buttons safely', async () => {
    const disabled = { isVisible: vi.fn(async () => true), isEnabled: vi.fn(async () => false) } as unknown as Locator;
    await expect(probePostButton([disabled], true, 100)).resolves.toMatchObject({ status: 'MISSING', enabled: false, reason: expect.stringContaining('remained disabled') });
    await expect(probePostButton([disabled, disabled], true)).resolves.toMatchObject({ status: 'AMBIGUOUS', count: 2 });
  });
});
