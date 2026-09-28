/**
 * The office's queue at load-test size: tasks in the chaos stack's own tenant (the one the Desk's
 * sign-in sees), shaped as production writes them. The rows are those scripts/bench_task_list.ts
 * seeds for its own tenant (programme 0.3): the intake event with the payload stored twice, some
 * carrying a reference photo as the Telegram intake stores one; one to three design revisions with a
 * QC run each; approvals; Canva bindings. Here they go into the tenant the Desk reads, because the
 * load test drives the Desk itself, which cannot be pointed at the bench tenant.
 *
 * Only the chaos database is accepted (assertChaosDatabaseUrl): 127.0.0.1:56432, hawa_chaos.
 */
import { CompiledQuery, createDb } from '../../packages/db/src/index.js';
import { assertChaosDatabaseUrl } from './load-stats.js';

/** The chaos stack's tenant (db/seed.sql) and its Primary Operator, who decides the seeded approvals. */
export const CHAOS_TENANT_ID = '00000000-0000-4000-a000-000000000001';
export const CHAOS_OPERATOR_ID = '00000000-0000-4000-b000-000000000001';
/** Eight clients of the load test's own, so the queue shows a spread of client names. */
export const LOAD_CLIENT_IDS = Array.from({ length: 8 }, (_, i) => `10ad0000-0000-4000-c000-00000000000${i}`);

export interface SeedOptions {
  tasks?: number;
  /** Every Nth task's intake event carries a reference photo (0: none). */
  photoEvery?: number;
  /** Size of that photo before base64. */
  photoKb?: number;
}

/**
 * Tops the chaos tenant up to `tasks` seeded tasks, as the owner (who bypasses row-level security),
 * in one transaction, then refreshes the planner's statistics. Returns how many it added and how long
 * that took. Seeded tasks are told apart by their intake's sourceEventId (`load-<n>`).
 */
export async function seedDeskTasks(ownerUrl: string, options: SeedOptions = {}): Promise<{ created: number; total: number; ms: number }> {
  assertChaosDatabaseUrl(ownerUrl);
  const owner = createDb(ownerUrl, { max: 1 });
  try {
    return await seedDeskTasksWith(owner, options);
  } finally {
    await owner.destroy();
  }
}

/**
 * The seeding itself, on a connection the caller owns and has already checked. Only seedDeskTasks
 * (the chaos database) and scripts/load/test/seed-desk-tasks.test.ts (a per-file test clone, which
 * checks these rows against the current schema) call it.
 */
