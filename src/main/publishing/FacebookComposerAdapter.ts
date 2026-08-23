import type { ElementHandle, Locator, Page } from 'playwright';
import { SessionHealthService } from '@main/browser/SessionHealthService';
import { normalizeFacebookGroupUrl } from '@shared/groupUrl';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { ComposerEditorType, ComposerEntryMethod, DialogCandidateSummary, SelectorProbeField, SelectorProbeResult, TextboxCandidateSummary, TriggerCandidateSummary } from '@shared/types';
import { PublishingError } from './PublishingError';
import { FACEBOOK_SELECTORS_VERSION, facebookText } from './selectors/facebookSelectors';

export type PostCandidate = { url: string; canonicalUrl: string; container?: Locator; visibleText?: string; groupIdentifier?: string };
export type SubmissionEvidence = { result: 'SUBMITTED' | 'SUBMITTED_PENDING_APPROVAL' | 'VERIFIED_PUBLISHED' | 'UNKNOWN'; evidence: string; postUrl?: string };
export type PostSubmitObservationMilestone = 'POST_CLICKED' | 'POST_OBSERVATION_STARTED' | 'POST_OBSERVATION_MINIMUM_REACHED' | 'COMPOSER_CLOSED' | 'PENDING_APPROVAL_DETECTED' | 'ACCEPTANCE_DETECTED' | 'NEW_POST_CANDIDATE' | 'POST_CORRELATED' | 'POST_CORRELATION';
export type ComposerHandle = { container: Locator; textbox: Locator; textboxStrategy?: string; textboxCandidates?: TextboxCandidateSummary[]; dialogTitle?: string; dialogCandidates?: DialogCandidateSummary[]; rawEditorCount?: number; logicalEditorCount?: number };
export type SubmissionBaseline = { urls: string[]; bodyFingerprint: string; candidates?: PostCandidate[] };
export type ComposerContentEntry = { method: ComposerEntryMethod; editorType: ComposerEditorType; visibleContentPresent: boolean; contentLength: number; expectedLength: number };
export type PreflightDiagnosticCapture = (page: Page, status: SelectorProbeResult['status']) => Promise<string | undefined>;
export type ComposerTriggerResolution = { status: 'FOUND' | 'MISSING' | 'AMBIGUOUS'; locator?: Locator; strategy?: string; count: number; safeCandidates: TriggerCandidateSummary[] };
export type ComposerTextboxResolution = { status: 'FOUND' | 'MISSING' | 'AMBIGUOUS'; locator?: Locator; strategy?: string; count: number; rawCount?: number; logicalCount?: number; safeCandidates: TextboxCandidateSummary[] };
export type ComposerDialogBaseline = { handles: Array<{ handle: ElementHandle<HTMLElement>; title?: string }>; capturedAt: string };
export type CreatePostDialogCandidate = { locator: Locator; summary: DialogCandidateSummary; title?: string; handle?: ElementHandle<HTMLElement> };
export type CreatePostDialogResolution = { status: 'FOUND' | 'MISSING' | 'AMBIGUOUS'; locator?: Locator; title?: string; count: number; candidates: CreatePostDialogCandidate[]; safeCandidates: DialogCandidateSummary[] };
type ComposerReadyResult = { status: 'FOUND' | 'MISSING' | 'AMBIGUOUS'; reason: 'COMPOSER_CONTAINER_NOT_FOUND' | 'COMPOSER_CONTAINER_AMBIGUOUS' | 'COMPOSER_TEXTBOX_NOT_FOUND' | 'COMPOSER_TEXTBOX_AMBIGUOUS'; message: string; container?: Locator; textbox?: Locator; strategy?: string; dialogTitle?: string; dialogCandidates: DialogCandidateSummary[]; rawEditorCount?: number; logicalEditorCount?: number; safeCandidates: TextboxCandidateSummary[] };

class ComposerReadinessError extends PublishingError {
  constructor(code: 'COMPOSER_CONTAINER_NOT_FOUND' | 'COMPOSER_CONTAINER_AMBIGUOUS' | 'COMPOSER_TEXTBOX_NOT_FOUND' | 'COMPOSER_TEXTBOX_AMBIGUOUS', message: string, public readonly textboxCandidates: TextboxCandidateSummary[], public readonly dialogCandidates: DialogCandidateSummary[] = [], public readonly dialogTitle?: string, public readonly rawEditorCount?: number, public readonly logicalEditorCount?: number) { super(code, message); }
}

type TextboxMetadata = { tag: string; role: string; contenteditable: string; ariaLabel: string; placeholder: string; ariaMultiline: string; lexicalEditor: string; type: string; visible: boolean; focusable: boolean; boundingBox?: { x: number; y: number; width: number; height: number } };
type RawEditorCandidate = { locator: Locator; metadata: TextboxMetadata; handle?: ElementHandle<HTMLElement>; strategy: string; identity: unknown; depth: number };
type LogicalEditorGroup = { id: number; candidates: RawEditorCandidate[]; selected?: RawEditorCandidate };

const COMPOSER_TRIGGER_PHRASES = [
  'write something', 'create post', 'what s on your mind', 'create a public post',
  'viet gi do', 'viet gi di', 'ban dang nghi gi', 'ban viet gi di',
  'ban muon chia se gi', 'chia se gi do', 'tao bai viet', 'tao bai viet cong khai'
];

const EMPTY_FIELD: SelectorProbeField = { status: 'NOT_TESTED' };
export const POST_SUBMIT_MIN_OBSERVATION_MS = 5000;
const POST_SUBMIT_POLL_MS = 250;

/** Canonical identity for a Facebook post candidate. Tracking parameters and fragments
 * are deliberately discarded so an existing post cannot look newly published. */
export function normalizePostCandidateUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'facebook.com' && hostname !== 'www.facebook.com') return undefined;
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return undefined;
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    const storyId = url.searchParams.get('story_fbid');
    const supportedPath = /(?:^|\/)posts\/[^/]+|(?:^|\/)permalink(?:\.php)?|(?:^|\/)story_fbid(?:\/|$)/i.test(path);
    if (!supportedPath && !storyId) return undefined;
    return 'https://www.facebook.com' + path + (!supportedPath && storyId ? '?story_fbid=' + encodeURIComponent(storyId) : '');
  } catch { return undefined; }
}

export const canonicalizePostUrl = normalizePostCandidateUrl;

function candidateGroupIdentifier(value: string): string | undefined {
  try {
    const path = new URL(value).pathname;
    const match = path.match(/\/groups\/([^/]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]).toLowerCase() : undefined;
  } catch { return undefined; }
}

function isTargetGroupCandidate(candidate: PostCandidate | string, groupUrl: string): boolean {
  try {
    const target = normalizeFacebookGroupUrl(groupUrl).identifier.toLowerCase();
    const value = typeof candidate === 'string' ? candidate : candidate.url;
    const identifier = candidateGroupIdentifier(value);
    return Boolean(identifier && identifier === target);
  } catch { return false; }
}

/** URL-only compatibility helper retained for callers and tests. */
export function correlateNewPostUrl(after: string[], before: string[], groupUrl: string): string | undefined {
  const seen = new Set(before.map(normalizePostCandidateUrl).filter((value): value is string => Boolean(value)));
  return after.find((href) => {
    const canonical = normalizePostCandidateUrl(href);
    return Boolean(canonical && !seen.has(canonical) && isTargetGroupCandidate(href, groupUrl));
  });
}

export function candidateContentMatches(candidateText: string | undefined, submittedBody: string): boolean {
  const candidate = normalizeVisibleText(candidateText ?? '');
  const excerpt = meaningfulExcerpt(submittedBody);
  if (!candidate || !excerpt) return false;
  return candidate.includes(excerpt) || (excerpt.length >= 40 && candidate.includes(excerpt.slice(0, 40)));
}

