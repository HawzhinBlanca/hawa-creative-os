import type { Context } from 'hono';
import type { RouteContext } from './types.js';
import { readPublicationInspections } from '../services/publication-inspections.js';

export function registerPublicationInspectionRoutes(ctx: RouteContext, enabled: boolean) {
  ctx.registerRoute('get','/operations/publication-inspections',async (c: Context) => {
    c.header('Cache-Control','no-store');
    const auth = ctx.verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId || !auth.userId || !auth.role) return ctx.problem(c,401,'Authentication Required');
    if (!ctx.db) return ctx.problem(c,503,'Database Required');
    try { return c.json(await readPublicationInspections(ctx.db,{tenantId:auth.tenantId,userId:auth.userId,role:auth.role},enabled,c.req.query('after'))); }
    catch (error) {
      if (error instanceof Error && error.message === 'PUBLICATION_INSPECTION_FORBIDDEN') return ctx.problem(c,403,'Publication Inspections Forbidden');
      if (error instanceof Error && error.message === 'PUBLICATION_INSPECTION_CURSOR_INVALID') return ctx.problem(c,400,'Invalid Inspection Cursor');
      return ctx.problem(c,503,'Publication Inspections Unavailable','Stored Google inspection evidence could not be read. Reload after access is restored.');
    }
  });
}
