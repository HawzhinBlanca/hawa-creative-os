import {sql,withRlsContext,type Database,type Kysely} from '@hawa/db';
import {auditPublicationReceipts} from '@hawa/domain';
import {parseReceiptAuditAction,publicationAwareTaskStatus,type ReceiptAuditScope,type ReceiptAuditState,
  type StoredReceiptAudit,type ReceiptAuditResult,type TaskRecord,type DriveRecord,type SheetRowRecord,type ReconciliationReport} from '@hawa/contracts';

export type AuditActor={tenantId:string;userId:string;role:string};
export class ReceiptAuditError extends Error {
  constructor(public status:400|403|409|503,public code:string,message:string){super(message);}
}
const fail=(status:400|403|409|503,code:string,message:string):never=>{throw new ReceiptAuditError(status,code,message);};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
type AuditRow={id:string;actor_user_id:string;revision:number;reason:string;scope_sha256:string;inputs_sha256:string;report_sha256:string;request:unknown;report:ReconciliationReport};
const view=(r:AuditRow):StoredReceiptAudit=>({...r.report,simulated:false,revision:r.revision,actorUserId:r.actor_user_id,reason:r.reason,
  scopeSha256:r.scope_sha256,inputsSha256:r.inputs_sha256,reportSha256:r.report_sha256});