function normalizeVisibleText(value: string): string { return value.toLocaleLowerCase().replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim(); }
function meaningfulExcerpt(value: string): string {
  const normalized = normalizeVisibleText(value);
  return normalized.length <= 100 ? normalized : normalized.slice(0, 80).trim();
}

export async function waitForEnabled(locator: Pick<Locator, 'isVisible' | 'isEnabled'>, timeoutMs = 4000, pollMs = 50): Promise<boolean> {
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 5000);
  while (Date.now() < deadline) {
    if (await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(pollMs, 10), 100)));
  }
  return await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false);
}

function normalizeComposerText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
}

function contentMatches(observed: string, expected: string): boolean {
  const normalizedExpected = normalizeComposerText(expected);
  if (!normalizedExpected) return true;
  const normalizedObserved = normalizeComposerText(observed);
  return Boolean(normalizedObserved && normalizedObserved === normalizedExpected);
}

export async function probePostButton(candidates: Locator[], contentFilled = true, timeoutMs = 4000): Promise<SelectorProbeField> {
  if (candidates.length > 1) return { status: 'AMBIGUOUS', count: candidates.length, reason: 'Multiple composer-scoped Post buttons were found.' };
  const button = candidates[0];
  if (!button) return { status: 'MISSING', count: 0, reason: 'No unique composer-scoped Post button was found.' };
  const visible = await button.isVisible().catch(() => false);
  if (!contentFilled) return visible ? { status: 'FOUND', count: 1, enabled: await button.isEnabled().catch(() => false) } : { status: 'MISSING', count: 1, enabled: false, reason: 'Post button is not visible.' };
  const enabled = visible && await waitForEnabled(button, timeoutMs);
  return enabled ? { status: 'FOUND', count: 1, enabled: true } : { status: 'MISSING', count: 1, enabled: false, reason: 'Post button was found but remained disabled after verified composer content.' };
}

export function hasPublishableContent(item: Pick<QueueRecord, 'body' | 'linkUrl' | 'media'>): boolean {
  return Boolean(item.body.trim() || item.linkUrl?.trim() || item.media.length);
}

export class FacebookComposerAdapter {
  readonly selectorsVersion = FACEBOOK_SELECTORS_VERSION;
  private readonly health = new SessionHealthService();

