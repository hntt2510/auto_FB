import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Locator, Page } from 'playwright';
import { FacebookComposerAdapter, POST_SUBMIT_MIN_OBSERVATION_MS, type ComposerHandle, type PostCandidate, type PostSubmitObservationMilestone } from './FacebookComposerAdapter';
import { facebookText } from './selectors/facebookSelectors';

type EvidenceSchedule = { composerClosedAt?: number; pendingAt?: number; acceptedAt?: number; candidateAt?: number };

function fixture(schedule: EvidenceSchedule) {
  let clickedAt: number | undefined; let clickCount = 0;
  const elapsed = () => clickedAt === undefined ? -1 : Date.now() - clickedAt;
  const empty = { count: vi.fn(async () => 0), nth: vi.fn(() => empty), isVisible: vi.fn(async () => false), filter: vi.fn(() => empty) } as unknown as Locator;
  const post = { count: vi.fn(async () => 1), nth: vi.fn(() => post), isVisible: vi.fn(async () => true), isEnabled: vi.fn(async () => true), click: vi.fn(async () => { clickCount += 1; clickedAt = Date.now(); }) } as unknown as Locator;
  const container = {
    getByRole: vi.fn(() => post),
    locator: vi.fn(() => ({ filter: vi.fn(() => empty) })),
    isVisible: vi.fn(async () => schedule.composerClosedAt === undefined || elapsed() < schedule.composerClosedAt)
  } as unknown as Locator;
  const feedback = (visibleAt?: number) => ({ first: vi.fn(() => feedbackLocator), isVisible: vi.fn(async () => visibleAt !== undefined && elapsed() >= visibleAt) } as unknown as Locator);
  let feedbackLocator = feedback();
  const page = {
    isClosed: vi.fn(() => false),
    getByText: vi.fn((pattern: RegExp) => { feedbackLocator = feedback(pattern === facebookText.pendingApproval ? schedule.pendingAt : schedule.acceptedAt); return feedbackLocator; })
  } as unknown as Page;
  const adapter = new FacebookComposerAdapter();
  const candidate: PostCandidate = { url: 'https://www.facebook.com/groups/test/posts/1', canonicalUrl: 'https://www.facebook.com/groups/test/posts/1', visibleText: 'Target body' };
  const postCandidates = vi.fn(async () => schedule.candidateAt !== undefined && elapsed() >= schedule.candidateAt ? [candidate] : []);
  (adapter as unknown as { postCandidates: () => Promise<PostCandidate[]> }).postCandidates = postCandidates;
  const composer = { container, textbox: empty } as ComposerHandle;
  const milestones: Array<{ event: PostSubmitObservationMilestone; at: number; detail?: string }> = [];
  const submit = () => adapter.submit(page, composer, { urls: [], candidates: [], bodyFingerprint: 'target body' }, 'https://www.facebook.com/groups/test', vi.fn(), (event, detail) => milestones.push({ event, at: elapsed(), detail }));
  return { submit, milestones, clickCount: () => clickCount, container, postCandidates };
}

afterEach(() => { vi.useRealTimers(); });

describe('post-submit minimum observation window', () => {
  it('keeps the operation alive for 5 seconds when verified evidence appears at 1 second', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const value = fixture({ acceptedAt: 1000, candidateAt: 1000 }); let settled = false;
    const result = value.submit().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1000); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(POST_SUBMIT_MIN_OBSERVATION_MS - 1001); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await expect(result).resolves.toMatchObject({ result: 'VERIFIED_PUBLISHED', postUrl: expect.stringContaining('/posts/1') });
    expect(value.clickCount()).toBe(1);
    expect(value.milestones.slice(0, 2).map(({ event }) => event)).toEqual(['POST_CLICKED', 'POST_OBSERVATION_STARTED']);
    expect(value.postCandidates.mock.calls.length).toBeGreaterThanOrEqual(20);
    expect(value.milestones.find(({ event }) => event === 'POST_OBSERVATION_MINIMUM_REACHED')?.at).toBeGreaterThanOrEqual(POST_SUBMIT_MIN_OBSERVATION_MS);
  });

  it('classifies a composer close at 500ms only after the minimum hold', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const value = fixture({ composerClosedAt: 500 }); let settled = false;
    const result = value.submit().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await expect(result).resolves.toMatchObject({ result: 'SUBMITTED', evidence: expect.stringContaining('Composer closed') });
    expect(value.milestones).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'COMPOSER_CLOSED' }), expect.objectContaining({ event: 'POST_OBSERVATION_MINIMUM_REACHED' })]));
    expect(value.clickCount()).toBe(1);
  });

  it('detects a correlated post that appears at 4.5 seconds', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const value = fixture({ acceptedAt: 4500, candidateAt: 4500 });
    const result = value.submit(); await vi.advanceTimersByTimeAsync(POST_SUBMIT_MIN_OBSERVATION_MS);
    await expect(result).resolves.toMatchObject({ result: 'VERIFIED_PUBLISHED' });
    expect(value.milestones.find(({ event }) => event === 'NEW_POST_CANDIDATE')?.at).toBeGreaterThanOrEqual(4500);
    expect(value.milestones.find(({ event }) => event === 'POST_CORRELATED')?.at).toBeGreaterThanOrEqual(4500);
    expect(value.clickCount()).toBe(1);
  });

  it('returns UNKNOWN after the hold when no evidence appears', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const value = fixture({});
    const result = value.submit(); await vi.advanceTimersByTimeAsync(POST_SUBMIT_MIN_OBSERVATION_MS);
    await expect(result).resolves.toMatchObject({ result: 'UNKNOWN' });
    expect(value.clickCount()).toBe(1);
  });
});
