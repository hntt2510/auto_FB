import { describe, expect, it, vi } from 'vitest';
import type { Locator } from 'playwright';
import { FacebookComposerAdapter, correlateNewPostUrl } from './FacebookComposerAdapter';

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
});
