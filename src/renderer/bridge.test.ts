import { describe, expect, it } from 'vitest';
import { isOperationalBridge, sanitizeRendererError } from './bridge';
import { RendererErrorBoundary } from './components/RendererGuards';

const bridge = {
  appBridge: { available: true as const, version: '1' },
  accountApi: { list: () => Promise.resolve([]), onChanged: () => () => undefined },
  dashboardApi: { summary: () => Promise.resolve(undefined) },
  onboardingApi: { overview: () => Promise.resolve(undefined), onChanged: () => () => undefined },
  publishApi: { status: () => Promise.resolve(undefined), onChanged: () => () => undefined },
  groupApi: { list: () => Promise.resolve([]) },
  draftApi: { list: () => Promise.resolve([]) },
  campaignApi: { list: () => Promise.resolve([]) },
  queueApi: { list: () => Promise.resolve([]) },
  settingsApi: { getPublishing: () => Promise.resolve(undefined) },
  logApi: { list: () => Promise.resolve([]) }
};

describe('renderer bootstrap guard', () => {
  it('allows a complete Electron bridge', () => expect(isOperationalBridge(bridge)).toBe(true));
  it('rejects a browser without preload APIs', () => expect(isOperationalBridge(undefined)).toBe(false));
  it('sanitizes sensitive error labels', () => expect(sanitizeRendererError(new Error('token=secret-value'))).toBe('token [redacted]'));
  it('creates a safe ErrorBoundary fallback state', () => expect(RendererErrorBoundary.getDerivedStateFromError(new Error('renderer exploded'))).toEqual({ error: 'renderer exploded' }));
});
