import type { Locator, Page } from 'playwright';
import { SessionHealthService } from '@main/browser/SessionHealthService';
import { normalizeFacebookGroupUrl } from '@shared/groupUrl';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { ComposerEditorType, ComposerEntryMethod, SelectorProbeField, SelectorProbeResult, TextboxCandidateSummary, TriggerCandidateSummary } from '@shared/types';
import { PublishingError } from './PublishingError';
import { FACEBOOK_SELECTORS_VERSION, facebookText } from './selectors/facebookSelectors';

export type PostCandidate = { url: string; canonicalUrl: string; container?: Locator; visibleText?: string; groupIdentifier?: string };
export type SubmissionEvidence = { result: 'SUBMITTED' | 'SUBMITTED_PENDING_APPROVAL' | 'VERIFIED_PUBLISHED' | 'UNKNOWN'; evidence: string; postUrl?: string };
export type ComposerHandle = { container: Locator; textbox: Locator; textboxStrategy?: string; textboxCandidates?: TextboxCandidateSummary[] };
export type SubmissionBaseline = { urls: string[]; bodyFingerprint: string; candidates?: PostCandidate[] };
export type ComposerContentEntry = { method: ComposerEntryMethod; editorType: ComposerEditorType; visibleContentPresent: boolean; contentLength: number; expectedLength: number };
export type PreflightDiagnosticCapture = (page: Page, status: SelectorProbeResult['status']) => Promise<string | undefined>;
export type ComposerTriggerResolution = { status: 'FOUND' | 'MISSING' | 'AMBIGUOUS'; locator?: Locator; strategy?: string; count: number; safeCandidates: TriggerCandidateSummary[] };
export type ComposerTextboxResolution = { status: 'FOUND' | 'MISSING' | 'AMBIGUOUS'; locator?: Locator; strategy?: string; count: number; safeCandidates: TextboxCandidateSummary[] };
type ComposerReadyResult = { status: 'FOUND' | 'MISSING' | 'AMBIGUOUS'; reason: 'COMPOSER_CONTAINER_NOT_FOUND' | 'COMPOSER_CONTAINER_AMBIGUOUS' | 'COMPOSER_TEXTBOX_NOT_FOUND' | 'COMPOSER_TEXTBOX_AMBIGUOUS'; message: string; container?: Locator; textbox?: Locator; strategy?: string; safeCandidates: TextboxCandidateSummary[] };

class ComposerReadinessError extends PublishingError {
  constructor(code: 'COMPOSER_CONTAINER_NOT_FOUND' | 'COMPOSER_CONTAINER_AMBIGUOUS' | 'COMPOSER_TEXTBOX_NOT_FOUND' | 'COMPOSER_TEXTBOX_AMBIGUOUS', message: string, public readonly textboxCandidates: TextboxCandidateSummary[]) { super(code, message); }
}

const COMPOSER_TRIGGER_PHRASES = [
  'write something', 'create post', 'what s on your mind', 'create a public post',
  'viet gi do', 'viet gi di', 'ban dang nghi gi', 'ban viet gi di',
  'ban muon chia se gi', 'chia se gi do', 'tao bai viet', 'tao bai viet cong khai'
];

