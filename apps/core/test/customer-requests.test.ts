import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createDb, sql, withRlsContext } from '@hawa/db';
import {
  CustomerRequests,
  type CustomerDesignRequest,
} from '../src/customer/customer-requests.js';
import {
  HAWZHIN_AUTH_ORIGIN,
  WorkspaceAccessError,
  type WorkspaceMember,
} from '../src/customer/supabase-member.js';
import { registerCustomerRoutes } from '../src/customer/customer.routes.js';
import {
  savedDesignCopy,
  savedDesignCopyLocales,
} from '../src/services/saved-design-copy.js';
const db = createDb(process.env.TEST_DATABASE_URL!),
  owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
afterAll(async () => {
  await db.destroy();
  await owner.destroy();
});
async function fixture(limit = 2) {
  const tenantId = randomUUID(),
    adminId = randomUUID(),
    clientId = randomUUID();
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Synthetic customer office',${tenantId})`.execute(
    owner,
  );
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${adminId}::uuid,${adminId + '@example.test'},'Synthetic administrator')`.execute(
    owner,
  );
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${adminId}::uuid,'administrator')`.execute(
    owner,
  );
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name,status) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Synthetic brand','active')`.execute(
    owner,
  );
  await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash)
    VALUES(${tenantId}::uuid,${clientId}::uuid,1,'active','{}',${randomUUID()})`.execute(
    owner,
  );
  async function account() {
    const id = randomUUID(),
      userId = randomUUID(),
      subject = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${userId}::uuid,${userId + '@example.test'},'Synthetic customer')`.execute(
      owner,
    );
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'requester')`.execute(
      owner,
    );
    await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${tenantId}::uuid,${clientId}::uuid,${userId}::uuid,'requester')`.execute(
      owner,
    );
    await withRlsContext(
      db,
      { tenantId, userId: adminId, role: 'administrator' },
      async (trx) => {
        await sql`INSERT INTO hawa.customer_accounts(id,tenant_id,issuer,subject,user_id,provisioned_by,reason,concurrent_job_limit)
      VALUES(${id}::uuid,${tenantId}::uuid,${HAWZHIN_AUTH_ORIGIN},${subject}::uuid,${userId}::uuid,${adminId}::uuid,'Synthetic qualification',${limit})`.execute(
          trx,
        );
        await sql`INSERT INTO hawa.customer_client_grants(tenant_id,account_id,client_id,provisioned_by,reason)
      VALUES(${tenantId}::uuid,${id}::uuid,${clientId}::uuid,${adminId}::uuid,'Synthetic qualification')`.execute(
          trx,
        );
      },
    );
    const member: WorkspaceMember = {
      kind: 'workspace_member',
      issuer: HAWZHIN_AUTH_ORIGIN,
      subject,
    };
    return { id, userId, member };
  }
  const a = await account(),
    b = await account();
  const service = new CustomerRequests(db, tenantId);
  const body: CustomerDesignRequest = {
    clientId,
    title: 'Website announcement',
    exactCopy: [{ text: '(Real copy)\n📍 Erbil — ٢٠٢٦', language: 'ar' }],
    designInstructions: 'Choose the composition for the content.',
    variant: 'square',
  };
  return { tenantId, adminId, clientId, a, b, service, body };
}

