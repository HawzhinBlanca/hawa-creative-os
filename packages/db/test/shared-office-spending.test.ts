import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';
import { DesignStudioRepository } from '../src/repositories/design-studio.repository.js';
import type { StudioDailyBudget } from '@hawa/domain';

const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!),runtime=createDb(process.env.TEST_DATABASE_URL!);
afterAll(async()=>{await owner.destroy();await runtime.destroy();});
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const defaults={officeUsd:30,clientUsd:30,roleUsd:30,clients:{},roles:{}};
async function fixture(limits:Partial<typeof defaults>={}) {
  const tenantId=randomUUID(),userId=randomUUID(),clientId=randomUUID(),otherClient=randomUUID();
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Shared budget fixture',${tenantId})`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${userId}::uuid,${userId+'@example.test'},'Synthetic operator')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'operator')`.execute(owner);
  const scope={tenantId,userId};
  const tx=<T>(fn:Parameters<typeof withRlsContext<T>>[2])=>withRlsContext(runtime,scope,fn);
  await withRlsContext(owner,scope,async q=>{
    for(const c of [clientId,otherClient])await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${c}::uuid,${tenantId}::uuid,${c},'Shared fixture')`.execute(q);
    await sql`INSERT INTO hawa.studio_spending_policies(tenant_id,version,reason,limits)
      VALUES(${tenantId}::uuid,2,'Synthetic shared limits',${JSON.stringify({...defaults,...limits})}::jsonb)`.execute(q);
  });
  const dataset=(await tx(q=>sql<{id:string}>`INSERT INTO hawa.eval_datasets(tenant_id,name,version,description,content_hash)
    VALUES(${tenantId}::uuid,'Shared fixture','1','Synthetic shared spending tests',${hash('fixture')}) RETURNING id`.execute(q))).rows[0].id;
  async function evalRun() {
    return (await tx(q=>sql<{id:string}>`INSERT INTO hawa.eval_runs(tenant_id,dataset_id,action_id,request_hash,actor_id,name,candidate,status)
      VALUES(${tenantId}::uuid,${dataset}::uuid,${randomUUID()}::uuid,${hash('run')},${userId}::uuid,'Shared fixture','{}','running') RETURNING id`.execute(q))).rows[0].id;
  }
  async function evaluation(usd:number,role='intake_router',connection=runtime) {
    const run=await evalRun(),requestHash=hash(randomUUID());
    const reservation={policy:'gateway-request-budget-v1',requestSha256:requestHash,usd};
    return (await withRlsContext(connection,scope,q=>sql<{id:string;started_at:Date;spending_policy_version:number}>`
      INSERT INTO hawa.eval_model_calls(tenant_id,run_id,ordinal,request_hash,role,deployment,budget_reservation,started_at)
      VALUES(${tenantId}::uuid,${run}::uuid,1,${requestHash},${role},'{}',${JSON.stringify(reservation)}::jsonb,'2000-01-01') RETURNING *`.execute(q))).rows[0];
  }
  async function voice(usd:number,cid=clientId,connection=runtime) {
    const sourceSha=hash(randomUUID()),sourceUpdateId=Math.floor(Math.random()*1e9),key=hash(`voice-v1:${cid}:${sourceSha}`);
    const upload={clientId:cid,blob:{sha256:sourceSha}};
    const payload={key,clientId:cid,sourceSha256:sourceSha,sourceUpdateId,estimatedMicrousd:Math.round(usd*1e6),day:'2000-01-01'};
    await tx(q=>sql`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
      VALUES(${tenantId}::uuid,'lifecycle_source_upload',${String(sourceUpdateId)},'lifecycle_source_upload',${JSON.stringify(upload)}::jsonb,${hash(JSON.stringify(upload))},true)`.execute(q));
    const insert=()=>withRlsContext(connection,scope,q=>sql<{id:string;received_at:Date;voice_reserved_usd:string;voice_budget_client_id:string}>`
      INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified,received_at)
      VALUES(${tenantId}::uuid,'lifecycle_voice_attempt',${key},'lifecycle_voice_attempt',${JSON.stringify(payload)}::jsonb,${hash(JSON.stringify(payload))},true,'2000-01-01')
      ON CONFLICT DO NOTHING RETURNING *`.execute(q));
    const row=(await insert()).rows[0];
    const finish=(providerOutcome:string)=>{
      const outcome={key,sourceSha256:sourceSha,actualUsd:null,result:{providerOutcome}};
      return tx(q=>sql`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
        VALUES(${tenantId}::uuid,'lifecycle_voice_outcome',${key},'lifecycle_voice_outcome',${JSON.stringify(outcome)}::jsonb,${hash(JSON.stringify(outcome))},true)`.execute(q));
    };
    return {row,insert,finish,payload,key};
  }
  async function studio(usd:number,cid=clientId) {
    const taskId=randomUUID(),runId=randomUUID(),id=randomUUID(),repo=new DesignStudioRepository(runtime);
    await tx(q=>sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${cid}::uuid,'Shared fixture')`.execute(q));
    await repo.createRun({id:runId,taskId,tenantId,clientId:cid,actorId:userId,requestKey:runId,requestHash:hash('studio'),request:{},tier:'premium',budget:{maxUsd:2,maxCalls:24,spentUsd:0,calls:0}});
    return repo.recordCallStart({id,runId,tenantId,actorId:userId,stage:'parity',provider:'openai',model:'synthetic',requestedModel:'synthetic',callOrdinal:null,logicalCallSha256:hash(id),
      reservation:{version:1,policy:'synthetic',requestSha256:hash(id),usd,inputTokens:100,outputTokens:100}});
  }
  const daily=async()=> (await tx(q=>sql<{daily:StudioDailyBudget}>`SELECT hawa.office_scope_budget() AS daily`.execute(q))).rows[0].daily;
  const finishEval=(id:string,cost:number|undefined,basis:string|undefined='usage')=>tx(q=>sql`UPDATE hawa.eval_model_calls
    SET status='completed',finished_at=now(),outcome=${JSON.stringify({ok:true,value:{usage:{estimatedCostUsd:cost,costBasis:basis}}})}::jsonb WHERE id=${id}::uuid`.execute(q));
  return {tenantId,userId,clientId,otherClient,scope,tx,evalRun,evaluation,voice,studio,daily,finishEval};
}
const office=(daily:StudioDailyBudget)=>daily.scopes.find(s=>s.scope==='office')!;
async function historical(table:'eval_model_calls'|'inbox_events',id:string,missing=false) {
  await owner.transaction().execute(async q=>{
    const triggers=table==='eval_model_calls'?['protect_eval_model_call','zz_enforce_evaluation_spending']:['enforce_voice_spending'];
    for(const t of triggers)await sql.raw(`ALTER TABLE hawa.${table} DISABLE TRIGGER ${t}`).execute(q);
    if(table==='eval_model_calls')await sql`UPDATE hawa.eval_model_calls SET started_at=now()-interval '2 days',budget_reservation=CASE WHEN ${missing} THEN NULL ELSE budget_reservation END WHERE id=${id}::uuid`.execute(q);
    else await sql`UPDATE hawa.inbox_events SET received_at=now()-interval '2 days' WHERE id=${id}::uuid`.execute(q);
    for(const t of triggers)await sql.raw(`ALTER TABLE hawa.${table} ENABLE TRIGGER ${t}`).execute(q);
  });
}

