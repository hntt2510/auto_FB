import type { Page } from 'playwright';
import type { HealthStatus } from '@shared/types';

export type SessionSignals = { url: string; text: string; loginForm: boolean; appNavigation: boolean };
export type SessionClassification = { status: HealthStatus; reason?: string };

const CHECKPOINT_RE = /checkpoint|security verification|confirm identity|account recovery|account locked|suspicious login|captcha|unlock your account/i;
const LOGIN_RE = /\/login(?:[/?#]|$)|log in to facebook|create new account/i;

export function classifySession(signals: SessionSignals): SessionClassification {
  if (CHECKPOINT_RE.test(signals.url) || CHECKPOINT_RE.test(signals.text)) return { status: 'CHECKPOINT', reason: 'Manual user action required.' };
  if (LOGIN_RE.test(signals.url) || signals.loginForm || /log in|forgot password/i.test(signals.text)) return { status: 'LOGIN_REQUIRED' };
  if (signals.appNavigation || /home|news feed|messenger|notifications/i.test(signals.text)) return { status: 'READY' };
  return { status: 'ERROR', reason: 'Facebook session state could not be determined safely.' };
}

export class SessionHealthService {
  async classify(page: Page): Promise<SessionClassification> {
    const url = page.url();
    const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const loginForm = await page.locator('input[name="email"], input[name="pass"]').count().then((count) => count > 0).catch(() => false);
    const appNavigation = await page.locator('[role="navigation"], [aria-label="Facebook"], a[href*="/notifications"]').count().then((count) => count > 0).catch(() => false);
    return classifySession({ url, text, loginForm, appNavigation });
  }
}
