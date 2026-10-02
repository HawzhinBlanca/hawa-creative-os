import { customerPhotos } from './customer-photos.js';
import type { CustomerPhotoManifest } from '@hawa/contracts';
import { createHash } from 'node:crypto';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { CHANNEL_INGRESS_USER_ID, isCustomerOpenCommand, type CustomerOpenCommand, type OutboundMessage } from '@hawa/contracts';
import type { ChatIntake } from '../services/chat-intake.js';
import { LifecycleProjectionConflict } from '../services/lifecycle-projection.js';
import type { CustomerDesignRequest } from './customer-requests.js';

export const WEB_CHANNEL = /^web:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function canonicalCustomerValue(value: unknown): string {
  if (Array.isArray(value)) return '['+value.map(canonicalCustomerValue).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([k,v])=>JSON.stringify(k)+':'+canonicalCustomerValue(v)).join(',')+'}';
  return JSON.stringify(value) ?? 'null';
}
export const customerValueHash=(value:unknown)=>createHash('sha256').update(canonicalCustomerValue(value)).digest('hex');
export interface WebReceipt {
  request_id:string;tenant_id:string;account_id:string;subject:string;client_id:string;
  body:CustomerDesignRequest;body_hash:string;dna_version:number;
}

export function customerWebDraft(receipt:WebReceipt,photos?:CustomerPhotoManifest):ChatIntake {
  const body=receipt.body;
  if (body.clientId.toLowerCase()!==receipt.client_id || customerValueHash(body)!==receipt.body_hash)
    throw new LifecycleProjectionConflict('IDEMPOTENCY_CONFLICT','The retained web brief does not match its scope or hash');
  return {platform:'hawzhin_web',sourceEventId:`lc-${receipt.request_id}-r0`,sourceChannelId:`web:${receipt.account_id}`,
    title:body.title,rawText:body.exactCopy.map(b=>b.text).join('\n\n'),designInstructions:body.designInstructions+(body.photoUsage?.mode==='all' ? '\nRequester photo requirement: use all photos.' : body.photoUsage?.mode==='count' ? `\nRequester photo requirement: use exactly ${body.photoUsage.count} photos.` : ''),
    ...(photos ? {customerWebPhotos:photos} : {}),
    exactCopy:body.exactCopy,clientId:receipt.client_id,autoGenerate:true,designStudio:true,
    variant:{square:{width:1080,height:1080},portrait:{width:1080,height:1350},story:{width:1080,height:1920}}[body.variant],
    studioOptions:{tier:'standard',imagery:'auto'}};
}

/** Internal only. Resolve ownership from retained Core evidence, never from a worker's fields. */
export async function authorizeCustomerWebOpen(trx:Kysely<Database>,tenantId:string,requestId:string) {
  const receipt=(await sql<WebReceipt>`SELECT * FROM hawa.customer_web_requests
    WHERE tenant_id=${tenantId}::uuid AND request_id=${requestId}::uuid`.execute(trx)).rows[0];
  if(!receipt) throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR','No retained customer web brief');
  const previous=(await sql<{customer:string;subject:string;user:string;legacyUser:string}>`SELECT
    COALESCE(current_setting('hawa.customer_id',true),'') AS customer,
    COALESCE(current_setting('hawa.customer_subject',true),'') AS subject,
    COALESCE(current_setting('app.user_id',true),'') AS "user",
    COALESCE(current_setting('hawa.current_user_id',true),'') AS "legacyUser"`.execute(trx)).rows[0];
  let failed=false;
  try {
    await sql`SELECT set_config('hawa.customer_id','',true),set_config('hawa.customer_subject',${receipt.subject},true),
      set_config('app.user_id','',true),set_config('hawa.current_user_id','',true)`.execute(trx);
    const account=(await sql<{id:string;user_id:string}>`SELECT id,user_id FROM hawa.customer_accounts
      WHERE id=${receipt.account_id}::uuid AND id=hawa.customer_account_for_subject()`.execute(trx)).rows[0];
    if(!account) throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR','Customer access was revoked before projection');
    await sql`SELECT set_config('hawa.customer_id',${account.id},true),set_config('app.user_id',${account.user_id},true),
      set_config('hawa.current_user_id',${account.user_id},true)`.execute(trx);
    await sql`SELECT hawa.lock_customer_request_access(${receipt.client_id}::uuid)`.execute(trx);
    const dna=(await sql<{version:number}>`SELECT hawa.pin_customer_dna(${receipt.client_id}::uuid) AS version`.execute(trx)).rows[0];
    if(dna.version!==receipt.dna_version) throw new LifecycleProjectionConflict('EVIDENCE_CHANGED','The admitted brand version changed before projection');
    const photos=await customerPhotos(trx,tenantId,account.id,receipt.client_id,receipt.body.photoIds);
    const manifest=photos.length ? {v:1 as const,images:photos.map(({sha256,mediaType,size})=>({sha256,mediaType,size}))} : undefined;
    return {receipt,draft:customerWebDraft(receipt,manifest),owner:{accountId:account.id,userId:account.user_id},dnaVersion:receipt.dna_version};
  } catch(error) {
    failed=true;
    if(error && typeof error==='object' && 'code' in error && error.code==='42501')
      throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR','Customer access was revoked before projection');
    throw error;
  } finally {
    await sql`SELECT set_config('hawa.customer_id',${previous.customer},true),set_config('hawa.customer_subject',${previous.subject},true),
      set_config('app.user_id',${previous.user},true),set_config('hawa.current_user_id',${previous.legacyUser},true)`.execute(trx).catch((error:unknown)=>{if(!failed) throw error;});
  }
}
export async function customerWebOpenEvent(db:Kysely<Database>,tenantId:string,requestId:string,command?:CustomerOpenCommand) {
  return withRlsContext(db,{tenantId,userId:CHANNEL_INGRESS_USER_ID,role:'operator'},async trx=>{
    if(command) {
      if(!isCustomerOpenCommand(command) || command.tenantId!==tenantId || command.requestId!==requestId)
        throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR','Invalid customer open references');
      const saved=(await sql<{account_id:string}>`SELECT w.account_id FROM hawa.customer_web_requests w
        JOIN hawa.outbox_commands o ON o.tenant_id=w.tenant_id AND o.aggregate_id=w.request_id
        WHERE w.tenant_id=${tenantId}::uuid AND w.request_id=${requestId}::uuid
          AND w.account_id=${command.accountId}::uuid AND o.id=${command.commandId}::uuid
          AND o.aggregate_type='request' AND o.command_type='customer.request.open'
          AND o.idempotency_key=${command.key}
          AND o.payload=jsonb_build_object('v',1,'requestId',w.request_id::text,'accountId',w.account_id::text)` .execute(trx)).rows[0];
      if(!saved) throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR','No matching retained customer command');
    }
    const {receipt,draft}=await authorizeCustomerWebOpen(trx,tenantId,requestId);
    return {v:1,eventId:`open:${requestId}`,requestId,tenantId,chatId:`web:${receipt.account_id}`,draft};
  });
}

