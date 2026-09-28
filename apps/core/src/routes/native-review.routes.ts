import { withRlsContext } from '@hawa/db';
import { parseNativeReviewSubmission } from '@hawa/domain';
import { isServiceUserId } from '@hawa/contracts';
import { signLifecycleOfficeEvent } from '@hawa/integrations';
import { nativeReviewReceipt } from '../services/lifecycle-native-review.js';
import { CanvaFlowError } from '../services/canva-flow-error.js';
import type { RouteContext } from './types.js';
import type { Context } from 'hono';

export function registerNativeReviewRoutes(ctx: RouteContext) {
  ctx.registerRoute('post','/tasks/:taskId/native-review',async (c:Context)=>{
    const auth=ctx.verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId || !auth.userId) return ctx.problem(c,401,'Authentication Required');
    if (isServiceUserId(auth.userId)) return ctx.problem(c,403,'Human Submission Required');
    if (!ctx.db) return ctx.problem(c,503,'Database Required');
    const body=await c.req.json().catch(()=>null);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k=>
      !['requestId','expectedRev','expectedTaskVersion','artifactId','confirmationEventId'].includes(k)))
      return ctx.problem(c,422,'Invalid Native Review');
    const actionId=c.req.header('Idempotency-Key') || '';
    const event=parseNativeReviewSubmission({...body,v:1,kind:'native_review',eventId:`desk:${actionId}`,actionId,
      taskId:c.req.param('taskId'),actor:{userId:auth.userId,role:auth.role}});
    if (!event) return ctx.problem(c,422,'Invalid Native Review','Submit the current request, confirmation and checked artifact with a stable action ID.');
    try {
      const prior=await withRlsContext(ctx.db,{tenantId:auth.tenantId,userId:auth.userId,role:auth.role},async trx=>{
        const task=await trx.selectFrom('tasks').select('request_id').where('tenant_id','=',auth.tenantId!)
          .where('id','=',event.taskId).executeTakeFirst();
        if (task?.request_id !== event.requestId) throw new CanvaFlowError(409,'NATIVE_REVIEW_STALE','The task is not owned by this request.');
        const receipt=await nativeReviewReceipt(trx,auth.tenantId!,event);
        const request=await trx.selectFrom('requests').select('rev').where('tenant_id','=',auth.tenantId!)
          .where('request_id','=',event.requestId).executeTakeFirst();
        // At the receipt revision, retry the owner so it can adopt a Core commit whose
        // response was lost. A later owner transition proves that adoption already happened.
        return receipt && Number(request?.rev)>receipt.rev ? receipt : undefined;
      });
      if (prior) return c.json(prior);
      const ingress=(process.env.RESTATE_INGRESS_URL||'').trim().replace(/\/+$/,''),secret=(process.env.HAWA_WORKER_TOKEN||'').trim();
      if (!ingress || !secret) return ctx.problem(c,503,'Lifecycle Review Unavailable','The request gateway is not configured.');
      const response=await fetch(`${ingress}/OfficeDecisionGateway/nativeReview`,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({v:1,event,signature:signLifecycleOfficeEvent(secret,event)}),signal:AbortSignal.timeout(15000)});
      const result=await response.json().catch(()=>null);
      if (response.ok && result?.accepted === true && result.requestId === event.requestId && result.taskId === event.taskId &&
          result.actionId === actionId && result.stage === 'in_review' && result.rev === event.expectedRev+1 &&
          typeof result.revisionId === 'string' && /^[0-9a-f-]{36}$/i.test(result.revisionId) && typeof result.qaPassed === 'boolean') return c.json(result);
      if ((response.ok && result?.accepted === false) || [400,409,422].includes(response.status))
        return ctx.problem(c,409,'Native Review Changed','Reload the current request, confirmation and captures before submitting.');
    } catch (error) {
      if (error instanceof CanvaFlowError) return ctx.problem(c,error.status,error.code,error.message);
    }
    return ctx.problem(c,503,'Native Review Uncertain','The submission may have committed. Retry with the same action ID and unchanged request.');
  });
}
