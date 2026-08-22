import type { Locator, Page } from 'playwright';
import { SessionHealthService } from '@main/browser/SessionHealthService';
import { normalizeFacebookGroupUrl } from '@shared/groupUrl';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { SelectorProbeField, SelectorProbeResult } from '@shared/types';
import { PublishingError } from './PublishingError';
import { FACEBOOK_SELECTORS_VERSION, facebookText } from './selectors/facebookSelectors';

export type PostCandidate = { url: string; canonicalUrl: string; container?: Locator; visibleText?: string; groupIdentifier?: string };
export type SubmissionEvidence = { result: 'SUBMITTED' | 'SUBMITTED_PENDING_APPROVAL' | 'VERIFIED_PUBLISHED' | 'UNKNOWN'; evidence: string; postUrl?: string };
export type ComposerHandle = { container: Locator; textbox: Locator };
export type SubmissionBaseline = { urls: string[]; bodyFingerprint: string; candidates?: PostCandidate[] };

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

export async function probePostButton(candidates: Locator[], contentFilled = true, timeoutMs = 4000): Promise<SelectorProbeField> {
  if (candidates.length > 1) return { status: 'AMBIGUOUS', count: candidates.length, reason: 'Multiple composer-scoped Post buttons were found.' };
  const button = candidates[0];
  if (!button) return { status: 'MISSING', count: 0, reason: 'No unique composer-scoped Post button was found.' };
  const enabled = contentFilled ? await waitForEnabled(button, timeoutMs) : await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false);
  return enabled
    ? { status: 'FOUND', count: 1, enabled: true }
    : { status: 'MISSING', count: 1, enabled: false, reason: 'Post button was found but remained disabled after content fill.' };
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

  async openComposer(page: Page): Promise<ComposerHandle> {
    const trigger = await this.uniqueVisible([
      page.getByRole('button', { name: facebookText.composerTrigger }),
      page.locator('[role="button"]').filter({ hasText: facebookText.composerTrigger })
    ]);
    if (!trigger) throw new PublishingError('COMPOSER_NOT_FOUND', 'Facebook group composer was not found.');
    await trigger.click();
    const container = await this.findComposerContainer(page);
    if (!container) throw new PublishingError('COMPOSER_NOT_FOUND', 'Facebook composer container was not found.');
    const textbox = await this.findTextbox(container);
    if (!textbox) throw new PublishingError('COMPOSER_NOT_FOUND', 'Facebook composer textbox was not found.');
    return { container, textbox };
  }

  async preflight(page: Page, item: QueueRecord, fillContent = false): Promise<{ probe: SelectorProbeResult; filledContent: boolean; handle?: ComposerHandle }> {
    const checkedAt = new Date().toISOString();
    const base = { id: undefined, accountId: item.accountId ?? '', groupId: item.groupId ?? '', selectorVersion: this.selectorsVersion, checkedAt, warnings: [] as string[] };
    if (fillContent && !hasPublishableContent(item)) {
      return { probe: { ...base, status: 'MISSING', session: { status: 'NOT_TESTED', reason: 'EMPTY_PUBLISH_CONTENT' }, group: { status: 'NOT_TESTED' }, composerTrigger: { status: 'NOT_TESTED' }, composerTextbox: { status: 'NOT_TESTED' }, mediaInput: { status: 'NOT_TESTED' }, postButton: { status: 'MISSING', reason: 'EMPTY_PUBLISH_CONTENT' }, uploadBusy: EMPTY_FIELD, approvalSignal: EMPTY_FIELD, acceptanceSignal: EMPTY_FIELD }, filledContent: false };
    }
    try { await this.openGroup(page, item.groupUrl); }
    catch (error) { const reason = error instanceof Error ? error.message : 'Group could not be opened.'; return { probe: { ...base, status: error instanceof PublishingError && error.code === 'ACCOUNT_CHECKPOINT' ? 'MISSING' : 'NOT_TESTED', session: { status: error instanceof PublishingError && error.code === 'ACCOUNT_LOGIN_REQUIRED' ? 'MISSING' : 'FOUND' }, group: { status: 'MISSING', reason }, composerTrigger: EMPTY_FIELD, composerTextbox: EMPTY_FIELD, mediaInput: EMPTY_FIELD, postButton: EMPTY_FIELD, uploadBusy: EMPTY_FIELD, approvalSignal: EMPTY_FIELD, acceptanceSignal: EMPTY_FIELD }, filledContent: false }; }
    const triggerCandidates = await this.visibleCandidates([page.getByRole('button', { name: facebookText.composerTrigger }), page.locator('[role="button"]').filter({ hasText: facebookText.composerTrigger })]);
    if (triggerCandidates.length !== 1) return { probe: { ...base, status: triggerCandidates.length > 1 ? 'AMBIGUOUS' : 'MISSING', session: { status: 'FOUND' }, group: { status: 'FOUND' }, composerTrigger: { status: triggerCandidates.length > 1 ? 'AMBIGUOUS' : 'MISSING', count: triggerCandidates.length }, composerTextbox: EMPTY_FIELD, mediaInput: EMPTY_FIELD, postButton: EMPTY_FIELD, uploadBusy: EMPTY_FIELD, approvalSignal: EMPTY_FIELD, acceptanceSignal: EMPTY_FIELD }, filledContent: false };
    let handle: ComposerHandle;
    try { handle = await this.openComposer(page); } catch (error) { const reason = error instanceof Error ? error.message : 'Textbox was not found.'; const ambiguous = /multiple/i.test(reason); return { probe: { ...base, status: ambiguous ? 'AMBIGUOUS' : 'MISSING', session: { status: 'FOUND' }, group: { status: 'FOUND' }, composerTrigger: { status: 'FOUND', count: 1 }, composerTextbox: { status: ambiguous ? 'AMBIGUOUS' : 'MISSING', reason }, mediaInput: EMPTY_FIELD, postButton: EMPTY_FIELD, uploadBusy: EMPTY_FIELD, approvalSignal: EMPTY_FIELD, acceptanceSignal: EMPTY_FIELD }, filledContent: false }; }
    const mediaInputCandidates = await this.visibleCandidates([handle.container.locator('input[type="file"]')]);
    const mediaInput = mediaInputCandidates.length === 1 ? mediaInputCandidates[0] : undefined;
    const requiresMedia = item.media.length > 0;
    const mediaStatus = mediaInput ? { status: 'FOUND' as const, count: 1 } : mediaInputCandidates.length > 1 ? { status: 'AMBIGUOUS' as const, count: mediaInputCandidates.length } : requiresMedia ? { status: 'MISSING' as const, count: 0 } : { status: 'NOT_TESTED' as const, count: 0, reason: 'No media is required for this snapshot.' };
    const statuses = { session: { status: 'FOUND' as const }, group: { status: 'FOUND' as const }, composerTrigger: { status: 'FOUND' as const, count: 1 }, composerTextbox: { status: 'FOUND' as const, count: 1 }, mediaInput: mediaStatus, postButton: EMPTY_FIELD, uploadBusy: { status: (await handle.container.getByText(facebookText.uploadBusy).count().catch(() => 0)) ? 'FOUND' as const : 'NOT_TESTED' as const }, approvalSignal: { status: (await handle.container.getByText(facebookText.pendingApproval).count().catch(() => 0)) ? 'FOUND' as const : 'NOT_TESTED' as const }, acceptanceSignal: { status: (await handle.container.getByText(facebookText.accepted).count().catch(() => 0)) ? 'FOUND' as const : 'NOT_TESTED' as const } };
    let filled = false;
    if (fillContent) { await this.fillContent(handle.textbox, item.body, item.linkUrl); filled = true; }
    const postButtonCandidates = await this.visibleCandidates([handle.container.getByRole('button', { name: facebookText.postButton }), handle.container.locator('[role="button"]').filter({ hasText: facebookText.postButton })]);
    const postButtonStatus = await probePostButton(postButtonCandidates, fillContent);
    const required: string[] = [statuses.composerTextbox.status, postButtonStatus.status]; if (requiresMedia) required.push(statuses.mediaInput.status); const status = required.includes('MISSING') ? 'MISSING' : required.includes('AMBIGUOUS') ? 'AMBIGUOUS' : 'FOUND';
    const dismissalWarning = await this.dismissComposer(page, handle.container);
    if (dismissalWarning) base.warnings.push(dismissalWarning);
    return { probe: { ...base, status, ...statuses, postButton: postButtonStatus }, filledContent: filled, handle };
  }

  async captureBaseline(page: Page, body: string): Promise<SubmissionBaseline> {
    const candidates = await this.postCandidates(page);
    return { urls: candidates.map((candidate) => candidate.canonicalUrl), candidates, bodyFingerprint: this.fingerprint(body) };
  }

  async fillContent(textboxOrHandle: Locator | ComposerHandle, body: string, linkUrl?: string): Promise<void> {
    const textbox = 'textbox' in textboxOrHandle ? textboxOrHandle.textbox : textboxOrHandle;
    const content = linkUrl && !this.containsLink(body, linkUrl) ? `${body}${body ? '\n\n' : ''}${linkUrl}` : body;
    try { await textbox.fill(content); } catch { throw new PublishingError('CONTENT_FILL_FAILED', 'Unable to fill the Facebook composer.'); }
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

  private async findComposerContainer(page: Page): Promise<Locator | undefined> {
    const dialogs = page.locator('[role="dialog"]'); const count = Math.min(await dialogs.count().catch(() => 0), 10); const visible: Locator[] = [];
    for (let index = 0; index < count; index++) { const dialog = dialogs.nth(index); if (await dialog.isVisible().catch(() => false) && await this.findTextbox(dialog)) visible.push(dialog); }
    if (visible.length === 1) return visible[0];
    if (visible.length > 1) throw new PublishingError('COMPOSER_NOT_FOUND', 'Multiple Facebook composers are visible.');
    const forms = page.locator('form'); const formCount = Math.min(await forms.count().catch(() => 0), 10); for (let index = 0; index < formCount; index++) { const form = forms.nth(index); if (await form.isVisible().catch(() => false) && await this.findTextbox(form)) return form; }
    return undefined;
  }

  private async findTextbox(scope: Locator): Promise<Locator | undefined> { return this.uniqueVisible([scope.getByRole('textbox', { name: facebookText.composerTextbox }), scope.locator('[contenteditable="true"][role="textbox"]'), scope.locator('[contenteditable="true"]')]); }
  private async dismissComposer(page: Page, container: Locator): Promise<string | undefined> {
    const close = await this.uniqueVisible([container.getByRole('button', { name: /close|cancel|discard/i }), container.locator('[aria-label*="Close" i]')]);
    if (close) await close.click().catch(() => undefined);
    else await page.keyboard.press('Escape').catch(() => undefined);
    const discard = await this.uniqueVisible([page.getByRole('button', { name: /discard post|discard/i }), page.getByText(/discard post/i)]);
    if (discard) await discard.click().catch(() => undefined);
    if (await container.isVisible().catch(() => false)) return 'Composer could not be safely dismissed after preflight.';
    return undefined;
  }
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