/** A durable browser record is neither a Telegram send nor evidence that a person saw a question. */
export async function recordCustomerWebMessage(db:Kysely<Database>,tenantId:string,message:OutboundMessage) {
  const channel=WEB_CHANNEL.exec(message?.chatId ?? '');
  const requestId=message?.key?.split(':')[0];
  if(!channel || !/^[0-9a-f-]{36}$/i.test(requestId ?? '') || message.v!==1 || message.tenantId!==tenantId ||
    !['text','photo','document'].includes(message.kind) || !['critical','courtesy'].includes(message.class) ||
    message.key.length>300 || Buffer.byteLength(JSON.stringify(message))>24576)
    throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR','Invalid web notification');
  for(const ref of [message.imageRef,message.exportRef]) {
    if(ref && (ref.tenantId!==tenantId || !message.taskId || ref.taskId!==message.taskId))
      throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR','Web attachment reference has different scope');
  }
  if(message.onSent && (message.onSent.kind!=='question' || message.onSent.requestId!==requestId ||
    !message.taskId || message.onSent.taskId!==message.taskId || !Number.isSafeInteger(message.onSent.requestRev) ||
    message.onSent.requestRev<2 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.onSent.questionId)))
    throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR','Web question reference has different scope');
  return withRlsContext(db,{tenantId,userId:CHANNEL_INGRESS_USER_ID,role:'operator'},async trx=>{
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`web-message:${tenantId}:${message.key}`},0))`.execute(trx);
    const receipt=(await sql<{account_id:string;client_id:string}>`SELECT account_id,client_id FROM hawa.customer_web_requests
      WHERE tenant_id=${tenantId}::uuid AND request_id=${requestId}::uuid AND account_id=${channel[1]}::uuid`.execute(trx)).rows[0];
    if(!receipt) throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR','Notification has no owned web request');
    if(message.taskId) {
      const task=await trx.selectFrom('tasks').select('id').where('tenant_id','=',tenantId).where('id','=',message.taskId)
        .where('request_id','=',requestId).where('customer_account_id','=',receipt.account_id).where('client_id','=',receipt.client_id).executeTakeFirst();
      if(!task) throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR','Notification task is outside the web request');
    }
    const hash=customerValueHash(message);
    const prior=(await sql<{id:string;payload_hash:string}>`SELECT id,payload_hash FROM hawa.customer_web_messages
      WHERE tenant_id=${tenantId}::uuid AND message_key=${message.key}`.execute(trx)).rows[0];
    if(prior) {
      if(prior.payload_hash!==hash) throw new LifecycleProjectionConflict('IDEMPOTENCY_CONFLICT','Web message key has different content');
      return {outcome:'web_recorded' as const,receiptId:prior.id};
    }
    const saved=(await sql<{id:string}>`INSERT INTO hawa.customer_web_messages(tenant_id,request_id,account_id,message_key,payload,payload_hash)
      VALUES(${tenantId}::uuid,${requestId}::uuid,${receipt.account_id}::uuid,${message.key},${JSON.stringify(message)}::jsonb,${hash}) RETURNING id`.execute(trx)).rows[0];
    return {outcome:'web_recorded' as const,receiptId:saved.id};
  });
}
