import {pptx as syntheticPptx,png as syntheticPng} from './fixtures/shipped-export.js';
import {checkCanvaPptx} from '@hawa/qa';
import {CanvaConnectService} from '../src/services/canva-connect-service.js';
import {customerActionEvent,projectCustomerAction,acknowledgeCustomerAction} from '../src/customer/customer-actions.js';
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
import { projectLifecycleDesignOutcome, projectLifecycleOpen } from '../src/services/lifecycle-projection.js';
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

it('mounted Core defaults generation off, pins customer CORS and refuses workspace JWTs on office routes',async()=>{
 const {createApp}=await import('../src/app.js');
 const token='Bearer untrusted.claims.signature';
 const app=createApp({db,skipTelegramProbe:true,skipPaidModelProbe:true,customerApi:{publishableKey:'sb_publishable_testfixture12',
  fetcher:async url=>new Response(JSON.stringify(String(url).endsWith('/auth/v1/user')?{id:randomUUID(),role:'authenticated',aud:'authenticated'}:true))}});
 const response=await app.request('/v1/customer/jobs',{method:'POST',headers:{Authorization:token,Origin:'https://hawzhin.app'}});
 expect(response.status).toBe(503);expect(await response.json()).toMatchObject({code:'DESIGN_GENERATION_NOT_READY'});
 expect(response.headers.get('access-control-allow-origin')).toBe('https://hawzhin.app');
 expect((await app.request('/v1/tasks',{headers:{Authorization:token}})).status).toBe(401);
 const foreign=await app.request('/v1/customer/jobs',{headers:{Authorization:token,Origin:'https://evil.example'}});
 expect(foreign.status).toBe(403);expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
 expect((await app.request('/v1/office/customer-accounts',{method:'PUT',headers:{Authorization:'Bearer test_admin_key'},body:'{}'})).status).toBe(403);
});

