import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { sql } from 'kysely';
import { createDb } from '../src/client.js';
import { BlobStore, initBlobStoreDir } from '../src/blobs/store.js';
import { claimAndUnlink, runBlobGc } from '../src/blobs/gc.js';

/**
 * The file store's garbage collector (ADR-035 section 2.3 as amended, FILESTORE_DESIGN.md sections
 * 2.5 and 7): a referenced file is never deleted, whichever table references it; the grace period
 * runs from unreferenced_since; the claim closes the race between a writer's put and the unlink; the
 * orphan and temporary-file sweeps; and the view covers every foreign key to hawa.blobs.
 *
 * The collector runs as the application role, as it does in production (docker exec in Core).
 * Time is moved by back-dating rows as the owner (session_replication_role = replica skips the row
 * guard and the foreign keys for that) and files with utimes.
 */
const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const GRACE = 15;
const DAY = 24 * 3600 * 1000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = () => Buffer.concat([PNG_SIGNATURE, randomBytes(300)]);
const hex = () => randomBytes(32).toString('hex');

/** Every branch of hawa.blob_references, as table.column. */
const BRANCHES = [
  'task_files.sha256',
  'design_feedback.preview_sha256',
  'design_studio_candidates.preview_sha256',
  'design_studio_candidates.composite_sha256',
  'design_studio_candidates.art_sha256',
  'canva_design_plans.source_sha256',
  'canva_editable_sources.sha256',
  'photo_cutouts.png_sha256',
  'photo_cutouts.shadow_sha256',
  'comparison_pairs.hawa_sha256',
  'comparison_pairs.designer_sha256',
] as const;
type Branch = (typeof BRANCHES)[number];
/** The references whose foreign key exists from migration 019 on; the rest get theirs in 020. */
const WITH_FOREIGN_KEY: Branch[] = ['task_files.sha256', 'design_studio_candidates.composite_sha256', 'photo_cutouts.png_sha256', 'photo_cutouts.shadow_sha256'];

