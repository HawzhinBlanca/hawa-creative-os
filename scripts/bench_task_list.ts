/**
 * scripts/bench_task_list.ts: the task list's cost at office scale (architecture programme 0.3).
 *
 * The Desk read every page of GET /tasks every 30 s and 1 s after every task event, and each row ran
 * six correlated subqueries, two on columns with no index. This seeds a tenant of its own with
 * 5,000 tasks and the rows the list reads (intake events, some carrying a reference photo as the
 * Telegram intake stores one; design revisions; QC runs; approvals; Canva bindings) and times the
 * list query as the runtime role, inside the same row-level-security context the handler opens.
 *
 *   npx tsx scripts/bench_task_list.ts                      # seed if needed, time both queries
 *   npx tsx scripts/bench_task_list.ts --variant keyset --explain
 *   npx tsx scripts/bench_task_list.ts --tasks 5000 --photo-every 20 --photo-kb 100 --runs 50
 *
 * Databases come from TEST_DATABASE_URL (runtime role) and TEST_DATABASE_OWNER_URL (to seed), read
 * from the environment or the gitignored .env.test. The production server and the live database are
 * refused. Seeding tops the bench tenant up to the requested count and never deletes anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CompiledQuery, createDb, sql, withRlsContext, type Kysely, type Database } from '../packages/db/src/index.js';
import { buildTaskCountQuery, buildTaskPageQuery, decodeTaskCursor, listTaskPage, type TaskPageCursor, type TaskPageParams } from '../packages/db/src/repositories/task.repository.js';
import { assertTestDatabaseEnv } from '../packages/db/src/test-database-guard.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The bench tenant and its operator. Nothing else uses these ids. */
export const BENCH_TENANT_ID = '0bec0000-0000-4000-a000-000000005000';
export const BENCH_USER_ID = '0bec0000-0000-4000-b000-000000005000';
export const BENCH_CLIENT_IDS = Array.from({ length: 8 }, (_, i) => `0bec0000-0000-4000-c000-00000000500${i}`);
export const BENCH_RLS = { tenantId: BENCH_TENANT_ID, userId: BENCH_USER_ID, role: 'operator' } as const;
/** A designer who is a member of the first bench client only: row-level security shows them less. */
export const BENCH_DESIGNER_ID = '0bec0000-0000-4000-b000-000000005001';

export interface SeedOptions {
  /** Tasks the bench tenant should hold. */
  tasks?: number;
  /** Every Nth task's intake event carries a reference photo (0: none). */
  photoEvery?: number;
  /** Size of that photo before base64. */
  photoKb?: number;
}

/**
 * Tops the bench tenant up to `tasks` tasks, as the owner (who bypasses row-level security), in one
 * transaction, then refreshes the planner's statistics. Rows are shaped as production writes them:
 * the intake payload is stored twice in the task.created event (createTaskAggregate spreads it),
 * which is why a photo in it costs twice.
 */
