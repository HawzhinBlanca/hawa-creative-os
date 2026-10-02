import { CustomerPhotoError, CUSTOMER_PHOTO_MAX_BYTES } from './customer-photos.js';
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
let activePhotoUploads=0;
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
    photoIds:z.array(z.string().uuid()).max(20).optional(),
    photoUsage:z.discriminatedUnion('mode',[
      z.object({mode:z.literal('auto')}).strict(),z.object({mode:z.literal('all')}).strict(),
      z.object({mode:z.literal('count'),count:z.number().int().min(1).max(20)}).strict(),
    ]).optional(),
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
          error instanceof CustomerRequestError || error instanceof CustomerPhotoError
        )
          return c.json({ code: error.code }, error.status);
        if(error && typeof error==='object' && 'code' in error && error.code==='42501')
          return c.json({code:'DESIGN_ACCESS_DENIED'},403);
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
  app.post('/v1/customer/clients/:clientId/photos',run(async(c,m)=>{
    // Same readiness switch as generation: an unreleased portal never accumulates public uploads.
    if(!generationEnabled) return c.json({code:'DESIGN_GENERATION_NOT_READY'},503);
    const clientId=c.req.param('clientId'),key=c.req.header('Idempotency-Key'),hash=c.req.header('X-Content-SHA256');
    if(!clientId || !z.string().uuid().safeParse(clientId).success || !key || !/^[a-zA-Z0-9_-]{8,100}$/.test(key) || !hash || !/^[a-f0-9]{64}$/.test(hash))
      return c.json({code:'DESIGN_PHOTO_INVALID'},400);
    let filename:string;
    try {filename=decodeURIComponent(c.req.header('X-Photo-Filename') ?? '');}
    catch {return c.json({code:'DESIGN_PHOTO_INVALID'},400);}
    // Bound buffered bodies before reading them; decoded concurrency alone is too late.
    if(activePhotoUploads>=2)return c.json({code:'DESIGN_PHOTO_BUSY'},503);
    activePhotoUploads++;
    try {
      // Reject inactive/unprovisioned/foreign-brand access before reading or decoding the body.
      await requests.checkPhotoAccess(m,clientId);
      const bytes=await readCustomerBody(c,CUSTOMER_PHOTO_MAX_BYTES,15000);
      const result=await requests.uploadPhoto(m,clientId,key,filename,c.req.header('Content-Type') ?? '',bytes,hash);
      return c.json(result,result.created ? 201 : 200);
    } catch(error) {
      if(error instanceof CustomerBodyError) return c.json({code:error.code},error.status);
      throw error;
    } finally {activePhotoUploads--;}
  }));
  app.post(
    '/v1/customer/jobs',
    run(async (c, m) => {
      // Public generation has a separate explicit readiness switch.
      if (!generationEnabled)
        return c.json({ code: 'DESIGN_GENERATION_NOT_READY' }, 503);
      const key = c.req.header('Idempotency-Key');
      if (!key || !/^[a-zA-Z0-9_-]{8,100}$/.test(key))
        return c.json({ code: 'DESIGN_IDEMPOTENCY_REQUIRED' }, 400);
      try {
        const bytes=await readCustomerBody(c,49152,10000);
        const parsed = schema.safeParse(
          JSON.parse(bytes.toString('utf8')),
        );
        if (!parsed.success)
          return c.json({ code: 'DESIGN_REQUEST_INVALID' }, 400);
        const result = await requests.create(m, key, parsed.data);
        return c.json(result, result.created ? 201 : 200);
      } catch (error) {
        if(error instanceof CustomerBodyError) return c.json({code:error.code},error.status);
        if (error instanceof SyntaxError)
          return c.json({ code: 'DESIGN_REQUEST_INVALID' }, 400);
        throw error;
      }
    }),
  );
}

class CustomerBodyError extends Error {
  constructor(readonly status:400|408|413,readonly code:string){super(code);}
}
/** One bounded reader for both JSON and raw photos; a stalled cancel cannot hold the HTTP reply. */
async function readCustomerBody(c:Context,maxBytes:number,timeoutMs:number):Promise<Buffer> {
  const reader=c.req.raw.body?.getReader();
  if(!reader) throw new CustomerBodyError(400,'DESIGN_REQUEST_INVALID');
  const deadline=Date.now()+timeoutMs;
  let size=0;
  const chunks:Uint8Array[]=[];
  try {
    while(true) {
      let timer:ReturnType<typeof setTimeout>|undefined;
      const chunk=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new CustomerBodyError(408,'DESIGN_REQUEST_TIMEOUT')),Math.max(1,deadline-Date.now()));
      })]).finally(()=>{if(timer)clearTimeout(timer);});
      if(chunk.done)break;
      size+=chunk.value.length;
      if(size>maxBytes)throw new CustomerBodyError(413,'DESIGN_REQUEST_TOO_LARGE');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    void reader.cancel().catch(()=>undefined);
    reader.releaseLock();
  }
}
