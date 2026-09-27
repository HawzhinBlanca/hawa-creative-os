import { afterAll,it,expect,vi } from 'vitest';
import { randomUUID,createHash } from 'node:crypto';
import { createDb,sql,withRlsContext,DesignStudioRepository,assertStudioCallsResolved } from '@hawa/db';
import { StudioCallSettlementService } from '../src/services/studio-call-settlement.js';
import { createApp } from '../src/app.js';

const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!),db=createDb(process.env.TEST_DATABASE_URL!);
afterAll(async()=>{await owner.destroy();await db.destroy();});
async function fixture(office=false,status:string|null='abandoned'){
  const tenantId=office?'00000000-0000-4000-a000-000000000001':randomUUID(),userId=randomUUID(),clientId=randomUUID(),taskId=randomUUID(),runId=randomUUID();
  const token=`hawa_sess_${randomUUID().replaceAll('-','')}`,sessionHash=createHash('sha256').update(token).digest('hex');
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Studio fixture',${tenantId}) ON CONFLICT DO NOTHING`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${userId+'@example.test'},'Named administrator',${userId})`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'administrator')`.execute(owner);
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Fixture client')`.execute(owner);
  await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Synthetic Studio recovery')`.execute(owner);
  await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES(${sessionHash},${tenantId}::uuid,${userId}::uuid,'oidc:fixture','administrator','Named administrator',now()+interval '1 hour','google_oidc')`.execute(owner);
  const scope={tenantId,userId,role:'administrator',sessionHash},repo=new DesignStudioRepository(owner);
  await repo.createRun({id:runId,tenantId,taskId,clientId,actorId:userId,requestKey:`run-${runId}`,requestHash:'a'.repeat(64),request:{},tier:'standard'});
  const callId=randomUUID();
  await repo.recordCallStart({id:callId,tenantId,runId,actorId:userId,stage:'briefing',provider:'openai',model:'synthetic',reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.5, inputTokens: 100, outputTokens: 100 }, requestedModel:'synthetic',callOrdinal:1,logicalCallSha256:'b'.repeat(64)});
  if(status) await repo.updateRunStatus(runId,tenantId,status as 'abandoned'|'transferred');
  const service=new StudioCallSettlementService(db),detail=await service.get(scope,taskId,runId);
  const body={expectedSnapshot:detail.snapshotHash,reason:'Provider confirmed final execution and charge',calls:[{callId,conclusion:'provider_finished',reportedCostUsd:0.125,evidenceReference:'support-case-123',evidenceSha256:'c'.repeat(64)}]};
  return {scope,repo,service,detail,body,token,taskId,runId,clientId,callId};
}
it('settles exact calls, preserves original outcomes and stopped run, survives a fresh service and releases only new work',async()=>{
  const f=await fixture(),action=randomUUID();
  const before=await f.repo.getRunById(f.runId,f.scope.tenantId);
  await expect(withRlsContext(db,f.scope,tx=>assertStudioCallsResolved(tx,f.scope.tenantId,f.taskId))).rejects.toMatchObject({code:'MODEL_CALL_UNCERTAIN'});
  const first=await f.service.settle(f.scope,f.taskId,f.runId,action,f.body);
  expect(first.replayed).toBe(false);
  expect(await new StudioCallSettlementService(db).settle(f.scope,f.taskId,f.runId,action,f.body)).toMatchObject({replayed:true,settlement:first.settlement});
  expect(await f.repo.getRunById(f.runId,f.scope.tenantId)).toEqual(before);
  expect(await f.repo.getCallsForRun(f.runId,f.scope.tenantId)).toMatchObject([{id:f.callId,status:'uncertain',finished_at:null}]);
  const after=await f.service.get(f.scope,f.taskId,f.runId);
  expect(after).toMatchObject({unresolvedCalls:0,canSettle:false,status:'abandoned'});
  expect(after.calls[0]).toMatchObject({status:'uncertain',estimatedCostUsd:null,settlement:{reportedCostUsd:0.125}});
  await expect(withRlsContext(db,f.scope,tx=>assertStudioCallsResolved(tx,f.scope.tenantId,f.taskId))).resolves.toBeUndefined();
  const request={id:randomUUID(),runId:f.runId,tenantId:f.scope.tenantId,actorId:f.scope.userId,stage:'briefing',provider:'openai',model:'test',reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.5, inputTokens: 100, outputTokens: 100 }, requestedModel:'test',callOrdinal:2,logicalCallSha256:'d'.repeat(64)};
  await expect(f.repo.recordCallStart(request)).rejects.toMatchObject({code:'TASK_GENERATION_BLOCKED'});
  const next=randomUUID();
  await f.repo.createRun({id:next,tenantId:f.scope.tenantId,taskId:f.taskId,clientId:f.clientId,actorId:f.scope.userId,requestKey:`new-${next}`,requestHash:'e'.repeat(64),request:{},tier:'standard'});
  await expect(f.repo.recordCallStart({...request,runId:next,callOrdinal:1})).resolves.toMatchObject({status:'uncertain'});
  await expect(withRlsContext(db,f.scope,tx=>assertStudioCallsResolved(tx,f.scope.tenantId,f.taskId))).rejects.toMatchObject({code:'MODEL_CALL_UNCERTAIN'});
  await f.repo.finalizeCall({id:f.callId,tenantId:f.scope.tenantId,status:'ok',inputTokens:10,outputTokens:2,usdEstimate:0.125,responseId:'late-synthetic-receipt'});
  expect((await f.service.get(f.scope,f.taskId,f.runId)).calls[0]).toMatchObject({status:'ok',responseId:'late-synthetic-receipt',settlement:{reportedCostUsd:0.125}});
});
it('rejects incomplete, stale, unknown-cost and changed keyed evidence; SQL keeps settlements immutable',async()=>{
  const f=await fixture(),action=randomUUID();
  for(const body of [{...f.body,calls:[]},{...f.body,expectedSnapshot:'f'.repeat(64)},
    {...f.body,calls:[{...f.body.calls[0],reportedCostUsd:null}]},
    {...f.body,calls:[{...f.body.calls[0],conclusion:'provider_not_accepted',reportedCostUsd:0.1}]},
    {...f.body,calls:[{...f.body.calls[0],callId:randomUUID()}]}]){
    await expect(f.service.settle(f.scope,f.taskId,f.runId,randomUUID(),body)).rejects.toThrow();
  }
  await f.service.settle(f.scope,f.taskId,f.runId,action,f.body);
  await expect(f.service.settle(f.scope,f.taskId,f.runId,action,{...f.body,reason:'changed'})).rejects.toMatchObject({code:'STUDIO_SETTLEMENT_ACTION_CONFLICT'});
  await expect(sql`UPDATE hawa.studio_run_settlements SET reason='changed' WHERE run_id=${f.runId}::uuid`.execute(owner)).rejects.toThrow(/immutable/);
  await expect(sql`DELETE FROM hawa.studio_run_settlements WHERE run_id=${f.runId}::uuid`.execute(owner)).rejects.toThrow(/immutable/);
});
it('rechecks named authority, revocation, task scope and tenant isolation',async()=>{
  const f=await fixture(),other=await fixture();
  await expect(f.service.settle({...f.scope,sessionHash:undefined},f.taskId,f.runId,randomUUID(),f.body)).rejects.toMatchObject({status:403});
  await expect(f.service.settle(other.scope,f.taskId,f.runId,randomUUID(),f.body)).rejects.toMatchObject({status:404});
  await expect(f.service.settle(f.scope,other.taskId,f.runId,randomUUID(),f.body)).rejects.toMatchObject({status:404});
  await sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${f.scope.sessionHash}`.execute(owner);
  await expect(f.service.settle(f.scope,f.taskId,f.runId,randomUUID(),f.body)).rejects.toMatchObject({status:403});
  expect((await f.service.get(f.scope,f.taskId,f.runId)).canSettle).toBe(false);
});
it('serializes competing evidence and refuses direct inserts without a named session',async()=>{
  const f=await fixture();
  await expect(withRlsContext(db,f.scope,tx=>sql`INSERT INTO hawa.studio_run_settlements
    (tenant_id,task_id,client_id,run_id,action_id,actor_user_id,request_hash,snapshot_hash,reason,calls)
    VALUES(${f.scope.tenantId}::uuid,${f.taskId}::uuid,${f.clientId}::uuid,${f.runId}::uuid,${randomUUID()}::uuid,${f.scope.userId}::uuid,
      ${'a'.repeat(64)},${f.body.expectedSnapshot},'Direct SQL',${JSON.stringify(f.body.calls)}::jsonb)`.execute(tx))).rejects.toThrow(/Named administrator/);
  const results=await Promise.allSettled([f.service.settle(f.scope,f.taskId,f.runId,randomUUID(),f.body),f.service.settle(f.scope,f.taskId,f.runId,randomUUID(),f.body)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await f.service.get(f.scope,f.taskId,f.runId)).settlements).toHaveLength(1);
});
it('supports named HTTP replay and refuses shared authority and missing CSRF',async()=>{
  const f=await fixture(true),action=randomUUID(),csrf=createHash('sha256').update(`${f.token}:csrf`).digest('hex');
  vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_ID','test-client');vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_SECRET','test-client-secret');
  vi.stubEnv('HAWA_GOOGLE_OIDC_REDIRECT_URI','https://desk.office.example/v1/auth/google/callback');vi.stubEnv('HAWA_GOOGLE_OIDC_HOSTED_DOMAINS','example.test');
  try {
    const options={db,skipPaidModelProbe:true,skipTelegramProbe:true,enableTelegramPolling:false};
    const path=`/v1/tasks/${f.taskId}/studio-recovery/${f.runId}/settlement`;
    const headers={'Content-Type':'application/json','Idempotency-Key':action,Cookie:`hawa_session=${f.token}; hawa_csrf=${csrf}`,'x-hawa-csrf':csrf};
    const request={method:'POST',headers,body:JSON.stringify(f.body)};
    const first=await createApp(options).request(path,request);expect(first.status,await first.clone().text()).toBe(200);
    const receipt=await first.json();
    const replay=await createApp(options).request(path,request);expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({replayed:true,settlement:receipt.settlement});
    expect((await createApp(options).request(path,{...request,headers:{'Content-Type':'application/json','Idempotency-Key':action,Cookie:headers.Cookie}})).status).toBe(403);
    expect((await createApp({...options,testAuth:{principal:{role:'administrator',userId:f.scope.userId}}}).request(path,
      {...request,headers:{'Content-Type':'application/json','Idempotency-Key':action}})).status).toBe(403);
  }finally{vi.unstubAllEnvs();}
});