export async function seedTaskListBench(ownerUrl: string, options: SeedOptions = {}): Promise<{ created: number; total: number }> {
  const target = options.tasks ?? 5000;
  const photoEvery = Math.max(0, Math.floor(options.photoEvery ?? 0));
  const photoHexChars = Math.max(32, Math.floor((options.photoKb ?? 100) * 1024 * 2));
  const owner = createDb(ownerUrl, { max: 1 });
  try {
    return await owner.transaction().execute(async (trx) => {
      const client = { query: (text: string, params: readonly unknown[] = []) => trx.executeQuery<any>(CompiledQuery.raw(text, [...params])) };
      await client.query('SET LOCAL search_path = hawa, public');
      // Two seeders (the bench and its test) must not both top up.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('hawa.bench_task_list'))");
      await client.query(
        `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Task list bench', 'bench-task-list') ON CONFLICT (id) DO NOTHING`,
        [BENCH_TENANT_ID]
      );
      await client.query(
        `INSERT INTO users (id, email, display_name) VALUES ($1, 'bench-task-list@test.invalid', 'Task list bench operator') ON CONFLICT (id) DO NOTHING`,
        [BENCH_USER_ID]
      );
      await client.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, active) VALUES ($1, $2, 'operator', true) ON CONFLICT DO NOTHING`,
        [BENCH_TENANT_ID, BENCH_USER_ID]
      );
      for (const [i, id] of BENCH_CLIENT_IDS.entries()) {
        await client.query(
          `INSERT INTO clients (id, tenant_id, code, name, default_language, status) VALUES ($1, $2, $3, $4, 'ckb', 'active') ON CONFLICT (id) DO NOTHING`,
          [id, BENCH_TENANT_ID, `bench-${i}`, `Bench client ${i} کۆمپانیا`]
        );
      }
      await client.query(
        `INSERT INTO users (id, email, display_name) VALUES ($1, 'bench-task-list-designer@test.invalid', 'Task list bench designer') ON CONFLICT (id) DO NOTHING`,
        [BENCH_DESIGNER_ID]
      );
      await client.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role, active) VALUES ($1, $2, 'designer', true) ON CONFLICT DO NOTHING`,
        [BENCH_TENANT_ID, BENCH_DESIGNER_ID]
      );
      await client.query(
        `INSERT INTO client_memberships (tenant_id, client_id, user_id, role, active) VALUES ($1, $2, $3, 'designer', true) ON CONFLICT DO NOTHING`,
        [BENCH_TENANT_ID, BENCH_CLIENT_IDS[0], BENCH_DESIGNER_ID]
      );
      await client.query(
        `INSERT INTO qc_profiles (tenant_id, name, version, rules, content_hash, status)
         VALUES ($1, 'bench-critical', '1', '{}'::jsonb, 'bench', 'active') ON CONFLICT DO NOTHING`,
        [BENCH_TENANT_ID]
      );
      const have = Number((await client.query('SELECT count(*) FROM tasks WHERE tenant_id = $1', [BENCH_TENANT_ID])).rows[0].count);
      const need = target - have;
      if (need <= 0) return { created: 0, total: have };

      await client.query(
        `CREATE TEMP TABLE bench_new ON COMMIT DROP AS
         SELECT g, gen_random_uuid() AS id,
           -- Two tasks share each timestamp, so the cursor's tie-break on id is exercised.
           timestamptz '2026-01-01 00:00:00+00' + ((g / 2) * interval '37 minutes') AS created_at,
           CASE WHEN g % 10 = 0 THEN NULL ELSE ($3::uuid[])[(g % 8) + 1] END AS client_id,
           (CASE
              WHEN g % 100 < 60 THEN 'complete' WHEN g % 100 < 68 THEN 'human_review' WHEN g % 100 < 73 THEN 'approved'
              WHEN g % 100 < 78 THEN 'revision_requested' WHEN g % 100 < 83 THEN 'failed_operator' WHEN g % 100 < 88 THEN 'received'
              WHEN g % 100 < 92 THEN 'studio_composition' WHEN g % 100 < 94 THEN 'publishing' WHEN g % 100 < 97 THEN 'paused'
              ELSE 'cancelled' END)::task_state AS state
         FROM generate_series($1::int, $2::int) g`,
        [have + 1, target, BENCH_CLIENT_IDS]
      );
      await client.query(
        `INSERT INTO tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at, language)
         SELECT id, $1, client_id, 'Bench request #' || g || ' — بانگهێشتی ئێوارە',
           'Members evening, December ' || (g % 28 + 1) || ', Erbil. ئێوارەی ئەندامان', state, (g % 5) + 1, 4, created_at, created_at, 'ckb'
         FROM bench_new`,
        [BENCH_TENANT_ID]
      );
      // The intake event, payload spread into the event as createTaskAggregate writes it.
      await client.query(
        `WITH p AS (
           SELECT n.id, n.g, n.client_id, n.created_at,
             jsonb_build_object(
               'sourcePlatform', 'telegram', 'sourceEventId', 'bench-' || n.g, 'sourceChannelId', '700000' || (n.g % 50),
               'headlineEn', 'Members evening ' || n.g, 'headlineCkb', 'ئێوارەی ئەندامان ' || n.g,
               'copyEn', 'December ' || (n.g % 28 + 1) || ', Erbil', 'copyCkb', 'هەولێر',
               'designInstructions', 'Use the club colours; keep the logo top right.',
               'rawRequestText', 'Members evening --- December, Erbil', 'workflow', 'canva', 'clientId', n.client_id
             ) || CASE WHEN $2::int > 0 AND n.g % $2::int = 0 THEN jsonb_build_object('studioOptions', jsonb_build_object('referencePhoto',
                  'data:image/jpeg;base64,' || encode(decode(
                    (SELECT string_agg(md5(random()::text || s::text), '') FROM generate_series(1, ($3::int / 32) + 0 * n.g) s), 'hex'), 'base64')))
                ELSE '{}'::jsonb END AS payload
           FROM bench_new n
         )
         INSERT INTO task_events (tenant_id, task_id, event_type, aggregate_version, actor_type, actor_id, correlation_id, data, occurred_at)
         SELECT $1, p.id, 'task.created', 1, 'adapter', 'telegram', gen_random_uuid(),
           jsonb_build_object('title', 'Bench request #' || p.g, 'clientId', p.client_id, 'state', 'received', 'priority', 3,
             'metadata', '{}'::jsonb, 'payload', p.payload) || p.payload,
           p.created_at
         FROM p`,
        [BENCH_TENANT_ID, photoEvery, photoHexChars]
      );
      await client.query(
        `INSERT INTO task_events (tenant_id, task_id, event_type, aggregate_version, actor_type, actor_id, correlation_id, data, occurred_at)
         SELECT $1, n.id, 'task.state_changed', v, 'workflow', 'bench', gen_random_uuid(),
           jsonb_build_object('fromState', 'received', 'toState', n.state::text, 'reason', 'bench step ' || v), n.created_at + v * interval '1 minute'
         FROM bench_new n CROSS JOIN generate_series(2, 4) v`,
        [BENCH_TENANT_ID]
      );
      // Four in five tasks have a design: one document and one to three revisions, each with a QC run.
      await client.query(
        `INSERT INTO design_documents (tenant_id, task_id, studio, studio_document_id, created_at)
         SELECT $1, n.id, 'canva', 'DAbench' || n.g, n.created_at FROM bench_new n WHERE n.g % 5 <> 0`,
        [BENCH_TENANT_ID]
      );
      await client.query(
        `INSERT INTO design_revisions (tenant_id, task_id, design_document_id, revision, studio, studio_version, studio_schema_version,
           source_storage_key, source_sha256, neutral_manifest, neutral_manifest_sha256, semantic_hash, author_type, author_id, status, created_at)
         SELECT $1, n.id, d.id, r, 'canva', '1', '1', 'bench/' || n.g || '/' || r,
           encode(sha256(convert_to(n.id::text || ':' || r, 'UTF8')), 'hex'),
           jsonb_build_object('width', 1080, 'height', 1350, 'studio', 'canva'),
           encode(sha256(convert_to('manifest:' || n.id::text || ':' || r, 'UTF8')), 'hex'), 'bench', 'model', 'canva_generator',
           'review', n.created_at + r * interval '5 minutes'
         FROM bench_new n JOIN design_documents d ON d.task_id = n.id CROSS JOIN LATERAL generate_series(1, (n.g % 3) + 1) r`,
        [BENCH_TENANT_ID]
      );
      await client.query(
        `INSERT INTO qc_runs (tenant_id, task_id, design_revision_id, qc_profile_id, status, critical_pass, report, started_at, completed_at)
         SELECT $1, dr.task_id, dr.id, (SELECT id FROM qc_profiles WHERE tenant_id = $1 AND name = 'bench-critical'),
           CASE WHEN dr.revision % 2 = 0 THEN 'failed' ELSE 'passed' END, dr.revision % 2 = 1,
           jsonb_build_object('bidiIsolation', true, 'safeMargins', NULL, 'contrastCompliant', NULL, 'fontCoverage', true, 'copyFidelity', true,
             'errors', CASE WHEN dr.revision % 2 = 0 THEN jsonb_build_array('Headline overflows its box') ELSE '[]'::jsonb END),
           dr.created_at + interval '1 minute', dr.created_at + interval '2 minutes'
         FROM design_revisions dr JOIN bench_new n ON n.id = dr.task_id`,
        [BENCH_TENANT_ID]
      );
      await client.query(
        `UPDATE tasks t SET current_design_revision_id = latest.id
         FROM (SELECT DISTINCT ON (dr.task_id) dr.task_id, dr.id FROM design_revisions dr JOIN bench_new n ON n.id = dr.task_id
               ORDER BY dr.task_id, dr.revision DESC) latest
         WHERE t.id = latest.task_id`
      );
      // An approval (or a request for changes) on the current revision of tasks that reached review.
      await client.query(
        `WITH decided AS (
           SELECT n.id AS task_id, n.state, t.current_design_revision_id AS revision_id,
             (SELECT q.id FROM qc_runs q WHERE q.design_revision_id = t.current_design_revision_id ORDER BY q.started_at DESC LIMIT 1) AS qc_run_id,
             n.created_at
           FROM bench_new n JOIN tasks t ON t.id = n.id
           WHERE t.current_design_revision_id IS NOT NULL AND n.state IN ('approved', 'publishing', 'complete', 'revision_requested')
         ), requests AS (
           INSERT INTO review_requests (tenant_id, task_id, design_revision_id, qc_run_id, stage, assigned_role, status, created_at)
           SELECT $1, task_id, revision_id, qc_run_id, 'art_director', 'approver', 'decided', created_at + interval '20 minutes'
           FROM decided
           RETURNING id, task_id
         )
         INSERT INTO approvals (tenant_id, task_id, review_request_id, design_revision_id, qc_run_id, decision, decided_by, decision_payload, nonce, created_at)
         SELECT $1, d.task_id, r.id, d.revision_id, d.qc_run_id,
           (CASE WHEN d.state = 'revision_requested' THEN 'revision_requested' ELSE 'approved' END)::approval_decision,
           $2, jsonb_build_object('approverRole', 'art_director'), gen_random_uuid()::text, d.created_at + interval '30 minutes'
         FROM decided d JOIN requests r ON r.task_id = d.task_id`,
        [BENCH_TENANT_ID, BENCH_USER_ID]
      );
      await client.query(
        `INSERT INTO canva_bindings (tenant_id, task_id, client_id, canva_design_id, edit_url, status, created_at, updated_at)
         SELECT $1, n.id, n.client_id, 'DAbench' || n.g, 'https://www.canva.com/design/DAbench' || n.g || '/edit', 'bound', n.created_at, n.created_at
         FROM bench_new n WHERE n.client_id IS NOT NULL AND n.g % 2 = 0`,
        [BENCH_TENANT_ID]
      );
      return { created: need, total: target };
    }).then(async (result) => {
      // Fresh statistics, so the planner sees the tenant as it is (autovacuum would, a minute later).
      if (result.created > 0) {
        for (const table of ['tasks', 'task_events', 'design_revisions', 'qc_runs', 'approvals', 'canva_bindings', 'clients']) {
          await owner.executeQuery(CompiledQuery.raw(`ANALYZE hawa.${table}`, []));
        }
      }
      return result;
    });
  } finally {
    await owner.destroy();
  }
}

