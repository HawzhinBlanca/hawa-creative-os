import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';

/**
 * Migration 023 (architecture programme Phase 2, slice 2.3; PHASE2_DESIGN.md 2.8): hawa.requests,
 * tasks.request_id and hawa.lifecycle_projections. The application may create a request and move
 * its stage and revision, never change its owner, move its revision back or remove it; a projection
 * record is written once and never changed. Access follows the request's root task.
 */
const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const TENANT = '00000000-0000-4000-a000-000000000001';
const OPERATOR = { tenantId: TENANT, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' };
const HASH = 'a'.repeat(64);

describe.skipIf(!appUrl || !ownerUrl)('migration 023: the request lifecycle\'s tables', () => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  const app = createDb(appUrl!);
  const marker = `lc-${randomUUID().slice(0, 8)}`;
  const [clientA, clientB] = [randomUUID(), randomUUID()];
  const designer = randomUUID();
  beforeAll(async () => {
    await owner.connect();
    for (const [id, code] of [[clientA, `${marker}-a`], [clientB, `${marker}-b`]]) {
      await owner.query('INSERT INTO hawa.clients (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)', [id, TENANT, code, code]);
    }
    await owner.query('INSERT INTO hawa.users (id, email, display_name) VALUES ($1, $2, $3)', [designer, `${marker}@test.invalid`, 'designer']);
    await owner.query(`INSERT INTO hawa.client_memberships (tenant_id, client_id, user_id, role, active) VALUES ($1, $2, $3, 'designer', true)`, [TENANT, clientA, designer]);
  });
  afterAll(async () => {
    await owner.end();
    await app.destroy();
  });

  const newTask = async (clientId: string | null = clientA) => {
    const task = randomUUID();
    await owner.query(`INSERT INTO hawa.tasks (id, tenant_id, client_id, title) VALUES ($1, $2, $3, 'lifecycle test')`, [task, TENANT, clientId]);
    return task;
  };
  const addRequest = (task: string, scope: { tenantId: string; userId: string; role: string } = OPERATOR, request = randomUUID()) =>
    withRlsContext(app, scope, (trx) => sql<{ request_id: string }>`
      INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, owner, stage, rev, chat_id)
      VALUES (${request}::uuid, ${scope.tenantId}::uuid, ${task}::uuid, ${task}::uuid, 'restate', 'designing', 1, '9300101')
      RETURNING request_id`.execute(trx)).then((r) => r.rows[0].request_id);
  const addProjection = (request: string, rev: number, key: string, scope = OPERATOR) =>
    withRlsContext(app, scope, (trx) => sql`
      INSERT INTO hawa.lifecycle_projections (tenant_id, request_id, rev, idempotency_key, request_hash, result)
      VALUES (${scope.tenantId}::uuid, ${request}::uuid, ${rev}, ${key}, ${HASH}, '{"status":"applied"}'::jsonb)`.execute(trx));

  it('is recorded by the upgrade runner, with tasks.request_id and its index', async () => {
    expect((await owner.query(`SELECT 1 FROM hawa.schema_upgrades WHERE name = '023_request_lifecycle.sql'`)).rowCount).toBe(1);
    const column = await owner.query(`SELECT data_type FROM information_schema.columns WHERE table_schema = 'hawa' AND table_name = 'tasks' AND column_name = 'request_id'`);
    expect(column.rows).toEqual([{ data_type: 'uuid' }]);
    expect((await owner.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'hawa' AND indexname = 'tasks_request_idx'`)).rowCount).toBe(1);
  });

  it('lets the application create a request, move its stage and revision, and read it', async () => {
    const task = await newTask();
    const request = await addRequest(task);
    await withRlsContext(app, OPERATOR, (trx) => sql`UPDATE hawa.requests SET stage = 'in_review', rev = 2, draft_sent_at = now() WHERE request_id = ${request}::uuid`.execute(trx));
    const read = await withRlsContext(app, OPERATOR, (trx) => sql<{ stage: string; rev: string; owner: string }>`SELECT stage, rev::text, owner FROM hawa.requests WHERE request_id = ${request}::uuid`.execute(trx));
    expect(read.rows).toEqual([{ stage: 'in_review', rev: '2', owner: 'restate' }]);
  });

  it('never lets the application change the owner, move the revision back or remove a request', async () => {
    const task = await newTask();
    const request = await addRequest(task);
    await expect(withRlsContext(app, OPERATOR, (trx) => sql`UPDATE hawa.requests SET owner = 'core' WHERE request_id = ${request}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(withRlsContext(app, OPERATOR, (trx) => sql`DELETE FROM hawa.requests WHERE request_id = ${request}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    await withRlsContext(app, OPERATOR, (trx) => sql`UPDATE hawa.requests SET rev = 5 WHERE request_id = ${request}::uuid`.execute(trx));
    await expect(withRlsContext(app, OPERATOR, (trx) => sql`UPDATE hawa.requests SET rev = 4 WHERE request_id = ${request}::uuid`.execute(trx))).rejects.toThrow(/cannot go back/);
    // Not even the owner of the schema moves the owner.
    await expect(owner.query(`UPDATE hawa.requests SET owner = 'core' WHERE request_id = $1`, [request])).rejects.toThrow(/written once/);
  });

  it('refuses a stage the lifecycle does not have, and a request whose task does not exist', async () => {
    const task = await newTask();
    await expect(withRlsContext(app, OPERATOR, (trx) => sql`
      INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, owner, stage) VALUES (${randomUUID()}::uuid, ${TENANT}::uuid, ${task}::uuid, ${task}::uuid, 'restate', 'archived')`.execute(trx))).rejects.toMatchObject({ code: '23514' });
    const missing = randomUUID();
    await expect(owner.query(`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, owner, stage) VALUES ($1, $2, $3, $3, 'restate', 'manual')`, [randomUUID(), TENANT, missing])).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps one projection per key and per revision, written once and never changed or removed', async () => {
    const task = await newTask();
    const request = await addRequest(task);
    await addProjection(request, 1, `${request}:1:open`);
    await expect(addProjection(request, 2, `${request}:1:open`)).rejects.toMatchObject({ code: '23505' });
    await expect(addProjection(request, 1, `${request}:1:other`)).rejects.toMatchObject({ code: '23505' });
    await expect(withRlsContext(app, OPERATOR, (trx) => sql`UPDATE hawa.lifecycle_projections SET result = '{}'::jsonb WHERE request_id = ${request}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(withRlsContext(app, OPERATOR, (trx) => sql`DELETE FROM hawa.lifecycle_projections WHERE request_id = ${request}::uuid`.execute(trx))).rejects.toThrow(/permission denied/);
    const read = await withRlsContext(app, OPERATOR, (trx) => sql<{ rev: string }>`SELECT rev::text FROM hawa.lifecycle_projections WHERE request_id = ${request}::uuid`.execute(trx));
    expect(read.rows).toEqual([{ rev: '1' }]);
  });

  it('keeps each tenant to its own requests and projections', async () => {
    const task = await newTask();
    const request = await addRequest(task);
    await addProjection(request, 1, `${request}:1:open`);
    const other = { tenantId: randomUUID(), userId: OPERATOR.userId, role: 'operator' };
    const seen = await withRlsContext(app, other, async (trx) => [
      ...(await sql`SELECT request_id FROM hawa.requests WHERE request_id = ${request}::uuid`.execute(trx)).rows,
      ...(await sql`SELECT request_id FROM hawa.lifecycle_projections WHERE request_id = ${request}::uuid`.execute(trx)).rows,
    ]);
    expect(seen).toEqual([]);
    await expect(addRequest(task, other)).rejects.toThrow();
  });

  it('follows the root task: a designer of one client sees and writes that client\'s requests, not another\'s', async () => {
    const mine = await newTask(clientA);
    const theirs = await newTask(clientB);
    const minesRequest = await addRequest(mine);
    const theirsRequest = await addRequest(theirs);
    await addProjection(theirsRequest, 1, `${theirsRequest}:1:open`);
    const scope = { tenantId: TENANT, userId: designer, role: 'operator' };
    const visible = await withRlsContext(app, scope, (trx) =>
      sql<{ request_id: string }>`SELECT request_id FROM hawa.requests WHERE request_id IN (${minesRequest}::uuid, ${theirsRequest}::uuid)`.execute(trx));
    expect(visible.rows.map((r) => r.request_id)).toEqual([minesRequest]);
    const projections = await withRlsContext(app, scope, (trx) => sql`SELECT 1 FROM hawa.lifecycle_projections WHERE request_id = ${theirsRequest}::uuid`.execute(trx));
    expect(projections.rows).toEqual([]);
    await expect(addRequest(theirs, scope)).rejects.toThrow(/row-level security/);
    await expect(addProjection(theirsRequest, 2, `${theirsRequest}:2:x`, scope)).rejects.toThrow(/row-level security/);
    await addProjection(minesRequest, 1, `${minesRequest}:1:open`, scope);
  });

  it('goes with its root task', async () => {
    const task = await newTask();
    const request = await addRequest(task);
    await addProjection(request, 1, `${request}:1:open`);
    await owner.query('DELETE FROM hawa.tasks WHERE id = $1', [task]);
    const left = await owner.query('SELECT (SELECT count(*) FROM hawa.requests WHERE request_id = $1)::int + (SELECT count(*) FROM hawa.lifecycle_projections WHERE request_id = $1)::int AS n', [request]);
    expect(left.rows[0].n).toBe(0);
  });
});
