import type Database from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION } from '@main/db/migrations';

export type DatabaseIntegrityReport = {
  integrityOk: boolean;
  schemaVersionOk: boolean;
  integrityDetail: string;
  foreignKeyViolations: number;
  schemaVersion: number;
  expectedSchemaVersion: number;
  expectedTables: string[];
  missingTables: string[];
  checkedAt: string;
};

const EXPECTED_TABLES = [
  'schema_migrations',
  'accounts',
  'groups',
  'account_groups',
  'drafts',
  'draft_media',
  'media_assets',
  'queue_items',
  'queue_item_media',
  'publish_attempts',
  'publish_attempt_events',
  'publish_receipts',
  'publish_reconciliations',
  'publish_preflights',
  'audit_logs',
  'settings',
  'account_onboarding_tasks',
  'account_sessions',
  'campaigns',
  'campaign_variants',
  'campaign_plan_items',
];

export function checkDatabaseIntegrity(db: Database.Database): DatabaseIntegrityReport {
  const integrity = db.pragma('integrity_check', { simple: true }) as string;
  const foreignKeys = db.pragma('foreign_key_check') as Array<{ table: string; rowid: number; parent: string; fkid: number }>;
  let schemaVersion = 0;
  try { schemaVersion = (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null })?.version ?? 0; } catch { schemaVersion = 0; }
  const existingTables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name));
  const missingTables = EXPECTED_TABLES.filter((table) => !existingTables.has(table));
  const schemaVersionOk = schemaVersion === LATEST_SCHEMA_VERSION;
  const integrityOk = integrity === 'ok' && foreignKeys.length === 0 && missingTables.length === 0 && schemaVersionOk;
  return {
    integrityOk,
    schemaVersionOk,
    integrityDetail: integrity,
    foreignKeyViolations: foreignKeys.length,
    schemaVersion,
    expectedSchemaVersion: LATEST_SCHEMA_VERSION,
    expectedTables: [...EXPECTED_TABLES],
    missingTables,
    checkedAt: new Date().toISOString(),
  };
}