/**
 * The list query as GET /tasks ran it before 0.3 (apps/core/src/app.ts at f143aa9), kept here only
 * to measure the baseline: offset paging, six correlated subqueries per row, the whole intake event.
 */
export function legacyTaskListQueries(trx: Kysely<Database>, tenantId: string, limit: number, offset: number) {
  const countQ = trx.selectFrom('tasks').select(trx.fn.count('id').as('count')).where('tenant_id', '=', tenantId);
  const q = trx.selectFrom('tasks').selectAll().select((eb) => [
    eb.selectFrom('task_events').select('data').whereRef('task_events.task_id', '=', 'tasks.id')
      .where('event_type', '=', 'task.created').limit(1).as('intake_data'),
    eb.selectFrom('clients').select('name').whereRef('clients.id', '=', 'tasks.client_id').limit(1).as('client_name'),
    sql<any>`(SELECT json_build_object('status', q.status, 'critical_pass', q.critical_pass, 'report', q.report) FROM hawa.qc_runs q WHERE q.task_id = tasks.id ORDER BY q.started_at DESC LIMIT 1)`.as('latest_qc_json'),
    sql<any>`(SELECT json_build_object('id', a.id, 'created_at', a.created_at, 'role', a.decision_payload->>'approverRole', 'actorId', a.decided_by) FROM hawa.approvals a WHERE a.task_id = tasks.id AND a.decision = 'approved' ORDER BY a.created_at DESC LIMIT 1)`.as('latest_approval_json'),
    sql<any>`(SELECT json_build_object('designId', b.canva_design_id, 'editUrl', b.edit_url) FROM hawa.canva_bindings b WHERE b.task_id = tasks.id AND b.status = 'bound' ORDER BY b.created_at DESC LIMIT 1)`.as('canva_binding_json'),
    sql<any>`(SELECT json_build_object('id', r.id, 'version', r.revision, 'sha256', r.source_sha256, 'format', 'png', 'created_at', r.created_at) FROM hawa.design_revisions r WHERE r.id = tasks.current_design_revision_id LIMIT 1)`.as('latest_rev_json'),
  ]).where('tenant_id', '=', tenantId).orderBy('created_at', 'desc').limit(limit).offset(offset);
  return { countQ, q };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)).toFixed(2));
}

