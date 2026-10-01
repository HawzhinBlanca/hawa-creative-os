import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext, type Database, type Kysely } from '../src/index.js';
import { TaskRepository } from '../src/repositories/task.repository.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
afterAll(async () => { await db.destroy(); await owner.destroy(); });
type Principal = 'designer' | 'operator' | 'approver' | 'stranger' | 'disabled' | 'inactive' | 'auditor' | 'requester';
const tables = ['tasks', 'task_events', 'design_briefs', 'design_documents', 'audit_events'] as const;
type Table = typeof tables[number];

async function fixture(principal: Principal = 'designer') {
  const tenantId = randomUUID(), userId = randomUUID(), mine = randomUUID(), other = randomUUID();
  const taskId = randomUUID(), otherTaskId = randomUUID(), unresolvedTaskId = randomUUID();
  const role = principal === 'disabled' || principal === 'inactive' ? 'operator' : principal === 'stranger' ? 'designer' : principal;
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES (${tenantId}::uuid,'Synthetic write office',${tenantId})`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name,disabled_at) VALUES
    (${userId}::uuid,${userId+'@example.test'},'Synthetic write actor',${principal === 'disabled' ? new Date() : null})`.execute(owner);
  for (const id of [mine, other]) await sql`INSERT INTO hawa.clients(id,tenant_id,code,name)
    VALUES (${id}::uuid,${tenantId}::uuid,${id},'Synthetic write client')`.execute(owner);
  if (principal !== 'stranger') await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active)
    VALUES (${tenantId}::uuid,${userId}::uuid,${role}::hawa.membership_role,${principal !== 'inactive'})`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role)
    VALUES (${tenantId}::uuid,${mine}::uuid,${userId}::uuid,${principal === 'approver' ? 'approver' : 'designer'}::hawa.membership_role)`.execute(owner);
  for (const [id, clientId] of [[taskId, mine], [otherTaskId, other], [unresolvedTaskId, null]] as const)
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES
      (${id}::uuid,${tenantId}::uuid,${clientId}::uuid,'Synthetic scoped task')`.execute(owner);
  return { tenantId, userId, mine, other, taskId, otherTaskId, unresolvedTaskId,
    // Forged application role strings cannot grant the actual stored actor more authority.
    scope: { tenantId, userId, role: 'administrator' } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function insert(trx: Kysely<Database>, table: Table, f: Fixture, foreign = false, unresolved = false) {
  const id = randomUUID(), clientId = unresolved ? null : foreign ? f.other : f.mine;
  const taskId = unresolved ? f.unresolvedTaskId : foreign ? f.otherTaskId : f.taskId;
  const row: Record<string, unknown> = { id, tenant_id: f.tenantId };
  if (table === 'tasks') Object.assign(row, { client_id: clientId, title: 'Synthetic inserted task' });
  else {
    row.task_id = taskId;
    if (table === 'task_events') Object.assign(row, { event_type: 'synthetic.write', aggregate_version: 1, actor_type: 'user', correlation_id: randomUUID() });
    if (table === 'design_briefs') Object.assign(row, { version: 1, brief: '{}', content_hash: id, created_by_type: 'user' });
    if (table === 'design_documents') Object.assign(row, { studio: 'canva', direction_name: id });
    if (table === 'audit_events') Object.assign(row, { action: 'synthetic.write', actor_type: 'user', resource_type: 'task' });
  }
  // No RETURNING: a SELECT policy must not disguise an unauthorized persisted INSERT.
  await sql`INSERT INTO ${sql.table('hawa.' + table)}
    (${sql.join(Object.keys(row).map(k => sql.ref(k)))}) VALUES (${sql.join(Object.values(row).map(v => sql.val(v)))})`.execute(trx);
  return id;
}

it('uses the actual restricted application role', async () => {
  expect((await sql<{ role: string }>`SELECT current_user AS role`.execute(db)).rows[0].role).toBe('hawa_app');
});

it.each(tables)('allows assigned designer writes and owner readback for %s', async table => {
  const f = await fixture();
  const id = await withRlsContext(db, f.scope, trx => insert(trx, table, f));
  expect((await sql`SELECT id FROM ${sql.table('hawa.'+table)} WHERE id=${id}::uuid`.execute(owner)).rows).toHaveLength(1);
});

it.each(tables)('allows a current broad operator to write another office client in %s', async table => {
  const f = await fixture('operator');
  const id = await withRlsContext(db, f.scope, trx => insert(trx, table, f, true));
  expect((await sql`SELECT id FROM ${sql.table('hawa.'+table)} WHERE id=${id}::uuid`.execute(owner)).rows).toHaveLength(1);
});

it.each(tables)('refuses a legitimate foreign-office operator insert into %s', async table => {
  const own = await fixture('operator'), foreign = await fixture('operator');
  await expect(withRlsContext(db, foreign.scope, trx => insert(trx, table, own))).rejects.toMatchObject({ code: '42501' });
});

for (const principal of ['designer', 'approver', 'stranger', 'disabled', 'inactive'] as const) {
  it.each(tables)(`refuses ${principal} unauthorized insert without RETURNING into %s`, async table => {
    const f = await fixture(principal);
    await expect(withRlsContext(db, f.scope, trx => insert(trx, table, f, principal === 'designer')))
      .rejects.toMatchObject({ code: '42501' });
  });
}

it.each(['task_events', 'design_briefs', 'design_documents'] as const)('refuses read-only auditor inserts into unresolved %s', async table => {
  const f = await fixture('auditor');
  await expect(withRlsContext(db, f.scope, trx => insert(trx, table, f, false, true))).rejects.toMatchObject({ code: '42501' });
});

it.each(['tasks', 'task_events', 'design_briefs', 'design_documents'] as const)('preserves requester unresolved-task creation in %s', async table => {
  const f = await fixture('requester');
  const id = await withRlsContext(db, f.scope, trx => insert(trx, table, f, false, true));
  expect((await sql`SELECT id FROM ${sql.table('hawa.'+table)} WHERE id=${id}::uuid`.execute(owner)).rows).toHaveLength(1);
});

it.each(['UPDATE', 'DELETE'] as const)('preserves append-only refusal for authorized operator %s of a task event', async operation => {
  const f = await fixture('operator');
  const id = await insert(owner, 'task_events', f, false, true);
  await expect(withRlsContext(db, f.scope, trx => operation === 'UPDATE'
    ? sql`UPDATE hawa.task_events SET data=data WHERE id=${id}::uuid`.execute(trx)
    : sql`DELETE FROM hawa.task_events WHERE id=${id}::uuid`.execute(trx))).rejects.toThrow('append-only');
});

it.each(['UPDATE', 'DELETE'] as const)('refuses auditor %s of an unresolved design document', async operation => {
  const f = await fixture('auditor');
  const id = await insert(owner, 'design_documents', f, false, true);
  const changed = await withRlsContext(db, f.scope, trx => operation === 'UPDATE'
    ? sql`UPDATE hawa.design_documents SET studio=studio WHERE id=${id}::uuid`.execute(trx)
    : sql`DELETE FROM hawa.design_documents WHERE id=${id}::uuid`.execute(trx));
  expect(Number(changed.numAffectedRows)).toBe(0);
});

it.each(['other', 'clear'] as const)('prevents a broad operator from changing selected task client scope: %s', async change => {
  const f = await fixture('operator');
  await expect(withRlsContext(db, f.scope, trx => sql`UPDATE hawa.tasks
    SET client_id=${change === 'clear' ? null : f.other}::uuid WHERE id=${f.taskId}::uuid`.execute(trx)))
    .rejects.toMatchObject({ code: '23514' });
  expect((await sql<{ client_id: string }>`SELECT client_id FROM hawa.tasks WHERE id=${f.taskId}::uuid`.execute(owner)).rows[0].client_id).toBe(f.mine);
});

it('preserves same-client and unrelated task updates at the actual database boundary', async () => {
  const f = await fixture('operator');
  const updated = await withRlsContext(db, f.scope, trx => sql`UPDATE hawa.tasks
    SET client_id=client_id,title='Synthetic valid update' WHERE id=${f.taskId}::uuid`.execute(trx));
  expect(Number(updated.numAffectedRows)).toBe(1);
  expect((await sql<{ client_id: string; title: string }>`SELECT client_id,title FROM hawa.tasks WHERE id=${f.taskId}::uuid`.execute(owner)).rows[0])
    .toEqual({ client_id: f.mine, title: 'Synthetic valid update' });
});

it('allows exactly one concurrent initial client assignment through the actual repository', async () => {
  const f = await fixture('operator'), repo = new TaskRepository(db);
  const original = repo.findById.bind(repo);
  let arrivals = 0, release!: () => void;
  const bothRead = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(repo, 'findById').mockImplementation(async (...args) => {
    const row = await original(...args);
    if (++arrivals === 2) release();
    await bothRead;
    return row;
  });
  try {
    const results = await Promise.allSettled([f.mine, f.other].map(clientId =>
      withRlsContext(db, f.scope, trx => repo.lockClientScope(f.unresolvedTaskId, clientId, undefined, f.tenantId, trx))));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: '23514' } });
    const winner = results.find(r => r.status === 'fulfilled');
    expect(winner?.status).toBe('fulfilled');
    if (winner?.status === 'fulfilled') {
      const stored = (await sql<{ client_id: string }>`SELECT client_id FROM hawa.tasks WHERE id=${f.unresolvedTaskId}::uuid`.execute(owner)).rows[0];
      expect(stored.client_id).toBe(winner.value.client_id);
      expect((await withRlsContext(db, f.scope, trx => repo.lockClientScope(f.unresolvedTaskId, stored.client_id, undefined, f.tenantId, trx))).client_id).toBe(stored.client_id);
    }
  } finally { spy.mockRestore(); }
});
