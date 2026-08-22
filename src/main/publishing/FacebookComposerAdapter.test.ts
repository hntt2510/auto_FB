import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Locator, type Page } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import { FacebookComposerAdapter, candidateContentMatches, correlateNewPostUrl, hasPublishableContent, normalizePostCandidateUrl, probePostButton } from './FacebookComposerAdapter';
import { FACEBOOK_SELECTORS_VERSION, facebookText } from './selectors/facebookSelectors';

type FakeState = { text: string; fillCount: number; insertCount: number; fillEnables: boolean; fillUpdates: boolean; fallbackEnables: boolean; fallbackUpdates: boolean; enabled: boolean };
type TriggerDescriptor = { role: string; tag: string; ariaLabel?: string; title?: string; text?: string };

function fakeComposer(state: FakeState, descriptor: TriggerDescriptor = { role: 'button', tag: 'DIV', ariaLabel: 'Bạn viết gì đi...', text: 'Bạn viết gì đi...' }, hydrationCycles = 0): { page: Page; textbox: Locator; container: Locator; post: Locator } {
  const post = {
    count: vi.fn(async () => 1),
    nth: vi.fn(() => post),
    isVisible: vi.fn(async () => true),
    isEnabled: vi.fn(async () => state.enabled),
    click: vi.fn(async () => undefined)
  } as unknown as Locator;
  const dialogTitle = {
    count: vi.fn(async () => 1),
    nth: vi.fn(() => dialogTitle),
    isVisible: vi.fn(async () => true),
    innerText: vi.fn(async () => 'Tạo bài viết'),
    textContent: vi.fn(async () => 'Tạo bài viết')
  } as unknown as Locator;
  const empty = { count: vi.fn(async () => 0), nth: vi.fn(() => empty), isVisible: vi.fn(async () => false), locator: vi.fn(() => empty), getByRole: vi.fn(() => empty), getByText: vi.fn(() => empty) } as unknown as Locator;
  const trigger = { count: vi.fn(async () => 1), nth: vi.fn(() => trigger), isVisible: vi.fn(async () => true), click: vi.fn(async () => undefined), getAttribute: vi.fn(async (name: string) => name === 'role' ? descriptor.role : name === 'aria-label' ? descriptor.ariaLabel ?? '' : name === 'title' ? descriptor.title ?? '' : ''), evaluate: vi.fn(async () => descriptor.tag), innerText: vi.fn(async () => descriptor.text ?? ''), textContent: vi.fn(async () => descriptor.text ?? '') } as unknown as Locator;
  const mainScope = { count: vi.fn(async () => 1), nth: vi.fn(() => mainScope), isVisible: vi.fn(async () => true), locator: vi.fn((selector: string) => selector === 'button, [role="button"], [tabindex="0"]' || selector === 'button' || selector === '[role="button"]' || selector === '[tabindex="0"]' ? trigger : empty) } as unknown as Locator;
  const page = { getByRole: vi.fn(() => trigger), locator: vi.fn((selector: string) => selector === 'main' || selector === '[role="main"]' ? mainScope : selector === 'body' ? mainScope : ({ filter: vi.fn(() => empty), count: vi.fn(async () => 0), nth: vi.fn(() => empty), isVisible: vi.fn(async () => false) })), keyboard: { insertText: vi.fn(async (value: string) => { state.insertCount += 1; if (state.fallbackUpdates) state.text = value; state.enabled = state.fallbackEnables; }), press: vi.fn(async () => undefined) } } as unknown as Page;
  let hydrationReads = 0;
  const textbox = {
    count: vi.fn(async () => 1),
    nth: vi.fn(() => textbox),
    isVisible: vi.fn(async () => true),
    fill: vi.fn(async (value: string) => { state.fillCount += 1; if (state.fillUpdates) state.text = value; state.enabled = state.fillEnables; }),
    getAttribute: vi.fn(async (name: string) => name === 'contenteditable' ? 'true' : name === 'role' ? 'textbox' : name === 'aria-multiline' ? 'true' : name === 'data-lexical-editor' ? 'true' : null),
    evaluate: vi.fn(async () => 'DIV'),
    innerText: vi.fn(async () => state.text),
    textContent: vi.fn(async () => state.text),
    focus: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    page: vi.fn(() => page)
  } as unknown as Locator;
  const container = {
    getByRole: vi.fn((role: string, options?: { name?: unknown }) => role === 'heading' ? dialogTitle : role === 'textbox' && options?.name === undefined ? textbox : String(options?.name ?? '').toLowerCase().includes('post') ? post : empty),
    locator: vi.fn((selector: string) => selector.includes('input[type="file"]') ? empty : selector.includes('contenteditable') ? (++hydrationReads > hydrationCycles ? textbox : empty) : { filter: vi.fn(() => empty) }),
    getByText: vi.fn(() => empty),
    isVisible: vi.fn(async () => true),
    evaluate: vi.fn(async () => true)
  } as unknown as Locator;
  return { page, textbox, container, post };
}

