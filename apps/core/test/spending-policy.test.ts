import {afterAll,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {createDb,sql,withRlsContext,DesignStudioRepository} from '@hawa/db';
import {SpendingPolicyService} from '../src/services/spending-policy.js';
import {createApp} from '../src/app.js';
import type {SpendingLimits,SpendingPolicyChange} from '@hawa/contracts';
const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!),db=createDb(process.env.TEST_DATABASE_URL!);
afterAll(async()=>{await db.destroy();await owner.destroy();});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(office=false){
  const tenantId=office?'00000000-0000-4000-a000-000000000001':randomUUID(),userId=randomUUID(),clientId=randomUUID(),taskId=randomUUID(),runId=randomUUID();
  const token=`hawa_sess_${randomUUID().replaceAll('-','')}`,scope={tenantId,userId,role:'administrator',sessionHash:hash(token)};
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Budget fixture',${tenantId}) ON CONFLICT DO NOTHING`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${userId+'@example.test'},'Budget administrator',${userId})`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'administrator')`.execute(owner);
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Budget client')`.execute(owner);
  await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Budget fixture')`.execute(owner);
  await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES(${scope.sessionHash},${tenantId}::uuid,${userId}::uuid,'oidc:budget-fixture','administrator','Budget administrator',now()+interval '1 hour','google_oidc')`.execute(owner);
  const tx=<T>(fn:Parameters<typeof withRlsContext<T>>[2])=>withRlsContext(db,scope,fn),service=new SpendingPolicyService(db),repo=new DesignStudioRepository(db);
  await repo.createRun({id:runId,tenantId,taskId,clientId,actorId:userId,requestKey:runId,requestHash:hash(runId),request:{},tier:'standard'});
  const body=async(limits:Partial<SpendingLimits>={}):Promise<SpendingPolicyChange>=>{const p=(await service.get(scope)).current;
    return {expectedVersion:p.version,expectedLimitsSha256:p.limitsSha256,reason:'Reviewed synthetic limits',limits:{...p.limits,...limits}};};
  const call=async()=>{const id=randomUUID();await repo.recordCallStart({id,tenantId,runId,actorId:userId,stage:'parity',provider:'synthetic',model:'budget-fixture',
    requestedModel:'budget-fixture',callOrdinal:null,logicalCallSha256:hash(id),reservation:{version:1,policy:'synthetic',requestSha256:hash(id),usd:.5,inputTokens:1,outputTokens:1}});return id;};
  return {tenantId,userId,clientId,taskId,runId,token,scope,tx,service,repo,body,call};
}
it('attributes immutable revisions and replays the exact old action after a later change',async()=>{
  const f=await fixture(),initial=await f.service.get(f.scope);expect(initial.canEdit).toBe(true);expect(initial.current.actorUserId).toBeNull();
  const action=randomUUID(),body=await f.body({officeUsd:22,clients:{[f.clientId]:10},roles:{voice_transcriber:2}});
  const first=await f.service.record(f.scope,action,body);expect(first).toMatchObject({replayed:false,receipt:{version:2,actorUserId:f.userId,limits:body.limits}});
  expect(first.receipt.limitsSha256).toMatch(/^[a-f0-9]{64}$/);
  await f.service.record(f.scope,randomUUID(),await f.body({officeUsd:21}));
  expect(await new SpendingPolicyService(db).record(f.scope,action,body)).toEqual({...first,replayed:true});
  await expect(f.service.record(f.scope,action,{...body,reason:'Different request'})).rejects.toMatchObject({code:'SPENDING_POLICY_ACTION_CONFLICT'});
  const current=await f.service.get(f.scope);expect(current.history).toHaveLength(3);expect(current.daily.policyVersion).toBe(3);
  for(const command of ['UPDATE hawa.studio_spending_policies SET reason=reason','DELETE FROM hawa.studio_spending_policies'])
    await expect(sql.raw(command).execute(owner)).rejects.toThrow('immutable');
});
it('serializes competing changes and refuses either stale version or stale limits hash',async()=>{
  const f=await fixture(),body=await f.body({officeUsd:12});
  const r=await Promise.allSettled([f.service.record(f.scope,randomUUID(),body),f.service.record(f.scope,randomUUID(),{...body,limits:{...body.limits,officeUsd:13}})]);
  expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(r.find(x=>x.status==='rejected')).toMatchObject({reason:{code:'SPENDING_POLICY_CHANGED'}});
  await expect(f.service.record(f.scope,randomUUID(),{...await f.body(),expectedLimitsSha256:'0'.repeat(64)})).rejects.toMatchObject({code:'SPENDING_POLICY_CHANGED'});
});
it('preserves existing obligations when lowering below spend, and binds later admission to the new policy',async()=>{
  const f=await fixture(),id=await f.call();
  await f.repo.finalizeCall({id,tenantId:f.tenantId,status:'ok',inputTokens:1,outputTokens:1,usdEstimate:.1,costBasis:'estimate',responseId:'synthetic'});
  await f.service.record(f.scope,randomUUID(),await f.body({officeUsd:0}));
  const state=await new SpendingPolicyService(db).get(f.scope);expect(state.daily.scopes.find(s=>s.scope==='office')).toMatchObject({maxUsd:0,spentUsd:.1,heldUsd:.4,remainingUsd:0});
  await expect(f.call()).rejects.toThrow('STUDIO_SCOPE_BUDGET_EXHAUSTED');
  await f.service.record(f.scope,randomUUID(),await f.body({officeUsd:30}));
  expect((await f.service.get(f.scope)).daily.scopes.find(s=>s.scope==='office')).toMatchObject({spentUsd:.1,heldUsd:.4});
  const next=await f.call();
  const row=(await sql<{version:number}>`SELECT spending_policy_version AS version FROM hawa.design_studio_calls WHERE id=${next}::uuid`.execute(owner)).rows[0];expect(row.version).toBe(3);
});
it('serializes a zero-limit change with a real call admission without erasing an admitted reservation',async()=>{
  for(let i=0;i<3;i++){
    const f=await fixture(),body=await f.body({officeUsd:0});
    const [policy,call]=await Promise.allSettled([f.service.record(f.scope,randomUUID(),body),f.call()]);
    expect(policy.status).toBe('fulfilled');
    const daily=(await f.service.get(f.scope)).daily.scopes.find(s=>s.scope==='office')!;
    if(call.status==='fulfilled'){
      expect(daily.heldUsd).toBe(.5);
      const r=(await sql<{version:number}>`SELECT spending_policy_version AS version FROM hawa.design_studio_calls WHERE id=${call.value}::uuid`.execute(owner)).rows[0];expect(r.version).toBe(1);
    }else{expect(String(call.reason)).toContain('STUDIO_SCOPE_BUDGET_EXHAUSTED');expect(daily.heldUsd).toBe(0);}
    await expect(f.call()).rejects.toThrow('STUDIO_SCOPE_BUDGET_EXHAUSTED');
  }
});
it('applies client and role overrides to admission and restores defaults when they are removed',async()=>{
  const f=await fixture();
  await f.service.record(f.scope,randomUUID(),await f.body({clients:{[f.clientId]:.25}}));
  await expect(f.call()).rejects.toThrow('STUDIO_SCOPE_BUDGET_EXHAUSTED: client');
  await f.service.record(f.scope,randomUUID(),await f.body({clients:{},roles:{visual_judge:.25}}));
  await expect(f.call()).rejects.toThrow('STUDIO_SCOPE_BUDGET_EXHAUSTED: visual_judge');
  await f.service.record(f.scope,randomUUID(),await f.body({roles:{}}));
  expect(await f.call()).toMatch(/^[a-f0-9-]{36}$/);
});
it('requires current named authority, including replay, without trusting role text',async()=>{
  const f=await fixture(),body=await f.body(),action=randomUUID();
  await expect(f.service.record({...f.scope,sessionHash:undefined},action,body)).rejects.toMatchObject({status:403});
  await f.service.record(f.scope,action,body);
  await sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${f.scope.sessionHash}`.execute(owner);
  await expect(f.service.record(f.scope,action,body)).rejects.toMatchObject({status:403});expect((await f.service.get(f.scope)).canEdit).toBe(false);
  const g=await fixture();await sql`UPDATE hawa.tenant_memberships SET role='operator' WHERE tenant_id=${g.tenantId}::uuid AND user_id=${g.userId}::uuid`.execute(owner);
  expect((await g.service.get(g.scope)).canEdit).toBe(false);await expect(g.service.record(g.scope,randomUUID(),await g.body())).rejects.toMatchObject({status:403});
});
it('refuses foreign clients, foreign sessions, invalid limits and direct application table writes',async()=>{
  const f=await fixture(),g=await fixture(),body=await f.body({clients:{[g.clientId]:1}});
  await expect(f.service.record(f.scope,randomUUID(),body)).rejects.toMatchObject({status:400});
  await expect(f.service.record({...f.scope,tenantId:g.tenantId},randomUUID(),await g.body())).rejects.toMatchObject({status:403});
  await expect(f.tx(tx=>sql`INSERT INTO hawa.studio_spending_policies(tenant_id,version,reason,limits) VALUES(${f.tenantId}::uuid,2,'No authority','{}')`.execute(tx))).rejects.toThrow('permission denied');
  const direct=(user:string,session:string,b:unknown)=>f.tx(tx=>sql`SELECT hawa.record_spending_policy(${randomUUID()}::uuid,${user}::uuid,${session},${JSON.stringify(b)}::jsonb)`.execute(tx));
  await expect(direct(g.userId,g.scope.sessionHash,await f.body())).rejects.toThrow('SPENDING_POLICY_NAMED_ADMINISTRATOR_REQUIRED');
  await expect(direct(f.userId,'bad',await f.body())).rejects.toThrow('SPENDING_POLICY_NAMED_ADMINISTRATOR_REQUIRED');
  await expect(direct(f.userId,f.scope.sessionHash,{...await f.body(),limits:{...(await f.body()).limits,roleUsd:.0000001}})).rejects.toThrow('whole micro-dollars');
  await expect(direct(f.userId,f.scope.sessionHash,{...await f.body(),extra:true})).rejects.toThrow('SPENDING_POLICY_INVALID');
  expect((await f.service.get(f.scope)).current.version).toBe(1);
  await expect(db.transaction().setIsolationLevel('repeatable read').execute(tx=>withRlsContext(tx,f.scope,q=>
    sql`SELECT hawa.record_spending_policy(${randomUUID()}::uuid,${f.userId}::uuid,${f.scope.sessionHash},${JSON.stringify(body)}::jsonb)`.execute(q))))
    .rejects.toThrow('SPENDING_POLICY_INVALID');
});
it('paginates history without missing revisions and preserves owner provenance',async()=>{
  const f=await fixture();for(let i=0;i<21;i++)await f.service.record(f.scope,randomUUID(),await f.body({officeUsd:i}));
  const one=await f.service.get(f.scope),two=await f.service.get(f.scope,String(one.nextBeforeVersion));
  expect(one.history).toHaveLength(20);expect(two.history).toHaveLength(2);expect(two.nextBeforeVersion).toBeNull();
  expect(new Set([...one.history,...two.history].map(r=>r.version)).size).toBe(22);expect(two.history.at(-1)?.actorUserId).toBeNull();
  await expect(f.service.get(f.scope,'-1')).rejects.toMatchObject({status:400});
});
it('enforces named HTTP cookie CSRF and refuses a shared administrator key',async()=>{
  const f=await fixture(true),body=await f.body({officeUsd:25}),action=randomUUID(),csrf=hash(`${f.token}:csrf`);
  vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_ID','test-client');vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_SECRET','test-secret');
  vi.stubEnv('HAWA_GOOGLE_OIDC_REDIRECT_URI','https://desk.office.example/v1/auth/google/callback');vi.stubEnv('HAWA_GOOGLE_OIDC_HOSTED_DOMAINS','example.test');
  try{
    const options={db,skipPaidModelProbe:true,skipTelegramProbe:true,enableTelegramPolling:false};
    const path='/v1/spending/policy',headers={'Content-Type':'application/json','Idempotency-Key':action,Cookie:`hawa_session=${f.token}; hawa_csrf=${csrf}`,'x-hawa-csrf':csrf,Origin:'https://desk.office.example'};
    const request={method:'POST',headers,body:JSON.stringify(body)};
    const first=await createApp(options).request(path,request);expect(first.status,await first.clone().text()).toBe(200);
    const replay=await createApp(options).request(path,request);expect(await replay.json()).toMatchObject({replayed:true});
    expect((await createApp(options).request(path,{...request,headers:{...headers,Origin:'https://foreign.example'}})).status).toBe(403);
    expect((await createApp(options).request(path,{...request,headers:{'Content-Type':'application/json',Cookie:headers.Cookie}})).status).toBe(403);
    expect((await createApp({...options,testAuth:{principal:{role:'administrator',userId:f.userId}}}).request(path,{...request,headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()}})).status).toBe(403);
  }finally{vi.unstubAllEnvs();}
});
