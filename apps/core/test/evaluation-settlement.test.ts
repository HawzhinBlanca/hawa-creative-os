import {afterAll,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {createDb,sql,withRlsContext} from '@hawa/db';
import {FakeModelGateway} from '@hawa/testkit';
import {DurableEvaluationService} from '../src/services/durable-evaluations.js';
import {createApp} from '../src/app.js';

const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!);
const db=createDb(process.env.TEST_DATABASE_URL!);
afterAll(async()=>{await owner.destroy();await db.destroy();});
async function fixture(useOfficeTenant=false,observedCost:number|null=null){
  const tenantId=useOfficeTenant?'00000000-0000-4000-a000-000000000001':randomUUID(),userId=randomUUID(),token=`hawa_sess_${randomUUID().replaceAll('-','')}`,sessionHash=createHash('sha256').update(token).digest('hex');
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Settlement fixture',${tenantId}) ON CONFLICT(id) DO NOTHING`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${`${userId}@example.test`},'Named administrator',${userId})`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'administrator')`.execute(owner);
  await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES(${sessionHash},${tenantId}::uuid,${userId}::uuid,'oidc:fixture','administrator','Named administrator',now()+interval '1 hour','google_oidc')`.execute(owner);
  const scope={tenantId,userId,role:'administrator',sessionHash};
  const gateway=new FakeModelGateway(),call=vi.spyOn(gateway,'generateStructured');
  if(observedCost===null) call.mockRejectedValueOnce(new Error('synthetic lost response'));
  else call.mockResolvedValueOnce({ok:false,error:{code:'MODEL_OUTPUT_UNUSABLE',message:'Synthetic unusable response',retryable:false,safeAction:'Review saved call',
    detail:{acceptance:'response_received',requiresReconciliation:true,estimatedCostUsd:observedCost,costBasis:'usage'}}});
  const service=new DurableEvaluationService(db,gateway),input={actionId:randomUUID(),name:'Held fixture'};
  const run=await service.run(scope,input),detail=(await service.get(scope,run.runId))!;
  const body={expectedSnapshot:detail.snapshotHash,reason:'Provider support confirmed terminal outcome and charge',calls:detail.calls.map(c=>({
    callId:c.id,conclusion:'provider_finished',reportedCostUsd:0.125,evidenceReference:'support-case-123',evidenceSha256:'a'.repeat(64)}))};
  return {scope,gateway,call,service,input,run,detail,body,token};
}
it('closes a held run with immutable named evidence, preserves unknown original cost, and never sends on settlement or replay',async()=>{
  const f=await fixture(),action=randomUUID();
  expect(f.detail.daily.scopes.find(s=>s.scope==='office')).toMatchObject({spentUsd:0,heldUsd:.01,remainingUsd:29.99});
  const result=await f.service.settle(f.scope,f.run.runId,action,f.body);
  expect(result.replayed).toBe(false);expect(f.call).toHaveBeenCalledTimes(1);
  expect(await new DurableEvaluationService(db,f.gateway).settle(f.scope,f.run.runId,action,f.body)).toMatchObject({replayed:true,settlement:result.settlement});
  const after=(await f.service.get(f.scope,f.run.runId))!;
  expect(after.status).toBe('closed');expect(after.report).toEqual(f.run.report);expect(after.resumable).toBe(false);
  expect(after.calls[0]).toMatchObject({status:'uncertain',estimatedCostUsd:null});
  expect(after.settlement?.calls[0].reportedCostUsd).toBe(0.125);
  expect(after.daily.scopes.find(s=>s.scope==='office')).toMatchObject({spentUsd:.125,heldUsd:0,remainingUsd:29.875});
  expect((await f.service.run(f.scope,f.input)).status).toBe('closed');expect(f.call).toHaveBeenCalledTimes(1);
  await expect(f.service.settle(f.scope,f.run.runId,action,{...f.body,reason:'changed'})).rejects.toMatchObject({status:409});
  await expect(withRlsContext(db,f.scope,tx=>sql`DELETE FROM hawa.eval_run_settlements WHERE run_id=${f.run.runId}::uuid`.execute(tx))).rejects.toThrow();
  const next=await f.service.run(f.scope,{actionId:randomUUID(),name:'Explicit new work'});
  expect(next.status).toBe('completed');expect(next.runId).not.toBe(f.run.runId);
});
it('never erases a larger observed evaluation cost with a smaller administrator attestation',async()=>{
  const f=await fixture(false,.2);
  await f.service.settle(f.scope,f.run.runId,randomUUID(),f.body);
  const after=(await f.service.get(f.scope,f.run.runId))!;
  expect(after.daily.scopes.find(s=>s.scope==='office')).toMatchObject({spentUsd:.2,heldUsd:0,remainingUsd:29.8});
  expect(after.calls[0].estimatedCostUsd).toBe(.2);expect(after.settlement?.calls[0].reportedCostUsd).toBe(.125);
  expect(f.call).toHaveBeenCalledTimes(1);
});
it('supports named HTTP settlement after response loss and denies shared keys and CSRF-less writes',async()=>{
  const f=await fixture(true),action=randomUUID();
  const csrf=createHash('sha256').update(`${f.token}:csrf`).digest('hex');
  vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_ID','test-client');vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_SECRET','test-client-secret');
  vi.stubEnv('HAWA_GOOGLE_OIDC_REDIRECT_URI','https://desk.office.example/v1/auth/google/callback');vi.stubEnv('HAWA_GOOGLE_OIDC_HOSTED_DOMAINS','example.test');
  try{
    const options={db,evaluationGateway:f.gateway,skipPaidModelProbe:true,skipTelegramProbe:true,enableTelegramPolling:false};
    const app=createApp(options),path=`/v1/evaluations/runs/${f.run.runId}/settlement`;
    const headers={'Content-Type':'application/json','Idempotency-Key':action,Cookie:`hawa_session=${f.token}; hawa_csrf=${csrf}`,'x-hawa-csrf':csrf};
    const request={method:'POST',headers,body:JSON.stringify(f.body)};
    const first=await app.request(path,request);expect(first.status,await first.clone().text()).toBe(200);
    const receipt=await first.json();expect(receipt.replayed).toBe(false);
    const second=await createApp(options).request(path,request);expect(second.status).toBe(200);expect(await second.json()).toMatchObject({settlement:receipt.settlement,replayed:true});
    const shared=createApp({...options,testAuth:{principal:{role:'administrator',userId:f.scope.userId}}});
    expect((await shared.request(path,{...request,headers:{'Content-Type':'application/json','Idempotency-Key':action}})).status).toBe(403);
    expect((await app.request(path,{...request,headers:{'Content-Type':'application/json','Idempotency-Key':action,Cookie:headers.Cookie}})).status).toBe(403);
    expect(f.call).toHaveBeenCalledTimes(1);
  }finally{vi.unstubAllEnvs();}
});
it('serializes conflicting settlements and enforces append-only evidence and the closed-run fence in SQL',async()=>{
  const f=await fixture();
  const results=await Promise.allSettled([f.service.settle(f.scope,f.run.runId,randomUUID(),f.body),f.service.settle(f.scope,f.run.runId,randomUUID(),f.body)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await sql`SELECT id FROM hawa.eval_run_settlements WHERE run_id=${f.run.runId}::uuid`.execute(owner)).rows).toHaveLength(1);
  await expect(sql`UPDATE hawa.eval_run_settlements SET reason='Rewrite' WHERE run_id=${f.run.runId}::uuid`.execute(owner)).rejects.toThrow(/immutable/);
  await expect(withRlsContext(db,f.scope,tx=>sql`INSERT INTO hawa.eval_model_calls(tenant_id,run_id,ordinal,request_hash,role,deployment)
    VALUES(${f.scope.tenantId}::uuid,${f.run.runId}::uuid,2,${'b'.repeat(64)},'intake_router','{}'::jsonb)`.execute(tx))).rejects.toThrow(/Closed evaluation/);
  const other=await fixture();
  await expect(withRlsContext(db,other.scope,tx=>sql`INSERT INTO hawa.eval_run_settlements(tenant_id,run_id,action_id,actor_user_id,request_hash,snapshot_hash,reason,calls)
    VALUES(${other.scope.tenantId}::uuid,${other.run.runId}::uuid,${randomUUID()}::uuid,${other.scope.userId}::uuid,${'a'.repeat(64)},${'b'.repeat(64)},'Direct SQL','[]'::jsonb)`.execute(tx))).rejects.toThrow(/Named administrator/);
});
it('refuses missing/unknown cost, stale evidence and incomplete call coverage without releasing the hold',async()=>{
  const f=await fixture();
  for(const body of [{...f.body,calls:[]},{...f.body,expectedSnapshot:'b'.repeat(64)},
    {...f.body,calls:[{...f.body.calls[0],reportedCostUsd:null}]},
    {...f.body,calls:[{...f.body.calls[0],conclusion:'provider_not_accepted',reportedCostUsd:0.5}]},
    {...f.body,calls:[{...f.body.calls[0],callId:randomUUID()}]}]){
    await expect(f.service.settle(f.scope,f.run.runId,randomUUID(),body)).rejects.toThrow();
  }
  await expect(f.service.run(f.scope,{actionId:randomUUID(),name:'Bypass'})).rejects.toMatchObject({code:'EVALUATION_PRIOR_RUN_UNSETTLED'});
  expect(f.call).toHaveBeenCalledTimes(1);
});
it('checks current named authority, revocation and tenant isolation inside the settlement transaction',async()=>{
  const f=await fixture(),other=await fixture();
  await expect(f.service.settle({...f.scope,sessionHash:undefined},f.run.runId,randomUUID(),f.body)).rejects.toMatchObject({status:403});
  await expect(f.service.settle(other.scope,f.run.runId,randomUUID(),f.body)).rejects.toMatchObject({status:404});
  await sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${f.scope.sessionHash}`.execute(owner);
  await expect(f.service.settle(f.scope,f.run.runId,randomUUID(),f.body)).rejects.toMatchObject({status:403});
  expect((await f.service.get(f.scope,f.run.runId))?.canSettle).toBe(false);
});
it('refuses settlement while the evaluation transport is active',async()=>{
  const f=await fixture();await f.service.settle(f.scope,f.run.runId,randomUUID(),f.body);
  let release!:()=>void,entered!:()=>void;
  const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
  f.call.mockImplementationOnce(async()=>{entered();await wait;throw new Error('lost');});
  const running=f.service.run(f.scope,{actionId:randomUUID(),name:'Active'});await started;
  try{
    const rows=await f.service.list(f.scope),run=rows.at(-1)!;
    const detail=(await f.service.get(f.scope,run.runId))!;
    await expect(f.service.settle(f.scope,run.runId,randomUUID(),{...f.body,expectedSnapshot:detail.snapshotHash,
      calls:[{...f.body.calls[0],callId:detail.calls[0].id}]})).rejects.toMatchObject({code:'EVALUATION_BUSY'});
  }finally{release();await running;}
});
