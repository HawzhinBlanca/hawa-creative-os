import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { DesignStudioService } from '../src/services/design-studio/index.js';

// The lifecycle ownership guard reads the task from Postgres; this test has none and is about the
// refusal's header only, so the guard lets the request through.
vi.mock('../src/routes/lifecycle-design-proof.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/routes/lifecycle-design-proof.js')>()),
  rejectUnownedLifecycleDesignWrite: async () => null,
}));

const { registerCanvaRoutes } = await import('../src/routes/canva.routes.js');
const { registerDesignStudioRoutes } = await import('../src/routes/design-studio.routes.js');
const { CanvaConnectService, CanvaFlowError } = await import('../src/services/canva-connect-service.js');

/**
 * Canva refusing an import or export with 429 past the client's short retry used to fail the draft.
 * Core now answers 429 CANVA_RATE_LIMITED with the wait (Retry-After, whole seconds), which the worker
 * keeps before asking again under the same key: on the export route and on the studio's resume, whose
 * transfer stage imports.
 */
const taskId = '00000000-0000-4000-c000-00000000000a';
const runId = '00000000-0000-4000-d000-00000000000a';
const limited = () => new CanvaFlowError(429, 'CANVA_RATE_LIMITED', 'Canva is refusing new exports for now.', 20000);

function app(studio?: Partial<DesignStudioService>) {
  const hono = new Hono();
  const ctx: any = {
    app: hono,
    db: {},
    registerRoute: (method: 'get' | 'post', path: string, handler: any) => hono[method]('/v1' + path, handler),
    verifyRequestAuth: () => ({ authenticated: true, tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }),
    problem: (c: any, status: number, title: string, detail?: string) => c.json({ title, status, detail: detail || title }, status),
  };
  if (studio) registerDesignStudioRoutes(ctx, undefined, studio as DesignStudioService);
  else registerCanvaRoutes(ctx);
  return hono;
}
const post = (hono: Hono, path: string, body: unknown = {}) =>
  hono.request('/v1/tasks/' + taskId + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'route-rate-limit-key' },
    body: JSON.stringify(body),
  });

afterEach(() => vi.restoreAllMocks());

describe('Canva still refusing with 429', () => {
  it('the export route answers 429 CANVA_RATE_LIMITED with the wait as Retry-After', async () => {
    vi.spyOn(CanvaConnectService.prototype, 'startExport').mockRejectedValue(limited());
    const res = await post(app(), '/canva/exports', { format: 'png', expectedVersion: 1 });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('20');
    expect(await res.json()).toMatchObject({ title: 'CANVA_RATE_LIMITED' });
  });

  it('the studio resume answers the same way when its transfer is refused', async () => {
    const res = await post(app({ resume: vi.fn().mockRejectedValue(limited()) }), '/canva/studio/' + runId + '/resume');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('20');
    expect(await res.json()).toMatchObject({ title: 'CANVA_RATE_LIMITED' });
  });
});
