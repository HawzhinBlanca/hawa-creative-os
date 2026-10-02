import {
  sql,
  withRlsContext,
  TaskRepository,
  IdempotencyConflictError,
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
const jobColumns = [
  'id',
  'client_id',
  'title',
  'state',
  'version',
  'created_at',
  'updated_at',
] as const;
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

  async list(member: WorkspaceMember) {
    return this.scoped(member, async (trx, account) =>
      (
        await trx
          .selectFrom('tasks')
          .select(jobColumns)
          .where('tenant_id', '=', this.tenantId)
          .where('customer_account_id', '=', account.id)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(50)
          .execute()
      ).map(job),
    );
  }

  async get(member: WorkspaceMember, id: string) {
    return this.scoped(member, async (trx, account) => {
      const row = await trx
        .selectFrom('tasks')
        .select(jobColumns)
        .where('tenant_id', '=', this.tenantId)
        .where('customer_account_id', '=', account.id)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw new CustomerRequestError(404, 'DESIGN_JOB_NOT_FOUND');
      return job(row);
    });
  }

  async create(
    member: WorkspaceMember,
    key: string,
    body: CustomerDesignRequest,
  ) {
    return this.scoped(member, async (trx, account) => {
      // One lock covers idempotency AND admission counts across different keys.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${account.id},0))`.execute(
        trx,
      );
      await sql`SELECT hawa.lock_customer_request_access(${body.clientId}::uuid)`.execute(
        trx,
      );
      const current = (
        await sql<Account>`SELECT id,user_id,daily_job_limit,concurrent_job_limit
        FROM hawa.customer_accounts WHERE id=${account.id}::uuid`.execute(trx)
      ).rows[0];
      if (!current) throw new CustomerRequestError(403, 'DESIGN_ACCESS_DENIED');
      const result = await new TaskRepository(this.db).createTaskAggregate(
        {
          tenantId: this.tenantId,
          userId: account.user_id,
          customerAccountId: account.id,
          idempotencyKey: `customer:${account.id}:${key}`,
          clientId: body.clientId,
          title: body.title,
          description: body.designInstructions,
          taskType: 'graphic_design',
          requestBody: { ...body },
          payload: {
            body,
            workflow: 'canva',
            autoGenerate: true,
            designStudio: true,
            variant: {
              square: { width: 1080, height: 1080 },
              portrait: { width: 1080, height: 1350 },
              story: { width: 1080, height: 1920 },
            }[body.variant],
            sourcePlatform: 'web',
            rawRequestText: body.designInstructions,
            studioOptions: { tier: 'standard', imagery: 'auto' },
            // Copy was explicitly supplied in separate fields; model extraction is unnecessary.
            reviewedSource: {
              confirmation: 'request_copy_reviewed',
              origin: 'customer_exact_copy',
              localesConfirmedByRequester: true,
            },
          },
          prepareCreatePayload: async () => {
            const counts = (
              await sql<{
                daily: number;
                concurrent: number;
              }>`SELECT * FROM hawa.customer_job_counts()`.execute(trx)
            ).rows[0];
            if (
              counts.daily >= current.daily_job_limit ||
              counts.concurrent >= current.concurrent_job_limit
            )
              throw new CustomerRequestError(429, 'DESIGN_REQUEST_LIMIT');
            const dna = (
              await sql<{
                version: number | null;
              }>`SELECT hawa.pin_customer_dna(${body.clientId}::uuid) AS version`.execute(
                trx,
              )
            ).rows[0];
            if (!dna.version)
              throw new CustomerRequestError(409, 'DESIGN_BRAND_NOT_READY');
            return { clientDnaVersion: dna.version };
          },
        },
        trx,
      );
      return { job: job(result.task), created: result.created };
    }).catch((error) => {
      if (error instanceof IdempotencyConflictError)
        throw new CustomerRequestError(409, 'DESIGN_IDEMPOTENCY_CONFLICT');
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '42501'
      )
        throw new CustomerRequestError(403, 'DESIGN_ACCESS_DENIED');
      throw error;
    });
  }
}
