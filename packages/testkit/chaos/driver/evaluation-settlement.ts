/** Deployed recovery proof using an internal fake provider and an explicitly synthetic administrator. */
import {createHash,randomUUID} from 'node:crypto';
import {compose,FAKES_URL,query,secrets,sql} from './stack.js';
import {TENANT_ID} from './provision.js';
import {waitUntil,type InvariantResult} from './scenario.js';

export async function candidateEvaluationSettlement(events:string[]):Promise<InvariantResult[]> {
  const checks:InvariantResult[]=[];
  const check=(name:string,ok:boolean,detail='Synthetic provider and staff evidence')=>{
    checks.push({name,ok,detail});if(!ok)throw new Error(name);
  };
  const call=async(path:string,body?:unknown,actionId?:string,token=secrets().CHAOS_BEARER_TOKEN)=>{
    const response=await fetch(`http://127.0.0.1:56081/v1${path}`,{method:body===undefined?'GET':'POST',headers:{
      Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(actionId?{'Idempotency-Key':actionId}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
    return {status:response.status,body:await response.json()};
  };
  const ledger=async()=>((await(await fetch(`${FAKES_URL}/__fakes/models/ledger`)).json()) as {ledger:unknown[]}).ledger.length;
  const before=await ledger(),startAction=randomUUID(),runBody={name:'[TEST] deployed settlement recovery'};
  const first=await call('/evaluations/runs',runBody,startAction);
  check('evaluation uncertainty produces a stopped saved report',first.status===200&&first.body.status==='failed'&&first.body.report.executionStatus==='stopped'&&first.body.report.overallPassRate===null);
  const path=`/evaluations/runs/${first.body.runId}`,detail=await call(path);
  check('uncertain receipt keeps its original unknown cost',detail.status===200&&detail.body.calls.length===1&&detail.body.calls[0].status==='uncertain'&&detail.body.calls[0].estimatedCostUsd===null);
  check('unsettled evaluation blocks fresh actions',(await call('/evaluations/runs',{name:'Bypass'},randomUUID())).status===409);
  const body={expectedSnapshot:detail.body.snapshotHash,reason:'Synthetic provider fixture confirms final processing and charge',calls:[{
    callId:detail.body.calls[0].id,conclusion:'provider_finished',reportedCostUsd:0.125,evidenceReference:'synthetic-provider-fixture',evidenceSha256:createHash('sha256').update('synthetic final receipt 0.125').digest('hex')}]};
  check('shared administrator credentials cannot settle',(await call(`${path}/settlement`,body,randomUUID(),secrets().CHAOS_ADMIN_KEY)).status===403);
  const userId=randomUUID(),token=`hawa_sess_${randomUUID().replaceAll('-','')}`,tokenHash=createHash('sha256').update(token).digest('hex');
  await query(sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${`settlement-${userId}@example.test`},'Synthetic settlement administrator',${`synthetic-${userId}`})`);
  await query(sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${TENANT_ID}::uuid,${userId}::uuid,'administrator')`);
  await query(sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES(${tokenHash},${TENANT_ID}::uuid,${userId}::uuid,'oidc:synthetic-fixture','administrator','Synthetic administrator',now()+interval '1 hour','google_oidc')`);
  try {
    check('named session reads settlement capability',(await call(path,undefined,undefined,token)).body.canSettle===true);
    check('unknown final cost cannot close the hold',(await call(`${path}/settlement`,{...body,calls:[{...body.calls[0],reportedCostUsd:null}]},randomUUID(),token)).status===400);
    check('changed ledger snapshot refuses settlement',(await call(`${path}/settlement`,{...body,expectedSnapshot:'0'.repeat(64)},randomUUID(),token)).status===409);
    const action=randomUUID(),settled=await call(`${path}/settlement`,body,action,token);
    check('named settlement records its actor and separate reported cost',settled.status===200&&settled.body.settlement.actorUserId===userId&&settled.body.settlement.calls[0].reportedCostUsd===0.125);
    compose(['restart','core']);
    await waitUntil('Core restarts after evaluation settlement',async()=>{try{return (await call('/evaluations/runs')).status===200;}catch{return false;}});
    const replay=await call(`${path}/settlement`,body,action,token);
    check('fresh Core replays one identical settlement',replay.status===200&&replay.body.replayed===true&&JSON.stringify(replay.body.settlement)===JSON.stringify(settled.body.settlement));
    const closed=await call(path);
    check('closure preserves original stopped report and uncertain receipt',closed.body.status==='closed'&&closed.body.resumable===false&&JSON.stringify(closed.body.report)===JSON.stringify(first.body.report)&&closed.body.calls[0].status==='uncertain'&&closed.body.calls[0].estimatedCostUsd===null);
    check('old run action returns closure without a model call',(await call('/evaluations/runs',runBody,startAction)).body.status==='closed'&&await ledger()===before+1);
    check('changed settlement intent conflicts',(await call(`${path}/settlement`,{...body,reason:'Changed'},action,token)).status===409);
    const next=await call('/evaluations/runs',{name:'[TEST] explicit new evaluation after settlement'},randomUUID());
    check('explicit fresh evaluation admits a separate provider request',next.status===200&&next.body.runId!==first.body.runId&&await ledger()===before+2,'Two synthetic provider calls total; no call on settlement/replay');
    const rows=await query<{n:number}>(sql`SELECT count(*)::int AS n FROM hawa.eval_run_settlements WHERE run_id=${first.body.runId}::uuid`);
    check('one immutable settlement survives restart',rows[0].n===1);
  }finally{
    await query(sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${tokenHash}`);
  }
  events.push('Held fixture evaluation → synthetic named settlement → Core restart → identical receipt → explicitly new evaluation. No live provider or human evidence.');
  return checks;
}
