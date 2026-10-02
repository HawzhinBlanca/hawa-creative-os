import type { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { CustomerRequests, CustomerRequestError } from './customer-requests.js';
import {
  WorkspaceAccessError,
  type WorkspaceMember,
} from './supabase-member.js';

export const CUSTOMER_ORIGINS = new Set([
  'https://hawzhin.app',
  'https://www.hawzhin.app',
]);
const schema = z
  .object({
    clientId: z.string().uuid(),
    title: z.string().trim().min(1).max(160),
    exactCopy: z
      .array(
        z
          .object({
            text: z
              .string()
              .min(1)
              .max(4000)
              .refine((s) => Boolean(s.trim())),
            language: z.enum(['en', 'ckb', 'ar']),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    designInstructions: z.string().max(4000),
    variant: z.enum(['square', 'portrait', 'story']),
  })
  .strict()
  .refine(
    (value) => value.exactCopy.reduce((n, b) => n + b.text.length, 0) <= 8000,
  );

/** Dedicated routes; never run an office-token guard or fall back to office admission. */
export function registerCustomerRoutes(
  app: Hono,
  requests: CustomerRequests,
  verify: (authorization: string | undefined) => Promise<WorkspaceMember>,
  generationEnabled: boolean,
) {
  const run =
    (fn: (c: Context, member: WorkspaceMember) => Promise<Response>) =>
    async (c: Context) => {
      c.header('Cache-Control', 'no-store');
      if (
        c.req.header('Origin') &&
        !CUSTOMER_ORIGINS.has(c.req.header('Origin')!)
      )
        return c.json({ code: 'DESIGN_ORIGIN_DENIED' }, 403);
      try {
        return await fn(c, await verify(c.req.header('Authorization')));
      } catch (error) {
        if (
          error instanceof WorkspaceAccessError ||
          error instanceof CustomerRequestError
        )
          return c.json({ code: error.code }, error.status);
        // No SQL/provider bodies, credentials or task payloads cross the boundary.
        return c.json({ code: 'DESIGN_SERVICE_UNAVAILABLE' }, 503);
      }
    };
  app.get(
    '/v1/customer/session',
    run(async (c, m) =>
      c.json({ ...(await requests.session(m)), generationEnabled }),
    ),
  );
  app.get(
    '/v1/customer/jobs',
    run(async (c, m) => c.json({ jobs: await requests.list(m) })),
  );
  app.get(
    '/v1/customer/jobs/:id',
    run(async (c, m) => {
      const id = c.req.param('id');
      if (!id || !z.string().uuid().safeParse(id).success)
        return c.json({ code: 'DESIGN_JOB_NOT_FOUND' }, 404);
      return c.json({ job: await requests.get(m, id), messages: await requests.messages(m,id) });
    }),
  );
  app.post(
    '/v1/customer/jobs',
    run(async (c, m) => {
      // Public generation has a separate explicit readiness switch.
      if (!generationEnabled)
        return c.json({ code: 'DESIGN_GENERATION_NOT_READY' }, 503);
      const key = c.req.header('Idempotency-Key');
      if (!key || !/^[a-zA-Z0-9_-]{8,100}$/.test(key))
        return c.json({ code: 'DESIGN_IDEMPOTENCY_REQUIRED' }, 400);
      // Bound actual streamed bytes; Content-Length is only a hint, never enforcement.
      const reader = c.req.raw.body?.getReader();
      if (!reader) return c.json({ code: 'DESIGN_REQUEST_INVALID' }, 400);
      const deadline=Date.now()+10000;
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          let timer:ReturnType<typeof setTimeout>|undefined;
          const chunk = await Promise.race([reader.read(),new Promise<never>((_,reject)=>{
            timer=setTimeout(()=>reject(new Error('CUSTOMER_BODY_TIMEOUT')),Math.max(1,deadline-Date.now()));
          })]).finally(()=>{if(timer) clearTimeout(timer);});
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 49152)
            return c.json({ code: 'DESIGN_REQUEST_TOO_LARGE' }, 413);
          chunks.push(chunk.value);
        }
        const parsed = schema.safeParse(
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
        if (!parsed.success)
          return c.json({ code: 'DESIGN_REQUEST_INVALID' }, 400);
        const result = await requests.create(m, key, parsed.data);
        return c.json(result, result.created ? 201 : 200);
      } catch (error) {
        if(error instanceof Error && error.message==='CUSTOMER_BODY_TIMEOUT') return c.json({code:'DESIGN_REQUEST_TIMEOUT'},408);
        if (error instanceof SyntaxError)
          return c.json({ code: 'DESIGN_REQUEST_INVALID' }, 400);
        throw error;
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }),
  );
}
