import { describe, expect, it, vi } from 'vitest';
import type { Locator } from 'playwright';
import { FacebookComposerAdapter } from './FacebookComposerAdapter';

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
});
