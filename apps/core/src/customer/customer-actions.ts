import {inspectCustomerNativeFiles,nativeReviewFingerprint,observeCustomerNativeVersion,type CustomerNativeBundle,type CustomerNativeVersionReader} from './customer-native-review.js';
import {createHash,randomUUID} from 'node:crypto';
import {sql,withRlsContext,OutboxRepository,TaskRepository,type Database,type Kysely} from '@hawa/db';
import {CHANNEL_INGRESS_USER_ID,isCustomerActionCommand,type CustomerActionBody,type CustomerActionCommand,type CustomerActionEvent,type CustomerActionResult} from '@hawa/contracts';
import {customerValueHash,authorizeCustomerWebOpen} from './customer-web-lifecycle.js';
import {LifecycleProjectionConflict,projectLifecycleRequesterRevisionWithIntake} from '../services/lifecycle-projection.js';
import type {WorkspaceMember} from './supabase-member.js';

let activeAcceptanceChecks=0;
export class CustomerActionError extends Error {
 constructor(readonly status:403|404|409|429|503,readonly code:string){super(code);}
}
export interface CustomerActionRow {id:string;tenant_id:string;request_id:string;account_id:string;subject:string;user_id:string;
 client_id:string;task_id:string;expected_rev:string;kind:CustomerActionBody['kind'];body:CustomerActionBody;body_hash:string;created_at:Date}
