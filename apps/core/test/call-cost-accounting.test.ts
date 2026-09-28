import { afterAll, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext, DesignStudioRepository, assertStudioCallsResolved } from '@hawa/db';
import { CallCostAccountingService } from '../src/services/call-cost-accounting.js';
import { StudioCallSettlementService } from '../src/services/studio-call-settlement.js';
import { createApp } from '../src/app.js';
import type { CallCostKind } from '@hawa/contracts';
const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!), db=createDb(process.env.TEST_DATABASE_URL!);
afterAll(async()=>{await db.destroy();await owner.destroy();});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(office=false) {
  const tenantId=office?'00000000-0000-4000-a000-000000000001':randomUUID(),userId=randomUUID(),clientId=randomUUID(),taskId=randomUUID(),runId=randomUUID();
  const token=`hawa_sess_${randomUUID().replaceAll('-','')}`,sessionHash=hash(token),scope={tenantId,userId,role:'administrator',sessionHash};
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Cost fixture',${tenantId}) ON CONFLICT DO NOTHING`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${userId+'@example.test'},'Named administrator',${userId})`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'administrator')`.execute(owner);
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Cost fixture')`.execute(owner);
  await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Cost fixture')`.execute(owner);
  await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES(${sessionHash},${tenantId}::uuid,${userId}::uuid,'oidc:cost-fixture','administrator','Named administrator',now()+interval '1 hour','google_oidc')`.execute(owner);
  const tx=<T>(fn:Parameters<typeof withRlsContext<T>>[2])=>withRlsContext(db,scope,fn);
  const repo=new DesignStudioRepository(db),service=new CallCostAccountingService(db);
  await repo.createRun({id:runId,tenantId,taskId,clientId,actorId:userId,requestKey:runId,requestHash:hash(runId),request:{},tier:'standard'});
  async function studio(finish=true) {
    const id=randomUUID();
    await repo.recordCallStart({id,tenantId,runId,actorId:userId,stage:'parity',provider:'openai',model:'synthetic',requestedModel:'synthetic',callOrdinal:null,logicalCallSha256:hash(id),
      reservation:{version:1,policy:'synthetic',requestSha256:hash(id),usd:.5,inputTokens:100,outputTokens:100}});
    if(finish) await repo.finalizeCall({id,tenantId,status:'ok',inputTokens:0,outputTokens:0,usdEstimate:.1,costBasis:'estimate',responseId:'synthetic-reply'});
    return id;
  }
  async function evaluation(outcome:unknown={ok:true,value:{usage:{costBasis:'unknown'},value:{privateAnswer:'must-not-leak'}}}) {
    const dataset=(await tx(q=>sql<{id:string}>`INSERT INTO hawa.eval_datasets(tenant_id,name,version,description,content_hash)
      VALUES(${tenantId}::uuid,${randomUUID()},'1','Accounting fixture',${hash('dataset')}) RETURNING id`.execute(q))).rows[0].id;
    const run=(await tx(q=>sql<{id:string}>`INSERT INTO hawa.eval_runs(tenant_id,dataset_id,candidate,status,action_id,request_hash,actor_id,name)
      VALUES(${tenantId}::uuid,${dataset}::uuid,'{}','running',${randomUUID()}::uuid,${hash('run')},${userId}::uuid,'Cost fixture') RETURNING id`.execute(q))).rows[0].id;
    const reservation={policy:'gateway-request-budget-v1',requestSha256:hash('request'),usd:.5};
    const id=(await tx(q=>sql<{id:string}>`INSERT INTO hawa.eval_model_calls(tenant_id,run_id,ordinal,request_hash,role,deployment,budget_reservation)
      VALUES(${tenantId}::uuid,${run}::uuid,1,${hash('request')},'intake_router','{}',${JSON.stringify(reservation)}::jsonb) RETURNING id`.execute(q))).rows[0].id;
    await tx(q=>sql`UPDATE hawa.eval_model_calls SET status='completed',finished_at=now(),outcome=${JSON.stringify(outcome)}::jsonb WHERE id=${id}::uuid`.execute(q));
    return id;
  }
  async function voice(finish=true) {
    const sourceSha=hash(randomUUID()),updateId=String(Math.floor(Math.random()*1e12)),key=hash(`voice-v1:${clientId}:${sourceSha}`);
    const upload={clientId,blob:{sha256:sourceSha}},attempt={key,clientId,sourceSha256:sourceSha,sourceUpdateId:updateId,estimatedMicrousd:6000,model:'whisper-1'};
    await tx(q=>sql`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
      VALUES(${tenantId}::uuid,'lifecycle_source_upload',${updateId},'lifecycle_source_upload',${JSON.stringify(upload)}::jsonb,${hash(JSON.stringify(upload))},true)`.execute(q));
    const id=(await tx(q=>sql<{id:string}>`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
      VALUES(${tenantId}::uuid,'lifecycle_voice_attempt',${key},'lifecycle_voice_attempt',${JSON.stringify(attempt)}::jsonb,${hash(JSON.stringify(attempt))},true) RETURNING id`.execute(q))).rows[0].id;
    if(finish){
      const outcome={key,sourceSha256:sourceSha,actualUsd:null,result:{providerOutcome:'received',transcript:'must-not-leak'}};
      await tx(q=>sql`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
        VALUES(${tenantId}::uuid,'lifecycle_voice_outcome',${key},'lifecycle_voice_outcome',${JSON.stringify(outcome)}::jsonb,${hash(JSON.stringify(outcome))},true)`.execute(q));
    }
    return id;
  }
  const body=async(kind:CallCostKind,id:string,cost=.125)=>({expectedSnapshot:(await service.get(scope,kind,id)).snapshotHash,reason:'Provider confirmed final billing',
    calls:[{callId:id,conclusion:'provider_finished' as const,reportedCostUsd:cost,evidenceReference:'synthetic-support-123',evidenceSha256:hash('evidence')}]});
  const daily=async()=> (await tx(q=>sql<{daily:{scopes:Array<{scope:string;heldUsd:number;spentUsd:number}>}}>`SELECT hawa.office_scope_budget() AS daily`.execute(q))).rows[0].daily.scopes.find(s=>s.scope==='office')!;
  return {tenantId,userId,clientId,taskId,runId,token,scope,tx,repo,service,studio,evaluation,voice,body,daily};
}

it('repairs completed Studio, unknown evaluation and received voice costs without changing original receipts',async()=>{
  const f=await fixture(),s=await f.studio(),e=await f.evaluation(),v=await f.voice();
  expect(await f.daily()).toMatchObject({spentUsd:.1,heldUsd:.906});
  const before=await f.repo.getCallsForRun(f.runId,f.tenantId);
  for(const [kind,id,cost] of [['studio',s,.125],['evaluation',e,.05],['voice',v,.003]] as const){
    expect(await f.service.get(f.scope,kind,id)).toMatchObject({requiresCostEvidence:true,canRecord:true,revision:0});
    const body=await f.body(kind,id,cost), action=randomUUID(),result=await f.service.record(f.scope,kind,id,action,body);
    expect(await new CallCostAccountingService(db).record(f.scope,kind,id,action,body)).toEqual({...result,replayed:true});
    expect(await f.service.get(f.scope,kind,id)).toMatchObject({requiresCostEvidence:false,revision:1,attestedCostUsd:cost});
  }
  expect(await f.daily()).toMatchObject({spentUsd:.178,heldUsd:0});
  expect((await f.repo.getBudgetUsage(f.runId,f.tenantId,f.userId))).toMatchObject({accountedUsd:.125,reservedAdditionalUsd:0});
  expect(await f.repo.getCallsForRun(f.runId,f.tenantId)).toEqual(before);
  const list=await f.service.list(f.scope);expect(list.items).toHaveLength(3);
  expect(JSON.stringify(list)).not.toContain('must-not-leak');
});
it('appends corrections while retaining higher costs and refusing false non-acceptance',async()=>{
  const f=await fixture(),id=await f.studio();
  await f.service.record(f.scope,'studio',id,randomUUID(),await f.body('studio',id,.2));
  await f.service.record(f.scope,'studio',id,randomUUID(),await f.body('studio',id,.05));
  expect(await f.service.get(f.scope,'studio',id)).toMatchObject({revision:2,attestedCostUsd:.2,accountedCostUsd:.2,evidenceConflict:true});
  expect(await f.daily()).toMatchObject({spentUsd:.2,heldUsd:0});
  const original=await f.body('studio',id,0),rejection={...original,calls:[{...original.calls[0],conclusion:'provider_not_accepted' as const}]};
  await expect(f.service.record(f.scope,'studio',id,randomUUID(),rejection)).rejects.toMatchObject({code:'CALL_COST_CONTRADICTORY_EVIDENCE'});
});
it('preserves the uncertain execution hold and invalidates a stale snapshot on a late first outcome',async()=>{
  const f=await fixture(),id=await f.studio(false),body=await f.body('studio',id,0);
  await f.service.record(f.scope,'studio',id,randomUUID(),{...body,calls:[{...body.calls[0],conclusion:'provider_not_accepted'}]});
  expect(await f.daily()).toMatchObject({spentUsd:0,heldUsd:0});
  await expect(withRlsContext(db,f.scope,tx=>assertStudioCallsResolved(tx,f.tenantId,f.taskId))).rejects.toMatchObject({code:'MODEL_CALL_UNCERTAIN'});
  expect(await f.repo.getBudgetUsage(f.runId,f.tenantId,f.userId)).toMatchObject({unresolvedCalls:1});
  const stale=await f.body('studio',id,.1);
  await f.repo.finalizeCall({id,tenantId:f.tenantId,status:'ok',inputTokens:1,outputTokens:1,usdEstimate:.7,costBasis:'usage',responseId:'late'});
  await expect(f.service.record(f.scope,'studio',id,randomUUID(),stale)).rejects.toMatchObject({code:'CALL_COST_SNAPSHOT_CHANGED'});
  expect(await f.service.get(f.scope,'studio',id)).toMatchObject({accountedCostUsd:.7,evidenceConflict:true});
  expect(await f.daily()).toMatchObject({spentUsd:.7,heldUsd:0});
  expect(await f.repo.getBudgetUsage(f.runId,f.tenantId,f.userId)).toMatchObject({blocker:'STUDIO_BUDGET_RESERVATION_EXCEEDED'});
});
it('serializes competing revisions and checks replay before the now-stale snapshot',async()=>{
  const f=await fixture(),id=await f.evaluation(),body=await f.body('evaluation',id),action=randomUUID();
  const results=await Promise.allSettled([f.service.record(f.scope,'evaluation',id,action,body),f.service.record(f.scope,'evaluation',id,randomUUID(),body)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(r=>r.status==='rejected')[0]).toMatchObject({reason:{code:'CALL_COST_SNAPSHOT_CHANGED'}});
  const fresh=await f.body('evaluation',id);await f.service.record(f.scope,'evaluation',id,'cccccccc-cccc-4ccc-8ccc-cccccccccccc',fresh);
  await expect(f.service.record(f.scope,'evaluation',id,'cccccccc-cccc-4ccc-8ccc-cccccccccccc',{...fresh,reason:'Changed'})).rejects.toMatchObject({code:'CALL_COST_ACTION_CONFLICT'});
});
it('enforces tenant boundaries, named active authority and immutable SQL evidence',async()=>{
  const f=await fixture(),other=await fixture(),id=await f.voice(),body=await f.body('voice',id,.003);
  await expect(f.service.get(other.scope,'voice',id)).rejects.toMatchObject({status:404});
  await expect(f.service.record({...f.scope,sessionHash:undefined},'voice',id,randomUUID(),body)).rejects.toMatchObject({status:403});
  const direct=(snapshot=body.expectedSnapshot)=>f.tx(tx=>sql`INSERT INTO hawa.call_cost_attestations(tenant_id,call_kind,call_id,revision,action_id,actor_user_id,request_hash,snapshot_hash,reason,conclusion,reported_cost_usd,evidence_reference,evidence_sha256)
    VALUES(${f.tenantId}::uuid,'voice',${id}::uuid,1,${randomUUID()}::uuid,${f.userId}::uuid,${hash('direct')},${snapshot},'Direct fixture','provider_finished',0,'synthetic',${hash('evidence')})`.execute(tx));
  await expect(direct()).rejects.toThrow('CALL_COST_NAMED_ADMINISTRATOR_REQUIRED');
  await f.service.record(f.scope,'voice',id,randomUUID(),body);
  for(const command of ['UPDATE hawa.call_cost_attestations SET reason=reason','DELETE FROM hawa.call_cost_attestations'])
    await expect(sql.raw(command).execute(owner)).rejects.toThrow('immutable');
  await sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${f.scope.sessionHash}`.execute(owner);
  await expect(f.service.record(f.scope,'voice',id,randomUUID(),body)).rejects.toMatchObject({status:403});
  expect((await f.service.get(f.scope,'voice',id)).canRecord).toBe(false);
});
it('serves named HTTP replay and refuses shared authority and missing CSRF',async()=>{
  const f=await fixture(true),id=await f.evaluation(),body=await f.body('evaluation',id),action=randomUUID(),csrf=hash(`${f.token}:csrf`);
  vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_ID','test-client');vi.stubEnv('HAWA_GOOGLE_OIDC_CLIENT_SECRET','test-client-secret');
  vi.stubEnv('HAWA_GOOGLE_OIDC_REDIRECT_URI','https://desk.office.example/v1/auth/google/callback');vi.stubEnv('HAWA_GOOGLE_OIDC_HOSTED_DOMAINS','example.test');
  try{
    const options={db,skipPaidModelProbe:true,skipTelegramProbe:true};
    const path=`/v1/spending/calls/evaluation/${id}/evidence`,headers={'Content-Type':'application/json','Idempotency-Key':action,Cookie:`hawa_session=${f.token}; hawa_csrf=${csrf}`,'x-hawa-csrf':csrf,Origin:'https://desk.office.example'};
    const request={method:'POST',headers,body:JSON.stringify(body)};
    const first=await createApp(options).request(path,request);expect(first.status,await first.clone().text()).toBe(200);
    const replay=await createApp(options).request(path,request);expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({replayed:true});
    expect((await createApp(options).request(path,{...request,headers:{...headers,Origin:'https://foreign.example'}})).status).toBe(403);
    expect((await createApp(options).request(path,{...request,headers:{'Content-Type':'application/json',Cookie:headers.Cookie}})).status).toBe(403);
    expect((await createApp({...options,testAuth:{principal:{role:'administrator',userId:f.userId}}}).request(path,{...request,headers:{'Content-Type':'application/json','Idempotency-Key':action}})).status).toBe(403);
  }finally{vi.unstubAllEnvs();}
});

