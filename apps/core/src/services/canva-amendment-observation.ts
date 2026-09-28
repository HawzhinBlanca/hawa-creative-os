import type { CanvaAmendmentObservation, CanvaObservation } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { CanvaHttpError, type CanvaConnectClient } from '@hawa/integrations';
import { CanvaFlowError } from './canva-flow-error.js';
import type { NativeActorScope } from './lifecycle-native-scope.js';

type BasisRow={taskVersion:number|string;clientId:string|null;bindingId:string|null;bindingVersion:number|string|null;
  bindingClientId:string|null;designId:string|null;bindingStatus:string|null};

function unavailable<T>(error:unknown,kind:'capabilities'|'dataset'):CanvaObservation<T> {
  if(error instanceof CanvaHttpError){
    if(error.status===403 && kind==='capabilities')return {status:'unknown',code:'CANVA_CAPABILITIES_SCOPE_OR_ACCESS',
      message:'Account capabilities could not be read. Ask the integration administrator to check profile:read permission and account access before reconnecting. This does not establish a subscription limitation.'};
    if(error.status===403)return {status:'forbidden',code:'CANVA_DATASET_ACCESS_REQUIRED',message:'The connected account cannot inspect this design’s fields. Check design access and design:content:read permission.'};
    if(error.status===401)return {status:'unavailable',code:'CANVA_CONNECTION_RECHECK_REQUIRED',message:'Canva refused the connection. Check its status in Settings.'};
    if(error.status===404)return {status:'unavailable',code:'CANVA_OBSERVATION_NOT_FOUND',message:'Canva could not find the requested resource.'};
    if(error.status===429)return {status:'unavailable',code:'CANVA_OBSERVATION_RATE_LIMITED',message:'Canva has limited these reads. Wait before checking again.'};
  }
  return {status:'unknown',code:'CANVA_OBSERVATION_UNVERIFIED',message:'A valid provider observation could not be obtained. Try again after checking the connection.'};
}

export async function inspectCanvaAmendment(
  db:Kysely<Database>,scope:NativeActorScope,taskId:string,authorize:()=>Promise<CanvaConnectClient>,
):Promise<CanvaAmendmentObservation>{
  const basis=()=>withRlsContext(db,{tenantId:scope.tenantId,userId:scope.actorId,role:scope.role||'operator'},async trx=>{
    const row=(await sql<BasisRow>`SELECT t.version AS "taskVersion",t.client_id AS "clientId",b.id AS "bindingId",
      b.version AS "bindingVersion",b.client_id AS "bindingClientId",b.canva_design_id AS "designId",b.status AS "bindingStatus"
      FROM hawa.tasks t LEFT JOIN hawa.canva_bindings b ON b.tenant_id=t.tenant_id AND b.task_id=t.id
      WHERE t.tenant_id=${scope.tenantId}::uuid AND t.id=${taskId}::uuid`.execute(trx)).rows[0];
    if(!row)return undefined;
    const taskVersion=Number(row.taskVersion),bindingVersion=row.bindingVersion===null?null:Number(row.bindingVersion);
    if(!Number.isSafeInteger(taskVersion) || taskVersion<1 ||
      (bindingVersion!==null&&(!Number.isSafeInteger(bindingVersion)||bindingVersion<1)))
      throw new CanvaFlowError(409,'CANVA_OBSERVATION_UNVERIFIED','The task or link version cannot be represented safely');
    return {...row,taskVersion,bindingVersion};
  });
  const initial=await basis();
  if(!initial)throw new CanvaFlowError(404,'CANVA_TASK_NOT_FOUND','Task not found');
  if(!initial.clientId || !initial.bindingId || initial.bindingClientId!==initial.clientId ||
      !initial.designId || initial.bindingVersion===null || initial.bindingStatus!=='bound')
    throw new CanvaFlowError(409,'CANVA_BINDING_REQUIRED','Link a Canva design belonging to this task’s client first');
  const client=await authorize();
  const before=(await client.getDesign(initial.designId)).design;
  if(before.id!==initial.designId)throw new CanvaFlowError(502,'CANVA_DESIGN_MISMATCH','Canva returned a different design');
  const [caps,fields]=await Promise.allSettled([client.getCapabilities(),client.getDesignDataset(initial.designId)]);
  const after=(await client.getDesign(initial.designId)).design;
  const current=await basis();
  // Metadata can detect a change, but cannot prove no concurrent edit occurred.
  if(JSON.stringify(current)!==JSON.stringify(initial) || after.id!==before.id || after.updated_at!==before.updated_at ||
      after.page_count!==before.page_count)
    throw new CanvaFlowError(409,'CANVA_OBSERVATION_STALE','The task, link or Canva design changed during inspection. Check the current design again.');
  if(!Number.isSafeInteger(after.updated_at) || after.updated_at<0)
    throw new CanvaFlowError(502,'CANVA_OBSERVATION_UNVERIFIED','The design has no valid update metadata');
  return {
    observedAt:new Date().toISOString(),nativeAmendmentQualified:false,
    basis:{taskId,clientId:initial.clientId,taskVersion:initial.taskVersion,bindingId:initial.bindingId,
      bindingVersion:initial.bindingVersion,designId:initial.designId,nativeUpdatedAt:after.updated_at,pageCount:after.page_count??null},
    capabilities:caps.status==='fulfilled'?{status:'observed',data:caps.value.capabilities}:unavailable(caps.reason,'capabilities'),
    dataset:fields.status==='fulfilled'?{status:'observed',data:fields.value.dataset}:unavailable(fields.reason,'dataset'),
    limitation:'These reads describe the connected account and named fields at the observed time. They do not qualify automatic edits, preservation of manual work, or protection from concurrent Canva changes.',
  };
}