  async openGroup(page: Page, url: string): Promise<void> {
    const canonical = normalizeFacebookGroupUrl(url).normalizedUrl;
    try { await page.goto(canonical, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
    catch { throw new PublishingError('NETWORK_ERROR', 'Facebook group navigation failed.'); }
    const state = await this.health.classify(page);
    if (state.status === 'LOGIN_REQUIRED') throw new PublishingError('ACCOUNT_LOGIN_REQUIRED', 'Facebook login is required.');
    if (state.status === 'CHECKPOINT') throw new PublishingError('ACCOUNT_CHECKPOINT', 'Manual user action required.');
    if (state.status === 'ERROR') throw new PublishingError('GROUP_UNAVAILABLE', state.reason ?? 'Facebook page state could not be determined safely.');
    const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (facebookText.permissionDenied.test(body)) throw new PublishingError('GROUP_PERMISSION_DENIED', 'The account cannot post to this group.');
  }

  async findComposerTrigger(page: Page): Promise<ComposerTriggerResolution> {
    const scopes = await this.triggerScopes(page);
    const matches: Array<{ locator: Locator; strategy: string; summary: TriggerCandidateSummary }> = [];
    const safeCandidates: TriggerCandidateSummary[] = [];
    for (const scope of scopes) {
      const namedCandidates = typeof scope.getByRole === 'function' ? await this.visibleCandidates([scope.getByRole('button', { name: facebookText.composerTrigger })]) : [];
      if (namedCandidates.length > 1) {
        const summaries: TriggerCandidateSummary[] = [];
        for (const candidate of namedCandidates.slice(0, 20)) summaries.push({ ...this.toTriggerSummary(await this.triggerMetadata(candidate)), strategy: 'ROLE_ACCESSIBLE_NAME' });
        return { status: 'AMBIGUOUS', count: namedCandidates.length, safeCandidates: summaries };
      }
      if (namedCandidates.length === 1) {
        const summary = { ...this.toTriggerSummary(await this.triggerMetadata(namedCandidates[0])), strategy: 'ROLE_ACCESSIBLE_NAME' };
        return { status: 'FOUND', locator: namedCandidates[0], strategy: 'ROLE_ACCESSIBLE_NAME', count: 1, safeCandidates: [summary] };
      }
      const candidates = await this.interactiveCandidates(scope);
      for (const candidate of candidates) {
        const metadata = await this.triggerMetadata(candidate);
        if (!metadata.visible) continue;
        const summary = this.toTriggerSummary(metadata);
        if (this.isPotentialTriggerDiagnostic(metadata)) safeCandidates.push(summary);
        const strategy = this.triggerStrategy(metadata);
        if (strategy) matches.push({ locator: candidate, strategy, summary: { ...summary, strategy } });
      }
    }
    const boundedCandidates = safeCandidates.slice(0, 20);
    if (matches.length > 1) return { status: 'AMBIGUOUS', count: matches.length, safeCandidates: matches.slice(0, 20).map((match) => match.summary) };
    const match = matches[0];
    if (match) return { status: 'FOUND', locator: match.locator, strategy: match.strategy, count: 1, safeCandidates: [match.summary] };
    return { status: 'MISSING', count: 0, safeCandidates: boundedCandidates };
  }

  async openComposer(page: Page, triggerResolution?: ComposerTriggerResolution): Promise<ComposerHandle> {
    const resolution = triggerResolution ?? await this.findComposerTrigger(page);
    if (resolution.status === 'AMBIGUOUS') throw new PublishingError('COMPOSER_TRIGGER_AMBIGUOUS', 'Multiple Facebook composer triggers were found.');
    if (resolution.status !== 'FOUND' || !resolution.locator) throw new PublishingError('COMPOSER_TRIGGER_NOT_FOUND', 'Facebook group composer trigger was not found.');
    const baseline = await this.captureDialogBaseline(page);
    try {
      try { await resolution.locator.click(); } catch { throw new PublishingError('COMPOSER_TRIGGER_CLICK_FAILED', 'Facebook composer trigger could not be clicked.'); }
      const ready = await this.waitForComposerReady(page, baseline);
      if (ready.status !== 'FOUND' || !ready.container || !ready.textbox) throw new ComposerReadinessError(ready.reason, ready.message, ready.safeCandidates, ready.dialogCandidates, ready.dialogTitle, ready.rawEditorCount, ready.logicalEditorCount);
      return { container: ready.container, textbox: ready.textbox, textboxStrategy: ready.strategy, textboxCandidates: ready.safeCandidates, dialogTitle: ready.dialogTitle, dialogCandidates: ready.dialogCandidates, rawEditorCount: ready.rawEditorCount, logicalEditorCount: ready.logicalEditorCount };
    } finally {
      await Promise.all(baseline.handles.map(({ handle }) => handle.dispose().catch(() => undefined)));
    }
  }

  async findComposerTextbox(scope: Locator, options: { createPostScope?: boolean } = {}): Promise<ComposerTextboxResolution> {
    const rawCandidates: RawEditorCandidate[] = [];
    const utilityCandidates: TextboxCandidateSummary[] = [];
    const selectors: Array<{ selector: string; strategy: string }> = [
      { selector: '[data-lexical-editor="true"][contenteditable="true"]', strategy: options.createPostScope ? 'CREATE_POST_LEXICAL' : 'LEXICAL_EDITOR' },
      { selector: '[role="textbox"]', strategy: options.createPostScope ? 'CREATE_POST_ROLE_TEXTBOX' : 'ROLE_TEXTBOX' },
      { selector: '[contenteditable="true"]', strategy: options.createPostScope ? 'CREATE_POST_CONTENTEDITABLE' : 'ROLE_TEXTBOX' },
      { selector: '[aria-multiline="true"][contenteditable="true"]', strategy: options.createPostScope ? 'CREATE_POST_CONTENTEDITABLE' : 'MULTILINE_CONTENTEDITABLE' },
      { selector: 'textarea', strategy: options.createPostScope ? 'CREATE_POST_TEXTAREA' : 'TEXTAREA' },
      { selector: 'input', strategy: options.createPostScope ? 'CREATE_POST_INPUT' : 'INPUT_COMPOSER' }
    ];
    for (const { selector, strategy } of selectors) {
      const candidates = await this.boundedLocators(scope.locator(selector), 20);
      for (const candidate of candidates) {
        const metadata = await this.textboxMetadata(candidate);
        if (!metadata.visible) continue;
        if (this.isUtilityField(metadata)) { utilityCandidates.push(this.toTextboxSummary(metadata)); continue; }
        const handle = await this.elementHandle(candidate);
        const validStrategy = this.textboxStrategy(metadata, strategy, options.createPostScope === true);
        if (!validStrategy) continue;
        rawCandidates.push({ locator: candidate, metadata, handle, strategy: validStrategy, identity: handle ?? candidate, depth: await this.domDepth(candidate) });
      }
    }
    const groups = await this.groupEditorCandidates(rawCandidates);
    await Promise.all(rawCandidates.map(async (candidate) => { if (candidate.handle) await candidate.handle.dispose().catch(() => undefined); }));
    const safeCandidates = [...utilityCandidates, ...groups.flatMap((group) => group.candidates.map((candidate) => ({ ...this.toTextboxSummary(candidate.metadata), strategy: candidate.strategy, groupId: group.id })))];
    const selectedGroups = groups.map((group) => ({ group, selected: this.selectEditorSurface(group) }));
    const logicalCount = selectedGroups.length;
    const rawCount = rawCandidates.length;
    if (!logicalCount) return { status: 'MISSING', count: 0, rawCount, logicalCount, safeCandidates: safeCandidates.slice(0, 20) };
    if (logicalCount > 1) {
      const focusable = selectedGroups.filter(({ selected }) => selected?.metadata.focusable);
      if (focusable.length === 1) {
        const match = focusable[0].selected!;
        return { status: 'FOUND', locator: match.locator, strategy: match.strategy, count: 1, rawCount, logicalCount, safeCandidates: safeCandidates.slice(0, 20).map((candidate) => candidate.groupId === focusable[0].group.id ? { ...candidate, strategy: match.strategy } : candidate) };
      }
      return { status: 'AMBIGUOUS', count: logicalCount, rawCount, logicalCount, safeCandidates: safeCandidates.slice(0, 20) };
    }
    const selected = selectedGroups[0].selected;
    if (!selected) return { status: 'MISSING', count: 0, rawCount, logicalCount, safeCandidates: safeCandidates.slice(0, 20) };
    return { status: 'FOUND', locator: selected.locator, strategy: selected.strategy, count: 1, rawCount, logicalCount, safeCandidates: safeCandidates.slice(0, 20).map((candidate) => ({ ...candidate, strategy: selected.strategy })) };
  }

  private async waitForComposerReady(page: Page, baseline: ComposerDialogBaseline, timeoutMs = 7000): Promise<ComposerReadyResult> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 8000);
    let lastCandidates: TextboxCandidateSummary[] = [];
    let lastDialogs: DialogCandidateSummary[] = [];
    let rawEditorCount = 0;
    let logicalEditorCount = 0;
    let sawDialog = false;
    let ambiguousEditorCandidates: TextboxCandidateSummary[] = [];
    let lastTitle: string | undefined;
    while (true) {
      const dialogs = await this.findCreatePostDialog(page, baseline);
      const ready: Array<{ candidate: CreatePostDialogCandidate; resolution: ComposerTextboxResolution }> = [];
      sawDialog ||= dialogs.candidates.length > 0;
      lastDialogs = dialogs.safeCandidates;
      lastTitle = dialogs.candidates[0]?.title;
      for (const candidate of dialogs.candidates) {
        const resolution = await this.findComposerTextbox(candidate.locator, { createPostScope: true });
        lastCandidates = resolution.safeCandidates.slice(0, 20);
        rawEditorCount = Math.max(rawEditorCount, resolution.rawCount ?? 0);
        logicalEditorCount = Math.max(logicalEditorCount, resolution.logicalCount ?? 0);
        if (resolution.status === 'AMBIGUOUS') ambiguousEditorCandidates = resolution.safeCandidates;
        if (resolution.status === 'FOUND' && resolution.locator) ready.push({ candidate, resolution });
      }
      if (ready.length === 1) {
        const match = ready[0];
        return { status: 'FOUND', reason: 'COMPOSER_TEXTBOX_NOT_FOUND', message: '', container: match.candidate.locator, textbox: match.resolution.locator, strategy: match.resolution.strategy, dialogTitle: match.candidate.title, dialogCandidates: lastDialogs, rawEditorCount: match.resolution.rawCount, logicalEditorCount: match.resolution.logicalCount, safeCandidates: match.resolution.safeCandidates };
      }
      if (ready.length > 1) return { status: 'AMBIGUOUS', reason: 'COMPOSER_CONTAINER_AMBIGUOUS', message: 'Multiple independent Create Post dialogs contain ready editors.', dialogCandidates: lastDialogs, rawEditorCount, logicalEditorCount, safeCandidates: lastCandidates };
      if (ambiguousEditorCandidates.length) return { status: 'AMBIGUOUS', reason: 'COMPOSER_TEXTBOX_AMBIGUOUS', message: 'Multiple independent editors remain inside the Create Post dialog.', dialogCandidates: lastDialogs, rawEditorCount, logicalEditorCount, safeCandidates: ambiguousEditorCandidates };
      if (Date.now() >= deadline) {
        if (sawDialog) return { status: 'MISSING', reason: 'COMPOSER_TEXTBOX_NOT_FOUND', message: 'Create Post dialog appeared, but its editor did not hydrate in time.', dialogCandidates: lastDialogs, dialogTitle: lastTitle, rawEditorCount, logicalEditorCount, safeCandidates: lastCandidates };
        return { status: 'MISSING', reason: 'COMPOSER_CONTAINER_NOT_FOUND', message: 'Create Post dialog did not appear after the trigger was clicked.', dialogCandidates: lastDialogs, dialogTitle: lastTitle, rawEditorCount, logicalEditorCount, safeCandidates: lastCandidates };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async findCreatePostDialog(page: Page, baseline?: ComposerDialogBaseline): Promise<CreatePostDialogResolution> {
    const dialogs = await this.visibleLocators(page.locator('[role="dialog"]'), 20);
    const candidates: CreatePostDialogCandidate[] = [];
    for (const locator of dialogs) {
      const metadata = await this.dialogMetadata(locator, baseline);
      if (metadata.handle) await metadata.handle.dispose().catch(() => undefined);
      if (!metadata.title || !metadata.visible || !metadata.foreground) continue;
      candidates.push({ locator, title: metadata.title, summary: metadata.summary });
    }
    const safeCandidates = candidates.map((candidate) => candidate.summary);
    if (!candidates.length) return { status: 'MISSING', count: 0, candidates: [], safeCandidates };
    if (candidates.length > 1) return { status: 'AMBIGUOUS', count: candidates.length, candidates, safeCandidates };
    return { status: 'FOUND', locator: candidates[0].locator, title: candidates[0].title, count: 1, candidates, safeCandidates };
  }

  private async captureDialogBaseline(page: Page): Promise<ComposerDialogBaseline> {
    const handles: ComposerDialogBaseline['handles'] = [];
    const dialogs = await this.visibleLocators(page.locator('[role="dialog"]'), 20);
    for (const locator of dialogs) {
      const handle = await this.elementHandle(locator);
      if (!handle) continue;
      handles.push({ handle, title: await this.dialogTitle(locator) });
    }
    return { handles, capturedAt: new Date().toISOString() };
  }

  private async textboxMetadata(locator: Locator): Promise<TextboxMetadata> {
    const getAttribute = async (name: string): Promise<string> => typeof locator.getAttribute === 'function' ? await locator.getAttribute(name).catch(() => '') || '' : '';
    const tag = (typeof locator.evaluate === 'function' ? await locator.evaluate((node) => node.tagName).catch(() => '') : '').toLowerCase();
    const placeholder = await getAttribute('placeholder') || await getAttribute('aria-placeholder') || await getAttribute('data-placeholder');
    const visible = await locator.isVisible().catch(() => false);
    const boundingBox = typeof locator.boundingBox === 'function' ? await locator.boundingBox().catch(() => undefined) : undefined;
    let focusable = false;
    if (visible && typeof locator.focus === 'function') {
      await locator.focus().catch(() => undefined);
      focusable = typeof locator.evaluate === 'function' && await locator.evaluate((node) => document.activeElement === node).catch(() => false);
    }
    return { tag, role: (await getAttribute('role')).toLowerCase(), contenteditable: await getAttribute('contenteditable'), ariaLabel: await getAttribute('aria-label'), placeholder, ariaMultiline: await getAttribute('aria-multiline'), lexicalEditor: await getAttribute('data-lexical-editor'), type: (await getAttribute('type')).toLowerCase(), visible, focusable, boundingBox: boundingBox ? { x: Math.round(boundingBox.x), y: Math.round(boundingBox.y), width: Math.round(boundingBox.width), height: Math.round(boundingBox.height) } : undefined };
  }

  private textboxStrategy(metadata: TextboxMetadata, strategy: string, scopedToCreatePost: boolean): string | undefined {
    const editable = metadata.contenteditable.toLowerCase() === 'true';
    const roleTextbox = metadata.role === 'textbox';
    const multiline = metadata.ariaMultiline.toLowerCase() === 'true';
    const lexical = metadata.lexicalEditor.toLowerCase() === 'true';
    const label = `${metadata.ariaLabel} ${metadata.placeholder}`.trim();
    if (scopedToCreatePost) {
      if (lexical && editable && roleTextbox) return 'CREATE_POST_LEXICAL';
      if (lexical && editable) return 'CREATE_POST_LEXICAL';
      if (editable && roleTextbox) return strategy === 'CREATE_POST_CONTENTEDITABLE' ? 'CREATE_POST_ROLE_TEXTBOX' : strategy;
      if (editable && multiline) return 'CREATE_POST_CONTENTEDITABLE';
      if (metadata.tag === 'textarea') return 'CREATE_POST_TEXTAREA';
      if (metadata.tag === 'input' && (multiline || this.isKnownComposerText(label))) return 'CREATE_POST_INPUT';
      return undefined;
    }
    if (roleTextbox && this.isKnownComposerText(label)) return 'NAMED_ROLE';
    if (lexical && editable) return 'LEXICAL_EDITOR';
    if (editable && roleTextbox) return 'ROLE_TEXTBOX';
    if (editable && multiline) return 'MULTILINE_CONTENTEDITABLE';
    if (metadata.tag === 'textarea') return 'TEXTAREA';
    if (metadata.tag === 'input' && (multiline || this.isKnownComposerText(label))) return 'INPUT_COMPOSER';
    return undefined;
  }

  private isKnownComposerText(value: string): boolean { return Boolean(value && (this.isComposerTriggerText(value) || facebookText.composerTextbox.test(value))); }
  private isUtilityField(metadata: TextboxMetadata): boolean {
    const label = `${metadata.role} ${metadata.ariaLabel} ${metadata.placeholder}`.toLocaleLowerCase();
    return metadata.role === 'searchbox' || metadata.role === 'combobox' || metadata.type === 'search' || /search|tìm|tim kiem/.test(label);
  }
  private toTextboxSummary(metadata: TextboxMetadata): TextboxCandidateSummary {
    const truncate = (value: string): string | undefined => value ? value.replace(/\s+/g, ' ').trim().slice(0, 100) : undefined;
    return { tag: truncate(metadata.tag), role: truncate(metadata.role), contenteditable: truncate(metadata.contenteditable), ariaLabel: truncate(metadata.ariaLabel), placeholder: truncate(metadata.placeholder), ariaMultiline: truncate(metadata.ariaMultiline), lexicalEditor: truncate(metadata.lexicalEditor), visible: metadata.visible, boundingBox: metadata.boundingBox, focusable: metadata.focusable };
  }

  private async elementHandle(locator: Locator): Promise<ElementHandle<HTMLElement> | undefined> {
    if (typeof locator.elementHandle !== 'function') return undefined;
    return await locator.elementHandle().then((handle) => handle ? handle as ElementHandle<HTMLElement> : undefined).catch(() => undefined);
  }

  private normalizeDialogTitle(value: string): string {
    return value.normalize('NFC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.:\u2026]+$/u, '').trim();
  }

  private isCreatePostTitle(value: string): boolean {
    return facebookText.createPostTitle.test(this.normalizeDialogTitle(value));
  }

  private async dialogTitle(locator: Locator): Promise<string | undefined> {
    const titleCandidates: Locator[] = [];
    if (typeof locator.getByRole === 'function') titleCandidates.push(locator.getByRole('heading', { name: facebookText.createPostTitle }));
    titleCandidates.push(locator.locator('h1, h2, h3, [role="heading"], [aria-level], span, div'));
    for (const source of titleCandidates) {
      const candidates = await this.boundedLocators(source, 80);
      for (const candidate of candidates) {
        if (!await candidate.isVisible().catch(() => false)) continue;
        const text = ((typeof candidate.innerText === 'function' ? await candidate.innerText().catch(() => '') : '') || (typeof candidate.textContent === 'function' ? await candidate.textContent().catch(() => '') : '') || '').replace(/\s+/g, ' ').trim();
        if (text && text.length <= 100 && this.isCreatePostTitle(text)) return text.slice(0, 100);
      }
    }
    return undefined;
  }

  private async dialogForeground(locator: Locator): Promise<boolean> {
    if (typeof locator.evaluate !== 'function') return false;
    return await locator.evaluate((node) => {
      const element = node as HTMLElement;
      if (element.getAttribute('aria-hidden') === 'true') return false;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
      const top = document.elementFromPoint(x, y);
      return Boolean(top && (top === element || element.contains(top)));
    }).catch(() => false);
  }

  private async sameElement(left: ElementHandle<HTMLElement>, right: ElementHandle<HTMLElement>): Promise<boolean> {
    return await left.evaluate((node, other) => node === other, right).catch(() => false);
  }

  private async dialogMetadata(locator: Locator, baseline?: ComposerDialogBaseline): Promise<{ title?: string; visible: boolean; foreground: boolean; handle?: ElementHandle<HTMLElement>; summary: DialogCandidateSummary }> {
    const visible = await locator.isVisible().catch(() => false);
    const title = await this.dialogTitle(locator);
    const foreground = visible && await this.dialogForeground(locator);
    const handle = await this.elementHandle(locator);
    let baselineEntry: { handle: ElementHandle<HTMLElement>; title?: string } | undefined;
    if (handle && baseline) {
      for (const entry of baseline.handles) {
        if (await this.sameElement(handle, entry.handle)) { baselineEntry = entry; break; }
      }
    }
    const changedAfterTrigger = Boolean(baselineEntry && baselineEntry.title !== title);
    const summary: DialogCandidateSummary = { title: title?.slice(0, 100), newAfterTrigger: baseline ? Boolean(handle && !baselineEntry) : undefined, changedAfterTrigger: baseline ? changedAfterTrigger : undefined, visible, foreground };
    return { title, visible, foreground, handle, summary };
  }

  private async domDepth(locator: Locator): Promise<number> {
    if (typeof locator.evaluate !== 'function') return 0;
    return await locator.evaluate((node) => {
      let depth = 0; let current: Node | null = node;
      while (current?.parentElement && depth < 100) { depth += 1; current = current.parentElement; }
      return depth;
    }).catch(() => 0);
  }

  private async relatedEditorNodes(left: RawEditorCandidate, right: RawEditorCandidate): Promise<boolean> {
    if (!left.handle || !right.handle) return left.identity === right.identity;
    return await left.handle.evaluate((node, other) => node === other || node.contains(other) || other.contains(node), right.handle).catch(() => false) || this.overlappingBoxes(left.metadata.boundingBox, right.metadata.boundingBox);
  }

  private overlappingBoxes(left?: TextboxMetadata['boundingBox'], right?: TextboxMetadata['boundingBox']): boolean {
    if (!left || !right || !left.width || !left.height || !right.width || !right.height) return false;
    const overlapWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
    const overlapHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
    const overlap = overlapWidth * overlapHeight;
    return overlap / Math.min(left.width * left.height, right.width * right.height) >= 0.8;
  }

  private async groupEditorCandidates(candidates: RawEditorCandidate[]): Promise<LogicalEditorGroup[]> {
    const groups: LogicalEditorGroup[] = [];
    for (const candidate of candidates) {
      const matching = [];
      for (const group of groups) {
        let related = false;
        for (const member of group.candidates) {
          if (await this.relatedEditorNodes(member, candidate)) { related = true; break; }
        }
        if (related) matching.push(group);
      }
      if (!matching.length) groups.push({ id: groups.length + 1, candidates: [candidate] });
      else {
        const target = matching[0]; target.candidates.push(candidate);
        for (const extra of matching.slice(1)) { target.candidates.push(...extra.candidates); groups.splice(groups.indexOf(extra), 1); }
      }
    }
    groups.forEach((group, index) => { group.id = index + 1; });
    return groups;
  }

  private selectEditorSurface(group: LogicalEditorGroup): RawEditorCandidate | undefined {
    const score = (candidate: RawEditorCandidate): number => {
      const metadata = candidate.metadata; const editable = metadata.contenteditable.toLowerCase() === 'true'; const lexical = metadata.lexicalEditor.toLowerCase() === 'true'; const role = metadata.role === 'textbox';
      let value = metadata.tag === 'textarea' ? 20 : metadata.tag === 'input' ? 10 : 0;
      if (editable) value += 30; if (role) value += 40; if (lexical) value += 50; if (metadata.focusable) value += 100;
      if (facebookText.composerPlaceholder.test(`${metadata.placeholder}`)) value += 10;
      return value + Math.min(candidate.depth, 100) / 100;
    };
    return [...group.candidates].sort((left, right) => score(right) - score(left))[0];
  }

  async preflight(page: Page, item: QueueRecord, fillContent = false, captureDiagnostic?: PreflightDiagnosticCapture): Promise<{ probe: SelectorProbeResult; filledContent: boolean; handle?: ComposerHandle }> {
    const checkedAt = new Date().toISOString();
    const base = { id: undefined, accountId: item.accountId ?? '', groupId: item.groupId ?? '', selectorVersion: this.selectorsVersion, checkedAt, warnings: [] as string[] };
    if (fillContent && !hasPublishableContent(item)) {
      return { probe: { ...base, status: 'MISSING', reason: 'EMPTY_PUBLISH_CONTENT', session: { status: 'NOT_TESTED', reason: 'EMPTY_PUBLISH_CONTENT' }, group: { status: 'NOT_TESTED' }, composerTrigger: { status: 'NOT_TESTED' }, composerTextbox: { status: 'NOT_TESTED' }, mediaInput: { status: 'NOT_TESTED' }, postButton: { status: 'MISSING', reason: 'EMPTY_PUBLISH_CONTENT' }, uploadBusy: EMPTY_FIELD, approvalSignal: EMPTY_FIELD, acceptanceSignal: EMPTY_FIELD }, filledContent: false };
    }
    try { await this.openGroup(page, item.groupUrl); }
    catch (error) { const reason = error instanceof Error ? error.message : 'Group could not be opened.'; return { probe: { ...base, status: error instanceof PublishingError && error.code === 'ACCOUNT_CHECKPOINT' ? 'MISSING' : 'NOT_TESTED', reason, session: { status: error instanceof PublishingError && error.code === 'ACCOUNT_LOGIN_REQUIRED' ? 'MISSING' : 'FOUND' }, group: { status: 'MISSING', reason }, composerTrigger: EMPTY_FIELD, composerTextbox: EMPTY_FIELD, mediaInput: EMPTY_FIELD, postButton: EMPTY_FIELD, uploadBusy: EMPTY_FIELD, approvalSignal: EMPTY_FIELD, acceptanceSignal: EMPTY_FIELD }, filledContent: false }; }
    let triggerResolution: ComposerTriggerResolution;
    try { triggerResolution = await this.findComposerTrigger(page); }
    catch { triggerResolution = { status: 'MISSING', count: 0, safeCandidates: [] }; }
    if (triggerResolution.status !== 'FOUND') {
      const reason = triggerResolution.status === 'AMBIGUOUS' ? 'COMPOSER_TRIGGER_AMBIGUOUS' : 'COMPOSER_TRIGGER_NOT_FOUND';
      base.warnings.push(reason);
      let diagnosticPath: string | undefined;
      if (captureDiagnostic) { try { diagnosticPath = await captureDiagnostic(page, triggerResolution.status); } catch { /* diagnostics must never block preflight */ } }
      return { probe: { ...base, status: triggerResolution.status, reason, session: { status: 'FOUND' }, group: { status: 'FOUND' }, composerTrigger: { status: triggerResolution.status, count: triggerResolution.count }, composerTextbox: EMPTY_FIELD, mediaInput: EMPTY_FIELD, postButton: EMPTY_FIELD, uploadBusy: EMPTY_FIELD, approvalSignal: EMPTY_FIELD, acceptanceSignal: EMPTY_FIELD, triggerStrategy: triggerResolution.strategy, triggerCandidates: triggerResolution.safeCandidates, diagnosticPath }, filledContent: false };
    }
    let handle: ComposerHandle;
    try { handle = await this.openComposer(page, triggerResolution); } catch (error) {
      const code = error instanceof PublishingError ? error.code : 'COMPOSER_TRIGGER_CLICK_FAILED';
      const status: SelectorProbeResult['status'] = code === 'COMPOSER_TRIGGER_AMBIGUOUS' || code === 'COMPOSER_CONTAINER_AMBIGUOUS' || code === 'COMPOSER_TEXTBOX_AMBIGUOUS' ? 'AMBIGUOUS' : 'MISSING';
      const reason = code;
      base.warnings.push(reason);
      let diagnosticPath: string | undefined;
      if (captureDiagnostic && ['COMPOSER_TRIGGER_CLICK_FAILED', 'COMPOSER_TRIGGER_CLICK_NO_COMPOSER', 'COMPOSER_CONTAINER_NOT_FOUND', 'COMPOSER_CONTAINER_AMBIGUOUS', 'COMPOSER_TEXTBOX_NOT_FOUND', 'COMPOSER_TEXTBOX_AMBIGUOUS'].includes(code)) { try { diagnosticPath = await captureDiagnostic(page, status); } catch { /* diagnostics must never block preflight */ } }
      const readiness = error instanceof ComposerReadinessError ? error : undefined;
      const textboxCandidates = readiness?.textboxCandidates ?? [];
      const dialogCandidates = readiness?.dialogCandidates ?? [];
      const dialogStatus: SelectorProbeField['status'] = code === 'COMPOSER_CONTAINER_AMBIGUOUS' ? 'AMBIGUOUS' : dialogCandidates.length ? 'FOUND' : 'MISSING';
      return { probe: { ...base, status, reason, session: { status: 'FOUND' }, group: { status: 'FOUND' }, composerTrigger: { status: 'FOUND', count: 1 }, composerTextbox: { status: status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'MISSING', reason }, mediaInput: EMPTY_FIELD, postButton: EMPTY_FIELD, uploadBusy: EMPTY_FIELD, approvalSignal: EMPTY_FIELD, acceptanceSignal: EMPTY_FIELD, createPostDialog: { status: dialogStatus, count: dialogCandidates.length }, dialogTitle: readiness?.dialogTitle, dialogCandidates, rawEditorCount: readiness?.rawEditorCount, logicalEditorCount: readiness?.logicalEditorCount, triggerStrategy: triggerResolution.strategy, triggerCandidates: triggerResolution.safeCandidates, textboxCandidates, diagnosticPath }, filledContent: false };
    }
    const mediaInputCandidates = await this.visibleCandidates([handle.container.locator('input[type="file"]')]);
    const mediaInput = mediaInputCandidates.length === 1 ? mediaInputCandidates[0] : undefined;
    const requiresMedia = item.media.length > 0;
    const mediaStatus = mediaInput ? { status: 'FOUND' as const, count: 1 } : mediaInputCandidates.length > 1 ? { status: 'AMBIGUOUS' as const, count: mediaInputCandidates.length } : requiresMedia ? { status: 'MISSING' as const, count: 0 } : { status: 'NOT_TESTED' as const, count: 0, reason: 'No media is required for this snapshot.' };
    const statuses = { session: { status: 'FOUND' as const }, group: { status: 'FOUND' as const }, composerTrigger: { status: 'FOUND' as const, count: 1 }, composerTextbox: { status: 'FOUND' as const, count: 1 }, mediaInput: mediaStatus, postButton: EMPTY_FIELD, createPostDialog: { status: 'FOUND' as const, count: handle.dialogCandidates?.length ?? 1 }, uploadBusy: { status: (await handle.container.getByText(facebookText.uploadBusy).count().catch(() => 0)) ? 'FOUND' as const : 'NOT_TESTED' as const }, approvalSignal: { status: (await handle.container.getByText(facebookText.pendingApproval).count().catch(() => 0)) ? 'FOUND' as const : 'NOT_TESTED' as const }, acceptanceSignal: { status: (await handle.container.getByText(facebookText.accepted).count().catch(() => 0)) ? 'FOUND' as const : 'NOT_TESTED' as const } };
    const expectedContent = this.composeContent(item.body, item.linkUrl);
    let entry: ComposerContentEntry | undefined;
    let postButtonCandidates = await this.visibleCandidates([handle.container.getByRole('button', { name: facebookText.postButton }), handle.container.locator('[role="button"]').filter({ hasText: facebookText.postButton })]);
    let postButtonStatus: SelectorProbeField = await probePostButton(postButtonCandidates, false);
    if (fillContent) {
      entry = await this.enterComposerContent(handle.textbox, expectedContent);
      postButtonCandidates = await this.visibleCandidates([handle.container.getByRole('button', { name: facebookText.postButton }), handle.container.locator('[role="button"]').filter({ hasText: facebookText.postButton })]);
      postButtonStatus = await probePostButton(postButtonCandidates, true, entry.visibleContentPresent ? 500 : 0);
      const shouldFallback = !entry.visibleContentPresent || (postButtonStatus.count === 1 && postButtonStatus.enabled === false);
      if (shouldFallback) {
        const fallback = await this.enterComposerContent(handle.textbox, expectedContent, 'KEYBOARD_INSERT');
        entry = fallback;
        postButtonCandidates = await this.visibleCandidates([handle.container.getByRole('button', { name: facebookText.postButton }), handle.container.locator('[role="button"]').filter({ hasText: facebookText.postButton })]);
        postButtonStatus = await probePostButton(postButtonCandidates, true, 2000);
      }
    }
    const required: string[] = [statuses.composerTextbox.status, postButtonStatus.status]; if (requiresMedia) required.push(statuses.mediaInput.status); let status: SelectorProbeResult['status'] = required.includes('MISSING') ? 'MISSING' : required.includes('AMBIGUOUS') ? 'AMBIGUOUS' : 'FOUND';
    let reason: string | undefined;
    if (fillContent && entry && !entry.visibleContentPresent) { status = 'MISSING'; reason = 'EDITOR_CONTENT_NOT_OBSERVED'; }
    else if (fillContent && postButtonStatus.count === 1 && postButtonStatus.enabled === false) { status = 'MISSING'; reason = `Post remained disabled after verified composer content. Entry method: ${entry?.method ?? 'UNKNOWN'}.`; }
    else if (postButtonStatus.status === 'AMBIGUOUS') { status = 'AMBIGUOUS'; reason = 'POST_BUTTON_AMBIGUOUS'; }
    else if (postButtonStatus.count === 0) { status = 'MISSING'; reason = 'POST_BUTTON_NOT_FOUND'; }
    const probe: SelectorProbeResult = { ...base, status, reason, ...statuses, postButton: postButtonStatus, editorType: entry?.editorType, contentObserved: entry?.visibleContentPresent, observedContentLength: entry?.contentLength, expectedContentLength: entry?.expectedLength, entryMethod: entry?.method, triggerStrategy: triggerResolution.strategy, triggerCandidates: triggerResolution.safeCandidates, textboxStrategy: handle.textboxStrategy, textboxCandidates: handle.textboxCandidates, dialogTitle: handle.dialogTitle, dialogCandidates: handle.dialogCandidates, rawEditorCount: handle.rawEditorCount, logicalEditorCount: handle.logicalEditorCount };
    if (reason) base.warnings.push(reason);
    if (captureDiagnostic && status !== 'FOUND') {
      try { probe.diagnosticPath = await captureDiagnostic(page, status); } catch { /* diagnostics must never block preflight */ }
    }
    const dismissalWarning = await this.dismissComposer(page, handle.container);
    if (dismissalWarning) base.warnings.push(dismissalWarning);
    return { probe, filledContent: Boolean(entry?.visibleContentPresent), handle };
  }

  async captureBaseline(page: Page, body: string): Promise<SubmissionBaseline> {
    const candidates = await this.postCandidates(page);
    return { urls: candidates.map((candidate) => candidate.canonicalUrl), candidates, bodyFingerprint: this.fingerprint(body) };
  }

  async fillContent(textboxOrHandle: Locator | ComposerHandle, body: string, linkUrl?: string): Promise<ComposerContentEntry> {
    const content = this.composeContent(body, linkUrl);
    const entry = await this.enterComposerContent(textboxOrHandle, content);
    if (content && !entry.visibleContentPresent) throw new PublishingError('CONTENT_FILL_FAILED', 'Facebook composer content was not observed after entry.');
    return entry;
  }

  async enterComposerContent(textboxOrHandle: Locator | ComposerHandle, content: string, method: ComposerEntryMethod = 'FILL'): Promise<ComposerContentEntry> {
    const textbox = 'textbox' in textboxOrHandle ? textboxOrHandle.textbox : textboxOrHandle;
    const editorType = await this.detectEditorType(textbox);
    try {
      if (method === 'FILL') await textbox.fill(content);
      else await this.keyboardInsert(textbox, content);
    } catch {
      return { method, editorType, visibleContentPresent: false, contentLength: 0, expectedLength: content.length };
    }
    const observed = await this.waitForObservedContent(textbox, editorType, content);
    return { method, editorType, visibleContentPresent: contentMatches(observed, content), contentLength: observed.length, expectedLength: content.length };
  }

  async uploadMedia(page: Page, paths: string[], hasVideo: boolean, videoTimeoutSeconds: number, container?: Locator): Promise<void> {
    if (!paths.length) return;
    const scope = container ?? page; const input = scope.locator('input[type="file"]');
    const visible = await this.uniqueVisible([input]); if (!visible) throw new PublishingError('MEDIA_UPLOAD_FAILED', 'Facebook media input was not found.');
    try { await visible.setInputFiles(paths); } catch { throw new PublishingError('MEDIA_UPLOAD_FAILED', 'Facebook rejected the selected media.'); }
    const timeout = hasVideo ? videoTimeoutSeconds * 1000 : 120000; const busy = scope.getByText(facebookText.uploadBusy).first();
    try {
      if (await busy.isVisible().catch(() => false)) await busy.waitFor({ state: 'hidden', timeout });
      const attachment = scope.locator('img, video, [data-testid*="media"], [data-testid*="attachment"]').first();
      if (!await attachment.isVisible().catch(() => false)) await attachment.waitFor({ state: 'visible', timeout });
      const post = await this.uniqueVisible([scope.getByRole('button', { name: facebookText.postButton }), scope.locator('[role="button"]').filter({ hasText: facebookText.postButton })]);
      if (!post || !await post.isEnabled().catch(() => false)) throw new PublishingError('MEDIA_UPLOAD_TIMEOUT', 'Facebook media processing did not finish safely.');
    } catch (error) { if (error instanceof PublishingError) throw error; throw new PublishingError('MEDIA_UPLOAD_TIMEOUT', 'Facebook media processing did not finish safely.'); }
  }

  async submit(page: Page, composer: ComposerHandle, baseline: SubmissionBaseline, groupUrl: string, onSubmitting: () => void, onObservation?: (event: PostSubmitObservationMilestone, detail?: string) => void): Promise<SubmissionEvidence> {
    const button = await this.uniqueVisible([composer.container.getByRole('button', { name: facebookText.postButton }), composer.container.locator('[role="button"]').filter({ hasText: facebookText.postButton })]);
    if (!button || !await button.isEnabled().catch(() => false)) throw new PublishingError('SUBMIT_FAILED', 'A unique enabled Post button was not found in the active composer.');
    onSubmitting();
    try { await button.click({ timeout: 10000 }); } catch { throw new PublishingError('SUBMISSION_UNKNOWN', 'Post interaction result is unknown.', true); }
    const emit = (event: PostSubmitObservationMilestone, detail?: string): void => { try { onObservation?.(event, detail); } catch { /* evidence logging must not shorten the observation hold */ } };
    const clickedAt = Date.now(); emit('POST_CLICKED'); emit('POST_OBSERVATION_STARTED');
    const before = new Set((baseline.candidates ?? []).map((candidate) => candidate.canonicalUrl).concat(baseline.urls));
    const observed = { composerClosed: false, pendingApproval: false, accepted: false, newTargetCandidates: 0, correlatedUrl: undefined as string | undefined, inspectionFailed: false };
    while (true) {
      try {
        if (typeof page.isClosed === 'function' && page.isClosed()) observed.inspectionFailed = true;
        else {
          const composerClosed = !await composer.container.isVisible().catch(() => false);
          if (composerClosed && !observed.composerClosed) { observed.composerClosed = true; emit('COMPOSER_CLOSED'); }
          const pendingApproval = await page.getByText(facebookText.pendingApproval).first().isVisible().catch(() => false);
          if (pendingApproval && !observed.pendingApproval) { observed.pendingApproval = true; emit('PENDING_APPROVAL_DETECTED'); }
          const accepted = await page.getByText(facebookText.accepted).first().isVisible().catch(() => false);
          if (accepted && !observed.accepted) { observed.accepted = true; emit('ACCEPTANCE_DETECTED'); }
          const afterCandidates = await this.postCandidates(page); const newCandidates = afterCandidates.filter((candidate) => !before.has(candidate.canonicalUrl)); const sameGroup = newCandidates.filter((candidate) => isTargetGroupCandidate(candidate, groupUrl));
          if (sameGroup.length > observed.newTargetCandidates) { observed.newTargetCandidates = sameGroup.length; emit('NEW_POST_CANDIDATE', 'TARGET_GROUP_CANDIDATES=' + sameGroup.length); }
          const correlated = sameGroup.find((candidate) => candidateContentMatches(candidate.visibleText, baseline.bodyFingerprint));
          if (correlated?.url && !observed.correlatedUrl) { observed.correlatedUrl = correlated.url; emit('POST_CORRELATED', 'CONTENT_CORRELATED=YES'); }
        }
      } catch { observed.inspectionFailed = true; }
      const remaining = clickedAt + POST_SUBMIT_MIN_OBSERVATION_MS - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(POST_SUBMIT_POLL_MS, remaining)));
    }
    emit('POST_OBSERVATION_MINIMUM_REACHED');
    emit('POST_CORRELATION', 'POST_CANDIDATES_BEFORE=' + before.size + ';NEW_TARGET_GROUP_CANDIDATES=' + observed.newTargetCandidates + ';CONTENT_CORRELATED=' + Boolean(observed.correlatedUrl));
    if (observed.correlatedUrl && observed.accepted) return { result: 'VERIFIED_PUBLISHED', evidence: 'Facebook displayed submission acceptance and a new target-group post candidate whose scoped text correlated with the snapshot.', postUrl: observed.correlatedUrl };
    if (observed.pendingApproval) return { result: 'SUBMITTED_PENDING_APPROVAL', evidence: 'Facebook displayed a post approval message.' };
    if (observed.accepted) return { result: 'SUBMITTED', evidence: 'Facebook displayed submission acceptance without correlated publication evidence.' };
    if (observed.composerClosed) return { result: 'SUBMITTED', evidence: 'Composer closed after the Post interaction.' };
    return { result: 'UNKNOWN', evidence: observed.inspectionFailed ? 'Facebook submission evidence could not be inspected continuously.' : 'Facebook did not provide conclusive submission evidence.' };
  }

  private async triggerScopes(page: Page): Promise<Locator[]> {
    const scopes: Locator[] = [];
    for (const selector of ['main', '[role="main"]']) {
      const root = page.locator(selector);
      const count = Math.min(await root.count().catch(() => 0), 5);
      for (let index = 0; index < count; index++) {
        const candidate = root.nth(index);
        if (await candidate.isVisible().catch(() => false)) scopes.push(candidate);
      }
      if (scopes.length) return scopes;
    }
    if (!scopes.length) scopes.push(page.locator('body'));
    return scopes;
  }

  private async interactiveCandidates(scope: Locator): Promise<Locator[]> {
    const combined = scope.locator('button, [role="button"], [tabindex="0"]');
    const combinedCount = Math.min(await combined.count().catch(() => 0), 50);
    if (combinedCount) {
      const candidates: Locator[] = [];
      for (let index = 0; index < combinedCount; index++) { const candidate = combined.nth(index); if (await candidate.isVisible().catch(() => false)) candidates.push(candidate); }
      return candidates;
    }
    const candidates: Locator[] = [];
    for (const selector of ['button', '[role="button"]', '[tabindex="0"]']) {
      const locator = scope.locator(selector);
      const count = Math.min(await locator.count().catch(() => 0), 50);
      for (let index = 0; index < count; index++) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) candidates.push(candidate);
      }
    }
    return candidates;
  }

