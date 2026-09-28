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
import {
  assertPreconditions,
  assertTargetAllowed,
  isProductionTarget,
  runBackfill,
  rehearsalReceipt,
  PHASES,
  type PhaseReport,
} from '../../../scripts/blob_backfill.js';

/**
 * The backfill (ADR-035, FILESTORE_DESIGN.md section 5) on seeded legacy rows in every table that
 * holds bytes: a task.created event and its outbox command with a reference photo, a legacy planner
 * request with one, a plan source and its editable source, a studio candidate's three PNGs, a cut-out
 * and its shadow, and a comparison pair whose study is already judging.
 *
 * Copy is idempotent (a second run writes nothing) and resumable (a run stopped by --limit finishes on
 * the next); verify counts what is left; strip empties only rows whose file the store has, with the
 * protective triggers enabled again afterwards; production is refused before any connection.
 *
 * Runs as the owner against this file's own clone on the test server, with a temporary store.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const TENANT = '00000000-0000-4000-a000-000000000001';
const CLIENT = 'c1000000-0000-4000-8000-000000000001';

describe.skipIf(!ownerUrl)('scripts/blob_backfill.ts', () => {
  const target = new URL(ownerUrl!);
  const database = target.pathname.slice(1);
  if (target.port !== '55432' || !/^hawa_t_[a-z0-9_]+$/.test(database)) throw new Error(`refusing ${target.port}/${database}`);
  const db = createDb(ownerUrl!);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-backfill-test-'));
  const store = new BlobStore({ root, db });
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(3000)]);
  const pptx = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(5000)]);
  const uri = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;

  const seeded = {
    photo: png(),
    planPhoto: png(),
    source: pptx(),
    preview: png(),
    composite: png(),
    art: png(),
    cutout: png(),
    shadow: png(),
    hawa: png(),
    designer: png(),
    ids: {} as Record<string, string>,
  };

  const task = async (title: string) => {
    const id = randomUUID();
    await sql`INSERT INTO hawa.tasks(id, tenant_id, client_id, title) VALUES (${id}::uuid, ${TENANT}::uuid, ${CLIENT}::uuid, ${title})`.execute(db);
    return id;
  };
  const created = async (taskId: string, studioOptions: Record<string, unknown>) => {
    const payload = { rawRequestText: 'Members evening', studioOptions };
    await sql`INSERT INTO hawa.task_events(tenant_id, task_id, event_type, aggregate_version, actor_type, actor_id, correlation_id, data)
      VALUES (${TENANT}::uuid, ${taskId}::uuid, 'task.created', 1, 'user', 'test', gen_random_uuid(), ${JSON.stringify({ payload, ...payload })}::jsonb)`.execute(db);
    await sql`INSERT INTO hawa.outbox_commands(tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload)
      VALUES (${TENANT}::uuid, 'task', ${taskId}::uuid, 'task.created', ${'backfill-' + taskId}, ${JSON.stringify({ ...payload, taskId, requestHash: 'h' })}::jsonb)`.execute(db);
  };

  const all = (reports: PhaseReport[]) => reports.reduce((n, r) => ({ stored: n.stored + r.stored, linked: n.linked + r.linked, stripped: n.stripped + r.stripped }), { stored: 0, linked: 0, stripped: 0 });
  const phase = (reports: PhaseReport[], p: string) => reports.find((r) => r.phase === p)!;
  const row = async (q: ReturnType<typeof sql<any>>) => (await q.execute(db)).rows[0];

  beforeAll(async () => {
    await initBlobStoreDir(root);
    const ids = seeded.ids;
    ids.photoTask = await task('backfill photo');
    await created(ids.photoTask, { referenceImageBase64: uri(seeded.photo) });
    ids.brokenTask = await task('backfill broken photo');
    await created(ids.brokenTask, { referenceImageBase64: 'data:image/png;base64,not*base64' });

    // A legacy planner request carrying the photo, with its PPTX source, and the editable source
    // Canva imported (the same bytes).
    ids.planTask = await task('backfill plan');
    ids.plan = randomUUID();
    await sql`INSERT INTO hawa.canva_design_plans(id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, status, result, source_content, source_sha256)
      VALUES (${ids.plan}::uuid, ${TENANT}::uuid, ${ids.planTask}::uuid, ${CLIENT}::uuid, 'test', 'plan-k', 'h',
        ${JSON.stringify({ referenceImageBase64: uri(seeded.planPhoto) })}::jsonb, 'planned', '{"manifest":{}}'::jsonb, ${seeded.source}, ${sha(seeded.source)})`.execute(db);
    const op = randomUUID();
    await sql`INSERT INTO hawa.canva_remote_operations(id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status)
      VALUES (${op}::uuid, ${TENANT}::uuid, ${ids.planTask}::uuid, ${CLIENT}::uuid, 'test', 'op-k', 'h', 'create', 'retrieved')`.execute(db);
    ids.editable = randomUUID();
    await sql`INSERT INTO hawa.canva_editable_sources(id, tenant_id, task_id, client_id, actor_id, operation_id, sha256, content, manifest)
      VALUES (${ids.editable}::uuid, ${TENANT}::uuid, ${ids.planTask}::uuid, ${CLIENT}::uuid, 'test', ${op}::uuid, ${sha(seeded.source)}, ${seeded.source}, '{}'::jsonb)`.execute(db);

    // A studio candidate as the old Core wrote it: preview and art hashes, no composite hash.
    const run = randomUUID();
    await sql`INSERT INTO hawa.design_studio_runs(id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status)
      VALUES (${run}::uuid, ${TENANT}::uuid, ${ids.photoTask}::uuid, ${CLIENT}::uuid, 'test', 'k', 'h', '{}', 'standard', 'awaiting_selection')`.execute(db);
    ids.candidate = randomUUID();
    await sql`INSERT INTO hawa.design_studio_candidates(id, run_id, tenant_id, ordinal, concept, status, preview_png, preview_sha256, composite_png, art_png, art_sha256)
      VALUES (${ids.candidate}::uuid, ${run}::uuid, ${TENANT}::uuid, 1, '{}', 'draft', ${seeded.preview}, ${sha(seeded.preview)}, ${seeded.composite}, ${seeded.art}, ${sha(seeded.art)})`.execute(db);

    ids.cutout = randomUUID();
    await sql`INSERT INTO hawa.photo_cutouts(id, tenant_id, source_sha256, model, model_sha256, passed, png, width, height, shadow_png, shadow, report)
      VALUES (${ids.cutout}::uuid, ${TENANT}::uuid, ${sha(randomBytes(8))}, 'm', ${sha(randomBytes(8))}, true, ${seeded.cutout}, 10, 10, ${seeded.shadow}, '{"width":4,"height":4,"x":0,"y":0}'::jsonb, '{}'::jsonb)`.execute(db);

    // A comparison pair of a study that has started judging: its row is protected by a trigger.
    const study = randomUUID();
    await sql`INSERT INTO hawa.comparison_studies(id, tenant_id, name, preregistration, created_by)
      VALUES (${study}::uuid, ${TENANT}::uuid, 'Backfill study', '{}'::jsonb, 'test')`.execute(db);
    ids.pair = randomUUID();
    await sql`INSERT INTO hawa.comparison_pairs(id, study_id, tenant_id, label, width, height, hawa_png, designer_png, hawa_sha256, designer_sha256)
      VALUES (${ids.pair}::uuid, ${study}::uuid, ${TENANT}::uuid, 'P01', 10, 10, ${seeded.hawa}, ${seeded.designer}, ${sha(seeded.hawa)}, ${sha(seeded.designer)})`.execute(db);
    await sql`UPDATE hawa.comparison_studies SET status = 'judging', locked_at = now() WHERE id = ${study}::uuid`.execute(db);
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('checks its preconditions: 019 applied, row-level security bypassed, the store marked', async () => {
    await expect(assertPreconditions(db, store)).resolves.toBeUndefined();
    const unmarked = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-backfill-unmarked-'));
    try {
      await expect(assertPreconditions(db, new BlobStore({ root: unmarked, db }))).rejects.toThrow(/not a blob store/);
    } finally {
      fs.rmSync(unmarked, { recursive: true, force: true });
    }
  });

  it('copy stopped by --limit resumes on the next run, and a third run writes nothing', async () => {
    const first = await runBackfill({ db, store, phases: PHASES, mode: 'copy', batch: 2, limit: 3 });
    expect(first.some((r) => r.stoppedEarly)).toBe(true);
    expect(all(first).stored).toBe(3);
    const pending = await runBackfill({ db, store, phases: PHASES, mode: 'verify' });
    expect(pending.reduce((n, r) => n + r.notCopied, 0)).toBeGreaterThan(0);

    const second = await runBackfill({ db, store, phases: PHASES, mode: 'copy', batch: 2 });
    expect(second.some((r) => r.stoppedEarly)).toBe(false);
    expect(all(second).stored).toBeGreaterThan(0);

    const third = await runBackfill({ db, store, phases: PHASES, mode: 'copy', batch: 2 });
    expect(all(third)).toEqual({ stored: 0, linked: 0, stripped: 0 });
    // The undecodable photo is reported every time and left where it is.
    expect(phase(third, 'reference_photos').problems.map((p) => p.id)).toContain(
      (await row(sql`SELECT id::text AS id FROM hawa.task_events WHERE task_id = ${seeded.ids.brokenTask}::uuid`)).id
    );
  }, 120_000);

  it('after copy every seeded file is in the store, linked, and no row\'s bytes or JSON changed', async () => {
    const { ids } = seeded;
    for (const bytes of [seeded.photo, seeded.planPhoto, seeded.source, seeded.preview, seeded.composite, seeded.art, seeded.cutout, seeded.shadow, seeded.hawa, seeded.designer]) {
      expect((await store.read(sha(bytes), { verify: true })).equals(bytes)).toBe(true);
    }
    const files = (await sql<{ task_id: string; sha256: string }>`SELECT task_id::text, sha256 FROM hawa.task_files
      WHERE task_id IN (${ids.photoTask}::uuid, ${ids.planTask}::uuid, ${ids.brokenTask}::uuid) ORDER BY sha256`.execute(db)).rows;
    expect(files).toEqual(
      [{ task_id: ids.photoTask, sha256: sha(seeded.photo) }, { task_id: ids.planTask, sha256: sha(seeded.planPhoto) }].sort((a, b) => a.sha256.localeCompare(b.sha256))
    );
    const cand = await row(sql`SELECT composite_sha256, preview_png IS NOT NULL AS has_preview FROM hawa.design_studio_candidates WHERE id = ${ids.candidate}::uuid`);
    expect(cand).toEqual({ composite_sha256: sha(seeded.composite), has_preview: true });
    const cut = await row(sql`SELECT png_sha256, shadow_sha256, png IS NOT NULL AS has_png FROM hawa.photo_cutouts WHERE id = ${ids.cutout}::uuid`);
    expect(cut).toEqual({ png_sha256: sha(seeded.cutout), shadow_sha256: sha(seeded.shadow), has_png: true });
    const event = await row(sql`SELECT data->'payload'->'studioOptions'->>'referenceImageBase64' AS image FROM hawa.task_events WHERE task_id = ${ids.photoTask}::uuid`);
    expect(event.image).toBe(uri(seeded.photo));
  });

  it('a second, different photo of a task that already has one is copied too, and verify counts it until it is', async () => {
    const { ids } = seeded;
    const second = png();
    await sql`INSERT INTO hawa.outbox_commands(tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload)
      VALUES (${TENANT}::uuid, 'task', ${ids.photoTask}::uuid, 'task.dispatch', ${'backfill-second-' + ids.photoTask},
        ${JSON.stringify({ taskId: ids.photoTask, studioOptions: { referenceImageBase64: uri(second) } })}::jsonb)`.execute(db);
    const before = await runBackfill({ db, store, phases: ['reference_photos'], mode: 'verify' });
    expect(before[0].notCopied).toBe(1);

    const copied = await runBackfill({ db, store, phases: ['reference_photos'], mode: 'copy' });
    expect(copied[0]).toMatchObject({ stored: 1, linked: 1 });
    const shas = (await sql<{ sha256: string }>`SELECT sha256 FROM hawa.task_files WHERE task_id = ${ids.photoTask}::uuid ORDER BY sha256`.execute(db)).rows.map((r) => r.sha256);
    expect(shas).toEqual([sha(seeded.photo), sha(second)].sort());
    expect((await runBackfill({ db, store, phases: ['reference_photos'], mode: 'verify' }))[0].notCopied).toBe(0);
  });

  it('copy never links a row to bytes the row no longer holds (Core replaced them mid-batch)', async () => {
    const run = (await row(sql`SELECT run_id::text AS id FROM hawa.design_studio_candidates WHERE id = ${seeded.ids.candidate}::uuid`)).id;
    const raced = randomUUID();
    const before = png();
    const after = png();
    await sql`INSERT INTO hawa.design_studio_candidates(id, run_id, tenant_id, ordinal, concept, status, composite_png)
      VALUES (${raced}::uuid, ${run}::uuid, ${TENANT}::uuid, 3, '{}', 'draft', ${before})`.execute(db);
    // Core writes a new composite (its own put failed, so no hash) between the backfill's select and update.
    const racing = Object.create(store) as BlobStore;
    racing.put = async (bytes: Buffer, mediaType: Parameters<BlobStore['put']>[1]) => {
      const ref = await store.put(bytes, mediaType);
      if (bytes.equals(before)) await sql`UPDATE hawa.design_studio_candidates SET composite_png = ${after}, composite_sha256 = NULL WHERE id = ${raced}::uuid`.execute(db);
      return ref;
    };
    await runBackfill({ db, store: racing, phases: ['candidates'], mode: 'copy' });
    expect((await row(sql`SELECT composite_sha256 FROM hawa.design_studio_candidates WHERE id = ${raced}::uuid`)).composite_sha256).toBeNull();

    // The next run links the bytes the row holds now.
    await runBackfill({ db, store, phases: ['candidates'], mode: 'copy' });
    expect((await row(sql`SELECT composite_sha256 FROM hawa.design_studio_candidates WHERE id = ${raced}::uuid`)).composite_sha256).toBe(sha(after));
  });

  it('verify counts nothing left to copy, and names what strip would empty', async () => {
    const reports = await runBackfill({ db, store, phases: PHASES, mode: 'verify' });
    for (const p of ['plan_sources', 'candidates', 'cutouts', 'comparisons']) {
      expect(phase(reports, p).notCopied, p).toBe(0);
      expect(phase(reports, p).strippable, p).toBeGreaterThan(0);
      expect(phase(reports, p).problems, p).toEqual([]);
    }
    expect(phase(reports, 'reference_photos').inlineJson).toBeGreaterThan(0);
  });

  it('strip empties only rows whose file the store has, through the triggers, and leaves them enabled', async () => {
    const { ids } = seeded;
    // A candidate copied but whose file has since gone: never stripped.
    const lost = png();
    await store.put(lost, 'image/png');
    const run = (await row(sql`SELECT run_id::text AS id FROM hawa.design_studio_candidates WHERE id = ${ids.candidate}::uuid`)).id;
    const lostCandidate = randomUUID();
    await sql`INSERT INTO hawa.design_studio_candidates(id, run_id, tenant_id, ordinal, concept, status, preview_png, preview_sha256)
      VALUES (${lostCandidate}::uuid, ${run}::uuid, ${TENANT}::uuid, 2, '{}', 'draft', ${lost}, ${sha(lost)})`.execute(db);
    fs.chmodSync(store.pathOf({ sha256: sha(lost), mediaType: 'image/png' }), 0o644);
    fs.rmSync(store.pathOf({ sha256: sha(lost), mediaType: 'image/png' }));

    const reports = await runBackfill({ db, store, phases: PHASES, mode: 'strip', batch: 2 });
    expect(phase(reports, 'reference_photos').problems[0]?.problem).toMatch(/refused/);
    // Nine seeded columns: the plan and editable sources, three candidate PNGs, the cut-out and its shadow, two arms.
    expect(all(reports).stripped).toBeGreaterThanOrEqual(9);
    expect(phase(reports, 'candidates').problems.map((p) => p.id)).toContain(lostCandidate);

    expect(await row(sql`SELECT source_content IS NULL AS gone FROM hawa.canva_design_plans WHERE id = ${ids.plan}::uuid`)).toEqual({ gone: true });
    expect(await row(sql`SELECT content IS NULL AS gone FROM hawa.canva_editable_sources WHERE id = ${ids.editable}::uuid`)).toEqual({ gone: true });
    expect(await row(sql`SELECT preview_png IS NULL AND composite_png IS NULL AND art_png IS NULL AS gone FROM hawa.design_studio_candidates WHERE id = ${ids.candidate}::uuid`)).toEqual({ gone: true });
    expect(await row(sql`SELECT preview_png IS NOT NULL AS kept FROM hawa.design_studio_candidates WHERE id = ${lostCandidate}::uuid`)).toEqual({ kept: true });
    expect(await row(sql`SELECT png IS NULL AND shadow_png IS NULL AS gone FROM hawa.photo_cutouts WHERE id = ${ids.cutout}::uuid`)).toEqual({ gone: true });
    expect(await row(sql`SELECT hawa_png IS NULL AND designer_png IS NULL AS gone FROM hawa.comparison_pairs WHERE id = ${ids.pair}::uuid`)).toEqual({ gone: true });
    // The JSON keeps its photo (reference photos are not stripped in this release).
    expect((await row(sql`SELECT data::text AS d FROM hawa.task_events WHERE task_id = ${ids.photoTask}::uuid`)).d).toContain('data:image/png;base64,');

    const triggers = (await sql<{ tgname: string; tgenabled: string }>`SELECT tgname, tgenabled FROM pg_trigger
      WHERE tgname IN ('task_events_append_only', 'immutable_canva_plan', 'canva_editable_sources_immutable', 'protect_comparison_pair') ORDER BY tgname`.execute(db)).rows;
    expect(triggers).toEqual([
      { tgname: 'canva_editable_sources_immutable', tgenabled: 'O' },
      { tgname: 'immutable_canva_plan', tgenabled: 'O' },
      { tgname: 'protect_comparison_pair', tgenabled: 'O' },
      { tgname: 'task_events_append_only', tgenabled: 'O' },
    ]);
    // Still protected: the judging study's pair cannot change.
    await expect(sql`UPDATE hawa.comparison_pairs SET label = 'P02' WHERE id = ${ids.pair}::uuid`.execute(db)).rejects.toThrow(/cannot change/);

    // A second strip finds nothing more to do, and verify has nothing left but the lost file.
    const again = await runBackfill({ db, store, phases: PHASES, mode: 'strip' });
    expect(all(again).stripped).toBe(0);
    const verify = await runBackfill({ db, store, phases: ['candidates'], mode: 'verify' });
    // Only the candidate whose file went missing still holds bytes, and verify names its missing file.
    expect(verify[0].strippable).toBe(1);
    expect(verify[0].problems.map((p) => p.id)).toEqual([lostCandidate]);
    expect(verify[0].problems[0].problem).toMatch(/missing/);
  }, 120_000);

  it('the CLI runs a copy against the database it is given and prints its summary', () => {
    const logFile = path.join(root, 'tmp', 'progress.ndjson');
    const r = spawnSync(path.join(repo, 'node_modules/.bin/tsx'), ['scripts/blob_backfill.ts', '--phase', 'candidates,cutouts', '--mode', 'copy', '--log', logFile], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120_000,
      env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), DATABASE_URL: ownerUrl!, HAWA_BLOB_DIR: root },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const summary = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(summary).toMatchObject({ database, mode: 'copy', phases: ['candidates', 'cutouts'] });
    // Everything was copied by the runs above: nothing more to write.
    expect(summary.reports.map((x: PhaseReport) => x.stored)).toEqual([0, 0]);
  }, 120_000);

  it('verify names every row whose hash has no file row (release B\'s foreign keys reject it), and the receipt counts them', async () => {
    const { ids } = seeded;
    const run = (await row(sql`SELECT run_id::text AS id FROM hawa.design_studio_candidates WHERE id = ${ids.candidate}::uuid`)).id;
    // A candidate whose preview hash names a file that was never stored, with no bytes to copy it from.
    const dangling = randomUUID();
    await sql`INSERT INTO hawa.design_studio_candidates(id, run_id, tenant_id, ordinal, concept, status, preview_sha256)
      VALUES (${dangling}::uuid, ${run}::uuid, ${TENANT}::uuid, 4, '{}', 'draft', ${sha(png())})`.execute(db);
    // A plan whose source is no PPTX, as the rehearsal found in production (an orchestrator test's
    // fixture, 2026-09-14): copy leaves it, so its hash names no file either.
    const fixtureTask = await task('backfill fixture plan');
    const fixturePlan = randomUUID();
    const fixtureBytes = Buffer.from('fallback-plan-content');
    await sql`INSERT INTO hawa.canva_design_plans(id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, status, result, source_content, source_sha256)
      VALUES (${fixturePlan}::uuid, ${TENANT}::uuid, ${fixtureTask}::uuid, ${CLIENT}::uuid, 'test', 'plan-fixture', 'h', '{}'::jsonb, 'planned', '{}'::jsonb, ${fixtureBytes}, ${sha(fixtureBytes)})`.execute(db);

    const reports = await runBackfill({ db, store, phases: ['plan_sources', 'candidates'], mode: 'verify' });
    const problems = reports.flatMap((r) => r.problems);
    expect(problems.find((p) => p.id === dangling)).toMatchObject({ table: 'design_studio_candidates', leftAsIs: true, blocksForeignKey: true });
    expect(problems.find((p) => p.id === fixturePlan)).toMatchObject({ table: 'canva_design_plans', leftAsIs: true, blocksForeignKey: true });
    // The candidate whose file went missing still has its file row: the foreign key accepts it (verify
    // fails it for the missing file instead).
    const missingFile = problems.filter((p) => /missing/.test(p.problem));
    expect(missingFile.length).toBeGreaterThan(0);
    expect(missingFile.some((p) => p.blocksForeignKey)).toBe(false);

    const receipt = rehearsalReceipt('hawa_restore_x', {}, reports);
    expect(receipt.foreignKeyBlockers).toBe(2);
    expect(receipt.leftAsIs.filter((x) => x.blocksForeignKey).map((x) => x.id).sort()).toEqual([dangling, fixturePlan].sort());

    // Copy cannot mend either: nothing to put.
    const copy = await runBackfill({ db, store, phases: ['plan_sources', 'candidates'], mode: 'copy' });
    expect(all(copy).stored).toBe(0);
    await sql`DELETE FROM hawa.design_studio_candidates WHERE id = ${dangling}::uuid`.execute(db);
  });

  it('a run stopped by a signal finishes the row in hand, says so, and the next run copies the rest', async () => {
    const run = (await row(sql`SELECT run_id::text AS id FROM hawa.design_studio_candidates WHERE id = ${seeded.ids.candidate}::uuid`)).id;
    for (const ordinal of [5, 6, 7]) {
      await sql`INSERT INTO hawa.design_studio_candidates(id, run_id, tenant_id, ordinal, concept, status, composite_png)
        VALUES (${randomUUID()}::uuid, ${run}::uuid, ${TENANT}::uuid, ${ordinal}, '{}', 'draft', ${png()})`.execute(db);
    }
    let written = 0;
    const first = await runBackfill({
      db, store, phases: ['candidates'], mode: 'copy', batch: 1,
      log: (line) => { if (line.sha256) written++; },
      shouldStop: () => written >= 1, // SIGINT arrives while the first batch is being written
    });
    expect(first[0]).toMatchObject({ stored: 1, linked: 1, stoppedEarly: true });
    const second = await runBackfill({ db, store, phases: ['candidates'], mode: 'copy', batch: 1 });
    expect(second[0]).toMatchObject({ stored: 2, linked: 2, stoppedEarly: false });
  });

  it('the CLI exits 3 when a run stops before it is done, and 0 once a later run finishes', async () => {
    const run = (await row(sql`SELECT run_id::text AS id FROM hawa.design_studio_candidates WHERE id = ${seeded.ids.candidate}::uuid`)).id;
    for (const ordinal of [8, 9]) {
      await sql`INSERT INTO hawa.design_studio_candidates(id, run_id, tenant_id, ordinal, concept, status, composite_png)
        VALUES (${randomUUID()}::uuid, ${run}::uuid, ${TENANT}::uuid, ${ordinal}, '{}', 'draft', ${png()})`.execute(db);
    }
    const cli = () => spawnSync(path.join(repo, 'node_modules/.bin/tsx'), ['scripts/blob_backfill.ts', '--phase', 'candidates', '--mode', 'copy', '--batch', '1', '--limit', '1', '--log', path.join(root, 'tmp', 'limit.ndjson')], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120_000,
      env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), DATABASE_URL: ownerUrl!, HAWA_BLOB_DIR: root },
    });
    const stopped = cli();
    expect(stopped.status).toBe(3);
    expect(JSON.parse(stopped.stdout.trim().split('\n').pop()!).reports[0]).toMatchObject({ stored: 1, stoppedEarly: true });
    const finished = cli();
    expect(finished.status).toBe(0);
    expect(JSON.parse(finished.stdout.trim().split('\n').pop()!).reports[0]).toMatchObject({ stored: 1, stoppedEarly: false });
  }, 120_000);

  describe('production', () => {
    const receiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-backfill-receipt-'));
    const receipt = path.join(receiptDir, 'rehearsal.json');
    const migrations = { '019_blob_store.sql': 'a'.repeat(64) };
    fs.writeFileSync(receipt, JSON.stringify({ database: 'hawa_restore_20260924', verifyFailures: 0, migrations }));
    afterAll(() => fs.rmSync(receiptDir, { recursive: true, force: true }));
    const prodPort = ['postgres://owner@127.0.0.1', '54332/anything'].join(':');
    const prodName = 'postgres://owner@127.0.0.1:1/hawa';

    it('is port 54332 or the database named hawa', () => {
      expect(isProductionTarget(prodPort)).toBe(true);
      expect(isProductionTarget(prodName)).toBe(true);
      expect(isProductionTarget(ownerUrl!)).toBe(false);
      expect(isProductionTarget(ownerUrl!, 'hawa')).toBe(true);
    });

    it('strip is refused there whatever is given', () => {
      for (const databaseUrl of [prodPort, prodName]) {
        expect(() => assertTargetAllowed({ databaseUrl, mode: 'strip', production: true, receiptPath: receipt, migrations })).toThrow(/strip does not run against production/);
      }
    });

    it('copy needs --production and a clean rehearsal receipt with the same migrations', () => {
      expect(() => assertTargetAllowed({ databaseUrl: prodName, mode: 'copy', production: false })).toThrow(/pass --production/);
      expect(() => assertTargetAllowed({ databaseUrl: prodName, mode: 'copy', production: true, receiptPath: path.join(receiptDir, 'none.json'), migrations })).toThrow(/no rehearsal receipt/);
      expect(() => assertTargetAllowed({ databaseUrl: prodName, mode: 'copy', production: true, receiptPath: receipt, migrations: { ...migrations, '020_x.sql': 'b'.repeat(64) } })).toThrow(/migration checksums differ/);
      expect(() => assertTargetAllowed({ databaseUrl: prodName, mode: 'copy', production: true, receiptPath: receipt, migrations })).not.toThrow();
      expect(() => assertTargetAllowed({ databaseUrl: ownerUrl!, mode: 'strip', production: false })).not.toThrow();
    });

    it('a rehearsal receipt comes only from a verify run on a hawa_restore_* copy, and counts what is left as failures', async () => {
      const verify = await runBackfill({ db, store, phases: ['candidates'], mode: 'verify' });
      expect(() => rehearsalReceipt(database, migrations, verify)).toThrow(/hawa_restore_/);
      const copy = await runBackfill({ db, store, phases: ['candidates'], mode: 'copy' });
      expect(() => rehearsalReceipt('hawa_restore_x', migrations, copy)).toThrow(/verify run/);
      const receipt = rehearsalReceipt('hawa_restore_x', migrations, verify);
      // The candidate whose file went missing (strip test above) is one failure: production stays refused.
      expect(receipt).toMatchObject({ database: 'hawa_restore_x', migrations, verifyFailures: 1, phases: ['candidates'] });
      const clean = rehearsalReceipt('hawa_restore_x', migrations, [{ ...verify[0], problems: [], notCopied: 0 }]);
      expect(clean.verifyFailures).toBe(0);
    });

    it('rows copy leaves as they are are listed apart in the receipt and must be accepted by count', async () => {
      const verify = await runBackfill({ db, store, phases: ['reference_photos'], mode: 'verify' });
      const r = rehearsalReceipt('hawa_restore_x', migrations, verify);
      // The undecodable photo, in its task.created event and its outbox command: not failures, but listed.
      expect(r.verifyFailures).toBe(0);
      expect(r.leftAsIs.map((x) => x.table).sort()).toEqual(['outbox_commands', 'task_events']);
      expect(r.leftAsIs.every((x) => /left as it is/.test(x.problem))).toBe(true);

      const withLeft = path.join(receiptDir, 'left.json');
      fs.writeFileSync(withLeft, JSON.stringify({ ...r, database: 'hawa_restore_20260924' }));
      expect(() => assertTargetAllowed({ databaseUrl: prodName, mode: 'copy', production: true, receiptPath: withLeft, migrations })).toThrow(/--accept-left-as-is 2/);
      expect(() => assertTargetAllowed({ databaseUrl: prodName, mode: 'copy', production: true, receiptPath: withLeft, migrations, acceptLeftAsIs: 1 })).toThrow(/left 2 row/);
      expect(() => assertTargetAllowed({ databaseUrl: prodName, mode: 'copy', production: true, receiptPath: withLeft, migrations, acceptLeftAsIs: 2 })).not.toThrow();
    });

    it('the CLI refuses a production strip before it connects', () => {
      const r = spawnSync(path.join(repo, 'node_modules/.bin/tsx'), ['scripts/blob_backfill.ts', '--phase', 'all', '--mode', 'strip'], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 60_000,
        env: { PATH: process.env.PATH ?? '', HOME: receiptDir, DATABASE_URL: prodName, HAWA_BLOB_DIR: root },
      });
      expect(r.stderr).toMatch(/Refused: strip does not run against production/);
      expect(r.status).toBe(2);
    });
  });
});
