import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSchemaSql, checkDatabaseSchema, resolveWorkspaceFile } from '../src/index.js';

describe('Static Schema Invariant & Snapshot Verification (Dry-Run Invariant Suite)', () => {
  const schemaPath = resolveWorkspaceFile('db/schema.sql');
  const rlsPath = resolveWorkspaceFile('db/rls.sql');
  const seedPath = resolveWorkspaceFile('db/seed.sql');

  it('generates a complete database snapshot containing schema, RLS, and seed data', () => {
    expect(existsSync(schemaPath)).toBe(true);
    expect(existsSync(rlsPath)).toBe(true);
    expect(existsSync(seedPath)).toBe(true);

    const schemaSql = readFileSync(schemaPath, 'utf-8');
    const rlsSql = readFileSync(rlsPath, 'utf-8');
    const seedSql = readFileSync(seedPath, 'utf-8');

    // Synthesize full recovery bundle
    const snapshotBundle = [
      '-- HAWA CREATIVE OS PRODUCTION RECOVERY SNAPSHOT',
      `-- GeneratedAt: ${new Date().toISOString()}`,
      '-- BEGIN SCHEMA',
      schemaSql,
      '-- BEGIN ROW LEVEL SECURITY',
      rlsSql,
      '-- BEGIN SEED TRUTH',
      seedSql,
      '-- END RECOVERY SNAPSHOT',
    ].join('\n\n');

    expect(snapshotBundle.length).toBeGreaterThan(10000);
    expect(snapshotBundle).toContain('CREATE TABLE');
    expect(snapshotBundle).toContain('CREATE POLICY');
    expect(snapshotBundle).toContain('INSERT INTO');
  });

  it('verifies exact schema invariant counts: 56 tables, 11 enums, 29 RLS policies', async () => {
    const result = await checkDatabaseSchema();

    expect(result.valid).toBe(true);
    expect(result.tableCount).toBe(56);
    expect(result.enumsCount).toBe(11);
    expect(result.policiesCount).toBe(29);
  });

  it('preserves the parsed base schema and policy inventory (not a recovery drill)', () => {
    // 1. Simulate empty clean host
    const simulatedCleanHost = {
      tables: [] as string[],
      enums: [] as string[],
      policies: [] as string[],
    };

    expect(simulatedCleanHost.tables).toHaveLength(0);

    // 2. Read snapshot and execute restoration
    const schemaSql = readFileSync(schemaPath, 'utf-8');
    const rlsSql = readFileSync(rlsPath, 'utf-8');

    const parsedSchema = parseSchemaSql(schemaSql);
    const parsedRls = parseSchemaSql(rlsSql);

    simulatedCleanHost.tables = parsedSchema.tables;
    simulatedCleanHost.enums = parsedSchema.enums;
    simulatedCleanHost.policies = [...parsedSchema.policies, ...parsedRls.policies];

    // 3. Verify post-restore integrity
    expect(simulatedCleanHost.tables).toHaveLength(56);
    expect(simulatedCleanHost.enums).toHaveLength(11);
    expect(simulatedCleanHost.policies).toHaveLength(29);

    // Multi-tenant core tables must be present
    expect(simulatedCleanHost.tables).toContain('eval_model_calls');
    expect(simulatedCleanHost.tables).toContain('eval_run_settlements');
    expect(simulatedCleanHost.tables).toContain('tasks');
    expect(simulatedCleanHost.tables).toContain('clients');
    expect(simulatedCleanHost.tables).toContain('client_dna_versions');
    expect(simulatedCleanHost.tables).toContain('client_rules');
    expect(simulatedCleanHost.tables).toContain('brand_assets');
    expect(simulatedCleanHost.tables).toContain('outbox_commands');
    // Migration 020 keeps what its duplicate sweep removed from inbox_events.
    expect(simulatedCleanHost.tables).toContain('inbox_event_duplicates');
    expect(simulatedCleanHost.tables).toContain('drive_upload_reservations');

    // Multi-tenant isolation policies must be present
    expect(simulatedCleanHost.policies).toContain('eval_model_calls_scope');
    expect(simulatedCleanHost.policies).toContain('tasks_select');
    expect(simulatedCleanHost.policies).toContain('tasks_write');
    expect(simulatedCleanHost.policies).toContain('drive_upload_reservations_operator_insert');
  });
});
