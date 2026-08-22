import type { Locator, Page } from 'playwright';
import { SessionHealthService } from '@main/browser/SessionHealthService';
import { normalizeFacebookGroupUrl } from '@shared/groupUrl';
import type { QueueRecord } from '@main/db/repositories/QueueRepository';
import type { SelectorProbeField, SelectorProbeResult } from '@shared/types';
import { PublishingError } from './PublishingError';
import { FACEBOOK_SELECTORS_VERSION, facebookText } from './selectors/facebookSelectors';

export type SubmissionEvidence = { result: 'SUBMITTED' | 'SUBMITTED_PENDING_APPROVAL' | 'VERIFIED_PUBLISHED' | 'UNKNOWN'; evidence: string; postUrl?: string };
export type ComposerHandle = { container: Locator; textbox: Locator };
export type SubmissionBaseline = { urls: string[]; bodyFingerprint: string };

const EMPTY_FIELD: SelectorProbeField = { status: 'NOT_TESTED' };

export function correlateNewPostUrl(after: string[], before: string[], groupUrl: string): string | undefined {
  const target = normalizeFacebookGroupUrl(groupUrl).identifier; const seen = new Set(before);
  return after.find((href) => { if (seen.has(href)) return false; try { const url = new URL(href); if (!['facebook.com', 'www.facebook.com'].includes(url.hostname.toLowerCase())) return false; return url.pathname.toLowerCase().includes(`/groups/${target.toLowerCase()}/`); } catch { return false; } });
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
    try { await this.openGroup(page, item.groupUrl); }
    catch (error) { const reason = error instanceof Error ? error.message : 'Group could not be opened.'; return { probe: { ...base, status: error instanceof PublishingError && error.code === 'ACCOUNT_CHECKPOINT' ? 'MISSING' : 'NOT_TESTED', session: { status: error instanceof PublishingError && error.code === 'ACCOUNT_LOGIN_REQUIRED' ? 'MISSING' : 'FOUND' }, group: { status: 'MISSING', reason }, composerTrigger: EMPTY_FIELD, composerTextbox: EMPTY_FIELD, mediaInput: EMPTY_FIELD, postButton: EMPTY_FIELD, uploadBusy: EMPTY_FIELD, approvalSignal: EMPTY_FIELD, acceptanceSignal: EMPTY_FIELD }, filledContent: false }; }
    const triggerCandidates = await this.visibleCandidates([page.getByRole('button', { name: facebookText.composerTrigger }), page.locator('[role="button"]').filter({ hasText: facebookText.composerTrigger })]);
    if (triggerCandidates.length !== 1) return { probe: { ...base, status: triggerCandidates.length > 1 ? 'AMBIGUOUS' : 'MISSING', session: { status: 'FOUND' }, group: { status: 'FOUND' }, composerTrigger: { status: triggerCandidates.length > 1 ? 'AMBIGUOUS' : 'MISSING', count: triggerCandidates.length }, composerTextbox: EMPTY_FIELD, mediaInput: EMPTY_FIELD, postButton: EMPTY_FIELD, uploadBusy: EMPTY_FIELD, approvalSignal: EMPTY_FIELD, acceptanceSignal: EMPTY_FIELD }, filledContent: false };
    let handle: ComposerHandle;
    try { handle = await this.openComposer(page); } catch (error) { const reason = error instanceof Error ? error.message : 'Textbox was not found.'; const ambiguous = /multiple/i.test(reason); return { probe: { ...base, status: ambiguous ? 'AMBIGUOUS' : 'MISSING', session: { status: 'FOUND' }, group: { status: 'FOUND' }, composerTrigger: { status: 'FOUND', count: 1 }, composerTextbox: { status: ambiguous ? 'AMBIGUOUS' : 'MISSING', reason }, mediaInput: EMPTY_FIELD, postButton: EMPTY_FIELD, uploadBusy: EMPTY_FIELD, approvalSignal: EMPTY_FIELD, acceptanceSignal: EMPTY_FIELD }, filledContent: false }; }
    const mediaInput = await this.uniqueVisible([handle.container.locator('input[type="file"]')]);
    const postButton = await this.uniqueVisible([handle.container.getByRole('button', { name: facebookText.postButton }), handle.container.locator('[role="button"]').filter({ hasText: facebookText.postButton })]);
    const statuses = { session: { status: 'FOUND' as const }, group: { status: 'FOUND' as const }, composerTrigger: { status: 'FOUND' as const, count: 1 }, composerTextbox: { status: 'FOUND' as const, count: 1 }, mediaInput: mediaInput ? { status: 'FOUND' as const, count: 1 } : { status: 'MISSING' as const, count: 0 }, postButton: postButton ? { status: await postButton.isEnabled().catch(() => false) ? 'FOUND' as const : 'MISSING' as const, count: 1 } : { status: 'MISSING' as const, count: 0 }, uploadBusy: { status: (await handle.container.getByText(facebookText.uploadBusy).count().catch(() => 0)) ? 'FOUND' as const : 'NOT_TESTED' as const }, approvalSignal: { status: (await handle.container.getByText(facebookText.pendingApproval).count().catch(() => 0)) ? 'FOUND' as const : 'NOT_TESTED' as const }, acceptanceSignal: { status: (await handle.container.getByText(facebookText.accepted).count().catch(() => 0)) ? 'FOUND' as const : 'NOT_TESTED' as const } };
    let filled = false;
    if (fillContent) { await this.fillContent(handle.textbox, item.body, item.linkUrl); filled = true; }
    const required: string[] = [statuses.composerTextbox.status, statuses.postButton.status]; const status = required.includes('MISSING') ? 'MISSING' : required.includes('AMBIGUOUS') ? 'AMBIGUOUS' : 'FOUND';
    await this.dismissComposer(page, handle.container);
    return { probe: { ...base, status, ...statuses }, filledContent: filled, handle };
  }

  async captureBaseline(page: Page, body: string): Promise<SubmissionBaseline> { return { urls: await this.candidateUrls(page), bodyFingerprint: this.fingerprint(body) }; }

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

  async submit(page: Page, composer: ComposerHandle, baseline: SubmissionBaseline, groupUrl: string, onSubmitting: () => void): Promise<SubmissionEvidence> {
    const button = await this.uniqueVisible([composer.container.getByRole('button', { name: facebookText.postButton }), composer.container.locator('[role="button"]').filter({ hasText: facebookText.postButton })]);
    if (!button || !await button.isEnabled().catch(() => false)) throw new PublishingError('SUBMIT_FAILED', 'A unique enabled Post button was not found in the active composer.');
    onSubmitting();
    try { await button.click({ timeout: 10000 }); } catch { throw new PublishingError('SUBMISSION_UNKNOWN', 'Post interaction result is unknown.', true); }
    try {
      const approval = page.getByText(facebookText.pendingApproval).first();
      if (await approval.isVisible({ timeout: 15000 }).catch(() => false)) return { result: 'SUBMITTED_PENDING_APPROVAL', evidence: 'Facebook displayed a post approval message.' };
      const accepted = page.getByText(facebookText.accepted).first();
      const acceptedVisible = await accepted.isVisible({ timeout: 15000 }).catch(() => false); const afterUrls = await this.candidateUrls(page); const newUrl = this.newCorrelatedUrl(afterUrls, baseline.urls, groupUrl); const afterText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''); const normalizedAfter = this.fingerprint(afterText); const excerpt = baseline.bodyFingerprint.slice(0, 48); const contentMatched = !excerpt || normalizedAfter.includes(excerpt);
      if (newUrl && acceptedVisible && contentMatched) return { result: 'VERIFIED_PUBLISHED', evidence: 'Facebook displayed submission acceptance, matching content, and a newly observed correlated post link.', postUrl: newUrl };
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
  private async dismissComposer(page: Page, container: Locator): Promise<void> { const close = await this.uniqueVisible([container.getByRole('button', { name: /close|cancel|discard/i }), container.locator('[aria-label*="Close" i]')]); if (close) { await close.click().catch(() => undefined); return; } await page.keyboard.press('Escape').catch(() => undefined); }
  private async visibleCandidates(locators: Locator[]): Promise<Locator[]> { const visible: Locator[] = []; for (const locator of locators) { const count = Math.min(await locator.count().catch(() => 0), 10); for (let index = 0; index < count; index++) { const candidate = locator.nth(index); if (await candidate.isVisible().catch(() => false)) visible.push(candidate); } if (visible.length) break; } return visible; }
  private async candidateUrls(page: Page): Promise<string[]> { return page.locator('a[href*="/posts/"], a[href*="permalink"], a[href*="story_fbid"]').evaluateAll((nodes) => nodes.map((node) => (node as HTMLAnchorElement).href).filter(Boolean)).catch(() => [] as string[]); }
  private newCorrelatedUrl(after: string[], before: string[], groupUrl: string): string | undefined { return correlateNewPostUrl(after, before, groupUrl); }
  private containsLink(body: string, link: string): boolean { try { return body.split(/\s+/).some((value) => new URL(value).href === new URL(link).href); } catch { return body.includes(link); } }
  private fingerprint(body: string): string { return body.trim().replace(/\s+/g, ' ').slice(0, 160).toLowerCase(); }
  private async uniqueVisible(locators: Locator[]): Promise<Locator | undefined> { const visible: Locator[] = []; for (const locator of locators) { const count = Math.min(await locator.count().catch(() => 0), 10); for (let index = 0; index < count; index++) { const candidate = locator.nth(index); if (await candidate.isVisible().catch(() => false)) visible.push(candidate); } if (visible.length) break; } return visible.length === 1 ? visible[0] : undefined; }
}
