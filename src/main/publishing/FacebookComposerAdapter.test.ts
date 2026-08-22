import { describe, expect, it, vi } from 'vitest';
import type { Locator, Page } from 'playwright';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import { FacebookComposerAdapter, candidateContentMatches, correlateNewPostUrl, hasPublishableContent, normalizePostCandidateUrl, probePostButton } from './FacebookComposerAdapter';

type FakeState = { text: string; fillCount: number; insertCount: number; fillEnables: boolean; fillUpdates: boolean; fallbackEnables: boolean; fallbackUpdates: boolean; enabled: boolean };

function fakeComposer(state: FakeState): { page: Page; textbox: Locator; container: Locator; post: Locator } {
  const post = {
    count: vi.fn(async () => 1),
    nth: vi.fn(() => post),
    isVisible: vi.fn(async () => true),
    isEnabled: vi.fn(async () => state.enabled),
    click: vi.fn(async () => undefined)
  } as unknown as Locator;
  const empty = { count: vi.fn(async () => 0), nth: vi.fn(() => empty), isVisible: vi.fn(async () => false) } as unknown as Locator;
  const trigger = { count: vi.fn(async () => 1), nth: vi.fn(() => trigger), isVisible: vi.fn(async () => true), click: vi.fn(async () => undefined) } as unknown as Locator;
  const page = { getByRole: vi.fn(() => trigger), locator: vi.fn(() => ({ filter: vi.fn(() => empty) })), keyboard: { insertText: vi.fn(async (value: string) => { state.insertCount += 1; if (state.fallbackUpdates) state.text = value; state.enabled = state.fallbackEnables; }), press: vi.fn(async () => undefined) } } as unknown as Page;
  const textbox = {
    fill: vi.fn(async (value: string) => { state.fillCount += 1; if (state.fillUpdates) state.text = value; state.enabled = state.fillEnables; }),
    getAttribute: vi.fn(async (name: string) => name === 'contenteditable' ? 'true' : null),
    evaluate: vi.fn(async () => 'DIV'),
    innerText: vi.fn(async () => state.text),
    textContent: vi.fn(async () => state.text),
    focus: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    page: vi.fn(() => page)
  } as unknown as Locator;
  const container = {
    getByRole: vi.fn((_role: string, options?: { name?: unknown }) => String(options?.name ?? '').toLowerCase().includes('post') ? post : empty),
    locator: vi.fn((selector: string) => selector.includes('input[type="file"]') ? empty : { filter: vi.fn(() => empty) }),
    getByText: vi.fn(() => empty),
    isVisible: vi.fn(async () => true)
  } as unknown as Locator;
  return { page, textbox, container, post };
}

