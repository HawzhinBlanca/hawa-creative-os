import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import type { RouteContext } from './types.js';
import { CallCostAccountingService } from '../services/call-cost-accounting.js';
import { CanvaFlowError } from '../services/canva-flow-error.js';

export function registerCallCostRoutes(ctx: RouteContext) {
  const service=ctx.db ? new CallCostAccountingService(ctx.db) : null;
  const handle=(operation:'list'|'get'|'record')=>async(c:Context)=>{
    c.header('Cache-Control','no-store');
    const auth=ctx.verifyRequestAuth(c),token=ctx.bearerTokenOf?.(c);
    if(!auth.authenticated||!auth.tenantId||!auth.userId) return ctx.problem(c,401,'Authentication Required');
    if(!['administrator','operator','auditor'].includes(auth.role||'')) return ctx.problem(c,403,'Call Accounting Forbidden');
    if(!service) return ctx.problem(c,503,'Database Required');
    const scope={tenantId:auth.tenantId,userId:auth.userId,role:auth.role,
      trustedOffice:auth.authMethod==='trusted_office',sessionHash:auth.authMethod==='google_oidc'&&token?createHash('sha256').update(token).digest('hex'):undefined};
    try {
      return c.json(operation==='list' ? await service.list(scope,c.req.query('cursor')) : operation==='get'
        ? await service.get(scope,c.req.param('kind')??'',c.req.param('callId')??'')
        : await service.record(scope,c.req.param('kind')??'',c.req.param('callId')??'',c.req.header('Idempotency-Key'),await c.req.json().catch(()=>null)));
    }catch(error){
      if(error instanceof CanvaFlowError) return ctx.problem(c,error.status,error.code,error.message);
      return ctx.problem(c,503,'Call Accounting Unavailable','Reload the evidence or retry the same saved action.');
    }
  };
  ctx.registerRoute('get','/spending/calls',handle('list'));
  ctx.registerRoute('get','/spending/calls/:kind/:callId',handle('get'));
  ctx.registerRoute('post','/spending/calls/:kind/:callId/evidence',handle('record'));
}
