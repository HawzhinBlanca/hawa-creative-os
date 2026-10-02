import crypto from 'node:crypto';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { canonicalJson } from '../core-helpers.js';
import { HAWZHIN_AUTH_ORIGIN } from './supabase-member.js';
import { CustomerRequestError } from './customer-requests.js';
export interface CustomerAdmission {
  subject: string;
  clientIds: string[];
  active: boolean;
  expectedVersion: number;
  dailyJobs: number;
  concurrentJobs: number;
  reason: string;
}
export interface AdmissionResult {
  accountId: string;
  version: number;
  active: boolean;
  clientIds: string[];
  dailyJobs: number;
  concurrentJobs: number;
}
/** The route must also lock a current named administrator's session. DB checks actual membership. */
export async function provisionCustomer(
  db: Kysely<Database>,
  admin: { tenantId: string; userId: string },
  actionId: string,
  input: CustomerAdmission,
): Promise<AdmissionResult> {
  return withRlsContext(
    db,
    { tenantId: admin.tenantId, userId: admin.userId, role: 'administrator' },
    async (trx) => {
      await sql`SELECT set_config('hawa.customer_id','',true),set_config('hawa.customer_subject','',true)`.execute(
        trx,
      );
      const authority = (
        await sql<{
          ok: boolean;
        }>`SELECT hawa.has_tenant_role(${admin.tenantId}::uuid,ARRAY['administrator']::hawa.membership_role[]) AS ok`.execute(
          trx,
        )
      ).rows[0];
      if (!authority.ok)
        throw new CustomerRequestError(403, 'NAMED_ADMINISTRATOR_REQUIRED');
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${admin.tenantId + ':customer-admission'},0))`.execute(
        trx,
      );
      const requestHash = crypto
        .createHash('sha256')
        .update(
          canonicalJson({ ...input, clientIds: [...input.clientIds].sort() }),
        )
        .digest('hex');
      const prior = (
        await sql<{
          actor_id: string;
          request_hash: string;
          result: AdmissionResult;
        }>`SELECT actor_id,request_hash,result FROM hawa.customer_access_actions
   WHERE tenant_id=${admin.tenantId}::uuid AND action_id=${actionId}::uuid`.execute(
          trx,
        )
      ).rows[0];
      if (prior) {
        if (
          prior.actor_id !== admin.userId ||
          prior.request_hash !== requestHash
        )
          throw new CustomerRequestError(409, 'DESIGN_IDEMPOTENCY_CONFLICT');
        return prior.result;
      }
      const found = (
        await sql<{
          id: string;
          user_id: string;
          version: string;
        }>`SELECT id,user_id,version FROM hawa.customer_accounts
   WHERE tenant_id=${admin.tenantId}::uuid AND issuer=${HAWZHIN_AUTH_ORIGIN} AND subject=${input.subject}::uuid FOR UPDATE`.execute(
          trx,
        )
      ).rows[0];
      if ((found ? Number(found.version) : 0) !== input.expectedVersion)
        throw new CustomerRequestError(409, 'DESIGN_ACCOUNT_VERSION_CONFLICT');
      for (const clientId of input.clientIds) {
        const valid = await trx
          .selectFrom('clients')
          .select('id')
          .where('tenant_id', '=', admin.tenantId)
          .where('id', '=', clientId)
          .where('status', '=', 'active')
          .forShare()
          .executeTakeFirst();
        if (!valid) throw new CustomerRequestError(403, 'DESIGN_ACCESS_DENIED');
      }
      const accountId = found?.id ?? crypto.randomUUID(),
        userId =
          found?.user_id ??
          (
            await sql<{
              id: string;
            }>`SELECT hawa.provision_customer_requester(${accountId}::uuid,${input.subject}::uuid) AS id`.execute(
              trx,
            )
          ).rows[0].id;
      if (!found) {
        await sql`INSERT INTO hawa.customer_accounts(id,tenant_id,issuer,subject,user_id,active,daily_job_limit,concurrent_job_limit,provisioned_by,reason)
    VALUES(${accountId}::uuid,${admin.tenantId}::uuid,${HAWZHIN_AUTH_ORIGIN},${input.subject}::uuid,${userId}::uuid,${input.active},${input.dailyJobs},${input.concurrentJobs},${admin.userId}::uuid,${input.reason})`.execute(
          trx,
        );
      } else {
        await sql`UPDATE hawa.customer_accounts SET active=${input.active},daily_job_limit=${input.dailyJobs},concurrent_job_limit=${input.concurrentJobs},reason=${input.reason},version=version+1 WHERE id=${accountId}::uuid`.execute(
          trx,
        );
      }
      // No deletion or reassignment: revoked grants retain their scope and audit trail.
      await sql`UPDATE hawa.customer_client_grants SET active=false,reason=${input.reason},version=version+1
   WHERE account_id=${accountId}::uuid AND active`.execute(trx);
      await sql`UPDATE hawa.client_memberships SET active=false WHERE tenant_id=${admin.tenantId}::uuid AND user_id=${userId}::uuid`.execute(
        trx,
      );
      for (const clientId of input.clientIds) {
        await sql`INSERT INTO hawa.customer_client_grants(tenant_id,account_id,client_id,active,provisioned_by,reason)
    VALUES(${admin.tenantId}::uuid,${accountId}::uuid,${clientId}::uuid,true,${admin.userId}::uuid,${input.reason})
    ON CONFLICT(account_id,client_id) DO UPDATE SET active=true,reason=EXCLUDED.reason,version=customer_client_grants.version+1`.execute(
          trx,
        );
        await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role,active)
    VALUES(${admin.tenantId}::uuid,${clientId}::uuid,${userId}::uuid,'requester',true)
    ON CONFLICT(client_id,user_id,role) DO UPDATE SET active=true`.execute(trx);
      }
      const result: AdmissionResult = {
        accountId,
        version: input.expectedVersion + 1,
        active: input.active,
        clientIds: [...input.clientIds].sort(),
        dailyJobs: input.dailyJobs,
        concurrentJobs: input.concurrentJobs,
      };
      await sql`INSERT INTO hawa.customer_access_actions(tenant_id,action_id,actor_id,request_hash,result)
   VALUES(${admin.tenantId}::uuid,${actionId}::uuid,${admin.userId}::uuid,${requestHash},${JSON.stringify(result)}::jsonb)`.execute(
        trx,
      );
      return result;
    },
  );
}
