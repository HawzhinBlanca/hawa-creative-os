/** Actual restricted-role writes on the isolated candidate; every actor/row is synthetic. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withRlsContext, type Database, type Kysely } from '@hawa/db';
import { db, query, sql, REPO_ROOT } from './stack.js';
import { TENANT_ID } from './provision.js';
import type { InvariantResult } from './scenario.js';

export async function verifyCandidateWriteAuthority(checks: InvariantResult[]): Promise<void> {
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    if (!ok) throw new Error(`${name}: ${detail}`);
  };
  const userId = randomUUID(), operatorId = randomUUID(), clients = [randomUUID(),randomUUID()];
  for (const [id,role] of [[userId,'designer'],[operatorId,'operator']]) {
    await query(sql`INSERT INTO hawa.users(id,email,display_name) VALUES (${id}::uuid,${id+'@example.test'},'Synthetic write authority actor')`);
    await query(sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES (${TENANT_ID}::uuid,${id}::uuid,${role}::hawa.membership_role)`);
  }
  for (const id of clients) await query(sql`INSERT INTO hawa.clients(id,tenant_id,code,name)
    VALUES (${id}::uuid,${TENANT_ID}::uuid,${id},'Synthetic write authority client')`);
  await query(sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role)
    VALUES (${TENANT_ID}::uuid,${clients[0]}::uuid,${userId}::uuid,'designer')`);
  const runtime = <T>(actorId: string, fn: (trx: Kysely<Database>) => Promise<T>) =>
    withRlsContext(db(), { tenantId: TENANT_ID, userId: actorId, role: 'administrator' }, async trx => {
      await sql`SET LOCAL ROLE hawa_app`.execute(trx);
      return fn(trx);
    });
  const refuse = async (name: string, fn: () => Promise<unknown>, expected: string) => {
    let actual: string | undefined;
    try { await fn(); } catch (err) { actual = (err as { code?: string }).code; }
    check(name, actual === expected, `SQL ${actual ?? 'unexpected success'}`);
  };
  const insertTask = (trx: Kysely<Database>, id: string, client: string) => sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,state)
    VALUES (${id}::uuid,${TENANT_ID}::uuid,${client}::uuid,'Synthetic no-returning write','complete')`.execute(trx);
  const role = await runtime(userId, async trx => (await sql<{ role: string }>`SELECT current_user AS role`.execute(trx)).rows[0].role);
  check('candidate write probes use the real restricted application role',role === 'hawa_app',role);
  const taskId = randomUUID();
  await runtime(userId,trx => insertTask(trx,taskId,clients[0]));
  check('candidate assigned designer insert without RETURNING persists its own client task',
    (await query(sql`SELECT id FROM hawa.tasks WHERE id=${taskId}::uuid`)).length === 1,'owner readback');
  await refuse('candidate denies a designer insert into an unassigned client without RETURNING',
    () => runtime(userId,trx => insertTask(trx,randomUUID(),clients[1])),'42501');
  const foreignTask = randomUUID();
  await query(sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,state)
    VALUES (${foreignTask}::uuid,${TENANT_ID}::uuid,${clients[1]}::uuid,'Synthetic foreign task','complete')`);
  await refuse('candidate denies a derived task-event insert into an unassigned client without RETURNING',
    () => runtime(userId,trx => sql`INSERT INTO hawa.task_events(tenant_id,task_id,event_type,aggregate_version,actor_type,correlation_id)
      VALUES (${TENANT_ID}::uuid,${foreignTask}::uuid,'synthetic.write',1,'user',${randomUUID()}::uuid)`.execute(trx)),'42501');
  await query(sql`UPDATE hawa.users SET disabled_at=now() WHERE id=${userId}::uuid`);
  await refuse('candidate denies disabled-account inserts despite a retained writing grant',
    () => runtime(userId,trx => insertTask(trx,randomUUID(),clients[0])),'42501');
  await query(sql`UPDATE hawa.users SET disabled_at=NULL WHERE id=${userId}::uuid`);
  await query(sql`UPDATE hawa.tenant_memberships SET active=false WHERE tenant_id=${TENANT_ID}::uuid AND user_id=${userId}::uuid`);
  await refuse('candidate denies withdrawn office membership inserts despite a retained writing grant',
    () => runtime(userId,trx => insertTask(trx,randomUUID(),clients[0])),'42501');
  await query(sql`UPDATE hawa.tenant_memberships SET active=true WHERE tenant_id=${TENANT_ID}::uuid AND user_id=${userId}::uuid`);
  await query(sql`UPDATE hawa.client_memberships SET role='approver' WHERE user_id=${userId}::uuid`);
  await refuse('candidate read-only client assignment cannot insert tasks through a forged administrator claim',
    () => runtime(userId,trx => insertTask(trx,randomUUID(),clients[0])),'42501');
  await refuse('candidate selected client cannot be replaced by a broad operator',
    () => runtime(operatorId,trx => sql`UPDATE hawa.tasks SET client_id=${clients[1]}::uuid WHERE id=${taskId}::uuid`.execute(trx)),'23514');
  await refuse('candidate selected client cannot be removed by a broad operator',
    () => runtime(operatorId,trx => sql`UPDATE hawa.tasks SET client_id=NULL WHERE id=${taskId}::uuid`.execute(trx)),'23514');
  const updated = await runtime(operatorId,trx => sql`UPDATE hawa.tasks SET client_id=client_id,title='Synthetic valid update' WHERE id=${taskId}::uuid`.execute(trx));
  check('candidate preserves same-client and unrelated authorized task updates',Number(updated.numAffectedRows) === 1,'one updated task');
  const expected = createHash('sha256').update(readFileSync(join(REPO_ROOT,'packages/db/migrations/080_task_write_scope_authority.sql'))).digest('hex');
  const stored = await query<{ sha256: string }>(sql`SELECT sha256 FROM hawa.schema_upgrades WHERE name='080_task_write_scope_authority.sql'`);
  check('candidate migration080 receipt matches the exact source checksum',stored.length === 1 && stored[0].sha256 === expected,expected);
}
