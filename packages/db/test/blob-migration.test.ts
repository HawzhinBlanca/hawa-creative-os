import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';

/**
 * Migration 019 (ADR-035, FILESTORE_DESIGN.md section 2.3): the blob table's guard and grants, the
 * task_files tenant policy, the relaxed byte columns, and that the file runs twice and survives a
 * re-run of db/03-grants.sql.
 */
const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const hex = () => randomBytes(32).toString('hex');
const TENANT = '00000000-0000-4000-a000-000000000001';
const CLIENT = 'c1000000-0000-4000-8000-000000000001';

describe.skipIf(!appUrl || !ownerUrl)('migration 019: the blob store schema', () => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const app = createDb(appUrl!);
  beforeAll(async () => {
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
    await app.destroy();
  });
  const unchecked = async (text: string, values: unknown[] = []) => {
    await owner.query('SET session_replication_role = replica');
    try {
      return await owner.query(text, values);
    } finally {
      await owner.query('SET session_replication_role = DEFAULT');
    }
  };
  const blob = async () => {
    const h = hex();
    await owner.query(`INSERT INTO hawa.blobs(sha256, size, media_type) VALUES ($1, 10, 'image/png')`, [h]);
    return h;
  };

  it('is recorded by the upgrade runner', async () => {
    const r = await owner.query(`SELECT name FROM hawa.schema_upgrades WHERE name = '019_blob_store.sql'`);
    expect(r.rowCount).toBe(1);
  });

  it('a blob row is immutable except its unreferenced mark', async () => {
    const h = await blob();
    await expect(owner.query('UPDATE hawa.blobs SET size = 11 WHERE sha256 = $1', [h])).rejects.toMatchObject({ code: '55000' });
    await expect(owner.query(`UPDATE hawa.blobs SET media_type = 'image/jpeg' WHERE sha256 = $1`, [h])).rejects.toMatchObject({ code: '55000' });
    await expect(owner.query(`UPDATE hawa.blobs SET created_at = now() - interval '1 day' WHERE sha256 = $1`, [h])).rejects.toMatchObject({ code: '55000' });
    await sql`UPDATE hawa.blobs SET unreferenced_since = now() WHERE sha256 = ${h}`.execute(app);
    await expect(owner.query(`INSERT INTO hawa.blobs(sha256, size, media_type) VALUES ('NOT-HEX', 1, 'image/png')`)).rejects.toMatchObject({ code: '23514' });
    await expect(owner.query(`INSERT INTO hawa.blobs(sha256, size, media_type) VALUES ($1, 1, 'image/svg+xml')`, [hex()])).rejects.toMatchObject({ code: '23514' });
  });

  it('gives the application role only what put and the collector need', async () => {
    const h = await blob();
    await expect(sql`UPDATE hawa.blobs SET size = 12 WHERE sha256 = ${h}`.execute(app)).rejects.toThrow(/permission denied/);
    await expect(sql`DELETE FROM hawa.blobs WHERE sha256 = ${h}`.execute(app)).rejects.toThrow(/permission denied/);
    await expect(sql`SELECT count(*) FROM hawa.blob_references`.execute(app)).rejects.toThrow(/permission denied/);
    const hashes = await sql<{ h: string }>`SELECT h FROM hawa.blob_reference_hashes() AS h`.execute(app);
    expect(Array.isArray(hashes.rows)).toBe(true);
    const privileges = await owner.query(`SELECT
      has_function_privilege('public', 'hawa.blob_gc_sweep(interval, integer)', 'EXECUTE') AS public_sweep,
      has_function_privilege('hawa_app', 'hawa.blob_gc_sweep(interval, integer)', 'EXECUTE') AS app_sweep`);
    expect(privileges.rows[0]).toEqual({ public_sweep: false, app_sweep: true });
  });

  it("task_files: a tenant sees and writes only its own rows, cannot change them, and a task's deletion takes them", async () => {
    const task = randomUUID();
    await owner.query(`INSERT INTO hawa.tasks(id, tenant_id, client_id, title) VALUES ($1, $2, $3, 'blob test')`, [task, TENANT, CLIENT]);
    const h = await blob();
    await withRlsContext(app, { tenantId: TENANT }, (trx) =>
      sql`INSERT INTO hawa.task_files(tenant_id, task_id, sha256, role) VALUES (${TENANT}::uuid, ${task}::uuid, ${h}, 'reference_image')`.execute(trx));
    const mine = await withRlsContext(app, { tenantId: TENANT }, (trx) => sql`SELECT sha256 FROM hawa.task_files WHERE task_id = ${task}::uuid`.execute(trx));
    expect(mine.rows).toEqual([{ sha256: h }]);
    const other = randomUUID();
    const theirs = await withRlsContext(app, { tenantId: other }, (trx) => sql`SELECT sha256 FROM hawa.task_files WHERE task_id = ${task}::uuid`.execute(trx));
    expect(theirs.rows).toEqual([]);
    await expect(withRlsContext(app, { tenantId: other }, (trx) =>
      sql`INSERT INTO hawa.task_files(tenant_id, task_id, sha256, role) VALUES (${TENANT}::uuid, ${task}::uuid, ${h}, 'reference_image')`.execute(trx))).rejects.toThrow(/row-level security/);
    await expect(withRlsContext(app, { tenantId: TENANT }, (trx) => sql`DELETE FROM hawa.task_files WHERE task_id = ${task}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(owner.query(`INSERT INTO hawa.task_files(tenant_id, task_id, sha256, role) VALUES ($1, $2, $3, 'reference_image')`, [TENANT, task, hex()])).rejects.toMatchObject({ code: '23503' });
    await owner.query('DELETE FROM hawa.tasks WHERE id = $1', [task]);
    expect((await owner.query('SELECT 1 FROM hawa.task_files WHERE task_id = $1', [task])).rowCount).toBe(0);
  });

  it('lets new rows carry a hash instead of bytes, and still requires one or the other', async () => {
    const h = await blob();
    // A planned plan needs its source hash, no longer its bytes.
    await unchecked(`INSERT INTO hawa.canva_design_plans(id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, status, result, source_sha256)
      VALUES ($1, $2, $3, $4, 'a', 'k', 'h', '{}', 'planned', '{}', $5)`, [randomUUID(), TENANT, randomUUID(), CLIENT, h]);
    await expect(unchecked(`INSERT INTO hawa.canva_design_plans(id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, status, result)
      VALUES ($1, $2, $3, $4, 'a', 'k', 'h', '{}', 'planned', '{}')`, [randomUUID(), TENANT, randomUUID(), CLIENT])).rejects.toMatchObject({ code: '23514' });
    await unchecked(`INSERT INTO hawa.canva_editable_sources(id, tenant_id, task_id, client_id, actor_id, operation_id, sha256, manifest)
      VALUES ($1, $2, $3, $4, 'a', $5, $6, '{}')`, [randomUUID(), TENANT, randomUUID(), CLIENT, randomUUID(), h]);
    await unchecked(`INSERT INTO hawa.comparison_pairs(study_id, tenant_id, label, width, height, hawa_sha256, designer_sha256)
      VALUES ($1, $2, 'B-1', 1, 1, $3, $4)`, [randomUUID(), TENANT, h, hex()]);
    await unchecked(`INSERT INTO hawa.photo_cutouts(tenant_id, source_sha256, model, model_sha256, passed, width, height, report, png_sha256)
      VALUES ($1, $2, 'm', $3, true, 1, 1, '{}', $4)`, [TENANT, hex(), hex(), h]);
    await expect(unchecked(`INSERT INTO hawa.photo_cutouts(tenant_id, source_sha256, model, model_sha256, passed, width, height, report)
      VALUES ($1, $2, 'm', $3, true, 1, 1, '{}')`, [TENANT, hex(), hex()])).rejects.toMatchObject({ code: '23514' });
    await expect(unchecked(`INSERT INTO hawa.design_studio_candidates(id, run_id, tenant_id, ordinal, concept, status, composite_sha256)
      VALUES ($1, $2, $3, 1, '{}', 'draft', 'not-a-hash')`, [randomUUID(), randomUUID(), TENANT])).rejects.toMatchObject({ code: '23514' });
  });

  it('runs twice (psql by hand after the runner) and keeps its grants when db/03-grants.sql runs again', async () => {
    const strip = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8').replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    await owner.query('BEGIN');
    try {
      await owner.query(strip('packages/db/migrations/019_blob_store.sql'));
      await owner.query(strip('db/03-grants.sql'));
      const r = await owner.query(`SELECT
        has_table_privilege('hawa_app', 'hawa.blobs', 'DELETE') AS blobs_delete,
        has_column_privilege('hawa_app', 'hawa.blobs', 'size', 'UPDATE') AS size_update,
        has_column_privilege('hawa_app', 'hawa.blobs', 'unreferenced_since', 'UPDATE') AS mark_update,
        has_table_privilege('hawa_app', 'hawa.blobs', 'INSERT') AS blobs_insert,
        has_table_privilege('hawa_app', 'hawa.blob_references', 'SELECT') AS view_select,
        has_table_privilege('hawa_app', 'hawa.task_files', 'DELETE') AS files_delete`);
      expect(r.rows[0]).toEqual({ blobs_delete: false, size_update: false, mark_update: true, blobs_insert: true, view_select: false, files_delete: false });
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
