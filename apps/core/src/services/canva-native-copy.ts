import { createHash, randomUUID } from 'node:crypto';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { canRetryCanvaCreation, type CanvaCreationFailureEvidence } from '@hawa/domain';
import { CanvaHttpError, canvaRequestNeverSent, prepareCanvaTextAutofillCopy,
  type CanvaConnectClient, type CanvaTextAutofillCopyParams, type CanvaTextAutofillCopyResponse } from '@hawa/integrations';
import { CanvaFlowError } from './canva-flow-error.js';
import { lockNativeRecovery, type NativeActorScope } from './lifecycle-native-scope.js';
import { nativeRevisionHandoff } from './native-revision-handoff.js';
import { assertTaskGenerationAllowed } from './task-generation-guard.js';

export interface NativeTextCopyRequest {
  expectedTaskVersion: number;
  basisSha256: string;
  nativeUpdatedAt: number;
  text: Record<string, string>;
}
type Basis = { sourceDesignId: string; title: string; clientId: string; basisSha256: string; taskVersion: number };
type Operation = {
  id: string; actor_id: string; client_id: string; request_hash: string; status: string;
  remote_job_id: string | null; design_id: string | null;
  metadata: { method?: string; failureEvidence?: CanvaCreationFailureEvidence;
    nativeTextCopy?: { schemaVersion: 1; basis: Basis; input: NativeTextCopyRequest; requestId: string; rev: number; prepared: CanvaTextAutofillCopyParams } };
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(code: string, message: string, status = 409): never { throw new CanvaFlowError(status, code, message); }

/** Candidate preparation only; RequestLifecycle and existing review retain all task authority. */
export class CanvaNativeCopyService {
  constructor(private db: Kysely<Database>, private authorize: (scope: NativeActorScope) => Promise<CanvaConnectClient>) {}

  private tx<T>(s: NativeActorScope, fn: (db: Kysely<Database>) => Promise<T>) {
    return withRlsContext(this.db, {tenantId:s.tenantId,userId:s.actorId,role:s.role || 'operator'},fn);
  }
  private outcome(op: Operation) {
    return {operationId:op.id,status:op.status,designId:op.design_id,remoteJobId:op.remote_job_id,
      contentStatus:'unverified_native_copy' as const,preservation:'unverified' as const,approvalReady:false as const};
  }
  private async operation(s: NativeActorScope, taskId: string, id: string): Promise<Operation> {
    const op=await this.tx(s,async db=>(await sql<Operation>`SELECT o.* FROM hawa.canva_remote_operations o
      JOIN hawa.tasks t ON t.tenant_id=o.tenant_id AND t.id=o.task_id AND t.client_id=o.client_id
      WHERE o.tenant_id=${s.tenantId}::uuid AND o.task_id=${taskId}::uuid AND o.id=${id}::uuid`.execute(db)).rows[0]);
    if(!op || op.actor_id!==s.actorId || op.metadata.method!=='native_text_copy' || !op.metadata.nativeTextCopy)
      fail('CANVA_NATIVE_COPY_NOT_FOUND','Native copy operation not found',404);
    return op;
  }
  private async basis(db: Kysely<Database>, s: NativeActorScope, taskId: string, input: NativeTextCopyRequest): Promise<Basis> {
    await lockNativeRecovery(db,s,taskId);
    const task=(await sql<{client_id:string;title:string;state:string}>`SELECT client_id,title,state FROM hawa.tasks
      WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db)).rows[0];
    if(!task)fail('CANVA_TASK_NOT_FOUND','Task not found',404);
    assertTaskGenerationAllowed(task.state);
    const handoff=await nativeRevisionHandoff(db,s.tenantId,taskId);
    if(!handoff?.available || !handoff.parentDesignId || !handoff.parentBindingId || handoff.bindingId)
      fail('CANVA_NATIVE_COPY_BASIS_REQUIRED','Use an unbound current manual revision with an available parent design');
    // Freeze parent database basis through claim commit. This cannot fence native Canva edits.
    await sql`SELECT id FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${handoff.parentTaskId}::uuid FOR SHARE`.execute(db);
    await sql`SELECT id FROM hawa.canva_bindings WHERE tenant_id=${s.tenantId}::uuid AND id=${handoff.parentBindingId}::uuid FOR SHARE`.execute(db);
    const current=await nativeRevisionHandoff(db,s.tenantId,taskId);
    if(!current?.available || current.basisSha256!==input.basisSha256 || current.taskVersion!==input.expectedTaskVersion)
      fail('CANVA_NATIVE_COPY_STALE','The parent or current revision changed; inspect it again');
    return {sourceDesignId:handoff.parentDesignId,title:task.title.slice(0,255),clientId:task.client_id,
      basisSha256:input.basisSha256,taskVersion:input.expectedTaskVersion};
  }

  async create(suppliedScope: NativeActorScope, taskId: string, key: string, supplied: NativeTextCopyRequest) {
    if(!uuid.test(taskId) || !/^[A-Za-z0-9_-]{8,128}$/.test(key) || !supplied ||
      !Number.isSafeInteger(supplied.expectedTaskVersion) || supplied.expectedTaskVersion<1 ||
      !/^[a-f0-9]{64}$/.test(supplied.basisSha256) || !Number.isSafeInteger(supplied.nativeUpdatedAt) || supplied.nativeUpdatedAt<0 ||
      !supplied.text || typeof supplied.text!=='object' || Array.isArray(supplied.text)) fail('CANVA_NATIVE_COPY_INVALID','Invalid native copy request',422);
    const s=structuredClone(suppliedScope),input=structuredClone(supplied);
    if(!s.nativeRecovery)fail('LIFECYCLE_OWNED','Use the current manual revision request');
    input.text=Object.fromEntries(Object.entries(input.text).sort(([a],[b])=>a.localeCompare(b,'en')));
    // Validate text bounds before any provider access, using only a synthetic type inventory.
    prepareCanvaTextAutofillCopy({designId:'validation',title:'validation',text:input.text,
      dataset:Object.fromEntries(Object.keys(input.text).map(name=>[name,{type:'text'}]))});
    const requestHash=digest({requestId:s.nativeRecovery.requestId,rev:s.nativeRecovery.rev,input});
    const replay=await this.tx(s,async db=>(await sql<Operation>`SELECT o.* FROM hawa.canva_remote_operations o
      JOIN hawa.tasks t ON t.tenant_id=o.tenant_id AND t.id=o.task_id AND t.client_id=o.client_id
      WHERE o.tenant_id=${s.tenantId}::uuid AND o.task_id=${taskId}::uuid AND o.request_key=${key}`.execute(db)).rows[0]);
    if(replay){
      if(replay.actor_id!==s.actorId || replay.request_hash!==requestHash || replay.metadata.method!=='native_text_copy')
        fail('CANVA_IDEMPOTENCY_CONFLICT','The request key belongs to another operation');
      return this.outcome(replay);
    }
    const initial=await this.tx(s,db=>this.basis(db,s,taskId,input));
    const client=await this.authorize(s);
    const before=(await client.getDesign(initial.sourceDesignId)).design;
    const dataset=(await client.getDesignDataset(initial.sourceDesignId)).dataset;
    const after=(await client.getDesign(initial.sourceDesignId)).design;
    if(before.id!==initial.sourceDesignId || after.id!==before.id || before.updated_at!==input.nativeUpdatedAt ||
      after.updated_at!==before.updated_at || before.page_count!==after.page_count)
      fail('CANVA_NATIVE_COPY_STALE','The native source changed during preparation');
    const prepared:CanvaTextAutofillCopyParams={designId:initial.sourceDesignId,title:initial.title,text:input.text,dataset};
    prepareCanvaTextAutofillCopy(prepared);
    const claim=await this.tx(s,async db=>{
      const current=await this.basis(db,s,taskId,input);
      if(JSON.stringify(current)!==JSON.stringify(initial))fail('CANVA_NATIVE_COPY_STALE','The native source basis changed');
      const ops=(await sql<Operation & {request_key:string}>`SELECT * FROM hawa.canva_remote_operations
        WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid AND (kind='create' OR request_key=${key}) ORDER BY created_at`.execute(db)).rows;
      const own=ops.find(op=>op.request_key===key);
      if(own){
        if(own.actor_id!==s.actorId || own.request_hash!==requestHash || own.metadata.method!=='native_text_copy')
          fail('CANVA_IDEMPOTENCY_CONFLICT','The request key belongs to another operation');
        return {op:own,created:false};
      }
      if(ops.some(op=>!canRetryCanvaCreation(op)))fail('CANVA_CREATE_CONFLICT','Reconcile the original creation before preparing another copy');
      const id=randomUUID();
      const metadata={method:'native_text_copy',nativeTextCopy:{schemaVersion:1,basis:initial,input,
        requestId:s.nativeRecovery!.requestId,rev:s.nativeRecovery!.rev,prepared}};
      const op=(await sql<Operation>`INSERT INTO hawa.canva_remote_operations
        (id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,kind,status,metadata)
        VALUES(${id}::uuid,${s.tenantId}::uuid,${taskId}::uuid,${initial.clientId}::uuid,${s.actorId},${key},${requestHash},'create','creating',${JSON.stringify(metadata)}::jsonb)
        RETURNING *`.execute(db)).rows[0];
      return {op,created:true};
    });
    if(!claim.created)return this.outcome(claim.op);
    let result:CanvaTextAutofillCopyResponse;
    try {result=await client.createTextAutofillCopy(prepared);}
    catch(error){
      const refused=canvaRequestNeverSent(error) || (error instanceof CanvaHttpError && [400,401,403,404,413,415,422,429].includes(error.status));
      const patch=refused?{failureEvidence:{kind:'not_accepted'}}:{reconciliationRequired:true,reconciliationReason:'native_copy_reply_unavailable'};
      await this.tx(s,db=>sql`UPDATE hawa.canva_remote_operations SET status=${refused?'failed':'uncertain'},metadata=metadata||${JSON.stringify(patch)}::jsonb,updated_at=now()
        WHERE tenant_id=${s.tenantId}::uuid AND id=${claim.op.id}::uuid AND status='creating' AND remote_job_id IS NULL`.execute(db));
      return this.outcome(await this.operation(s,taskId,claim.op.id));
    }
    // If persistence fails, the committed claim holds. The request must never be sent again.
    await this.tx(s,db=>sql`UPDATE hawa.canva_remote_operations SET remote_job_id=${result.job.id},status='submitted',
      metadata=(metadata-'reconciliationReason')||'{"reconciliationRequired":false}'::jsonb,updated_at=now()
      WHERE tenant_id=${s.tenantId}::uuid AND id=${claim.op.id}::uuid AND remote_job_id IS NULL AND status IN ('creating','uncertain')`.execute(db));
    await this.settle(s,claim.op.id,result);
    return this.outcome(await this.operation(s,taskId,claim.op.id));
  }

  private async settle(s:NativeActorScope,id:string,result:CanvaTextAutofillCopyResponse) {
    const job=result.job;
    if(job.status==='in_progress')return;
    const failed=job.status==='failed';
    const patch=failed?{failureEvidence:{kind:'provider_failed',remoteJobId:job.id}}:{candidateOnly:true,preservation:'unverified'};
    await this.tx(s,db=>sql`UPDATE hawa.canva_remote_operations SET status=${failed?'failed':'retrieved'},
      design_id=${job.status==='success'?job.result.design.id:null},
      metadata=(metadata-'reconciliationReason')||${JSON.stringify({...patch,reconciliationRequired:false})}::jsonb,updated_at=now()
      WHERE tenant_id=${s.tenantId}::uuid AND id=${id}::uuid AND remote_job_id=${job.id}
        AND status IN ('submitted','uncertain') AND design_id IS NULL`.execute(db));
  }
  async reconcile(s:NativeActorScope,taskId:string,id:string) {
    if(!uuid.test(taskId)||!uuid.test(id))fail('CANVA_NATIVE_COPY_NOT_FOUND','Native copy operation not found',404);
    const op=await this.operation(s,taskId,id);
    if(op.status==='retrieved'||canRetryCanvaCreation(op)||!op.remote_job_id)return this.outcome(op);
    try {
      const client=await this.authorize(s);
      const result=await client.getTextAutofillCopyJob(op.remote_job_id,op.metadata.nativeTextCopy!.basis.sourceDesignId);
      await this.settle(s,id,result);
    } catch {
      // A failed read cannot establish a failed remote operation. Keep its original identity.
      await this.tx(s,db=>sql`UPDATE hawa.canva_remote_operations SET status='uncertain',
        metadata=metadata||'{"reconciliationRequired":true,"reconciliationReason":"native_copy_read_unavailable"}'::jsonb,updated_at=now()
        WHERE tenant_id=${s.tenantId}::uuid AND id=${id}::uuid AND status IN ('submitted','uncertain') AND design_id IS NULL`.execute(db));
    }
    return this.outcome(await this.operation(s,taskId,id));
  }
}