it('releases prior-day allocations only after exact evidence for each source, including a lost voice reply',async()=>{
  const f=await fixture(),s=await f.studio(),e=await f.evaluation(),v=await f.voice(false);
  // Historical fixtures only: original production timestamps and outcomes remain immutable.
  await owner.transaction().execute(async tx=>{
    for(const [table,triggers,id,time] of [
      ['design_studio_calls',['immutable_design_studio_call','enforce_studio_scope_budget'],s,'started_at'],
      ['eval_model_calls',['protect_eval_model_call','zz_enforce_evaluation_spending'],e,'started_at'],
      ['inbox_events',['enforce_voice_spending'],v,'received_at'],
    ] as const){
      for(const trigger of triggers) await sql.raw(`ALTER TABLE hawa.${table} DISABLE TRIGGER ${trigger}`).execute(tx);
      await sql.raw(`UPDATE hawa.${table} SET ${time}=now()-interval '2 days' WHERE id='${id}'`).execute(tx);
      for(const trigger of triggers) await sql.raw(`ALTER TABLE hawa.${table} ENABLE TRIGGER ${trigger}`).execute(tx);
    }
  });
  expect(await f.daily()).toMatchObject({spentUsd:0,heldUsd:1.006});
  await f.service.record(f.scope,'evaluation',e,randomUUID(),await f.body('evaluation',e,.01));
  expect(await f.daily()).toMatchObject({spentUsd:0,heldUsd:.506});
  await f.service.record(f.scope,'voice',v,randomUUID(),await f.body('voice',v,.003));
  await f.service.record(f.scope,'studio',s,randomUUID(),await f.body('studio',s,.125));
  expect(await f.daily()).toMatchObject({spentUsd:0,heldUsd:0});
  expect((await f.service.get(f.scope,'voice',v)).status).toBe('uncertain');
});

