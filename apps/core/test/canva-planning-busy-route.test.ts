import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { registerCanvaRoutes } from '../src/routes/canva.routes.js';
import { CanvaDesignPlanner } from '../src/services/canva-design-planner.js';
import { CanvaFlowError } from '../src/services/canva-connect-service.js';

/**
 * The worker waits the time Core names on a busy answer (Retry-After) instead of doubling its sleep,
 * so the generation route has to send the planner's wait as the header, in whole seconds.
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
  it('answers 429 PLANNING_BUSY with the planner\'s wait as Retry-After', async () => {
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
