import Database from 'better-sqlite3';
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { BackupInfo, BackupKind } from '@shared/types';
import { LATEST_SCHEMA_VERSION, runMigrations } from './migrations';

export type AppPaths = { dataRoot: string; database: string; profiles: string; logs: string; media: string; diagnostics: string; backups: string };

export function createAppPaths(userData: string): AppPaths {
  const dataRoot = join(userData, 'fb-account-manager');
  const paths = { dataRoot, database: join(dataRoot, 'app.db'), profiles: join(dataRoot, 'profiles'), logs: join(dataRoot, 'logs'), media: join(dataRoot, 'media'), diagnostics: join(dataRoot, 'diagnostics'), backups: join(dataRoot, 'backups') };
  mkdirSync(paths.profiles, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  mkdirSync(paths.media, { recursive: true });
  mkdirSync(paths.diagnostics, { recursive: true });
  mkdirSync(paths.backups, { recursive: true });
  return paths;
}

/** Use SQLite's online backup API; never copy a live WAL database byte-for-byte. */
export async function backupDatabase(db: Database.Database, backupRoot: string, now = new Date()): Promise<string> {
  mkdirSync(backupRoot, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
  let target = join(backupRoot, 'app-' + stamp + '.db');
  let suffix = 1;
  while (existsSync(target)) target = join(backupRoot, 'app-' + stamp + '-' + suffix++ + '.db');
  await db.backup(target);
  const files = readdirSync(backupRoot).filter((name) => /^app-.*\.db$/i.test(name)).sort().reverse();
  for (const stale of files.slice(5)) { try { unlinkSync(join(backupRoot, stale)); } catch { /* best effort */ } }
  return target;
}

export function openDatabase(paths: AppPaths): Database.Database {
  mkdirSync(paths.dataRoot, { recursive: true });
  const db = new Database(paths.database);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  let current = 0;
  try { current = (db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null } | undefined)?.version ?? 0; } catch { current = 0; }
  if (existsSync(paths.database) && shouldBackupBeforeMigrations(current, LATEST_SCHEMA_VERSION)) backupDatabaseSync(db, paths.backups);
  runMigrations(db);
  return db;
}

export function shouldBackupBeforeMigrations(currentVersion: number, latestVersion: number): boolean { return currentVersion > 0 && currentVersion < latestVersion; }

export function backupDatabaseSync(db: Database.Database, backupRoot: string, now = new Date()): string {
  mkdirSync(backupRoot, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
  let target = join(backupRoot, 'app-' + stamp + '.db');
  let suffix = 1;
  while (existsSync(target)) target = join(backupRoot, 'app-' + stamp + '-' + suffix++ + '.db');
  db.prepare('VACUUM INTO ?').run(target);
  const files = readdirSync(backupRoot).filter((name) => /^app-.*\.db$/i.test(name)).sort().reverse();
  for (const stale of files.slice(5)) { try { unlinkSync(join(backupRoot, stale)); } catch { /* best effort */ } }
  return target;
}

export async function createManagedBackup(db: Database.Database, backupRoot: string, kind: Extract<BackupKind, 'MANUAL' | 'PRE_RESTORE'>, now = new Date()): Promise<BackupInfo> {
  mkdirSync(backupRoot, { recursive: true }); const prefix = kind === 'MANUAL' ? 'manual' : 'pre-restore'; const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-'); let name = `${prefix}-${stamp}.db`; let suffix = 1;
  while (existsSync(join(backupRoot, name))) name = `${prefix}-${stamp}-${suffix++}.db`;
  const target = join(backupRoot, name); await db.backup(target); retainManagedBackups(backupRoot, prefix, 5); return inspectManagedBackup(backupRoot, name);
}

export function listManagedBackups(backupRoot: string): BackupInfo[] {
  mkdirSync(backupRoot, { recursive: true }); return readdirSync(backupRoot).filter((name) => /^(manual|pre-restore|app)-[A-Za-z0-9._-]+\.db$/i.test(name)).map((name) => { try { return inspectManagedBackup(backupRoot, name); } catch { return undefined; } }).filter((value): value is BackupInfo => Boolean(value)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function resolveManagedBackup(backupRoot: string, id: string): string {
  if (!/^(manual|pre-restore|app)-[A-Za-z0-9._-]+\.db$/i.test(id) || basename(id) !== id) throw new Error('Invalid managed backup identifier.');
  const root = resolve(backupRoot); const target = resolve(root, id); const rel = relative(root, target); if (!rel || rel.startsWith('..') || rel.includes('/') || rel.includes('\\')) throw new Error('Backup path is outside managed storage.');
  const info = lstatSync(target); if (info.isSymbolicLink() || !info.isFile()) throw new Error('Backup is not a regular managed file.'); return target;
}

export function validateManagedBackup(backupRoot: string, id: string): BackupInfo {
  const path = resolveManagedBackup(backupRoot, id); const candidate = new Database(path, { readonly: true, fileMustExist: true });
  try { const integrity = candidate.pragma('integrity_check', { simple: true }); if (integrity !== 'ok') throw new Error('Backup integrity check failed.'); const version = (candidate.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? 0; if (version < 1 || version > LATEST_SCHEMA_VERSION) throw new Error('Backup schema version is unsupported.'); }
  finally { candidate.close(); }
  return inspectManagedBackup(backupRoot, id);
}

function inspectManagedBackup(root: string, name: string): BackupInfo {
  const path = resolveManagedBackup(root, name); const info = statSync(path); const kind: BackupKind = name.startsWith('manual-') ? 'MANUAL' : name.startsWith('pre-restore-') ? 'PRE_RESTORE' : 'MIGRATION'; const candidate = new Database(path, { readonly: true, fileMustExist: true }); let schemaVersion = 0; try { schemaVersion = (candidate.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? 0; } catch { schemaVersion = 0; } finally { candidate.close(); }
  return { id: name, kind, createdAt: info.birthtime.toISOString(), size: info.size, schemaVersion };
}
function retainManagedBackups(root: string, prefix: string, count: number): void { const files = readdirSync(root).filter((name) => name.startsWith(prefix + '-') && name.endsWith('.db')).sort().reverse(); for (const name of files.slice(count)) { try { unlinkSync(join(root, name)); } catch { /* best effort */ } } }
