import { afterAll, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext, DesignStudioRepository } from '@hawa/db';
import { PaidModelProbeService } from '../src/services/paid-model-probe.js';
import { CallCostAccountingService } from '../src/services/call-cost-accounting.js';
import { reserveStudioText } from '@hawa/creative';
const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!), db=createDb(process.env.TEST_DATABASE_URL!);
afterAll(async()=>{await db.destroy();await owner.destroy();});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'), model='gpt-4.1-mini', key='synthetic-probe-key';
const good=()=>new Response(JSON.stringify({id:'probe-response-1',model,choices:[{}],usage:{prompt_tokens:7,completion_tokens:1,total_tokens:8}}),
  {status:200,headers:{'x-request-id':'provider-request-1'}});
async function fixture() {
  const tenantId=randomUUID(),userId=randomUUID(),clientId=randomUUID(),taskId=randomUUID(),runId=randomUUID();
  const scope={tenantId,userId,role:'administrator',sessionHash:hash(randomUUID())};
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Probe fixture',${tenantId})`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${userId+'@example.test'},'Probe administrator',${userId})`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'administrator')`.execute(owner);
  await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'Probe fixture')`.execute(owner);
  await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Probe fixture')`.execute(owner);
  await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES(${scope.sessionHash},${tenantId}::uuid,${userId}::uuid,'oidc:probe','administrator','Probe administrator',now()+interval '1 hour','google_oidc')`.execute(owner);
  const tx=<T>(fn:Parameters<typeof withRlsContext<T>>[2])=>withRlsContext(db,scope,fn);
  const calls=async()=> (await tx(q=>sql<{id:string;status:string;cost_usd:string|null;reconciliation_required:boolean;model:string;reservation:{usd:number};response_id:string|null;started_at:Date;acceptance:string|null;cost_basis:string|null}>`
    SELECT * FROM hawa.paid_model_probe_calls WHERE tenant_id=${tenantId}::uuid ORDER BY started_at,id`.execute(q))).rows;
  const daily=async()=> (await tx(q=>sql<{daily:{scopes:Array<{scope:string;subject:string;heldUsd:number;spentUsd:number}>}}>`SELECT hawa.office_scope_budget() AS daily`.execute(q))).rows[0].daily.scopes.find(s=>s.scope==='office')!;
  const policy=async(officeUsd=100,roles:Record<string,number>={})=>{
    await sql`INSERT INTO hawa.studio_spending_policies(tenant_id,version,reason,limits)
      SELECT ${tenantId}::uuid,coalesce(max(version),0)+1,'Synthetic test policy',${JSON.stringify({officeUsd,clientUsd:100,roleUsd:100,clients:{},roles})}::jsonb
      FROM hawa.studio_spending_policies WHERE tenant_id=${tenantId}::uuid`.execute(owner);
  };
  const age=async(days=0)=>owner.transaction().execute(async q=>{
    await sql`ALTER TABLE hawa.paid_model_probe_calls DISABLE TRIGGER enforce_paid_probe`.execute(q);
    await sql`UPDATE hawa.paid_model_probe_calls SET started_at=now()-make_interval(secs=>${days?days*86400:3600}) WHERE tenant_id=${tenantId}::uuid`.execute(q);
    await sql`ALTER TABLE hawa.paid_model_probe_calls ENABLE TRIGGER enforce_paid_probe`.execute(q);
  });
  const accounting=new CallCostAccountingService(db);
  const attest=async(id:string,cost=0,conclusion:'provider_finished'|'provider_not_accepted'='provider_finished')=>{
    const body={expectedSnapshot:(await accounting.get(scope,'health_probe',id)).snapshotHash,reason:'Synthetic terminal provider confirmation',
      calls:[{callId:id,conclusion,reportedCostUsd:cost,evidenceReference:'synthetic-proof',evidenceSha256:hash('evidence')}]};
    return accounting.record(scope,'health_probe',id,randomUUID(),body);
  };
  await policy();
  return {tenantId,userId,clientId,taskId,runId,scope,tx,calls,daily,policy,age,accounting,attest};
}

it('admits once across concurrent and restarted schedulers; binds exact request bytes and real receipt metadata',async()=>{
  const f=await fixture();let finish!:()=>void;
  const pending=new Promise<void>(resolve=>{finish=resolve;});
  const fetcher=vi.fn(async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const rows=await f.calls();expect(rows).toHaveLength(1);expect(rows[0].status).toBe('started');
    expect((rows[0].reservation as {requestSha256?:string}).requestSha256).toBe(hash(String(init!.body)));
    expect(await f.daily()).toMatchObject({spentUsd:0,heldUsd:rows[0].reservation.usd});
    await pending;return good();
  });
  const first=new PaidModelProbeService(db,fetcher).execute(f.scope,key,model,300000);
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
  expect(await new PaidModelProbeService(db,fetcher).execute(f.scope,key,model,300000)).toMatchObject({dispatched:false,status:'reconciliation_required'});
  finish();expect(await first).toMatchObject({dispatched:true,status:'connected'});
  expect(await new PaidModelProbeService(db,fetcher).execute(f.scope,key+'changed',model,300000)).toMatchObject({dispatched:false,status:'not_due'});
  expect(fetcher).toHaveBeenCalledTimes(1);
  const call=(await f.calls())[0];
  expect(await f.accounting.get(f.scope,'health_probe',call.id)).toMatchObject({providerRequestId:'provider-request-1',responseId:'probe-response-1',
    costBasis:'usage',originalCostUsd:.000005,requiresCostEvidence:false,originalAccepted:true});
  expect(await f.daily()).toMatchObject({spentUsd:.000005,heldUsd:0});
  expect((await f.accounting.list(f.scope)).items.map(c=>c.kind)).toEqual(['health_probe']);
});

it.each(['office','role'] as const)('stops at the shared %s zero limit before transport',async(kind)=>{
  const f=await fixture(),fetcher=vi.fn(async()=>good()),service=new PaidModelProbeService(db,fetcher);
  await f.policy(kind==='office'?0:100,kind==='role'?{health_probe:0}:{});
  expect(await service.execute(f.scope,key,model,300000)).toMatchObject({status:'budget_held',dispatched:false});
  expect(await service.admissionHealth(f.scope,key,model)).toMatchObject({spendingStatus:'budget_held'});
  expect(fetcher).not.toHaveBeenCalled();expect(await f.calls()).toHaveLength(0);
});

it.each([408,500,503])('retains uncertain HTTP %s across restart, changed credentials and midnight',async(status)=>{
  const f=await fixture(),fetcher=vi.fn(async()=>new Response('{}',{status})),service=new PaidModelProbeService(db,fetcher);
  expect(await service.execute(f.scope,key,model,300000)).toMatchObject({status:'http_error',dispatched:true});
  const call=(await f.calls())[0];expect(call).toMatchObject({cost_usd:null,reconciliation_required:true,acceptance:'unknown'});
  await f.age(2);
  const restarted=new PaidModelProbeService(db,fetcher);
  expect(await restarted.execute(f.scope,key+'changed','gpt-4o-mini',300000)).toMatchObject({dispatched:false,status:'reconciliation_required'});
  expect(await restarted.admissionHealth(f.scope,key+'changed','gpt-4o-mini')).toMatchObject({spendingStatus:'reconciliation_required',callId:call.id});
  expect(await f.daily()).toMatchObject({heldUsd:call.reservation.usd,spentUsd:0});expect(fetcher).toHaveBeenCalledTimes(1);
  await f.attest(call.id,.002);expect(await f.daily()).toMatchObject({heldUsd:0,spentUsd:0});
  expect(await restarted.execute(f.scope,key,model,300000)).toMatchObject({dispatched:true});
  expect(fetcher).toHaveBeenCalledTimes(2);expect((await f.calls())[0]).toEqual({...call,started_at:(await f.calls())[0].started_at});
});

it.each([
  ['missing usage',{id:'actual',model,choices:[{}]}],
  ['empty choices',{id:'actual',model,choices:[],usage:{prompt_tokens:7,completion_tokens:1,total_tokens:8}}],
  ['inconsistent usage',{id:'actual',model,choices:[{}],usage:{prompt_tokens:7,completion_tokens:1,total_tokens:999}}],
  ['changed model',{id:'actual',model:'gpt-4o-mini',choices:[{}],usage:{prompt_tokens:7,completion_tokens:1,total_tokens:8}}],
  ['unpriced model',{id:'actual',model:'unexpected',choices:[{}],usage:{prompt_tokens:7,completion_tokens:1,total_tokens:8}}],
  ['output overrun',{id:'actual',model,choices:[{}],usage:{prompt_tokens:7,completion_tokens:2,total_tokens:9}}],
  ['missing receipt ID',{model,choices:[{}],usage:{prompt_tokens:7,completion_tokens:1,total_tokens:8}}],
] as const)('holds a paid success with %s and refuses fabricated non-acceptance',async(_name,body)=>{
  const f=await fixture(),fetcher=vi.fn(async()=>new Response(JSON.stringify(body))),service=new PaidModelProbeService(db,fetcher);
  expect(await service.execute(f.scope,key,model,300000)).toMatchObject({status:'http_error'});
  const call=(await f.calls())[0];expect(call.reconciliation_required).toBe(true);expect(call.acceptance).toBe('response_received');
  expect(await service.execute(f.scope,key,model,300000)).toMatchObject({dispatched:false});expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(f.attest(call.id,0,'provider_not_accepted')).rejects.toMatchObject({code:'CALL_COST_CONTRADICTORY_EVIDENCE'});
});

it.each([400,401,403,422,429])('records definite HTTP %s refusal as zero, without charging or replaying it',async(status)=>{
  const f=await fixture(),fetcher=vi.fn(async()=>new Response(JSON.stringify({error:{type:'insufficient_quota'}}),{status}));
  await new PaidModelProbeService(db,fetcher).execute(f.scope,key,model,300000);
  expect((await f.calls())[0]).toMatchObject({cost_usd:'0',cost_basis:'not_accepted',reconciliation_required:false});
  expect(await f.daily()).toMatchObject({heldUsd:0,spentUsd:0});
  expect(await new PaidModelProbeService(db,fetcher).execute(f.scope,key,model,300000)).toMatchObject({status:'not_due'});
});

it('records timeout without leaking error text, retains its hold and requires named authority to resolve it',async()=>{
  const f=await fixture(),foreign=await fixture(),fetcher=vi.fn(async()=>{throw new Error('credential-and-body-must-not-leak');});
  expect(await new PaidModelProbeService(db,fetcher).execute(f.scope,key,model,300000)).toMatchObject({status:'unreachable'});
  const call=(await f.calls())[0],evidence=await f.accounting.get(f.scope,'health_probe',call.id);
  expect(JSON.stringify(evidence)).not.toContain('credential-and-body');expect(evidence.originalCostUsd).toBeNull();
  await expect(f.accounting.get(foreign.scope,'health_probe',call.id)).rejects.toMatchObject({status:404});
  await expect(f.accounting.record({...f.scope,sessionHash:undefined},'health_probe',call.id,randomUUID(),{
    expectedSnapshot:evidence.snapshotHash,reason:'No authority',calls:[{callId:call.id,conclusion:'provider_not_accepted',reportedCostUsd:0,evidenceReference:'synthetic',evidenceSha256:hash('evidence')}]
  })).rejects.toMatchObject({status:403});
  await f.attest(call.id,0,'provider_not_accepted');
  expect(await new PaidModelProbeService(db,fetcher).execute(f.scope,key,model,300000)).toMatchObject({status:'not_due'});
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('stops before transport when DB admission fails or pricing is unavailable',async()=>{
  const f=await fixture(),fetcher=vi.fn(async()=>good()),service=new PaidModelProbeService(db,fetcher);
  expect(await service.execute(f.scope,key,'unpriced',300000)).toMatchObject({status:'unquotable',dispatched:false});
  await expect(service.execute({...f.scope,tenantId:randomUUID()},key,model,300000)).rejects.toThrow();
  await expect(service.execute(f.scope,key,model,1)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it('preserves admission after a successful provider response followed by failed outcome persistence',async()=>{
  const f=await fixture(),fetcher=vi.fn(async()=>good()),service=new PaidModelProbeService(db,fetcher);
  // Force the final observation INSERT to fail. The outcome UPDATE must roll back with it.
  await sql.raw(`CREATE FUNCTION hawa.probe_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.tenant_id='${f.tenantId}'::uuid THEN RAISE EXCEPTION 'synthetic persistence failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER probe_fixture_fail BEFORE INSERT ON hawa.paid_model_health_observations FOR EACH ROW EXECUTE FUNCTION hawa.probe_fixture_fail();`).execute(owner);
  try { await expect(service.execute(f.scope,key,model,300000)).rejects.toThrow('synthetic persistence failure'); }
  finally {await sql.raw('DROP TRIGGER probe_fixture_fail ON hawa.paid_model_health_observations; DROP FUNCTION hawa.probe_fixture_fail();').execute(owner);}
  expect((await f.calls())[0]).toMatchObject({status:'started',cost_usd:null,reconciliation_required:true});
  expect(await new PaidModelProbeService(db,fetcher).execute(f.scope,key,model,300000)).toMatchObject({status:'reconciliation_required',dispatched:false});
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('retains a committed start with no provider result and protects identity/outcomes from runtime mutation',async()=>{
  const f=await fixture(),body=JSON.stringify({model,messages:[{role:'user',content:'ping'}],response_format:{type:'text'},max_completion_tokens:1,service_tier:'default'});
  const reserve=reserveStudioText(body),id=randomUUID();
  await f.tx(q=>sql`INSERT INTO hawa.paid_model_probe_calls(id,tenant_id,config_sha256,model,interval_ms,reservation,spending_policy_version)
    VALUES(${id}::uuid,${f.tenantId}::uuid,${hash(key)},${model},300000,${JSON.stringify(reserve)}::jsonb,1)`.execute(q));
  const fetcher=vi.fn(async()=>good());
  expect(await new PaidModelProbeService(db,fetcher).execute(f.scope,key,model,300000)).toMatchObject({status:'reconciliation_required'});
  await expect(f.tx(q=>sql`UPDATE hawa.paid_model_probe_calls SET model='changed' WHERE id=${id}::uuid`.execute(q))).rejects.toThrow('immutable');
  await expect(f.tx(q=>sql`DELETE FROM hawa.paid_model_probe_calls WHERE id=${id}::uuid`.execute(q))).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it('shares the office allowance in both directions with Studio and preserves observed overruns',async()=>{
  const f=await fixture(),repo=new DesignStudioRepository(db);
  await repo.createRun({id:f.runId,tenantId:f.tenantId,taskId:f.taskId,clientId:f.clientId,actorId:f.userId,requestKey:f.runId,requestHash:hash(f.runId),request:{},tier:'standard'});
  const studio=async(id:string,usd:number)=>repo.recordCallStart({id,tenantId:f.tenantId,runId:f.runId,actorId:f.userId,stage:'parity',provider:'openai',model:'synthetic',requestedModel:'synthetic',callOrdinal:null,logicalCallSha256:hash(id),
    reservation:{version:1,policy:'synthetic',requestSha256:hash(id),usd,inputTokens:10,outputTokens:10}});
  await f.policy(.5);const id=randomUUID();await studio(id,.5);
  const fetcher=vi.fn(async()=>good()),service=new PaidModelProbeService(db,fetcher);
  expect(await service.execute(f.scope,key,model,300000)).toMatchObject({status:'budget_held'});expect(fetcher).not.toHaveBeenCalled();
  await repo.finalizeCall({id,tenantId:f.tenantId,status:'ok',usdEstimate:.4,inputTokens:1,outputTokens:1,costBasis:'usage'});
  const overrun=new PaidModelProbeService(db,async()=>new Response(JSON.stringify({id:'overrun',model,choices:[{}],usage:{prompt_tokens:1_000_000,completion_tokens:1,total_tokens:1_000_001}})));
  await overrun.execute(f.scope,key,model,300000);
  expect((await f.daily()).spentUsd).toBeGreaterThan(.8);
  await expect(studio(randomUUID(),.01)).rejects.toThrow(/exhausted|allowance/i);
  const probe=(await f.calls())[0];await f.attest(probe.id,.01);
  expect((await f.daily()).spentUsd).toBeGreaterThan(.8);
  expect(await f.accounting.get(f.scope,'health_probe',probe.id)).toMatchObject({evidenceConflict:true});
});

it.each(['after-send','after-response-before-save','after-save'])('survives actual SIGKILL %s without another provider request',async boundary=>{
  const f=await fixture();let accepted=0,notify!:()=>void,response:ServerResponse|undefined;
  const received=new Promise<void>(resolve=>{notify=resolve;});
  const server=createServer((request,res)=>{request.resume();request.on('end',()=>{accepted++;response=res;notify();});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('Local port unavailable');
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/paid-probe-kill-child.ts',import.meta.url))],{
    cwd:process.cwd(),env:{...process.env,HAWA_PROBE_DRILL_DB:process.env.TEST_DATABASE_URL!,HAWA_PROBE_DRILL_PORT:String(address.port),
      HAWA_PROBE_DRILL_TENANT:f.tenantId,HAWA_PROBE_DRILL_USER:f.userId},stdio:['ignore','ignore','ignore','ipc']});
  const exited=new Promise<string|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',(_code,signal)=>resolve(signal));});
  let bytesReceived!:()=>void,committed!:()=>void,unlock:(()=>void)|undefined,lockTask:Promise<unknown>|undefined;
  const bytes=new Promise<void>(resolve=>{bytesReceived=resolve;}),saved=new Promise<void>(resolve=>{committed=resolve;});
  child.on('message',message=>{if(message==='received')bytesReceived();if(message==='committed')committed();});
  let timer:NodeJS.Timeout|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Probe child did not reach the boundary')),15000);});
  const guard=<T>(promise:Promise<T>)=>Promise.race([promise,timeout,exited.then(()=>{throw new Error('Probe child exited early');})]);
  try{
    await guard(received);const call=(await f.calls())[0];expect(call.status).toBe('started');
    if(boundary==='after-response-before-save'){
      let locked!:()=>void;const ready=new Promise<void>(resolve=>{locked=resolve;}),release=new Promise<void>(resolve=>{unlock=resolve;});
      lockTask=f.tx(async tx=>{await sql`SELECT id FROM hawa.paid_model_probe_calls WHERE id=${call.id}::uuid FOR UPDATE`.execute(tx);locked();await release;});
      await guard(ready);
    }
    if(boundary!=='after-send'){
      response!.writeHead(200,{'content-type':'application/json'});response!.end(await good().text());
      await guard(boundary==='after-save'?saved:bytes);
    }
    child.kill('SIGKILL');expect(await exited).toBe('SIGKILL');unlock?.();await lockTask;unlock=undefined;
    const freshDb=createDb(process.env.TEST_DATABASE_URL!),fetcher=vi.fn(async()=>good());
    try{
      const fresh=new PaidModelProbeService(freshDb,fetcher);
      expect(await fresh.execute(f.scope,key,model,300000)).toMatchObject({status:boundary==='after-save'?'not_due':'reconciliation_required',dispatched:false});
      expect((await f.calls())[0].status).toBe(boundary==='after-save'?'completed':'started');
      expect(fetcher).not.toHaveBeenCalled();expect(accepted).toBe(1);
    }finally{await freshDb.destroy();}
  }finally{
    clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;
    unlock?.();await lockTask;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
},25000);

it('bounds response bytes and sanitizes provider-controlled identifiers',async()=>{
  const f=await fixture(),fetcher=vi.fn(async()=>new Response('x'.repeat(65537),{headers:{'x-request-id':'private value with spaces'}}));
  await new PaidModelProbeService(db,fetcher).execute(f.scope,key,model,300000);
  const call=(await f.calls())[0],view=await f.accounting.get(f.scope,'health_probe',call.id);
  expect(view).toMatchObject({providerRequestId:null,responseId:null,originalCostUsd:null,requiresCostEvidence:true,originalAccepted:true});
  expect(JSON.stringify(view)).not.toContain('private value');
  await expect(f.tx(q=>sql`UPDATE hawa.paid_model_probe_calls SET cost_usd=0 WHERE id=${call.id}::uuid`.execute(q))).rejects.toThrow('immutable');
});

it('an expired pricing policy sends no request',async()=>{
  const f=await fixture(),fetcher=vi.fn(async()=>good());
  vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-11-22T00:00:00Z'));
  try{expect(await new PaidModelProbeService(db,fetcher).execute(f.scope,key,model,300000)).toMatchObject({status:'unquotable',dispatched:false});}
  finally{vi.restoreAllMocks();}
  expect(fetcher).not.toHaveBeenCalled();
});