describe('shared office admission over original PostgreSQL ledgers',()=>{
  it('allows only one Studio/evaluation/voice admission for the same last office funds',async()=>{
    const f=await fixture({officeUsd:.01}),peer=createDb(process.env.TEST_DATABASE_URL!);
    try{
      const results=await Promise.allSettled([f.studio(.006),f.evaluation(.006,'intake_router',peer),f.voice(.006,f.otherClient)]);
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
      expect(results.filter(r=>r.status==='rejected')).toHaveLength(2);
      expect(office(await f.daily())).toMatchObject({heldUsd:.006,remainingUsd:.004,historyIncomplete:false});
    }finally{await peer.destroy();}
  });
  it('shares a role allowance across Studio and evaluations without inventing an evaluation client',async()=>{
    const f=await fixture({roleUsd:.01,clientUsd:.01});await f.studio(.006);
    await expect(f.evaluation(.006,'visual_judge')).rejects.toThrow('OFFICE_BUDGET_EXHAUSTED');
    await expect(f.evaluation(.006,'intake_router')).resolves.toBeDefined();
    await expect(f.voice(.006)).rejects.toThrow('OFFICE_BUDGET_EXHAUSTED');
    await expect(f.voice(.006,f.otherClient)).resolves.toBeDefined();
    expect((await f.daily()).scopes.some(s=>s.scope==='client')).toBe(false);
  });
  it('retains unknown evaluation and received-voice allocations across midnight and fresh connections',async()=>{
    const f=await fixture({officeUsd:.02}),e=await f.evaluation(.01),v=await f.voice(.006);
    await f.finishEval(e.id,undefined,'unknown');await v.finish('received');
    await historical('eval_model_calls',e.id);await historical('inbox_events',v.row.id);
    expect(office(await f.daily())).toMatchObject({spentUsd:0,heldUsd:.016,remainingUsd:.004});
    const peer=createDb(process.env.TEST_DATABASE_URL!);
    try{await expect(f.evaluation(.005,'intake_router',peer)).rejects.toThrow('OFFICE_BUDGET_EXHAUSTED');}
    finally{await peer.destroy();}
  });
  it('releases complete evaluation usage and definite voice rejections without discarding cost',async()=>{
    const f=await fixture({officeUsd:.02}),e=await f.evaluation(.01),v=await f.voice(.006);
    await f.finishEval(e.id,.003);await v.finish('rejected');
    expect(office(await f.daily())).toMatchObject({spentUsd:.003,heldUsd:0,remainingUsd:.017});
    await historical('eval_model_calls',e.id);
    expect(office(await f.daily())).toMatchObject({spentUsd:0,heldUsd:0,remainingUsd:.02});
  });
  it('retains a reported overrun and blocks paid work in the other paths',async()=>{
    const f=await fixture({officeUsd:.02}),e=await f.evaluation(.01);await f.finishEval(e.id,.03);
    expect(office(await f.daily())).toMatchObject({spentUsd:.03,remainingUsd:0});
    await expect(f.voice(.006)).rejects.toThrow('OFFICE_BUDGET_EXHAUSTED');
    await expect(f.studio(.006)).rejects.toMatchObject({code:'BUDGET_EXHAUSTED'});
  });
  it('does not invent historical evaluation usage or a missing reservation',async()=>{
    const f=await fixture(),e=await f.evaluation(.01);await f.finishEval(e.id,.001,'unknown');
    await historical('eval_model_calls',e.id,true);
    expect(office(await f.daily()).historyIncomplete).toBe(true);
    await expect(f.voice(.006)).rejects.toThrow('OFFICE_BUDGET_HISTORY_INCOMPLETE');
  });
  it('uses database timestamps and preserves an exact voice replay after the budget is exhausted',async()=>{
    const f=await fixture({officeUsd:.006}),v=await f.voice(.006);
    expect(new Date(v.row.received_at).getTime()).toBeGreaterThan(Date.now()-60_000);
    expect(v.row.voice_budget_client_id).toBe(f.clientId);expect(Number(v.row.voice_reserved_usd)).toBe(.006);
    expect((await v.insert()).rows).toEqual([]);expect(office(await f.daily()).heldUsd).toBe(.006);
  });
  it('refuses reservation edits, missing allowances, evidence deletion and forged voice identity',async()=>{
    const f=await fixture(),e=await f.evaluation(.01),v=await f.voice(.006);
    expect(e.spending_policy_version).toBe(2);expect(new Date(e.started_at).getTime()).toBeGreaterThan(Date.now()-60_000);
    await expect(f.tx(q=>sql`UPDATE hawa.eval_model_calls SET budget_reservation='{}',finished_at=now(),status='completed',outcome='{}' WHERE id=${e.id}::uuid`.execute(q))).rejects.toThrow('immutable');
    await expect(f.tx(q=>sql`DELETE FROM hawa.inbox_events WHERE id=${v.row.id}::uuid`.execute(q))).rejects.toThrow('immutable');
    await expect(f.tx(q=>sql`UPDATE hawa.inbox_events SET source_account_id='erased' WHERE id=${v.row.id}::uuid`.execute(q))).rejects.toThrow('immutable');
    const run=await f.evalRun();
    await expect(f.tx(q=>sql`INSERT INTO hawa.eval_model_calls(tenant_id,run_id,ordinal,request_hash,role,deployment)
      VALUES(${f.tenantId}::uuid,${run}::uuid,1,${hash('raw')},'intake_router','{}')`.execute(q))).rejects.toThrow('OFFICE_BUDGET_INVALID');
    await expect(f.tx(q=>sql`SELECT hawa.studio_scope_budget_internal(${f.tenantId}::uuid,NULL)`.execute(q))).rejects.toMatchObject({code:'42501'});
  });
  it('rejects unknown roles, stopped role allocations and stale transaction snapshots',async()=>{
    const f=await fixture({roles:{intake_router:0,voice_transcriber:0}});
    await expect(f.evaluation(.001)).rejects.toThrow('OFFICE_BUDGET_EXHAUSTED');
    await expect(f.voice(.006)).rejects.toThrow('OFFICE_BUDGET_EXHAUSTED');
    await expect(f.evaluation(.001,'invented_role')).rejects.toThrow('OFFICE_BUDGET_INVALID');
    await expect(runtime.transaction().setIsolationLevel('repeatable read').execute(q=>
      f.evaluation(.001,'visual_judge',q))).rejects.toThrow('OFFICE_BUDGET_INVALID');
    expect(office(await f.daily())).toMatchObject({spentUsd:0,heldUsd:0,remainingUsd:30});
  });
  it('rejects a foreign-client voice source and a changed replay without changing the original allocation',async()=>{
    const f=await fixture(),other=await fixture();
    await expect(f.voice(.006,other.clientId)).rejects.toThrow('retained client source');
    const v=await f.voice(.006),changed={...v.payload,estimatedMicrousd:1000};
    await expect(f.tx(q=>sql`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
      VALUES(${f.tenantId}::uuid,'lifecycle_voice_attempt',${v.key},'lifecycle_voice_attempt',${JSON.stringify(changed)}::jsonb,${hash(JSON.stringify(changed))},true)
      ON CONFLICT DO NOTHING`.execute(q))).rejects.toThrow('identity conflict');
    expect(office(await f.daily())).toMatchObject({spentUsd:0,heldUsd:.006,remainingUsd:29.994});
  });
  it('only releases an evaluation failure when non-acceptance and zero cost are explicit',async()=>{
    const f=await fixture(),certain=await f.evaluation(.01),unknown=await f.evaluation(.01);
    for(const [id,cost] of [[certain.id,0],[unknown.id,null]] as const){
      const outcome={ok:false,error:{detail:{acceptance:'not_accepted',requiresReconciliation:false,estimatedCostUsd:cost}}};
      await f.tx(q=>sql`UPDATE hawa.eval_model_calls SET status='completed',finished_at=now(),outcome=${JSON.stringify(outcome)}::jsonb WHERE id=${id}::uuid`.execute(q));
    }
    expect(office(await f.daily())).toMatchObject({spentUsd:0,heldUsd:.01,remainingUsd:29.99});
  });
});
