import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, withRlsContext, sql, TaskRepository } from '@hawa/db';
import { kaaeClientDNA } from '@hawa/domain';
import { createApp } from '../src/app.js';
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const app = () => createApp({ db, testAuth: { principal: { role: 'operator', userId: scope.userId } } });
afterAll(() => Promise.all([db.destroy(), owner.destroy()]));
async function client(active = true) {
  const id = randomUUID(), name = `Registered ${id}`;
  await withRlsContext(db, scope, async trx => {
    await trx.insertInto('clients').values({ id, tenant_id: tenantId, code: id, name, aliases: [], default_language: 'en', retention_policy: {}, model_egress_policy: {}, status: active ? 'active' : 'inactive' }).execute();
    await trx.insertInto('client_dna_versions').values({ id: randomUUID(), tenant_id: tenantId, client_id: id,
      version: 1, status: 'active', content_hash: randomUUID(), dna: { ...kaaeClientDNA, clientId: 'client-old-alias', name } }).execute();
  });
  return id;
}
async function post(body: Record<string, unknown>, key = randomUUID()) {
  const response = await app().request('/v1/tasks', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
describe('registered client scope at the Desk boundary (ADR-066)', () => {
  it('returns canonical UUIDs and hides inactive clients even when their DNA is active', async () => {
    const active = await client(), inactive = await client(false);
    const rows = await (await app().request('/v1/clients')).json();
    expect(rows.some((row: { clientId: string }) => row.clientId === active)).toBe(true);
    expect(rows.some((row: { clientId: string }) => [inactive, 'client-old-alias'].includes(row.clientId))).toBe(false);
    const dna = await (await app().request(`/v1/clients/${active}/dna`)).json();
    expect(dna.clientId).toBe(active);
  });
  it('refuses missing, inactive and nonexistent manual scope without recording a task or outbox', async () => {
    const inactive = await client(false);
    for (const clientId of [undefined, inactive, randomUUID()]) {
      const title = randomUUID(), key = randomUUID();
      const result = await post({ title, clientId, workflow: 'canva_manual' }, key);
      expect(result.status).toBe(clientId ? 403 : 422);
      await withRlsContext(db, scope, async trx => {
        expect(await trx.selectFrom('tasks').select('id').where('title', '=', title).execute()).toEqual([]);
        expect(await trx.selectFrom('outbox_commands').select('id').where('idempotency_key', '=', key).execute()).toEqual([]);
      });
    }
  });
  it('refuses a project belonging to a different client and a read-only client identity', async () => {
    const clientId = await client(), otherClient = await client(), projectId = randomUUID(), userId = randomUUID();
    await withRlsContext(db, scope, async trx => {
      await trx.insertInto('projects').values({ id: projectId, tenant_id: tenantId, client_id: otherClient,
        code: projectId, name: 'Other client project', aliases: [], due_policy: {}, status: 'active' }).execute();
    });
    await owner.transaction().execute(async trx => {
      await sql`INSERT INTO hawa.users(id,email,external_subject,display_name)
        VALUES (${userId}::uuid,${userId + '@example.test'},${userId},'Read-only client tester')`.execute(trx);
      await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role,active)
        VALUES (${tenantId}::uuid,${userId}::uuid,'auditor',true)`.execute(trx);
    });
    expect((await post({ title: 'Wrong project', clientId, projectId, workflow: 'canva_manual' })).status).toBe(403);
    const reader = createApp({ db, testAuth: { principal: { role: 'auditor', userId } } });
    const result = await reader.request('/v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Read-only attempt', clientId, workflow: 'canva_manual' }) });
    expect(result.status).toBe(403);
    const tasks = await withRlsContext(db, scope, trx => trx.selectFrom('tasks').select('id')
      .where('title', 'in', ['Wrong project', 'Read-only attempt']).execute());
    expect(tasks).toEqual([]);
  });

  it('recovers a manual receipt written by the previous server without changing its DNA version', async () => {
    const clientId = await client(), key = randomUUID();
    const body = { title: 'Before the upgrade', clientId, workflow: 'canva_manual' };
    const old = await withRlsContext(db, scope, trx => new TaskRepository(trx).createTaskAggregate({
      tenantId, userId: scope.userId, idempotencyKey: key, title: body.title, clientId,
      payload: { body, clientDnaVersion: 1 }, enqueueOutbox: true,
    }, trx));
    await withRlsContext(db, scope, trx => trx.updateTable('clients').set({ status: 'inactive' }).where('id', '=', clientId).execute());
    expect(await post(body, key)).toMatchObject({ status: 200, body: { id: old.task.id, clientDnaVersion: 1 } });
  });

  it('replays the committed original scope and DNA version after the directory changes', async () => {
    const clientId = await client(), key = randomUUID();
    const body = { title: 'Cedar manual draft', clientId, clientDnaVersion: 999, copyEn: 'Exact copy', workflow: 'canva_manual' };
    const first = await post(body, key);
    expect(first.status).toBe(201); expect(first.body.clientDnaVersion).toBe(1);
    await withRlsContext(db, scope, async trx => {
      await trx.updateTable('clients').set({ status: 'inactive' }).where('id', '=', clientId).execute();
      await trx.updateTable('client_dna_versions').set({ version: 2 }).where('client_id', '=', clientId).execute();
    });
    const replay = await post(body, key);
    expect(replay).toMatchObject({ status: 200, body: { id: first.body.id, clientId, clientDnaVersion: 1 } });
    expect((await post({ ...body, clientId: await client() }, key)).status).toBe(409);
    expect((await post(body)).status).toBe(403);
    await withRlsContext(db, scope, async trx => {
      const count = await sql<{ count: string }>`SELECT count(*) FROM hawa.tasks WHERE client_id=${clientId}::uuid`.execute(trx);
      expect(Number(count.rows[0].count)).toBe(1);
    });
  });
});