describe.skipIf(!appUrl || !ownerUrl)('blob garbage collection against PostgreSQL', () => {
  const app = createDb(appUrl!);
  const writerDb = createDb(appUrl!);
  const owner = new pg.Client({ connectionString: ownerUrl });
  const dirs: string[] = [];
  let root: string;
  let store: BlobStore;

  beforeAll(async () => {
    await owner.connect();
  });
  afterAll(async () => {
    await app.destroy();
    await writerDb.destroy();
    await owner.end();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-blob-gc-test-'));
    dirs.push(root);
    await initBlobStoreDir(root);
    store = new BlobStore({ root, db: app });
  });

  /** Runs statements as the owner with triggers and foreign-key checks off, for back-dating and seeding. */
  async function asOwnerUnchecked(text: string, values: unknown[] = []): Promise<pg.QueryResult> {
    await owner.query('SET session_replication_role = replica');
    try {
      return await owner.query(text, values);
    } finally {
      await owner.query('SET session_replication_role = DEFAULT');
    }
  }
  const backdate = (sha256: string, createdDays: number, unreferencedDays: number | null) =>
    asOwnerUnchecked(
      `UPDATE hawa.blobs SET created_at = now() - make_interval(days => $2), unreferenced_since = CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END WHERE sha256 = $1`,
      [sha256, createdDays, unreferencedDays],
    );
  const row = async (sha256: string) =>
    (await owner.query('SELECT created_at, unreferenced_since FROM hawa.blobs WHERE sha256 = $1', [sha256])).rows[0] as
      | { created_at: Date; unreferenced_since: Date | null }
      | undefined;
  const gc = (opts: { dryRun?: boolean; now?: () => number } = {}) => runBlobGc(store, app, { graceDays: GRACE, ...opts });

  /** A minimal referencing row for one branch. Foreign keys to tasks, runs and studies are not checked. */
  async function reference(branch: Branch, sha256: string): Promise<void> {
    const tenant = randomUUID();
    const [table, column] = branch.split('.');
    switch (table) {
      case 'design_feedback':
        // No candidate reference retains this old picture: only the review does.
        await asOwnerUnchecked(`INSERT INTO hawa.design_feedback(id, tenant_id, task_id, actor_id, source, verdict, preview_sha256) VALUES ($1, $2, $3, 'reviewer', 'desk', 'revise', $4)`, [randomUUID(), tenant, randomUUID(), sha256]);
        return;
      case 'task_files':
        await asOwnerUnchecked(`INSERT INTO hawa.task_files(tenant_id, task_id, sha256, role) VALUES ($1, $2, $3, 'reference_image')`, [tenant, randomUUID(), sha256]);
        return;
      case 'design_studio_candidates':
        await asOwnerUnchecked(
          `INSERT INTO hawa.design_studio_candidates(id, run_id, tenant_id, ordinal, concept, status, ${column}) VALUES ($1, $2, $3, 1, '{}', 'draft', $4)`,
          [randomUUID(), randomUUID(), tenant, sha256],
        );
        return;
      case 'canva_design_plans':
        await asOwnerUnchecked(
          `INSERT INTO hawa.canva_design_plans(id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, status, source_sha256)
           VALUES ($1, $2, $3, $4, 'actor', 'key', 'hash', '{}', 'planning', $5)`,
          [randomUUID(), tenant, randomUUID(), randomUUID(), sha256],
        );
        return;
      case 'canva_editable_sources':
        await asOwnerUnchecked(
          `INSERT INTO hawa.canva_editable_sources(id, tenant_id, task_id, client_id, actor_id, operation_id, sha256, manifest)
           VALUES ($1, $2, $3, $4, 'actor', $5, $6, '{}')`,
          [randomUUID(), tenant, randomUUID(), randomUUID(), randomUUID(), sha256],
        );
        return;
      case 'photo_cutouts':
        await asOwnerUnchecked(
          `INSERT INTO hawa.photo_cutouts(tenant_id, source_sha256, model, model_sha256, passed, width, height, report, png_sha256, shadow_sha256)
           VALUES ($1, $2, 'm', $3, true, 10, 10, '{}', $4, $5)`,
          [tenant, hex(), hex(), column === 'png_sha256' ? sha256 : (await store.put(png(), 'image/png')).sha256, column === 'shadow_sha256' ? sha256 : null],
        );
        return;
      case 'comparison_pairs':
        await asOwnerUnchecked(
          `INSERT INTO hawa.comparison_pairs(study_id, tenant_id, label, width, height, hawa_sha256, designer_sha256) VALUES ($1, $2, 'A-1', 10, 10, $3, $4)`,
          [randomUUID(), tenant, column === 'hawa_sha256' ? sha256 : hex(), column === 'designer_sha256' ? sha256 : hex()],
        );
        return;
    }
  }

  for (const branch of BRANCHES) {
    it(`never deletes a file referenced from ${branch}, even with a stale mark`, async () => {
      const ref = await store.put(png(), 'image/png');
      await reference(branch, ref.sha256);
      // Long unreferenced by an old mark, and long past the grace: only the reference keeps it.
      await backdate(ref.sha256, 40, 30);
      // The sweep on its own skips it (the view), without a mark first.
      const direct = await sql<{ sha256: string }>`SELECT sha256 FROM hawa.blob_gc_sweep(make_interval(days => ${GRACE}), 10000)`.execute(app);
      expect(direct.rows.map((r) => r.sha256)).not.toContain(ref.sha256);
      // And the full run clears the stale mark.
      await gc();
      expect(await row(ref.sha256)).toMatchObject({ unreferenced_since: null });
      expect(fs.existsSync(store.pathOf(ref))).toBe(true);
    });
  }

  it('a direct DELETE of a referenced row is refused by the foreign key, and the application role cannot delete at all', async () => {
    for (const branch of WITH_FOREIGN_KEY) {
      const ref = await store.put(png(), 'image/png');
      await reference(branch, ref.sha256);
      await expect(owner.query('DELETE FROM hawa.blobs WHERE sha256 = $1', [ref.sha256])).rejects.toMatchObject({ code: '23503' });
    }
    const loose = await store.put(png(), 'image/png');
    await expect(sql`DELETE FROM hawa.blobs WHERE sha256 = ${loose.sha256}`.execute(app)).rejects.toThrow(/permission denied/);
  });

  it('keeps an unreferenced file within the grace, deletes and unlinks it after', async () => {
    const ref = await store.put(png(), 'image/png');
    const first = await gc();
    expect(first.marked).toBeGreaterThanOrEqual(1);
    expect((await row(ref.sha256))?.unreferenced_since).toBeInstanceOf(Date);
    expect(fs.existsSync(store.pathOf(ref))).toBe(true);

    // Old, but unreferenced only since yesterday: the dump of two days ago still references it.
    await backdate(ref.sha256, 40, 1);
    await gc();
    expect(await row(ref.sha256)).toBeDefined();
    // Unreferenced for longer than the grace, but stored only yesterday: kept too.
    await backdate(ref.sha256, 1, GRACE + 1);
    await gc();
    expect(await row(ref.sha256)).toBeDefined();

    await backdate(ref.sha256, GRACE + 1, GRACE + 1);
    const dry = await gc({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, deleted: 1, unlinked: 0 });
    expect(await row(ref.sha256)).toBeDefined();
    expect(fs.existsSync(store.pathOf(ref))).toBe(true);

    const report = await gc();
    expect(report).toMatchObject({ deleted: 1, unlinked: 1, bytesFreed: ref.size });
    expect(await row(ref.sha256)).toBeUndefined();
    expect(fs.existsSync(store.pathOf(ref))).toBe(false);
  });

  it('a new reference or a new put clears the mark', async () => {
    const a = await store.put(png(), 'image/png');
    const b = await store.put(png(), 'image/png');
    await gc();
    expect((await row(a.sha256))?.unreferenced_since).toBeInstanceOf(Date);
    await reference('task_files.sha256', a.sha256);
    const report = await gc();
    expect(report.cleared).toBeGreaterThanOrEqual(1);
    expect((await row(a.sha256))?.unreferenced_since).toBeNull();
    await backdate(b.sha256, GRACE + 5, GRACE + 5);
    await store.put(await store.read(b), 'image/png');
    expect((await row(b.sha256))?.unreferenced_since).toBeNull();
    await gc();
    expect(await row(b.sha256)).toBeDefined();
  });

  async function waitForAdvisoryWaiter(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const r = await owner.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
      if (r.rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('nobody waited on the blob lock');
  }

  it('race, collector first: a put that finds the file during the unlink writes it again (two connections)', async () => {
    const bytes = png();
    const ref = await store.put(bytes, 'image/png');
    // The sweep has deleted the row; the file is still there.
    await asOwnerUnchecked('DELETE FROM hawa.blobs WHERE sha256 = $1', [ref.sha256]);
    const collector = new pg.Client({ connectionString: appUrl });
    await collector.connect();
    try {
      await collector.query('BEGIN');
      const claim = await collector.query('SELECT hawa.blob_gc_claim_unlink($1) AS gone', [ref.sha256]);
      expect(claim.rows[0].gone).toBe(true);
      // The writer sees the file before its transaction, so it writes no temporary copy, then waits.
      const writer = new BlobStore({ root, db: writerDb });
      const put = writer.put(bytes, 'image/png');
      await waitForAdvisoryWaiter();
      // It checked for the file before its transaction and found it, so it holds no copy of its own.
      expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([]);
      fs.unlinkSync(store.pathOf(ref));
      await collector.query('COMMIT');
      await put;
    } finally {
      await collector.end();
    }
    expect(await row(ref.sha256)).toBeDefined();
    expect((await store.read(ref, { verify: true })).equals(bytes)).toBe(true);
  });

  it('race, writer first: the collector waits for the put and keeps the file (two connections)', async () => {
    const bytes = png();
    const ref = await store.put(bytes, 'image/png');
    await asOwnerUnchecked('DELETE FROM hawa.blobs WHERE sha256 = $1', [ref.sha256]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inserted!: () => void;
    const rowInserted = new Promise<void>((resolve) => { inserted = resolve; });
    const writer = new BlobStore({ root, db: writerDb });
    const put = writerDb.transaction().execute(async (trx) => {
      await writer.put(bytes, 'image/png', { trx });
      inserted();
      await gate;
    });
    await rowInserted;
    const claim = claimAndUnlink(app, store.pathOf(ref), ref.sha256);
    await waitForAdvisoryWaiter();
    release();
    await put;
    expect(await claim).toBeUndefined();
    expect(fs.existsSync(store.pathOf(ref))).toBe(true);
    expect(await row(ref.sha256)).toBeDefined();
  });

  it('sweeps orphan files past the grace and temporary files older than a day, and nothing younger', async () => {
    const shaOld = hex();
    const shaNew = hex();
    const oldFile = path.join(root, 'sha256', shaOld.slice(0, 2), `${shaOld}.png`);
    const newFile = path.join(root, 'sha256', shaNew.slice(0, 2), `${shaNew}.png`);
    for (const f of [oldFile, newFile]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, png(), { mode: 0o444 });
    }
    const past = (days: number) => new Date(Date.now() - days * DAY);
    fs.utimesSync(oldFile, past(GRACE + 1), past(GRACE + 1));
    // A file with a row is never an orphan, however old.
    const kept = await store.put(png(), 'image/png');
    fs.utimesSync(store.pathOf(kept), past(GRACE + 10), past(GRACE + 10));
    const staleTmp = path.join(root, 'tmp', `${hex()}.abc.part`);
    const freshTmp = path.join(root, 'tmp', `${hex()}.def.part`);
    fs.writeFileSync(staleTmp, 'x');
    fs.writeFileSync(freshTmp, 'x');
    fs.utimesSync(staleTmp, past(2), past(2));

    const dry = await gc({ dryRun: true });
    expect(dry).toMatchObject({ orphans: 1, tmp: 1 });
    expect(fs.existsSync(oldFile) && fs.existsSync(staleTmp)).toBe(true);

    const report = await gc();
    expect(report).toMatchObject({ orphans: 1, tmp: 1 });
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.existsSync(store.pathOf(kept))).toBe(true);
    expect(fs.existsSync(staleTmp)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);
    expect(report.storeFiles).toBe(2);
  });

  it('refuses a grace period under seven days, in the tool and in the database', async () => {
    await expect(runBlobGc(store, app, { graceDays: 3 })).rejects.toThrow(/at least 7 \(got 3\)/);
    await expect(runBlobGc(store, app, { graceDays: 7.5 })).rejects.toThrow(/whole number of days/);
    await expect(sql`SELECT * FROM hawa.blob_gc_sweep(interval '6 days')`.execute(app)).rejects.toThrow(/at least 7 days/);
  });

  it('the reference view reads every column that has a foreign key to hawa.blobs (coverage)', async () => {
    const fks = await owner.query(`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'hawa.blobs'::regclass`);
    const used = await owner.query(`
      SELECT table_schema || '.' || table_name AS tbl, column_name AS col FROM information_schema.view_column_usage
      WHERE view_schema = 'hawa' AND view_name = 'blob_references'`);
    const inView = new Set(used.rows.map((r) => `${String(r.tbl).replace(/^hawa\./, '')}.${r.col}`));
    const withFk = fks.rows.map((r) => `${String(r.tbl).replace(/^hawa\./, '')}.${r.col}`);
    // ADR-111 and ADR-112 retain studio model images and visual inputs through hawa.blobs (061, 062).
    const RETAINED_STUDIO = ['design_studio_call_results.image_blob_sha256', 'studio_visual_input_assets.blob_sha256'];
    const UPLOADED_SOURCES = ['brand_assets.blob_sha256', 'uploaded_asset_sources.source_sha256'];
    expect(withFk.sort()).toEqual([...WITH_FOREIGN_KEY, 'client_documents.source_sha256', ...RETAINED_STUDIO, ...UPLOADED_SOURCES].sort());
    for (const column of withFk) expect(inView, `${column} has a foreign key to hawa.blobs but blob_references does not read it`).toContain(column);
    // ADR-061 also retains a pending lifecycle decision's JSON blob reference before its
    // task_files row exists. The intake test exercises that branch; it has no foreign key.
    expect([...inView].sort()).toEqual([...BRANCHES,
      'client_documents.source_sha256', 'inbox_events.event_kind', 'inbox_events.payload', 'inbox_events.source_account_id', ...RETAINED_STUDIO, ...UPLOADED_SOURCES].sort());
  });
});
