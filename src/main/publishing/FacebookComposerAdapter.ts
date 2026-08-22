import type { Locator, Page } from 'playwright';
import { SessionHealthService } from '@main/browser/SessionHealthService';
import { normalizeFacebookGroupUrl } from '@shared/groupUrl';
import { PublishingError } from './PublishingError';
import { FACEBOOK_SELECTORS_VERSION, facebookText } from './selectors/facebookSelectors';

export type SubmissionEvidence = { result: 'SUBMITTED' | 'SUBMITTED_PENDING_APPROVAL' | 'VERIFIED_PUBLISHED' | 'UNKNOWN'; evidence: string; postUrl?: string };

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

  async openComposer(page: Page): Promise<Locator> {
    const trigger = await this.uniqueVisible([
      page.getByRole('button', { name: facebookText.composerTrigger }),
      page.locator('[role="button"]').filter({ hasText: facebookText.composerTrigger })
    ]);
    if (!trigger) throw new PublishingError('COMPOSER_NOT_FOUND', 'Facebook group composer was not found.');
    await trigger.click();
    const textbox = await this.uniqueVisible([
      page.getByRole('textbox', { name: facebookText.composerTextbox }),
      page.locator('[role="dialog"] [role="textbox"]'),
      page.locator('[contenteditable="true"][role="textbox"]')
    ]);
    if (!textbox) throw new PublishingError('COMPOSER_NOT_FOUND', 'Facebook composer textbox was not found.');
    return textbox;
  }

  async fillContent(textbox: Locator, body: string, linkUrl?: string): Promise<void> {
    const content = linkUrl && !body.includes(linkUrl) ? `${body}${body ? '\n\n' : ''}${linkUrl}` : body;
    try { await textbox.fill(content); } catch { throw new PublishingError('CONTENT_FILL_FAILED', 'Unable to fill the Facebook composer.'); }
  }

  async uploadMedia(page: Page, paths: string[], hasVideo: boolean, videoTimeoutSeconds: number): Promise<void> {
    if (!paths.length) return;
    const input = page.locator('input[type="file"]').first();
    if (!await input.count()) throw new PublishingError('MEDIA_UPLOAD_FAILED', 'Facebook media input was not found.');
    try { await input.setInputFiles(paths); } catch { throw new PublishingError('MEDIA_UPLOAD_FAILED', 'Facebook rejected the selected media.'); }
    const timeout = hasVideo ? videoTimeoutSeconds * 1000 : 120000;
    const busy = page.getByText(facebookText.uploadBusy).first();
    try { if (await busy.isVisible().catch(() => false)) await busy.waitFor({ state: 'hidden', timeout }); }
    catch { throw new PublishingError('MEDIA_UPLOAD_TIMEOUT', 'Facebook media processing did not finish safely.'); }
  }

  async submit(page: Page, onSubmitting: () => void): Promise<SubmissionEvidence> {
    const button = await this.uniqueVisible([page.getByRole('button', { name: facebookText.postButton })]);
    if (!button || !await button.isEnabled().catch(() => false)) throw new PublishingError('SUBMIT_FAILED', 'A unique enabled Post button was not found.');
    onSubmitting();
    try { await button.click({ timeout: 10000 }); } catch { throw new PublishingError('SUBMISSION_UNKNOWN', 'Post interaction result is unknown.', true); }
    try {
      const approval = page.getByText(facebookText.pendingApproval).first();
      if (await approval.isVisible({ timeout: 15000 }).catch(() => false)) return { result: 'SUBMITTED_PENDING_APPROVAL', evidence: 'Facebook displayed a post approval message.' };
      const accepted = page.getByText(facebookText.accepted).first();
      if (await accepted.isVisible({ timeout: 15000 }).catch(() => false)) {
        const postUrl = await this.observedPostUrl(page); return postUrl ? { result: 'VERIFIED_PUBLISHED', evidence: 'Facebook displayed submission evidence and an observed post link.', postUrl } : { result: 'SUBMITTED', evidence: 'Facebook displayed submission acceptance.' };
      }
      const dialog = page.locator('[role="dialog"]');
      if (!await dialog.isVisible().catch(() => false)) return { result: 'SUBMITTED', evidence: 'Composer closed after the Post interaction.' };
      return { result: 'UNKNOWN', evidence: 'Facebook did not provide conclusive submission evidence.' };
    } catch { return { result: 'UNKNOWN', evidence: 'Facebook submission evidence could not be inspected.' }; }
  }

  private async observedPostUrl(page: Page): Promise<string | undefined> {
    const hrefs = await page.locator('a[href*="/posts/"], a[href*="permalink"], a[href*="story_fbid"]').evaluateAll((nodes) => nodes.map((node) => (node as HTMLAnchorElement).href).filter(Boolean)).catch(() => [] as string[]);
    return hrefs.find((href) => { try { const url = new URL(href); return ['facebook.com', 'www.facebook.com'].includes(url.hostname.toLowerCase()); } catch { return false; } });
  }

  private async uniqueVisible(locators: Locator[]): Promise<Locator | undefined> {
    const visible: Locator[] = [];
    for (const locator of locators) {
      const count = Math.min(await locator.count().catch(() => 0), 10);
      for (let index = 0; index < count; index++) { const candidate = locator.nth(index); if (await candidate.isVisible().catch(() => false)) visible.push(candidate); }
      if (visible.length) break;
    }
    return visible.length === 1 ? visible[0] : undefined;
  }
}
