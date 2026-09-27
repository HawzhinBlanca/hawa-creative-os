import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { FakeModelGateway } from '@hawa/testkit';
import { ResilientModelGateway } from '@hawa/integrations';
import { DurableEvaluationService, type EvaluationScope } from '../src/services/durable-evaluations.js';
import { createApp } from '../src/app.js';

const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!);
const runtime=createDb(process.env.TEST_DATABASE_URL!);
afterAll(async()=>{await owner.destroy();await runtime.destroy();});
async function scope():Promise<EvaluationScope>{
  const tenantId=randomUUID(),userId=randomUUID();
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Evaluation test',${tenantId})`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${userId}::uuid,${`${userId}@example.test`},'Evaluation tester')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${userId}::uuid,'operator')`.execute(owner);
  return {tenantId,userId,role:'operator'};
}
const input=()=>({actionId:randomUUID(),name:'Synthetic fixture tournament'});
const newGateway=()=>{
  const gateway=new FakeModelGateway();
  const call=vi.spyOn(gateway,'generateStructured');
  return {gateway,call};
};
describe('durable fixture evaluations under runtime RLS',()=>{
  it('retains a native gateway overrun and its exact request bound through fresh Core replay',async()=>{
    const s=await scope(),i=input(),gateway=new ResilientModelGateway();
    vi.stubEnv('GEMINI_API_KEY','synthetic-gateway-key');
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({modelVersion:'gemini-3.8-flash',
      candidates:[{content:{parts:[{text:'{"decision":"route_matched","confidence":0.9}'}]}}],
      usageMetadata:{promptTokenCount:1_000_000,candidatesTokenCount:100,totalTokenCount:1_000_100},
    }),{status:200}));
    try{
      const service=new DurableEvaluationService(runtime,gateway),run=await service.run(s,i);
      expect(run.report?.executionStatus).toBe('stopped');
      const detail=await service.get(s,run.runId),call=detail!.calls[0];
      expect(call.status).toBe('uncertain');expect(call.estimatedCostUsd).toBe(.750375);expect(call.costBasis).toBe('usage');
      expect(call.spending).toMatchObject({requestSha256:createHash('sha256').update(String(fetcher.mock.calls[0]?.[1]?.body)).digest('hex'),outputTokens:2048});
      const fresh=new DurableEvaluationService(runtime,new ResilientModelGateway());
      expect(await fresh.run(s,i)).toEqual(run);expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await fresh.get(s,run.runId))?.calls[0]).toEqual(call);
    }finally{vi.restoreAllMocks();vi.unstubAllEnvs();}
  });
  it('persists unknown usage and the original quote without inventing a final charge',async()=>{
    const s=await scope(),i=input(),gateway=new ResilientModelGateway();
    vi.stubEnv('GEMINI_API_KEY','synthetic-gateway-key');
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({modelVersion:'gemini-3.8-flash',
      candidates:[{content:{parts:[{text:'{"decision":"abstain","confidence":0.9}'}]}}],
    }),{status:200})).mockResolvedValue(new Response('',{status:503}));
    try{
      const service=new DurableEvaluationService(runtime,gateway),run=await service.run(s,i),detail=await service.get(s,run.runId);
      expect(detail?.calls[0]).toMatchObject({status:'completed',estimatedCostUsd:null,costBasis:'unknown',spending:{outputTokens:2048}});
      expect(detail?.calls[0].spending?.usd).toBeGreaterThan(0);
      expect(run.report?.executionStatus).toBe('stopped');expect(fetcher).toHaveBeenCalledTimes(2);
      await new DurableEvaluationService(runtime,gateway).run(s,i);expect(fetcher).toHaveBeenCalledTimes(2);
    }finally{vi.restoreAllMocks();vi.unstubAllEnvs();}
  });
  it('saves the run, receipts and scoring projection and replays from a fresh Core without more model calls',async()=>{
    const s=await scope(),i=input(),{gateway,call}=newGateway();
    const service=new DurableEvaluationService(runtime,gateway);
    const run=await service.run(s,i);
    expect(run.status).toBe('completed');expect(run.report?.admissionEligible).toBe(false);
    const before=call.mock.calls.length;expect(before).toBeGreaterThan(1);
    const freshDb=createDb(process.env.TEST_DATABASE_URL!);
    try{
      const replay=await new DurableEvaluationService(freshDb,gateway).run(s,i);
      expect(replay).toEqual(run);expect(call).toHaveBeenCalledTimes(before);
    }finally{await freshDb.destroy();}
    const calls=await withRlsContext(runtime,s,tx=>sql<{status:string;outcome:unknown}>`SELECT status,outcome FROM hawa.eval_model_calls WHERE run_id=${run.runId}::uuid`.execute(tx));
    expect(calls.rows).toHaveLength(before);expect(calls.rows.every(c=>c.status==='completed')).toBe(true);
    expect(await service.list(s)).toHaveLength(1);
    const other=await scope();expect(await service.get(other,run.runId)).toBeNull();expect(await service.list(other)).toEqual([]);
    await expect(service.run(s,{...i,name:'Changed'})).rejects.toMatchObject({code:'EVALUATION_ACTION_CONFLICT'});
    await expect(withRlsContext(runtime,s,tx=>sql`UPDATE hawa.eval_model_calls SET outcome='{}'::jsonb WHERE run_id=${run.runId}::uuid`.execute(tx))).rejects.toThrow(/immutable/);
    await expect(withRlsContext(runtime,s,tx=>sql`UPDATE hawa.eval_runs SET name='Changed' WHERE id=${run.runId}::uuid`.execute(tx))).rejects.toThrow(/immutable/);
  });
  it('stores unknown spend and blocks a fresh action after uncertainty',async()=>{
    const s=await scope(),i=input(),{gateway,call}=newGateway();
    call.mockResolvedValue({ok:false,error:{code:'MODEL_ACCEPTANCE_UNKNOWN',message:'PRIVATE MODEL RESPONSE',safeAction:'PRIVATE',retryable:false,
      detail:{requiresReconciliation:true,httpStatus:503,provider:'google',providerRequestId:'receipt-123',estimatedCostUsd:null,private:'PRIVATE'}}});
    const service=new DurableEvaluationService(runtime,gateway);
    const result=await service.run(s,i);expect(result.report?.executionStatus).toBe('stopped');expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result.report?.modelCallHold?.detail).toMatchObject({providerRequestId:'receipt-123',estimatedCostUsd:null});
    expect(await new DurableEvaluationService(runtime,gateway).run(s,i)).toEqual(result);expect(call).toHaveBeenCalledTimes(1);
    await expect(service.run(s,input())).rejects.toMatchObject({code:'EVALUATION_PRIOR_RUN_UNSETTLED'});
  });
  it('serializes competing starts and preserves the in-flight row before transport completes',async()=>{
    const s=await scope(),i=input(),{gateway,call}=newGateway();
    let release!:()=>void,entered!:()=>void;
    const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
    call.mockImplementationOnce(async()=>{entered();await wait;throw new Error('synthetic lost reply');});
    const service=new DurableEvaluationService(runtime,gateway);const active=service.run(s,i);await started;
    try{
      const saved=await service.list(s);expect(saved).toHaveLength(1);expect(saved[0]).toMatchObject({status:'running',resumable:true,report:null});
      await expect(service.run(s,i)).rejects.toMatchObject({code:'EVALUATION_BUSY'});
      const pending=await withRlsContext(runtime,s,tx=>sql<{status:string;outcome:unknown}>`SELECT status,outcome FROM hawa.eval_model_calls WHERE run_id=${saved[0].runId}::uuid`.execute(tx));
      expect(pending.rows).toEqual([{status:'pending',outcome:null}]);
      await expect(withRlsContext(runtime,s,tx=>sql`UPDATE hawa.eval_model_calls SET request_hash=${'b'.repeat(64)} WHERE run_id=${saved[0].runId}::uuid`.execute(tx))).rejects.toThrow(/immutable/);
    }finally{release();}
    expect((await active).report?.executionStatus).toBe('stopped');expect(call).toHaveBeenCalledTimes(1);
  });
  it('resumes a saved completed call after the next database admission fails, without repeating it',async()=>{
    const s=await scope(),i=input(),{gateway,call}=newGateway();
    // Fail ordinal 2 before transport, after the first outcome has been committed.
    await sql.raw(`CREATE FUNCTION hawa.test_eval_admit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${s.tenantId}'::uuid AND NEW.ordinal=2 THEN RAISE EXCEPTION 'synthetic admission outage'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_eval_admit_failure BEFORE INSERT ON hawa.eval_model_calls FOR EACH ROW EXECUTE FUNCTION hawa.test_eval_admit_failure();`).execute(owner);
    const service=new DurableEvaluationService(runtime,gateway);
    try{await expect(service.run(s,i)).rejects.toThrow('synthetic admission outage');}finally{
      await sql.raw('DROP TRIGGER test_eval_admit_failure ON hawa.eval_model_calls; DROP FUNCTION hawa.test_eval_admit_failure();').execute(owner);
    }
    expect(call).toHaveBeenCalledTimes(1);
    const replayGateway=new FakeModelGateway();const replayCall=vi.spyOn(replayGateway,'generateStructured');
    const result=await new DurableEvaluationService(runtime,replayGateway).run(s,i);expect(result.status).toBe('completed');
    const count=await withRlsContext(runtime,s,tx=>sql<{n:number}>`SELECT count(*)::int AS n FROM hawa.eval_model_calls WHERE run_id=${result.runId}::uuid`.execute(tx));
    expect(replayCall).toHaveBeenCalledTimes(count.rows[0].n-1);
  });
  it('refuses a missing action or unauthorized role before a model call',async()=>{
    const s=await scope(),{gateway,call}=newGateway(),service=new DurableEvaluationService(runtime,gateway);
    await expect(service.run(s,{...input(),actionId:undefined})).rejects.toMatchObject({status:400});
    await expect(service.run({...s,role:'viewer'},input())).rejects.toMatchObject({status:403});expect(call).not.toHaveBeenCalled();
  });
  it('HTTP retries and fresh Core history reuse the action and expose only receipt evidence',async()=>{
    const {gateway,call}=newGateway(),actionId=randomUUID();
    const options={db:runtime,evaluationGateway:gateway,testAuth:{principal:{role:'operator',userId:'00000000-0000-4000-b000-000000000001'}},skipPaidModelProbe:true,skipTelegramProbe:true,enableTelegramPolling:false};
    const first=createApp(options);
    const request=()=>({method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':actionId},body:JSON.stringify({name:'HTTP saved run'})});
    const response=await first.request('/v1/evaluations/runs',request());expect(response.status).toBe(200);
    const run=await response.json();const before=call.mock.calls.length;
    const fresh=createApp(options);const replay=await fresh.request('/v1/evaluations/runs',request());expect(await replay.json()).toEqual(run);expect(call).toHaveBeenCalledTimes(before);
    const details=await (await fresh.request(`/v1/evaluations/runs/${run.runId}`)).json();expect(details.calls).toHaveLength(before);
    expect(details.calls[0]).toHaveProperty('responseHash');expect(details.calls[0]).not.toHaveProperty('outcome');
    expect((await fresh.request('/v1/evaluations/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'No action'})})).status).toBe(400);
  });
  it('refuses resume under a different saved evaluator identity without model work',async()=>{
    const s=await scope(),i=input(),{gateway,call}=newGateway();
    const datasetId=randomUUID();
    await sql`INSERT INTO hawa.eval_datasets(id,tenant_id,name,version,description,content_hash) VALUES(${datasetId}::uuid,${s.tenantId}::uuid,'Old corpus','old','Version negative control',${'0'.repeat(64)})`.execute(owner);
    await sql`INSERT INTO hawa.eval_runs(tenant_id,dataset_id,action_id,request_hash,actor_id,name,candidate,status)
      VALUES(${s.tenantId}::uuid,${datasetId}::uuid,${i.actionId}::uuid,${createHash('sha256').update(JSON.stringify({name:i.name})).digest('hex')},${s.userId}::uuid,${i.name},${JSON.stringify({suiteHash:'0'.repeat(64)})}::jsonb,'running')`.execute(owner);
    await expect(new DurableEvaluationService(runtime,gateway).run(s,i)).rejects.toMatchObject({code:'EVALUATION_VERSION_CONFLICT'});expect(call).not.toHaveBeenCalled();
  });
  it('Core has no in-memory fallback when durable storage is unavailable',async()=>{
    const {gateway,call}=newGateway();const app=createApp({evaluationGateway:gateway,testAuth:{principal:{role:'operator'}},skipPaidModelProbe:true,skipTelegramProbe:true,enableTelegramPolling:false});
    const response=await app.request('/v1/evaluations/runs',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({name:'Test'})});
    expect(response.status).toBe(503);expect(call).not.toHaveBeenCalled();
  });
});
