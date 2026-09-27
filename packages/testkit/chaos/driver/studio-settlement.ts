/** Deployed API recovery with synthetic call admissions and synthetic administrator evidence. */
import {createHash,randomUUID} from 'node:crypto';
import {withRlsContext} from '@hawa/db';
import {compose,db,FAKES_URL,query,secrets,sql} from './stack.js';
import {TENANT_ID,KAAE_CLIENT_ID} from './provision.js';
import {waitUntil,type InvariantResult} from './scenario.js';

export async function candidateStudioSettlement(events:string[]):Promise<InvariantResult[]> {
  const checks:InvariantResult[]=[];
  const check=(name:string,ok:boolean,detail='Synthetic Studio ledger and named administrator evidence')=>{
    checks.push({name,ok,detail});if(!ok)throw new Error(name);
  };
  const call=async(path:string,body?:unknown,actionId?:string,token=secrets().CHAOS_BEARER_TOKEN)=>{
    const response=await fetch(`http://127.0.0.1:56081/v1${path}`,{method:body===undefined?'GET':'POST',headers:{
      Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(actionId?{'Idempotency-Key':actionId}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
    return {status:response.status,body:await response.json()};
  };
  const ledger=async()=>((await(await fetch(`${FAKES_URL}/__fakes/models/ledger`)).json()) as {ledger:unknown[]}).ledger.length;
  const before=await ledger();
  const created=await call('/tasks',{clientId:KAAE_CLIENT_ID,title:'Synthetic Studio recovery',priority:'routine',
    copyEn:'Exact recovery copy 123.45',copyCkb:'',description:'Exact recovery copy 123.45',designInstructions:'Preserve exact copy.',
    referenceAssets:'',workflow:'canva_manual',source:{platform:'hawa_desk',externalId:'synthetic-recovery'}},randomUUID());
  check('deployed Studio recovery creates a manual fixture task',created.status===201&&!!created.body.id);
  const taskId=created.body.id,input={width:1080,height:1350,tier:'standard'},studio=`/tasks/${taskId}/canva/studio`;
  const first=await call(studio,input,randomUUID());
  check('deployed Studio admits a run without transport',first.status===202&&first.body.created===true&&await ledger()===before);
  const runId=first.body.runId,callId=randomUUID();
  const reservation={version:1,usd:.01,requestSha256:'a'.repeat(64),policy:'synthetic-runtime-proof',inputTokens:1,outputTokens:1};
  await withRlsContext(db(),{tenantId:TENANT_ID},tx=>sql`INSERT INTO hawa.design_studio_calls(id,tenant_id,run_id,stage,provider,model,requested_model,call_ordinal,logical_call_sha256,status,reservation)
    VALUES(${callId}::uuid,${TENANT_ID}::uuid,${runId}::uuid,'briefing','openai','synthetic','synthetic',1,${'a'.repeat(64)},'uncertain',${JSON.stringify(reservation)}::jsonb)`.execute(tx));
  await query(sql`UPDATE hawa.design_studio_runs SET status='abandoned',diagnostic='Synthetic interrupted-call fixture' WHERE id=${runId}::uuid`);
  check('deployed abandoned run cannot bypass unresolved spend',(await call(studio,input,randomUUID())).status===409);
  const path=`/tasks/${taskId}/studio-recovery/${runId}`,detail=await call(path);
  check('deployed original Studio cost remains unknown',detail.status===200&&detail.body.calls[0].estimatedCostUsd===null&&detail.body.unresolvedCalls===1);
  const body={expectedSnapshot:detail.body.snapshotHash,reason:'Synthetic terminal provider evidence',calls:[{
    callId,conclusion:'provider_finished',reportedCostUsd:0.125,evidenceReference:'synthetic-studio-terminal',evidenceSha256:'b'.repeat(64)}]};
  check('shared keys cannot settle Studio calls',(await call(`${path}/settlement`,body,randomUUID(),secrets().CHAOS_ADMIN_KEY)).status===403);
  const userId=randomUUID(),token=`hawa_sess_${randomUUID().replaceAll('-','')}`,tokenHash=createHash('sha256').update(token).digest('hex');
  await query(sql`INSERT INTO hawa.users(id,email,display_name,external_subject) VALUES(${userId}::uuid,${userId+'@example.test'},'Synthetic Studio administrator',${userId})`);
  await query(sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${TENANT_ID}::uuid,${userId}::uuid,'administrator')`);
  await query(sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
    VALUES(${tokenHash},${TENANT_ID}::uuid,${userId}::uuid,'oidc:synthetic-studio','administrator','Synthetic administrator',now()+interval '1 hour','google_oidc')`);
  try {
    check('named Studio recovery authority is current',(await call(path,undefined,undefined,token)).body.canSettle===true);
    check('Studio refuses unknown attested cost',(await call(`${path}/settlement`,{...body,calls:[{...body.calls[0],reportedCostUsd:null}]},randomUUID(),token)).status===400);
    check('Studio refuses changed evidence snapshots',(await call(`${path}/settlement`,{...body,expectedSnapshot:'0'.repeat(64)},randomUUID(),token)).status===409);
    const action=randomUUID(),settled=await call(`${path}/settlement`,body,action,token);
    check('Studio stores named settlement with separate cost',settled.status===200&&settled.body.settlement.actorUserId===userId&&settled.body.settlement.calls[0].reportedCostUsd===0.125);
    compose(['restart','core']);
    await waitUntil('Core restarts after Studio settlement',async()=>{try{return(await call(path)).status===200;}catch{return false;}});
    const replay=await call(`${path}/settlement`,body,action,token);
    check('Studio settlement replays through fresh Core',replay.status===200&&replay.body.replayed===true&&JSON.stringify(replay.body.settlement)===JSON.stringify(settled.body.settlement));
    const after=await call(path);
    check('Studio settlement preserves original uncertainty and stopped run',after.body.status==='abandoned'&&after.body.calls[0].status==='uncertain'&&after.body.calls[0].estimatedCostUsd===null&&after.body.unresolvedCalls===0);
    const next=await call(studio,input,randomUUID());
    check('explicit new Studio action admits after settlement',next.status===202&&next.body.created===true&&next.body.runId!==runId);
    check('Studio settlement and replay make zero model requests',await ledger()===before,'Ledger admissions are synthetic; no model transport was requested by the recovery proof.');
  }finally{await query(sql`UPDATE hawa.desk_sessions SET revoked_at=now() WHERE token_hash=${tokenHash}`);}
  events.push(`Studio ${runId}: synthetic unresolved admission → abandoned run → named settlement → Core restart → identical receipt → explicit new run. No live provider/human evidence.`);
  return checks;
}
