import { createHash } from 'node:crypto';
import { sql, withRlsContext, type Kysely, type Database, type RlsContext } from '@hawa/db';
import { parseEvaluationSettlement, type EvaluationCallSettlement } from '@hawa/domain';
import { lockNamedOfficeAdministrator } from './named-review-authority.js';
import { CanvaFlowError } from './canva-flow-error.js';

type Scope = RlsContext & { userId:string; sessionHash?:string };
type Run = { id:string; task_id:string; client_id:string; status:string; request_hash:string; updated_at:Date };
type Task = { id:string; client_id:string; state:string; version:number; request_id:string|null };
type Call = { id:string; call_ordinal:number|null; stage:string; provider:string; model:string; status:string;
  logical_call_sha256:string|null; response_id:string|null; provider_request_id:string|null;
  usd_estimate:string; finished_at:Date|null; started_at:Date };
type Settlement = { id:string; run_id:string; action_id:string; actor_user_id:string; request_hash:string; reason:string;
  calls:EvaluationCallSettlement[]; recorded_at:Date };
const stopped = (status:string) => ['abandoned','failed','degraded','transferred'].includes(status);
const uuid = (value:unknown):value is string => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const view = (s:Settlement) => ({id:s.id,actionId:s.action_id,actorUserId:s.actor_user_id,reason:s.reason,
  calls:s.calls,recordedAt:new Date(s.recorded_at).toISOString(),evidenceType:'administrator_attestation' as const});