export async function seedDeskTasksWith(owner: ReturnType<typeof createDb>, options: SeedOptions = {}): Promise<{ created: number; total: number; ms: number }> {
  const target = options.tasks ?? 5000;
  const photoEvery = Math.max(0, Math.floor(options.photoEvery ?? 20));
  const photoHexChars = Math.max(32, Math.floor((options.photoKb ?? 100) * 1024 * 2));
  const started = Date.now();
  {
    const result = await owner.transaction().execute(async (trx) => {
      const q = (text: string, params: readonly unknown[] = []) => trx.executeQuery<Record<string, unknown>>(CompiledQuery.raw(text, [...params]));
      await q('SET LOCAL search_path = hawa, public');
      for (const [i, id] of LOAD_CLIENT_IDS.entries()) {
        await q(
          `INSERT INTO clients (id, tenant_id, code, name, default_language, status) VALUES ($1, $2, $3, $4, 'ckb', 'active') ON CONFLICT (id) DO NOTHING`,
          [id, CHAOS_TENANT_ID, `load-${i}`, `Load client ${i} کۆمپانیا`]
        );
      }
      await q(
        `INSERT INTO qc_profiles (tenant_id, name, version, rules, content_hash, status)
         VALUES ($1, 'load-critical', '1', '{}'::jsonb, 'load', 'active') ON CONFLICT DO NOTHING`,
        [CHAOS_TENANT_ID]
      );
      const have = Number((await q(`SELECT count(*) AS n FROM task_events WHERE tenant_id = $1 AND event_type = 'task.created' AND data->>'sourceEventId' LIKE 'load-%'`, [CHAOS_TENANT_ID])).rows[0].n);
      const need = target - have;
      if (need <= 0) return { created: 0, total: have };

      await q(
        `CREATE TEMP TABLE load_new ON COMMIT DROP AS
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
        [have + 1, target, LOAD_CLIENT_IDS]
      );
      await q(
        `INSERT INTO tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at, language)
         SELECT id, $1, client_id, 'Load request #' || g || ' — بانگهێشتی ئێوارە',
           'Members evening, December ' || (g % 28 + 1) || ', Erbil. ئێوارەی ئەندامان', state, (g % 5) + 1, 4, created_at, created_at, 'ckb'
         FROM load_new`,
        [CHAOS_TENANT_ID]
      );
      // The intake event, payload spread into the event as createTaskAggregate writes it.
      await q(
        `WITH p AS (
           SELECT n.id, n.g, n.client_id, n.created_at,
             jsonb_build_object(
               'sourcePlatform', 'telegram', 'sourceEventId', 'load-' || n.g, 'sourceChannelId', '700000' || (n.g % 50),
               'headlineEn', 'Members evening ' || n.g, 'headlineCkb', 'ئێوارەی ئەندامان ' || n.g,
               'copyEn', 'December ' || (n.g % 28 + 1) || ', Erbil', 'copyCkb', 'هەولێر',
               'designInstructions', 'Use the club colours; keep the logo top right.',
               'rawRequestText', 'Members evening --- December, Erbil', 'workflow', 'canva', 'clientId', n.client_id
             ) || CASE WHEN $2::int > 0 AND n.g % $2::int = 0 THEN jsonb_build_object('studioOptions', jsonb_build_object('referencePhoto',
                  'data:image/jpeg;base64,' || encode(decode(
                    (SELECT string_agg(md5(random()::text || s::text), '') FROM generate_series(1, ($3::int / 32) + 0 * n.g) s), 'hex'), 'base64')))
                ELSE '{}'::jsonb END AS payload
           FROM load_new n
         )
         INSERT INTO task_events (tenant_id, task_id, event_type, aggregate_version, actor_type, actor_id, correlation_id, data, occurred_at)
         SELECT $1, p.id, 'task.created', 1, 'adapter', 'telegram', gen_random_uuid(),
           jsonb_build_object('title', 'Load request #' || p.g, 'clientId', p.client_id, 'state', 'received', 'priority', 3,
             'metadata', '{}'::jsonb, 'payload', p.payload) || p.payload,
           p.created_at
         FROM p`,
        [CHAOS_TENANT_ID, photoEvery, photoHexChars]
      );
      await q(
        `INSERT INTO task_events (tenant_id, task_id, event_type, aggregate_version, actor_type, actor_id, correlation_id, data, occurred_at)
         SELECT $1, n.id, 'task.state_changed', v, 'workflow', 'load', gen_random_uuid(),
           jsonb_build_object('fromState', 'received', 'toState', n.state::text, 'reason', 'load step ' || v), n.created_at + v * interval '1 minute'
         FROM load_new n CROSS JOIN generate_series(2, 4) v`,
        [CHAOS_TENANT_ID]
      );
      // Four in five tasks have a design: one document and one to three revisions, each with a QC run.
      await q(
        `INSERT INTO design_documents (tenant_id, task_id, studio, studio_document_id, created_at)
         SELECT $1, n.id, 'canva', 'DAload' || n.g, n.created_at FROM load_new n WHERE n.g % 5 <> 0`,
        [CHAOS_TENANT_ID]
      );
      await q(
        `INSERT INTO design_revisions (tenant_id, task_id, design_document_id, revision, studio, studio_version, studio_schema_version,
           source_storage_key, source_sha256, neutral_manifest, neutral_manifest_sha256, semantic_hash, author_type, author_id, status, created_at)
         SELECT $1, n.id, d.id, r, 'canva', '1', '1', 'load/' || n.g || '/' || r,
           encode(sha256(convert_to(n.id::text || ':' || r, 'UTF8')), 'hex'),
           jsonb_build_object('width', 1080, 'height', 1350, 'studio', 'canva'),
           encode(sha256(convert_to('manifest:' || n.id::text || ':' || r, 'UTF8')), 'hex'), 'load', 'model', 'canva_generator',
           'review', n.created_at + r * interval '5 minutes'
         FROM load_new n JOIN design_documents d ON d.task_id = n.id CROSS JOIN LATERAL generate_series(1, (n.g % 3) + 1) r`,
        [CHAOS_TENANT_ID]
      );
      await q(
        `INSERT INTO qc_runs (tenant_id, task_id, design_revision_id, qc_profile_id, status, critical_pass, report, started_at, completed_at)
         SELECT $1, dr.task_id, dr.id, (SELECT id FROM qc_profiles WHERE tenant_id = $1 AND name = 'load-critical'),
           CASE WHEN dr.revision % 2 = 0 THEN 'failed' ELSE 'passed' END, dr.revision % 2 = 1,
           jsonb_build_object('bidiIsolation', true, 'safeMargins', NULL, 'contrastCompliant', NULL, 'fontCoverage', true, 'copyFidelity', true,
             'errors', CASE WHEN dr.revision % 2 = 0 THEN jsonb_build_array('Headline overflows its box') ELSE '[]'::jsonb END),
           dr.created_at + interval '1 minute', dr.created_at + interval '2 minutes'
         FROM design_revisions dr JOIN load_new n ON n.id = dr.task_id`,
        [CHAOS_TENANT_ID]
      );
      await q(
        `UPDATE tasks t SET current_design_revision_id = latest.id
         FROM (SELECT DISTINCT ON (dr.task_id) dr.task_id, dr.id FROM design_revisions dr JOIN load_new n ON n.id = dr.task_id
               ORDER BY dr.task_id, dr.revision DESC) latest
         WHERE t.id = latest.task_id`
      );
      await q(
        `WITH decided AS (
           SELECT n.id AS task_id, n.state, t.current_design_revision_id AS revision_id,
             (SELECT q.id FROM qc_runs q WHERE q.design_revision_id = t.current_design_revision_id ORDER BY q.started_at DESC LIMIT 1) AS qc_run_id,
             n.created_at
           FROM load_new n JOIN tasks t ON t.id = n.id
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
        [CHAOS_TENANT_ID, CHAOS_OPERATOR_ID]
      );
      await q(
        `INSERT INTO canva_bindings (tenant_id, task_id, client_id, canva_design_id, edit_url, status, created_at, updated_at)
         SELECT $1, n.id, n.client_id, 'DAload' || n.g, 'https://www.canva.com/design/DAload' || n.g || '/edit', 'bound', n.created_at, n.created_at
         FROM load_new n WHERE n.client_id IS NOT NULL AND n.g % 2 = 0`,
        [CHAOS_TENANT_ID]
      );
      return { created: need, total: target };
    });
    if (result.created > 0) {
      // Fresh statistics, so the planner sees the tenant as it is (autovacuum would, a minute later).
      for (const table of ['tasks', 'task_events', 'design_revisions', 'qc_runs', 'approvals', 'canva_bindings', 'clients']) {
        await owner.executeQuery(CompiledQuery.raw(`ANALYZE hawa.${table}`, []));
      }
    }
    return { ...result, ms: Date.now() - started };
  }
}
