import type { Context } from 'hono';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import type { RouteContext } from './types.js';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { revisionMetrics } from '../services/revision-metrics.js';

/**
 * What the office and the owner read about the system itself: the revision loop's numbers, the
 * studio's status and the cutover's. Moved out of app.ts by group G1 (leaves) of the split
 * (architecture programme 1.3, SPLIT_PLAN.md section 2). Not system.routes.ts, which only the
 * delivery group may edit while the split runs.
 */
export function registerSystemStatusRoutes(ctx: RouteContext): void {
  const { registerRoute, verifyRequestAuth, problem, db, globalCanvaCircuitBreaker } = ctx;
  // Production Studio is strictly Canva Native Studio under ADR 021 & CV-22/CV-23
  const activeStudioType = 'canva';

  // How the revision loop is doing (services/revision-metrics.ts): for the art director and the owner.
  registerRoute('get', '/system/revision-metrics', async (c: Context) => {
    const auth = verifyRequestAuth(c);
    if (!auth.authenticated) return problem(c, 401, 'Authentication Required');
    if (!['administrator', 'art_director', 'creative_director'].includes(String(auth.role))) return problem(c, 403, 'Forbidden', 'Art director or administrator required');
    if (!db) return problem(c, 503, 'Database Unavailable');
    const days = Number(c.req.query('days') || 30);
    const metrics = await revisionMetrics(db, { tenantId: auth.tenantId || DEFAULT_TENANT_ID, userId: auth.userId || SYSTEM_AUTOMATION_USER_ID }, Number.isFinite(days) ? days : 30);
    return c.json(metrics);
  });

  // Selected provider and measured readiness are separate concepts (ADR 022).
  registerRoute('get', '/system/studio-status', (c: any) => c.json({
    status: 'requires_native_handoff', activeStudio: activeStudioType,
    studioVersion: '2.1.0-handoff', cloudConnected: false, admittedClients: [],
    admittedTaskClasses: [], qualification: 'not_verified',
    circuitBreaker: globalCanvaCircuitBreaker.getSnapshot(), timestamp: new Date().toISOString(),
  }));
  registerRoute('get', '/system/cutover/status', (c: any) => c.json({
    cutoverState: 'NOT_QUALIFIED',
    release: { version: '2.1.0-handoff', gitCommit: process.env.HAWA_BUILD_COMMIT || null },
    activeStudio: { provider: 'canva', cloudConnected: false },
    pilotSignoff: null, dataCounts: null,
    blockers: ['Native capture not verified', 'Live publication not qualified', 'Exact-build recovery and human pilot required'],
  }));
  registerRoute('post', '/system/cutover/rollback-rehearsal', (c: any) => {
    if (!verifyRequestAuth(c).authenticated) return problem(c, 401, 'Authentication Required');
    return problem(c, 422, 'Recovery Drill Required', 'This endpoint cannot certify recovery. Run an isolated restore drill and attach its measured evidence');
  });
}