/** Financial evidence only: this service has no model/provider, task-control or workflow client. */
export class StudioCallSettlementService {
  constructor(private db:Kysely<Database>) {}
  private scoped<T>(s:Scope,fn:(tx:Kysely<Database>)=>Promise<T>) { return withRlsContext(this.db,s,fn); }
  private async read(tx:Kysely<Database>,s:Scope,taskId:string,runId:string) {
    const task=(await sql<Task>`SELECT id,client_id,state,version,request_id FROM hawa.tasks
      WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(tx)).rows[0];
    const run=(await sql<Run>`SELECT id,task_id,client_id,status,request_hash,updated_at FROM hawa.design_studio_runs
      WHERE tenant_id=${s.tenantId}::uuid AND id=${runId}::uuid AND task_id=${taskId}::uuid FOR UPDATE`.execute(tx)).rows[0];
    if(!task||!run||task.client_id!==run.client_id) throw new CanvaFlowError(404,'STUDIO_RECOVERY_NOT_FOUND','Studio evidence was not found for this task.');
    const calls=(await sql<Call>`SELECT id,call_ordinal,stage,provider,model,status,logical_call_sha256,response_id,
      provider_request_id,usd_estimate,finished_at,started_at FROM hawa.design_studio_calls
      WHERE tenant_id=${s.tenantId}::uuid AND run_id=${runId}::uuid ORDER BY id FOR UPDATE`.execute(tx)).rows;
    const settlements=(await sql<Settlement>`SELECT * FROM hawa.studio_run_settlements
      WHERE tenant_id=${s.tenantId}::uuid AND run_id=${runId}::uuid ORDER BY recorded_at,id`.execute(tx)).rows;
    const covered=new Set(settlements.flatMap(receipt=>receipt.calls.map(call=>call.callId)));
    const unresolved=calls.filter(c=>c.status==='uncertain'&&!covered.has(c.id));
    return {task,run,calls,settlements,unresolved,snapshotHash:digest({task,run,calls,settlements:settlements.map(s=>s.id)})};
  }
  async get(s:Scope,taskId:string,runId:string) {
    if(!uuid(taskId)||!uuid(runId)) throw new CanvaFlowError(400,'STUDIO_RECOVERY_INVALID','Use the saved task and run IDs.');
    return this.scoped(s,async tx=>{
      const named=!!s.sessionHash&&await lockNamedOfficeAdministrator(tx,{...s,sessionHash:s.sessionHash});
      const state=await this.read(tx,s,taskId,runId);
      const byCall=new Map(state.settlements.flatMap(receipt=>receipt.calls.map(c=>[c.callId,{...c,actorUserId:receipt.actor_user_id,recordedAt:receipt.recorded_at}] as const)));
      return {runId,taskId,status:state.run.status,snapshotHash:state.snapshotHash,
        canSettle:named&&stopped(state.run.status)&&state.unresolved.length>0,
        requiresStop:!stopped(state.run.status),unresolvedCalls:state.unresolved.length,
        settlements:state.settlements.map(view),
        calls:state.calls.map(c=>({id:c.id,ordinal:c.call_ordinal,stage:c.stage,provider:c.provider,model:c.model,status:c.status,
          providerRequestId:c.provider_request_id,responseId:c.response_id,estimatedCostUsd:c.status==='uncertain'?null:Number(c.usd_estimate),
          settlement:byCall.get(c.id)||null,startedAt:c.started_at,finishedAt:c.finished_at}))};
    });
  }
  async settle(s:Scope,taskId:string,runId:string,actionId:unknown,body:unknown) {
    if(!s.sessionHash) throw new CanvaFlowError(403,'NAMED_ADMINISTRATOR_REQUIRED','Sign in as a named office administrator.');
    // Both recovery operations share the same strict provider-evidence input format.
    const input=parseEvaluationSettlement(body);
    if(!uuid(taskId)||!uuid(runId)||!uuid(actionId)||!input||!input.calls.length)
      throw new CanvaFlowError(400,'STUDIO_SETTLEMENT_INVALID','Supply a current snapshot, reason, and final provider evidence and cost for every unresolved call.');
    const requestHash=digest({taskId,runId,actorId:s.userId,...input});
    return this.scoped(s,async tx=>{
      if(!await lockNamedOfficeAdministrator(tx,{...s,sessionHash:s.sessionHash!}))
        throw new CanvaFlowError(403,'NAMED_ADMINISTRATOR_REQUIRED','The named administrator session or membership is no longer active.');
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`studio-settlement:${s.tenantId}:${actionId}`},0))`.execute(tx);
      const prior=(await sql<Settlement>`SELECT * FROM hawa.studio_run_settlements
        WHERE tenant_id=${s.tenantId}::uuid AND action_id=${actionId}::uuid`.execute(tx)).rows[0];
      if(prior){
        if(prior.request_hash!==requestHash) throw new CanvaFlowError(409,'STUDIO_SETTLEMENT_ACTION_CONFLICT','This action already records different evidence.');
        return {replayed:true,settlement:view(prior)};
      }
      const state=await this.read(tx,s,taskId,runId);
      if(!stopped(state.run.status)) throw new CanvaFlowError(409,'STUDIO_RUN_MUST_STOP','Stop this run through its owning workflow before recording settlement.');
      if(state.snapshotHash!==input.expectedSnapshot) throw new CanvaFlowError(409,'STUDIO_SNAPSHOT_CHANGED','Reload the saved calls; their evidence or task state changed.');
      if(input.calls.length!==state.unresolved.length||!state.unresolved.every(c=>input.calls.some(e=>e.callId===c.id)))
        throw new CanvaFlowError(409,'STUDIO_EVIDENCE_INCOMPLETE','Record terminal evidence for every currently unresolved call exactly once.');
      await sql`SELECT set_config('hawa.studio_settlement_session_hash',${s.sessionHash},true)`.execute(tx);
      const saved=(await sql<Settlement>`INSERT INTO hawa.studio_run_settlements
        (tenant_id,task_id,client_id,run_id,action_id,actor_user_id,request_hash,snapshot_hash,reason,calls)
        VALUES(${s.tenantId}::uuid,${taskId}::uuid,${state.run.client_id}::uuid,${runId}::uuid,${actionId}::uuid,
          ${s.userId}::uuid,${requestHash},${input.expectedSnapshot},${input.reason},${JSON.stringify(input.calls)}::jsonb)
        RETURNING *`.execute(tx)).rows[0];
      return {replayed:false,settlement:view(saved)};
    });
  }
}
