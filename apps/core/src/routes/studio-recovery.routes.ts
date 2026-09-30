import { createHash } from 'node:crypto';
import type { RouteContext } from './types.js';
import { StudioCallSettlementService } from '../services/studio-call-settlement.js';
import { CanvaFlowError } from '../services/canva-flow-error.js';

/** Adds financial evidence only; does not bypass the owner of any design/task mutation. */
export function registerStudioRecoveryRoutes(ctx:RouteContext) {
  const service=ctx.db?new StudioCallSettlementService(ctx.db):null;
  const handle=(write:boolean)=>async(c:any)=>{
    c.header('Cache-Control','no-store');
    const auth=ctx.verifyRequestAuth(c),token=ctx.bearerTokenOf?.(c);
    if(!auth.authenticated||!auth.tenantId||!auth.userId) return ctx.problem(c,401,'Authentication Required');
    if(!['administrator','operator','designer','art_director','creative_director'].includes(auth.role||'')) return ctx.problem(c,403,'Studio Recovery Forbidden');
    if(!service) return ctx.problem(c,503,'Database Required');
    // ADR-159: the trusted office (ADR-146) may record the evidence as the shared office administrator;
    // the settlement names that evidence type, since no individual signed in.
    const scope={tenantId:auth.tenantId,userId:auth.userId,role:auth.role,
      sessionHash:auth.authMethod==='google_oidc'&&token?createHash('sha256').update(token).digest('hex'):undefined,
      trustedOffice:auth.authMethod==='trusted_office'};
    try {
      const result=write
        ?await service.settle(scope,c.req.param('taskId'),c.req.param('runId'),c.req.header('Idempotency-Key'),await c.req.json().catch(()=>null))
        :await service.get(scope,c.req.param('taskId'),c.req.param('runId'));
      return c.json(result);
    }catch(error){
      if(error instanceof CanvaFlowError) return ctx.problem(c,error.status,error.code,error.message);
      return ctx.problem(c,503,'Studio Recovery Unavailable','Reload the evidence or retry the same saved settlement action.');
    }
  };
  ctx.registerRoute('get','/tasks/:taskId/studio-recovery/:runId',handle(false));
  ctx.registerRoute('post','/tasks/:taskId/studio-recovery/:runId/settlement',handle(true));
}
