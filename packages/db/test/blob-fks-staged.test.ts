import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDb } from '../src/client.js';
import { BlobStore, initBlobStoreDir } from '../src/blobs/store.js';

/**
 * Release B's foreign keys (ADR-035), staged outside the migrations directory until the production copy
 * has run: output/plans/2026-09-24-architecture-programme/staged/blob_fks.sql. Run as the upgrade runner
 * runs a migration (its BEGIN and COMMIT lines dropped, inside the runner's own transaction), it fails at
 * VALIDATE while a row names a hash the store has no row for, and validates once every hash has one.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const staged = path.resolve(here, '../../../output/plans/2026-09-24-architecture-programme/staged/blob_fks.sql');
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const TENANT = '00000000-0000-4000-a000-000000000001';
const CLIENT = 'c1000000-0000-4000-8000-000000000001';
const CONSTRAINTS = ['canva_editable_blob_fk', 'canva_plan_source_blob_fk', 'comparison_designer_blob_fk', 'comparison_hawa_blob_fk', 'dsc_art_blob_fk', 'dsc_preview_blob_fk'];

describe.skipIf(!ownerUrl)('staged release B migration: foreign keys to hawa.blobs', () => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const db = createDb(ownerUrl!);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-fks-test-'));
  const store = new BlobStore({ root, db });
  const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2000)]);
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const body = fs.readFileSync(staged, 'utf8').replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
  /** As packages/db/src/upgrade.ts applies a file: one transaction, rolled back on any error. */
  const apply = async () => {
    await owner.query('BEGIN');
    try {
      await owner.query(body);
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  };
  let run = '';
  const candidate = async (previewSha: string) => {
    const id = randomUUID();
    await owner.query(`INSERT INTO hawa.design_studio_candidates(id, run_id, tenant_id, ordinal, concept, status, preview_sha256)
      VALUES ($1, $2, $3, (SELECT coalesce(max(ordinal), 0) + 1 FROM hawa.design_studio_candidates WHERE run_id = $2), '{}', 'draft', $4)`, [id, run, TENANT, previewSha]);
    return id;
  };

  beforeAll(async () => {
    await owner.connect();
    await initBlobStoreDir(root);
    const task = randomUUID();
    await owner.query('INSERT INTO hawa.tasks(id, tenant_id, client_id, title) VALUES ($1, $2, $3, $4)', [task, TENANT, CLIENT, 'staged fk']);
    run = randomUUID();
    await owner.query(`INSERT INTO hawa.design_studio_runs(id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status)
      VALUES ($1, $2, $3, $4, 'test', 'k', 'h', '{}', 'standard', 'awaiting_selection')`, [run, TENANT, task, CLIENT]);
  });
  afterAll(async () => {
    await owner.end();
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is not in the migrations directory, so the next deploy does not run it', () => {
    const migrations = fs.readdirSync(path.resolve(here, '../migrations'));
    expect(migrations.some((f) => /blob_fk/.test(f))).toBe(false);
  });

  it('fails at VALIDATE while a row names a hash with no file row, and changes nothing', async () => {
    const dangling = await candidate(sha(png()));
    await expect(apply()).rejects.toThrow(/dsc_preview_blob_fk/);
    const left = await owner.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = ANY($1)`, [CONSTRAINTS]);
    expect(left.rows[0].n).toBe(0);
    await owner.query('DELETE FROM hawa.design_studio_candidates WHERE id = $1', [dangling]);
  });

  it('validates once every hash has its file row, rejects a new dangling hash, and runs twice', async () => {
    const ref = await store.put(png(), 'image/png');
    await candidate(ref.sha256);
    await apply();
    const made = await owner.query(`SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1) ORDER BY conname`, [CONSTRAINTS]);
    expect(made.rows).toEqual(CONSTRAINTS.map((conname) => ({ conname, convalidated: true })));
    await expect(candidate(sha(png()))).rejects.toThrow(/dsc_preview_blob_fk/);
    // A referenced file row can no longer be deleted.
    await expect(owner.query('DELETE FROM hawa.blobs WHERE sha256 = $1', [ref.sha256])).rejects.toThrow(/dsc_preview_blob_fk/);
    await apply();
  });
});