/** EXPLAIN (ANALYZE, BUFFERS) of a compiled query, run in the caller's RLS context. */
export async function explainAnalyze(trx: Kysely<Database>, compiled: { sql: string; parameters: readonly unknown[] }): Promise<string> {
  const result = await trx.executeQuery<{ 'QUERY PLAN': string }>(CompiledQuery.raw(`EXPLAIN (ANALYZE, BUFFERS) ${compiled.sql}`, [...compiled.parameters]));
  return result.rows.map((r) => r['QUERY PLAN']).join('\n');
}

/** The keyset cursor of page `page` (1-based) of the unfiltered list, found by walking the pages. */
export async function cursorOfPage(db: Kysely<Database>, page: number, limit: number): Promise<string | null> {
  let cursor: string | null = null;
  for (let i = 1; i < page; i++) {
    const after: TaskPageCursor | null = cursor ? decodeTaskCursor(cursor) : null;
    const next: string | null = await withRlsContext(db, BENCH_RLS, async (trx) =>
      (await listTaskPage(trx, { tenantId: BENCH_TENANT_ID, limit, cursor: after })).nextCursor
    );
    if (!next) return cursor;
    cursor = next;
  }
  return cursor;
}

interface Timing { label: string; runs: number; p50: number; p95: number; max: number }

