import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { createDb } from '../src/client.js';
import { BlobStore, initBlobStoreDir } from '../src/blobs/store.js';
import { runBackfill, type PhaseReport } from '../../../scripts/blob_backfill.js';

/**
 * When the backfill says it stopped (FILESTORE_DESIGN.md section 5; exit 3 means "rows left, run it
 * again"). A run is stopped only when a row it would have written is left: rows that are already
 * linked, or that copy and strip leave as they are, are not work left, so a run that ran out of budget
 * or got SIGINT just as the last writable row was done has finished.
 *
 * Also: a row whose bytes do not hash to the hash it names, when that hash does name a stored file.
 * Copy skips it (its file is there) and strip's update skips it (the bytes differ), so verify and strip
 * must say so rather than count it as strippable for ever.
 *
 * Its own clone on the test server (the rows here would change blob-backfill.test.ts's counts), with a
 * temporary store.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const TENANT = '00000000-0000-4000-a000-000000000001';
const CLIENT = 'c1000000-0000-4000-8000-000000000001';

describe.skipIf(!ownerUrl)('blob_backfill: stopped means rows are left', () => {
  const target = new URL(ownerUrl!);
  const database = target.pathname.slice(1);
  if (target.port !== '55432' || !/^hawa_t_[a-z0-9_]+$/.test(database)) throw new Error(`refusing ${target.port}/${database}`);
  const db = createDb(ownerUrl!);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-backfill-stop-'));
  const store = new BlobStore({ root, db });
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(3000)]);
  const uri = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;
  // Keyset order is the row id, so fixed ids decide which row a batch of one reads next.
  const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

  const task = async (title: string) => {
    const taskId = randomUUID();
    await sql`INSERT INTO hawa.tasks(id, tenant_id, client_id, title) VALUES (${taskId}::uuid, ${TENANT}::uuid, ${CLIENT}::uuid, ${title})`.execute(db);
    return taskId;
  };
  // A task.created event and its outbox command, both carrying the photo, as production writes them.
  const withPhoto = async (title: string) => {
    const taskId = await task(title);
    const payload = { rawRequestText: 'Members evening', studioOptions: { referenceImageBase64: uri(png()) } };
    await sql`INSERT INTO hawa.task_events(tenant_id, task_id, event_type, aggregate_version, actor_type, actor_id, correlation_id, data)
      VALUES (${TENANT}::uuid, ${taskId}::uuid, 'task.created', 1, 'user', 'test', gen_random_uuid(), ${JSON.stringify({ payload, ...payload })}::jsonb)`.execute(db);
    await sql`INSERT INTO hawa.outbox_commands(tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload)
      VALUES (${TENANT}::uuid, 'task', ${taskId}::uuid, 'task.created', ${'stop-' + taskId}, ${JSON.stringify({ ...payload, taskId, requestHash: 'h' })}::jsonb)`.execute(db);
    return taskId;
  };
  const cli = (args: string[]) =>
    spawnSync(path.join(repo, 'node_modules/.bin/tsx'), ['scripts/blob_backfill.ts', ...args, '--log', path.join(root, 'tmp', `cli-${randomUUID()}.ndjson`)], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120_000,
      env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), DATABASE_URL: ownerUrl!, HAWA_BLOB_DIR: root },
    });
  const lastReport = (stdout: string): PhaseReport => JSON.parse(stdout.trim().split('\n').pop()!).reports[0];

  let run = '';
  beforeAll(async () => {
    await initBlobStoreDir(root);
    const runTask = await task('stop run');
    run = randomUUID();
    await sql`INSERT INTO hawa.design_studio_runs(id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status)
      VALUES (${run}::uuid, ${TENANT}::uuid, ${runTask}::uuid, ${CLIENT}::uuid, 'test', 'k', 'h', '{}', 'standard', 'awaiting_selection')`.execute(db);
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reference photos: a run whose budget ends on the last unlinked photo is done, though its outbox row is still read', async () => {
    await withPhoto('stop photo');
    // The event links the photo; the outbox command carries the same photo, already linked.
    const first = await runBackfill({ db, store, phases: ['reference_photos'], mode: 'copy', limit: 1 });
    expect(first[0]).toMatchObject({ stored: 1, linked: 1, stoppedEarly: false });
    const second = await runBackfill({ db, store, phases: ['reference_photos'], mode: 'copy' });
    expect(second[0]).toMatchObject({ stored: 0, linked: 0, stoppedEarly: false });
  });

  it('reference photos: the CLI exits 0, not 3, when --limit ends exactly as the phase is done', () => {
    return withPhoto('stop photo cli').then(() => {
      const r = cli(['--phase', 'reference_photos', '--mode', 'copy', '--limit', '1']);
      expect(r.stderr).toBe('');
      expect(lastReport(r.stdout)).toMatchObject({ stored: 1, linked: 1, stoppedEarly: false });
      expect(r.status).toBe(0);
    });
  }, 120_000);

  it('reference photos: a run stopped with an unlinked photo left is stopped, and the next run links it', async () => {
    await withPhoto('stop photo a');
    await withPhoto('stop photo b');
    const first = await runBackfill({ db, store, phases: ['reference_photos'], mode: 'copy', limit: 1 });
    expect(first[0]).toMatchObject({ stored: 1, linked: 1, stoppedEarly: true });
    const second = await runBackfill({ db, store, phases: ['reference_photos'], mode: 'copy' });
    expect(second[0]).toMatchObject({ stored: 1, linked: 1, stoppedEarly: false });
  });

  it('bytea copy: rows left as they are after the budget runs out are not rows left to copy', async () => {
    // The first row is copied; the second is not an image, so copy leaves it as it is.
    await sql`INSERT INTO hawa.design_studio_candidates(id, run_id, tenant_id, ordinal, concept, status, composite_png)
      VALUES (${id(0xa1)}::uuid, ${run}::uuid, ${TENANT}::uuid, 1, '{}', 'draft', ${png()}),
             (${id(0xa2)}::uuid, ${run}::uuid, ${TENANT}::uuid, 2, '{}', 'draft', ${Buffer.from('not an image at all')})`.execute(db);
    const first = await runBackfill({ db, store, phases: ['candidates'], mode: 'copy', batch: 1, limit: 1 });
    expect(first[0]).toMatchObject({ stored: 1, linked: 1, stoppedEarly: false });
    expect(first[0].problems.map((p) => p.id)).toEqual([id(0xa2)]);

    const r = cli(['--phase', 'candidates', '--mode', 'copy', '--batch', '1', '--limit', '1']);
    // Nothing to write, one row left as it is: exit 1 (problems to read), not 3.
    expect(lastReport(r.stdout)).toMatchObject({ stored: 0, stoppedEarly: false });
    expect(r.status).toBe(1);

    // With two copyable rows left, a budget of one is a stopped run, and the next run finishes.
    await sql`INSERT INTO hawa.design_studio_candidates(id, run_id, tenant_id, ordinal, concept, status, composite_png)
      VALUES (${id(0xa3)}::uuid, ${run}::uuid, ${TENANT}::uuid, 3, '{}', 'draft', ${png()}),
             (${id(0xa4)}::uuid, ${run}::uuid, ${TENANT}::uuid, 4, '{}', 'draft', ${png()})`.execute(db);
    const limited = await runBackfill({ db, store, phases: ['candidates'], mode: 'copy', batch: 1, limit: 1 });
    expect(limited[0]).toMatchObject({ stored: 1, stoppedEarly: true });
    const rest = await runBackfill({ db, store, phases: ['candidates'], mode: 'copy', batch: 1 });
    expect(rest[0]).toMatchObject({ stored: 1, stoppedEarly: false });
  }, 120_000);

  describe('a row whose bytes differ from the stored file its hash names', () => {
    const good = png();
    const other = png();
    const named = png();
    beforeAll(async () => {
      for (const b of [good, named]) await store.put(b, 'image/png');
      const cutout = (n: number, bytes: Buffer, shaOf: Buffer) =>
        sql`INSERT INTO hawa.photo_cutouts(id, tenant_id, source_sha256, model, model_sha256, passed, png, png_sha256, width, height, report)
          VALUES (${id(n)}::uuid, ${TENANT}::uuid, ${sha(randomBytes(8))}, 'm', ${sha(randomBytes(8))}, true, ${bytes}, ${sha(shaOf)}, 10, 10, '{}'::jsonb)`.execute(db);
      await cutout(0xc1, good, good);
      // Its png_sha256 names a stored file, but the png column holds other bytes.
      await cutout(0xc2, other, named);
    });

    it('verify reports it, left as it is, and does not count it as strippable', async () => {
      const [report] = await runBackfill({ db, store, phases: ['cutouts'], mode: 'verify' });
      expect(report.strippable).toBe(1);
      expect(report.notCopied).toBe(0);
      expect(report.problems).toHaveLength(1);
      expect(report.problems[0]).toMatchObject({ table: 'photo_cutouts', id: id(0xc2), leftAsIs: true });
      expect(report.problems[0].blocksForeignKey).toBeUndefined();
    });

    it('strip reports it, leaves its bytes, and is not stopped by it when the budget ends before it', async () => {
      const [report] = await runBackfill({ db, store, phases: ['cutouts'], mode: 'strip', batch: 1, limit: 1 });
      expect(report).toMatchObject({ stripped: 1, stoppedEarly: false });
      expect(report.problems.map((p) => [p.id, p.leftAsIs])).toEqual([[id(0xc2), true]]);
      const rows = (await sql<{ id: string; kept: boolean }>`SELECT id::text AS id, png IS NOT NULL AS kept FROM hawa.photo_cutouts ORDER BY id`.execute(db)).rows;
      expect(rows).toEqual([{ id: id(0xc1), kept: false }, { id: id(0xc2), kept: true }]);

      const again = await runBackfill({ db, store, phases: ['cutouts'], mode: 'strip' });
      expect(again[0]).toMatchObject({ stripped: 0, stoppedEarly: false });
    });

    it('strip with a budget of one and two strippable rows left stops, and the next run strips the other', async () => {
      const more = [png(), png()];
      for (const [i, b] of more.entries()) {
        await store.put(b, 'image/png');
        await sql`INSERT INTO hawa.photo_cutouts(id, tenant_id, source_sha256, model, model_sha256, passed, png, png_sha256, width, height, report)
          VALUES (${id(0xc3 + i)}::uuid, ${TENANT}::uuid, ${sha(randomBytes(8))}, 'm', ${sha(randomBytes(8))}, true, ${b}, ${sha(b)}, 10, 10, '{}'::jsonb)`.execute(db);
      }
      const first = await runBackfill({ db, store, phases: ['cutouts'], mode: 'strip', batch: 5, limit: 1 });
      expect(first[0]).toMatchObject({ stripped: 1, stoppedEarly: true });
      const second = await runBackfill({ db, store, phases: ['cutouts'], mode: 'strip', batch: 5 });
      expect(second[0]).toMatchObject({ stripped: 1, stoppedEarly: false });
    });
  });
});
