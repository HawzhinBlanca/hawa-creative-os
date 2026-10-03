import type { Context, MiddlewareHandler } from 'hono';

/**
 * The largest request body Core reads (bug hunt 3). Above every legitimate upload: an asset's JSON
 * envelope (~13.4 MB), a requester photo (10 MB), a PDF (20 MiB) and the largest, a comparison of two
 * 15 MB images sent as base64 in one JSON body (~40 MB). nginx stops outside callers at 25 MB; this
 * bounds what reaches Core any other way (the compose network, a misconfigured proxy).
 */
export const CORE_MAX_BODY_BYTES = 48 * 1024 * 1024;

class PayloadTooLarge extends Error {
  constructor() { super('Payload Too Large'); this.name = 'PayloadTooLarge'; }
}

/**
 * Refuses a body over `maxBytes` with `refuse(c)`. A declared length is checked before any handler
 * runs. An undeclared (chunked) body is counted as the handler reads it, never buffered here, so the
 * routes that bound a stalled upload with their own deadline keep doing so; once it passes the limit
 * the stream errors and the answer is replaced by the refusal.
 */
export function coreBodyLimit(maxBytes: number, refuse: (c: Context) => Response): MiddlewareHandler {
  return async (c, next) => {
    const body = c.req.raw.body;
    if (!body) return next();
    const declared = c.req.raw.headers.get('content-length');
    if (declared !== null && !c.req.raw.headers.has('transfer-encoding')) {
      if (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes) return refuse(c);
      return next();
    }
    let size = 0;
    let exceeded = false;
    const counted = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          exceeded = true;
          controller.error(new PayloadTooLarge());
          return;
        }
        controller.enqueue(chunk);
      },
    }));
    c.req.raw = new Request(c.req.raw, { body: counted, duplex: 'half' } as RequestInit);
    await next();
    if (exceeded) c.res = refuse(c);
  };
}