async function time(label: string, runs: number, once: () => Promise<unknown>, warm = true): Promise<Timing> {
  if (warm) await once(); // warm the cache and the pool, as a Desk that has been open a while has
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await once();
    samples.push(performance.now() - t0);
  }
  return { label, runs, p50: percentile(samples, 50), p95: percentile(samples, 95), max: Number(Math.max(...samples).toFixed(2)) };
}

function loadDatabaseEnv(): { appUrl: string; ownerUrl: string } {
  const file = path.join(root, '.env.test');
  const fromFile: Record<string, string> = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^(TEST_DATABASE_URL|TEST_DATABASE_OWNER_URL)=(.*)$/.exec(line.trim());
      if (m) fromFile[m[1]] = m[2];
    }
  }
  const appUrl = process.env.TEST_DATABASE_URL || fromFile.TEST_DATABASE_URL;
  const ownerUrl = process.env.TEST_DATABASE_OWNER_URL || fromFile.TEST_DATABASE_OWNER_URL;
  if (!appUrl || !ownerUrl) throw new Error('TEST_DATABASE_URL and TEST_DATABASE_OWNER_URL are required (environment or .env.test)');
  assertTestDatabaseEnv({ ...process.env, TEST_DATABASE_URL: appUrl, TEST_DATABASE_OWNER_URL: ownerUrl });
  return { appUrl, ownerUrl };
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const { appUrl, ownerUrl } = loadDatabaseEnv();
  const tasks = Number(arg('tasks', '5000'));
  const runs = Number(arg('runs', '50'));
  const variant = arg('variant', 'both');
  const limit = 50;
  const deepPage = 50;
  const explain = process.argv.includes('--explain');

  const seeded = await seedTaskListBench(ownerUrl, { tasks, photoEvery: Number(arg('photo-every', '20')), photoKb: Number(arg('photo-kb', '100')) });
  console.log(`bench tenant: ${seeded.total} tasks (${seeded.created} added now)`);

  const db = createDb(appUrl, { max: 2 });
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  try {
    const tenantId = BENCH_TENANT_ID;
    if (variant === 'legacy' || variant === 'both') {
      for (const [label, offset] of [['legacy page 1', 0], [`legacy page ${deepPage}`, (deepPage - 1) * limit]] as const) {
        timings.push(await time(label, runs, () => withRlsContext(db, BENCH_RLS, async (trx) => {
          const { countQ, q } = legacyTaskListQueries(trx, tenantId, limit, offset);
          await countQ.executeTakeFirst();
          return q.execute();
        })));
        if (explain) plans[label] = await withRlsContext(db, BENCH_RLS, (trx) => explainAnalyze(trx, legacyTaskListQueries(trx, tenantId, limit, offset).q.compile()));
      }
      // What one Desk refresh cost: every page of 200 until the total. Once: it takes minutes.
      timings.push(await time('legacy full queue read (Desk before 0.3)', 1, async () => {
        for (let offset = 0; ; offset += 200) {
          const page = await withRlsContext(db, BENCH_RLS, async (trx) => {
            const { countQ, q } = legacyTaskListQueries(trx, tenantId, 200, offset);
            await countQ.executeTakeFirst();
            return q.execute();
          });
          if (page.length < 200) break;
        }
      }, false));
    }
    if (variant === 'keyset' || variant === 'both') {
      const deepCursor = await cursorOfPage(db, deepPage, limit);
      const pages: Array<[string, TaskPageParams]> = [
        ['keyset page 1', { tenantId, limit }],
        [`keyset page ${deepPage}`, { tenantId, limit, cursor: deepCursor ? decodeTaskCursor(deepCursor) : null }],
        ['keyset page 1, filter "needs approval"', { tenantId, limit, states: ['human_review'] }],
        ['keyset page 1, search', { tenantId, limit, search: 'کۆمپانیا 3' }],
      ];
      for (const [label, params] of pages) {
        timings.push(await time(label, runs, () => withRlsContext(db, BENCH_RLS, (trx) => listTaskPage(trx, params))));
        if (explain) {
          plans[label] = await withRlsContext(db, BENCH_RLS, (trx) => explainAnalyze(trx, buildTaskPageQuery(params).compile(trx)));
          plans[`${label} (total)`] = await withRlsContext(db, BENCH_RLS, (trx) => explainAnalyze(trx, buildTaskCountQuery(params).compile(trx)));
        }
      }
    }
  } finally {
    await db.destroy();
  }

  console.log('\nlist query as the runtime role (hawa_app, RLS as the handler sets it), milliseconds per request:');
  for (const t of timings) console.log(`  ${t.label.padEnd(44)} p50 ${String(t.p50).padStart(8)}  p95 ${String(t.p95).padStart(8)}  max ${String(t.max).padStart(8)}  (${t.runs} runs)`);
  for (const [label, plan] of Object.entries(plans)) console.log(`\n--- EXPLAIN (ANALYZE, BUFFERS): ${label}\n${plan}`);
  console.log(`\n${JSON.stringify({ tasks: seeded.total, timings })}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
