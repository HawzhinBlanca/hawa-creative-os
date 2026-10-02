import { customerPhotoSelection } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { blobStoreFor } from '../src/services/blob-store-context.js';
import { inspectCustomerPhoto, decodeCustomerPhoto } from '../src/customer/customer-photos.js';
import { orderedCustomerPhotos } from '@hawa/contracts';
import { CHANNEL_INGRESS_USER_ID } from '@hawa/contracts';
import { customerWebOpenEvent, recordCustomerWebMessage } from '../src/customer/customer-web-lifecycle.js';
import { projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
import { afterAll, expect, it, vi } from 'vitest';
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
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${CHANNEL_INGRESS_USER_ID}::uuid,'operator')`.execute(owner);
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
it('commits one owned canonical request and command before any task or paid work',async()=>{
  const f=await fixture(),r=await f.service.create(f.a.member,'request_001',f.body);
  expect(r.created).toBe(true);
  expect(r.job).toMatchObject({clientId:f.clientId,state:'received',version:1});
  const receipt=(await sql<{account_id:string;body:unknown;dna_version:number}>`SELECT account_id,body,dna_version
    FROM hawa.customer_web_requests WHERE request_id=${r.job.id}::uuid`.execute(owner)).rows[0];
  expect(receipt).toEqual({account_id:f.a.id,body:f.body,dna_version:1});
  expect((await sql`SELECT id FROM hawa.tasks WHERE tenant_id=${f.tenantId}::uuid`.execute(owner)).rows).toHaveLength(0);
  const commands=(await sql<{command_type:string;aggregate_type:string;payload:unknown}>`SELECT command_type,aggregate_type,payload
    FROM hawa.outbox_commands WHERE aggregate_id=${r.job.id}::uuid`.execute(owner)).rows;
  expect(commands).toEqual([{command_type:'customer.request.open',aggregate_type:'request',payload:{v:1,requestId:r.job.id,accountId:f.a.id}}]);
  const event=await customerWebOpenEvent(db,f.tenantId,r.job.id);
  const input={requestId:r.job.id,tenantId:f.tenantId,expectedRev:0 as const,rev:1 as const,key:`${r.job.id}:1:open`,draft:event.draft};
  const projections=await Promise.all([projectLifecycleOpen(db,input),projectLifecycleOpen(db,input)]);
  expect(projections[0]).toEqual(projections[1]);
  const projected=projections[0];
  const task=(await sql<{customer_account_id:string;requested_by:string;request_id:string;language:string}>`SELECT customer_account_id,requested_by,request_id,language
    FROM hawa.tasks WHERE id=${projected.taskId}::uuid`.execute(owner)).rows[0];
  expect(task).toEqual({customer_account_id:f.a.id,requested_by:f.a.userId,request_id:r.job.id,language:'ar'});
  expect(projected.design).toMatchObject({sourcePlatform:'hawzhin_web',designStudio:true,variant:{width:1080,height:1080}});
  const creation=(await sql<{payload:Record<string,unknown>;state:string}>`SELECT payload,state FROM hawa.outbox_commands
    WHERE aggregate_id=${projected.taskId}::uuid AND command_type='task.created'`.execute(owner)).rows[0];
  expect(creation.state).toBe('delivered');
  expect(creation.payload).toMatchObject({lifecycleOwner:'restate',clientDnaVersion:1});
  expect(savedDesignCopy(creation.payload,'')).toEqual({copy:[f.body.exactCopy[0].text],instructions:f.body.designInstructions});
  expect(savedDesignCopyLocales(creation.payload,[f.body.exactCopy[0].text])).toEqual(['ar']);
  expect((await f.service.get(f.a.member,r.job.id)).id).toBe(r.job.id);
});
it('resolves an open only when references match the immutable Core command and account',async()=>{
  const f=await fixture(),r=await f.service.create(f.a.member,'command_refs_001',f.body);
  const command=(await sql<{id:string;idempotency_key:string}>`SELECT id,idempotency_key FROM hawa.outbox_commands
    WHERE aggregate_id=${r.job.id}::uuid AND command_type='customer.request.open'`.execute(owner)).rows[0];
  const refs={v:1 as const,requestId:r.job.id,tenantId:f.tenantId,accountId:f.a.id,commandId:command.id,key:command.idempotency_key};
  await expect(customerWebOpenEvent(db,f.tenantId,r.job.id,refs)).resolves.toMatchObject({requestId:r.job.id,chatId:`web:${f.a.id}`});
  for(const bad of [{...refs,accountId:f.b.id},{...refs,commandId:randomUUID()},{...refs,key:refs.key+'tamper'},
    {...refs,requestId:randomUUID()},{...refs,tenantId:randomUUID()}])
    await expect(customerWebOpenEvent(db,f.tenantId,r.job.id,bad)).rejects.toMatchObject({code:'UNAUTHORIZED_ACTOR'});
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
      ).toEqual([]);
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
it('concurrent duplicate retries create one immutable request and dispatch, and differing bodies conflict', async () => {
  const f = await fixture(1),
    results = await Promise.all(
      [1, 2, 3].map(() => f.service.create(f.a.member, 'request_001', f.body)),
    );
  expect(results.filter((r) => r.created)).toHaveLength(1);
  expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
  expect(
    (
      await sql`SELECT request_id FROM hawa.customer_web_requests WHERE request_id=${results[0].job.id}::uuid`.execute(
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
  const event=await customerWebOpenEvent(db,f.tenantId,r.job.id);
  const projected=await projectLifecycleOpen(db,{requestId:r.job.id,tenantId:f.tenantId,expectedRev:0,rev:1,key:`${r.job.id}:1:open`,draft:event.draft});
  for (const change of [
    sql`UPDATE hawa.tasks SET customer_account_id=${f.b.id}::uuid WHERE id=${projected.taskId}::uuid`,
    sql`UPDATE hawa.tasks SET requested_by=${f.b.userId}::uuid WHERE id=${projected.taskId}::uuid`,
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

it('refuses a forged web draft and revocation before projection without a task',async()=>{
  const f=await fixture(),r=await f.service.create(f.a.member,'request_001',f.body);
  const event=await customerWebOpenEvent(db,f.tenantId,r.job.id);
  const input={requestId:r.job.id,tenantId:f.tenantId,expectedRev:0 as const,rev:1 as const,key:`${r.job.id}:1:open`,draft:event.draft};
  await expect(projectLifecycleOpen(db,{...input,draft:{...input.draft,rawText:'Worker changed it'}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid`.execute(owner);
  await expect(projectLifecycleOpen(db,input)).rejects.toMatchObject({code:'UNAUTHORIZED_ACTOR'});
  expect((await sql`SELECT id FROM hawa.tasks WHERE tenant_id=${f.tenantId}::uuid`.execute(owner)).rows).toHaveLength(0);
});
it('records a real web receipt once and isolates messages without marking a question sent',async()=>{
  const f=await fixture(),r=await f.service.create(f.a.member,'request_001',f.body);
  const m={v:1 as const,key:`${r.job.id}:1:ack`,chatId:`web:${f.a.id}`,tenantId:f.tenantId,kind:'text' as const,text:'Received',class:'critical' as const};
  const a=await recordCustomerWebMessage(db,f.tenantId,m),b=await recordCustomerWebMessage(db,f.tenantId,m);
  expect(a).toEqual(b);expect(a.outcome).toBe('web_recorded');
  await expect(recordCustomerWebMessage(db,f.tenantId,{...m,text:'Changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await expect(recordCustomerWebMessage(db,f.tenantId,{...m,key:`${r.job.id}:1:foreign`,chatId:`web:${f.b.id}`})).rejects.toMatchObject({code:'UNAUTHORIZED_ACTOR'});
  await expect(recordCustomerWebMessage(db,f.tenantId,{...m,key:`${r.job.id}:1:foreign-ref`,exportRef:{tenantId:randomUUID(),taskId:randomUUID(),artifactId:randomUUID(),sha256:'0'.repeat(64)}})).rejects.toMatchObject({code:'UNAUTHORIZED_ACTOR'});
  const messages=await f.service.messages(f.a.member,r.job.id);expect(messages).toHaveLength(1);expect(messages[0].text).toBe('Received');
  await expect(f.service.messages(f.b.member,r.job.id)).rejects.toMatchObject({status:404});
  expect((await sql`SELECT id FROM hawa.inbox_events WHERE tenant_id=${f.tenantId}::uuid`.execute(owner)).rows).toHaveLength(0);
});

it('rechecks customer generation access at the shared paid-reservation boundary',async()=>{
 const f=await fixture(),r=await f.service.create(f.a.member,'request_001',f.body),event=await customerWebOpenEvent(db,f.tenantId,r.job.id);
 const projected=await projectLifecycleOpen(db,{requestId:r.job.id,tenantId:f.tenantId,expectedRev:0,rev:1,key:`${r.job.id}:1:open`,draft:event.draft});
 const scope={tenantId:f.tenantId,userId:f.adminId,role:'administrator'};
 await withRlsContext(db,scope,trx=>sql`SELECT hawa.lock_customer_task_generation(${projected.taskId}::uuid)`.execute(trx));
 await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid`.execute(owner);
 await expect(withRlsContext(db,scope,trx=>sql`SELECT hawa.lock_customer_task_generation(${projected.taskId}::uuid)`.execute(trx))).rejects.toMatchObject({code:'42501'});
});

it('bounds a stalled request body without committing or awaiting an untrusted cancel hook',async()=>{
 vi.useFakeTimers();
 const create=vi.fn(),app=new Hono();
 registerCustomerRoutes(app,{create} as unknown as CustomerRequests,async()=>({kind:'workspace_member',issuer:HAWZHIN_AUTH_ORIGIN,subject:randomUUID()}),true);
 try {
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){return new Promise(()=>undefined);}});
  const request=new Request('http://test/v1/customer/jobs',{method:'POST',headers:{'Idempotency-Key':'request_001'},body:stream,duplex:'half'} as RequestInit);
  const answer=app.request(request);
  await vi.advanceTimersByTimeAsync(10001);
  expect((await answer).status).toBe(408);expect(create).not.toHaveBeenCalled();
 } finally {vi.useRealTimers();}
});

it('reserves global automatic slots atomically across members, and preserves replay at the cap',async()=>{
 vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL','1');
 try {
  const f=await fixture(10),members=[f.a.member,f.b.member];
  const results=await Promise.allSettled(members.map(m=>f.service.create(m,'request_001',f.body)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{status:429}});
  const index=results.findIndex(r=>r.status==='fulfilled');
  expect((await f.service.create(members[index],'request_001',f.body)).created).toBe(false);
 } finally {vi.unstubAllEnvs();}
});
it('does not silently send admitted web requests to manual work at the Telegram sender cap',async()=>{
 vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER','1');
 try {
  const f=await fixture(10);
  for(let i=0;i<2;i++) {
   const r=await f.service.create(f.a.member,`request_00${i}`,f.body),event=await customerWebOpenEvent(db,f.tenantId,r.job.id);
   const projection=await projectLifecycleOpen(db,{requestId:r.job.id,tenantId:f.tenantId,expectedRev:0,rev:1,key:`${r.job.id}:1:open`,draft:event.draft});
   expect(projection).toMatchObject({autoGenerate:true,stage:'designing'});
  }
 } finally {vi.unstubAllEnvs();}
});

it('retains an uppercase UUID submission body while resolving its canonical selected brand',async()=>{
 const f=await fixture(),body={...f.body,clientId:f.clientId.toUpperCase()},r=await f.service.create(f.a.member,'request_001',body);
 const event=await customerWebOpenEvent(db,f.tenantId,r.job.id);
 expect(event.draft.clientId).toBe(f.clientId);
 expect((await f.service.create(f.a.member,'request_001',body)).job.id).toBe(r.job.id);
});

const photoJpeg=readFileSync(new URL('./fixtures/telegram-photo-1280.jpg',import.meta.url));
const photoHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function upload(f:Awaited<ReturnType<typeof fixture>>,n=0,member=f.a.member) {
  const bytes=execFileSync('ffmpeg',['-v','error','-f','image2pipe','-i','pipe:0','-vf',`scale=32:32,hue=h=${n*37}`,
    '-frames:v','1','-threads','1','-c:v','png','-f','image2pipe','pipe:1'],{input:photoJpeg,maxBuffer:65536});
  return f.service.uploadPhoto(member,f.clientId,'photo_key_'+n,`photo${n}.png`,'image/png',bytes,photoHash(bytes));
}
it('decodes actual JPEG/PNG/WebP originals and refuses malformed headers, hash mismatch, traversal and pixel bombs',async()=>{
  const jpg=inspectCustomerPhoto(photoJpeg,'image/jpeg','original.jpg',photoHash(photoJpeg));
  expect(jpg.width).toBeGreaterThan(0);
  await decodeCustomerPhoto(photoJpeg,'image/jpeg');
  const webp=readFileSync(new URL('./fixtures/customer-photo-32.webp',import.meta.url));
  expect(inspectCustomerPhoto(webp,'image/webp','image.webp',photoHash(webp))).toMatchObject({width:32,height:32});
  await decodeCustomerPhoto(webp,'image/webp');
  expect(()=>inspectCustomerPhoto(photoJpeg,'image/png','photo.png',photoHash(photoJpeg))).toThrow('DESIGN_PHOTO_UNREADABLE');
  expect(()=>inspectCustomerPhoto(photoJpeg,'image/jpeg','../photo.jpg',photoHash(photoJpeg))).toThrow('DESIGN_PHOTO_INVALID');
  expect(()=>inspectCustomerPhoto(photoJpeg,'image/jpeg','photo.jpg','0'.repeat(64))).toThrow('DESIGN_PHOTO_HASH_MISMATCH');
  const header=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(header);header.write('IHDR',12);header.writeUInt32BE(32,16);header.writeUInt32BE(32,20);
  await expect(decodeCustomerPhoto(header,'image/png')).rejects.toMatchObject({code:'DESIGN_PHOTO_UNREADABLE'});
  header.writeUInt32BE(12000,16);header.writeUInt32BE(12000,20);
  expect(()=>inspectCustomerPhoto(header,'image/png','bomb.png',photoHash(header))).toThrow('DESIGN_PHOTO_DIMENSIONS');
});
it('retains six originals in requester order through the actual canonical projection without Telegram IDs',async()=>{
  const f=await fixture();const photos=[];
  for(let i=0;i<6;i++)photos.push((await upload(f,i)).photo);
  const photoIds=[...photos].reverse().map(p=>p.id);
  const body={...f.body,photoIds,photoUsage:{mode:'all' as const}};
  const admitted=await f.service.create(f.a.member,'six_photos',body);
  const open=await customerWebOpenEvent(db,f.tenantId,admitted.job.id);
  expect(open.draft).toMatchObject({platform:'hawzhin_web',customerWebPhotos:{v:1,images:[...photos].reverse().map(({sha256,mediaType,size})=>({sha256,mediaType,size}))}});
  expect(open.draft.lifecycleAlbum).toBeUndefined();expect(open.draft.lifecycleImage).toBeUndefined();
  expect(open.draft.designInstructions).toContain('use all photos');
  expect(open.draft.exactCopy).toEqual(f.body.exactCopy);
  const projected=await projectLifecycleOpen(db,{requestId:open.requestId,tenantId:f.tenantId,expectedRev:0,rev:1,draft:open.draft,key:'open:'+open.requestId});
  const task=(await sql<{id:string;source:Record<string,unknown>}>`SELECT t.id,e.data AS source FROM hawa.tasks t JOIN hawa.task_events e ON e.task_id=t.id AND e.event_type='task.created' WHERE t.request_id=${open.requestId}::uuid`.execute(owner)).rows[0];
  const refs=(await sql<{sha256:string;media_type:string;size:string}>`SELECT f.sha256,b.media_type,b.size FROM hawa.task_files f
    JOIN hawa.blobs b ON b.sha256=f.sha256 WHERE f.task_id=${task.id}::uuid`.execute(owner)).rows;
  expect(refs).toHaveLength(6);
  const payload=task.source.payload as Record<string,unknown>;
  expect(orderedCustomerPhotos(payload.customerWebPhotos,refs).map(r=>r.sha256)).toEqual([...photos].reverse().map(p=>p.sha256));
  expect(()=>orderedCustomerPhotos(payload.customerWebPhotos,refs.slice(1))).toThrow('Incomplete');
  const studio=new DesignStudioService(db,undefined,{blobStore:blobStoreFor(db)});
  const readImages=(studio as unknown as {requestImages:(scope:{tenantId:string;actorId:string},taskId:string)=>Promise<string[]>}).requestImages.bind(studio);
  const images=await readImages({tenantId:f.tenantId,actorId:CHANNEL_INGRESS_USER_ID},task.id);
  expect(images.map(u=>photoHash(Buffer.from(u.split(',')[1],'base64')))).toEqual([...photos].reverse().map(p=>p.sha256));

  await expect(projectLifecycleOpen(db,{requestId:open.requestId,tenantId:f.tenantId,expectedRev:0,rev:1,draft:open.draft,key:'open:'+open.requestId})).resolves.toEqual(projected);
  for(const p of photos)expect((await blobStoreFor(db)!.read(p.sha256,{verify:true})).length).toBe(p.size);
});
it('never forces all photos automatically and bounds an explicit count',async()=>{
  const f=await fixture();const a=(await upload(f,1)).photo,b=(await upload(f,2)).photo;
  const result=await f.service.create(f.a.member,'auto_photo',{...f.body,photoIds:[a.id,b.id]});
  expect((await customerWebOpenEvent(db,f.tenantId,result.job.id)).draft.designInstructions).toBe(f.body.designInstructions);
  await expect(f.service.create(f.a.member,'bad_count',{...f.body,photoIds:[a.id],photoUsage:{mode:'count',count:2}})).rejects.toMatchObject({code:'DESIGN_PHOTOS_INVALID'});
  const count=await f.service.create(f.a.member,'one_photo',{...f.body,photoIds:[a.id,b.id],photoUsage:{mode:'count',count:1}});
  expect((await customerWebOpenEvent(db,f.tenantId,count.job.id)).draft.designInstructions).toContain('use exactly 1 photos');
});
it('refuses other customers, brands, duplicate content and revoked grant photos',async()=>{
  const f=await fixture();const a=(await upload(f)).photo;
  await expect(f.service.create(f.b.member,'other_photo',{...f.body,photoIds:[a.id]})).rejects.toMatchObject({code:'DESIGN_PHOTOS_INVALID'});
  await expect(f.service.create(f.a.member,'repeat_photo',{...f.body,photoIds:[a.id,a.id]})).rejects.toMatchObject({code:'DESIGN_PHOTOS_INVALID'});
  const duplicate=await f.service.uploadPhoto(f.a.member,f.clientId,'same_byte_other','other.png',a.mediaType,await blobStoreFor(db)!.read(a.sha256),a.sha256);
  await expect(f.service.create(f.a.member,'same_bytes',{...f.body,photoIds:[a.id,duplicate.photo.id]})).rejects.toMatchObject({code:'DESIGN_PHOTOS_INVALID'});
  await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid`.execute(owner);
  await expect(f.service.create(f.a.member,'revoked_photo',{...f.body,photoIds:[a.id]})).rejects.toMatchObject({status:403});
});
it('serializes concurrent upload replay and preserves immutable GC roots',async()=>{
  const f=await fixture();const result=await Promise.all([upload(f),upload(f)]);
  expect(result.map(r=>r.created).sort()).toEqual([false,true]);expect(result[0].photo).toEqual(result[1].photo);
  const p=result[0].photo;
  expect((await sql`SELECT sha256 FROM hawa.blob_references WHERE sha256=${p.sha256}`.execute(owner)).rows.length).toBeGreaterThan(0);
  await expect(sql`UPDATE hawa.customer_photo_receipts SET filename='changed' WHERE id=${p.id}::uuid`.execute(owner)).rejects.toMatchObject({code:'55000'});
  await expect(f.service.uploadPhoto(f.a.member,f.clientId,'photo_key_0','changed.png',p.mediaType,await blobStoreFor(db)!.read(p.sha256),p.sha256)).rejects.toMatchObject({status:409});
  await sql`INSERT INTO hawa.customer_photo_receipts(tenant_id,account_id,client_id,subject,action_key,filename,sha256,media_type,size,width,height)
    SELECT tenant_id,account_id,client_id,subject,'quota_'||n,filename,sha256,media_type,size,width,height
    FROM hawa.customer_photo_receipts CROSS JOIN generate_series(1,39) n WHERE id=${p.id}::uuid`.execute(owner);
  await expect(upload(f,2)).rejects.toMatchObject({status:429});
});
it('mounts binary uploads under customer authentication, exact replay, disabled admission and actual streamed bounds',async()=>{
  const f=await fixture();const app=new Hono();registerCustomerRoutes(app,f.service,async()=>f.a.member,true);
  const headers={'Content-Type':'image/jpeg','Idempotency-Key':'http_photo','X-Content-SHA256':photoHash(photoJpeg),'X-Photo-Filename':encodeURIComponent('Original photo.jpg')};
  const url='/v1/customer/clients/'+f.clientId+'/photos';
  const first=await app.request(url,{method:'POST',headers,body:new Uint8Array(photoJpeg)});expect(first.status).toBe(201);
  expect((await app.request(url,{method:'POST',headers,body:new Uint8Array(photoJpeg)})).status).toBe(200);
  const huge=await app.request(url,{method:'POST',headers,body:new Uint8Array(10*1024*1024+1)});expect(huge.status).toBe(413);
  const disabled=new Hono();registerCustomerRoutes(disabled,f.service,async()=>f.a.member,false);
  expect((await disabled.request(url,{method:'POST',headers,body:new Uint8Array(photoJpeg)})).status).toBe(503);
  await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid`.execute(owner);
  expect((await app.request(url,{method:'POST',headers,body:new Uint8Array(photoJpeg)})).status).toBe(403);
});

it('binds explicit web photo choices deterministically even when words say choose best',()=>{
  expect(customerPhotoSelection({photoCount:6,usage:{mode:'all'}},'Choose the best photos',6)).toEqual({mode:'all',minimum:6,insisted:true});
  expect(customerPhotoSelection({photoCount:6,usage:{mode:'count',count:2}},'Use all photos',6)).toMatchObject({mode:'choose',minimum:2,maximum:2,counted:true});
  expect(()=>customerPhotoSelection({photoCount:6,usage:{mode:'all'}},'',5)).toThrow('changed');
});

it('refuses a same-owner foreign-brand photo and never resets upload allowance after brand revocation',async()=>{
  const f=await fixture(),otherClient=randomUUID();
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name,status) VALUES(${otherClient}::uuid,${f.tenantId}::uuid,${otherClient},'Second synthetic brand','active')`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${f.tenantId}::uuid,${otherClient}::uuid,${f.a.userId}::uuid,'requester')`.execute(owner);
  await withRlsContext(db,{tenantId:f.tenantId,userId:f.adminId,role:'administrator'},async trx=>{
    await sql`INSERT INTO hawa.customer_client_grants(tenant_id,account_id,client_id,provisioned_by,reason)
      VALUES(${f.tenantId}::uuid,${f.a.id}::uuid,${otherClient}::uuid,${f.adminId}::uuid,'Synthetic second brand')`.execute(trx);
  });
  const p=(await f.service.uploadPhoto(f.a.member,otherClient,'second_photo','second.jpg','image/jpeg',photoJpeg,photoHash(photoJpeg))).photo;
  await expect(f.service.create(f.a.member,'wrong_brand',{...f.body,photoIds:[p.id]})).rejects.toMatchObject({code:'DESIGN_PHOTOS_INVALID'});
  await sql`INSERT INTO hawa.customer_photo_receipts(tenant_id,account_id,client_id,subject,action_key,filename,sha256,media_type,size,width,height)
    SELECT tenant_id,account_id,client_id,subject,'revoked_quota_'||n,filename,sha256,media_type,size,width,height
    FROM hawa.customer_photo_receipts CROSS JOIN generate_series(1,39) n WHERE id=${p.id}::uuid`.execute(owner);
  await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid AND client_id=${otherClient}::uuid`.execute(owner);
  await expect(upload(f,8)).rejects.toMatchObject({status:429});
});

it('bounds concurrent streaming photo bodies before buffering and releases stalled slots on deadline',async()=>{
  const f=await fixture(),app=new Hono();registerCustomerRoutes(app,f.service,async()=>f.a.member,true);
  const checked=vi.spyOn(f.service,'checkPhotoAccess').mockResolvedValue(undefined);
  const headers={'Content-Type':'image/jpeg','Idempotency-Key':'stream_photo','X-Content-SHA256':photoHash(photoJpeg),'X-Photo-Filename':'photo.jpg'};
  const url='/v1/customer/clients/'+f.clientId+'/photos';
  vi.useFakeTimers();
  try {
    const stream=()=>new ReadableStream({pull(){return new Promise(()=>undefined);},cancel(){return new Promise(()=>undefined);}});
    const init=(body:ReadableStream)=>({method:'POST',headers,body,duplex:'half'} as RequestInit);
    const one=app.request(url,init(stream())),two=app.request(url,init(stream()));
    for(let i=0;i<20 && checked.mock.calls.length<2;i++)await Promise.resolve();
    expect(checked).toHaveBeenCalledTimes(2);
    expect((await app.request(url,{method:'POST',headers,body:new Uint8Array(photoJpeg)})).status).toBe(503);
    await vi.advanceTimersByTimeAsync(15001);
    expect((await one).status).toBe(408);expect((await two).status).toBe(408);
  } finally {vi.useRealTimers();checked.mockRestore();}
  expect((await app.request(url,{method:'POST',headers,body:new Uint8Array(photoJpeg)})).status).toBe(201);
});
