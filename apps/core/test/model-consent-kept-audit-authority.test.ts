import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { computeDnaHash } from '../src/core-helpers.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-b000-000000000002';
const privacy = { modelEgressMode: 'approved_providers', allowedProviders: ['openai'] };
const previousId = randomUUID(), nextId = randomUUID(), taskId = randomUUID();
const beforeHash = computeDnaHash({ version: 1, privacy });
const afterHash = computeDnaHash({ version: 2, privacy });
const scope = { tenantId, clientId, userId, role: 'administrator' };
type Audit = {
  tenantId: string; clientId: string; actorId: string; taskId: string | null;
  resourceId: string; beforeHash: string; afterHash: string; data: Record<string, unknown>;
};
const audit = (): Audit => ({ tenantId, clientId, actorId: userId, taskId: null,
  resourceId: nextId, beforeHash, afterHash,
  data: { via: 'dna', fromVersion: 1, toVersion: 2, privacy, previousApprovedBy: userId,
    actor: { userId, role: 'administrator' } } });
async function write(a: Audit = audit(), ctx = scope) {
  return withRlsContext(db, ctx, async trx => sql`INSERT INTO hawa.audit_events
    (tenant_id,client_id,task_id,actor_type,actor_id,action,resource_type,resource_id,before_hash,after_hash,data)
    VALUES (${a.tenantId}::uuid,${a.clientId}::uuid,${a.taskId}::uuid,'user',${a.actorId},
      'client.model_consent.kept','client_dna_version',${a.resourceId},${a.beforeHash},${a.afterHash},${JSON.stringify(a.data)}::jsonb)`.execute(trx));
}
beforeEach(async () => {
  await sql`DELETE FROM hawa.client_dna_versions WHERE client_id=${clientId}::uuid`.execute(owner);
  for (const [id, version, status, hash] of [
    [previousId, 1, 'superseded', beforeHash], [nextId, 2, 'active', afterHash],
  ] as const) {
    await sql`INSERT INTO hawa.client_dna_versions
      (id,tenant_id,client_id,version,status,dna,content_hash,created_by,approved_by)
      VALUES (${id}::uuid,${tenantId}::uuid,${clientId}::uuid,${version},${status}::hawa.record_status,
        ${JSON.stringify({ version, privacy })}::jsonb,${hash},${userId}::uuid,${userId}::uuid)`.execute(owner);
  }
  await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title)
    VALUES (${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Synthetic consent guard task')
    ON CONFLICT(id) DO NOTHING`.execute(owner);
});
afterAll(async () => { await db.destroy(); await owner.destroy(); });

it('admits only the exact current administrator and approved unchanged-privacy version pair', async () => {
  await write();
  const observed = await sql<{actor_id: string; before_hash: string; after_hash: string}>`
    SELECT actor_id,before_hash,after_hash FROM hawa.audit_events
    WHERE action='client.model_consent.kept' AND resource_id=${nextId}`.execute(owner);
  expect(observed.rows).toEqual([{ actor_id: userId, before_hash: beforeHash, after_hash: afterHash }]);
});
it.each([
  ['actor', (a: Audit) => { a.actorId = SYSTEM_AUTOMATION_USER_ID; }],
  ['client', (a: Audit) => { a.clientId = 'c1000000-0000-4000-8000-000000000003'; }],
  ['tenant', (a: Audit) => { a.tenantId = '00000000-0000-4000-a000-000000000006'; }],
  ['resource', (a: Audit) => { a.resourceId = previousId; }],
  ['before hash', (a: Audit) => { a.beforeHash = '0'.repeat(64); }],
  ['after hash', (a: Audit) => { a.afterHash = '0'.repeat(64); }],
  ['version', (a: Audit) => { a.data.toVersion = 3; }],
  ['recorded privacy', (a: Audit) => { a.data.privacy = { modelEgressMode: 'local_only', allowedProviders: [] }; }],
  ['prior approver', (a: Audit) => { a.data.previousApprovedBy = SYSTEM_AUTOMATION_USER_ID; }],
  ['save route', (a: Audit) => { a.data.via = 'worker'; }],
  ['task-policy bypass', (a: Audit) => { a.taskId = taskId; }],
] as const)('refuses mismatched %s through actual restricted INSERT', async (_name, mutate) => {
  const a = audit(); mutate(a);
  await expect(write(a)).rejects.toMatchObject({ code: '42501' });
});
it('does not admit a claimed operator role as administrator authority', async () => {
  await expect(write(audit(), { ...scope, role: 'operator' })).rejects.toMatchObject({ code: '42501' });
});
it.each([null, SYSTEM_AUTOMATION_USER_ID])('refuses absent or service-issued prior approval (%s)', async approved => {
  await sql`UPDATE hawa.client_dna_versions SET approved_by=${approved}::uuid WHERE id=${previousId}::uuid`.execute(owner);
  await expect(write()).rejects.toMatchObject({ code: '42501' });
});
it('refuses the audit when stored privacy actually changed', async () => {
  await sql`UPDATE hawa.client_dna_versions SET dna=${JSON.stringify({version: 2, privacy: { ...privacy, allowedProviders: ['anthropic'] }})}::jsonb
    WHERE id=${nextId}::uuid`.execute(owner);
  await expect(write()).rejects.toMatchObject({ code: '42501' });
});
