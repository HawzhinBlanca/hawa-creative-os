import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';

// The lifecycle ownership guard reads the task from Postgres; this test has none and is about the
// refusal's header only, so the guard lets the request through.
vi.mock('../src/routes/lifecycle-design-proof.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/routes/lifecycle-design-proof.js')>()),
  rejectUnownedLifecycleDesignWrite: async () => null,
}));

const { registerCanvaRoutes } = await import('../src/routes/canva.routes.js');
const { CanvaDesignPlanner } = await import('../src/services/canva-design-planner.js');
const { CanvaFlowError } = await import('../src/services/canva-connect-service.js');

/**
 * The worker waits the time Core names on a busy answer (Retry-After) instead of doubling its sleep
 * (ADR-131), so the generation route has to send the planner's wait as the header, in whole seconds.
 */
function app() {
  const hono = new Hono();
  const ctx: any = {
    app: hono,
    db: {},
    registerRoute: (method: 'get' | 'post', path: string, handler: any) => hono[method]('/v1' + path, handler),
    verifyRequestAuth: () => ({ authenticated: true, tenantId: '00000000-0000-4000-a000-000000000001', userId: 'worker', role: 'operator' }),
    problem: (c: any, status: number, title: string, detail?: string) => c.json({ title, status, detail: detail || title }, status),
  };
  registerCanvaRoutes(ctx);
  return hono;
}
const generate = (hono: Hono) =>
  hono.request('/v1/tasks/00000000-0000-4000-c000-000000000009/canva/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'route-busy-key' },
    body: JSON.stringify({ width: 1200, height: 1697 }),
  });

afterEach(() => vi.restoreAllMocks());

describe('the generation route when every planning slot is taken', () => {
  it("answers 429 PLANNING_BUSY with the planner's wait as Retry-After, rounded up to whole seconds", async () => {
    vi.spyOn(CanvaDesignPlanner.prototype, 'generate').mockRejectedValue(new CanvaFlowError(429, 'PLANNING_BUSY', 'All 5 planning slots are taken.', 7200));
    const res = await generate(app());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('8');
    expect(await res.json()).toMatchObject({ title: 'PLANNING_BUSY' });
  });

  it('sends no Retry-After on a refusal that names no wait', async () => {
    vi.spyOn(CanvaDesignPlanner.prototype, 'generate').mockRejectedValue(new CanvaFlowError(409, 'GENERATION_CONFLICT', 'A different generation already exists.'));
    const res = await generate(app());
    expect(res.status).toBe(409);
    expect(res.headers.get('Retry-After')).toBeNull();
  });
});
