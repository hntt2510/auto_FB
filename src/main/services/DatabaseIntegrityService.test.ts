import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppPaths, openDatabase } from '@main/db/database';
import { checkDatabaseIntegrity } from './DatabaseIntegrityService';
import { LATEST_SCHEMA_VERSION } from '@main/db/migrations';
import { renderToStaticMarkup } from 'react-dom/server';
import { DatabaseIntegrityView } from '../../renderer/pages/AboutPage';

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
    expect(report.schemaVersionOk).toBe(true);
    expect(report.integrityDetail).toBe('ok');
    expect(report.foreignKeyViolations).toBe(0);
    expect(report.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(report.expectedSchemaVersion).toBe(8);
    expect(report.missingTables).toEqual([]);
    expect(report.checkedAt).toBeTruthy();
    db.close();
  });

  it('detects SQLite integrity failure when database file is corrupted', () => {
    const { db } = setup();
    // Simulate integrity_check returning failure
    const originalPragma = db.pragma.bind(db);
    db.pragma = ((pragmaSql: string, options?: unknown) => {
      if (typeof pragmaSql === 'string' && pragmaSql.includes('integrity_check')) {
        return '*** in database main ***\nPage 4: b-tree is corrupted';
      }
      return originalPragma(pragmaSql, options as never);
    }) as typeof db.pragma;

    const report = checkDatabaseIntegrity(db);
    expect(report.integrityOk).toBe(false);
    expect(report.integrityDetail).toContain('b-tree is corrupted');
    db.close();
  });

  it('detects missing campaign tables', () => {
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
    db.pragma('foreign_keys = OFF');
    db.exec(
      `INSERT INTO queue_items (id, draft_id, account_id, group_id, draft_title_snapshot, body_snapshot, link_url_snapshot, account_name_snapshot, group_name_snapshot, group_url_snapshot, snapshot_hash, status, created_at, updated_at) VALUES ('test-qi', 'nonexistent', 'nonexistent', 'nonexistent', 'test', 'body', NULL, 'acc', 'grp', 'url', 'hash', 'PENDING', '2024-01-01', '2024-01-01')`
    );
    db.pragma('foreign_keys = ON');
    const report = checkDatabaseIntegrity(db);
    expect(report.foreignKeyViolations).toBeGreaterThan(0);
    expect(report.integrityOk).toBe(false);
    db.close();
  });

  it('detects outdated schema version (schema 7)', () => {
    const { db } = setup();
    db.exec('DELETE FROM schema_migrations WHERE version = 8');
    const report = checkDatabaseIntegrity(db);
    expect(report.schemaVersion).toBe(7);
    expect(report.schemaVersionOk).toBe(false);
    expect(report.integrityOk).toBe(false);
    db.close();
  });

  it('detects unrecognized future schema version (schema 9 mock)', () => {
    const { db } = setup();
    db.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (9, '2026-09-05T00:00:00.000Z')");
    const report = checkDatabaseIntegrity(db);
    expect(report.schemaVersion).toBe(9);
    expect(report.schemaVersionOk).toBe(false);
    expect(report.integrityOk).toBe(false);
    db.close();
  });

  it('renders PASSED and OK badges in About UI when integrity is valid', () => {
    const report = {
      integrityOk: true,
      schemaVersionOk: true,
      integrityDetail: 'ok',
      foreignKeyViolations: 0,
      schemaVersion: 8,
      expectedSchemaVersion: 8,
      expectedTables: ['accounts'],
      missingTables: [],
      checkedAt: '2026-09-05T12:00:00.000Z'
    };
    const html = renderToStaticMarkup(React.createElement(DatabaseIntegrityView, { integrity: report }));
    expect(html).toContain('PASSED');
    expect(html).toContain('status-succeeded');
    expect(html).toContain('OK');
    expect(html).toContain('None');
  });

  it('renders FAILED and MISMATCH badges in About UI when schema version is invalid', () => {
    const report = {
      integrityOk: false,
      schemaVersionOk: false,
      integrityDetail: 'ok',
      foreignKeyViolations: 0,
      schemaVersion: 7,
      expectedSchemaVersion: 8,
      expectedTables: ['accounts'],
      missingTables: [],
      checkedAt: '2026-09-05T12:00:00.000Z'
    };
    const html = renderToStaticMarkup(React.createElement(DatabaseIntegrityView, { integrity: report }));
    expect(html).toContain('FAILED');
    expect(html).toContain('status-failed');
    expect(html).toContain('MISMATCH');
  });
});
