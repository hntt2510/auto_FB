import { dialog } from 'electron';
import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { AuditLogRepository } from '@main/db/repositories/AuditLogRepository';
import type { PublishRepository } from '@main/db/repositories/PublishRepository';
import type { AppPaths } from '@main/db/database';
import { createManagedBackup, listManagedBackups, validateManagedBackup } from '@main/db/database';
import type { PublishScheduler } from '@main/publishing/PublishScheduler';
import type { AboutInfo, BackupInfo, DatabaseIntegrityReport, OrphanMediaScan, PublishHistoryFilter, PublishingHistoryRow, StorageUsage } from '@shared/types';
import { AppError } from '@main/errors';
import { checkDatabaseIntegrity } from './DatabaseIntegrityService';

export class OperationsService {
  private lastOrphanScan?: OrphanMediaScan;
  constructor(private readonly db: Database.Database, private readonly paths: AppPaths, private readonly publishing: PublishRepository, private readonly scheduler: PublishScheduler, private readonly audit: AuditLogRepository, private readonly appInfo: AboutInfo, private readonly restore: (backupPath: string) => Promise<void>) {}

  history(filter: PublishHistoryFilter = {}): PublishingHistoryRow[] { return this.publishing.history(filter); }
  async exportHistoryCsv(filter: PublishHistoryFilter = {}): Promise<string | undefined> {
    const result = await dialog.showSaveDialog({ title: 'Export sanitized publishing history', defaultPath: 'facebook-publish-history.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] }); if (result.canceled || !result.filePath) return undefined;
    const header = ['timestamp','queue id','account name','group name','draft title','campaign name','variant label','automated result','final status','verification source','error code','post URL']; const rows = this.history(filter).map((row) => [row.timestamp,row.queueId,row.accountName,row.groupName,row.draftTitle,row.campaignName ?? '',row.campaignVariantLabel ?? '',row.automatedResult ?? '',row.finalStatus,row.verificationSource,row.errorCode ?? '',row.postUrl ?? '']); await writeFile(result.filePath, [header, ...rows].map((row) => row.map(csv).join(',')).join('\r\n'), 'utf8'); this.auditSafe('PUBLISH_HISTORY_EXPORTED', `Exported ${rows.length} sanitized history row(s).`); return result.filePath;
  }
  integrityCheck(): DatabaseIntegrityReport { return checkDatabaseIntegrity(this.db); }
  listBackups(): BackupInfo[] { return listManagedBackups(this.paths.backups); }
  async createBackup(): Promise<BackupInfo> { const backup = await createManagedBackup(this.db, this.paths.backups, 'MANUAL'); this.auditSafe('DATABASE_BACKUP_CREATED', 'Manual database backup created.'); return backup; }
  async restoreBackup(id: string): Promise<void> {
    if (this.scheduler.runtimeState() !== 'DISARMED' || this.publishing.activePublishingCount() > 0) throw new AppError('RESTORE_NOT_SAFE', 'Disarm the scheduler and wait for active publishing to finish before restoring.');
    let backup: BackupInfo; try { backup = validateManagedBackup(this.paths.backups, id); } catch { throw new AppError('BACKUP_INVALID', 'The selected managed backup is corrupt, unsupported, or unsafe.'); }
    await createManagedBackup(this.db, this.paths.backups, 'PRE_RESTORE'); this.auditSafe('DATABASE_RESTORE_STARTED', `Restoring managed ${backup.kind.toLowerCase()} backup.`); await this.restore(join(this.paths.backups, backup.id));
  }
  async storageUsage(): Promise<StorageUsage> { const [database, profiles, media, diagnostics, backups] = await Promise.all([fileSize(this.paths.database), directorySize(this.paths.profiles), directorySize(this.paths.media), directorySize(this.paths.diagnostics), directorySize(this.paths.backups)]); return { database, profiles, media, diagnostics, backups, calculatedAt: new Date().toISOString() }; }
  async cleanDiagnostics(retentionDays = 30): Promise<number> { const cutoff = Date.now() - retentionDays * 86_400_000; const removed = await cleanOldFiles(this.paths.diagnostics, cutoff); this.auditSafe('DIAGNOSTICS_CLEANED', `Removed ${removed} old diagnostic file(s).`); return removed; }
  async scanOrphanMedia(): Promise<OrphanMediaScan> {
    const referenced = new Set((this.db.prepare('SELECT stored_name FROM media_assets').all() as Array<{ stored_name: string }>).map((row) => row.stored_name)); const entries = await readdir(this.paths.media, { withFileTypes: true }); const candidates: string[] = []; let totalBytes = 0;
    for (const entry of entries) { if (!entry.isFile() || entry.isSymbolicLink() || referenced.has(entry.name)) continue; const id = basename(entry.name, extname(entry.name)); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) continue; candidates.push(id); totalBytes += (await stat(join(this.paths.media, entry.name))).size; }
    this.lastOrphanScan = { candidateIds: candidates, candidateCount: candidates.length, totalBytes, scannedAt: new Date().toISOString() }; return this.lastOrphanScan;
  }
  async cleanOrphanMedia(candidateIds: string[]): Promise<number> {
    if (!this.lastOrphanScan) throw new AppError('INVALID_STATE', 'Scan orphan media before cleaning.'); const approved = new Set(this.lastOrphanScan.candidateIds); if (candidateIds.some((id) => !approved.has(id))) throw new AppError('INVALID_REQUEST', 'Cleanup candidates no longer match the reviewed scan.'); const referenced = new Set((this.db.prepare('SELECT stored_name FROM media_assets').all() as Array<{ stored_name: string }>).map((row) => row.stored_name)); let removed = 0;
    for (const entry of await readdir(this.paths.media, { withFileTypes: true })) { const id = basename(entry.name, extname(entry.name)); if (!candidateIds.includes(id) || referenced.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue; const target = resolve(this.paths.media, entry.name); if (!target.startsWith(resolve(this.paths.media) + '\\') && !target.startsWith(resolve(this.paths.media) + '/')) continue; await rm(target); removed++; }
    this.lastOrphanScan = undefined; this.auditSafe('ORPHAN_MEDIA_CLEANED', `Removed ${removed} reviewed orphan media file(s).`); return removed;
  }
  about(): AboutInfo { return this.appInfo; }
  private auditSafe(eventType: string, message: string): void { try { this.audit.add({ eventType, message }); } catch { /* best effort */ } }
}

function csv(value: string): string { const safe = /^[=+\-@]/.test(value) ? `'${value}` : value; return `"${safe.replace(/"/g, '""')}"`; }
async function fileSize(path: string): Promise<number> { try { return (await stat(path)).size; } catch { return 0; } }
async function directorySize(root: string): Promise<number> { let total = 0; for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) { if (entry.isSymbolicLink()) continue; const path = join(root, entry.name); if (entry.isDirectory()) total += await directorySize(path); else if (entry.isFile()) total += await fileSize(path); } return total; }
async function cleanOldFiles(root: string, cutoff: number): Promise<number> { let removed = 0; for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) { if (entry.isSymbolicLink()) continue; const path = join(root, entry.name); if (entry.isDirectory()) removed += await cleanOldFiles(path, cutoff); else if (entry.isFile() && (await stat(path)).mtimeMs < cutoff) { await rm(path); removed++; } } return removed; }