  private async triggerMetadata(locator: Locator): Promise<{ visible: boolean; role: string; tag: string; ariaLabel: string; title: string; text: string }> {
    const getAttribute = async (name: string): Promise<string> => typeof locator.getAttribute === 'function' ? await locator.getAttribute(name).catch(() => '') || '' : '';
    const tag = (typeof locator.evaluate === 'function' ? await locator.evaluate((node) => node.tagName).catch(() => '') : '').toLowerCase();
    const roleAttribute = await getAttribute('role');
    const role = roleAttribute || (tag === 'button' ? 'button' : tag);
    const ariaLabel = await getAttribute('aria-label');
    const title = await getAttribute('title');
    const innerText = typeof locator.innerText === 'function' ? await locator.innerText().catch(() => '') : '';
    const text = innerText || (typeof locator.textContent === 'function' ? await locator.textContent().catch(() => '') || '' : '');
    return { visible: await locator.isVisible().catch(() => false), role, tag, ariaLabel, title, text };
  }

  private triggerStrategy(metadata: { role: string; tag: string; ariaLabel: string; title: string; text: string }): string | undefined {
    const roleButton = metadata.role.toLowerCase() === 'button' || metadata.tag === 'button' || metadata.tag === 'a' && Boolean(metadata.ariaLabel || metadata.title);
    const accessibleLabel = `${metadata.ariaLabel} ${metadata.title}`.trim();
    if (roleButton && accessibleLabel && this.isComposerTriggerText(accessibleLabel)) return 'ROLE_ACCESSIBLE_NAME';
    if (accessibleLabel && this.isComposerTriggerText(accessibleLabel)) return 'ARIA_LABEL_TITLE';
    if (roleButton && this.isComposerTriggerText(metadata.text)) return 'VISIBLE_TEXT_INTERACTIVE_ANCESTOR';
    return undefined;
  }