function queueItem(body: string, linkUrl?: string): QueueRecord {
  return { id: 'queue', accountId: 'account', groupId: 'group', draftTitle: 'Draft', body, linkUrl, accountName: 'Account', groupName: 'Group', groupUrl: 'https://www.facebook.com/groups/example', status: 'PENDING', media: [], snapshotHash: 'snapshot', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as QueueRecord;
}

function adapterFor(fake: ReturnType<typeof fakeComposer>): FacebookComposerAdapter {
  const adapter = new FacebookComposerAdapter();
  vi.spyOn(adapter, 'openGroup').mockResolvedValue(undefined);
  vi.spyOn(adapter, 'openComposer').mockResolvedValue({ container: fake.container, textbox: fake.textbox });
  (adapter as unknown as { dismissComposer: () => Promise<undefined> }).dismissComposer = vi.fn(async () => undefined);
  return adapter;
}

describe('FacebookComposerAdapter content handling', () => {
  it('preserves Unicode, emoji, line breaks, and appends a missing link once', async () => {
    const state: FakeState = { text: '', fillCount: 0, insertCount: 0, fillEnables: true, fillUpdates: true, fallbackEnables: true, fallbackUpdates: true, enabled: false };
    const fake = fakeComposer(state); const adapter = adapterFor(fake);
    const result = await adapter.fillContent(fake.textbox, '🔥 NGỌC RỒNG GỐC – SERVER CÀY CHAY 100%\nTối thứ 7 19h\nThử nghiệm tiếng Việt 🇻🇳', 'https://example.com/a');
    expect(state.text).toBe('🔥 NGỌC RỒNG GỐC – SERVER CÀY CHAY 100%\nTối thứ 7 19h\nThử nghiệm tiếng Việt 🇻🇳\n\nhttps://example.com/a');
    expect(result).toMatchObject({ method: 'FILL', editorType: 'CONTENTEDITABLE', visibleContentPresent: true });
  });

  it('does not duplicate a link already present in the snapshot body', async () => {
    const state: FakeState = { text: '', fillCount: 0, insertCount: 0, fillEnables: true, fillUpdates: true, fallbackEnables: true, fallbackUpdates: true, enabled: false };
    const fake = fakeComposer(state); const adapter = adapterFor(fake);
    await adapter.fillContent(fake.textbox, 'Visit https://example.com/a today', 'https://example.com/a');
    expect(state.text).toBe('Visit https://example.com/a today');
  });

  it('runs the actual preflight flow without fallback when fill enables Post', async () => {
    const state: FakeState = { text: '', fillCount: 0, insertCount: 0, fillEnables: true, fillUpdates: true, fallbackEnables: true, fallbackUpdates: true, enabled: false };
    const fake = fakeComposer(state); const adapter = adapterFor(fake);
    const result = await adapter.preflight(fake.page, queueItem('Text-only content'), true);
    expect(result.probe.status).toBe('FOUND');
    expect(result.probe.entryMethod).toBe('FILL');
    expect(result.probe.contentObserved).toBe(true);
    expect(state.insertCount).toBe(0);
    expect(fake.post.click).not.toHaveBeenCalled();
  });

  it('uses one keyboard fallback when fill text is visible but Facebook state remains disabled', async () => {
    const state: FakeState = { text: '', fillCount: 0, insertCount: 0, fillEnables: false, fillUpdates: true, fallbackEnables: true, fallbackUpdates: true, enabled: false };
    const fake = fakeComposer(state); const adapter = adapterFor(fake);
    const result = await adapter.preflight(fake.page, queueItem('Fallback content'), true);
    expect(result.probe.status).toBe('FOUND');
    expect(result.probe.entryMethod).toBe('KEYBOARD_INSERT');
    expect(state.insertCount).toBe(1);
    expect(fake.post.click).not.toHaveBeenCalled();
  });

  it('replaces existing editor text instead of appending during fallback', async () => {
    const state: FakeState = { text: 'Original text', fillCount: 0, insertCount: 0, fillEnables: false, fillUpdates: true, fallbackEnables: true, fallbackUpdates: true, enabled: false };
    const fake = fakeComposer(state); const adapter = adapterFor(fake);
    const result = await adapter.enterComposerContent(fake.textbox, 'Replacement text', 'KEYBOARD_INSERT');
    expect(result.visibleContentPresent).toBe(true);
    expect(state.text).toBe('Replacement text');
    expect(state.text).not.toContain('Original textReplacement text');
  });

  it('fails clearly when verified content is present but Post stays disabled', async () => {
    const state: FakeState = { text: '', fillCount: 0, insertCount: 0, fillEnables: false, fillUpdates: true, fallbackEnables: false, fallbackUpdates: true, enabled: false };
    const fake = fakeComposer(state); const adapter = adapterFor(fake);
    const capture = vi.fn(async () => 'C:\\managed\\diagnostics\\preflight.png');
    const result = await adapter.preflight(fake.page, queueItem('Disabled after entry'), true, capture);
    expect(result.probe.status).toBe('MISSING');
    expect(result.probe.contentObserved).toBe(true);
    expect(result.probe.reason).toContain('Post remained disabled after verified composer content');
    expect(result.probe.entryMethod).toBe('KEYBOARD_INSERT');
    expect(result.probe.diagnosticPath).toContain('preflight.png');
    expect(capture).toHaveBeenCalledWith(fake.page, 'MISSING');
    expect(fake.post.click).not.toHaveBeenCalled();
  });

  it('stops before readiness when content is not observed after both methods', async () => {
    const state: FakeState = { text: '', fillCount: 0, insertCount: 0, fillEnables: false, fillUpdates: false, fallbackEnables: false, fallbackUpdates: false, enabled: false };
    const fake = fakeComposer(state); const adapter = adapterFor(fake);
    const result = await adapter.preflight(fake.page, queueItem('Missing content'), true);
    expect(result.probe.status).toBe('MISSING');
    expect(result.probe.reason).toBe('EDITOR_CONTENT_NOT_OBSERVED');
    expect(result.probe.contentObserved).toBe(false);
    expect(fake.post.click).not.toHaveBeenCalled();
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

  it('canonicalizes tracking variants and requires candidate-scoped content correlation', () => {
    expect(normalizePostCandidateUrl('https://www.facebook.com/groups/demo/posts/10?__cft__=tracking#fragment')).toBe('https://www.facebook.com/groups/demo/posts/10');
    expect(candidateContentMatches('Completely unrelated content', 'A post about a very specific launch announcement')).toBe(false);
    expect(candidateContentMatches('A post about a very specific launch announcement with more text', 'A post about a very specific launch announcement')).toBe(true);
  });

  it('reports disabled and ambiguous Post buttons safely without clicking', async () => {
    const disabled = { isVisible: vi.fn(async () => true), isEnabled: vi.fn(async () => false) } as unknown as Locator;
    await expect(probePostButton([disabled], true, 100)).resolves.toMatchObject({ status: 'MISSING', enabled: false, reason: expect.stringContaining('remained disabled') });
    await expect(probePostButton([disabled, disabled], true)).resolves.toMatchObject({ status: 'AMBIGUOUS', count: 2 });
  });

  it('rejects an empty publish snapshot', () => {
    expect(hasPublishableContent({ body: '', linkUrl: undefined, media: [] })).toBe(false);
    expect(hasPublishableContent({ body: 'Body', linkUrl: undefined, media: [] })).toBe(true);
    expect(hasPublishableContent({ body: '', linkUrl: undefined, media: [{ id: 'media' }] as never })).toBe(true);
  });
});
