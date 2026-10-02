import crypto from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, withRlsContext } from '@hawa/db';
import type { RouteContext } from '../routes/types.js';
import { lockNamedOfficeAdministrator } from '../services/named-review-authority.js';
import { provisionCustomer } from './customer-provisioning.js';
import { CustomerRequestError } from './customer-requests.js';
const admission = z
  .object({
    subject: z.string().uuid(),
    clientIds: z
      .array(z.string().uuid())
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length),
    active: z.boolean(),
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    dailyJobs: z.number().int().min(1).max(100),
    concurrentJobs: z.number().int().min(1).max(10),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export function registerCustomerAdminRoutes(ctx: RouteContext) {
  const { db, registerRoute } = ctx;
  if (!db) return;
  const named = async (c: Context) => {
    const auth = ctx.verifyRequestAuth(c),
      token = ctx.bearerTokenOf?.(c);
    if (
      !auth.authenticated ||
      auth.authMethod !== 'google_oidc' ||
      !auth.userId ||
      !auth.tenantId ||
      !token
    )
      return null;
    const admin = {
      tenantId: auth.tenantId,
      userId: auth.userId,
      sessionHash: crypto.createHash('sha256').update(token).digest('hex'),
    };
    return admin;
  };
  registerRoute('get', '/office/customer-accounts', async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const admin = await named(c);
    if (!admin) return c.json({ code: 'NAMED_ADMINISTRATOR_REQUIRED' }, 403);
    return withRlsContext(
      db,
      { ...admin, role: 'administrator' },
      async (trx) => {
        if (!(await lockNamedOfficeAdministrator(trx, admin)))
          return c.json({ code: 'NAMED_ADMINISTRATOR_REQUIRED' }, 403);
        const accounts = (
          await sql`SELECT id,subject,active,version,daily_job_limit,concurrent_job_limit FROM hawa.customer_accounts WHERE tenant_id=${admin.tenantId}::uuid ORDER BY created_at DESC LIMIT 200`.execute(
            trx,
          )
        ).rows;
        return c.json({ accounts });
      },
    );
  });
  registerRoute('put', '/office/customer-accounts', async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const admin = await named(c);
    if (!admin) return c.json({ code: 'NAMED_ADMINISTRATOR_REQUIRED' }, 403);
    const actionId = c.req.header('Idempotency-Key');
    if (!z.string().uuid().safeParse(actionId).success)
      return c.json({ code: 'DESIGN_IDEMPOTENCY_REQUIRED' }, 400);
    const input = admission.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: 'DESIGN_REQUEST_INVALID' }, 400);
    try {
      return await withRlsContext(
        db,
        { ...admin, role: 'administrator' },
        async (trx) => {
          if (!(await lockNamedOfficeAdministrator(trx, admin)))
            return c.json({ code: 'NAMED_ADMINISTRATOR_REQUIRED' }, 403);
          return c.json(
            await provisionCustomer(trx, admin, actionId!, input.data),
          );
        },
      );
    } catch (error) {
      if (error instanceof CustomerRequestError)
        return c.json({ code: error.code }, error.status);
      return c.json({ code: 'DESIGN_SERVICE_UNAVAILABLE' }, 503);
    }
  });
}