  private isPotentialTriggerDiagnostic(metadata: { role: string; tag: string; ariaLabel: string; title: string; text: string }): boolean {
    const label = `${metadata.ariaLabel} ${metadata.title} ${metadata.text}`.replace(/\s+/g, ' ').trim();
    return Boolean(label && label.length <= 100);
  }

  private isComposerTriggerText(value: string): boolean {
    const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return COMPOSER_TRIGGER_PHRASES.some((phrase) => normalized.includes(phrase));
  }

  private toTriggerSummary(metadata: { role: string; tag: string; ariaLabel: string; title: string; text: string }): TriggerCandidateSummary {
    const truncate = (value: string): string | undefined => value ? value.replace(/\s+/g, ' ').trim().slice(0, 100) : undefined;
    return { role: truncate(metadata.role), tag: truncate(metadata.tag), ariaLabel: truncate(metadata.ariaLabel), title: truncate(metadata.title), text: truncate(metadata.text) };
  }

  private composeContent(body: string, linkUrl?: string): string { return linkUrl && !this.containsLink(body, linkUrl) ? `${body}${body ? '\n\n' : ''}${linkUrl}` : body; }
  private async detectEditorType(textbox: Locator): Promise<ComposerEditorType> {
    const contenteditable = typeof textbox.getAttribute === 'function' ? await textbox.getAttribute('contenteditable').catch(() => undefined) : undefined;
    if (contenteditable?.toLowerCase() === 'true') return 'CONTENTEDITABLE';
    const tagName = typeof textbox.evaluate === 'function' ? await textbox.evaluate((node) => node.tagName).catch(() => '') : '';
    if (tagName.toUpperCase() === 'TEXTAREA') return 'TEXTAREA';
    if (tagName.toUpperCase() === 'INPUT') return 'INPUT';
    return 'UNKNOWN';
  }
  private async readComposerContent(textbox: Locator, editorType: ComposerEditorType): Promise<string> {
    if (editorType === 'INPUT' || editorType === 'TEXTAREA') return typeof textbox.inputValue === 'function' ? await textbox.inputValue().catch(() => '') : '';
    if (editorType === 'CONTENTEDITABLE') {
      const innerText = typeof textbox.innerText === 'function' ? await textbox.innerText().catch(() => '') : '';
      return innerText || (typeof textbox.textContent === 'function' ? await textbox.textContent().catch(() => '') || '' : '');
    }
    if (typeof textbox.inputValue === 'function') return await textbox.inputValue().catch(() => '');
    if (typeof textbox.innerText === 'function') return await textbox.innerText().catch(() => '');
    return typeof textbox.textContent === 'function' ? await textbox.textContent().catch(() => '') || '' : '';
  }
  private async waitForObservedContent(textbox: Locator, editorType: ComposerEditorType, expected: string, timeoutMs = 750): Promise<string> {
    let observed = await this.readComposerContent(textbox, editorType);
    if (!expected || contentMatches(observed, expected)) return observed;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      observed = await this.readComposerContent(textbox, editorType);
      if (contentMatches(observed, expected)) break;
    }
    return observed;
  }
  private async keyboardInsert(textbox: Locator, content: string): Promise<void> {
    await textbox.focus();
    await textbox.press('ControlOrMeta+A');
    await textbox.press('Backspace');
    await textbox.page().keyboard.insertText(content);
  }
  private async dismissComposer(page: Page, container: Locator): Promise<string | undefined> {
    const close = await this.uniqueVisible([container.getByRole('button', { name: /close|cancel|discard/i }), container.locator('[aria-label*="Close" i]')]);
    if (close) await close.click().catch(() => undefined);
    else await page.keyboard.press('Escape').catch(() => undefined);
    const discard = await this.uniqueVisible([page.getByRole('button', { name: /discard post|discard/i }), page.getByText(/discard post/i)]);
    if (discard) await discard.click().catch(() => undefined);
    if (await container.isVisible().catch(() => false)) return 'Composer could not be safely dismissed after preflight.';
    return undefined;
  }
  private async boundedLocators(locator: Locator, limit: number): Promise<Locator[]> { const candidates: Locator[] = []; if (typeof locator.count !== 'function') return candidates; const count = Math.min(await locator.count().catch(() => 0), limit); for (let index = 0; index < count; index++) candidates.push(locator.nth(index)); return candidates; }
  private async visibleLocators(locator: Locator, limit: number): Promise<Locator[]> { const visible: Locator[] = []; if (typeof locator.count !== 'function') return visible; const count = Math.min(await locator.count().catch(() => 0), limit); for (let index = 0; index < count; index++) { const candidate = locator.nth(index); if (await candidate.isVisible().catch(() => false)) visible.push(candidate); } return visible; }
  private async visibleCandidates(locators: Locator[]): Promise<Locator[]> { const visible: Locator[] = []; for (const locator of locators) { if (typeof locator.count !== 'function') continue; const count = Math.min(await locator.count().catch(() => 0), 10); for (let index = 0; index < count; index++) { const candidate = locator.nth(index); if (await candidate.isVisible().catch(() => false)) visible.push(candidate); } if (visible.length) break; } return visible; }
  private async candidateUrls(page: Page): Promise<string[]> { return (await this.postCandidates(page)).map((candidate) => candidate.canonicalUrl); }
  private async postCandidates(page: Page): Promise<PostCandidate[]> {
    const links = page.locator('a[href*="/posts/"], a[href*="permalink"], a[href*="story_fbid"]'); const count = Math.min(await links.count().catch(() => 0), 200); const candidates: PostCandidate[] = []; const seen = new Set<string>();
    for (let index = 0; index < count; index++) {
      const anchor = links.nth(index); if (!await anchor.isVisible().catch(() => false)) continue;
      const href = await anchor.getAttribute('href').catch(() => undefined); const absolute = href ? (() => { try { return new URL(href, page.url()).href; } catch { return href; } })() : undefined; const canonicalUrl = absolute ? normalizePostCandidateUrl(absolute) : undefined; if (!absolute || !canonicalUrl || seen.has(canonicalUrl)) continue; seen.add(canonicalUrl);
      const container = anchor.locator('xpath=ancestor-or-self::*[self::article or @role="article"][1]'); const hasContainer = await container.count().catch(() => 0); const scoped = hasContainer ? container.first() : anchor.locator('xpath=..'); const visibleText = await scoped.innerText({ timeout: 1500 }).catch(() => undefined);
      candidates.push({ url: absolute, canonicalUrl, container: scoped, visibleText, groupIdentifier: candidateGroupIdentifier(absolute) });
    }
    return candidates;
  }
  private newCorrelatedUrl(after: string[], before: string[], groupUrl: string): string | undefined { return correlateNewPostUrl(after, before, groupUrl); }
  private containsLink(body: string, link: string): boolean { try { return body.split(/\s+/).some((value) => new URL(value).href === new URL(link).href); } catch { return body.includes(link); } }
  private fingerprint(body: string): string { return body.trim().replace(/\s+/g, ' ').slice(0, 160).toLowerCase(); }
  private async uniqueVisible(locators: Locator[]): Promise<Locator | undefined> { const visible: Locator[] = []; for (const locator of locators) { const count = Math.min(await locator.count().catch(() => 0), 10); for (let index = 0; index < count; index++) { const candidate = locator.nth(index); if (await candidate.isVisible().catch(() => false)) visible.push(candidate); } if (visible.length) break; } return visible.length === 1 ? visible[0] : undefined; }
}
