import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
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
