import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AssignmentAccount, FacebookGroup, GroupFilter, GroupInput } from '@shared/types';
import { normalizeFacebookGroupUrl, normalizeTags } from '@shared/groupUrl';

type GroupRow = { id: string; name: string; url: string; normalized_url: string; facebook_group_id: string | null; notes: string | null; active: number; assigned_accounts_count: number; tags: string | null; created_at: string; updated_at: string };
type AssignmentRow = { id: string; name: string; status: AssignmentAccount['status']; last_health_status: AssignmentAccount['lastHealthStatus'] | null };

function mapGroup(row: GroupRow): FacebookGroup {
  return { id: row.id, name: row.name, url: row.url, normalizedUrl: row.normalized_url, facebookGroupId: row.facebook_group_id ?? undefined,
    notes: row.notes ?? undefined, tags: row.tags ? row.tags.split('\u001f').filter(Boolean) : [], active: Boolean(row.active),
    assignedAccountsCount: row.assigned_accounts_count, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapAssignment(row: AssignmentRow): AssignmentAccount {
  return { id: row.id, name: row.name, status: row.status, lastHealthStatus: row.last_health_status ?? undefined };
}

const select = `SELECT g.*, (SELECT COUNT(*) FROM account_groups ag WHERE ag.group_id = g.id AND ag.enabled = 1) AS assigned_accounts_count,
  (SELECT GROUP_CONCAT(gt.tag, char(31)) FROM group_tags gt WHERE gt.group_id = g.id) AS tags FROM groups g`;

export class GroupRepository {
  constructor(private readonly db: Database.Database) {}

  list(filter: GroupFilter = {}): FacebookGroup[] {
    const conditions: string[] = []; const params: Record<string, string | number> = {};
    if (filter.search) { conditions.push('(g.name LIKE @search OR g.normalized_url LIKE @search)'); params.search = `%${filter.search}%`; }
    if (filter.tag) { conditions.push('EXISTS (SELECT 1 FROM group_tags ft WHERE ft.group_id = g.id AND ft.tag = @tag)'); params.tag = filter.tag.toLowerCase(); }
    if (filter.active !== undefined) { conditions.push('g.active = @active'); params.active = filter.active ? 1 : 0; }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    return (this.db.prepare(`${select}${where} ORDER BY g.updated_at DESC`).all(params) as GroupRow[]).map(mapGroup);
  }

  get(id: string): FacebookGroup | undefined {
    const row = this.db.prepare(`${select} WHERE g.id = ?`).get(id) as GroupRow | undefined;
    return row ? mapGroup(row) : undefined;
  }

  getByNormalizedUrl(normalizedUrl: string): FacebookGroup | undefined {
    const row = this.db.prepare(`${select} WHERE g.normalized_url = ?`).get(normalizedUrl) as GroupRow | undefined;
    return row ? mapGroup(row) : undefined;
  }

  insert(id: string, input: GroupInput, timestamp: string): FacebookGroup {
    const normalized = normalizeFacebookGroupUrl(input.url);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO groups (id, name, url, normalized_url, facebook_group_id, notes, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.name, input.url, normalized.normalizedUrl, normalized.facebookGroupId ?? null, input.notes ?? null, input.active === false ? 0 : 1, timestamp, timestamp);
      this.replaceTags(id, input.tags);
    })();
    return this.get(id)!;
  }

  insertMany(inputs: GroupInput[]): string[] {
    const ids: string[] = [];
    this.db.transaction(() => {
      const insertGroup = this.db.prepare(`INSERT INTO groups (id, name, url, normalized_url, facebook_group_id, notes, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertTag = this.db.prepare('INSERT INTO group_tags (group_id, tag) VALUES (?, ?)');
      for (const input of inputs) {
        const id = randomUUID(); const timestamp = new Date().toISOString(); const normalized = normalizeFacebookGroupUrl(input.url);
        insertGroup.run(id, input.name, input.url, normalized.normalizedUrl, normalized.facebookGroupId ?? null, input.notes ?? null, input.active === false ? 0 : 1, timestamp, timestamp);
        for (const tag of normalizeTags(input.tags)) insertTag.run(id, tag);
        ids.push(id);
      }
    })();
    return ids;
  }

  update(id: string, input: GroupInput, timestamp: string): FacebookGroup {
    const normalized = normalizeFacebookGroupUrl(input.url);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE groups SET name = ?, url = ?, normalized_url = ?, facebook_group_id = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?`)
        .run(input.name, input.url, normalized.normalizedUrl, normalized.facebookGroupId ?? null, input.notes ?? null, input.active === false ? 0 : 1, timestamp, id);
      this.replaceTags(id, input.tags);
    })();
    return this.get(id)!;
  }

  setActive(id: string, active: boolean): FacebookGroup {
    this.db.prepare('UPDATE groups SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, new Date().toISOString(), id);
    return this.get(id)!;
  }

  replaceTags(groupId: string, tags: string[]): void {
    this.db.prepare('DELETE FROM group_tags WHERE group_id = ?').run(groupId);
    const insert = this.db.prepare('INSERT INTO group_tags (group_id, tag) VALUES (?, ?)');
    for (const tag of normalizeTags(tags)) insert.run(groupId, tag);
  }

  assignments(groupId: string): AssignmentAccount[] {
    return this.db.prepare(`SELECT a.id, a.name, a.status, a.last_health_status FROM accounts a JOIN account_groups ag ON ag.account_id = a.id WHERE ag.group_id = ? AND ag.enabled = 1 ORDER BY a.name COLLATE NOCASE`)
      .all(groupId).map((row) => mapAssignment(row as AssignmentRow));
  }

  replaceAssignments(groupId: string, accountIds: string[]): AssignmentAccount[] {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM account_groups WHERE group_id = ?').run(groupId);
      const insert = this.db.prepare('INSERT INTO account_groups (account_id, group_id, enabled, created_at) VALUES (?, ?, 1, ?)');
      const timestamp = new Date().toISOString();
      for (const id of [...new Set(accountIds)]) insert.run(id, groupId, timestamp);
    })();
    return this.assignments(groupId);
  }

  forAccount(accountId: string): FacebookGroup[] {
    return (this.db.prepare(`${select} JOIN account_groups ag ON ag.group_id = g.id WHERE ag.account_id = ? AND ag.enabled = 1 ORDER BY g.name COLLATE NOCASE`).all(accountId) as GroupRow[]).map(mapGroup);
  }

  replaceAccountGroups(accountId: string, groupIds: string[]): FacebookGroup[] {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM account_groups WHERE account_id = ?').run(accountId);
      const insert = this.db.prepare('INSERT INTO account_groups (account_id, group_id, enabled, created_at) VALUES (?, ?, 1, ?)');
      const timestamp = new Date().toISOString();
      for (const id of [...new Set(groupIds)]) insert.run(accountId, id, timestamp);
    })();
    return this.forAccount(accountId);
  }

  hasActiveQueueItems(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM queue_items WHERE group_id = ? AND status IN ('PENDING', 'PAUSED', 'RUNNING', 'SUBMITTED', 'NEEDS_ATTENTION') LIMIT 1").get(id));
  }

  delete(id: string): void { this.db.prepare('DELETE FROM groups WHERE id = ?').run(id); }
}