it('SQL independently refuses stale snapshots, foreign targets and role downgrade',async()=>{
  const f=await fixture(),other=await fixture(),id=await f.evaluation(),foreign=await other.evaluation();
  const insert=(callId:string,snapshot:string)=>f.tx(async tx=>{
    await sql`SELECT set_config('hawa.call_cost_session_hash',${f.scope.sessionHash},true)`.execute(tx);
    return sql`INSERT INTO hawa.call_cost_attestations(tenant_id,call_kind,call_id,revision,action_id,actor_user_id,request_hash,snapshot_hash,reason,conclusion,reported_cost_usd,evidence_reference,evidence_sha256)
      VALUES(${f.tenantId}::uuid,'evaluation',${callId}::uuid,1,${randomUUID()}::uuid,${f.userId}::uuid,${hash('direct')},${snapshot},'Direct SQL control','provider_finished',0,'synthetic',${hash('evidence')})`.execute(tx);
  });
  await expect(insert(id,'f'.repeat(64))).rejects.toThrow('CALL_COST_SNAPSHOT_CHANGED');
  await expect(insert(foreign,(await other.service.get(other.scope,'evaluation',foreign)).snapshotHash)).rejects.toThrow('CALL_COST_NOT_FOUND');
  const body=await f.body('evaluation',id);
  await sql`UPDATE hawa.tenant_memberships SET role='operator' WHERE tenant_id=${f.tenantId}::uuid AND user_id=${f.userId}::uuid`.execute(owner);
  await expect(f.service.record(f.scope,'evaluation',id,randomUUID(),body)).rejects.toMatchObject({status:403});
  expect((await f.service.get(f.scope,'evaluation',id)).canRecord).toBe(false);
});