function resolverPage(descriptors: TriggerDescriptor[]): Page {
  const locators = descriptors.map((descriptor) => ({
    count: vi.fn(async () => 1), nth: vi.fn(() => locators[descriptors.indexOf(descriptor)]), isVisible: vi.fn(async () => true),
    getAttribute: vi.fn(async (name: string) => name === 'role' ? descriptor.role : name === 'aria-label' ? descriptor.ariaLabel ?? '' : name === 'title' ? descriptor.title ?? '' : ''),
    evaluate: vi.fn(async () => descriptor.tag), innerText: vi.fn(async () => descriptor.text ?? ''), textContent: vi.fn(async () => descriptor.text ?? '')
  } as unknown as Locator));
  const collection = { count: vi.fn(async () => locators.length), nth: vi.fn((index: number) => locators[index]) } as unknown as Locator;
  const scope = { count: vi.fn(async () => 1), nth: vi.fn(() => scope), isVisible: vi.fn(async () => true), locator: vi.fn(() => collection) } as unknown as Locator;
  return { locator: vi.fn((selector: string) => selector === 'main' || selector === '[role="main"]' || selector === 'body' ? scope : collection) } as unknown as Page;
}

type TextboxDescriptor = { tag: string; role?: string; contenteditable?: string; ariaLabel?: string; placeholder?: string; ariaMultiline?: string; lexicalEditor?: string; type?: string };
function textboxScope(descriptors: TextboxDescriptor[]): Locator {
  const locators = descriptors.map((descriptor) => ({
    count: vi.fn(async () => 1), nth: vi.fn(() => locators[descriptors.indexOf(descriptor)]), isVisible: vi.fn(async () => true),
    getAttribute: vi.fn(async (name: string) => ({ role: descriptor.role, contenteditable: descriptor.contenteditable, 'aria-label': descriptor.ariaLabel, placeholder: descriptor.placeholder, 'aria-multiline': descriptor.ariaMultiline, 'data-lexical-editor': descriptor.lexicalEditor, type: descriptor.type }[name] ?? '')),
    evaluate: vi.fn(async () => descriptor.tag)
  } as unknown as Locator));
  const collection = { count: vi.fn(async () => locators.length), nth: vi.fn((index: number) => locators[index]) } as unknown as Locator;
  return { locator: vi.fn(() => collection) } as unknown as Locator;
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

function actualAdapterFor(fake: ReturnType<typeof fakeComposer>): FacebookComposerAdapter {
  let opened = false;
  const page = fake.page as Page & { locator: ReturnType<typeof vi.fn>; getByRole: ReturnType<typeof vi.fn> };
  const trigger = page.getByRole();
  trigger.click.mockImplementation(async () => { opened = true; });
  const dialog = { count: vi.fn(async () => opened ? 1 : 0), nth: vi.fn(() => fake.container), isVisible: vi.fn(async () => opened) } as unknown as Locator;
  const originalLocator = page.locator;
  page.locator = vi.fn((selector: string) => selector === '[role="dialog"]' ? dialog : selector === 'form' ? { count: vi.fn(async () => 0), nth: vi.fn(() => dialog), isVisible: vi.fn(async () => false) } : originalLocator(selector)) as unknown as typeof page.locator;
  const adapter = new FacebookComposerAdapter();
  vi.spyOn(adapter, 'openGroup').mockResolvedValue(undefined);
  (adapter as unknown as { dismissComposer: () => Promise<undefined> }).dismissComposer = vi.fn(async () => undefined);
  return adapter;
}

describe('FacebookComposerAdapter content handling', () => {
  it('uses the versioned selector set', () => {
    expect(FACEBOOK_SELECTORS_VERSION).toBe('2026-08-v4');
  });

  it('resolves the live Vietnamese trigger variant through the central resolver', async () => {
    const adapter = new FacebookComposerAdapter();
    expect(facebookText.composerTrigger.test('Bạn viết gì đi...')).toBe(true);
    const result = await adapter.findComposerTrigger(resolverPage([{ role: 'button', tag: 'DIV', text: 'Bạn viết gì đi...' }]));
    expect(result).toMatchObject({ status: 'FOUND', count: 1, strategy: 'VISIBLE_TEXT_INTERACTIVE_ANCESTOR' });
  });

  it('resolves an aria-label-only trigger without broad feed matching', async () => {
    const adapter = new FacebookComposerAdapter();
    const result = await adapter.findComposerTrigger(resolverPage([{ role: 'button', tag: 'DIV', ariaLabel: 'Tạo bài viết' }]));
    expect(result).toMatchObject({ status: 'FOUND', count: 1, strategy: 'ROLE_ACCESSIBLE_NAME' });
  });

  it('rejects multiple genuine triggers as ambiguous without clicking', async () => {
    const adapter = new FacebookComposerAdapter();
    const result = await adapter.findComposerTrigger(resolverPage([{ role: 'button', tag: 'DIV', text: 'Bạn viết gì đi...' }, { role: 'button', tag: 'DIV', text: 'Tạo bài viết' }]));
    expect(result).toMatchObject({ status: 'AMBIGUOUS', count: 2 });
  });

  it('does not treat generic post actions as composer triggers', async () => {
    const adapter = new FacebookComposerAdapter();
    const result = await adapter.findComposerTrigger(resolverPage([{ role: 'button', tag: 'BUTTON', text: 'Đăng' }, { role: 'button', tag: 'BUTTON', text: 'Chia sẻ' }]));
    expect(result).toMatchObject({ status: 'MISSING', count: 0 });
  });

  it('resolves Lexical and unnamed role=textbox editors centrally', async () => {
    const adapter = new FacebookComposerAdapter();
    await expect(adapter.findComposerTextbox(textboxScope([{ tag: 'DIV', role: 'textbox', contenteditable: 'true', ariaMultiline: 'true', lexicalEditor: 'true' }]))).resolves.toMatchObject({ status: 'FOUND', strategy: 'LEXICAL_EDITOR', count: 1 });
    await expect(adapter.findComposerTextbox(textboxScope([{ tag: 'DIV', role: 'textbox', contenteditable: 'true' }]))).resolves.toMatchObject({ status: 'FOUND', strategy: 'ROLE_TEXTBOX', count: 1 });
  });

  it('preserves named textbox priority and excludes utility search fields', async () => {
    const adapter = new FacebookComposerAdapter();
    await expect(adapter.findComposerTextbox(textboxScope([{ tag: 'DIV', role: 'textbox', contenteditable: 'true', ariaLabel: "What's on your mind" }]))).resolves.toMatchObject({ status: 'FOUND', strategy: 'NAMED_ROLE' });
    const utility = await adapter.findComposerTextbox(textboxScope([{ tag: 'INPUT', role: 'searchbox', type: 'search', placeholder: 'Search' }]));
    expect(utility).toMatchObject({ status: 'MISSING', count: 0 });
    expect(utility.safeCandidates[0]).toMatchObject({ role: 'searchbox', visible: true });
  });

  it('rejects ambiguous valid editors without selecting the first', async () => {
    const adapter = new FacebookComposerAdapter();
    const result = await adapter.findComposerTextbox(textboxScope([{ tag: 'DIV', role: 'textbox', contenteditable: 'true' }, { tag: 'DIV', role: 'textbox', contenteditable: 'true' }]));
    expect(result).toMatchObject({ status: 'AMBIGUOUS', count: 2 });
  });

  it('runs preflight through one resolved trigger, composer, textbox, and content path', async () => {
    const state: FakeState = { text: '', fillCount: 0, insertCount: 0, fillEnables: true, fillUpdates: true, fallbackEnables: true, fallbackUpdates: true, enabled: false };
    const fake = fakeComposer(state); const adapter = actualAdapterFor(fake);
    const result = await adapter.preflight(fake.page, queueItem('Resolver integration'), true);
    expect(result.probe.status).toBe('FOUND');
    expect(result.probe.triggerStrategy).toBe('ROLE_ACCESSIBLE_NAME');
    expect(result.probe.contentObserved).toBe(true);
    expect(state.fillCount).toBe(1);
    expect(fake.post.click).not.toHaveBeenCalled();
  });

  it('waits through dialog hydration before resolving the editor', async () => {
    const state: FakeState = { text: '', fillCount: 0, insertCount: 0, fillEnables: true, fillUpdates: true, fallbackEnables: true, fallbackUpdates: true, enabled: false };
    const fake = fakeComposer(state, undefined, 18); const adapter = actualAdapterFor(fake);
    const result = await adapter.preflight(fake.page, queueItem('Hydration race'), true);
    expect(result.probe.status).toBe('FOUND');
    expect(result.probe.textboxStrategy).toBe('CREATE_POST_LEXICAL');
    expect(result.probe.reason).toBeUndefined();
    expect(fake.post.click).not.toHaveBeenCalled();
  });

  it('times out safely when no editor hydrates and retains bounded candidate diagnostics', async () => {
    const state: FakeState = { text: '', fillCount: 0, insertCount: 0, fillEnables: true, fillUpdates: true, fallbackEnables: true, fallbackUpdates: true, enabled: false };
    const fake = fakeComposer(state, undefined, 1000); const utility = textboxScope([{ tag: 'INPUT', role: 'searchbox', type: 'search', placeholder: 'Search people' }]);
    fake.container.locator = vi.fn((selector: string) => selector.includes('contenteditable') ? utility.locator('[role="textbox"]') : { filter: vi.fn(() => ({ count: vi.fn(async () => 0), nth: vi.fn(), isVisible: vi.fn(async () => false) })) }) as unknown as typeof fake.container.locator;
    const adapter = actualAdapterFor(fake);
    await fake.page.getByRole('button').click();
    const ready = await (adapter as unknown as { waitForComposerReady: (page: Page, baseline: { handles: []; capturedAt: string }, timeoutMs: number) => Promise<{ status: string; reason: string; safeCandidates: unknown[] }> }).waitForComposerReady(fake.page, { handles: [], capturedAt: '' }, 1000);
    expect(ready).toMatchObject({ status: 'MISSING', reason: 'COMPOSER_TEXTBOX_NOT_FOUND' });
    expect(ready.safeCandidates.length).toBeGreaterThan(0);
  }, 10000);

  it('captures early diagnostics when the trigger is missing', async () => {
    const adapter = new FacebookComposerAdapter(); vi.spyOn(adapter, 'openGroup').mockResolvedValue(undefined);
    const capture = vi.fn(async () => 'C:\\managed\\diagnostics\\trigger.png');
    const result = await adapter.preflight(resolverPage([{ role: 'button', tag: 'BUTTON', text: 'Đăng' }, { role: 'button', tag: 'BUTTON', ariaLabel: 'Chia sẻ' }]), queueItem('Trigger diagnostic'), false, capture);
    expect(result.probe).toMatchObject({ status: 'MISSING', reason: 'COMPOSER_TRIGGER_NOT_FOUND', diagnosticPath: expect.stringContaining('trigger.png') });
    expect(result.probe.triggerCandidates).toHaveLength(2);
    expect(capture).toHaveBeenCalledWith(expect.anything(), 'MISSING');
  });

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

describe('Facebook Create Post dialog scoping with local DOM fixtures', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;

  function localChromiumExecutable(): string | undefined {
    const root = join(process.cwd(), 'node_modules', 'playwright-core', '.local-browsers');
    const version = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.startsWith('chromium-') && (existsSync(join(root, entry.name, 'chrome-win64', 'chrome.exe')) || existsSync(join(root, entry.name, 'chrome-win', 'chrome.exe'))));
    if (!version) return undefined;
    const folder = existsSync(join(root, version.name, 'chrome-win64', 'chrome.exe')) ? 'chrome-win64' : 'chrome-win';
    return join(root, version.name, folder, 'chrome.exe');
  }

  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: localChromiumExecutable() }); });
  afterAll(async () => { await browser?.close(); });

  async function fixture(markup: string): Promise<{ page: Page; close: () => Promise<void> }> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(`<main>${markup}</main>`);
    return { page, close: () => page.close() };
  }

  function adapterForPage(adapter: FacebookComposerAdapter): void {
    vi.spyOn(adapter, 'openGroup').mockResolvedValue(undefined);
  }

  it('deduplicates one DOM node matched by Lexical, role, and contenteditable selectors', async () => {
    const { page, close } = await fixture('<div id="dialog" role="dialog" style="position:fixed;left:100px;top:100px;width:600px;height:400px;background:white"><h2>Create post</h2><div id="editor" role="textbox" contenteditable="true" data-lexical-editor="true" aria-label="Viết bình luận công khai..."></div></div>');
    try {
      const result = await new FacebookComposerAdapter().findComposerTextbox(page.locator('[role="dialog"]'), { createPostScope: true });
      expect(result).toMatchObject({ status: 'FOUND', rawCount: 3, logicalCount: 1, strategy: 'CREATE_POST_LEXICAL' });
    } finally { await close(); }
  });

  it('collapses nested editor wrappers and selects the focusable inner surface', async () => {
    const { page, close } = await fixture('<div role="dialog" style="position:fixed;left:100px;top:100px;width:600px;height:400px;background:white"><h2>Create post</h2><div id="outer" contenteditable="true" data-lexical-editor="true" style="width:500px;height:100px"><div id="inner" role="textbox" contenteditable="true" data-lexical-editor="true" tabindex="0" style="width:500px;height:100px"></div></div></div>');
    try {
      const adapter = new FacebookComposerAdapter();
      const result = await adapter.findComposerTextbox(page.locator('[role="dialog"]'), { createPostScope: true });
      expect(result).toMatchObject({ status: 'FOUND', logicalCount: 1, strategy: 'CREATE_POST_LEXICAL' });
      await expect(result.locator!.getAttribute('id')).resolves.toBe('inner');
    } finally { await close(); }
  });

  it('accepts the real misleading Vietnamese aria-label inside the Create Post dialog', async () => {
    const { page, close } = await fixture('<div role="dialog" style="position:fixed;left:100px;top:100px;width:600px;height:400px;background:white"><h2>Tạo bài viết</h2><div role="textbox" contenteditable="true" data-lexical-editor="true" aria-label="Viết bình luận công khai..."></div></div>');
    try {
      const adapter = new FacebookComposerAdapter();
      const baseline = await adapter.findCreatePostDialog(page);
      expect(baseline).toMatchObject({ status: 'FOUND', title: 'Tạo bài viết', count: 1 });
      const result = await adapter.findComposerTextbox(baseline.locator!, { createPostScope: true });
      expect(result).toMatchObject({ status: 'FOUND', strategy: 'CREATE_POST_LEXICAL', logicalCount: 1 });
    } finally { await close(); }
  });

  it('uses an exact fallback title and ignores hidden unrelated dialogs', async () => {
    const { page, close } = await fixture('<div role="dialog" style="display:none"><h2>Create post</h2><div role="textbox" contenteditable="true" data-lexical-editor="true"></div></div><div role="dialog" style="position:fixed;left:100px;top:100px;width:600px;height:400px;background:white"><div>Tạo bài viết</div><div role="textbox" contenteditable="true" data-lexical-editor="true"></div></div>');
    try {
      const result = await new FacebookComposerAdapter().findCreatePostDialog(page);
      expect(result).toMatchObject({ status: 'FOUND', count: 1, title: 'Tạo bài viết' });
    } finally { await close(); }
  });

  it('ignores feed comment editors with the same aria-label outside the selected dialog', async () => {
    const { page, close } = await fixture('<article><div role="textbox" contenteditable="true" aria-label="Viết bình luận công khai..."></div><div role="textbox" contenteditable="true" aria-label="Viết bình luận công khai..."></div></article><div role="dialog" style="position:fixed;left:100px;top:100px;width:600px;height:400px;background:white"><h2>Tạo bài viết</h2><div id="post-editor" role="textbox" contenteditable="true" data-lexical-editor="true" aria-label="Viết bình luận công khai..."></div></div>');
    try {
      const adapter = new FacebookComposerAdapter();
      const dialog = await adapter.findCreatePostDialog(page);
      const result = await adapter.findComposerTextbox(dialog.locator!, { createPostScope: true });
      expect(result).toMatchObject({ status: 'FOUND', logicalCount: 1 });
      await expect(result.locator!.getAttribute('id')).resolves.toBe('post-editor');
    } finally { await close(); }
  });

  it('uses the post-trigger dialog baseline and waits for delayed editor hydration', async () => {
    const { page, close } = await fixture('<button id="trigger" aria-label="Create post">Create post</button><script>document.getElementById("trigger").onclick=()=>{const d=document.createElement("div");d.setAttribute("role","dialog");d.style.cssText="position:fixed;left:100px;top:100px;width:600px;height:400px;background:white";d.innerHTML="<h2>Create post</h2>";document.body.append(d);setTimeout(()=>{d.insertAdjacentHTML("beforeend",`<div id="hydrated" role="textbox" contenteditable="true" data-lexical-editor="true"></div><button aria-label="Close">Close</button>`);},150);};</script>');
    try {
      const adapter = new FacebookComposerAdapter();
      adapterForPage(adapter);
      const handle = await adapter.openComposer(page);
      expect(handle.dialogTitle).toBe('Create post');
      expect(handle.dialogCandidates?.[0]).toMatchObject({ newAfterTrigger: true, visible: true, foreground: true });
      expect(handle.textboxStrategy).toBe('CREATE_POST_LEXICAL');
    } finally { await close(); }
  });

  it('runs the complete scoped preflight and never clicks Post', async () => {
    const { page, close } = await fixture('<button id="trigger" aria-label="Create post">Create post</button>');
    await page.evaluate(() => {
      document.body.dataset.postClicks = '0';
      document.getElementById('trigger')?.addEventListener('click', () => {
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.style.cssText = 'position:fixed;left:100px;top:100px;width:600px;height:400px;background:white';
        dialog.innerHTML = '<h2>Tạo bài viết</h2><div id="editor" role="textbox" contenteditable="true" data-lexical-editor="true" aria-label="Viết bình luận công khai..."></div><button id="post" disabled>Post</button><button id="close" aria-label="Close">Close</button>';
        const editor = dialog.querySelector('#editor') as HTMLElement; const post = dialog.querySelector('#post') as HTMLButtonElement;
        editor.addEventListener('input', () => { post.disabled = !editor.innerText.trim(); });
        post.addEventListener('click', () => { document.body.dataset.postClicks = String(Number(document.body.dataset.postClicks ?? '0') + 1); });
        dialog.querySelector('#close')?.addEventListener('click', () => dialog.remove()); document.body.append(dialog);
      });
    });
    try {
      const adapter = new FacebookComposerAdapter();
      adapterForPage(adapter);
      const result = await adapter.preflight(page, queueItem('Scoped preflight content'), true);
      expect(result.probe).toMatchObject({ status: 'FOUND', selectorVersion: '2026-08-v4', createPostDialog: { status: 'FOUND' }, dialogTitle: 'Tạo bài viết', textboxStrategy: 'CREATE_POST_LEXICAL', contentObserved: true, postButton: { status: 'FOUND', enabled: true } });
      await expect(page.locator('body').getAttribute('data-post-clicks')).resolves.toBe('0');
    } finally { await close(); }
  });

  it('returns container ambiguity for two independent ready Create Post dialogs', async () => {
    const { page, close } = await fixture('<button id="trigger" aria-label="Create post">Create post</button>');
    await page.evaluate(() => {
      document.getElementById('trigger')?.addEventListener('click', () => {
        for (let index = 0; index < 2; index += 1) {
          const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.style.cssText = `position:fixed;left:${100 + index * 600}px;top:100px;width:500px;height:300px;background:white`;
          dialog.innerHTML = '<h2>Create post</h2><div role="textbox" contenteditable="true" data-lexical-editor="true"></div><button aria-label="Post">Post</button>'; document.body.append(dialog);
        }
      });
    });
    try {
      const adapter = new FacebookComposerAdapter();
      adapterForPage(adapter);
      await expect(adapter.openComposer(page)).rejects.toMatchObject({ code: 'COMPOSER_CONTAINER_AMBIGUOUS' });
    } finally { await close(); }
  }, 10000);
  it('selects the only focusable editor when another distinct editor is disabled', async () => {
    const { page, close } = await fixture('<div role="dialog" style="position:fixed;left:100px;top:100px;width:600px;height:400px;background:white"><h2>Create post</h2><textarea disabled></textarea><div id="active" role="textbox" contenteditable="true" data-lexical-editor="true" tabindex="0" style="margin-top:20px;width:500px;height:100px"></div></div>');
    try {
      const result = await new FacebookComposerAdapter().findComposerTextbox(page.locator('[role="dialog"]'), { createPostScope: true });
      expect(result).toMatchObject({ status: 'FOUND', logicalCount: 2 });
      await expect(result.locator!.getAttribute('id')).resolves.toBe('active');
    } finally { await close(); }
  });
});
