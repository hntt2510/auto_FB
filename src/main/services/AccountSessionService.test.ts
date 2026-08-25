import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAppPaths, openDatabase } from '@main/db/database';
import { AccountRepository } from '@main/db/repositories/AccountRepository';
import { AccountSessionRepository } from '@main/db/repositories/AccountSessionRepository';
import { OnboardingRepository } from '@main/db/repositories/OnboardingRepository';
import { GroupRepository } from '@main/db/repositories/GroupRepository';
import { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import { SettingsRepository } from '@main/db/repositories/SettingsRepository';
import { OnboardingService } from './OnboardingService';
import { AccountSessionService } from './AccountSessionService';
import type { AccountService } from './AccountService';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(proxyEnabled = false) {
  const root = mkdtempSync(join(tmpdir(), 'account-session-')); roots.push(root); const db = openDatabase(createAppPaths(root)); const accounts = new AccountRepository(db); const sessions = new AccountSessionRepository(db); const onboardingRepository = new OnboardingRepository(db); const groups = new GroupRepository(db); const audit = new AuditLogRepository(db); const settings = new SettingsRepository(db); let clock = new Date('2026-01-01T00:00:00.000Z'); const id = randomUUID();
  accounts.insert({ id, name: 'Session account', profileName: `session-${id}`, profileDirectory: join(root, 'profile'), proxyEnabled, proxyProtocol: 'HTTP', proxyHost: proxyEnabled ? 'proxy.example.com' : undefined, proxyPort: proxyEnabled ? 8080 : undefined, createdAt: clock.toISOString(), updatedAt: clock.toISOString() });
  const onboarding = new OnboardingService(onboardingRepository, accounts, groups, audit, vi.fn(), () => clock); onboarding.start({ accountId: id, templateId: 'BASIC_3_DAY' });
  const browser = { isRunning: vi.fn(() => false), navigateSessionPage: vi.fn(async () => ({ accountId: id, status: 'OPENED' as const })), navigateAccountPage: vi.fn(async () => ({ accountId: id, status: 'OPENED' as const })) };
  const accountService = { browser, reportHealthResult: vi.fn(), testProxy: vi.fn(async () => ({ success: true, testedAt: clock.toISOString(), ip: '203.0.113.8' })), healthCheck: vi.fn(async () => { accounts.setHealth(id, 'READY', clock.toISOString()); return { accountId: id, status: 'READY' as const, checkedAt: clock.toISOString() }; }), open: vi.fn(async () => { accounts.setStatus(id, 'RUNNING'); return accounts.get(id)!; }), close: vi.fn(async () => { accounts.setStatus(id, 'STOPPED'); return accounts.get(id)!; }) } as unknown as AccountService;
  const service = new AccountSessionService(sessions, onboardingRepository, accounts, groups, settings, accountService, onboarding, audit, vi.fn(), () => clock);
  return { root, db, accounts, sessions, onboardingRepository, groups, audit, settings, onboarding, browser, accountService, service, id, advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); }, now: () => clock };
}