it('requires a stopped run and refuses a changed receipt snapshot',async()=>{
  const f=await fixture(false,null);
  expect(f.detail).toMatchObject({canSettle:false,requiresStop:true});
  await expect(f.service.settle(f.scope,f.taskId,f.runId,randomUUID(),f.body)).rejects.toMatchObject({code:'STUDIO_RUN_MUST_STOP'});
  await f.repo.updateRunStatus(f.runId,f.scope.tenantId,'abandoned');
  await expect(f.service.settle(f.scope,f.taskId,f.runId,randomUUID(),f.body)).rejects.toMatchObject({code:'STUDIO_SNAPSHOT_CHANGED'});
});
it('scopes a transferred run settlement to exact calls, never its future parity requests',async()=>{
  const f=await fixture(false,'transferred');
  await f.service.settle(f.scope,f.taskId,f.runId,randomUUID(),f.body);
  const id=randomUUID();
  await f.repo.recordCallStart({id,runId:f.runId,tenantId:f.scope.tenantId,actorId:f.scope.userId,stage:'parity',provider:'openai',model:'synthetic',reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.5, inputTokens: 100, outputTokens: 100 }, requestedModel:'synthetic',callOrdinal:null,logicalCallSha256:'e'.repeat(64)});
  const detail=await f.service.get(f.scope,f.taskId,f.runId);
  expect(detail.unresolvedCalls).toBe(1);
  expect(detail.calls.find(c=>c.id===id)?.settlement).toBeNull();
  await f.service.settle(f.scope,f.taskId,f.runId,randomUUID(),{...f.body,expectedSnapshot:detail.snapshotHash,calls:[{...f.body.calls[0],callId:id}]});
  const after=await f.service.get(f.scope,f.taskId,f.runId);
  expect(after.settlements).toHaveLength(2);expect(after.unresolvedCalls).toBe(0);
  await expect(f.repo.recordCallStart({id:randomUUID(),runId:f.runId,tenantId:f.scope.tenantId,actorId:f.scope.userId,stage:'parity',provider:'openai',model:'synthetic',reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.5, inputTokens: 100, outputTokens: 100 }, requestedModel:'synthetic',callOrdinal:null,logicalCallSha256:'e'.repeat(64)}))
    .rejects.toMatchObject({code:'MODEL_CALL_ADMISSION_CONFLICT'});
});
it('SQL rejects unknown costs even for a named administrator bypassing application parsing',async()=>{
  const f=await fixture();
  await expect(withRlsContext(db,f.scope,async tx=>{
    await sql`SELECT set_config('hawa.studio_settlement_session_hash',${f.scope.sessionHash},true)`.execute(tx);
    await sql`INSERT INTO hawa.studio_run_settlements
      (tenant_id,task_id,client_id,run_id,action_id,actor_user_id,request_hash,snapshot_hash,reason,calls)
      VALUES(${f.scope.tenantId}::uuid,${f.taskId}::uuid,${f.clientId}::uuid,${f.runId}::uuid,${randomUUID()}::uuid,${f.scope.userId}::uuid,
        ${'a'.repeat(64)},${f.body.expectedSnapshot},'Direct named SQL',${JSON.stringify([{...f.body.calls[0],reportedCostUsd:null}])}::jsonb)`.execute(tx);
  })).rejects.toThrow(/Terminal provider evidence/);
});