const EMPTY_FIELD: SelectorProbeField = { status: 'NOT_TESTED' };

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
    try { await resolution.locator.click(); } catch { throw new PublishingError('COMPOSER_TRIGGER_CLICK_FAILED', 'Facebook composer trigger could not be clicked.'); }
    const ready = await this.waitForComposerReady(page);
    if (ready.status !== 'FOUND' || !ready.container || !ready.textbox) throw new ComposerReadinessError(ready.reason, ready.message, ready.safeCandidates);
    return { container: ready.container, textbox: ready.textbox, textboxStrategy: ready.strategy, textboxCandidates: ready.safeCandidates };
  }

  async findComposerTextbox(scope: Locator): Promise<ComposerTextboxResolution> {
    const namedCandidates = typeof scope.getByRole === 'function' ? await this.visibleCandidates([scope.getByRole('textbox', { name: facebookText.composerTextbox })]) : [];
    const namedKeys = new Set<string>();
    for (const candidate of namedCandidates) namedKeys.add(this.textboxMetadataKey(await this.textboxMetadata(candidate)));
    const broad = scope.locator('[contenteditable="true"], [data-lexical-editor="true"], [role="textbox"], textarea, input');
    const candidates = await this.boundedLocators(broad, 20);
    const safeCandidates: TextboxCandidateSummary[] = [];
    const valid: Array<{ locator: Locator; strategy: string; summary: TextboxCandidateSummary }> = [];
    for (const candidate of candidates) {
      const metadata = await this.textboxMetadata(candidate);
      const summary = this.toTextboxSummary(metadata);
      safeCandidates.push(summary);
      const strategy = metadata.visible ? this.textboxStrategy(metadata, namedKeys.has(this.textboxMetadataKey(metadata))) : undefined;
      if (strategy) valid.push({ locator: candidate, strategy, summary: { ...summary, strategy } });
    }
    if (valid.length > 1) return { status: 'AMBIGUOUS', count: valid.length, safeCandidates: valid.slice(0, 20).map((candidate) => candidate.summary) };
    const match = valid[0];
    if (match) return { status: 'FOUND', locator: match.locator, strategy: match.strategy, count: 1, safeCandidates: [match.summary] };
    return { status: 'MISSING', count: 0, safeCandidates: safeCandidates.slice(0, 20) };
  }

  private async waitForComposerReady(page: Page, timeoutMs = 7000): Promise<ComposerReadyResult> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 8000);
    let lastCandidates: TextboxCandidateSummary[] = [];
    let sawContainer = false;
    while (true) {
      const containers = await this.visibleComposerContainers(page);
      sawContainer ||= containers.length > 0;
      const valid: Array<{ container: Locator; resolution: ComposerTextboxResolution }> = [];
      for (const container of containers) {
        const resolution = await this.findComposerTextbox(container);
        lastCandidates = [...lastCandidates, ...resolution.safeCandidates].slice(-20);
        if (resolution.status === 'AMBIGUOUS') return { status: 'AMBIGUOUS', reason: 'COMPOSER_TEXTBOX_AMBIGUOUS', message: 'Multiple valid Facebook composer editors are visible.', safeCandidates: resolution.safeCandidates };
        if (resolution.status === 'FOUND' && resolution.locator) valid.push({ container, resolution });
      }
      if (valid.length === 1) {
        const match = valid[0];
        return { status: 'FOUND', reason: 'COMPOSER_TEXTBOX_NOT_FOUND', message: '', container: match.container, textbox: match.resolution.locator, strategy: match.resolution.strategy, safeCandidates: match.resolution.safeCandidates };
      }
      if (valid.length > 1) return { status: 'AMBIGUOUS', reason: 'COMPOSER_CONTAINER_AMBIGUOUS', message: 'Multiple Facebook composer containers are ready.', safeCandidates: lastCandidates };
      if (Date.now() >= deadline) {
        if (containers.length > 1) return { status: 'AMBIGUOUS', reason: 'COMPOSER_CONTAINER_AMBIGUOUS', message: 'Multiple Facebook composer containers were visible without a unique ready editor.', safeCandidates: lastCandidates };
        if (sawContainer) return { status: 'MISSING', reason: 'COMPOSER_TEXTBOX_NOT_FOUND', message: 'Facebook composer appeared, but its editor did not hydrate in time.', safeCandidates: lastCandidates };
        return { status: 'MISSING', reason: 'COMPOSER_CONTAINER_NOT_FOUND', message: 'Facebook composer did not appear after the trigger was clicked.', safeCandidates: lastCandidates };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async visibleComposerContainers(page: Page): Promise<Locator[]> {
    const dialogs = await this.visibleLocators(page.locator('[role="dialog"]'), 10);
    if (dialogs.length) return dialogs;
    return this.visibleLocators(page.locator('form'), 10);
  }

  private async textboxMetadata(locator: Locator): Promise<{ tag: string; role: string; contenteditable: string; ariaLabel: string; placeholder: string; ariaMultiline: string; lexicalEditor: string; type: string; visible: boolean }> {
    const getAttribute = async (name: string): Promise<string> => typeof locator.getAttribute === 'function' ? await locator.getAttribute(name).catch(() => '') || '' : '';
    const tag = (typeof locator.evaluate === 'function' ? await locator.evaluate((node) => node.tagName).catch(() => '') : '').toLowerCase();
    return { tag, role: (await getAttribute('role')).toLowerCase(), contenteditable: await getAttribute('contenteditable'), ariaLabel: await getAttribute('aria-label'), placeholder: await getAttribute('placeholder'), ariaMultiline: await getAttribute('aria-multiline'), lexicalEditor: await getAttribute('data-lexical-editor'), type: (await getAttribute('type')).toLowerCase(), visible: await locator.isVisible().catch(() => false) };
  }

  private textboxStrategy(metadata: { tag: string; role: string; contenteditable: string; ariaLabel: string; placeholder: string; ariaMultiline: string; lexicalEditor: string; type: string }, namedRole = false): string | undefined {
    const editable = metadata.contenteditable.toLowerCase() === 'true';
    const roleTextbox = metadata.role === 'textbox';
    const multiline = metadata.ariaMultiline.toLowerCase() === 'true';
    const lexical = metadata.lexicalEditor.toLowerCase() === 'true';
    const label = `${metadata.ariaLabel} ${metadata.placeholder}`.trim();
    if (roleTextbox && (namedRole || this.isKnownComposerText(label))) return 'NAMED_ROLE';
    if (lexical && editable) return 'LEXICAL_EDITOR';
    if (editable && roleTextbox) return 'ROLE_TEXTBOX';
    if (editable && multiline) return 'MULTILINE_CONTENTEDITABLE';
    if (metadata.tag === 'textarea' && !this.isUtilityField(metadata)) return 'TEXTAREA';
    if (metadata.tag === 'input' && !this.isUtilityField(metadata) && (multiline || this.isKnownComposerText(label))) return 'INPUT_COMPOSER';
    return undefined;
  }

  private isKnownComposerText(value: string): boolean { return Boolean(value && (this.isComposerTriggerText(value) || facebookText.composerTextbox.test(value))); }
  private textboxMetadataKey(metadata: { tag: string; role: string; contenteditable: string; ariaLabel: string; placeholder: string; ariaMultiline: string; lexicalEditor: string; type: string }): string { return [metadata.tag, metadata.role, metadata.contenteditable, metadata.ariaLabel, metadata.placeholder, metadata.ariaMultiline, metadata.lexicalEditor, metadata.type].join('|'); }
  private isUtilityField(metadata: { role: string; ariaLabel: string; placeholder: string; type: string }): boolean {
    const label = `${metadata.role} ${metadata.ariaLabel} ${metadata.placeholder}`.toLocaleLowerCase();
    return metadata.role === 'searchbox' || metadata.role === 'combobox' || metadata.type === 'search' || /search|tìm|tim kiem/.test(label);
  }
  private toTextboxSummary(metadata: { tag: string; role: string; contenteditable: string; ariaLabel: string; placeholder: string; ariaMultiline: string; lexicalEditor: string; type: string; visible: boolean }): TextboxCandidateSummary {
    const truncate = (value: string): string | undefined => value ? value.replace(/\s+/g, ' ').trim().slice(0, 100) : undefined;
    return { tag: truncate(metadata.tag), role: truncate(metadata.role), contenteditable: truncate(metadata.contenteditable), ariaLabel: truncate(metadata.ariaLabel), placeholder: truncate(metadata.placeholder), ariaMultiline: truncate(metadata.ariaMultiline), lexicalEditor: truncate(metadata.lexicalEditor), visible: metadata.visible };
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
      const textboxCandidates = error instanceof ComposerReadinessError ? error.textboxCandidates : [];
      return { probe: { ...base, status, reason, session: { status: 'FOUND' }, group: { status: 'FOUND' }, composerTrigger: { status: 'FOUND', count: 1 }, composerTextbox: { status: status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'MISSING', reason }, mediaInput: EMPTY_FIELD, postButton: EMPTY_FIELD, uploadBusy: EMPTY_FIELD, approvalSignal: EMPTY_FIELD, acceptanceSignal: EMPTY_FIELD, triggerStrategy: triggerResolution.strategy, triggerCandidates: triggerResolution.safeCandidates, textboxCandidates, diagnosticPath }, filledContent: false };
    }
    const mediaInputCandidates = await this.visibleCandidates([handle.container.locator('input[type="file"]')]);
    const mediaInput = mediaInputCandidates.length === 1 ? mediaInputCandidates[0] : undefined;
    const requiresMedia = item.media.length > 0;
    const mediaStatus = mediaInput ? { status: 'FOUND' as const, count: 1 } : mediaInputCandidates.length > 1 ? { status: 'AMBIGUOUS' as const, count: mediaInputCandidates.length } : requiresMedia ? { status: 'MISSING' as const, count: 0 } : { status: 'NOT_TESTED' as const, count: 0, reason: 'No media is required for this snapshot.' };
    const statuses = { session: { status: 'FOUND' as const }, group: { status: 'FOUND' as const }, composerTrigger: { status: 'FOUND' as const, count: 1 }, composerTextbox: { status: 'FOUND' as const, count: 1 }, mediaInput: mediaStatus, postButton: EMPTY_FIELD, uploadBusy: { status: (await handle.container.getByText(facebookText.uploadBusy).count().catch(() => 0)) ? 'FOUND' as const : 'NOT_TESTED' as const }, approvalSignal: { status: (await handle.container.getByText(facebookText.pendingApproval).count().catch(() => 0)) ? 'FOUND' as const : 'NOT_TESTED' as const }, acceptanceSignal: { status: (await handle.container.getByText(facebookText.accepted).count().catch(() => 0)) ? 'FOUND' as const : 'NOT_TESTED' as const } };
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
    const probe: SelectorProbeResult = { ...base, status, reason, ...statuses, postButton: postButtonStatus, editorType: entry?.editorType, contentObserved: entry?.visibleContentPresent, observedContentLength: entry?.contentLength, expectedContentLength: entry?.expectedLength, entryMethod: entry?.method, triggerStrategy: triggerResolution.strategy, triggerCandidates: triggerResolution.safeCandidates, textboxStrategy: handle.textboxStrategy, textboxCandidates: handle.textboxCandidates };
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

  async submit(page: Page, composer: ComposerHandle, baseline: SubmissionBaseline, groupUrl: string, onSubmitting: () => void, onCorrelation?: (detail: string) => void): Promise<SubmissionEvidence> {
    const button = await this.uniqueVisible([composer.container.getByRole('button', { name: facebookText.postButton }), composer.container.locator('[role="button"]').filter({ hasText: facebookText.postButton })]);
    if (!button || !await button.isEnabled().catch(() => false)) throw new PublishingError('SUBMIT_FAILED', 'A unique enabled Post button was not found in the active composer.');
    onSubmitting();
    try { await button.click({ timeout: 10000 }); } catch { throw new PublishingError('SUBMISSION_UNKNOWN', 'Post interaction result is unknown.', true); }
    try {
      const approval = page.getByText(facebookText.pendingApproval).first();
      if (await approval.isVisible({ timeout: 15000 }).catch(() => false)) return { result: 'SUBMITTED_PENDING_APPROVAL', evidence: 'Facebook displayed a post approval message.' };
      const accepted = page.getByText(facebookText.accepted).first();
      const acceptedVisible = await accepted.isVisible({ timeout: 15000 }).catch(() => false); const afterCandidates = await this.postCandidates(page); const before = new Set((baseline.candidates ?? []).map((candidate) => candidate.canonicalUrl).concat(baseline.urls)); const newCandidates = afterCandidates.filter((candidate) => !before.has(candidate.canonicalUrl)); const sameGroup = newCandidates.filter((candidate) => isTargetGroupCandidate(candidate, groupUrl)); const correlated = sameGroup.find((candidate) => candidateContentMatches(candidate.visibleText, baseline.bodyFingerprint)); const newUrl = correlated?.url; const contentMatched = Boolean(correlated);
      onCorrelation?.('POST_CANDIDATES_BEFORE=' + before.size + ';POST_CANDIDATES_AFTER=' + afterCandidates.length + ';NEW_CORRELATED_CANDIDATES=' + sameGroup.length + ';CONTENT_CORRELATED=' + contentMatched);
      if (newUrl && acceptedVisible && contentMatched) return { result: 'VERIFIED_PUBLISHED', evidence: 'Facebook displayed submission acceptance and a new target-group post candidate whose scoped text correlated with the snapshot.', postUrl: newUrl };
      if (acceptedVisible) return { result: 'SUBMITTED', evidence: 'Facebook displayed submission acceptance without correlated publication evidence.' };
      if (!await composer.container.isVisible().catch(() => false)) return { result: 'SUBMITTED', evidence: 'Composer closed after the Post interaction.' };
      return { result: 'UNKNOWN', evidence: 'Facebook did not provide conclusive submission evidence.' };
    } catch { return { result: 'UNKNOWN', evidence: 'Facebook submission evidence could not be inspected.' }; }
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
  private async boundedLocators(locator: Locator, limit: number): Promise<Locator[]> { const candidates: Locator[] = []; const count = Math.min(await locator.count().catch(() => 0), limit); for (let index = 0; index < count; index++) candidates.push(locator.nth(index)); return candidates; }
  private async visibleLocators(locator: Locator, limit: number): Promise<Locator[]> { const visible: Locator[] = []; const count = Math.min(await locator.count().catch(() => 0), limit); for (let index = 0; index < count; index++) { const candidate = locator.nth(index); if (await candidate.isVisible().catch(() => false)) visible.push(candidate); } return visible; }
  private async visibleCandidates(locators: Locator[]): Promise<Locator[]> { const visible: Locator[] = []; for (const locator of locators) { const count = Math.min(await locator.count().catch(() => 0), 10); for (let index = 0; index < count; index++) { const candidate = locator.nth(index); if (await candidate.isVisible().catch(() => false)) visible.push(candidate); } if (visible.length) break; } return visible; }
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