export async function customerActionReceipt(trx:Kysely<Database>,id:string) {
 const row=(await sql<CustomerActionRow>`SELECT * FROM hawa.customer_web_actions WHERE id=${id}::uuid`.execute(trx)).rows[0];
 if(!row)throw new CustomerActionError(404,'DESIGN_ACTION_NOT_FOUND');
 const event=(await sql<{phase:string;result:CustomerActionResult}>`SELECT phase,result FROM hawa.customer_web_action_events
 WHERE tenant_id=${row.tenant_id}::uuid AND action_id=${id}::uuid ORDER BY CASE phase WHEN 'applied' THEN 3 WHEN 'refused' THEN 2 ELSE 1 END DESC LIMIT 1`.execute(trx)).rows[0];
 return {id:row.id,requestId:row.request_id,kind:row.kind,expectedVersion:Number(row.expected_rev),
  phase:event?.phase ?? 'queued',code:event?.result.code ?? null,createdAt:new Date(row.created_at).toISOString()};
}
export async function admitCustomerAction(trx:Kysely<Database>,tenantId:string,account:{id:string;user_id:string;daily_job_limit:number;concurrent_job_limit:number},member:WorkspaceMember,requestId:string,key:string,body:CustomerActionBody) {
 await sql`SELECT pg_advisory_xact_lock(hashtextextended(${account.id},0))`.execute(trx);
 const web=(await sql<{client_id:string}>`SELECT client_id FROM hawa.customer_web_requests
 WHERE tenant_id=${tenantId}::uuid AND request_id=${requestId}::uuid AND account_id=${account.id}::uuid`.execute(trx)).rows[0];
 if(!web)throw new CustomerActionError(404,'DESIGN_JOB_NOT_FOUND');
 await sql`SELECT hawa.lock_customer_request_access(${web.client_id}::uuid)`.execute(trx);
 const hash=customerValueHash(body),prior=(await sql<CustomerActionRow>`SELECT * FROM hawa.customer_web_actions
 WHERE tenant_id=${tenantId}::uuid AND account_id=${account.id}::uuid AND action_key=${key}`.execute(trx)).rows[0];
 if(prior) {
  if(prior.request_id!==requestId || prior.body_hash!==hash)throw new CustomerActionError(409,'DESIGN_ACTION_KEY_CONFLICT');
  return {action:await customerActionReceipt(trx,prior.id),created:false};
 }
 const basis=(await sql<{task_id:string;request_rev:string;stage:string;automatic:boolean}>`SELECT * FROM hawa.customer_action_basis(${requestId}::uuid)`.execute(trx)).rows[0];
 if(!basis || Number(basis.request_rev)!==body.expectedVersion)throw new CustomerActionError(409,'DESIGN_ACTION_STALE');
 if((['revise','answer'].includes(body.kind) && !basis.automatic) || (body.kind==='cancel' && !['designing','awaiting_answer','manual','in_review'].includes(basis.stage)) ||
  (body.kind==='revise' && !['manual','in_review'].includes(basis.stage)) || (body.kind==='accept' && basis.stage!=='in_review') ||
  (['seen','answer'].includes(body.kind) && basis.stage!=='awaiting_answer'))throw new CustomerActionError(409,'DESIGN_ACTION_WRONG_STAGE');
 const pending=(await sql`SELECT a.id FROM hawa.customer_web_actions a WHERE a.tenant_id=${tenantId}::uuid AND a.request_id=${requestId}::uuid
 AND NOT EXISTS(SELECT 1 FROM hawa.customer_web_action_events e WHERE e.tenant_id=a.tenant_id AND e.action_id=a.id AND e.phase IN ('applied','refused')) LIMIT 1`.execute(trx)).rows;
 if(pending.length)throw new CustomerActionError(409,'DESIGN_ACTION_PENDING');
 if('messageId' in body)await currentCustomerQuestion(trx,tenantId,requestId,basis.task_id,body.expectedVersion,body.messageId);
 const usage=(await sql<{all_count:string;design_count:string}>`SELECT count(*) AS all_count,count(*) FILTER(WHERE kind IN ('revise','answer')) AS design_count
 FROM hawa.customer_web_actions WHERE tenant_id=${tenantId}::uuid AND account_id=${account.id}::uuid AND created_at>now()-interval '1 day'`.execute(trx)).rows[0];
 if(Number(usage.all_count)>=200)throw new CustomerActionError(429,'DESIGN_ACTION_LIMIT');
 if(body.kind==='accept') {
  if((await sql<{a:unknown}>`SELECT hawa.customer_current_acceptance(${requestId}::uuid) AS a`.execute(trx)).rows[0]?.a)
   throw new CustomerActionError(409,'DESIGN_ALREADY_APPROVED');
  const row=(await sql<CustomerNativeBundle>`SELECT * FROM hawa.customer_native_review(${requestId}::uuid,${body.previewId}::uuid,
    ${body.expectedVersion}::bigint,${body.previewSha256},false)`.execute(trx)).rows[0];
  if(!row || !matchesAcceptedFiles(body,row))throw new CustomerActionError(409,'DESIGN_ACCEPTANCE_STALE');
 }
 if(['revise','answer'].includes(body.kind)) {
  // Only a currently accepted request releases a slot; this new action reserves it.
  const accepted=(await sql<{a:unknown}>`SELECT hawa.customer_current_acceptance(${requestId}::uuid) AS a`.execute(trx)).rows[0]?.a;
  if(accepted) {
   const counts=(await sql<{concurrent:number}>`SELECT * FROM hawa.customer_job_counts()`.execute(trx)).rows[0];
   if(counts.concurrent>=account.concurrent_job_limit)throw new CustomerActionError(429,'DESIGN_CONCURRENCY_LIMIT');
  }
  const originals=(await sql<{n:string}>`SELECT count(*) AS n FROM hawa.customer_web_requests WHERE tenant_id=${tenantId}::uuid
  AND account_id=${account.id}::uuid AND created_at>now()-interval '1 day'`.execute(trx)).rows[0];
  if(Number(originals.n)+Number(usage.design_count)>=account.daily_job_limit)throw new CustomerActionError(429,'DESIGN_REQUEST_LIMIT');
 }
 const id=randomUUID();
 await sql`INSERT INTO hawa.customer_web_actions(id,tenant_id,request_id,account_id,subject,user_id,client_id,task_id,expected_rev,action_key,kind,body,body_hash)
 VALUES(${id}::uuid,${tenantId}::uuid,${requestId}::uuid,${account.id}::uuid,${member.subject}::uuid,${account.user_id}::uuid,
 ${web.client_id}::uuid,${basis.task_id}::uuid,${body.expectedVersion},${key},${body.kind},${JSON.stringify(body)}::jsonb,${hash})`.execute(trx);
 await new OutboxRepository(trx).enqueue({tenantId,aggregateType:'request',aggregateId:requestId,commandType:'customer.request.action',
 idempotencyKey:`customer:${account.id}:action:${key}`,payload:{v:1,requestId,accountId:account.id,actionId:id}},trx);
 return {action:await customerActionReceipt(trx,id),created:true};
}
async function currentCustomerQuestion(trx:Kysely<Database>,tenantId:string,requestId:string,taskId:string,rev:number,messageId:string) {
 const m=(await sql<{question:{questionId:string}}>`SELECT payload->'onSent' AS question FROM hawa.customer_web_messages
 WHERE tenant_id=${tenantId}::uuid AND request_id=${requestId}::uuid AND id=${messageId}::uuid
 AND payload->'onSent'->>'kind'='question' AND payload->'onSent'->>'requestId'=${requestId}
 AND payload->'onSent'->>'taskId'=${taskId} AND payload->'onSent'->>'requestRev'=${String(rev)}`.execute(trx)).rows[0];
 if(!m)throw new CustomerActionError(409,'DESIGN_QUESTION_STALE');
 return m.question;
}
/** Called inside the real projection transaction; source refs never confer authority. */
export async function authorizeCustomerAction(trx:Kysely<Database>,tenantId:string,actionId:string) {
 const a=(await sql<CustomerActionRow>`SELECT * FROM hawa.customer_web_actions WHERE tenant_id=${tenantId}::uuid AND id=${actionId}::uuid`.execute(trx)).rows[0];
 if(!a || customerValueHash(a.body)!==a.body_hash || a.body.kind!==a.kind || a.body.expectedVersion!==Number(a.expected_rev))
  throw new CustomerActionError(403,'DESIGN_ACTION_INVALID');
 const web=await authorizeCustomerWebOpen(trx,tenantId,a.request_id,['revise','answer'].includes(a.kind));
 if(web.owner.accountId!==a.account_id || web.owner.userId!==a.user_id || web.receipt.subject!==a.subject || web.receipt.client_id!==a.client_id)
  throw new CustomerActionError(403,'DESIGN_ACTION_INVALID');
 return {action:a,web};
}
async function checkedCommand(trx:Kysely<Database>,refs:CustomerActionCommand) {
 if(!isCustomerActionCommand(refs))throw new CustomerActionError(403,'DESIGN_ACTION_INVALID');
 const a=(await sql<CustomerActionRow>`SELECT a.* FROM hawa.customer_web_actions a JOIN hawa.outbox_commands o ON o.tenant_id=a.tenant_id
 AND o.aggregate_id=a.request_id WHERE a.tenant_id=${refs.tenantId}::uuid AND a.id=${refs.actionId}::uuid
 AND a.request_id=${refs.requestId}::uuid AND a.account_id=${refs.accountId}::uuid AND o.id=${refs.commandId}::uuid
 AND o.command_type='customer.request.action' AND o.aggregate_type='request' AND o.idempotency_key=${refs.key}
 AND o.payload=jsonb_build_object('v',1,'requestId',a.request_id::text,'accountId',a.account_id::text,'actionId',a.id::text)`.execute(trx)).rows[0];
 if(!a)throw new CustomerActionError(403,'DESIGN_ACTION_INVALID');
 return a;
}
export async function customerActionEvent(db:Kysely<Database>,refs:CustomerActionCommand):Promise<CustomerActionEvent> {
 return withRlsContext(db,{tenantId:refs.tenantId,userId:CHANNEL_INGRESS_USER_ID,role:'operator'},async trx=>{
  const a=await checkedCommand(trx,refs);
  return {...refs,expectedRev:Number(a.expected_rev),taskId:a.task_id,bodyHash:a.body_hash,kind:a.kind};
 });
}
export async function projectCustomerAction(db:Kysely<Database>,event:CustomerActionEvent,basis:{taskId:string;rev:number;stage:string;round:number;questionId?:string},reader?:CustomerNativeVersionReader):Promise<CustomerActionResult> {
 if(event.kind==='accept') {if(activeAcceptanceChecks>=2)throw new CustomerActionError(503,'DESIGN_ACCEPTANCE_BUSY');activeAcceptanceChecks++;}
 try {
 const check=event.kind==='accept' ? await prepareCustomerAcceptance(db,event,reader) : undefined;
 if(check?.prior)return check.prior;
 return await withRlsContext(db,{tenantId:event.tenantId,userId:CHANNEL_INGRESS_USER_ID,role:'operator'},async trx=>{
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle:${event.requestId}`},0))`.execute(trx);
  const a=await checkedCommand(trx,event);
  if(event.bodyHash!==a.body_hash || event.kind!==a.kind || event.taskId!==a.task_id || event.expectedRev!==Number(a.expected_rev))throw new CustomerActionError(403,'DESIGN_ACTION_INVALID');
  const prior=(await sql<{result:CustomerActionResult}>`SELECT result FROM hawa.customer_web_action_events WHERE tenant_id=${event.tenantId}::uuid
  AND action_id=${a.id}::uuid AND phase IN ('projected','refused') LIMIT 1`.execute(trx)).rows[0];
  if(prior)return prior.result;
  const base={v:1 as const,actionId:a.id,requestId:a.request_id,kind:a.kind};
  let result:CustomerActionResult;
  await sql`SAVEPOINT customer_action_authorization`.execute(trx);
  try {
   await authorizeCustomerAction(trx,event.tenantId,a.id);
   await sql`RELEASE SAVEPOINT customer_action_authorization`.execute(trx);
  } catch(error) {
   await sql`ROLLBACK TO SAVEPOINT customer_action_authorization`.execute(trx);
   if(error instanceof CustomerActionError || error instanceof LifecycleProjectionConflict || (error && typeof error==='object' && 'code' in error && error.code==='42501')) {
    result={...base,accepted:false,code:'DESIGN_ACCESS_DENIED'};
    await saveActionEvent(trx,event.tenantId,a.id,'refused',result);return result;
   }
   throw error;
  }
  const r=await trx.selectFrom('requests').selectAll().where('tenant_id','=',event.tenantId).where('request_id','=',a.request_id).forUpdate().executeTakeFirst();
  let question:{questionId:string}|undefined;
  if(r && Number(r.rev)===Number(a.expected_rev) && 'messageId' in a.body) {
    try {question=await currentCustomerQuestion(trx,event.tenantId,a.request_id,a.task_id,Number(r.rev),a.body.messageId);}
    catch(error) {
      if(!(error instanceof CustomerActionError))throw error;
      result={...base,accepted:false,code:error.code};await saveActionEvent(trx,event.tenantId,a.id,'refused',result);return result;
    }
  }
  if(!r || r.owner!=='restate' || Number(r.rev)!==Number(a.expected_rev) || r.current_task_id!==a.task_id ||
    basis.rev!==Number(r.rev) || basis.taskId!==r.current_task_id || basis.stage!==r.stage)result={...base,accepted:false,code:'DESIGN_ACTION_STALE'};
  else if(a.kind==='cancel') {
   if(!['designing','awaiting_answer','manual','in_review'].includes(r.stage))result={...base,accepted:false,code:'DESIGN_ACTION_WRONG_STAGE'};
   else {
    const task=await trx.selectFrom('tasks').select(['state','version']).where('tenant_id','=',event.tenantId).where('id','=',a.task_id).forUpdate().executeTakeFirstOrThrow();
    await new TaskRepository(trx).transitionState({tenantId:event.tenantId,taskId:a.task_id,expectedVersion:Number(task.version),
      fromState:task.state,toState:'cancelled',actorType:'user',actorId:a.user_id,reason:(a.body as Extract<CustomerActionBody,{kind:'cancel'}>).reason,
      data:{customerActionId:a.id,scope:'one_time',requestId:a.request_id}},trx);
    await trx.updateTable('requests').set({stage:'cancelled',rev:Number(r.rev)+1,updated_at:new Date()}).where('tenant_id','=',event.tenantId).where('request_id','=',a.request_id).execute();
    result={...base,accepted:true,taskId:a.task_id,rev:Number(r.rev)+1,stage:'cancelled',fromStage:r.stage};
    await trx.insertInto('lifecycle_projections').values({tenant_id:event.tenantId,request_id:a.request_id,rev:result.rev!,
      idempotency_key:`${a.request_id}:${result.rev}:customerAction:${a.id}`,payload_sha256:a.body_hash,result:{...result,withdrawn:true,actor:'requester',officeAlerts:[]}}).execute();
   }
  } else if(a.kind==='accept') {
   const body=a.body as Extract<CustomerActionBody,{kind:'accept'}>;
   if(r.stage!=='in_review')result={...base,accepted:false,code:'DESIGN_ACTION_WRONG_STAGE'};
   else if(check?.code || !check?.fingerprint)result={...base,accepted:false,code:check?.code ?? 'DESIGN_ACCEPTANCE_BLOCKED'};
   else {
    await sql`SAVEPOINT customer_acceptance_commit`.execute(trx);
    try {
     const current=await storedCustomerReview(trx,a,false);
     if(!current || nativeReviewFingerprint(current.basis)!==check.fingerprint || !matchesAcceptedFiles(body,current))
      throw new CustomerActionError(409,'DESIGN_ACCEPTANCE_STALE');
     const rev=Number(r.rev)+1;
     await trx.updateTable('requests').set({rev,updated_at:new Date()}).where('tenant_id','=',event.tenantId).where('request_id','=',a.request_id).execute();
     await sql`INSERT INTO hawa.customer_acceptances(tenant_id,action_id,request_id,account_id,subject,user_id,task_id,accepted_rev,basis,basis_hash)
      VALUES(${event.tenantId}::uuid,${a.id}::uuid,${a.request_id}::uuid,${a.account_id}::uuid,${a.subject}::uuid,${a.user_id}::uuid,
      ${a.task_id}::uuid,${rev},${JSON.stringify(current.basis)}::jsonb,${body.basisSha256})`.execute(trx);
     result={...base,accepted:true,taskId:a.task_id,rev,stage:'in_review'};
     await trx.insertInto('lifecycle_projections').values({tenant_id:event.tenantId,request_id:a.request_id,rev,
       idempotency_key:`${a.request_id}:${rev}:customerAction:${a.id}`,payload_sha256:a.body_hash,
       result:{...result,customerAcceptanceId:a.id}}).execute();
     await sql`RELEASE SAVEPOINT customer_acceptance_commit`.execute(trx);
    } catch(error) {
     await sql`ROLLBACK TO SAVEPOINT customer_acceptance_commit`.execute(trx);
     if(error instanceof CustomerActionError || (error && typeof error==='object' && 'code' in error && error.code==='42501'))
      result={...base,accepted:false,code:'DESIGN_ACCEPTANCE_STALE'};
     else throw error;
    }
   }
  } else if(a.kind==='seen') {
   const body=a.body as Extract<CustomerActionBody,{kind:'seen'}>;
   const q=question!;
   if(r.stage!=='awaiting_answer' || basis.questionId!==q.questionId)result={...base,accepted:false,code:'DESIGN_QUESTION_STALE'};
   else {
    const now=Date.now();await trx.updateTable('requests').set({question_asked_at:r.question_asked_at ?? new Date(now),updated_at:new Date()}).where('tenant_id','=',event.tenantId).where('request_id','=',a.request_id).execute();
    result={...base,accepted:true,taskId:a.task_id,rev:Number(r.rev),stage:r.stage,questionId:q.questionId,messageId:body.messageId,seenAtMs:r.question_asked_at ? new Date(r.question_asked_at).getTime() : now};
   }
  } else {
   const body=a.body as Extract<CustomerActionBody,{kind:'revise'|'answer'}>;
   const q=body.kind==='answer' ? question : undefined;
   if((q && (r.stage!=='awaiting_answer' || basis.questionId!==q.questionId)) || (!q && !['manual','in_review'].includes(r.stage)))result={...base,accepted:false,code:'DESIGN_ACTION_WRONG_STAGE'};
   else {
    const source={customerActionId:a.id,body:a.body};
    await sql`SAVEPOINT customer_action_revision`.execute(trx);
    try {
    const projected=await projectLifecycleRequesterRevisionWithIntake(trx,{requestId:a.request_id,tenantId:event.tenantId,priorTaskId:a.task_id,
      expectedRev:Number(r.rev),rev:Number(r.rev)+1,round:basis.round+1,directive:body.directive,rawText:body.directive,
      sourceEventId:`lc-${a.request_id}-web-${a.id}`,sourceChannelId:`web:${a.account_id}`,sourceUpdate:source,
      sourceUpdateHash:createHash('sha256').update(JSON.stringify(source)).digest('hex'),clientId:a.client_id,key:`${a.request_id}:${Number(r.rev)+1}:customerAction:${a.id}`,
      customerWebActionId:a.id,...(q ? {questionId:q.questionId} : {})});
    result={...base,accepted:true,taskId:projected.newTaskId,rev:projected.rev,stage:projected.stage,round:projected.round,runId:projected.runId,directive:projected.directive};
    await sql`RELEASE SAVEPOINT customer_action_revision`.execute(trx);
    } catch(error) {
     await sql`ROLLBACK TO SAVEPOINT customer_action_revision`.execute(trx);
     if(error instanceof LifecycleProjectionConflict || error instanceof CustomerActionError) {
      result={...base,accepted:false,code:error instanceof CustomerActionError ? error.code : 'DESIGN_REVISION_UNAVAILABLE'};
     } else throw error;
    }
   }
  }
  await saveActionEvent(trx,event.tenantId,a.id,result.accepted ? 'projected':'refused',result);return result;
 });
 } finally {if(event.kind==='accept')activeAcceptanceChecks--;}
}
async function saveActionEvent(trx:Kysely<Database>,tenantId:string,id:string,phase:string,result:CustomerActionResult) {
 await sql`INSERT INTO hawa.customer_web_action_events(tenant_id,action_id,phase,result) VALUES(${tenantId}::uuid,${id}::uuid,${phase},${JSON.stringify(result)}::jsonb)`.execute(trx);
}
export async function acknowledgeCustomerAction(db:Kysely<Database>,event:CustomerActionEvent,result:CustomerActionResult) {
 return withRlsContext(db,{tenantId:event.tenantId,userId:CHANNEL_INGRESS_USER_ID,role:'operator'},async trx=>{
  const a=await checkedCommand(trx,event);
  if(event.bodyHash!==a.body_hash || event.kind!==a.kind || event.taskId!==a.task_id || event.expectedRev!==Number(a.expected_rev))throw new CustomerActionError(403,'DESIGN_ACTION_INVALID');
  const stored=(await sql<{result:CustomerActionResult}>`SELECT result FROM hawa.customer_web_action_events
  WHERE tenant_id=${event.tenantId}::uuid AND action_id=${a.id}::uuid AND phase='projected'`.execute(trx)).rows[0];
  if(!stored || customerValueHash(stored.result)!==customerValueHash(result))throw new CustomerActionError(403,'DESIGN_ACTION_INVALID');
  await sql`INSERT INTO hawa.customer_web_action_events(tenant_id,action_id,phase,result) VALUES(${event.tenantId}::uuid,${a.id}::uuid,'applied',${JSON.stringify(result)}::jsonb) ON CONFLICT DO NOTHING`.execute(trx);
  return {acknowledged:true};
 });
}