it('uses the restricted runtime role and returns only explicitly granted brands', async () => {
  const f = await fixture();
  expect(
    (await sql<{ role: string }>`SELECT current_user AS role`.execute(db))
      .rows[0].role,
  ).toBe('hawa_app');
  expect(await f.service.session(f.a.member)).toMatchObject({
    accountId: f.a.id,
    clients: [{ id: f.clientId, name: 'Synthetic brand' }],
  });
  await expect(
    f.service.session({ ...f.a.member, subject: randomUUID() }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    new CustomerRequests(db, randomUUID()).session(f.a.member),
  ).rejects.toMatchObject({ status: 403 });
});
it('commits owned task, exact copy, pinned DNA and one dispatch receipt atomically', async () => {
  const f = await fixture(),
    r = await f.service.create(f.a.member, 'request_001', f.body);
  expect(r.created).toBe(true);
  expect(r.job).toMatchObject({
    clientId: f.clientId,
    state: 'received',
    version: 1,
  });
  const task = (
    await sql<{
      customer_account_id: string;
      requested_by: string;
    }>`SELECT customer_account_id,requested_by FROM hawa.tasks WHERE id=${r.job.id}::uuid`.execute(
      owner,
    )
  ).rows[0];
  expect(task).toEqual({
    customer_account_id: f.a.id,
    requested_by: f.a.userId,
  });
  const rows = (
    await sql<{
      payload: Record<string, unknown>;
    }>`SELECT payload FROM hawa.outbox_commands WHERE aggregate_id=${r.job.id}::uuid`.execute(
      owner,
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].payload).toMatchObject({
    workflow: 'canva',
    autoGenerate: true,
    designStudio: true,
    clientDnaVersion: 1,
  });
  expect(rows[0].payload.variant).toEqual({ width: 1080, height: 1080 });
  expect(
    savedDesignCopyLocales(rows[0].payload, [f.body.exactCopy[0].text]),
  ).toEqual(['ar']);
  expect(savedDesignCopyLocales(rows[0].payload, ['Changed'])).toEqual(['und']);
  expect(savedDesignCopy(rows[0].payload, '')).toEqual({
    copy: [f.body.exactCopy[0].text],
    instructions: f.body.designInstructions,
  });
});
it('isolates two members who share the same brand, including raw inherited RLS reads', async () => {
  const f = await fixture(),
    a = await f.service.create(f.a.member, 'request_001', f.body),
    b = await f.service.create(f.b.member, 'request_001', f.body);
  expect((await f.service.list(f.a.member)).map((j) => j.id)).toEqual([
    a.job.id,
  ]);
  await expect(f.service.get(f.a.member, b.job.id)).rejects.toMatchObject({
    status: 404,
  });
  await withRlsContext(
    db,
    { tenantId: f.tenantId, userId: f.a.userId, role: 'administrator' },
    async (trx) => {
      await sql`SELECT set_config('hawa.customer_id',${f.a.id},true),set_config('hawa.customer_subject',${f.a.member.subject},true)`.execute(
        trx,
      );
      expect(
        (await trx.selectFrom('tasks').select('id').execute()).map((j) => j.id),
      ).toEqual([a.job.id]);
      expect(
        (
          await trx
            .selectFrom('outbox_commands')
            .select('aggregate_id')
            .execute()
        ).map((j) => j.aggregate_id),
      ).toEqual([a.job.id]);
      expect(
        await trx.selectFrom('integrations').selectAll().execute(),
      ).toEqual([]);
      expect(
        Number(
          (
            await sql`UPDATE hawa.tasks SET state='approved' WHERE id=${a.job.id}::uuid`.execute(
              trx,
            )
          ).numAffectedRows,
        ),
      ).toBe(0);
    },
  );
});
it('concurrent duplicate retries create one task/event/dispatch, and differing bodies conflict', async () => {
  const f = await fixture(1),
    results = await Promise.all(
      [1, 2, 3].map(() => f.service.create(f.a.member, 'request_001', f.body)),
    );
  expect(results.filter((r) => r.created)).toHaveLength(1);
  expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
  expect(
    (
      await sql`SELECT id FROM hawa.task_events WHERE task_id=${results[0].job.id}::uuid`.execute(
        owner,
      )
    ).rows,
  ).toHaveLength(1);
  await expect(
    f.service.create(f.a.member, 'request_001', {
      ...f.body,
      title: 'Changed',
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it('serializes distinct submissions before concurrent limits and preserves successful replay at the cap', async () => {
  const f = await fixture(1),
    results = await Promise.allSettled(
      ['request_001', 'request_002'].map((k) =>
        f.service.create(f.a.member, k, f.body),
      ),
    );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { status: 429 },
  });
  expect(await f.service.list(f.a.member)).toHaveLength(1);
  const key = results[0].status === 'fulfilled' ? 'request_001' : 'request_002';
  expect((await f.service.create(f.a.member, key, f.body)).created).toBe(false);
});
it.each([
  'account',
  'grant',
  'membership',
  'disabled',
  'elevated',
  'client',
] as const)(
  'refuses live %s revocation without another dispatch',
  async (kind) => {
    const f = await fixture(),
      r = await f.service.create(f.a.member, 'request_001', f.body);
    if (kind === 'account')
      await sql`UPDATE hawa.customer_accounts SET active=false,version=version+1 WHERE id=${f.a.id}::uuid`.execute(
        owner,
      );
    if (kind === 'grant')
      await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid`.execute(
        owner,
      );
    if (kind === 'membership')
      await sql`UPDATE hawa.client_memberships SET active=false WHERE user_id=${f.a.userId}::uuid`.execute(
        owner,
      );
    if (kind === 'disabled')
      await sql`UPDATE hawa.users SET disabled_at=now() WHERE id=${f.a.userId}::uuid`.execute(
        owner,
      );
    if (kind === 'elevated')
      await sql`UPDATE hawa.tenant_memberships SET role='operator' WHERE user_id=${f.a.userId}::uuid`.execute(
        owner,
      );
    if (kind === 'client')
      await sql`UPDATE hawa.clients SET status='inactive' WHERE id=${f.clientId}::uuid`.execute(
        owner,
      );
    await expect(
      f.service.create(f.a.member, 'request_002', f.body),
    ).rejects.toMatchObject({ status: 403 });
    await expect(f.service.get(f.a.member, r.job.id)).rejects.toMatchObject({
      status: ['account', 'disabled', 'elevated'].includes(kind) ? 403 : 404,
    });
    expect(
      (
        await sql`SELECT id FROM hawa.outbox_commands WHERE tenant_id=${f.tenantId}::uuid`.execute(
          owner,
        )
      ).rows,
    ).toHaveLength(1);
  },
);
it('does not enqueue an ungranted brand or a brand without active DNA', async () => {
  const f = await fixture();
  await expect(
    f.service.create(f.a.member, 'request_001', {
      ...f.body,
      clientId: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 403 });
  await sql`UPDATE hawa.client_dna_versions SET status='inactive' WHERE client_id=${f.clientId}::uuid`.execute(
    owner,
  );
  await expect(
    f.service.create(f.a.member, 'request_002', f.body),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await sql`SELECT id FROM hawa.tasks WHERE tenant_id=${f.tenantId}::uuid`.execute(
        owner,
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await sql`SELECT id FROM hawa.outbox_commands WHERE tenant_id=${f.tenantId}::uuid`.execute(
        owner,
      )
    ).rows,
  ).toHaveLength(0);
});
it('protects ownership even from office changes and audits access changes', async () => {
  const f = await fixture(),
    r = await f.service.create(f.a.member, 'request_001', f.body);
  for (const change of [
    sql`UPDATE hawa.tasks SET customer_account_id=${f.b.id}::uuid WHERE id=${r.job.id}::uuid`,
    sql`UPDATE hawa.tasks SET requested_by=${f.b.userId}::uuid WHERE id=${r.job.id}::uuid`,
  ])
    await expect(change.execute(owner)).rejects.toMatchObject({
      code: '23514',
    });
  await expect(
    sql`UPDATE hawa.customer_accounts SET version=version+1,subject=${randomUUID()}::uuid WHERE id=${f.a.id}::uuid`.execute(
      owner,
    ),
  ).rejects.toMatchObject({ code: '23514' });
  expect(
    (
      await sql`SELECT id FROM hawa.customer_access_audit WHERE account_id=${f.a.id}::uuid`.execute(
        owner,
      )
    ).rows,
  ).toHaveLength(2);
});
it('HTTP authenticates before data, validates strict bounded requests, and returns owned projection', async () => {
  const f = await fixture(),
    app = new Hono();
  registerCustomerRoutes(
    app,
    f.service,
    async (header) => {
      if (header !== 'Bearer synthetic')
        throw new WorkspaceAccessError(401, 'WORKSPACE_SIGN_IN_REQUIRED');
      return f.a.member;
    },
    true,
  );
  expect((await app.request('/v1/customer/session')).status).toBe(401);
  const headers = {
    Authorization: 'Bearer synthetic',
    'Content-Type': 'application/json',
    'Idempotency-Key': 'request_001',
    Origin: 'https://hawzhin.app',
  };
  expect(
    (
      await app.request('/v1/customer/jobs', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...f.body, role: 'administrator' }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request('/v1/customer/jobs', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.example' },
        body: JSON.stringify(f.body),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request('/v1/customer/jobs', {
        method: 'POST',
        headers,
        body: 'a'.repeat(49153),
      })
    ).status,
  ).toBe(413);
  const response = await app.request('/v1/customer/jobs', {
    method: 'POST',
    headers,
    body: JSON.stringify(f.body),
  });
  expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const result = await response.json();
  expect(Object.keys(result.job).sort()).toEqual([
    'clientId',
    'createdAt',
    'id',
    'state',
    'title',
    'updatedAt',
    'version',
  ]);
});
it('generation readiness refuses intake before creating anything', async () => {
  const f = await fixture(),
    app = new Hono();
  registerCustomerRoutes(app, f.service, async () => f.a.member, false);
  expect(
    (await app.request('/v1/customer/jobs', { method: 'POST' })).status,
  ).toBe(503);
  expect(await f.service.list(f.a.member)).toEqual([]);
});

it('administrator admission creates only a dedicated requester, replays exactly and revokes with expected revisions', async () => {
  const { provisionCustomer } =
    await import('../src/customer/customer-provisioning.js');
  const f = await fixture(),
    subject = randomUUID(),
    actionId = randomUUID();
  const input = {
    subject,
    clientIds: [f.clientId],
    active: true,
    expectedVersion: 0,
    dailyJobs: 5,
    concurrentJobs: 1,
    reason: 'Synthetic member admission',
  };
  const admin = { tenantId: f.tenantId, userId: f.adminId },
    result = await provisionCustomer(db, admin, actionId, input);
  expect(result.version).toBe(1);
  expect(await provisionCustomer(db, admin, actionId, input)).toEqual(result);
  await expect(
    provisionCustomer(db, admin, actionId, { ...input, dailyJobs: 10 }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    provisionCustomer(db, admin, randomUUID(), input),
  ).rejects.toMatchObject({ status: 409 });
  const member: WorkspaceMember = {
    kind: 'workspace_member',
    issuer: HAWZHIN_AUTH_ORIGIN,
    subject,
  };
  expect((await f.service.session(member)).clients).toHaveLength(1);
  const mapping = (
    await sql<{
      user_id: string;
    }>`SELECT user_id FROM hawa.customer_accounts WHERE id=${result.accountId}::uuid`.execute(
      owner,
    )
  ).rows[0];
  expect(
    (
      await sql<{
        role: string;
      }>`SELECT role FROM hawa.tenant_memberships WHERE user_id=${mapping.user_id}::uuid`.execute(
        owner,
      )
    ).rows.map((r) => r.role),
  ).toEqual(['requester']);
  await expect(
    provisionCustomer(
      db,
      { tenantId: f.tenantId, userId: f.a.userId },
      randomUUID(),
      { ...input, subject: randomUUID() },
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (
      await provisionCustomer(db, admin, randomUUID(), {
        ...input,
        expectedVersion: 1,
        active: false,
      })
    ).version,
  ).toBe(2);
  await expect(f.service.session(member)).rejects.toMatchObject({
    status: 403,
  });
  expect(
    (
      await sql`SELECT action_id FROM hawa.customer_access_actions WHERE tenant_id=${f.tenantId}::uuid`.execute(
        owner,
      )
    ).rows,
  ).toHaveLength(2);
});

it('mounted Core keeps generation disabled, pins customer CORS and refuses workspace JWTs on office routes',async()=>{
 const {createApp}=await import('../src/app.js');
 const token='Bearer untrusted.claims.signature';
 const app=createApp({db,skipTelegramProbe:true,skipPaidModelProbe:true,customerApi:{publishableKey:'sb_publishable_testfixture12',generationEnabled:true,
  fetcher:async url=>new Response(JSON.stringify(String(url).endsWith('/auth/v1/user')?{id:randomUUID(),role:'authenticated',aud:'authenticated'}:true))}});
 const response=await app.request('/v1/customer/jobs',{method:'POST',headers:{Authorization:token,Origin:'https://hawzhin.app'}});
 expect(response.status).toBe(503);expect(await response.json()).toMatchObject({code:'DESIGN_GENERATION_NOT_READY'});
 expect(response.headers.get('access-control-allow-origin')).toBe('https://hawzhin.app');
 expect((await app.request('/v1/tasks',{headers:{Authorization:token}})).status).toBe(401);
 const foreign=await app.request('/v1/customer/jobs',{headers:{Authorization:token,Origin:'https://evil.example'}});
 expect(foreign.status).toBe(403);expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
 expect((await app.request('/v1/office/customer-accounts',{method:'PUT',headers:{Authorization:'Bearer test_admin_key'},body:'{}'})).status).toBe(403);
});
