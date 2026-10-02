import { dailyDraftCap } from '../services/chat-intake.js';
import { randomUUID } from 'node:crypto';
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
    public readonly status: 403 | 404 | 409 | 429,
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
      // Select the requester read model explicitly; refs and internal routing never cross this API.
      return (await sql<{id:string;kind:string;text:string;created_at:Date;question:unknown}>`
        SELECT id,payload->>'kind' AS kind,COALESCE(payload->>'caption',payload->>'text','') AS text,
          created_at,payload->'onSent' AS question FROM hawa.customer_web_messages
        WHERE tenant_id=${this.tenantId}::uuid AND account_id=${account.id}::uuid AND request_id=${id}::uuid
        ORDER BY created_at DESC,id DESC LIMIT 100`.execute(trx)).rows.reverse().map(row=>({id:row.id,kind:row.kind,text:row.text,
          createdAt:new Date(row.created_at).toISOString(),question:row.question ?? null}));
    });
  }
  async create(member:WorkspaceMember,key:string,body:CustomerDesignRequest) {
    return this.scoped(member,async (trx,account)=>{
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${account.id},0))`.execute(trx);
      await sql`SELECT hawa.lock_customer_request_access(${body.clientId}::uuid)`.execute(trx);
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
