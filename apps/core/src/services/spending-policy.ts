import { sql, withRlsContext, type Kysely, type Database, type RlsContext } from '@hawa/db';
import { parseSpendingPolicyChange } from '@hawa/domain';
import type { SpendingPolicyDetail, SpendingPolicyRevision, SpendingPolicyResult } from '@hawa/contracts';
import { lockNamedOfficeAdministrator } from './named-review-authority.js';
import { CanvaFlowError } from './canva-flow-error.js';

type Scope = RlsContext & { userId:string; sessionHash?:string };
const fail = (status:number,code:string,message:string):never => { throw new CanvaFlowError(status,code,message); };
export class SpendingPolicyService {
  constructor(private db:Kysely<Database>) {}
  async get(s:Scope,beforeVersion?:string):Promise<SpendingPolicyDetail> {
    const before=beforeVersion===undefined?null:Number(beforeVersion);
    if(before!==null&&(!/^\d+$/.test(beforeVersion!)||!Number.isSafeInteger(before)||before<1||before>2147483647))
      return fail(400,'SPENDING_POLICY_INVALID','Reload the first page of policy history.');
    return withRlsContext(this.db,s,async tx=>{
      const canEdit=!!s.sessionHash&&await lockNamedOfficeAdministrator(tx,{...s,sessionHash:s.sessionHash});
      // Same ordering as the writer: authority, then spending. Current policy and usage
      // must be from one serial point even when another administrator is changing limits.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`studio-spending:${s.tenantId}`},0))`.execute(tx);
      const current=(await sql<{p:SpendingPolicyRevision}>`SELECT hawa.spending_policy_view(p) AS p
        FROM hawa.studio_spending_policies p WHERE tenant_id=${s.tenantId}::uuid ORDER BY version DESC LIMIT 1`.execute(tx)).rows[0]?.p;
      if(!current)return fail(404,'SPENDING_POLICY_NOT_FOUND','No spending policy is available for this account.');
      const history=(await sql<{p:SpendingPolicyRevision}>`SELECT hawa.spending_policy_view(p) AS p
        FROM hawa.studio_spending_policies p WHERE tenant_id=${s.tenantId}::uuid AND (${before}::integer IS NULL OR version<${before}::integer)
        ORDER BY version DESC LIMIT 21`.execute(tx)).rows.map(r=>r.p);
      const daily=(await sql<{daily:SpendingPolicyDetail['daily']}>`SELECT hawa.office_scope_budget() AS daily`.execute(tx)).rows[0].daily;
      const clients=(await sql<{id:string;name:string}>`SELECT id,name FROM hawa.clients WHERE tenant_id=${s.tenantId}::uuid ORDER BY name,id`.execute(tx)).rows;
      return {tenantId:s.tenantId,userId:s.userId,canEdit,current,history:history.slice(0,20),
        nextBeforeVersion:history.length>20?history[19].version:null,daily,clients};
    });
  }
  async record(s:Scope,actionId:unknown,body:unknown):Promise<SpendingPolicyResult> {
    const input=parseSpendingPolicyChange(body);
    if(!input||typeof actionId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actionId))
      return fail(400,'SPENDING_POLICY_INVALID','Supply the current policy, whole micro-dollar limits, a reason and an action ID.');
    if(!s.sessionHash)return fail(403,'NAMED_ADMINISTRATOR_REQUIRED','Sign in as a named office administrator.');
    try{return await withRlsContext(this.db,s,async tx=>(await sql<{result:SpendingPolicyResult}>`
      SELECT hawa.record_spending_policy(${actionId}::uuid,${s.userId}::uuid,${s.sessionHash},${JSON.stringify(input)}::jsonb) AS result
    `.execute(tx)).rows[0].result);}catch(error){
      const message=error instanceof Error?error.message:'';
      if(message==='SPENDING_POLICY_NAMED_ADMINISTRATOR_REQUIRED')return fail(403,'NAMED_ADMINISTRATOR_REQUIRED','The named administrator session or membership is no longer active.');
      if(message==='SPENDING_POLICY_CHANGED')return fail(409,message,'The policy changed. Reload and review the current limits before proposing a new revision.');
      if(message==='SPENDING_POLICY_ACTION_CONFLICT')return fail(409,message,'This action already records a different proposal. Retry its original inputs.');
      if(message==='SPENDING_POLICY_INVALID'||message.startsWith('Studio policy ')||message==='Invalid Studio spending policy'||message==='Unknown Studio budget role')
        return fail(400,'SPENDING_POLICY_INVALID','Review the limits and select clients belonging to this office.');
      throw error;
    }
  }
}
