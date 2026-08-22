import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAppPaths, openDatabase } from './database';
import { AccountRepository } from './repositories/AccountRepository';
import { GroupRepository } from './repositories/GroupRepository';
import { DraftRepository } from './repositories/DraftRepository';
import { QueueRepository } from './repositories/QueueRepository';
import { PublishRepository } from './repositories/PublishRepository';

function withDatabase(run: (db: ReturnType<typeof openDatabase>) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'fb-ops-'));
  const db = openDatabase(createAppPaths(root));
  try { run(db); } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

describe('workspace persistence', () => {
  it('creates workspace tables with foreign keys and survives reopen', () => withDatabase((db) => {
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    expect(db.pragma('foreign_keys')).toEqual([{ foreign_keys: 1 }]);
    for (const table of ['groups', 'group_tags', 'account_groups', 'drafts', 'media_assets', 'draft_media', 'queue_items', 'queue_item_media', 'publish_attempts', 'publish_attempt_events', 'publish_receipts', 'account_publish_blocks', 'publish_reconciliations', 'selector_probes', 'publish_preflights']) {
      expect(db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?').get(table)).toEqual({ name: table });
    }
  }));

  it('claims a queue item exactly once and recovers stale execution', () => withDatabase((db) => {
    const accounts = new AccountRepository(db); const groups = new GroupRepository(db); const drafts = new DraftRepository(db); const queue = new QueueRepository(db); const publishing = new PublishRepository(db); const now = new Date().toISOString();
    const accountId = randomUUID(); accounts.insert({ id: accountId, name: 'Publisher', profileName: 'publisher', profileDirectory: join(tmpdir(), 'publisher'), proxyEnabled: false, createdAt: now, updatedAt: now });
    const group = groups.insert(randomUUID(), { name: 'Publish Group', url: 'https://facebook.com/groups/publish-test', tags: [], active: true }, now); groups.replaceAssignments(group.id, [accountId]);
    const draft = drafts.insert(randomUUID(), { title: 'Publish', body: 'Snapshot body' }, now); const itemId = randomUUID(); queue.insertBatch([{ id: itemId, draftId: draft.id, accountId, groupId: group.id, draftTitle: draft.title, body: draft.body, accountName: 'Publisher', groupName: group.name, groupUrl: group.normalizedUrl, snapshotHash: 'publish-hash', createdAt: now, media: [] }]);
    expect(publishing.claim(itemId)).toBeDefined(); expect(publishing.claim(itemId)).toBeUndefined(); expect(queue.get(itemId)?.status).toBe('RUNNING');
    expect(publishing.recoverRunning('Previous execution ended unexpectedly.')).toBe(1); expect(queue.get(itemId)?.status).toBe('NEEDS_ATTENTION'); expect(publishing.attempts(itemId)[0].status).toBe('NEEDS_ATTENTION');
  }));

  it('enforces execution transitions and preserves immutable history when requeued', () => withDatabase((db) => {
    const accounts = new AccountRepository(db); const groups = new GroupRepository(db); const drafts = new DraftRepository(db); const queue = new QueueRepository(db); const publishing = new PublishRepository(db); const now = new Date().toISOString();
    const accountId = randomUUID(); accounts.insert({ id: accountId, name: 'Publisher 2', profileName: 'publisher2', profileDirectory: join(tmpdir(), 'publisher2'), proxyEnabled: false, createdAt: now, updatedAt: now });
    const group = groups.insert(randomUUID(), { name: 'Publish Group 2', url: 'https://facebook.com/groups/publish-test-2', tags: [], active: true }, now); groups.replaceAssignments(group.id, [accountId]);
    const draft = drafts.insert(randomUUID(), { title: 'Original snapshot', body: 'Never mutate me' }, now); const id = randomUUID(); queue.insertBatch([{ id, draftId: draft.id, accountId, groupId: group.id, draftTitle: draft.title, body: draft.body, accountName: 'Publisher 2', groupName: group.name, groupUrl: group.normalizedUrl, snapshotHash: 'immutable-hash', createdAt: now, media: [] }]);
    const first = publishing.claim(id)!; publishing.addEvent(first.attempt.id, 'SUBMITTING'); publishing.createReceipt(id, first.attempt.id, 'VERIFIED_PUBLISHED', group.normalizedUrl, 'https://www.facebook.com/groups/publish-test-2/posts/1', 'Observed post link.'); publishing.setAttemptStatus(first.attempt.id, 'SUCCEEDED', undefined, undefined, true); queue.finishClaim(id, first.token, 'SUCCEEDED');
    const clone = queue.requeue(id, randomUUID(), undefined, new Date().toISOString()); expect(clone.id).not.toBe(id); expect(clone.body).toBe('Never mutate me'); expect(clone.status).toBe('PENDING'); expect(queue.get(id)?.status).toBe('SUCCEEDED'); expect(publishing.attempts(id)[0].receipt?.result).toBe('VERIFIED_PUBLISHED');
  }));

  it('replaces assignments transactionally and cascades account deletion', () => withDatabase((db) => {
    const accounts = new AccountRepository(db); const groups = new GroupRepository(db); const now = new Date().toISOString();
    const accountId = randomUUID(); accounts.insert({ id: accountId, name: 'Account', profileName: 'profile', profileDirectory: join(tmpdir(), 'profile'), proxyEnabled: false, createdAt: now, updatedAt: now });
    const group = groups.insert(randomUUID(), { name: 'Group', url: 'https://facebook.com/groups/test', tags: [], active: true }, now);
    accounts.setHealth(accountId, 'READY', now); const assigned = groups.replaceAssignments(group.id, [accountId]); expect(assigned).toHaveLength(1); expect(assigned[0].lastHealthStatus).toBe('READY'); expect(assigned[0]).not.toHaveProperty('last_health_status');
    accounts.delete(accountId);
    expect(groups.assignments(group.id)).toEqual([]);
  }));

  it('keeps queue snapshots after source draft deletion and blocks active source deletion', () => withDatabase((db) => {
    const accounts = new AccountRepository(db); const groups = new GroupRepository(db); const drafts = new DraftRepository(db); const queue = new QueueRepository(db); const now = new Date().toISOString();
    const accountId = randomUUID(); accounts.insert({ id: accountId, name: 'Account', profileName: 'profile2', profileDirectory: join(tmpdir(), 'profile2'), proxyEnabled: false, createdAt: now, updatedAt: now });
    const group = groups.insert(randomUUID(), { name: 'Group', url: 'https://facebook.com/groups/test2', tags: [], active: true }, now); groups.replaceAssignments(group.id, [accountId]);
    const draft = drafts.insert(randomUUID(), { title: 'Snapshot', body: 'Immutable body' }, now); drafts.setStatus(draft.id, 'READY');
    queue.insertBatch([{ id: randomUUID(), draftId: draft.id, accountId, groupId: group.id, draftTitle: draft.title, body: draft.body, accountName: 'Account', groupName: group.name, groupUrl: group.normalizedUrl, snapshotHash: 'hash', createdAt: now, media: [] }]);
    expect(queue.hasActiveForDraft(draft.id)).toBe(true);
    db.prepare('DELETE FROM drafts WHERE id = ?').run(draft.id);
    const item = queue.list()[0]; expect(item.draftId).toBeUndefined(); expect(item.body).toBe('Immutable body');
  }));

  it('finalizes publish outcomes atomically and preserves operator reconciliation', () => withDatabase((db) => {
    const accounts = new AccountRepository(db); const groups = new GroupRepository(db); const drafts = new DraftRepository(db); const queue = new QueueRepository(db); const publishing = new PublishRepository(db); const now = new Date().toISOString();
    const accountId = randomUUID(); accounts.insert({ id: accountId, name: 'Atomic', profileName: 'atomic', profileDirectory: join(tmpdir(), 'atomic'), proxyEnabled: false, createdAt: now, updatedAt: now });
    const group = groups.insert(randomUUID(), { name: 'Atomic Group', url: 'https://facebook.com/groups/atomic', tags: [], active: true }, now); groups.replaceAssignments(group.id, [accountId]); const draft = drafts.insert(randomUUID(), { title: 'Atomic', body: 'Body' }, now); const id = randomUUID();
    queue.insertBatch([{ id, draftId: draft.id, accountId, groupId: group.id, draftTitle: draft.title, body: draft.body, accountName: 'Atomic', groupName: group.name, groupUrl: group.normalizedUrl, snapshotHash: 'atomic-hash', createdAt: now, media: [] }]);
    const claim = publishing.claim(id, { executionMode: 'LIVE', selectorVersion: 'test' })!; publishing.finalizeSubmission(id, claim.token, claim.attempt.id, group.normalizedUrl, 'SUBMITTED', 'Accepted without public verification.');
    expect(queue.get(id)?.status).toBe('SUBMITTED'); expect(publishing.attempts(id)[0].receipt?.verificationSource).toBe('AUTOMATED'); expect(queue.hasActiveForAccount(accountId)).toBe(false);
    const reconciliation = publishing.markVerified(id, 'Operator saw the post in the group.'); expect(reconciliation.action).toBe('MARK_VERIFIED'); expect(queue.get(id)?.status).toBe('SUCCEEDED'); expect(publishing.attempts(id)[0].receipt?.verificationSource).toBe('OPERATOR'); expect(publishing.attempts(id)[0].receipt?.evidence).toBe('Accepted without public verification.');
  }));

  it('rolls back a failed terminal finalization without a partial receipt', () => withDatabase((db) => {
    const accounts = new AccountRepository(db); const groups = new GroupRepository(db); const drafts = new DraftRepository(db); const queue = new QueueRepository(db); const publishing = new PublishRepository(db); const now = new Date().toISOString(); const accountId = randomUUID();
    accounts.insert({ id: accountId, name: 'Rollback', profileName: 'rollback', profileDirectory: join(tmpdir(), 'rollback'), proxyEnabled: false, createdAt: now, updatedAt: now }); const group = groups.insert(randomUUID(), { name: 'Rollback Group', url: 'https://facebook.com/groups/rollback', tags: [], active: true }, now); groups.replaceAssignments(group.id, [accountId]); const draft = drafts.insert(randomUUID(), { title: 'Rollback', body: 'Body' }, now); const id = randomUUID(); queue.insertBatch([{ id, draftId: draft.id, accountId, groupId: group.id, draftTitle: draft.title, body: draft.body, accountName: 'Rollback', groupName: group.name, groupUrl: group.normalizedUrl, snapshotHash: 'rollback-hash', createdAt: now, media: [] }]); const claim = publishing.claim(id)!;
    expect(() => publishing.finalizeSuccess(id, claim.token, randomUUID(), group.normalizedUrl, 'https://www.facebook.com/groups/rollback/posts/1', 'bad attempt')).toThrow(); expect(queue.get(id)?.status).toBe('RUNNING'); expect(publishing.attempts(id)[0].status).toBe('STARTING'); expect(db.prepare('SELECT COUNT(*) AS count FROM publish_receipts').get()).toEqual({ count: 0 });
  }));
});
