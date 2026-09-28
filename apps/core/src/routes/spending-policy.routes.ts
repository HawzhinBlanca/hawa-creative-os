import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import type { RouteContext } from './types.js';
import { SpendingPolicyService } from '../services/spending-policy.js';
import { CanvaFlowError } from '../services/canva-flow-error.js';

export function registerSpendingPolicyRoutes(ctx:RouteContext) {
  const service=ctx.db?new SpendingPolicyService(ctx.db):null;
  const handle=(write:boolean)=>async(c:Context)=>{
    c.header('Cache-Control','no-store');
    const auth=ctx.verifyRequestAuth(c),token=ctx.bearerTokenOf?.(c);
    if(!auth.authenticated||!auth.tenantId||!auth.userId)return ctx.problem(c,401,'Authentication Required');
    if(!['administrator','operator','auditor'].includes(auth.role||''))return ctx.problem(c,403,'Spending Policy Forbidden');
    if(!service)return ctx.problem(c,503,'Database Required');
    const scope={tenantId:auth.tenantId,userId:auth.userId,role:auth.role,
      sessionHash:auth.authMethod==='google_oidc'&&token?createHash('sha256').update(token).digest('hex'):undefined};
    try{return c.json(write?await service.record(scope,c.req.header('Idempotency-Key'),await c.req.json().catch(()=>null))
      :await service.get(scope,c.req.query('beforeVersion')));
    }catch(error){
      if(error instanceof CanvaFlowError)return ctx.problem(c,error.status,error.code,error.message);
      return ctx.problem(c,503,'Spending Policy Unavailable','Reload the policy or retry the same saved action.');
    }
  };
  ctx.registerRoute('get','/spending/policy',handle(false));
  ctx.registerRoute('post','/spending/policy',handle(true));
}
