import type Database from 'better-sqlite3';
import type { QueueFilter, QueueItem, QueueStatus, MediaType } from '@shared/types';

export type QueueMediaRecord = { id: string; type: MediaType; originalName: string; storedName: string; localPath: string; mimeType?: string; fileSize: number; sortOrder: number };
export type QueueRecord = Omit<QueueItem, 'media' | 'draftId' | 'accountId' | 'groupId'> & { draftId?: string; accountId?: string; groupId?: string; snapshotHash: string; media: QueueMediaRecord[] };
export type QueueInsert = { id: string; draftId: string; accountId: string; groupId: string; draftTitle: string; body: string; linkUrl?: string; accountName: string; groupName: string; groupUrl: string; snapshotHash: string; scheduledAt?: string; media: QueueMediaRecord[]; createdAt: string };
type QueueRow = { id: string; draft_id: string | null; account_id: string | null; group_id: string | null; draft_title_snapshot: string; body_snapshot: string; link_url_snapshot: string | null; account_name_snapshot: string; group_name_snapshot: string; group_url_snapshot: string; snapshot_hash: string; status: QueueStatus; scheduled_at: string | null; created_at: string; updated_at: string };
type QueueMediaRow = { queue_item_id: string; media_id: string; type: MediaType; original_name: string; stored_name: string; local_path: string; mime_type: string | null; file_size: number; sort_order: number };

