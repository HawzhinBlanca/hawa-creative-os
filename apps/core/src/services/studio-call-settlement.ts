import { createHash } from 'node:crypto';
import { sql, withRlsContext, type Kysely, type Database, type RlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { parseEvaluationSettlement, type EvaluationCallSettlement } from '@hawa/domain';
import { lockNamedOfficeAdministrator } from './named-review-authority.js';
import { CanvaFlowError } from './canva-flow-error.js';

/**
 * `trustedOffice`: the request came through the trusted-office policy (ADR-146), so it acts as the
 * shared office administrator with no named session. The route sets it from the verified request.
 */
type Scope = RlsContext & { userId:string; sessionHash?:string; trustedOffice?:boolean };
type Run = { id:string; task_id:string; client_id:string; status:string; request_hash:string; updated_at:Date };
type Task = { id:string; client_id:string; state:string; version:number; request_id:string|null };
type Call = { id:string; call_ordinal:number|null; stage:string; provider:string; model:string; status:string;
  logical_call_sha256:string|null; response_id:string|null; provider_request_id:string|null;
  usd_estimate:string; finished_at:Date|null; started_at:Date };
type EvidenceType = 'administrator_attestation'|'trusted_office_attestation'|'reservation_expiry';
type Settlement = { id:string; run_id:string; action_id:string; actor_user_id:string; request_hash:string; reason:string;
  calls:EvaluationCallSettlement[]; recorded_at:Date; evidence_type?:EvidenceType };
const stopped = (status:string) => ['abandoned','failed','degraded','transferred'].includes(status);
const uuid = (value:unknown):value is string => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const view = (s:Settlement) => ({id:s.id,actionId:s.action_id,actorUserId:s.actor_user_id,reason:s.reason,
  calls:s.calls,recordedAt:new Date(s.recorded_at).toISOString(),evidenceType:s.evidence_type??'administrator_attestation',
  ...(s.evidence_type==='trusted_office_attestation'?{actorLabel:'trusted_office_team'}:{})});

/**
 * ADR-159: how long a call may have no provider outcome before System Automation charges its whole
 * reservation, so it stops blocking its task and holding every later office day. Neither provider
 * can be asked about a request whose answer never arrived (no lookup by request id), so waiting is
 * only the office's chance to record the real charge first. HAWA_UNCERTAIN_CALL_HOLD_HOURS, 1 to 168.
 */
export const DEFAULT_UNCERTAIN_CALL_HOLD_HOURS = 6;
export function uncertainCallHoldMs(env: Record<string,string|undefined> = process.env): number {
  const raw=(env.HAWA_UNCERTAIN_CALL_HOLD_HOURS??'').trim();
  const hours=/^\d+$/.test(raw)&&Number(raw)>=1&&Number(raw)<=168?Number(raw):DEFAULT_UNCERTAIN_CALL_HOLD_HOURS;
  return hours*3_600_000;
}
/** A deterministic action id: a replayed sweep finds its own receipt instead of adding another. */
const actionIdFor = (kind:string,id:string) => {
  const h=createHash('sha256').update(`reservation-expiry:${kind}:${id}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-${(8|parseInt(h[16],16)&3).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;
};
const EXPIRY_REFERENCE='hawa:reservation-expiry';

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
  /** A named administrator's session, or the trusted office acting as the office administrator. */
  private async authority(tx:Kysely<Database>,s:Scope):Promise<'named'|'trusted_office'|null> {
    if(s.sessionHash&&await lockNamedOfficeAdministrator(tx,{...s,sessionHash:s.sessionHash}))return 'named';
    return s.trustedOffice&&s.role==='administrator'?'trusted_office':null;
  }
  async get(s:Scope,taskId:string,runId:string) {
    if(!uuid(taskId)||!uuid(runId)) throw new CanvaFlowError(400,'STUDIO_RECOVERY_INVALID','Use the saved task and run IDs.');
    return this.scoped(s,async tx=>{
      const authority=await this.authority(tx,s);
      const state=await this.read(tx,s,taskId,runId);
      const byCall=new Map(state.settlements.flatMap(receipt=>receipt.calls.map(c=>[c.callId,{...c,actorUserId:receipt.actor_user_id,recordedAt:receipt.recorded_at}] as const)));
      const hold=uncertainCallHoldMs();
      return {runId,taskId,status:state.run.status,snapshotHash:state.snapshotHash,
        canSettle:!!authority&&stopped(state.run.status)&&state.unresolved.length>0,
        requiresStop:!stopped(state.run.status),unresolvedCalls:state.unresolved.length,
        settlements:state.settlements.map(view),
        calls:state.calls.map(c=>({id:c.id,ordinal:c.call_ordinal,stage:c.stage,provider:c.provider,model:c.model,status:c.status,
          providerRequestId:c.provider_request_id,responseId:c.response_id,estimatedCostUsd:c.status==='uncertain'?null:Number(c.usd_estimate),
          settlement:byCall.get(c.id)||null,startedAt:c.started_at,finishedAt:c.finished_at,
          // When System Automation charges it in full if nobody records the real charge first (ADR-159).
          ...(c.status==='uncertain'&&!byCall.has(c.id)?{chargedInFullAfter:new Date(new Date(c.started_at).getTime()+hold).toISOString()}:{})}))};
    });
  }
  async settle(s:Scope,taskId:string,runId:string,actionId:unknown,body:unknown) {
    if(!s.sessionHash&&!(s.trustedOffice&&s.role==='administrator'))
      throw new CanvaFlowError(403,'NAMED_ADMINISTRATOR_REQUIRED','Sign in as a named office administrator.');
    // Both recovery operations share the same strict provider-evidence input format.
    const input=parseEvaluationSettlement(body);
    if(!uuid(taskId)||!uuid(runId)||!uuid(actionId)||!input||!input.calls.length)
      throw new CanvaFlowError(400,'STUDIO_SETTLEMENT_INVALID','Supply a current snapshot, reason, and final provider evidence and cost for every unresolved call.');
    const requestHash=digest({taskId,runId,actorId:s.userId,...input});
    return this.scoped(s,async tx=>{
      const authority=await this.authority(tx,s);
      if(!authority)
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
      const evidenceType:EvidenceType=authority==='named'?'administrator_attestation':'trusted_office_attestation';
      if(authority==='named')await sql`SELECT set_config('hawa.studio_settlement_session_hash',${s.sessionHash!},true)`.execute(tx);
      else await sql`SELECT set_config('hawa.studio_settlement_auth','trusted_office',true)`.execute(tx);
      const saved=(await sql<Settlement>`INSERT INTO hawa.studio_run_settlements
        (tenant_id,task_id,client_id,run_id,action_id,actor_user_id,request_hash,snapshot_hash,reason,calls,evidence_type)
        VALUES(${s.tenantId}::uuid,${taskId}::uuid,${state.run.client_id}::uuid,${runId}::uuid,${actionId}::uuid,
          ${s.userId}::uuid,${requestHash},${input.expectedSnapshot},${input.reason},${JSON.stringify(input.calls)}::jsonb,${evidenceType})
        RETURNING *`.execute(tx)).rows[0];
      return {replayed:false,settlement:view(saved)};
    });
  }

  /**
   * ADR-159: charges every call that has had no provider outcome for `holdMs` its whole reservation,
   * as System Automation, recorded as evidence. A Studio run is settled once it has stopped and all
   * its unresolved calls are that old (the settlement unblocks its task); a planner call gets a cost
   * attestation (its plan still has to be abandoned or failed before the task plans again).
   * Idempotent: each receipt has a fixed action id. Returns what it charged.
   */
  async settleExpired(tenantId:string,holdMs:number=uncertainCallHoldMs()):Promise<{studioRuns:string[];plannerCalls:string[]}> {
    const system={tenantId,userId:SYSTEM_AUTOMATION_USER_ID,role:'operator'};
    const hours=Math.round(holdMs/3_600_000*10)/10;
    const reason=`No provider outcome after ${hours} hours: charged its whole advance reservation (ADR-159).`;
    const studioRuns:string[]=[],plannerCalls:string[]=[];
    const runs=await this.scoped(system,async tx=>(await sql<{run_id:string;task_id:string}>`
      SELECT DISTINCT c.run_id,r.task_id FROM hawa.design_studio_calls c
        JOIN hawa.design_studio_runs r ON r.id=c.run_id AND r.tenant_id=c.tenant_id
      WHERE c.tenant_id=${tenantId}::uuid AND c.status='uncertain' AND c.reservation IS NOT NULL
        AND r.status IN ('abandoned','failed','degraded','transferred')
        AND NOT EXISTS(SELECT 1 FROM hawa.studio_run_settlements s WHERE s.tenant_id=c.tenant_id AND s.run_id=c.run_id
          AND s.calls @> jsonb_build_array(jsonb_build_object('callId',c.id::text)))
      ORDER BY c.run_id LIMIT 200`.execute(tx)).rows);
    for(const {run_id:runId,task_id:taskId} of runs){
      const done=await this.scoped(system,async tx=>{
        const state=await this.read(tx,system,taskId,runId);
        if(!stopped(state.run.status)||!state.unresolved.length)return false;
        const rows=(await sql<{id:string;row:unknown;reserved:string;estimate:string;old:boolean}>`
          SELECT id,to_jsonb(c) AS row,(reservation->>'usd') AS reserved,usd_estimate AS estimate,
            started_at<=clock_timestamp()-${`${Math.floor(holdMs/1000)} seconds`}::interval AS old
          FROM hawa.design_studio_calls c WHERE tenant_id=${tenantId}::uuid AND run_id=${runId}::uuid
            AND id=ANY(${state.unresolved.map(c=>c.id)}::uuid[])`.execute(tx)).rows;
        // A run is settled whole: one younger call keeps all of it for the office until it is old too.
        if(rows.length!==state.unresolved.length||rows.some(r=>!r.old||r.reserved===null))return false;
        const calls=rows.map(r=>({callId:r.id,conclusion:'reservation_charged',
          reportedCostUsd:Math.max(Number(r.reserved),Number(r.estimate)),evidenceReference:EXPIRY_REFERENCE,
          evidenceSha256:digest(r.row)})).sort((a,b)=>a.callId.localeCompare(b.callId));
        const actionId=actionIdFor('studio-run',`${runId}:${calls.map(c=>c.callId).join(',')}`);
        const already=(await sql`SELECT 1 FROM hawa.studio_run_settlements WHERE tenant_id=${tenantId}::uuid
          AND action_id=${actionId}::uuid`.execute(tx)).rows.length>0;
        if(already)return false;
        await sql`INSERT INTO hawa.studio_run_settlements
          (tenant_id,task_id,client_id,run_id,action_id,actor_user_id,request_hash,snapshot_hash,reason,calls,evidence_type)
          VALUES(${tenantId}::uuid,${taskId}::uuid,${state.run.client_id}::uuid,${runId}::uuid,${actionId}::uuid,
            ${SYSTEM_AUTOMATION_USER_ID}::uuid,${digest({runId,calls})},${state.snapshotHash},${reason},
            ${JSON.stringify(calls)}::jsonb,'reservation_expiry')`.execute(tx);
        return true;
      });
      if(done)studioRuns.push(runId);
    }
    const planner=await this.scoped(system,async tx=>(await sql<{id:string}>`
      SELECT c.id FROM hawa.canva_planner_calls c WHERE c.tenant_id=${tenantId}::uuid AND c.reconciliation_required
        AND c.started_at<=clock_timestamp()-${`${Math.floor(holdMs/1000)} seconds`}::interval
        AND NOT EXISTS(SELECT 1 FROM hawa.call_cost_attestations a WHERE a.tenant_id=c.tenant_id
          AND a.call_kind='canva_planner' AND a.call_id=c.id)
      ORDER BY c.started_at LIMIT 200`.execute(tx)).rows);
    for(const {id} of planner){
      const done=await this.scoped(system,async tx=>{
        const evidence=(await sql<{e:any}>`SELECT hawa.office_call_cost_evidence('canva_planner',${id}::uuid) AS e`.execute(tx)).rows[0]?.e;
        if(!evidence||!evidence.requiresCostEvidence||evidence.reservedUsd===null)return false;
        const charge=Math.max(Number(evidence.reservedUsd),Number(evidence.accountedCostUsd||0));
        await sql`INSERT INTO hawa.call_cost_attestations(tenant_id,call_kind,call_id,revision,action_id,actor_user_id,
            request_hash,snapshot_hash,reason,conclusion,reported_cost_usd,evidence_reference,evidence_sha256,evidence_type)
          VALUES(${tenantId}::uuid,'canva_planner',${id}::uuid,${Number(evidence.revision)+1},${actionIdFor('canva-planner',id)}::uuid,
            ${SYSTEM_AUTOMATION_USER_ID}::uuid,${digest({id,charge})},${evidence.snapshotHash},${reason},'reservation_charged',
            ${charge},${EXPIRY_REFERENCE},${evidence.snapshotHash},'reservation_expiry')
          ON CONFLICT (tenant_id,action_id) DO NOTHING`.execute(tx);
        return true;
      });
      if(done)plannerCalls.push(id);
    }
    return {studioRuns,plannerCalls};
  }
}