it('mounted Core explicit generation opt-in commits one canonical customer request, exact copy and command',async()=>{
 const {createApp}=await import('../src/app.js');
 const {provisionCustomer}=await import('../src/customer/customer-provisioning.js');
 const tenantId='00000000-0000-4000-a000-000000000001',adminId='00000000-0000-4000-b000-000000000002';
 const clientId=randomUUID(),subject=randomUUID();
 await sql`INSERT INTO hawa.clients(id,tenant_id,code,name,status) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Private intake fixture','active')`.execute(owner);
 await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash)
   VALUES(${tenantId}::uuid,${clientId}::uuid,1,'active','{}',${randomUUID()})`.execute(owner);
 const account=await provisionCustomer(db,{tenantId,userId:adminId},randomUUID(),{subject,clientIds:[clientId],active:true,
   expectedVersion:0,dailyJobs:8,concurrentJobs:3,reason:'Private production factory intake qualification'});
 const app=createApp({db,skipTelegramProbe:true,skipPaidModelProbe:true,requesterIntentModel:null,customerApi:{publishableKey:'sb_publishable_testfixture12',generationEnabled:true,
   fetcher:async url=>new Response(JSON.stringify(String(url).endsWith('/auth/v1/user')?{id:subject,role:'authenticated',aud:'authenticated'}:true))}});
 const body={clientId,title:'Actual Core intake',exactCopy:[{text:'سڵاو — ٢٠٢٦\n(Exact copy)',language:'ckb'}],designInstructions:'Content-aware composition.',variant:'story'};
 const init={method:'POST',headers:{Authorization:'Bearer untrusted.claims.signature',Origin:'https://hawzhin.app','Content-Type':'application/json','Idempotency-Key':'factory_intake_001'},body:JSON.stringify(body)};
 const responses=await Promise.all([app.request('/v1/customer/jobs',init),app.request('/v1/customer/jobs',init)]);
 expect(responses.map(r=>r.status).sort()).toEqual([200,201]);
 const results=await Promise.all(responses.map(r=>r.json()));
 expect(results[0].job.id).toBe(results[1].job.id);
 const id=results[0].job.id;
 expect((await sql`SELECT account_id,body FROM hawa.customer_web_requests WHERE request_id=${id}::uuid`.execute(owner)).rows)
   .toEqual([{account_id:account.accountId,body}]);
 expect((await sql`SELECT command_type FROM hawa.outbox_commands WHERE aggregate_id=${id}::uuid`.execute(owner)).rows)
   .toEqual([{command_type:'customer.request.open'}]);
 const session=await app.request('/v1/customer/session',{headers:init.headers});
 expect(await session.json()).toMatchObject({accountId:account.accountId,generationEnabled:true});
 const foreign=await app.request('/v1/customer/jobs',{...init,headers:{...init.headers,Origin:'https://foreign.example'}});
 expect(foreign.status).toBe(403);
 expect((await app.request('/v1/tasks',{headers:init.headers})).status).toBe(401);
});

it('preserves six admitted website photos across mounted internal HTTP and refuses changed manifests',async()=>{
 const {createApp}=await import('../src/app.js');
 const {provisionCustomer}=await import('../src/customer/customer-provisioning.js');
 const tenantId='00000000-0000-4000-a000-000000000001',adminId='00000000-0000-4000-b000-000000000002';
 const clientId=randomUUID(),subject=randomUUID();
 await sql`INSERT INTO hawa.clients(id,tenant_id,code,name,status) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Mounted photo fixture','active')`.execute(owner);
 await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash)
   VALUES(${tenantId}::uuid,${clientId}::uuid,1,'active','{}',${randomUUID()})`.execute(owner);
 await provisionCustomer(db,{tenantId,userId:adminId},randomUUID(),{subject,clientIds:[clientId],active:true,
   expectedVersion:0,dailyJobs:8,concurrentJobs:3,reason:'Mounted six-photo projection regression'});
 const service=new CustomerRequests(db,tenantId),member:WorkspaceMember={kind:'workspace_member',issuer:HAWZHIN_AUTH_ORIGIN,subject};
 const photos=[];
 for(let i=0;i<6;i++) {
  const bytes=execFileSync('ffmpeg',['-v','error','-f','image2pipe','-i','pipe:0','-vf',`scale=32:32,hue=h=${i*37}`,
    '-frames:v','1','-threads','1','-c:v','png','-f','image2pipe','pipe:1'],{input:photoJpeg,maxBuffer:65536});
  photos.push((await service.uploadPhoto(member,clientId,'mounted_photo_'+i,`source${i}.png`,'image/png',bytes,photoHash(bytes))).photo);
 }
 const admitted=await service.create(member,'mounted_six_photos',{clientId,title:'Mounted six originals',
  exactCopy:[{text:'Use all six originals — ٢٠٢٦',language:'en'}],designInstructions:'Use a content-aware composition.',
  variant:'story',photoIds:[...photos].reverse().map(p=>p.id),photoUsage:{mode:'all'}});
 const open=await customerWebOpenEvent(db,tenantId,admitted.job.id);
 const saved=process.env.HAWA_WORKER_TOKEN,token=['test','customer','photo','projection','worker'].join('_');
 process.env.HAWA_WORKER_TOKEN=token;
 try {
  const app=createApp({db,skipTelegramProbe:true,skipPaidModelProbe:true,requesterIntentModel:null});
  const send=async(draft:unknown)=>app.request(`/v1/internal/lifecycle/${open.requestId}/project`,{
   method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
   body:JSON.stringify({v:1,expectedRev:0,rev:1,key:`${open.requestId}:1:open`,ops:[{kind:'createRequest',draft}]})});
  const changed=structuredClone(open.draft);changed.customerWebPhotos!.images.reverse();
  const refusal=await send(changed);expect(refusal.status).toBe(409);expect(await refusal.json()).toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const first=await send(open.draft);expect(first.status).toBe(200);const receipt=await first.json();
  const replay=await send(open.draft);expect(replay.status).toBe(200);expect(await replay.json()).toEqual(receipt);
  const task=(await sql<{id:string;source:Record<string,unknown>}>`SELECT t.id,e.data->'payload' AS source FROM hawa.tasks t JOIN hawa.task_events e ON e.task_id=t.id
   WHERE t.request_id=${open.requestId}::uuid AND e.event_type='task.created'`.execute(owner)).rows;
  expect(task).toHaveLength(1);expect(task[0].source).toMatchObject({customerWebPhotos:open.draft.customerWebPhotos,body:{photoUsage:{mode:'all'}}});
  expect((await sql<{sha256:string}>`SELECT sha256 FROM hawa.task_files WHERE task_id=${task[0].id}::uuid`.execute(owner)).rows.map(r=>r.sha256).sort()).toEqual(photos.map(p=>p.sha256).sort());
  const omitted={...open.draft};delete omitted.customerWebPhotos;
  expect((await send(omitted)).status).toBe(409);
  for(const manifest of [{v:2,images:open.draft.customerWebPhotos!.images},{v:1,images:[]},
    {v:1,images:[...open.draft.customerWebPhotos!.images,open.draft.customerWebPhotos!.images[0]]},
    {v:1,images:open.draft.customerWebPhotos!.images,owner:'forged'},
    {v:1,images:[{...open.draft.customerWebPhotos!.images[0],size:10485761}]}])
   expect((await send({...open.draft,customerWebPhotos:manifest})).status).toBe(400);
  expect((await send({...open.draft,platform:'telegram',sourceChannelId:'12345'})).status).toBe(400);
 } finally {
  if(saved===undefined)delete process.env.HAWA_WORKER_TOKEN;else process.env.HAWA_WORKER_TOKEN=saved;
 }
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
async function previewFixture(override?:Partial<CustomerDesignRequest>) {
 const f=await fixture();Object.assign(f.body,override);
 const receipt=await f.service.create(f.a.member,'preview_request',f.body);
 const event=await customerWebOpenEvent(db,f.tenantId,receipt.job.id);
 const projection=await projectLifecycleOpen(db,{requestId:receipt.job.id,tenantId:f.tenantId,expectedRev:0,rev:1,key:receipt.job.id+':1:open',draft:event.draft});
 const binding=randomUUID(),designId='Synthetic-'+randomUUID();
 await sql`INSERT INTO hawa.canva_bindings(id,tenant_id,task_id,client_id,canva_design_id,edit_url)
 VALUES(${binding}::uuid,${f.tenantId}::uuid,${projection.taskId}::uuid,${f.clientId}::uuid,${designId},'https://www.canva.com/design/synthetic/edit')`.execute(owner);
 const png=execFileSync('ffmpeg',['-v','error','-f','image2pipe','-i','pipe:0','-vf','scale=32:32','-frames:v','1','-threads','1','-c:v','png','-f','image2pipe','pipe:1'],{input:photoJpeg,maxBuffer:65536});
 async function capture(bytes=png,format='png',native='v1',check?:Record<string,unknown>) {
  const operation=randomUUID(),id=randomUUID(),hash=photoHash(bytes);
  await sql`INSERT INTO hawa.canva_remote_operations(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,kind,status,design_id,binding_version,metadata)
  VALUES(${operation}::uuid,${f.tenantId}::uuid,${projection.taskId}::uuid,${f.clientId}::uuid,${check?f.adminId:'synthetic-operator'},${operation},${hash},'export','retrieved',${designId},1,${JSON.stringify({designUpdatedAt:native,...(check?{checkingPolicy:check.checkingPolicy}:{})})}::jsonb)`.execute(owner);
  await sql`INSERT INTO hawa.canva_export_bytes(id,tenant_id,task_id,client_id,operation_id,format,sha256,content,content_check)
  VALUES(${id}::uuid,${f.tenantId}::uuid,${projection.taskId}::uuid,${f.clientId}::uuid,${operation}::uuid,${format},${hash},${bytes},${check?JSON.stringify(check):null}::jsonb)`.execute(owner);
  return {id,sha256:hash,version:1};
 }
 return {...f,receipt,projection,binding,designId,png,capture};
}
it('returns only captured native metadata and exact hashed PNG bytes for the current owner',async()=>{
 const f=await previewFixture();expect(await f.service.preview(f.a.member,f.receipt.job.id)).toBeNull();
 const capture=await f.capture(),detail=await f.service.detail(f.a.member,f.receipt.job.id);
 expect(detail.preview).toMatchObject({id:capture.id,requestVersion:1,bindingVersion:1,sha256:capture.sha256,size:f.png.length});
 expect(detail.preview).not.toHaveProperty('bytes');expect(JSON.stringify(detail)).not.toContain(f.designId);
 const result=await f.service.preview(f.a.member,f.receipt.job.id,capture);
 expect(result && 'bytes' in result && result.bytes.equals(f.png)).toBe(true);
 await expect(f.service.preview(f.b.member,f.receipt.job.id,capture)).rejects.toMatchObject({status:404});
 await expect(new CustomerRequests(db,randomUUID()).preview(f.a.member,f.receipt.job.id,capture)).rejects.toMatchObject({status:403});
});
it('rejects stale capture, request revision, hash and changed binding',async()=>{
 const f=await previewFixture(),capture=await f.capture();
 for(const changed of [{...capture,id:randomUUID()},{...capture,version:2},{...capture,sha256:'0'.repeat(64)}])
  await expect(f.service.preview(f.a.member,f.receipt.job.id,changed)).rejects.toMatchObject({code:'DESIGN_PREVIEW_STALE',status:409});
 const next=await f.capture();
 await expect(f.service.preview(f.a.member,f.receipt.job.id,capture)).rejects.toMatchObject({status:409});
 await expect(f.service.preview(f.a.member,f.receipt.job.id,next)).resolves.toMatchObject({id:next.id});
 await sql`UPDATE hawa.requests SET rev=rev+1 WHERE request_id=${f.receipt.job.id}::uuid`.execute(owner);
 await expect(f.service.preview(f.a.member,f.receipt.job.id,next)).rejects.toMatchObject({status:409});
 await sql`UPDATE hawa.canva_bindings SET version=version+1 WHERE id=${f.binding}::uuid`.execute(owner);
 expect(await f.service.preview(f.a.member,f.receipt.job.id)).toBeNull();
});
it('does not reuse an older PNG after a later native export observes a different design version',async()=>{
 const f=await previewFixture(),capture=await f.capture();
 await f.capture(Buffer.alloc(40,1),'pptx','v2');
 expect(await f.service.preview(f.a.member,f.receipt.job.id)).toBeNull();
 await expect(f.service.preview(f.a.member,f.receipt.job.id,capture)).rejects.toMatchObject({status:409});
 const next=await f.capture(f.png,'png','v2');
 await expect(f.service.preview(f.a.member,f.receipt.job.id,next)).resolves.toMatchObject({id:next.id});
});
it('rechecks revoked grant/account and disabled user instead of serving warm preview bytes',async()=>{
 for(const revoke of ['grant','account','user']) {
  const f=await previewFixture(),capture=await f.capture();
  await f.service.preview(f.a.member,f.receipt.job.id,capture);
  if(revoke==='grant')await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid`.execute(owner);
  if(revoke==='account')await sql`UPDATE hawa.customer_accounts SET active=false,version=version+1 WHERE id=${f.a.id}::uuid`.execute(owner);
  if(revoke==='user')await sql`UPDATE hawa.users SET disabled_at=now() WHERE id=${f.a.userId}::uuid`.execute(owner);
  await expect(f.service.preview(f.a.member,f.receipt.job.id,capture)).rejects.toMatchObject({status:revoke==='grant'?404:403});
 }
});
it('requires an observed native version and refuses a foreign current-task pointer',async()=>{
 const f=await previewFixture(),capture=await f.capture(f.png,'png','');
 expect(await f.service.preview(f.a.member,f.receipt.job.id)).toBeNull();
 await expect(f.service.preview(f.a.member,f.receipt.job.id,capture)).rejects.toMatchObject({status:409});
 await f.capture();
 const foreign=await f.service.create(f.b.member,'foreign_preview',f.body),event=await customerWebOpenEvent(db,f.tenantId,foreign.job.id);
 const projected=await projectLifecycleOpen(db,{requestId:foreign.job.id,tenantId:f.tenantId,expectedRev:0,rev:1,key:foreign.job.id+':1:open',draft:event.draft});
 await sql`UPDATE hawa.requests SET current_task_id=${projected.taskId}::uuid WHERE request_id=${f.receipt.job.id}::uuid`.execute(owner);
 expect(await f.service.preview(f.a.member,f.receipt.job.id)).toBeNull();
});
it('does not display revoked bindings or unconfirmed export operations',async()=>{
 const f=await previewFixture();await f.capture();
 await sql`UPDATE hawa.canva_remote_operations SET status='stale' WHERE task_id=${f.projection.taskId}::uuid`.execute(owner);
 expect(await f.service.preview(f.a.member,f.receipt.job.id)).toBeNull();
 await f.capture();
 await sql`UPDATE hawa.canva_bindings SET status='revoked' WHERE id=${f.binding}::uuid`.execute(owner);
 expect(await f.service.preview(f.a.member,f.receipt.job.id)).toBeNull();
});
it('refuses invalid hashed native PNG and never gives a public cache or provider URL',async()=>{
 const f=await previewFixture(),capture=await f.capture(),app=new Hono();
 registerCustomerRoutes(app,f.service,async()=>f.a.member,false);
 const url=`/v1/customer/jobs/${f.receipt.job.id}/preview/${capture.id}?version=1&sha256=${capture.sha256}`;
 const response=await app.request(url,{headers:{Origin:'https://hawzhin.app','If-None-Match':capture.sha256}});
 expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
 expect(response.headers.get('Content-Type')).toBe('image/png');expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
 expect(response.headers.get('ETag')).toBeNull();expect(response.headers.get('Location')).toBeNull();
 expect(Buffer.from(await response.arrayBuffer()).equals(f.png)).toBe(true);
 expect((await app.request(url,{headers:{Origin:'https://evil.example'}})).status).toBe(403);
 expect((await app.request(url.replace('version=1','version=2'))).status).toBe(409);
 const bad=await f.capture(Buffer.alloc(40,2));
 await expect(f.service.preview(f.a.member,f.receipt.job.id,bad)).rejects.toMatchObject({code:'DESIGN_PREVIEW_INVALID',status:503});
});
it('keeps raw native tables closed and grants no preview routine to the worker or public',async()=>{
 const f=await previewFixture();await f.capture();
 await withRlsContext(db,{tenantId:f.tenantId,userId:f.a.userId,role:'requester'},async trx=>{
  await sql`SELECT set_config('hawa.customer_subject',${f.a.member.subject},true),set_config('hawa.customer_id',${f.a.id},true)`.execute(trx);
  for(const table of ['canva_bindings','canva_remote_operations','canva_export_bytes'])
   expect((await sql`SELECT * FROM ${sql.table('hawa.'+table)}`.execute(trx)).rows).toHaveLength(0);
 });
 const permissions=(await sql<{worker:boolean;public:boolean}>`SELECT has_function_privilege('hawa_worker','hawa.customer_current_preview(uuid,uuid,bigint,text)','EXECUTE') AS worker,
 EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid='hawa.customer_current_preview(uuid,uuid,bigint,text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public`.execute(owner)).rows[0];
 expect(permissions).toEqual({worker:false,public:false});
});
it('bounds complete concurrent preview reads before retaining or decoding native bytes',async()=>{
 const f=await fixture(),app=new Hono();registerCustomerRoutes(app,f.service,async()=>f.a.member,false);
 const pending:Array<(value:null)=>void>=[];
 const spy=vi.spyOn(f.service,'preview').mockImplementation(()=>new Promise(resolve=>pending.push(resolve)));
 const url=`/v1/customer/jobs/${randomUUID()}/preview/${randomUUID()}?version=1&sha256=${'0'.repeat(64)}`;
 const a=app.request(url),b=app.request(url);
 try {
  await vi.waitFor(()=>expect(pending).toHaveLength(2));
  const busy=await app.request(url);expect(busy.status).toBe(503);expect(await busy.json()).toEqual({code:'DESIGN_PREVIEW_BUSY'});
  expect(spy).toHaveBeenCalledTimes(2);
 } finally {pending.forEach(resolve=>resolve(null));await Promise.all([a,b]);spy.mockRestore();}
 expect((await app.request(url)).status).toBe(404);
});
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

