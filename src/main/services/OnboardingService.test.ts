import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppPaths, openDatabase } from '@main/db/database';
import { AccountRepository } from '@main/db/repositories/AccountRepository';
import { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import { GroupRepository } from '@main/db/repositories/GroupRepository';
import { OnboardingRepository } from '@main/db/repositories/OnboardingRepository';
import { OnboardingService } from './OnboardingService';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'onboarding-')); roots.push(root); const db = openDatabase(createAppPaths(root)); const accounts = new AccountRepository(db); const groups = new GroupRepository(db); const audit = new AuditLogRepository(db); const repository = new OnboardingRepository(db); let clock = new Date('2026-01-01T00:00:00.000Z'); const notify = vi.fn(); const service = new OnboardingService(repository, accounts, groups, audit, notify, () => clock); const id = randomUUID();
  accounts.insert({ id, name: 'Manual account', profileName: 'manual-account', profileDirectory: join(root, 'profile'), proxyEnabled: false, createdAt: clock.toISOString(), updatedAt: clock.toISOString() });
  return { root, db, accounts, groups, audit, repository, service, notify, id, advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); } };
}

describe('human-in-the-loop account onboarding', () => {
  it('starts NEW accounts, tracks checklist/session state, pauses on health, resumes, and marks READY explicitly', () => {
    const value = fixture(); expect(value.accounts.get(value.id)?.onboardingStatus).toBe('NEW');
    let detail = value.service.start({ accountId: value.id, templateId: 'BASIC_3_DAY' }); expect(detail.account.onboardingStatus).toBe('WARMING'); expect(detail.currentDay).toBe(1); expect(detail.tasks.length).toBeGreaterThan(5);
    const first = detail.tasks[0]; expect(value.service.setTaskStatus({ taskId: first.id, status: 'DONE' }).status).toBe('DONE'); const second = detail.tasks[1]; expect(value.service.setTaskStatus({ taskId: second.id, status: 'SKIPPED', note: 'Operator deferred this item.' }).status).toBe('SKIPPED');
    const session = value.service.startSession(value.id); value.advance(125_000); expect(value.service.stopSession(value.id)).toMatchObject({ id: session.id, durationSeconds: 125 }); expect(value.accounts.get(value.id)?.lastManualSessionAt).toBe('2026-01-01T00:02:05.000Z');
    value.accounts.setHealth(value.id, 'CHECKPOINT', new Date().toISOString(), 'Manual user action required.'); expect(value.service.syncHealthPauses()).toBe(1); expect(value.accounts.get(value.id)).toMatchObject({ onboardingStatus: 'PAUSED', onboardingPausedReason: 'Facebook checkpoint requires manual action.' });
    expect(() => value.service.resume(value.id)).toThrow(/successful health check/i); value.accounts.setHealth(value.id, 'READY', new Date().toISOString()); expect(value.service.resume(value.id).account.onboardingStatus).toBe('WARMING');
    detail = value.service.markReady(value.id); expect(detail.account.onboardingStatus).toBe('READY');
    expect(value.audit.list({}).map((entry) => entry.eventType)).toEqual(expect.arrayContaining(['WARMUP_STARTED', 'WARMUP_TASK_DONE', 'WARMUP_TASK_SKIPPED', 'MANUAL_SESSION_STARTED', 'MANUAL_SESSION_ENDED', 'WARMUP_PAUSED', 'WARMUP_RESUMED', 'WARMUP_MARKED_READY']));
    value.db.close();
  });

  it('supports assigned-group task configuration, custom guidance, notes, and restores READY after a health pause', () => {
    const value = fixture(); const group = value.groups.insert(randomUUID(), { name: 'Assigned group', url: 'https://facebook.com/groups/manual-onboarding', tags: [], active: true }, new Date().toISOString()); value.groups.replaceAssignments(group.id, [value.id]);
    let detail = value.service.start({ accountId: value.id, templateId: 'BASIC_5_DAY' }); const groupTask = detail.tasks.find((task) => task.type === 'OPEN_GROUP')!; const updated = value.service.updateTask({ taskId: groupTask.id, title: 'Review the assigned group manually', description: 'Operator guidance only.', groupId: group.id }); expect(updated).toMatchObject({ groupId: group.id, groupName: 'Assigned group' });
    detail = value.service.updateNotes(value.id, 'Profile completed.'); expect(detail.account.onboardingNotes).toBe('Profile completed.'); value.service.markReady(value.id); value.accounts.setStatus(value.id, 'ERROR', 'Browser failed.'); expect(value.service.syncHealthPauses()).toBe(1); value.accounts.setStatus(value.id, 'STOPPED'); expect(value.service.resume(value.id).account.onboardingStatus).toBe('READY'); value.db.close();
  });

  it('enforces one active manual timer and retains state after reopen', () => {
    const value = fixture(); value.service.start({ accountId: value.id, templateId: 'BASIC_3_DAY' }); value.service.startSession(value.id); expect(() => value.service.startSession(value.id)).toThrowError(expect.objectContaining({ code: 'MANUAL_SESSION_ACTIVE' })); value.db.close();
    const reopened = openDatabase(createAppPaths(value.root)); expect(new AccountRepository(reopened).get(value.id)?.onboardingStatus).toBe('WARMING'); expect(new OnboardingRepository(reopened).activeSession(value.id)).toBeDefined(); reopened.close();
  });
});
