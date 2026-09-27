import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, type RawBuilder } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';
import {
  buildTaskCountQuery,
  buildTaskPageQuery,
  dbStatesForApiStatuses,
  decodeTaskCursor,
  encodeTaskCursor,
  listTaskPage,
  type TaskPageParams,
} from '../src/repositories/task.repository.js';
import {
  BENCH_CLIENT_IDS,
  BENCH_DESIGNER_ID,
  BENCH_RLS,
  BENCH_TENANT_ID,
  legacyTaskListQueries,
  seedTaskListBench,
} from '../../../scripts/bench_task_list.js';

/**
 * Architecture programme 0.3 (2026-09-24): the task list at office scale. A tenant of its own holds
 * 5,000 tasks with their intake events, revisions, QC runs, approvals and Canva bindings
 * (scripts/bench_task_list.ts seeds it once and tops it up). Before, each page ran six correlated
 * subqueries per row over tables with no index on task_id and took about 7 s here; the Desk read
 * every page every 30 s.
 *
 * The timing lives in the bench script. These assert what does not depend on the machine: the plan
 * reads through indexes, a page costs the same at any depth, paging visits every task exactly once,
 * and row-level security shows each reader what the old query showed them.
 */
describe('the task list page query (PostgreSQL, 5,000 tasks, runtime role)', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const designer = { tenantId: BENCH_TENANT_ID, userId: BENCH_DESIGNER_ID, role: 'designer' };
  afterAll(() => db.destroy());

  beforeAll(async () => {
    await seedTaskListBench(process.env.TEST_DATABASE_OWNER_URL!, { tasks: 5000, photoEvery: 0 });
  }, 180_000);

  interface PlanNode {
    'Node Type': string;
    'Relation Name'?: string;
    'Index Name'?: string;
    'Actual Rows'?: number;
    'Actual Loops'?: number;
    'Shared Hit Blocks'?: number;
    'Shared Read Blocks'?: number;
    Plans?: PlanNode[];
  }

  const explain = async (params: TaskPageParams, build: (p: TaskPageParams) => RawBuilder<unknown> = buildTaskPageQuery) => {
    const rows = await withRlsContext(db, BENCH_RLS, async (trx) =>
      (await sql<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${build(params)}`.execute(trx)).rows
    );
    const root = rows[0]['QUERY PLAN'][0].Plan;
    const nodes: PlanNode[] = [];
    const walk = (n: PlanNode) => {
      nodes.push(n);
      (n.Plans || []).forEach(walk);
    };
    walk(root);
    return { root, nodes, buffers: (root['Shared Hit Blocks'] || 0) + (root['Shared Read Blocks'] || 0) };
  };

  const BIG_TABLES = ['tasks', 'task_events', 'qc_runs', 'approvals', 'design_revisions', 'canva_bindings'];

  it('reads the page and each row\'s latest QC run and approval through indexes, never a whole table', async () => {
    const { nodes } = await explain({ tenantId: BENCH_TENANT_ID, limit: 50 });
    const indexes = nodes.map((n) => n['Index Name']).filter(Boolean);
    expect(indexes).toEqual(expect.arrayContaining(['tasks_list_idx', 'qc_runs_task_idx', 'approvals_task_idx']));
    const seqScans = nodes.filter((n) => n['Node Type'] === 'Seq Scan' && BIG_TABLES.includes(String(n['Relation Name'])));
    expect(seqScans.map((n) => n['Relation Name'])).toEqual([]);
    // The keyset scan stops after the page (and one row to tell whether another page exists).
    const pageScan = nodes.find((n) => n['Index Name'] === 'tasks_list_idx')!;
    expect(pageScan['Actual Rows']).toBeLessThanOrEqual(51);
  });

  it('costs the same at page 50 as at page 1 (keyset, not offset)', async () => {
    let cursor: string | null = null;
    for (let page = 1; page < 50; page++) {
      const after: ReturnType<typeof decodeTaskCursor> = cursor ? decodeTaskCursor(cursor) : null;
      cursor = (await withRlsContext(db, BENCH_RLS, (trx) => listTaskPage(trx, { tenantId: BENCH_TENANT_ID, limit: 50, cursor: after }))).nextCursor;
      expect(cursor).not.toBeNull();
    }
    const first = await explain({ tenantId: BENCH_TENANT_ID, limit: 50 });
    const deep = await explain({ tenantId: BENCH_TENANT_ID, limit: 50, cursor: decodeTaskCursor(cursor!) });
    expect(deep.nodes.find((n) => n['Index Name'] === 'tasks_list_idx')!['Actual Rows']).toBeLessThanOrEqual(51);
    expect(deep.buffers).toBeLessThanOrEqual(first.buffers * 1.5 + 100);
  });

  it('the total reads the tasks table alone (the planner may scan it whole: it is the tenant\'s rows)', async () => {
    const { nodes } = await explain({ tenantId: BENCH_TENANT_ID, limit: 50 }, buildTaskCountQuery);
    const relations = new Set(nodes.map((n) => n['Relation Name']).filter(Boolean));
    expect([...relations]).toEqual(['tasks']);
  });

  it('pages through all 5,000 tasks by cursor: each exactly once, newest first, ties broken by id', async () => {
    const seen: Array<{ id: string; created: string }> = [];
    let cursor: string | null = null;
    let total = -1;
    do {
      const after: ReturnType<typeof decodeTaskCursor> = cursor ? decodeTaskCursor(cursor) : null;
      const page: Awaited<ReturnType<typeof listTaskPage>> = await withRlsContext(db, BENCH_RLS, (trx) => listTaskPage(trx, { tenantId: BENCH_TENANT_ID, limit: 200, cursor: after }));
      total = page.total;
      seen.push(...page.rows.map((r) => ({ id: r.id, created: r.cursor_created_at })));
      cursor = page.nextCursor;
    } while (cursor);
    expect(total).toBeGreaterThanOrEqual(5000);
    expect(seen).toHaveLength(total);
    expect(new Set(seen.map((r) => r.id)).size).toBe(total);
    for (let i = 1; i < seen.length; i++) {
      const [a, b] = [seen[i - 1], seen[i]];
      expect(a.created > b.created || (a.created === b.created && a.id > b.id)).toBe(true);
    }
    // The seed gives pairs of tasks the same created_at, so the tie-break was exercised.
    expect(seen.some((r, i) => i > 0 && r.created === seen[i - 1].created)).toBe(true);
  }, 120_000);

  it('filters by status and searches with the Arabic-keyboard letters folded, and the total counts the same filter', async () => {
    const approval = await withRlsContext(db, BENCH_RLS, (trx) =>
      listTaskPage(trx, { tenantId: BENCH_TENANT_ID, limit: 20, states: dbStatesForApiStatuses(['AWAITING_APPROVAL']) })
    );
    expect(approval.rows.length).toBe(20);
    expect(approval.rows.every((r) => r.state === 'human_review')).toBe(true);
    const counted = await withRlsContext(db, BENCH_RLS, async (trx) =>
      Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.tasks WHERE tenant_id = ${BENCH_TENANT_ID}::uuid AND state = 'human_review'`.execute(trx)).rows[0].n)
    );
    expect(approval.total).toBe(counted);

    // "كۆمپانیا" typed with the Arabic kaf finds the clients named with the Sorani one (کۆمپانیا).
    const search = await withRlsContext(db, BENCH_RLS, (trx) =>
      listTaskPage(trx, { tenantId: BENCH_TENANT_ID, limit: 10, search: 'client 3 كۆمپانیا' })
    );
    expect(search.total).toBeGreaterThan(0);
    expect(search.rows.every((r) => r.client_id === BENCH_CLIENT_IDS[3])).toBe(true);
    // A LIKE wildcard in the search is a character, not a pattern.
    const wildcard = await withRlsContext(db, BENCH_RLS, (trx) => listTaskPage(trx, { tenantId: BENCH_TENANT_ID, limit: 10, search: '%' }));
    expect(wildcard.total).toBe(0);
    // A status the API never reports matches nothing (toDbTaskState would have made it 'received').
    expect(dbStatesForApiStatuses(['IN_PROGRESS'])).toEqual([]);
    expect(dbStatesForApiStatuses(['OPERATOR_REQUIRED'])).toEqual(['failed_retryable', 'failed_operator']);
  });

  it('shows each reader what the old query showed them (row-level security unchanged)', async () => {
    // The designer is a member of the first bench client only; the operator sees the whole tenant.
    for (const [who, ctx, clientId] of [
      ['operator', BENCH_RLS, BENCH_CLIENT_IDS[1]],
      ['designer', designer, undefined],
    ] as const) {
      const compare = await withRlsContext(db, ctx, async (trx) => {
        const legacy = legacyTaskListQueries(trx, BENCH_TENANT_ID, 200, 0);
        let legacyQ = legacy.q;
        let legacyCount = legacy.countQ;
        if (clientId) {
          legacyQ = legacyQ.where('client_id', '=', clientId);
          legacyCount = legacyCount.where('client_id', '=', clientId);
        }
        const before = await legacyQ.execute();
        const beforeTotal = Number((await legacyCount.executeTakeFirst())?.count || 0);
        const after = await listTaskPage(trx, { tenantId: BENCH_TENANT_ID, limit: 200, clientId });
        return { before, beforeTotal, after };
      });
      expect({ who, total: compare.after.total }).toEqual({ who, total: compare.beforeTotal });
      const pick = (r: any) => ({
        id: r.id,
        client: r.client_name ?? null,
        qc: r.qc_status ?? r.latest_qc_json?.status ?? null,
        approval: r.approval_id ?? r.latest_approval_json?.id ?? null,
        binding: r.canva_design_id ?? r.canva_binding_json?.designId ?? null,
        revision: r.rev_id ?? r.latest_rev_json?.id ?? null,
        headline: r.headline_ckb ?? r.intake_data?.payload?.headlineCkb ?? null,
      });
      const byId = (rows: any[]) => new Map(rows.map((r) => [r.id, pick(r)]));
      const before = byId(compare.before);
      const after = byId(compare.after.rows);
      // Same rows (the old query ordered by created_at only, so a tie at the page edge may differ).
      const shared = [...after.keys()].filter((id) => before.has(id));
      expect(shared.length).toBeGreaterThanOrEqual(Math.min(after.size, before.size) - 1);
      for (const id of shared) expect(after.get(id)).toEqual(before.get(id));
      if (who === 'designer') {
        expect(compare.after.rows.every((r) => r.client_id === null || r.client_id === BENCH_CLIENT_IDS[0])).toBe(true);
        expect(compare.after.total).toBeLessThan(5000);
      }
    }
  }, 60_000);

  it('rows carry no intake JSON and no image bytes, even for a task whose intake holds a photo', async () => {
    const photoTask = await withRlsContext(db, BENCH_RLS, async (trx) =>
      (await sql<{ id: string }>`SELECT task_id AS id FROM hawa.task_events
        WHERE tenant_id = ${BENCH_TENANT_ID}::uuid AND event_type = 'task.created' AND data ? 'studioOptions' LIMIT 1`.execute(trx)).rows[0]
    );
    const page = await withRlsContext(db, BENCH_RLS, (trx) => listTaskPage(trx, { tenantId: BENCH_TENANT_ID, limit: 200 }));
    const text = JSON.stringify(page.rows);
    expect(text).not.toMatch(/data:image|base64/);
    expect(Object.keys(page.rows[0])).not.toContain('intake_data');
    if (photoTask) {
      // Seeded with photos by the bench script: the row is there, and it is small.
      const row = await withRlsContext(db, BENCH_RLS, (trx) =>
        listTaskPage(trx, { tenantId: BENCH_TENANT_ID, limit: 1, search: photoTask.id })
      );
      expect(row.rows[0]?.id).toBe(photoTask.id);
      expect(JSON.stringify(row.rows[0]).length).toBeLessThan(4_000);
    }
  });

  it('refuses a cursor it did not issue', () => {
    expect(decodeTaskCursor('not-a-cursor')).toBeNull();
    expect(decodeTaskCursor(Buffer.from('["2026-01-01", "x"]').toString('base64url'))).toBeNull();
    const cursor = { createdAt: '2026-01-01T00:00:00.123456Z', id: '0bec0000-0000-4000-a000-000000005000' };
    expect(decodeTaskCursor(encodeTaskCursor(cursor))).toEqual(cursor);
  });
});
