import type { AppBridge } from '@shared/types';

export type RendererBridge = {
  appBridge?: AppBridge;
  accountApi?: { list?: unknown; onChanged?: unknown };
  dashboardApi?: { summary?: unknown };
  onboardingApi?: { overview?: unknown; onChanged?: unknown };
  publishApi?: { status?: unknown; onChanged?: unknown };
  groupApi?: { list?: unknown };
  draftApi?: { list?: unknown };
  campaignApi?: { list?: unknown };
  queueApi?: { list?: unknown };
  settingsApi?: { getPublishing?: unknown };
  logApi?: { list?: unknown };
};

export function isOperationalBridge(value: RendererBridge | undefined): boolean {
  return Boolean(
    value?.appBridge?.available === true &&
    typeof value.accountApi?.list === 'function' &&
    typeof value.accountApi?.onChanged === 'function' &&
    typeof value.dashboardApi?.summary === 'function' &&
    typeof value.onboardingApi?.overview === 'function' &&
    typeof value.onboardingApi?.onChanged === 'function' &&
    typeof value.publishApi?.status === 'function' &&
    typeof value.publishApi?.onChanged === 'function' &&
    typeof value.groupApi?.list === 'function' &&
    typeof value.draftApi?.list === 'function' &&
    typeof value.campaignApi?.list === 'function' &&
    typeof value.queueApi?.list === 'function' &&
    typeof value.settingsApi?.getPublishing === 'function' &&
    typeof value.logApi?.list === 'function'
  );
}

export function sanitizeRendererError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/(password|cookie|token|access_token|secret)[^\s]*/gi, '$1 [redacted]').slice(0, 300);
}
