import type Database from 'better-sqlite3';
import type { Draft, DraftFilter, DraftInput, DraftStatus, DraftMedia, MediaType } from '@shared/types';

export type DraftMediaRecord = Omit<DraftMedia, 'previewUrl'> & { storedName: string; localPath: string };
export type DraftRecord = Omit<Draft, 'media'> & { media: DraftMediaRecord[] };
type DraftRow = { id: string; title: string; body: string; link_url: string | null; status: DraftStatus; created_at: string; updated_at: string };
type MediaRow = { id: string; draft_id: string; type: MediaType; original_name: string; stored_name: string; local_path: string; mime_type: string | null; file_size: number; sort_order: number; created_at: string };
type AssetRow = { id: string; type: MediaType; original_name: string; stored_name: string; local_path: string; mime_type: string | null; file_size: number; created_at: string };

function mapMedia(row: MediaRow): DraftMediaRecord {
  return { id: row.id, draftId: row.draft_id, type: row.type, originalName: row.original_name, storedName: row.stored_name, localPath: row.local_path, mimeType: row.mime_type ?? undefined, fileSize: row.file_size, sortOrder: row.sort_order, createdAt: row.created_at };
}

function mapDraft(row: DraftRow, media: DraftMediaRecord[] = []): DraftRecord {
  return { id: row.id, title: row.title, body: row.body, linkUrl: row.link_url ?? undefined, status: row.status, media, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class DraftRepository {
  constructor(private readonly db: Database.Database) {}

  list(filter: DraftFilter = {}): DraftRecord[] {
    const conditions: string[] = []; const params: Record<string, string> = {};
    if (filter.search) { conditions.push('(d.title LIKE @search OR d.body LIKE @search)'); params.search = `%${filter.search}%`; }
    if (filter.status) { conditions.push('d.status = @status'); params.status = filter.status; }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT d.* FROM drafts d${where} ORDER BY d.updated_at DESC LIMIT 1000`).all(params) as DraftRow[];
    return this.attachMedia(rows);
  }

  get(id: string): DraftRecord | undefined {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined;
    return row ? mapDraft(row, this.media(id)) : undefined;
  }

  insert(id: string, input: DraftInput, timestamp: string): DraftRecord {
    this.db.prepare('INSERT INTO drafts (id, title, body, link_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'DRAFT\', ?, ?)').run(id, input.title, input.body, input.linkUrl ?? null, timestamp, timestamp);
    return this.get(id)!;
  }

  update(id: string, input: DraftInput): DraftRecord {
    this.db.prepare('UPDATE drafts SET title = ?, body = ?, link_url = ?, updated_at = ? WHERE id = ?').run(input.title, input.body, input.linkUrl ?? null, new Date().toISOString(), id);
    return this.get(id)!;
  }

  duplicate(source: DraftRecord, id: string, timestamp: string): DraftRecord {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO drafts (id, title, body, link_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'DRAFT\', ?, ?)').run(id, `${source.title} (Copy)`.slice(0, 160), source.body, source.linkUrl ?? null, timestamp, timestamp);
      const insert = this.db.prepare('INSERT INTO draft_media (draft_id, media_id, sort_order, created_at) VALUES (?, ?, ?, ?)');
      for (const media of source.media) insert.run(id, media.id, media.sortOrder, timestamp);
    })();
    return this.get(id)!;
  }

  setStatus(id: string, status: DraftStatus): DraftRecord {
    this.db.prepare('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    return this.get(id)!;
  }

  media(draftId: string): DraftMediaRecord[] {
    return (this.db.prepare(`SELECT dm.*, ma.type, ma.original_name, ma.stored_name, ma.local_path, ma.mime_type, ma.file_size, ma.created_at
      FROM draft_media dm JOIN media_assets ma ON ma.id = dm.media_id WHERE dm.draft_id = ? ORDER BY dm.sort_order`).all(draftId) as MediaRow[]).map(mapMedia);
  }

  insertAssetAndAttach(asset: { id: string; type: MediaType; originalName: string; storedName: string; localPath: string; mimeType?: string; fileSize: number }, draftId: string, sortOrder: number, timestamp: string): DraftMediaRecord {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO media_assets (id, type, original_name, stored_name, local_path, mime_type, file_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(asset.id, asset.type, asset.originalName, asset.storedName, asset.localPath, asset.mimeType ?? null, asset.fileSize, timestamp);
      this.db.prepare('INSERT INTO draft_media (draft_id, media_id, sort_order, created_at) VALUES (?, ?, ?, ?)').run(draftId, asset.id, sortOrder, timestamp);
    })();
    return this.media(draftId).find((media) => media.id === asset.id)!;
  }

  removeMedia(draftId: string, mediaId: string): { assetId: string; path: string } | undefined {
    const asset = this.db.prepare(`SELECT ma.id AS asset_id, ma.local_path AS path FROM draft_media dm JOIN media_assets ma ON ma.id = dm.media_id WHERE dm.draft_id = ? AND dm.media_id = ?`).get(draftId, mediaId) as { asset_id: string; path: string } | undefined;
    if (!asset) return undefined;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM draft_media WHERE draft_id = ? AND media_id = ?').run(draftId, mediaId);
      this.compactSortOrder(draftId);
    })();
    return { assetId: asset.asset_id, path: asset.path };
  }

  reorderMedia(draftId: string, mediaIds: string[]): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE draft_media SET sort_order = sort_order + 1000000 WHERE draft_id = ?').run(draftId);
      const update = this.db.prepare('UPDATE draft_media SET sort_order = ? WHERE draft_id = ? AND media_id = ?');
      mediaIds.forEach((id, index) => update.run(index, draftId, id));
    })();
  }

  mediaAsset(id: string): AssetRow | undefined { return this.db.prepare('SELECT * FROM media_assets WHERE id = ?').get(id) as AssetRow | undefined; }
  mediaAssetByPath(path: string): AssetRow | undefined { return this.db.prepare('SELECT * FROM media_assets WHERE local_path = ?').get(path) as AssetRow | undefined; }
  mediaReferenceCount(id: string): number {
    const row = this.db.prepare('SELECT (SELECT COUNT(*) FROM draft_media WHERE media_id = ?) + (SELECT COUNT(*) FROM queue_item_media WHERE media_id = ?) AS count').get(id, id) as { count: number };
    return row.count;
  }
  deleteAsset(id: string): void { this.db.prepare('DELETE FROM media_assets WHERE id = ?').run(id); }
  draftMediaAssetIds(draftId: string): string[] { return (this.db.prepare('SELECT media_id AS id FROM draft_media WHERE draft_id = ?').all(draftId) as { id: string }[]).map((row) => row.id); }
  hasActiveQueueItems(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM queue_items WHERE draft_id = ? AND status IN ('PENDING', 'PAUSED', 'RUNNING', 'SUBMITTED', 'NEEDS_ATTENTION') LIMIT 1").get(id)); }
  delete(id: string): string[] {
    const assetIds = this.draftMediaAssetIds(id);
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
    return assetIds;
  }

  private attachMedia(rows: DraftRow[]): DraftRecord[] {
    if (!rows.length) return [];
    const placeholders = rows.map(() => '?').join(',');
    const mediaRows = this.db.prepare(`SELECT dm.*, ma.type, ma.original_name, ma.stored_name, ma.local_path, ma.mime_type, ma.file_size, ma.created_at FROM draft_media dm JOIN media_assets ma ON ma.id = dm.media_id WHERE dm.draft_id IN (${placeholders}) ORDER BY dm.draft_id, dm.sort_order`).all(...rows.map((row) => row.id)) as MediaRow[];
    const byDraft = new Map<string, DraftMediaRecord[]>();
    for (const media of mediaRows) { const list = byDraft.get(media.draft_id) ?? []; list.push(mapMedia(media)); byDraft.set(media.draft_id, list); }
    return rows.map((row) => mapDraft(row, byDraft.get(row.id) ?? []));
  }

  private compactSortOrder(draftId: string): void {
    const ids = this.db.prepare('SELECT media_id AS id FROM draft_media WHERE draft_id = ? ORDER BY sort_order').all(draftId) as { id: string }[];
    const update = this.db.prepare('UPDATE draft_media SET sort_order = ? WHERE draft_id = ? AND media_id = ?');
    ids.forEach((row, index) => update.run(index, draftId, row.id));
  }
}