it('paginates equal-time calls without omitting or repeating IDs and rejects malformed cursors',async()=>{
  const f=await fixture(),ids=[];
  for(let i=0;i<52;i++) ids.push(await f.voice());
  await owner.transaction().execute(async tx=>{
    await sql`ALTER TABLE hawa.inbox_events DISABLE TRIGGER enforce_voice_spending`.execute(tx);
    await sql`UPDATE hawa.inbox_events SET received_at='2000-01-01' WHERE tenant_id=${f.tenantId}::uuid AND source_account_id='lifecycle_voice_attempt'`.execute(tx);
    await sql`ALTER TABLE hawa.inbox_events ENABLE TRIGGER enforce_voice_spending`.execute(tx);
  });
  const first=await f.service.list(f.scope);expect(first.items).toHaveLength(50);expect(first.nextCursor).toBeTruthy();
  const second=await f.service.list(f.scope,first.nextCursor!);expect(second.items).toHaveLength(2);expect(second.nextCursor).toBeNull();
  expect([...first.items,...second.items].map(c=>c.id).sort()).toEqual(ids.sort());
  await expect(f.service.list(f.scope,'invalid')).rejects.toMatchObject({status:400});
});

it('retains attributed run costs for a designer without granting office accounting access',async()=>{
  const f=await fixture(),id=await f.studio();
  await f.service.record(f.scope,'studio',id,randomUUID(),await f.body('studio',id,.2));
  await sql`UPDATE hawa.tenant_memberships SET role='designer' WHERE tenant_id=${f.tenantId}::uuid AND user_id=${f.userId}::uuid`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${f.tenantId}::uuid,${f.clientId}::uuid,${f.userId}::uuid,'designer')`.execute(owner);
  expect(await f.repo.getBudgetUsage(f.runId,f.tenantId,f.userId)).toMatchObject({accountedUsd:.2,reservedAdditionalUsd:0});
  await expect(f.service.get(f.scope,'studio',id)).rejects.toThrow('CALL_COST_FORBIDDEN');
});

it('does not relabel a schema-invalid provider response as a non-accepted request',async()=>{
  const f=await fixture(),id=await f.evaluation({ok:false,error:{code:'MODEL_RESPONSE_SCHEMA_INVALID',detail:{acceptance:'response_received',estimatedCostUsd:null}}});
  const input=await f.body('evaluation',id,0);
  expect(await f.service.get(f.scope,'evaluation',id)).toMatchObject({originalCostUsd:null,originalAccepted:true,requiresCostEvidence:true});
  await expect(f.service.record(f.scope,'evaluation',id,randomUUID(),{...input,calls:[{...input.calls[0],conclusion:'provider_not_accepted'}]}))
    .rejects.toMatchObject({code:'CALL_COST_CONTRADICTORY_EVIDENCE'});
  const errored=await f.evaluation({ok:false,error:{code:'MODEL_RESPONSE_SCHEMA_INVALID',detail:{acceptance:'response_received',estimatedCostUsd:0,costBasis:'usage',requiresReconciliation:true}}});
  expect(await f.service.get(f.scope,'evaluation',errored)).toMatchObject({originalAccepted:true,requiresCostEvidence:true});
});

it('counts a prior run settlement once and resolves the current conflict only with matching higher evidence',async()=>{
  const f=await fixture(),id=await f.studio(false),recovery=new StudioCallSettlementService(db);
  await f.repo.updateRunStatus(f.runId,f.tenantId,'abandoned');
  const prior=await recovery.get(f.scope,f.taskId,f.runId),body=await f.body('studio',id,.3);
  await recovery.settle(f.scope,f.taskId,f.runId,randomUUID(),{...body,expectedSnapshot:prior.snapshotHash});
  await f.service.record(f.scope,'studio',id,randomUUID(),await f.body('studio',id,.1));
  expect(await f.service.get(f.scope,'studio',id)).toMatchObject({settledCostUsd:.3,attestedCostUsd:.1,accountedCostUsd:.3,evidenceConflict:true});
  await f.service.record(f.scope,'studio',id,randomUUID(),await f.body('studio',id,.3));
  expect(await f.service.get(f.scope,'studio',id)).toMatchObject({revision:2,accountedCostUsd:.3,evidenceConflict:false,attestations:expect.any(Array)});
  expect(await f.daily()).toMatchObject({spentUsd:.3,heldUsd:0});
});
