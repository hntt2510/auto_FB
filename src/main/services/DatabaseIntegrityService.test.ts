import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppPaths, openDatabase } from '@main/db/database';
import { checkDatabaseIntegrity } from './DatabaseIntegrityService';
import { LATEST_SCHEMA_VERSION } from '@main/db/migrations';

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'integrity-test-'));
  roots.push(root);
  const paths = createAppPaths(root);
  const db = openDatabase(paths);
  return { db, paths };
}

afterEach(() => { for (const root of roots.splice(0)) try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('DatabaseIntegrityService', () => {
  it('reports ok on a fresh schema-8 database', () => {
    const { db } = setup();
    const report = checkDatabaseIntegrity(db);
    expect(report.integrityOk).toBe(true);
    expect(report.integrityDetail).toBe('ok');
    expect(report.foreignKeyViolations).toBe(0);
    expect(report.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(report.expectedSchemaVersion).toBe(8);
    expect(report.missingTables).toEqual([]);
    expect(report.checkedAt).toBeTruthy();
    db.close();
  });

  it('detects missing tables', () => {
    const { db } = setup();
    db.exec('DROP TABLE campaign_plan_items');
    db.exec('DROP TABLE campaign_variants');
    db.exec('DROP TABLE campaigns');
    const report = checkDatabaseIntegrity(db);
    expect(report.integrityOk).toBe(false);
    expect(report.missingTables).toContain('campaigns');
    expect(report.missingTables).toContain('campaign_variants');
    expect(report.missingTables).toContain('campaign_plan_items');
    db.close();
  });

  it('detects foreign key violations', () => {
    const { db } = setup();
    // Insert an orphan queue_item referencing a non-existent account
    db.pragma('foreign_keys = OFF');
    db.exec(`INSERT INTO queue_items (id, draft_id, account_id, group_id, draft_title_snapshot, body_snapshot, link_url_snapshot, account_name_snapshot, group_name_snapshot, group_url_snapshot, snapshot_hash, status, created_at, updated_at) VALUES ('test-qi', 'nonexistent', 'nonexistent', 'nonexistent', 'test', 'body', NULL, 'acc', 'grp', 'url', 'hash', 'PENDING', '2024-01-01', '2024-01-01')`);
    db.pragma('foreign_keys = ON');
    const report = checkDatabaseIntegrity(db);
    expect(report.foreignKeyViolations).toBeGreaterThan(0);
    expect(report.integrityOk).toBe(false);
    db.close();
  });

  it('reports correct schema version', () => {
    const { db } = setup();
    const report = checkDatabaseIntegrity(db);
    expect(report.schemaVersion).toBe(8);
    expect(report.expectedSchemaVersion).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });
});