async function actionEvent(f:Awaited<ReturnType<typeof fixture>>,requestId:string,actionId:string) {
 const cmd=(await sql<{id:string;idempotency_key:string}>`SELECT id,idempotency_key FROM hawa.outbox_commands
 WHERE tenant_id=${f.tenantId}::uuid AND payload->>'actionId'=${actionId}`.execute(owner)).rows[0];
 return customerActionEvent(db,{v:1,requestId,tenantId:f.tenantId,accountId:f.a.id,actionId,commandId:cmd.id,key:cmd.idempotency_key});
}
it('admits one owned cancellation action and exactly reconciles replay before or after owner projection',async()=>{
 const f=await previewFixture(),requestId=f.receipt.job.id;
 const body={kind:'cancel' as const,expectedVersion:1,reason:'Created by mistake'};
 const [a,b]=await Promise.all([f.service.action(f.a.member,requestId,'cancel_key_001',body),f.service.action(f.a.member,requestId,'cancel_key_001',body)]);
 expect(a.action.id).toBe(b.action.id);expect([a.created,b.created].sort()).toEqual([false,true]);
 await expect(f.service.action(f.b.member,requestId,'foreign_action',body)).rejects.toMatchObject({status:404});
 await expect(f.service.action(f.a.member,requestId,'cancel_key_001',{...body,reason:'Other'})).rejects.toMatchObject({code:'DESIGN_ACTION_KEY_CONFLICT'});
 const event=await actionEvent(f,requestId,a.action.id),basis={taskId:f.projection.taskId,rev:1,stage:'designing',round:0};
 const result=await projectCustomerAction(db,event,basis);expect(result).toMatchObject({accepted:true,stage:'cancelled',rev:2});
 expect(await projectCustomerAction(db,event,basis)).toEqual(result);
 await acknowledgeCustomerAction(db,event,result);
 expect((await f.service.action(f.a.member,requestId,'cancel_key_001',body)).action.phase).toBe('applied');
 expect((await f.service.get(f.a.member,requestId)).state).toBe('cancelled');
});
it('refuses changed basis and revocation before action projection without changing the task',async()=>{
 for(const revoke of [false,true]) {
  const f=await previewFixture(),requestId=f.receipt.job.id;
  const receipt=await f.service.action(f.a.member,requestId,'cancel_key_001',{kind:'cancel',expectedVersion:1,reason:'Stop'});
  const event=await actionEvent(f,requestId,receipt.action.id);
  if(revoke)await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid`.execute(owner);
  const result=await projectCustomerAction(db,event,{taskId:f.projection.taskId,rev:revoke?1:2,stage:'designing',round:0});
  expect(result).toMatchObject({accepted:false,code:revoke?'DESIGN_ACCESS_DENIED':'DESIGN_ACTION_STALE'});
  expect((await sql<{state:string}>`SELECT state FROM hawa.tasks WHERE id=${f.projection.taskId}::uuid`.execute(owner)).rows[0].state).toBe('received');
 }
});
it('revises a web draft through existing intake and keeps customer scope and live copy separate from direction',async()=>{
 const f=await previewFixture(),requestId=f.receipt.job.id;
 await sql`UPDATE hawa.requests SET stage='in_review',rev=2 WHERE request_id=${requestId}::uuid`.execute(owner);
 const receipt=await f.service.action(f.a.member,requestId,'revise_key_001',{kind:'revise',expectedVersion:2,directive:'Make the composition calmer',category:'layout'});
 const event=await actionEvent(f,requestId,receipt.action.id);
 const result=await projectCustomerAction(db,event,{taskId:f.projection.taskId,rev:2,stage:'in_review',round:0});
 expect(result).toMatchObject({accepted:true,stage:'designing',rev:3,round:1});
 const task=(await sql<{customer_account_id:string;requested_by:string;source:Record<string,unknown>}>`SELECT t.customer_account_id,t.requested_by,e.data AS source FROM hawa.tasks t JOIN hawa.task_events e ON e.task_id=t.id AND e.event_type='task.created' WHERE t.id=${result.taskId}::uuid`.execute(owner)).rows[0];
 expect(task.customer_account_id).toBe(f.a.id);expect(task.requested_by).toBe(f.a.userId);
 expect(task.source).toMatchObject({payload:{sourcePlatform:'hawzhin_web'}});
 const payload=(await sql<{payload:Record<string,unknown>}>`SELECT payload FROM hawa.outbox_commands WHERE aggregate_id=${result.taskId}::uuid AND command_type='task.created'`.execute(owner)).rows[0].payload;
 expect(savedDesignCopy(payload,'').copy).toEqual([f.body.exactCopy[0].text]);
 expect(payload).toMatchObject({lifecycleOwner:'restate',sourcePlatform:'hawzhin_web'});
});

async function questionFixture() {
 const f=await previewFixture(),requestId=f.receipt.job.id,questionId=randomUUID(),taskId=f.projection.taskId;
 await sql`INSERT INTO hawa.design_studio_runs(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,request,tier,status,stages)
 VALUES(${questionId}::uuid,${f.tenantId}::uuid,${taskId}::uuid,${f.clientId}::uuid,'test',${questionId},'fixture-hash','{}','standard','failed',
 ${JSON.stringify({directed:{refused:'NEEDS_CLARIFICATION',clarify:{question:'Which date should be used?',options:['Today','Tomorrow']}}})}::jsonb)`.execute(owner);
 const outcome=await projectLifecycleDesignOutcome(db,{requestId,tenantId:f.tenantId,taskId,runId:`dr-${taskId}`,expectedRev:1,rev:2,key:requestId+':2:outcome',
 report:{status:'DESIGN_FAILED',code:'NEEDS_CLARIFICATION',runId:questionId}});
 expect(outcome.question?.id).toBe(questionId);
 const message=await recordCustomerWebMessage(db,f.tenantId,{v:1,key:requestId+':2:design-outcome',chatId:`web:${f.a.id}`,tenantId:f.tenantId,taskId,
 kind:'text',class:'critical',text:outcome.message!.text,onSent:{kind:'question',requestId,taskId,requestRev:2,questionId}});
 return {...f,questionId,messageId:message.receiptId,basis:{taskId,rev:2,stage:'awaiting_answer',round:0,questionId}};
}
it('retains a real web question without inferring seen, then explicitly records seen and answers with live replacement copy',async()=>{
 const f=await questionFixture(),requestId=f.receipt.job.id;
 expect((await f.service.detail(f.a.member,requestId)).actions).toMatchObject({canRevise:false,canCancel:true,questionMessageId:f.messageId});
 expect((await sql<{asked:Date|null}>`SELECT question_asked_at AS asked FROM hawa.requests WHERE request_id=${requestId}::uuid`.execute(owner)).rows[0].asked).toBeNull();
 await expect(f.service.action(f.a.member,requestId,'stale_question',{kind:'seen',expectedVersion:2,messageId:randomUUID()})).rejects.toMatchObject({code:'DESIGN_QUESTION_STALE'});
 const seen=await f.service.action(f.a.member,requestId,'seen_question',{kind:'seen',expectedVersion:2,messageId:f.messageId}),seenEvent=await actionEvent(f,requestId,seen.action.id);
 const result=await projectCustomerAction(db,seenEvent,f.basis);expect(result).toMatchObject({accepted:true,rev:2,questionId:f.questionId,messageId:f.messageId});
 expect(result.seenAtMs).toBeGreaterThan(0);expect(await projectCustomerAction(db,seenEvent,f.basis)).toEqual(result);
 await acknowledgeCustomerAction(db,seenEvent,result);
 const exactCopy=[{text:'موعدنا غداً ٢٠٢٦',language:'ar' as const}],answer=await f.service.action(f.a.member,requestId,'answer_question',{kind:'answer',expectedVersion:2,messageId:f.messageId,directive:'Use tomorrow, with this exact date text',exactCopy});
 const event=await actionEvent(f,requestId,answer.action.id),projected=await projectCustomerAction(db,event,f.basis);
 expect(projected).toMatchObject({accepted:true,rev:3,round:1,stage:'designing'});
 const payload=(await sql<{payload:Record<string,unknown>}>`SELECT payload FROM hawa.outbox_commands WHERE aggregate_id=${projected.taskId}::uuid AND command_type='task.created'`.execute(owner)).rows[0].payload;
 expect(savedDesignCopy(payload,'').copy).toEqual([exactCopy[0].text]);expect(payload.studioOptions).toMatchObject({clarified:true,answers:f.projection.taskId});
 expect(payload.studioOptions).not.toHaveProperty('parentTaskId');
 expect((await sql<{state:string}>`SELECT state FROM hawa.tasks WHERE id=${f.projection.taskId}::uuid`.execute(owner)).rows[0].state).toBe('cancelled');
 expect((await f.service.detail(f.a.member,requestId)).actions.questionMessageId).toBeNull();
});
it('rolls back a child task created during a permanently refused answer and retains a terminal action receipt',async()=>{
 const f=await questionFixture(),requestId=f.receipt.job.id;
 // Privileged corruption fixture: task no longer paused while request still asks the same question.
 await sql`UPDATE hawa.tasks SET state='received' WHERE id=${f.projection.taskId}::uuid`.execute(owner);
 const answer=await f.service.action(f.a.member,requestId,'answer_question',{kind:'answer',expectedVersion:2,messageId:f.messageId,directive:'Tomorrow'});
 const event=await actionEvent(f,requestId,answer.action.id),result=await projectCustomerAction(db,event,f.basis);
 expect(result).toMatchObject({accepted:false,code:'DESIGN_REVISION_UNAVAILABLE'});expect(await projectCustomerAction(db,event,f.basis)).toEqual(result);
 expect((await sql`SELECT id FROM hawa.tasks WHERE request_id=${requestId}::uuid`.execute(owner)).rows).toHaveLength(1);
 expect((await f.service.detail(f.a.member,requestId)).actions.receipts[0]).toMatchObject({phase:'refused',code:'DESIGN_REVISION_UNAVAILABLE'});
 expect((await sql<{rev:string}>`SELECT rev FROM hawa.requests WHERE request_id=${requestId}::uuid`.execute(owner)).rows[0].rev).toBe('2');
});
it('preserves every ordered original and explicit use-all policy in a web revision',async()=>{
 const f=await fixture(),photos=[];for(let i=0;i<3;i++)photos.push((await upload(f,i)).photo);
 const receipt=await f.service.create(f.a.member,'photo_revision',{...f.body,photoIds:[...photos].reverse().map(p=>p.id),photoUsage:{mode:'all'}}),requestId=receipt.job.id;
 const open=await customerWebOpenEvent(db,f.tenantId,requestId),projection=await projectLifecycleOpen(db,{requestId,tenantId:f.tenantId,expectedRev:0,rev:1,key:requestId+':1:open',draft:open.draft});
 await sql`UPDATE hawa.requests SET stage='in_review',rev=2 WHERE request_id=${requestId}::uuid`.execute(owner);
 const action=await f.service.action(f.a.member,requestId,'revise_photos',{kind:'revise',expectedVersion:2,directive:'Arrange the photos creatively',category:'imagery'}),event=await actionEvent(f,requestId,action.action.id);
 const result=await projectCustomerAction(db,event,{taskId:projection.taskId,rev:2,stage:'in_review',round:0});expect(result.accepted).toBe(true);
 const payload=(await sql<{payload:Record<string,unknown>}>`SELECT payload FROM hawa.outbox_commands WHERE aggregate_id=${result.taskId}::uuid AND command_type='task.created'`.execute(owner)).rows[0].payload;
 const refs=(await sql<{sha256:string;media_type:string;size:string}>`SELECT f.sha256,b.media_type,b.size FROM hawa.task_files f JOIN hawa.blobs b ON b.sha256=f.sha256 WHERE f.task_id=${result.taskId}::uuid`.execute(owner)).rows;
 expect(orderedCustomerPhotos(payload.customerWebPhotos,refs).map(p=>p.sha256)).toEqual([...photos].reverse().map(p=>p.sha256));expect(payload.designInstructions).toContain('use all photos');
 expect(savedDesignCopy(payload,'').copy).toEqual([f.body.exactCopy[0].text]);
});
it('reconciles a committed projection after revocation while refusing changed command evidence or acknowledgement',async()=>{
 const f=await previewFixture(),requestId=f.receipt.job.id,action=await f.service.action(f.a.member,requestId,'cancel_owned',{kind:'cancel',expectedVersion:1,reason:'Stop'}),event=await actionEvent(f,requestId,action.action.id),basis={taskId:f.projection.taskId,rev:1,stage:'designing',round:0};
 await expect(projectCustomerAction(db,{...event,bodyHash:'0'.repeat(64)},basis)).rejects.toMatchObject({code:'DESIGN_ACTION_INVALID'});
 await expect(customerActionEvent(db,{...event,commandId:randomUUID()})).rejects.toMatchObject({code:'DESIGN_ACTION_INVALID'});
 const result=await projectCustomerAction(db,event,basis);
 await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid`.execute(owner);
 expect(await projectCustomerAction(db,event,basis)).toEqual(result);
 await expect(acknowledgeCustomerAction(db,event,{...result,rev:3})).rejects.toMatchObject({code:'DESIGN_ACTION_INVALID'});
 await acknowledgeCustomerAction(db,event,result);await acknowledgeCustomerAction(db,event,result);
 expect((await sql<{phase:string}>`SELECT phase FROM hawa.customer_web_action_events WHERE action_id=${event.actionId}::uuid`.execute(owner)).rows.map(r=>r.phase).sort()).toEqual(['applied','projected']);
});
it('enforces pending-action and daily generation limits while allowing exact retries and cancellation',async()=>{
 const f=await previewFixture(),requestId=f.receipt.job.id;
 await sql`UPDATE hawa.customer_accounts SET daily_job_limit=1,version=version+1 WHERE id=${f.a.id}::uuid`.execute(owner);
 await sql`UPDATE hawa.requests SET stage='in_review',rev=2 WHERE request_id=${requestId}::uuid`.execute(owner);
 await expect(f.service.action(f.a.member,requestId,'over_limit',{kind:'revise',expectedVersion:2,directive:'More space',category:'layout'})).rejects.toMatchObject({status:429,code:'DESIGN_REQUEST_LIMIT'});
 const body={kind:'cancel' as const,expectedVersion:2,reason:'Stop'},first=await f.service.action(f.a.member,requestId,'cancel_limit',body);
 expect((await f.service.action(f.a.member,requestId,'cancel_limit',body)).action.id).toBe(first.action.id);
 await expect(f.service.action(f.a.member,requestId,'cancel_second',body)).rejects.toMatchObject({code:'DESIGN_ACTION_PENDING'});
});
it('mounts strict customer action admission behind auth, readiness, owned basis and exact replay',async()=>{
 const f=await previewFixture(),app=new Hono(),requestId=f.receipt.job.id;registerCustomerRoutes(app,f.service,async()=>f.a.member,true);
 const url=`/v1/customer/jobs/${requestId}/actions`,body={kind:'cancel',expectedVersion:1,reason:'Stop'},headers={'Content-Type':'application/json','Idempotency-Key':'http_cancel'};
 const first=await app.request(url,{method:'POST',headers,body:JSON.stringify(body)});expect(first.status).toBe(202);
 expect((await app.request(url,{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(200);
 expect((await app.request(url,{method:'POST',headers,body:JSON.stringify({...body,actorId:f.adminId})})).status).toBe(400);
 const disabled=new Hono();registerCustomerRoutes(disabled,f.service,async()=>f.a.member,false);
 expect((await disabled.request(url,{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(503);
 const foreign=new Hono();registerCustomerRoutes(foreign,f.service,async()=>f.b.member,true);
 expect((await foreign.request(url,{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(404);
});
it('keeps action rows and events immutable with no raw worker or foreign customer authority',async()=>{
 const f=await previewFixture(),requestId=f.receipt.job.id,action=await f.service.action(f.a.member,requestId,'immutable_cancel',{kind:'cancel',expectedVersion:1,reason:'Stop'});
 await expect(sql`UPDATE hawa.customer_web_actions SET kind='seen' WHERE id=${action.action.id}::uuid`.execute(owner)).rejects.toThrow();
 await expect(sql`DELETE FROM hawa.customer_web_actions WHERE id=${action.action.id}::uuid`.execute(owner)).rejects.toThrow();
 for(const table of ['customer_web_actions','customer_web_action_events']) {
  const grants=(await sql<{read:boolean;write:boolean}>`SELECT has_table_privilege('hawa_worker',${'hawa.'+table},'SELECT') AS read,has_table_privilege('hawa_worker',${'hawa.'+table},'INSERT') AS write`.execute(owner)).rows[0];expect(grants).toEqual({read:false,write:false});
 }
 const grants=(await sql<{execute:boolean}>`SELECT has_function_privilege('hawa_worker','hawa.customer_action_basis(uuid)','EXECUTE') AS execute`.execute(owner)).rows[0];expect(grants.execute).toBe(false);
 await expect(f.service.detail(f.b.member,requestId)).rejects.toMatchObject({status:404});
});

async function nativeReviewFixture(capitals=false) {
 const copy=['Verified announcement'],f=await previewFixture({variant:'portrait',exactCopy:[{text:copy[0],language:'en'}]}),
  sourceId=randomUUID(),operation=randomUUID(),bytes=Buffer.from(syntheticPptx({x:10,y:15,w:88,h:20,color:'14253D'},null,
    capitals?copy.map(text=>text.toUpperCase()):copy));
 const hash=photoHash(bytes),policy={version:1,kind:'imported_source',sourceId,copy,options:{fontsByIndex:['Cinzel'],directionsByIndex:['ltr' as const],
   ...(capitals?{uppercaseByIndex:[true]}:{})}};
 await sql`INSERT INTO hawa.canva_remote_operations(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,kind,status,design_id,binding_version)
 VALUES(${operation}::uuid,${f.tenantId}::uuid,${f.projection.taskId}::uuid,${f.clientId}::uuid,${f.adminId},${operation},${hash},'create','retrieved',${f.designId},1)`.execute(owner);
 await sql`INSERT INTO hawa.canva_editable_sources(id,tenant_id,task_id,client_id,actor_id,operation_id,sha256,content,manifest)
 VALUES(${sourceId}::uuid,${f.tenantId}::uuid,${f.projection.taskId}::uuid,${f.clientId}::uuid,${f.adminId},${operation}::uuid,${hash},${bytes},${JSON.stringify({copy})}::jsonb)`.execute(owner);
 f.png=Buffer.from(syntheticPng(1080,1350,'#FFFFFF'));
 const contentCheck={...checkCanvaPptx(bytes,copy,policy.options),expectedCopy:copy,checkingPolicy:policy};
 const png=await f.capture(f.png,'png','200'),exported=await f.capture(bytes,'pptx','200',contentCheck);
 await projectLifecycleDesignOutcome(db,{requestId:f.receipt.job.id,tenantId:f.tenantId,taskId:f.projection.taskId,runId:'dr-'+f.projection.taskId,
 expectedRev:1,rev:2,key:f.receipt.job.id+':2:outcome',report:{status:'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',designId:f.designId}});
 const reader={observeCustomerDesign:vi.fn(async()=>({ok:true,observedVersion:'200'}))};
 const service=new CustomerRequests(db,f.tenantId,reader),expected={...png,version:2};
 return {...f,service,reader,sourceId,bytes,exported,expected};
}
it('checks actual current native files with an independent customer boundary and exposes no provider authority',async()=>{
 const f=await nativeReviewFixture(),requestId=f.receipt.job.id;
 const result=await f.service.review(f.a.member,requestId,f.expected);
 expect(result).toMatchObject({status:'ready',requestVersion:2,previewId:f.expected.id,reasons:[],
 files:[{id:f.expected.id,format:'png',sha256:f.expected.sha256},{id:f.exported.id,format:'pptx',sha256:f.exported.sha256}]});
 expect(result.basisSha256).toMatch(/^[a-f0-9]{64}$/);
 expect(f.reader.observeCustomerDesign).toHaveBeenCalledExactlyOnceWith({tenantId:f.tenantId,actorId:f.adminId,designId:f.designId,capturedVersion:'200'});
 const encoded=JSON.stringify(result);for(const secret of [f.adminId,f.designId,'contentCheck','manifest','creation'])expect(encoded).not.toContain(secret);
 expect((await sql`SELECT id FROM hawa.approvals WHERE tenant_id=${f.tenantId}::uuid`.execute(owner)).rows).toHaveLength(0);
 await expect(f.service.review(f.b.member,requestId,f.expected)).rejects.toMatchObject({status:404});
 expect(f.reader.observeCustomerDesign).toHaveBeenCalledTimes(1);
});
it('fails closed on unobserved native edits, connection failures and missing version reader',async()=>{
 const f=await nativeReviewFixture(),id=f.receipt.job.id;
 for(const outcome of [{ok:false,code:'CANVA_DESIGN_CHANGED'},{ok:false,code:'CANVA_DESIGN_CHECK_UNAVAILABLE'},{ok:true,observedVersion:'201'}]) {
  f.reader.observeCustomerDesign.mockResolvedValueOnce(outcome as never);
  expect(await f.service.review(f.a.member,id,f.expected)).toMatchObject({status:'blocked',files:[],reasons:[
   outcome.code==='CANVA_DESIGN_CHANGED' ? 'NATIVE_DESIGN_CHANGED':'NATIVE_CHECK_UNAVAILABLE']});
 }
 expect(await new CustomerRequests(db,f.tenantId).review(f.a.member,id,f.expected)).toMatchObject({status:'blocked',reasons:['NATIVE_CHECK_UNAVAILABLE']});
});
it('reauthorizes after native observation and refuses changed evidence or revoked access',async()=>{
 for(const change of ['rev','grant','capture','qc']) {
  const f=await nativeReviewFixture();
  f.reader.observeCustomerDesign.mockImplementationOnce(async()=>{
   if(change==='rev')await sql`UPDATE hawa.requests SET rev=3 WHERE request_id=${f.receipt.job.id}::uuid`.execute(owner);
   if(change==='grant')await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid`.execute(owner);
   if(change==='capture')await f.capture(f.png,'png','201');
   if(change==='qc')await sql`UPDATE hawa.qc_runs SET critical_pass=false WHERE tenant_id=${f.tenantId}::uuid`.execute(owner);
   return {ok:true,observedVersion:'200'};
  });
  await expect(f.service.review(f.a.member,f.receipt.job.id,f.expected),change).rejects.toMatchObject({status:change==='grant'?404:409});
 }
});
it('does not let stored passing QC waive altered export text or a pending RTL visual review',async()=>{
 for(const mode of ['copy','rtl','failed']) {
  const f=await nativeReviewFixture();
  if(mode==='rtl')await sql`UPDATE hawa.qc_runs SET report=report||'{"rtlVisualReviewRequired":true}'::jsonb WHERE tenant_id=${f.tenantId}::uuid`.execute(owner);
  if(mode==='failed')await sql`UPDATE hawa.qc_runs SET status='failed',critical_pass=false WHERE tenant_id=${f.tenantId}::uuid`.execute(owner);
  if(mode==='copy') {
   // The actual parser must reject the byte-changed copy even if a stored check says pass.
   // Export bytes are immutable in production: test owner disables the trigger solely for fault injection.
   const altered=Buffer.from(syntheticPptx({x:10,y:15,w:88,h:20},null,['Wrong announcement']));
   await sql`ALTER TABLE hawa.canva_export_bytes DISABLE TRIGGER USER`.execute(owner);
   try {await sql`UPDATE hawa.canva_export_bytes SET content=${altered},sha256=${photoHash(altered)} WHERE id=${f.exported.id}::uuid`.execute(owner);}
   finally {await sql`ALTER TABLE hawa.canva_export_bytes ENABLE TRIGGER USER`.execute(owner);}
  }
  const result=await f.service.review(f.a.member,f.receipt.job.id,f.expected);
  expect(result).toMatchObject({status:'blocked',files:[]});
  expect(result.reasons).toContain(mode==='rtl'?'RTL_REVIEW_REQUIRED':'QUALITY_CHECK_FAILED');
  expect(f.reader.observeCustomerDesign).not.toHaveBeenCalled();
 }
});
it('keeps the native review function app-only and raw native tables closed to the customer',async()=>{
 const f=await nativeReviewFixture();
 const row=(await sql<{worker:boolean;public:boolean}>`SELECT has_function_privilege('hawa_worker','hawa.customer_native_review(uuid,uuid,bigint,text,boolean)','EXECUTE') AS worker,
 EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid='hawa.customer_native_review(uuid,uuid,bigint,text,boolean)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public`.execute(owner)).rows[0];
 expect(row).toEqual({worker:false,public:false});
 await withRlsContext(db,{tenantId:f.tenantId,userId:f.a.userId,role:'requester'},async trx=>{
  await sql`SELECT set_config('hawa.customer_id',${f.a.id},true),set_config('hawa.customer_subject',${f.a.member.subject},true)`.execute(trx);
  for(const table of ['canva_export_bytes','canva_remote_operations','canva_editable_sources','qc_runs'])
   expect((await sql`SELECT id FROM ${sql.table('hawa.'+table)}`.execute(trx)).rows).toHaveLength(0);
  const metadata=(await sql<{png:Buffer|null;pptx:Buffer|null;source:Buffer|null}>`SELECT * FROM hawa.customer_native_review(${f.receipt.job.id}::uuid,${f.expected.id}::uuid,2,${f.expected.sha256},false)`.execute(trx)).rows[0];
  expect(metadata).toMatchObject({png:null,pptx:null,source:null});
 });
});
it('mounts authenticated exact-version review HTTP without approval or cacheable results',async()=>{
 const f=await nativeReviewFixture(),app=new Hono();registerCustomerRoutes(app,f.service,async()=>f.a.member,false);
 const url=`/v1/customer/jobs/${f.receipt.job.id}/review/${f.expected.id}?version=2&sha256=${f.expected.sha256}`;
 const response=await app.request(url,{headers:{Origin:'https://hawzhin.app'}});
 expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
 expect(await response.json()).toMatchObject({status:'ready',files:[{format:'png'},{format:'pptx'}]});
 expect((await app.request(url.replace('version=2','version=1'))).status).toBe(409);
 expect((await app.request(url,{headers:{Origin:'https://attacker.example'}})).status).toBe(403);
});
it('bounds complete native checks and holds their slots until the server finishes',async()=>{
 const f=await nativeReviewFixture(),app=new Hono();registerCustomerRoutes(app,f.service,async()=>f.a.member,false);
 const pending:Array<(v:Awaited<ReturnType<CustomerRequests['review']>>)=>void>=[];
 const spy=vi.spyOn(f.service,'review').mockImplementation(()=>new Promise(resolve=>pending.push(resolve)));
 const url=`/v1/customer/jobs/${f.receipt.job.id}/review/${f.expected.id}?version=2&sha256=${f.expected.sha256}`;
 const first=app.request(url),second=app.request(url);await vi.waitFor(()=>expect(pending).toHaveLength(2));
 expect((await app.request(url)).status).toBe(503);
 spy.mockRestore();const result=await f.service.review(f.a.member,f.receipt.job.id,f.expected);
 pending.forEach(resolve=>resolve(result));expect((await Promise.all([first,second])).map(r=>r.status)).toEqual([200,200]);
 expect((await app.request(url)).status).toBe(200);
});
it('reads the actual bound actor connection for customer native version observation',async()=>{
 const f=await nativeReviewFixture(),canva=new CanvaConnectService(db);
 const getDesign=vi.fn().mockResolvedValue({design:{id:f.designId,updated_at:200}});
 vi.spyOn(canva,'authorizedClient').mockResolvedValue({getDesign} as never);
 const input={tenantId:f.tenantId,actorId:f.adminId,designId:f.designId,capturedVersion:'200'};
 expect(await canva.observeCustomerDesign(input)).toEqual({ok:true,observedVersion:'200'});
 expect(getDesign).toHaveBeenCalledWith(f.designId,{singleAttempt:true});
 getDesign.mockResolvedValueOnce({design:{id:f.designId,updated_at:201}});
 expect(await canva.observeCustomerDesign(input)).toMatchObject({ok:false,code:'CANVA_DESIGN_CHANGED'});
 getDesign.mockRejectedValueOnce(new Error('Synthetic provider failure'));
 expect(await canva.observeCustomerDesign(input)).toMatchObject({ok:false,code:'CANVA_DESIGN_CHECK_UNAVAILABLE'});
});

it('invalidates the checking policy when the active brand revision changes',async()=>{
 const f=await nativeReviewFixture();
 await sql`UPDATE hawa.client_dna_versions SET status='superseded' WHERE tenant_id=${f.tenantId}::uuid`.execute(owner);
 await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash)
 VALUES(${f.tenantId}::uuid,${f.clientId}::uuid,2,'active','{}',${randomUUID()})`.execute(owner);
 expect(await f.service.review(f.a.member,f.receipt.job.id,f.expected)).toMatchObject({status:'blocked',reasons:['CAPTURE_POLICY_CHANGED']});
 expect(f.reader.observeCustomerDesign).not.toHaveBeenCalled();
});

it('withholds readiness while an owned revision action awaits canonical acknowledgement',async()=>{
 const f=await nativeReviewFixture();
 await f.service.action(f.a.member,f.receipt.job.id,'review_pending_revision',{kind:'revise',expectedVersion:2,directive:'Improve the title hierarchy',category:'typography'});
 await expect(f.service.review(f.a.member,f.receipt.job.id,f.expected)).rejects.toMatchObject({status:409,code:'DESIGN_REVIEW_NOT_READY'});
 expect(f.reader.observeCustomerDesign).not.toHaveBeenCalled();
});

async function acceptanceFixture(capitals=false) {
 const f=await nativeReviewFixture(capitals),review=await f.service.review(f.a.member,f.receipt.job.id,f.expected);
 expect(review.status).toBe('ready');
 const body={kind:'accept' as const,expectedVersion:review.requestVersion,previewId:review.previewId,
  previewSha256:review.previewSha256,basisSha256:review.basisSha256,files:review.files};
 const admitted=await f.service.action(f.a.member,f.receipt.job.id,'accept_key_001',body);
 const event=await actionEvent(f,f.receipt.job.id,admitted.action.id),basis={taskId:f.projection.taskId,rev:2,stage:'in_review',round:0};
 return {...f,review,body,admitted,event,basis};
}
async function applyAcceptance(f:Awaited<ReturnType<typeof acceptanceFixture>>) {
 const result=await projectCustomerAction(db,f.event,f.basis,f.reader);expect(result).toMatchObject({kind:'accept',accepted:true,rev:3,stage:'in_review',taskId:f.projection.taskId});
 expect((await f.service.detail(f.a.member,f.receipt.job.id)).acceptance).toBeNull();
 await acknowledgeCustomerAction(db,f.event,result);return result;
}
function downloadExpected(f:Awaited<ReturnType<typeof acceptanceFixture>>,format:'png'|'pptx'='png') {
 const file=f.review.files.find(a=>a.format===format)!;
 return {acceptanceId:f.admitted.action.id,version:3,format,fileId:file.id,sha256:file.sha256};
}
it('records one independent customer acceptance, waits for durable acknowledgement and downloads exact owned files',async()=>{
 const f=await acceptanceFixture(),id=f.receipt.job.id;
 await expect(f.service.download(f.a.member,id,downloadExpected(f))).rejects.toMatchObject({status:409});
 expect((await f.service.action(f.a.member,id,'accept_key_001',f.body)).created).toBe(false);
 const result=await applyAcceptance(f);
 const detail=await f.service.detail(f.a.member,id);expect(detail).toMatchObject({job:{version:3,state:'customer_approved'},acceptance:{id:f.admitted.action.id,requestVersion:3,files:f.review.files}});
 expect(JSON.stringify(detail.acceptance)).not.toContain(f.designId);
 for(const format of ['png','pptx'] as const) {
  const download=await f.service.download(f.a.member,id,downloadExpected(f,format));
  expect(download.bytes.equals(format==='png' ? f.png:f.bytes)).toBe(true);expect(photoHash(download.bytes)).toBe(download.sha256);
 }
 const calls=f.reader.observeCustomerDesign.mock.calls.length;
 expect(await projectCustomerAction(db,f.event,f.basis,f.reader)).toEqual(result);
 expect(f.reader.observeCustomerDesign).toHaveBeenCalledTimes(calls);
 await acknowledgeCustomerAction(db,f.event,result);
 const rows=(await sql<{n:string}>`SELECT count(*) AS n FROM hawa.customer_acceptances WHERE tenant_id=${f.tenantId}::uuid AND action_id=${f.admitted.action.id}::uuid`.execute(owner)).rows[0];expect(Number(rows.n)).toBe(1);
 expect((await sql<{state:string}>`SELECT state FROM hawa.tasks WHERE id=${f.projection.taskId}::uuid`.execute(owner)).rows[0].state).toBe('human_review');
});
it('uses the frozen capitals policy through independent customer review, acceptance and native download',async()=>{
 const f=await acceptanceFixture(true);await applyAcceptance(f);
 const download=await f.service.download(f.a.member,f.receipt.job.id,downloadExpected(f,'pptx'));
 expect(download.bytes.equals(f.bytes)).toBe(true);
 expect(checkCanvaPptx(download.bytes,['Verified announcement'],{fontsByIndex:['Cinzel']}).copyPass).toBe(false);
 expect(checkCanvaPptx(download.bytes,['Verified announcement'],{fontsByIndex:['Cinzel'],uppercaseByIndex:[true]}).copyPass).toBe(true);
});
it('refuses forged reviewed identities and foreign customer approval without touching Canva',async()=>{
 const f=await nativeReviewFixture(),review=await f.service.review(f.a.member,f.receipt.job.id,f.expected);
 const body={kind:'accept' as const,expectedVersion:2,previewId:review.previewId,previewSha256:review.previewSha256,basisSha256:review.basisSha256,files:review.files};
 f.reader.observeCustomerDesign.mockClear();
 for(const altered of [{...body,basisSha256:'0'.repeat(64)},{...body,files:[body.files[0],{...body.files[1],id:randomUUID()}]},
  {...body,files:[body.files[1],body.files[0]]},{...body,expectedVersion:1}])
  await expect(f.service.action(f.a.member,f.receipt.job.id,randomUUID(),altered)).rejects.toMatchObject({status:409});
 await expect(f.service.action(f.b.member,f.receipt.job.id,randomUUID(),body)).rejects.toMatchObject({status:404});
 expect(f.reader.observeCustomerDesign).not.toHaveBeenCalled();
});
it('refuses native edits or unavailable observations at approval and reconciles that refusal',async()=>{
 for(const mode of ['changed','unavailable','missing']) {
  const f=await acceptanceFixture();f.reader.observeCustomerDesign.mockClear();
  f.reader.observeCustomerDesign.mockResolvedValue(mode==='changed' ? {ok:false,code:'CANVA_DESIGN_CHANGED'} as never:{ok:false} as never);
  const result=await projectCustomerAction(db,f.event,f.basis,mode==='missing'?undefined:f.reader);
  expect(result).toMatchObject({accepted:false,code:mode==='changed'?'DESIGN_ACCEPTANCE_STALE':'DESIGN_NATIVE_CHECK_UNAVAILABLE'});
  expect(await projectCustomerAction(db,f.event,f.basis,f.reader)).toEqual(result);
  expect((await f.service.get(f.a.member,f.receipt.job.id)).version).toBe(2);
 }
});
it('reauthorizes acceptance after the provider returns and never inherits changed evidence',async()=>{
 for(const change of ['grant','revision','qc']) {
  const f=await acceptanceFixture();f.reader.observeCustomerDesign.mockImplementation(async()=>{
   if(change==='grant')await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid`.execute(owner);
   if(change==='revision')await sql`UPDATE hawa.requests SET rev=3 WHERE request_id=${f.receipt.job.id}::uuid`.execute(owner);
   if(change==='qc')await sql`UPDATE hawa.qc_runs SET status='failed',critical_pass=false WHERE tenant_id=${f.tenantId}::uuid`.execute(owner);
   return {ok:true,observedVersion:'200'};
  });
  const result=await projectCustomerAction(db,f.event,f.basis,f.reader);expect(result.accepted).toBe(false);
  expect((await sql<{n:string}>`SELECT count(*) AS n FROM hawa.customer_acceptances WHERE action_id=${f.admitted.action.id}::uuid`.execute(owner)).rows[0].n).toBe('0');
 }
});
it('reconciles committed acceptance before revoked grants or an unavailable provider',async()=>{
 const f=await acceptanceFixture(),result=await applyAcceptance(f);f.reader.observeCustomerDesign.mockClear();
 await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid`.execute(owner);
 expect(await projectCustomerAction(db,f.event,f.basis,f.reader)).toEqual(result);expect(f.reader.observeCustomerDesign).not.toHaveBeenCalled();
 await expect(f.service.download(f.a.member,f.receipt.job.id,downloadExpected(f))).rejects.toMatchObject({status:404});
});
it('invalidates customer downloads for native edits, changed QA, new captures, revisions or pending actions',async()=>{
 for(const change of ['native','qc','capture','revision','pending']) {
  const f=await acceptanceFixture();await applyAcceptance(f);
  if(change==='native')f.reader.observeCustomerDesign.mockResolvedValue({ok:false,code:'CANVA_DESIGN_CHANGED'} as never);
  if(change==='qc')await sql`UPDATE hawa.qc_runs SET critical_pass=false WHERE tenant_id=${f.tenantId}::uuid`.execute(owner);
  if(change==='capture')await f.capture(f.png,'png','201');
  if(change==='revision')await sql`UPDATE hawa.requests SET rev=4 WHERE request_id=${f.receipt.job.id}::uuid`.execute(owner);
  if(change==='pending')await f.service.action(f.a.member,f.receipt.job.id,'cancel_after_approval',{kind:'cancel',expectedVersion:3,reason:'Changed brief'});
  await expect(f.service.download(f.a.member,f.receipt.job.id,downloadExpected(f))).rejects.toMatchObject({status:409});
 }
});
it('reauthorizes a download after observation and hides foreign and stale artifact requests',async()=>{
 const f=await acceptanceFixture();await applyAcceptance(f);const expected=downloadExpected(f);
 f.reader.observeCustomerDesign.mockClear();
 await expect(f.service.download(f.b.member,f.receipt.job.id,expected)).rejects.toMatchObject({status:404});
 for(const bad of [{...expected,version:2},{...expected,fileId:randomUUID()},{...expected,sha256:'0'.repeat(64)},{...expected,acceptanceId:randomUUID()}])
  await expect(f.service.download(f.a.member,f.receipt.job.id,bad)).rejects.toMatchObject({status:409});
 expect(f.reader.observeCustomerDesign).not.toHaveBeenCalled();
 f.reader.observeCustomerDesign.mockImplementation(async()=>{
  await sql`UPDATE hawa.customer_client_grants SET active=false,version=version+1 WHERE account_id=${f.a.id}::uuid`.execute(owner);
  return {ok:true,observedVersion:'200'};
 });
 await expect(f.service.download(f.a.member,f.receipt.job.id,expected)).rejects.toMatchObject({status:404});
});
it('releases an applied accepted request slot and reserves it again for an admitted revision',async()=>{
 const f=await acceptanceFixture();await applyAcceptance(f);
 await sql`UPDATE hawa.customer_accounts SET concurrent_job_limit=1,version=version+1 WHERE id=${f.a.id}::uuid`.execute(owner);
 await f.service.create(f.a.member,'next_request_001', {clientId:f.clientId,title:'Next design',exactCopy:[{text:'New copy',language:'en'}],designInstructions:'',variant:'square'});
 await expect(f.service.action(f.a.member,f.receipt.job.id,'revision_slot_001',{kind:'revise',expectedVersion:3,directive:'Calmer imagery',category:'imagery'})).rejects.toMatchObject({status:429,code:'DESIGN_CONCURRENCY_LIMIT'});
});
it('serves exact approved attachments with no-store and a complete two-request concurrency bound',async()=>{
 const f=await acceptanceFixture();await applyAcceptance(f);const app=new Hono();registerCustomerRoutes(app,f.service,async()=>f.a.member,false);
 const e=downloadExpected(f),url=`/v1/customer/jobs/${f.receipt.job.id}/download/${e.acceptanceId}/png?version=${e.version}&id=${e.fileId}&sha256=${e.sha256}`;
 const response=await app.request(url);expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer()).equals(f.png)).toBe(true);
 expect(response.headers.get('Cache-Control')).toBe('no-store');expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
 expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="design-${f.receipt.job.id}-3.png"`);
 expect((await app.request(url.replace('/png?','/pdf?'))).status).toBe(409);
 let resolve!:()=>void;const wait=new Promise<void>(r=>{resolve=r;});
 f.reader.observeCustomerDesign.mockImplementation(async()=>{await wait;return {ok:true,observedVersion:'200'};});
 f.reader.observeCustomerDesign.mockClear();const one=app.request(url),two=app.request(url);
 await vi.waitFor(()=>expect(f.reader.observeCustomerDesign).toHaveBeenCalledTimes(2));
 expect((await app.request(url)).status).toBe(503);resolve();expect((await one).status).toBe(200);expect((await two).status).toBe(200);
});
it('keeps customer acceptance receipts immutable and their elevated routines unavailable to the worker',async()=>{
 const f=await acceptanceFixture();await applyAcceptance(f);
 const privilege=(await sql<{worker:boolean}>`SELECT has_function_privilege('hawa_worker','hawa.customer_native_review_for_action(uuid,uuid,bigint,text,boolean,uuid)','EXECUTE') OR
 has_function_privilege('hawa_worker','hawa.customer_current_acceptance(uuid)','EXECUTE') AS worker`.execute(owner)).rows[0];expect(privilege.worker).toBe(false);
 await expect(sql`UPDATE hawa.customer_acceptances SET basis_hash=${'0'.repeat(64)} WHERE action_id=${f.admitted.action.id}::uuid`.execute(owner)).rejects.toThrow();
});
it('rejects corrupted actual bytes at acceptance and download despite unchanged stored identities',async()=>{
 for(const phase of ['accept','download']) {
  const f=await acceptanceFixture();if(phase==='download')await applyAcceptance(f);
  const altered=Buffer.from(f.png);altered[altered.length-1]^=1;
  // Isolated test-owner fault injection only: bypass the SQL hash constraint, then restore it and bytes.
  await sql`ALTER TABLE hawa.canva_export_bytes DISABLE TRIGGER USER`.execute(owner);
  await sql`ALTER TABLE hawa.canva_export_bytes DROP CONSTRAINT canva_export_bytes_check`.execute(owner);
  try {
   await sql`UPDATE hawa.canva_export_bytes SET content=${altered} WHERE id=${f.expected.id}::uuid`.execute(owner);
   f.reader.observeCustomerDesign.mockClear();
   if(phase==='accept')expect(await projectCustomerAction(db,f.event,f.basis,f.reader)).toMatchObject({accepted:false,code:'DESIGN_ACCEPTANCE_BLOCKED'});
   else await expect(f.service.download(f.a.member,f.receipt.job.id,downloadExpected(f))).rejects.toMatchObject({status:409,code:'DESIGN_DOWNLOAD_BLOCKED'});
   expect(f.reader.observeCustomerDesign).not.toHaveBeenCalled();
  } finally {
   await sql`UPDATE hawa.canva_export_bytes SET content=${f.png} WHERE id=${f.expected.id}::uuid`.execute(owner);
   await sql`ALTER TABLE hawa.canva_export_bytes ADD CONSTRAINT canva_export_bytes_check CHECK(sha256=encode(digest(content,'sha256'),'hex'))`.execute(owner);
   await sql`ALTER TABLE hawa.canva_export_bytes ENABLE TRIGGER USER`.execute(owner);
  }
 }
});
it('counts an accepted request with a pending revision as active before starting the new task',async()=>{
 const f=await acceptanceFixture();await applyAcceptance(f);
 await sql`UPDATE hawa.customer_accounts SET concurrent_job_limit=1,version=version+1 WHERE id=${f.a.id}::uuid`.execute(owner);
 const revision=await f.service.action(f.a.member,f.receipt.job.id,'revision_reservation_001',{kind:'revise',expectedVersion:3,directive:'Quieter imagery',category:'imagery'});
 expect(revision.created).toBe(true);
 await expect(f.service.create(f.a.member,'no_spare_slot_001',{clientId:f.clientId,title:'New design',exactCopy:[{text:'New copy',language:'en'}],designInstructions:'',variant:'square'})).rejects.toMatchObject({status:429,code:'DESIGN_CONCURRENCY_LIMIT'});
});
it('refuses a new approval key for already accepted current files without advancing the owner',async()=>{
 const f=await acceptanceFixture();await applyAcceptance(f);
 const current=await f.service.review(f.a.member,f.receipt.job.id,{...f.expected,version:3});
 await expect(f.service.action(f.a.member,f.receipt.job.id,'duplicate_new_key',{...f.body,expectedVersion:3,basisSha256:current.basisSha256})).rejects.toMatchObject({status:409,code:'DESIGN_ALREADY_APPROVED'});
 expect((await f.service.get(f.a.member,f.receipt.job.id)).version).toBe(3);
});
it('bounds complete concurrent acceptance checks until owner projection commits',async()=>{
 const [a,b,c]=await Promise.all([acceptanceFixture(),acceptanceFixture(),acceptanceFixture()]);
 let finish!:()=>void;const wait=new Promise<void>(r=>{finish=r;});
 for(const f of [a,b]){f.reader.observeCustomerDesign.mockClear();f.reader.observeCustomerDesign.mockImplementation(async()=>{await wait;return {ok:true,observedVersion:'200'};});}
 const one=projectCustomerAction(db,a.event,a.basis,a.reader),two=projectCustomerAction(db,b.event,b.basis,b.reader);
 await vi.waitFor(()=>{expect(a.reader.observeCustomerDesign).toHaveBeenCalledTimes(1);expect(b.reader.observeCustomerDesign).toHaveBeenCalledTimes(1);});
 await expect(projectCustomerAction(db,c.event,c.basis,c.reader)).rejects.toMatchObject({status:503,code:'DESIGN_ACCEPTANCE_BUSY'});
 finish();expect((await one).accepted).toBe(true);expect((await two).accepted).toBe(true);
 expect((await projectCustomerAction(db,c.event,c.basis,c.reader)).accepted).toBe(true);
});
it('exposes the approved file checksum through the real customer CORS middleware',async()=>{
 const {createApp}=await import('../src/app.js');
 const app=createApp({requesterIntentModel:null,skipTelegramProbe:true,skipPaidModelProbe:true});
 const response=await app.request('/v1/customer/session',{headers:{Origin:'https://hawzhin.app'}});
 expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://hawzhin.app');
 expect(response.headers.get('Access-Control-Expose-Headers')).toBe('X-Content-SHA256');
 const denied=await app.request('/v1/customer/session',{headers:{Origin:'https://foreign.example'}});
 expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
});
