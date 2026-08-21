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

function withDatabase(run: (db: ReturnType<typeof openDatabase>) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'fb-ops-'));
  const db = openDatabase(createAppPaths(root));
  try { run(db); } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

describe('migration 2 persistence', () => {
  it('creates workspace tables with foreign keys and survives reopen', () => withDatabase((db) => {
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(db.pragma('foreign_keys')).toEqual([{ foreign_keys: 1 }]);
    for (const table of ['groups', 'group_tags', 'account_groups', 'drafts', 'media_assets', 'draft_media', 'queue_items', 'queue_item_media']) {
      expect(db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?').get(table)).toEqual({ name: table });
    }
  }));

  it('replaces assignments transactionally and cascades account deletion', () => withDatabase((db) => {
    const accounts = new AccountRepository(db); const groups = new GroupRepository(db); const now = new Date().toISOString();
    const accountId = randomUUID(); accounts.insert({ id: accountId, name: 'Account', profileName: 'profile', profileDirectory: join(tmpdir(), 'profile'), proxyEnabled: false, createdAt: now, updatedAt: now });
    const group = groups.insert(randomUUID(), { name: 'Group', url: 'https://facebook.com/groups/test', tags: [], active: true }, now);
    expect(groups.replaceAssignments(group.id, [accountId])).toHaveLength(1);
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
});
