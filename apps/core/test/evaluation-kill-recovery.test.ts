import {afterAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer,type ServerResponse} from 'node:http';
import {fileURLToPath} from 'node:url';
import {createDb,sql,withRlsContext} from '@hawa/db';
import {FakeModelGateway} from '@hawa/testkit';
import {DurableEvaluationService} from '../src/services/durable-evaluations.js';
const owner=createDb(process.env.TEST_DATABASE_OWNER_URL!),runtime=createDb(process.env.TEST_DATABASE_URL!);
afterAll(async()=>{await owner.destroy();await runtime.destroy();});
it.each(['after-send','after-receipt'])('preserves %s through actual SIGKILL and fresh database handles',async boundary=>{
  const scope={tenantId:randomUUID(),userId:randomUUID(),role:'operator'},actionId=randomUUID();
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${scope.tenantId}::uuid,'Eval kill',${scope.tenantId})`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${scope.userId}::uuid,${`${scope.userId}@example.test`},'Eval kill')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${scope.tenantId}::uuid,${scope.userId}::uuid,'operator')`.execute(owner);
  let accepted=0,notify!:()=>void,response:ServerResponse|undefined;
  const received=new Promise<void>(r=>notify=r);
  const server=createServer((request,res)=>{request.resume();request.on('end',()=>{accepted++;response=res;notify();});});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address();if(!address||typeof address==='string')throw new Error('Local port unavailable');
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/evaluation-kill-child.ts',import.meta.url))],{
    cwd:process.cwd(),env:{...process.env,HAWA_EVAL_DRILL_DB:process.env.TEST_DATABASE_URL!,HAWA_EVAL_DRILL_PORT:String(address.port),HAWA_EVAL_DRILL_TENANT:scope.tenantId,HAWA_EVAL_DRILL_USER:scope.userId,HAWA_EVAL_DRILL_ACTION:actionId},stdio:'ignore'});
  const exited=new Promise<string|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',(_code,signal)=>resolve(signal));});
  let timer:NodeJS.Timeout|undefined,unlock:(()=>void)|undefined,lockTask:Promise<unknown>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Evaluation drill did not reach its local provider')),20000);});
  try{
    await Promise.race([received,timeout,exited.then(()=>{throw new Error('Evaluation child exited before its boundary');})]);
    const service=new DurableEvaluationService(runtime,new FakeModelGateway());const [run]=await service.list(scope);expect(run.status).toBe('running');
    if(boundary==='after-receipt'){
      let locked!:()=>void;const ready=new Promise<void>(r=>locked=r),release=new Promise<void>(r=>unlock=r);
      lockTask=withRlsContext(runtime,scope,async tx=>{await sql`SELECT id FROM hawa.eval_runs WHERE id=${run.runId}::uuid FOR NO KEY UPDATE`.execute(tx);locked();await release;});
      await ready;
      response!.writeHead(200,{'content-type':'application/json'});
      response!.end(JSON.stringify({ok:true,value:{deployment:{deploymentId:randomUUID(),role:'intake_router',provider:'synthetic',exactModelId:'fixture-model',deploymentVersion:'test'},
        value:{decision:'abstain',confidence:1,privateText:'DO NOT RETAIN'},responseHash:'a'.repeat(64),invocationId:randomUUID(),usage:{estimatedCostUsd:0.02},latencyMs:1,attempts:1,completedAt:new Date().toISOString()}}));
      const deadline=Date.now()+10000;let completed=false;
      while(Date.now()<deadline){
        const rows=await withRlsContext(runtime,scope,tx=>sql<{status:string;outcome:unknown}>`SELECT status,outcome FROM hawa.eval_model_calls WHERE run_id=${run.runId}::uuid AND ordinal=1`.execute(tx));
        if(rows.rows[0]?.status==='completed'){completed=true;expect(JSON.stringify(rows.rows[0])).not.toContain('DO NOT RETAIN');break;}
        await new Promise(r=>setTimeout(r,25));
      }
      expect(completed).toBe(true);
    }
    child.kill('SIGKILL');expect(await exited).toBe('SIGKILL');unlock?.();await lockTask;unlock=undefined;
    const freshDb=createDb(process.env.TEST_DATABASE_URL!);const gateway=new FakeModelGateway(),calls=vi.spyOn(gateway,'generateStructured');
    if(boundary==='after-send') vi.spyOn(gateway,'resolve').mockResolvedValue({ok:false,error:{code:'MODEL_UNAVAILABLE',message:'Unavailable now',retryable:false,safeAction:'Review configuration'}});
    try{
      const fresh=new DurableEvaluationService(freshDb,gateway);const result=await fresh.run(scope,{actionId,name:'Kill boundary'});
      expect(accepted).toBe(1);
      const rows=await withRlsContext(freshDb,scope,tx=>sql<{status:string;outcome:unknown}>`SELECT status,outcome FROM hawa.eval_model_calls WHERE run_id=${run.runId}::uuid ORDER BY ordinal`.execute(tx));
      if(boundary==='after-send'){
        expect(result.report?.modelCallHold?.code).toBe('EVALUATION_CALL_UNCERTAIN');expect(calls).not.toHaveBeenCalled();expect(rows.rows).toEqual([{status:'pending',outcome:null}]);
        await expect(fresh.run(scope,{actionId:randomUUID(),name:'Fresh bypass'})).rejects.toMatchObject({code:'EVALUATION_PRIOR_RUN_UNSETTLED'});
      }else{
        expect(result.status).toBe('completed');expect(calls).toHaveBeenCalledTimes(rows.rows.length-1);
        expect(rows.rows[0]).toMatchObject({status:'completed',outcome:{ok:true,value:{usage:{estimatedCostUsd:0.02}}}});
      }
    }finally{await freshDb.destroy();}
  }finally{
    clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;
    unlock?.();await lockTask;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
  }
},40000);
