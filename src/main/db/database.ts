import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from './migrations';

export type AppPaths = { dataRoot: string; database: string; profiles: string; logs: string };

export function createAppPaths(userData: string): AppPaths {
  const dataRoot = join(userData, 'fb-account-manager');
  const paths = { dataRoot, database: join(dataRoot, 'app.db'), profiles: join(dataRoot, 'profiles'), logs: join(dataRoot, 'logs') };
  mkdirSync(paths.profiles, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  return paths;
}

export function openDatabase(paths: AppPaths): Database.Database {
  mkdirSync(paths.dataRoot, { recursive: true });
  const db = new Database(paths.database);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  return db;
}