function matchesAcceptedFiles(body:Extract<CustomerActionBody,{kind:'accept'}>,bundle:CustomerNativeBundle) {
 const b=bundle.basis;
 return body.expectedVersion===Number(b.requestVersion) && body.previewId===b.preview.id && body.previewSha256===b.preview.sha256 &&
  body.basisSha256===nativeReviewFingerprint(b) && customerValueHash(body.files)===customerValueHash([
   {...b.preview,format:'png'},{id:b.export.id,sha256:b.export.sha256,size:b.export.size,format:'pptx'}]);
}
/** Only a verified stored action establishes this scope; caller-provided identities never do. */
async function storedCustomerReview(trx:Kysely<Database>,a:CustomerActionRow,bytes:boolean) {
 if(a.body.kind!=='accept')throw new CustomerActionError(403,'DESIGN_ACTION_INVALID');
 const keys=['app.user_id','hawa.current_user_id','app.role','hawa.current_role','hawa.customer_id','hawa.customer_subject'];
 const old=(await sql<{key:string;value:string}>`SELECT k AS key,COALESCE(current_setting(k,true),'') AS value FROM unnest(${keys}::text[]) k`.execute(trx)).rows;
 await sql`SAVEPOINT customer_native_scope`.execute(trx);
 try {
  const values=[a.user_id,a.user_id,'requester','requester',a.account_id,a.subject];
  for(let i=0;i<keys.length;i++)await sql`SELECT set_config(${keys[i]},${values[i]},true)`.execute(trx);
  const b=a.body;
  const row=(await sql<CustomerNativeBundle>`SELECT * FROM hawa.customer_native_review_for_action(${a.request_id}::uuid,
   ${b.previewId}::uuid,${b.expectedVersion}::bigint,${b.previewSha256},${bytes},${a.id}::uuid)`.execute(trx)).rows[0];
  for(const v of old)await sql`SELECT set_config(${v.key},${v.value},true)`.execute(trx);
  await sql`RELEASE SAVEPOINT customer_native_scope`.execute(trx);
  return row;
 } catch(error) {await sql`ROLLBACK TO SAVEPOINT customer_native_scope`.execute(trx);throw error;}
}
async function prepareCustomerAcceptance(db:Kysely<Database>,event:CustomerActionEvent,reader?:CustomerNativeVersionReader):Promise<{prior?:CustomerActionResult;code?:string;fingerprint?:string}> {
 const read=await withRlsContext(db,{tenantId:event.tenantId,userId:CHANNEL_INGRESS_USER_ID,role:'operator'},async trx=>{
  const a=await checkedCommand(trx,event);
  if(event.bodyHash!==a.body_hash || event.kind!==a.kind || event.taskId!==a.task_id || event.expectedRev!==Number(a.expected_rev))
   throw new CustomerActionError(403,'DESIGN_ACTION_INVALID');
  const prior=(await sql<{result:CustomerActionResult}>`SELECT result FROM hawa.customer_web_action_events
   WHERE tenant_id=${event.tenantId}::uuid AND action_id=${a.id}::uuid AND phase IN ('projected','refused') LIMIT 1`.execute(trx)).rows[0];
  if(prior)return {prior:prior.result};
  await authorizeCustomerAction(trx,event.tenantId,a.id);
  return {action:a,bundle:await storedCustomerReview(trx,a,true)};
 }).catch(error=>{
  if(error instanceof CustomerActionError || error instanceof LifecycleProjectionConflict || (error && typeof error==='object' && 'code' in error && error.code==='42501'))return {code:'DESIGN_ACCESS_DENIED'};
  throw error;
 });
 if('prior' in read)return {prior:read.prior};
 if('code' in read)return {code:read.code};
 if(!read.bundle || read.action.body.kind!=='accept' || !matchesAcceptedFiles(read.action.body,read.bundle))return {code:'DESIGN_ACCEPTANCE_STALE'};
 const reasons=await inspectCustomerNativeFiles(read.bundle);
 if(reasons.length)return {code:'DESIGN_ACCEPTANCE_BLOCKED'};
 const observed=await observeCustomerNativeVersion(reader,event.tenantId,read.bundle.basis);
 if(observed)return {code:observed==='NATIVE_DESIGN_CHANGED' ? 'DESIGN_ACCEPTANCE_STALE':'DESIGN_NATIVE_CHECK_UNAVAILABLE'};
 return {fingerprint:nativeReviewFingerprint(read.bundle.basis)};
}