function mapMedia(row: QueueMediaRow): QueueMediaRecord { return { id: row.media_id, type: row.type, originalName: row.original_name, storedName: row.stored_name, localPath: row.local_path, mimeType: row.mime_type ?? undefined, fileSize: row.file_size, sortOrder: row.sort_order }; }
function mapRow(row: QueueRow, media: QueueMediaRecord[] = []): QueueRecord {
  return { id: row.id, draftId: row.draft_id ?? undefined, accountId: row.account_id ?? undefined, groupId: row.group_id ?? undefined, draftTitle: row.draft_title_snapshot, body: row.body_snapshot, linkUrl: row.link_url_snapshot ?? undefined, accountName: row.account_name_snapshot, groupName: row.group_name_snapshot, groupUrl: row.group_url_snapshot, status: row.status, scheduledAt: row.scheduled_at ?? undefined, media, snapshotHash: row.snapshot_hash, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class QueueRepository {
  constructor(private readonly db: Database.Database) {}

  list(filter: QueueFilter = {}): QueueRecord[] {
    const conditions: string[] = []; const params: Record<string, string> = {};
    if (filter.search) { conditions.push('(q.draft_title_snapshot LIKE @search OR q.body_snapshot LIKE @search OR q.account_name_snapshot LIKE @search OR q.group_name_snapshot LIKE @search)'); params.search = `%${filter.search}%`; }
    if (filter.status) { conditions.push('q.status = @status'); params.status = filter.status; }
    if (filter.accountId) { conditions.push('q.account_id = @accountId'); params.accountId = filter.accountId; }
    if (filter.groupId) { conditions.push('q.group_id = @groupId'); params.groupId = filter.groupId; }
    if (filter.from) { conditions.push('q.scheduled_at >= @from'); params.from = filter.from; }
    if (filter.to) { conditions.push('q.scheduled_at <= @to'); params.to = filter.to; }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT q.* FROM queue_items q${where} ORDER BY q.scheduled_at IS NULL, q.scheduled_at ASC, q.created_at DESC LIMIT 1000`).all(params) as QueueRow[];
    return this.attachMedia(rows);
  }

  get(id: string): QueueRecord | undefined {
    const row = this.db.prepare('SELECT * FROM queue_items WHERE id = ?').get(id) as QueueRow | undefined;
    return row ? mapRow(row, this.media(id)) : undefined;
  }

  insertBatch(items: QueueInsert[]): QueueRecord[] {
    this.db.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO queue_items (id, draft_id, account_id, group_id, draft_title_snapshot, body_snapshot, link_url_snapshot, account_name_snapshot, group_name_snapshot, group_url_snapshot, snapshot_hash, status, scheduled_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`);
      const mediaInsert = this.db.prepare('INSERT INTO queue_item_media (queue_item_id, media_id, type, original_name, mime_type, file_size, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const item of items) {
        insert.run(item.id, item.draftId, item.accountId, item.groupId, item.draftTitle, item.body, item.linkUrl ?? null, item.accountName, item.groupName, item.groupUrl, item.snapshotHash, item.scheduledAt ?? null, item.createdAt, item.createdAt);
        for (const media of item.media) mediaInsert.run(item.id, media.id, media.type, media.originalName, media.mimeType ?? null, media.fileSize, media.sortOrder);
      }
    })();
    return items.map((item) => this.get(item.id)!);
  }

  hasActiveForAccount(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM queue_items WHERE account_id = ? AND status IN ('PENDING', 'PAUSED') LIMIT 1").get(id)); }
  hasActiveForGroup(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM queue_items WHERE group_id = ? AND status IN ('PENDING', 'PAUSED') LIMIT 1").get(id)); }
  hasActiveForDraft(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM queue_items WHERE draft_id = ? AND status IN ('PENDING', 'PAUSED') LIMIT 1").get(id)); }
  hasDuplicate(draftId: string, hash: string, accountId: string, groupId: string, scheduledAt?: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM queue_items WHERE draft_id = ? AND snapshot_hash = ? AND account_id = ? AND group_id = ? AND IFNULL(scheduled_at, '') = IFNULL(?, '') AND status IN ('PENDING', 'PAUSED') LIMIT 1").get(draftId, hash, accountId, groupId, scheduledAt ?? null));
  }

  updateState(id: string, action: 'PAUSE' | 'RESUME' | 'CANCEL'): QueueRecord {
    const transitions = { PAUSE: { from: 'PENDING', to: 'PAUSED' }, RESUME: { from: 'PAUSED', to: 'PENDING' }, CANCEL: { from: ['PENDING', 'PAUSED'], to: 'CANCELLED' as QueueStatus } } as const;
    const transition = transitions[action];
    const from = Array.isArray(transition.from) ? transition.from : [transition.from];
    const placeholders = from.map(() => '?').join(',');
    const result = this.db.prepare(`UPDATE queue_items SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`).run(transition.to, new Date().toISOString(), id, ...from);
    if (!result.changes) throw new Error('Invalid queue item state transition.');
    return this.get(id)!;
  }

  deleteCancelled(id: string): QueueMediaRecord[] {
    const media = this.media(id);
    const result = this.db.prepare("DELETE FROM queue_items WHERE id = ? AND status = 'CANCELLED'").run(id);
    if (!result.changes) throw new Error('Only cancelled queue items can be deleted.');
    return media;
  }

  media(id: string): QueueMediaRecord[] {
    return (this.db.prepare(`SELECT qim.queue_item_id, qim.media_id, qim.type, qim.original_name, ma.stored_name, ma.local_path, qim.mime_type, qim.file_size, qim.sort_order
      FROM queue_item_media qim JOIN media_assets ma ON ma.id = qim.media_id WHERE qim.queue_item_id = ? ORDER BY qim.sort_order`).all(id) as QueueMediaRow[]).map(mapMedia);
  }

  private attachMedia(rows: QueueRow[]): QueueRecord[] {
    if (!rows.length) return [];
    const placeholders = rows.map(() => '?').join(',');
    const mediaRows = this.db.prepare(`SELECT qim.queue_item_id, qim.media_id, qim.type, qim.original_name, ma.stored_name, ma.local_path, qim.mime_type, qim.file_size, qim.sort_order
      FROM queue_item_media qim JOIN media_assets ma ON ma.id = qim.media_id WHERE qim.queue_item_id IN (${placeholders}) ORDER BY qim.queue_item_id, qim.sort_order`).all(...rows.map((row) => row.id)) as QueueMediaRow[];
    const byQueue = new Map<string, QueueMediaRecord[]>();
    for (const media of mediaRows) { const list = byQueue.get(media.queue_item_id) ?? []; list.push(mapMedia(media)); byQueue.set(media.queue_item_id, list); }
    return rows.map((row) => mapRow(row, byQueue.get(row.id) ?? []));
  }
}