async function scopeOf(tx:Kysely<Database>):Promise<ReceiptAuditScope>{
  const scope=(await sql<{scope:ReceiptAuditScope|null}>`SELECT hawa.receipt_audit_scope() AS scope`.execute(tx)).rows[0]?.scope;
  if(!scope)return fail(403,'RECEIPT_AUDIT_FORBIDDEN','An active office membership is required to read or record an audit.');
  return scope;
}
function expectedFiles(value:unknown):TaskRecord['expectedFiles'] {
  if(!object(value)||!Array.isArray(value.files)||value.files.length===0)return null;
  const files:Array<{name:string;sha256:string;size:number}>=[];
  for(const f of value.files){
    if(!object(f)||typeof f.name!=='string'||!f.name||typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256)||
      typeof f.size!=='number'||!Number.isSafeInteger(f.size)||f.size<0)return null;
    files.push({name:f.name,sha256:f.sha256,size:f.size});
  }
  return files;
}
async function inputsOf(tx:Kysely<Database>,actor:AuditActor){
  const rows=(await sql<{id:string;state:Database['tasks']['state'];client_id:string|null;current_design_revision_id:string|null;updated_at:Date;
    publication_id:string|null;package_sha256:string|null;package_manifest:unknown;delivery_error_class:string|null}>`
    SELECT t.id,t.state,t.client_id,t.current_design_revision_id,t.updated_at,p.id AS publication_id,p.package_sha256,p.package_manifest,
      CASE WHEN EXISTS(SELECT 1 FROM hawa.publications unresolved WHERE unresolved.tenant_id=t.tenant_id AND unresolved.task_id=t.id
        AND unresolved.error_class='ARCHIVE_UNCONFIRMED') THEN 'ARCHIVE_UNCONFIRMED' ELSE p.error_class END AS delivery_error_class
    FROM hawa.tasks t LEFT JOIN LATERAL(SELECT p.* FROM hawa.publications p WHERE p.tenant_id=t.tenant_id AND p.task_id=t.id
      AND p.design_revision_id=t.current_design_revision_id ORDER BY p.created_at DESC,p.id DESC LIMIT 1) p ON true
    WHERE t.tenant_id=${actor.tenantId}::uuid ORDER BY t.id`.execute(tx)).rows;
  const ids=rows.flatMap(r=>r.publication_id?[r.publication_id]:[]);
  const files=ids.length?(await sql<DriveRecord>`SELECT p.task_id::text AS "taskId",d.file_id AS "fileId",d.folder_id AS "folderId",
    d.file_name AS name,d.expected_sha256 AS sha256,d.observed_size::float8 AS "byteSize"
    FROM hawa.drive_refs d JOIN hawa.publications p ON p.id=d.publication_id AND p.tenant_id=d.tenant_id
    WHERE p.tenant_id=${actor.tenantId}::uuid AND p.id=ANY(${ids}::uuid[]) AND d.status='verified' ORDER BY p.task_id,d.id`.execute(tx)).rows:[];
  const sheets=ids.length?(await sql<SheetRowRecord>`SELECT p.task_id::text AS "taskId",s.row_number::float8 AS "rowNumber",
    'COMPLETE' AS status,p.package_sha256 AS "packageHash",coalesce(s.synced_at,s.updated_at)::text AS "syncedAt",
    s.expected_hash AS "expectedRowHash",s.observed_hash AS "observedRowHash"
    FROM hawa.sheet_syncs s JOIN hawa.publications p ON p.id=s.publication_id AND p.tenant_id=s.tenant_id AND p.task_id=s.task_id
    WHERE p.tenant_id=${actor.tenantId}::uuid AND p.id=ANY(${ids}::uuid[]) AND s.status='synced' AND s.row_number IS NOT NULL
    ORDER BY p.task_id,s.synced_at,s.updated_at,s.id`.execute(tx)).rows:[];
  const tasks:TaskRecord[]=rows.map(t=>({id:t.id,status:publicationAwareTaskStatus(t.state,{errorClass:t.delivery_error_class}),
    publicationErrorClass:t.delivery_error_class,clientId:t.client_id||undefined,latestRevisionId:t.current_design_revision_id||undefined,
    packageHash:t.package_sha256||undefined,expectedFiles:expectedFiles(t.package_manifest),updatedAt:new Date(t.updated_at).toISOString()}));
  return {tasks,driveFiles:files,sheetRows:sheets};
}
export class ReceiptAuditService {
  constructor(private db:Kysely<Database>){}
  async get(actor:AuditActor,beforeRevision?:string):Promise<ReceiptAuditState>{
    const before=beforeRevision===undefined?null:Number(beforeRevision);
    if(before!==null&&(!/^\d+$/.test(beforeRevision!)||!Number.isSafeInteger(before)||before<1||before>2147483647))
      return fail(400,'RECEIPT_AUDIT_INVALID','Reload the first page of audit history.');
    return this.db.transaction().setIsolationLevel('repeatable read').execute(tx=>withRlsContext(tx,actor,async tx=>{
      const scope=await scopeOf(tx);
      const latest=(await sql<AuditRow>`SELECT * FROM hawa.receipt_audits WHERE tenant_id=${actor.tenantId}::uuid AND actor_user_id=${actor.userId}::uuid
        AND scope_sha256=${scope.sha256} ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
      const history=(await sql<AuditRow>`SELECT * FROM hawa.receipt_audits WHERE tenant_id=${actor.tenantId}::uuid AND actor_user_id=${actor.userId}::uuid
        AND scope_sha256=${scope.sha256} AND (${before}::integer IS NULL OR revision<${before}::integer) ORDER BY revision DESC LIMIT 21`.execute(tx)).rows;
      return {schemaVersion:1,tenantId:actor.tenantId,userId:actor.userId,scope,latest:latest?view(latest):null,
        history:history.slice(0,20).map(view),nextBeforeRevision:history.length>20?history[19].revision:null};
    }));
  }
  async record(actor:AuditActor,body:unknown):Promise<ReceiptAuditResult>{
    const action=parseReceiptAuditAction(body);
    if(!action)return fail(400,'RECEIPT_AUDIT_INVALID','Supply an audit action ID, current scope and predecessor, and a reason.');
    for(let attempt=0;attempt<3;attempt++){
      try{return await this.db.transaction().setIsolationLevel('serializable').execute(tx=>withRlsContext(tx,actor,async tx=>{
        const scope=await scopeOf(tx);
        if(scope.sha256!==action.expectedScopeSha256)return fail(409,'RECEIPT_AUDIT_SCOPE_CHANGED','Your authorized client scope changed. Reload the audit view.');
        const saved=(await sql<AuditRow>`SELECT * FROM hawa.receipt_audits WHERE tenant_id=${actor.tenantId}::uuid AND actor_user_id=${actor.userId}::uuid AND id=${action.actionId}::uuid`.execute(tx)).rows[0];
        if(saved){
          const same=(await sql<{same:boolean}>`SELECT ${JSON.stringify(saved.request)}::jsonb=${JSON.stringify(action)}::jsonb AS same`.execute(tx)).rows[0].same;
          if(!same)return fail(409,'RECEIPT_AUDIT_ACTION_CONFLICT','This action already belongs to a different audit request. Retry its original inputs.');
          return {...view(saved),replayed:true};
        }
        const previous=(await sql<AuditRow>`SELECT * FROM hawa.receipt_audits WHERE tenant_id=${actor.tenantId}::uuid AND actor_user_id=${actor.userId}::uuid
          AND scope_sha256=${scope.sha256} ORDER BY revision DESC LIMIT 1`.execute(tx)).rows[0];
        if((previous?.id??null)!==action.expectedLatestAuditId)return fail(409,'RECEIPT_AUDIT_CHANGED','A newer audit was recorded. Reload before starting another audit.');
        const inputs=await inputsOf(tx,actor);
        const timestamp=new Date((await sql<{at:Date}>`SELECT date_trunc('milliseconds',transaction_timestamp()) AS at`.execute(tx)).rows[0].at).toISOString();
        const report=auditPublicationReceipts(inputs.tasks,inputs.driveFiles,inputs.sheetRows,{auditId:action.actionId,timestamp});
        const row=(await sql<AuditRow>`INSERT INTO hawa.receipt_audits(tenant_id,actor_user_id,id,scope_sha256,revision,previous_audit_id,
          reason,request,request_sha256,scope,inputs,inputs_sha256,report,report_sha256,recorded_at)
          VALUES(${actor.tenantId}::uuid,${actor.userId}::uuid,${action.actionId}::uuid,${scope.sha256},${(previous?.revision??0)+1},${action.expectedLatestAuditId}::uuid,
            ${action.reason},${JSON.stringify(action)}::jsonb,${'0'.repeat(64)},${JSON.stringify(scope)}::jsonb,${JSON.stringify(inputs)}::jsonb,${'0'.repeat(64)},
            ${JSON.stringify(report)}::jsonb,${'0'.repeat(64)},${timestamp}::timestamptz) RETURNING *`.execute(tx)).rows[0];
        return {...view(row),replayed:false};
      }));}catch(error){
        const code=object(error)?error.code:undefined;
        if(['40001','40P01','23505'].includes(String(code))&&attempt<2)continue;
        if(code==='23505'&&object(error)&&error.constraint==='receipt_audits_pkey')return fail(409,'RECEIPT_AUDIT_ACTION_CONFLICT','This action identity is already bound to another authorized scope or request.');
        if(['40001','40P01','23505'].includes(String(code)))return fail(409,'RECEIPT_AUDIT_BUSY','Another audit or authorization change is in progress. Retry the saved action.');
        throw error;
      }
    }
    return fail(503,'RECEIPT_AUDIT_UNAVAILABLE','The audit could not be recorded. Retry the saved action.');
  }
}
