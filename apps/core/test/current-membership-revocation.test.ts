import { afterAll, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
afterAll(async () => { await db.destroy(); await owner.destroy(); });

async function fixture(role: 'designer' | 'operator' = 'designer') {
  const userId = randomUUID(), clientId = randomUUID(), taskId = randomUUID();
  const token = `hawa_sess_${randomUUID().replaceAll('-', '')}`;
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES
    (${userId}::uuid,${userId + '@example.test'},'Synthetic membership reader')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES
    (${tenantId}::uuid,${userId}::uuid,${role}::hawa.membership_role)`.execute(owner);
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES
    (${clientId}::uuid,${tenantId}::uuid,${clientId},'Synthetic membership client')`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES
    (${tenantId}::uuid,${clientId}::uuid,${userId}::uuid,'designer')`.execute(owner);
  await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,state) VALUES
    (${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Synthetic membership task','complete')`.execute(owner);
  await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES(${createHash('sha256').update(token).digest('hex')},${tenantId}::uuid,${userId}::uuid,
      ${'oidc:' + userId},${role},'Synthetic membership reader',now()+interval '1 hour','google_oidc')`.execute(owner);
  const app = createApp({ db, testAuth: { principal: { role: 'operator' } } });
  const upload = await app.request('/v1/assets/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, filename: 'membership.svg', mimeType: 'image/svg+xml',
      content: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#${randomUUID().replaceAll('-', '').slice(0, 6)}"/></svg>` }) });
  expect(upload.status).toBe(201);
  const asset = await upload.json() as { assetId: string; sourceSha256: string };
  return { app, userId, clientId, taskId, token, asset, scope: { tenantId, userId, role } };
}

it('refuses retained original bytes immediately after office membership is revoked, including a warm actual session', async () => {
  const f = await fixture();
  const path = `/v1/assets/${f.asset.assetId}/sources/${f.asset.sourceSha256}/content`;
  const request = () => f.app.request(path, { headers: { Authorization: `Bearer ${f.token}` } });
  const positive = await request();
  expect(positive.status).toBe(200);
  expect((await positive.arrayBuffer()).byteLength).toBeGreaterThan(0);
  await sql`UPDATE hawa.tenant_memberships SET active=false WHERE user_id=${f.userId}::uuid`.execute(owner);
  const denied = await request();
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain('<svg');
});

it.each(['designer', 'operator'] as const)('disabled %s cannot read or mutate client/task rows through current runtime RLS', async role => {
  const f = await fixture(role);
  const read = () => withRlsContext(db, f.scope, async trx =>
    (await sql`SELECT id FROM hawa.tasks WHERE id=${f.taskId}::uuid`.execute(trx)).rows);
  expect(await read()).toHaveLength(1);
  await sql`UPDATE hawa.users SET disabled_at=now() WHERE id=${f.userId}::uuid`.execute(owner);
  expect(await read()).toEqual([]);
  const changed = await withRlsContext(db, f.scope, async trx =>
    (await sql`UPDATE hawa.tasks SET title='Unauthorized rewrite' WHERE id=${f.taskId}::uuid`.execute(trx)).numAffectedRows);
  expect(Number(changed)).toBe(0);
});

it.each(['designer', 'operator'] as const)('disabled %s cannot mutate a task through a retained runtime context', async role => {
  const f = await fixture(role);
  const mutate = () => withRlsContext(db, f.scope, async trx =>
    (await sql`UPDATE hawa.tasks SET title=title WHERE id=${f.taskId}::uuid`.execute(trx)).numAffectedRows);
  expect(Number(await mutate())).toBe(1);
  await sql`UPDATE hawa.users SET disabled_at=now() WHERE id=${f.userId}::uuid`.execute(owner);
  expect(Number(await mutate())).toBe(0);
});

async function authority(f: Awaited<ReturnType<typeof fixture>>, tid = tenantId, cid = f.clientId) {
  return withRlsContext(db, { ...f.scope, role: 'administrator' }, async trx => (await sql<{
    member: boolean; broad: boolean; access: boolean; write: boolean; reads: string[]; writes: string[];
  }>`SELECT hawa.is_tenant_member(${tid}::uuid) AS member,
      hawa.has_tenant_role(${tid}::uuid,ARRAY['administrator','operator']::hawa.membership_role[]) AS broad,
      hawa.can_access_client(${tid}::uuid,${cid}::uuid) AS access,
      hawa.can_write_client(${tid}::uuid,${cid}::uuid) AS write,
      hawa.member_client_ids(false) AS reads,hawa.member_client_ids(true) AS writes`.execute(trx)).rows[0]);
}

it('direct and hoisted authority refuse inactive or missing office membership, and reactivation preserves exact client scope', async () => {
  const f = await fixture();
  expect(await authority(f)).toMatchObject({ member: true, broad: false, access: true, write: true, reads: [f.clientId], writes: [f.clientId] });
  expect(await authority(f, tenantId, randomUUID())).toMatchObject({ access: false, write: false });
  expect(await authority(f, randomUUID())).toMatchObject({ member: false, broad: false, access: false, write: false });
  const denied = { member: false, broad: false, access: false, write: false, reads: [], writes: [] };
  await sql`UPDATE hawa.tenant_memberships SET active=false WHERE user_id=${f.userId}::uuid`.execute(owner);
  expect(await authority(f)).toEqual(denied);
  await sql`UPDATE hawa.tenant_memberships SET active=true WHERE user_id=${f.userId}::uuid`.execute(owner);
  expect(await authority(f)).toMatchObject({ access: true, write: true, reads: [f.clientId], writes: [f.clientId] });
  await sql`DELETE FROM hawa.tenant_memberships WHERE user_id=${f.userId}::uuid`.execute(owner);
  expect(await authority(f)).toEqual(denied);
  const cold = createApp({ db });
  expect((await cold.request(`/v1/assets/${f.asset.assetId}/content`, { headers: { Authorization: `Bearer ${f.token}` } })).status).toBe(404);
});

it('account disabling removes every direct and hoisted grant and re-enabling restores only existing client roles', async () => {
  const f = await fixture();
  expect((await authority(f)).write).toBe(true);
  await sql`UPDATE hawa.users SET disabled_at=now() WHERE id=${f.userId}::uuid`.execute(owner);
  expect(await authority(f)).toEqual({ member: false, broad: false, access: false, write: false, reads: [], writes: [] });
  await sql`UPDATE hawa.users SET disabled_at=NULL WHERE id=${f.userId}::uuid`.execute(owner);
  expect((await authority(f)).write).toBe(true);
  await sql`UPDATE hawa.client_memberships SET role='approver' WHERE user_id=${f.userId}::uuid`.execute(owner);
  expect(await authority(f)).toMatchObject({ member: true, broad: false, access: true, write: false, reads: [f.clientId], writes: [] });
  await sql`UPDATE hawa.client_memberships SET active=false WHERE user_id=${f.userId}::uuid`.execute(owner);
  expect(await authority(f)).toMatchObject({ member: true, broad: false, access: false, write: false, reads: [], writes: [] });
});

it('hoisted row policies retain statement InitPlans for membership and client grants', async () => {
  const f = await fixture();
  const plan = await withRlsContext(db, f.scope, async trx => (await sql<Record<string, unknown>>`
    EXPLAIN (VERBOSE, FORMAT JSON) SELECT id FROM hawa.tasks WHERE client_id=${f.clientId}::uuid`.execute(trx)).rows[0]);
  const text = JSON.stringify(plan);
  expect(text).toContain('InitPlan');
  expect(text).toContain('member_client_ids(false)');
  expect(text).not.toContain('can_access_client(tenant_id');
});
