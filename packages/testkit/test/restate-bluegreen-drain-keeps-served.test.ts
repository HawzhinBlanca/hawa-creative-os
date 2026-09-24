import { describe, it, expect } from 'vitest';
import { RestateAdmin, finishDrains } from '../../../scripts/restate-bluegreen.js';

/**
 * Review finding (phase 0.1 fix round): finishDrains deleted a non-live deployment that was still the
 * only deployment of a service, which brought back "service 'TaskService' not found" (2026-09-17 class).
 */
describe('finishDrains never deletes a deployment a service is still routed to', () => {
  it('keeps legacy while TaskService is still served by it, even with nothing pinned', async () => {
    const serving: Record<string, string> = { TaskWorkflow: 'dp_blue', TaskService: 'dp_legacy' };
    const deletes: string[] = [];
    const fetcher = async (url: string, init: any = {}) => {
      const u = new URL(url); const m = (init.method || 'GET').toUpperCase();
      if (m === 'GET' && u.pathname === '/deployments') return Response.json({ deployments: [
        { id: 'dp_legacy', uri: 'http://worker:9080/' }, { id: 'dp_blue', uri: 'http://worker-blue:9080/' }] });
      if (m === 'GET' && u.pathname === '/services') return Response.json({ services: Object.entries(serving).map(([name, deployment_id]) => ({ name, deployment_id })) });
      const s = /^\/services\/(\w+)$/.exec(u.pathname);
      if (m === 'GET' && s) return serving[s[1]] ? Response.json({ deployment_id: serving[s[1]] }) : new Response('', { status: 404 });
      if (m === 'POST' && u.pathname === '/query') return Response.json({ rows: [{ n: 0 }] });
      if (m === 'DELETE') { const id = u.pathname.split('/').pop()!; deletes.push(id); for (const k of Object.keys(serving)) if (serving[k] === id) delete serving[k]; return new Response(null, { status: 202 }); }
      return new Response('', { status: 404 });
    };
    const report = await finishDrains(new RestateAdmin('http://restate:9070', fetcher as any), { waitMs: 0 });
    expect(deletes).toEqual([]);                 // was ['dp_legacy']
    expect(serving.TaskService).toBe('dp_legacy'); // was undefined -> ingress 404 service not found
    expect(report.deleted).toEqual([]);
  });
});
