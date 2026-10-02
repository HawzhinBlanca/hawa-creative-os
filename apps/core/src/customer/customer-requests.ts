import { blobStoreFor } from '../services/blob-store-context.js';
import { parseAndValidatePng } from '@hawa/integrations';
import {admitCustomerAction,customerActionReceipt} from './customer-actions.js';
import type {CustomerActionBody} from '@hawa/contracts';
import { CustomerPhotoError, customerPhotos, inspectCustomerPhoto, decodeCustomerPhoto, type CustomerPhoto } from './customer-photos.js';
import { dailyDraftCap } from '../services/chat-intake.js';
import { createHash, randomUUID } from 'node:crypto';
import { customerValueHash } from './customer-web-lifecycle.js';
import { OutboxRepository } from '@hawa/db';
import {
  sql,
  withRlsContext,
  type Database,
  type Kysely,
} from '@hawa/db';
import {
  HAWZHIN_AUTH_ORIGIN,
  type WorkspaceMember,
} from './supabase-member.js';

export class CustomerRequestError extends Error {
  constructor(
    public readonly status: 403 | 404 | 409 | 429 | 503,
    public readonly code: string,
  ) {
    super(code);
  }
}
export interface CustomerDesignRequest {
  clientId: string;
  title: string;
  exactCopy: Array<{ text: string; language: 'en' | 'ckb' | 'ar' }>;
  designInstructions: string;
  variant: 'square' | 'portrait' | 'story';
  photoIds?: string[];
  photoUsage?: { mode: 'auto' | 'all' } | { mode: 'count'; count: number };
}
interface Account {
  id: string;
  user_id: string;
  daily_job_limit: number;
  concurrent_job_limit: number;
}
/** Only the owned customer projection crosses this boundary, never provider payloads/logs. */
export interface CustomerJob {
  id: string;
  clientId: string;
  title: string;
  state: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
function job(row: {
  id: string;
  client_id: string | null;
  title: string;
  state: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}): CustomerJob {
  return {
    id: row.id,
    clientId: row.client_id!,
    title: row.title,
    state: row.state,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Core owns tenant configuration; the body/JWT metadata can never select it. */
export class CustomerRequests {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly tenantId: string,
  ) {}

  private async scoped<T>(
    member: WorkspaceMember,
    fn: (trx: Kysely<Database>, account: Account) => Promise<T>,
  ): Promise<T> {
    if (
      member.issuer !== HAWZHIN_AUTH_ORIGIN ||
      member.kind !== 'workspace_member'
    )
      throw new CustomerRequestError(403, 'DESIGN_ACCESS_DENIED');
    return withRlsContext(
      this.db,
      { tenantId: this.tenantId, role: 'requester' },
      async (trx) => {
        // Set every field even when absent: nested/context reuse must not inherit an office user.
        await sql`SELECT set_config('app.user_id','',true),set_config('hawa.current_user_id','',true),
        set_config('hawa.customer_id','',true),set_config('hawa.customer_subject',${member.subject},true)`.execute(
          trx,
        );
        const account = (
          await sql<Account>`SELECT id,user_id,daily_job_limit,concurrent_job_limit
        FROM hawa.customer_accounts WHERE id=hawa.customer_account_for_subject()`.execute(
            trx,
          )
        ).rows[0];
        if (!account)
          throw new CustomerRequestError(403, 'DESIGN_ACCOUNT_NOT_PROVISIONED');
        await sql`SELECT set_config('app.user_id',${account.user_id},true),set_config('hawa.current_user_id',${account.user_id},true),
        set_config('hawa.customer_id',${account.id},true)`.execute(trx);
        return fn(trx, account);
      },
    );
  }

  async session(member: WorkspaceMember) {
    return this.scoped(member, async (trx, account) => {
      const clients = (
        await sql<{
          id: string;
          name: string;
        }>`SELECT c.id,c.name FROM hawa.clients c
        WHERE c.tenant_id=${this.tenantId}::uuid AND hawa.customer_can_request(c.id) ORDER BY c.name,c.id`.execute(
          trx,
        )
      ).rows;
      return {
        accountId: account.id,
        clients,
        limits: {
          dailyJobs: account.daily_job_limit,
          concurrentJobs: account.concurrent_job_limit,
        },
      };
    });
  }

  private async jobs(trx:Kysely<Database>,account:Account,id?:string) {
    return (await sql<{id:string;client_id:string;title:string;state:string;version:number;created_at:Date;updated_at:Date}>`
      SELECT w.request_id AS id,w.client_id,w.body->>'title' AS title,COALESCE(t.state::text,'received') AS state,
        COALESCE(r.rev,1) AS version,w.created_at,COALESCE(r.updated_at,w.created_at) AS updated_at
      FROM hawa.customer_web_requests w
      LEFT JOIN hawa.requests r ON r.tenant_id=w.tenant_id AND r.request_id=w.request_id
      LEFT JOIN hawa.tasks t ON t.tenant_id=r.tenant_id AND t.id=r.current_task_id
      WHERE w.tenant_id=${this.tenantId}::uuid AND w.account_id=${account.id}::uuid
        ${id ? sql`AND w.request_id=${id}::uuid` : sql``}
      ORDER BY w.created_at DESC,w.request_id DESC LIMIT 50`.execute(trx)).rows.map(job);
  }
  async list(member:WorkspaceMember) {
    return this.scoped(member,(trx,account)=>this.jobs(trx,account));
  }
  async get(member:WorkspaceMember,id:string) {
    return this.scoped(member,async (trx,account)=>{
      const rows=await this.jobs(trx,account,id);
      if(!rows.length) throw new CustomerRequestError(404,'DESIGN_JOB_NOT_FOUND');
      return rows[0];
    });
  }
  async messages(member:WorkspaceMember,id:string) {
    return this.scoped(member,async (trx,account)=>{
      if(!(await this.jobs(trx,account,id)).length) throw new CustomerRequestError(404,'DESIGN_JOB_NOT_FOUND');
      return this.readMessages(trx,account,id);
    });
  }
  async preview(member:WorkspaceMember,id:string,expected?:{id:string;version:number;sha256:string}) {
    return this.scoped(member,async(trx,account)=>{
      if(!(await this.jobs(trx,account,id)).length) throw new CustomerRequestError(404,'DESIGN_JOB_NOT_FOUND');
      return this.currentPreview(trx,id,expected);
    });
  }
  private async currentPreview(trx:Kysely<Database>,id:string,expected?:{id:string;version:number;sha256:string}) {
      const row=(await sql<{id:string;request_rev:string;binding_version:number;sha256:string;byte_size:number;captured_at:Date;content:Buffer|null}>`
        SELECT * FROM hawa.customer_current_preview(${id}::uuid,${expected?.id ?? null}::uuid,
          ${expected?.version ?? null}::bigint,${expected?.sha256 ?? null}::text)`.execute(trx)).rows[0];
      if(!row) {
        if(expected) throw new CustomerRequestError(409,'DESIGN_PREVIEW_STALE');
        return null;
      }
      const preview={id:row.id,requestVersion:Number(row.request_rev),bindingVersion:Number(row.binding_version),
        sha256:row.sha256,size:Number(row.byte_size),capturedAt:new Date(row.captured_at).toISOString()};
      if(expected) {
        const bytes=row.content;
        if(!bytes || bytes.length!==preview.size || bytes.length>26214400 ||
          createHash('sha256').update(bytes).digest('hex')!==preview.sha256 || !parseAndValidatePng(bytes).ok)
          throw new CustomerRequestError(503,'DESIGN_PREVIEW_INVALID');
        return {...preview,bytes};
      }
      return preview;
  }
  async detail(member:WorkspaceMember,id:string) {
    return this.scoped(member,async(trx,account)=>{
      if(!(await this.jobs(trx,account,id)).length)throw new CustomerRequestError(404,'DESIGN_JOB_NOT_FOUND');
      // The preview routine holds the current request/task/binding while we read the projection.
      const preview=await this.currentPreview(trx,id);
      const rows=await this.jobs(trx,account,id);
      if(!rows.length)throw new CustomerRequestError(404,'DESIGN_JOB_NOT_FOUND');
      const messages=await this.readMessages(trx,account,id);
      const current=(await sql<{stage:string;task_id:string;automatic:boolean}>`SELECT * FROM hawa.customer_action_basis(${id}::uuid)`.execute(trx)).rows[0];
      const question=[...messages].reverse().find(m=>m.question && typeof m.question==='object' && 'requestRev' in m.question &&
        m.question.requestRev===rows[0].version && 'taskId' in m.question && m.question.taskId===current?.task_id);
      const actionIds=(await sql<{id:string}>`SELECT id FROM hawa.customer_web_actions WHERE tenant_id=${this.tenantId}::uuid
        AND request_id=${id}::uuid AND account_id=${account.id}::uuid ORDER BY created_at DESC,id DESC LIMIT 10`.execute(trx)).rows;
      const receipts=[];for(const a of actionIds)receipts.push(await customerActionReceipt(trx,a.id));
      return {job:rows[0],preview,messages,actions:{canRevise:current?.automatic===true && ['manual','in_review'].includes(current?.stage ?? ''),
        canCancel:['designing','awaiting_answer','manual','in_review'].includes(current?.stage ?? ''),
        questionMessageId:current?.stage==='awaiting_answer' ? question?.id ?? null : null,receipts}};
    });
  }
  async action(member:WorkspaceMember,id:string,key:string,body:CustomerActionBody) {
    return this.scoped(member,(trx,account)=>admitCustomerAction(trx,this.tenantId,account,member,id,key,body));
  }
  private async readMessages(trx:Kysely<Database>,account:Account,id:string) {
      // Select the requester read model explicitly; refs and internal routing never cross this API.
      return (await sql<{id:string;kind:string;text:string;created_at:Date;question:unknown}>`
        SELECT id,payload->>'kind' AS kind,COALESCE(payload->>'caption',payload->>'text','') AS text,
          created_at,payload->'onSent' AS question FROM hawa.customer_web_messages
        WHERE tenant_id=${this.tenantId}::uuid AND account_id=${account.id}::uuid AND request_id=${id}::uuid
        ORDER BY created_at DESC,id DESC LIMIT 100`.execute(trx)).rows.reverse().map(row=>({id:row.id,kind:row.kind,text:row.text,
          createdAt:new Date(row.created_at).toISOString(),question:row.question ?? null}));
  }
  async checkPhotoAccess(member:WorkspaceMember,clientId:string) {
    return this.scoped(member,async trx=>{await sql`SELECT hawa.lock_customer_request_access(${clientId}::uuid)`.execute(trx);});
  }
  async uploadPhoto(member:WorkspaceMember,clientId:string,key:string,filename:string,mediaType:string,bytes:Buffer,hash:string) {
    const inspected=inspectCustomerPhoto(bytes,mediaType,filename,hash);
    return this.scoped(member,async (trx,account)=>{
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${account.id},0))`.execute(trx);
      await sql`SELECT hawa.lock_customer_request_access(${clientId}::uuid)`.execute(trx);
      const prior=(await sql<{id:string;client_id:string;filename:string;sha256:string;media_type:CustomerPhoto['mediaType'];size:number;width:number;height:number}>`
        SELECT * FROM hawa.customer_photo_receipts WHERE tenant_id=${this.tenantId}::uuid
        AND account_id=${account.id}::uuid AND action_key=${key}`.execute(trx)).rows[0];
      if(prior) {
        if(prior.client_id!==clientId.toLowerCase() || prior.filename!==filename || prior.sha256!==hash || prior.media_type!==mediaType || prior.size!==bytes.length)
          throw new CustomerPhotoError(409,'DESIGN_PHOTO_IDEMPOTENCY_CONFLICT');
        return {photo:{id:prior.id,filename:prior.filename,sha256:prior.sha256,mediaType:prior.media_type,size:prior.size,width:prior.width,height:prior.height},created:false};
      }
      const used=(await sql<{n:string;bytes:string}>`SELECT * FROM hawa.customer_photo_usage()`.execute(trx)).rows[0];
      if(Number(used.n)>=40 || Number(used.bytes)+bytes.length>100*1024*1024)
        throw new CustomerPhotoError(429,'DESIGN_PHOTO_LIMIT');
      const store=blobStoreFor(this.db);
      if(!store) throw new CustomerPhotoError(503,'DESIGN_PHOTO_STORE_UNAVAILABLE');
      await decodeCustomerPhoto(bytes,mediaType);
      const ref=await store.put(bytes,inspected.mediaType,{trx});
      const saved=(await sql<{id:string}>`INSERT INTO hawa.customer_photo_receipts
        (tenant_id,account_id,client_id,subject,action_key,filename,sha256,media_type,size,width,height)
        VALUES(${this.tenantId}::uuid,${account.id}::uuid,${clientId}::uuid,${member.subject}::uuid,${key},${filename},
          ${ref.sha256},${ref.mediaType},${ref.size},${inspected.width},${inspected.height}) RETURNING id`.execute(trx)).rows[0];
      return {photo:{id:saved.id,filename,...ref,width:inspected.width,height:inspected.height},created:true};
    });
  }
  async create(member:WorkspaceMember,key:string,body:CustomerDesignRequest) {
    return this.scoped(member,async (trx,account)=>{
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${account.id},0))`.execute(trx);
      await sql`SELECT hawa.lock_customer_request_access(${body.clientId}::uuid)`.execute(trx);
      const photos=await customerPhotos(trx,this.tenantId,account.id,body.clientId,body.photoIds);
      if(body.photoUsage && (!photos.length || (body.photoUsage.mode==='count' &&
        (!Number.isInteger(body.photoUsage.count) || body.photoUsage.count<1 || body.photoUsage.count>photos.length))))
        throw new CustomerPhotoError(422,'DESIGN_PHOTOS_INVALID');
      const hash=customerValueHash(body);
      const prior=(await sql<{request_id:string;body_hash:string}>`SELECT request_id,body_hash FROM hawa.customer_web_requests
        WHERE tenant_id=${this.tenantId}::uuid AND account_id=${account.id}::uuid AND action_key=${key}`.execute(trx)).rows[0];
      if(prior) {
        if(prior.body_hash!==hash) throw new CustomerRequestError(409,'DESIGN_IDEMPOTENCY_CONFLICT');
        return {job:(await this.jobs(trx,account,prior.request_id))[0],created:false};
      }
      const current=(await sql<Account>`SELECT id,user_id,daily_job_limit,concurrent_job_limit FROM hawa.customer_accounts
        WHERE id=${account.id}::uuid`.execute(trx)).rows[0];
      if(!current) throw new CustomerRequestError(403,'DESIGN_ACCESS_DENIED');
      const counts=(await sql<{daily:number;concurrent:number}>`SELECT * FROM hawa.customer_job_counts()`.execute(trx)).rows[0];
      if(counts.daily>=current.daily_job_limit || counts.concurrent>=current.concurrent_job_limit)
        throw new CustomerRequestError(429,'DESIGN_REQUEST_LIMIT');
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`auto-draft-admission:${this.tenantId}`},0))`.execute(trx);
      const global=(await sql<{n:string}>`SELECT hawa.customer_global_job_count() AS n`.execute(trx)).rows[0];
      if(Number(global.n)>=dailyDraftCap('AUTO_GENERATE_DAILY_CAP_GLOBAL',200))
        throw new CustomerRequestError(429,'DESIGN_REQUEST_LIMIT');
      const dna=(await sql<{version:number|null}>`SELECT hawa.pin_customer_dna(${body.clientId}::uuid) AS version`.execute(trx)).rows[0];
      if(!dna.version) throw new CustomerRequestError(409,'DESIGN_BRAND_NOT_READY');
      const requestId=randomUUID();
      await sql`INSERT INTO hawa.customer_web_requests(request_id,tenant_id,account_id,client_id,subject,action_key,body_hash,body,dna_version)
        VALUES(${requestId}::uuid,${this.tenantId}::uuid,${account.id}::uuid,${body.clientId}::uuid,${member.subject}::uuid,
          ${key},${hash},${JSON.stringify(body)}::jsonb,${dna.version})`.execute(trx);
      await new OutboxRepository(this.db).enqueue({tenantId:this.tenantId,aggregateType:'request',aggregateId:requestId,
        commandType:'customer.request.open',idempotencyKey:`customer:${account.id}:${key}`,payload:{v:1,requestId,accountId:account.id}},trx);
      return {job:(await this.jobs(trx,account,requestId))[0],created:true};
    }).catch(error=>{
      if(error && typeof error==='object' && 'code' in error && error.code==='42501')
        throw new CustomerRequestError(403,'DESIGN_ACCESS_DENIED');
      throw error;
    });
  }
}