describe('operator-controlled account sessions', () => {
  it('uses a 30-minute default, validates settings, starts after health, and prevents duplicate ownership', async () => {
    const value = fixture(); expect(value.service.settings()).toEqual({ targetDurationMinutes: 30 }); expect(() => value.service.updateSettings({ targetDurationMinutes: 9 })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    const detail = await value.service.start({ accountId: value.id }); expect(detail.activeSession).toMatchObject({ status: 'ACTIVE', targetDurationSeconds: 1800, durationSeconds: 0 }); expect(value.accountService.healthCheck).toHaveBeenCalledBefore(value.accountService.open as never); expect(value.accountService.open).toHaveBeenCalledTimes(1); await expect(value.service.start({ accountId: value.id })).rejects.toMatchObject({ code: 'ACCOUNT_SESSION_ACTIVE' }); value.db.close();
  });

  it('runs proxy preflight and refuses proxy or health failures before opening a browser', async () => {
    const proxy = fixture(true); vi.mocked(proxy.accountService.testProxy).mockResolvedValueOnce({ success: false, testedAt: proxy.now().toISOString(), message: 'Proxy failed.' }); await expect(proxy.service.start({ accountId: proxy.id })).rejects.toMatchObject({ code: 'SESSION_PREFLIGHT_FAILED' }); expect(proxy.accountService.open).not.toHaveBeenCalled(); proxy.db.close();
    const health = fixture(); vi.mocked(health.accountService.healthCheck).mockResolvedValueOnce({ accountId: health.id, status: 'LOGIN_REQUIRED', checkedAt: health.now().toISOString(), reason: 'Manual user action required.' }); await expect(health.service.start({ accountId: health.id })).rejects.toMatchObject({ code: 'SESSION_PREFLIGHT_FAILED' }); expect(health.accountService.open).not.toHaveBeenCalled(); health.db.close();
  });

  it('tracks automatic time across pause/resume and completes observable system tasks', async () => {
    const value = fixture(); value.service.updateSettings({ targetDurationMinutes: 10 }); await value.service.start({ accountId: value.id }); expect(value.onboardingRepository.tasks(value.id).filter((task) => ['HEALTH_CHECK', 'OPEN_FACEBOOK'].includes(task.type) && task.dayNumber === 1).every((task) => task.status === 'DONE')).toBe(true);
    value.advance(120_000); expect(value.service.pause(value.id).activeSession).toMatchObject({ status: 'PAUSED', durationSeconds: 120 }); value.advance(60_000); value.service.resume(value.id); value.advance(480_000); const ended = value.service.end({ accountId: value.id, operatorNote: 'Operator-managed browsing only.' }); expect(ended.sessions[0]).toMatchObject({ status: 'COMPLETED', durationSeconds: 600, completionReason: 'OPERATOR_ENDED', operatorNote: 'Operator-managed browsing only.' }); expect(ended.dailyProgress[0].completed).toBe(true); expect(value.accounts.get(value.id)?.lastManualSessionAt).toBe(value.now().toISOString()); value.db.close();
  });

  it('interrupts on checkpoint, pauses onboarding, and ends when the browser closes', async () => {
    const checkpoint = fixture(); await checkpoint.service.start({ accountId: checkpoint.id }); checkpoint.accounts.setHealth(checkpoint.id, 'CHECKPOINT', checkpoint.now().toISOString(), 'Manual user action required.'); checkpoint.service.handleHealthResult({ accountId: checkpoint.id, status: 'CHECKPOINT', checkedAt: checkpoint.now().toISOString() }); expect(checkpoint.service.detail(checkpoint.id).sessions[0]).toMatchObject({ status: 'INTERRUPTED', completionReason: 'HEALTH_INTERRUPTED', endingHealthStatus: 'CHECKPOINT' }); expect(checkpoint.accounts.get(checkpoint.id)?.onboardingStatus).toBe('PAUSED'); checkpoint.db.close();
    const closed = fixture(); await closed.service.start({ accountId: closed.id }); closed.advance(5_000); closed.service.handleBrowserClosed(closed.id); expect(closed.service.detail(closed.id).sessions[0]).toMatchObject({ status: 'INTERRUPTED', completionReason: 'BROWSER_CLOSED', durationSeconds: 5 }); closed.db.close();
  });

  it('uses one running context for explicit shortcuts and only assigned groups', async () => {
    const value = fixture(); const group = value.groups.insert(randomUUID(), { name: 'Assigned', url: 'https://facebook.com/groups/assigned-session', tags: [], active: true }, value.now().toISOString()); value.groups.replaceAssignments(group.id, [value.id]); await value.service.start({ accountId: value.id }); await value.service.navigate({ accountId: value.id, destination: 'HOME' }); await value.service.navigate({ accountId: value.id, destination: 'URL', url: 'https://www.facebook.com/example' }); await value.service.openGroup(value.id, group.id); expect(value.browser.navigateSessionPage).toHaveBeenCalledTimes(2); expect(value.browser.navigateAccountPage).toHaveBeenCalledTimes(1); expect(value.accountService.open).toHaveBeenCalledTimes(1); value.browser.navigateSessionPage.mockResolvedValueOnce({ accountId: value.id, status: 'CHECKPOINT', reason: 'Manual user action required.' } as never); await value.service.navigate({ accountId: value.id, destination: 'NOTIFICATIONS' }); expect(value.accountService.reportHealthResult).toHaveBeenCalledWith(expect.objectContaining({ accountId: value.id, status: 'CHECKPOINT' })); value.db.close();
  });

  it('emergency-stops every open session and reconciles abandoned sessions after restart', async () => {
    const value = fixture(); await value.service.start({ accountId: value.id }); expect(await value.service.stopAll()).toBe(1); expect(value.service.detail(value.id).sessions[0]).toMatchObject({ status: 'INTERRUPTED', completionReason: 'EMERGENCY_STOP' }); expect(value.accountService.close).toHaveBeenCalledWith(value.id); value.db.close();
    const abandoned = fixture(); await abandoned.service.start({ accountId: abandoned.id }); abandoned.advance(30_000); expect(abandoned.service.recoverAbandoned()).toBe(1); expect(abandoned.service.detail(abandoned.id).sessions[0]).toMatchObject({ status: 'INTERRUPTED', completionReason: 'APPLICATION_RESTART', durationSeconds: 30 }); abandoned.db.close();
  });

  it('aggregates multiple sessions into one daily target and dashboard total', () => {
    const value = fixture(); const start = value.now().toISOString(); const first = randomUUID(); value.sessions.start({ id: first, accountId: value.id, onboardingDay: 1, targetDurationSeconds: 600, timestamp: start }); value.advance(300_000); value.sessions.finish(value.id, 'COMPLETED', 'OPERATOR_ENDED', 'READY', undefined, value.now().toISOString()); const second = randomUUID(); value.sessions.start({ id: second, accountId: value.id, onboardingDay: 1, targetDurationSeconds: 600, timestamp: value.now().toISOString() }); value.advance(300_000); value.sessions.finish(value.id, 'COMPLETED', 'OPERATOR_ENDED', 'READY', undefined, value.now().toISOString()); expect(value.sessions.dailyProgress(value.id, 3, 600, value.now().toISOString())[0]).toMatchObject({ durationSeconds: 600, completed: true }); expect(value.sessions.dashboard('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', value.now().toISOString())).toMatchObject({ sessionsToday: 2, minutesToday: 10, dailyTargetsCompleted: 1 }); value.db.close();
  });
  it('assigns sessions to elapsed onboarding days without inferring Facebook activity', async () => {
    const value = fixture(); value.service.updateSettings({ targetDurationMinutes: 10 }); await value.service.start({ accountId: value.id, targetDurationMinutes: 10 }); value.advance(600_000); value.service.end({ accountId: value.id }); await value.accountService.close(value.id); value.advance(86_400_000); const second = await value.service.start({ accountId: value.id, targetDurationMinutes: 10 }); expect(second.activeSession?.onboardingDay).toBe(2); value.advance(600_000); value.service.end({ accountId: value.id }); await value.accountService.close(value.id); value.advance(86_400_000); const third = await value.service.start({ accountId: value.id, targetDurationMinutes: 10 }); expect(third.activeSession?.onboardingDay).toBe(3); value.advance(600_000); value.service.end({ accountId: value.id }); expect(value.service.detail(value.id).eligibility).toEqual({ eligible: true, requiredDaysCompleted: true, healthReady: true, proxyReady: true, noActiveCheckpoint: true }); value.db.close();
  });
});