it('counts exact-call settlement cost towards parity admission and never discounts it after a late reply',async()=>{
  const f=await fixture(false,'transferred');
  await f.service.settle(f.scope,f.taskId,f.runId,randomUUID(),{...f.body,calls:[{...f.body.calls[0],reportedCostUsd:6}]});
  const admit=()=>f.repo.recordCallStart({id:randomUUID(),runId:f.runId,tenantId:f.scope.tenantId,actorId:f.scope.userId,
    stage:'parity',provider:'openai',model:'synthetic',reservation: { version: 1 as const, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: 0.5, inputTokens: 100, outputTokens: 100 }, requestedModel:'synthetic',callOrdinal:null,logicalCallSha256:'f'.repeat(64)});
  await expect(admit()).rejects.toMatchObject({code:'STUDIO_BUDGET_RESERVATION_EXCEEDED'});
  expect(await f.repo.getBudgetUsage(f.runId,f.scope.tenantId,f.scope.userId))
    .toMatchObject({knownUsdEstimate:0,attestedAdditionalUsd:6,accountedUsd:6,unresolvedCalls:0});
  await f.repo.finalizeCall({id:f.callId,tenantId:f.scope.tenantId,inputTokens:1,outputTokens:1,usdEstimate:0.25,status:'ok'});
  await expect(admit()).rejects.toMatchObject({code:'STUDIO_BUDGET_RESERVATION_EXCEEDED'});
  expect(await f.repo.getBudgetUsage(f.runId,f.scope.tenantId,f.scope.userId))
    .toMatchObject({knownUsdEstimate:0.25,attestedAdditionalUsd:5.75,accountedUsd:6});
});
