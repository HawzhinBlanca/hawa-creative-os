import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { RouteContext } from './types.js';
import { CanvaConnectService, CanvaFlowError, type CanvaServiceOptions } from '../services/canva-connect-service.js';
import { CanvaDesignPlanner } from '../services/canva-design-planner.js';
import { withRlsContext } from '@hawa/db';
import { TASK_TRANSITIONED_EVENT, taskTransitioned } from '@hawa/contracts';
import { log } from '../logging.js';
import { rejectUnownedLifecycleDesignWrite, nativeRecoveryHeaders } from './lifecycle-design-proof.js';
import type { NativeActorScope } from '../services/lifecycle-native-scope.js';
import { registerNativeReviewRoutes } from './native-review.routes.js';
import { recordManualCanvaReview, type CaptureReview } from '../services/manual-canva-review.js';
import { confirmNativeCopy } from '../services/initial-native-handoff.js';

export function registerCanvaRoutes(ctx: RouteContext, options?: CanvaServiceOptions) {
  registerNativeReviewRoutes(ctx);
  const service = ctx.db ? new CanvaConnectService(ctx.db,options) : null;
  const planner = ctx.db && service ? new CanvaDesignPlanner(ctx.db,service) : null;
  const protect = (fn: (c: any,s: NativeActorScope,api:CanvaConnectService) => Promise<Response>) => async (c: any) => {
    c.header('Cache-Control','no-store');
    const auth=ctx.verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId || !auth.userId) return ctx.problem(c,401,'Authentication Required','Sign in to Hawa first');
    if (!['administrator','art_director','creative_director','operator','designer'].includes(auth.role || '')) return ctx.problem(c,403,'Canva Access Forbidden','This role cannot operate the Canva integration');
    if (!service) return ctx.problem(c,503,'Database Required','Canva operations require durable storage');
    for (const name of ['taskId','operationId','artifactId']) {
      const value=c.req.param(name); if (value && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return ctx.problem(c,422,'Invalid Identifier','Use a valid task or operation identifier');
    }
    const lifecycleRefusal = await rejectUnownedLifecycleDesignWrite(ctx, c, auth);
    if (lifecycleRefusal) return lifecycleRefusal;
    // The role travels with the actor: the service lets an art director or administrator act on
    // another actor's import or source for the task, and the role never reached it (2026-09-24).
    try { return await fn(c,{tenantId:auth.tenantId,actorId:auth.userId,role:auth.role,nativeRecovery:nativeRecoveryHeaders(c)},service); }
    catch (error) {
      if (error instanceof CanvaFlowError) return ctx.problem(c,error.status,error.code,error.message);
      // Never echo provider bodies, OAuth tokens or signed download URLs.
      return ctx.problem(c,502,'Canva Operation Failed','Canva could not complete this operation. Check the connection and existing operation before retrying.');
    }
  };
  ctx.registerRoute('get','/integrations/canva/status',protect(async (c,s,api) => c.json(await api.status(s))));
  ctx.registerRoute('post','/integrations/canva/authorize',protect(async (c,s,api) => {
    const result=await api.startAuthorization(s);
    setCookie(c,'hawa_canva_state',result.state,{httpOnly:true,secure:new URL(api.redirect()).protocol==='https:',sameSite:'Lax',path:'/v1/integrations/canva/callback',maxAge:600});
    return c.json({authorizationUrl:result.authorizationUrl});
  }));
  ctx.registerRoute('post','/integrations/canva/disconnect',protect(async(c,s,api)=>c.json(await api.disconnect(s))));
  // Fixed canonical callback; no caller-provided return URL or redirects with credentials.
  ctx.app.get('/v1/integrations/canva/callback',async c => {
    c.header('Cache-Control','no-store'); c.header('Referrer-Policy','no-referrer');
    const state=c.req.query('state')||'', cookie=getCookie(c,'hawa_canva_state')||'';
    deleteCookie(c,'hawa_canva_state',{path:'/v1/integrations/canva/callback'});
    try {
      if (!service || c.req.query('error')) throw new Error('Authorization unavailable or declined');
      await service.finishAuthorization(state,cookie,c.req.query('code')||'');
      return c.text('Canva is connected to your Hawa account. Return to Hawa Settings and refresh the connection status.');
    } catch { return c.text('Canva connection was not completed. Return to Hawa Settings and connect again.',400); }
  });
  ctx.registerRoute('get','/tasks/:taskId/canva',protect(async(c,s,api)=>c.json(await api.taskState(s,c.req.param('taskId')))));
  ctx.registerRoute('post','/tasks/:taskId/canva/revision-copy',protect(async(c,s)=>{
    const body=await c.req.json().catch(()=>({}));
    return c.json(await withRlsContext(ctx.db!,{tenantId:s.tenantId,userId:s.actorId,role:s.role},
      db=>confirmNativeCopy(db,s,c.req.param('taskId'),c.req.header('Idempotency-Key')||'',body)));
  }));
  ctx.registerRoute('get','/tasks/:taskId/canva/editor',protect(async(c,s,api)=>c.json(await api.editor(s,c.req.param('taskId')))));
  ctx.registerRoute('get','/tasks/:taskId/canva/amendment-observation',protect(async(c,s,api)=>c.json(await api.amendmentObservation(s,c.req.param('taskId')))));
  ctx.registerRoute('get','/tasks/:taskId/canva/plans',protect(async(c,s)=>c.json({plans:await planner!.state(s,c.req.param('taskId'))})));
  ctx.registerRoute('post','/tasks/:taskId/canva/generate',protect(async(c,s)=>{
    const body=await c.req.json().catch(()=>({}));
    return c.json(await planner!.generate(s,c.req.param('taskId'),c.req.header('Idempotency-Key')||'',body.width,body.height),202);
  }));
  ctx.registerRoute('post','/tasks/:taskId/canva/plans/:operationId/resume',protect(async(c,s)=>c.json(await planner!.resume(s,c.req.param('taskId'),c.req.param('operationId')))));
  ctx.registerRoute('post','/tasks/:taskId/canva/plans/:operationId/abandon',protect(async(c,s)=>{
    const body=await c.req.json().catch(()=>({}));
    return c.json(await planner!.abandon(s,c.req.param('taskId'),c.req.param('operationId'),body.reason));
  }));
  ctx.registerRoute('post','/tasks/:taskId/canva/imports/:operationId/resume',protect(async(c,s,api)=>c.json(await api.resumeImport(s,c.req.param('taskId'),c.req.param('operationId')))));
  ctx.registerRoute('post','/tasks/:taskId/canva/design',protect(async(c,s,api)=>{
    const body=await c.req.json().catch(()=>({}));
    const result=await api.createDesign(s,c.req.param('taskId'),c.req.header('Idempotency-Key')||'',body.width,body.height);
    return c.json(result,result.status==='retrieved'?201:202);
  }));
  /**
   * A copy-and-font check retrieved here (the Desk's "Check copy & fonts", or the worker's own) becomes
   * the manual task's captured revision, or the automatic draft's latest QC run, so capturing again after a
   * failed or timed-out check unblocks approval; after a revision request it becomes the new revision
   * (recordCheckedExportQc). Nothing recorded it until 2026-09-24. The evaluator lives in app.ts,
   * which has loaded by the time a request arrives.
   */
  const recordCheck = async (s: {tenantId:string;actorId:string;role?:string}, taskId: string, result: { status?: string; artifact?: { id?: string; format?: string; content_check?: unknown } | null }): Promise<CaptureReview | undefined> => {
    if (result?.status!=='retrieved'||result.artifact?.format!=='pptx'||!result.artifact.content_check||!ctx.db) return;
    try {
      const owned = await withRlsContext(ctx.db,{tenantId:s.tenantId,userId:s.actorId,role:s.role||'operator'},trx=>
        trx.selectFrom('tasks').select('request_id').where('tenant_id','=',s.tenantId).where('id','=',taskId).executeTakeFirst());
      if (owned?.request_id) return {status:'blocked',retryable:false,reason:'The checked files are retained. Submit this native revision through the current request for review.'};
      const [{ recordCheckedExportQc }, { evaluateCanvaExportQc }] = await Promise.all([import('../services/canva-task-outcome.js'), import('../core-helpers.js')]);
      if (result.artifact?.id) {
        const manual = await withRlsContext(ctx.db,
          {tenantId:s.tenantId,userId:s.actorId,role:s.role||'operator'}, trx=>recordManualCanvaReview(trx,evaluateCanvaExportQc,
            {tenantId:s.tenantId,taskId,actorId:s.actorId,artifactId:result.artifact!.id!}));
        if (manual.status !== 'not_applicable') return manual;
      }
      const recorded = await withRlsContext(ctx.db,{tenantId:s.tenantId,userId:s.actorId,role:s.role||'operator'},(trx)=>recordCheckedExportQc(trx,evaluateCanvaExportQc,{tenantId:s.tenantId,taskId,actorId:s.actorId,rework:true}));
      // The revision, its QC run and the task's move are Postgres's; approval reads them there.
      if (recorded.recorded && recorded.transition?.changed) {
        // Its own catch: the check is recorded by now, so a failure here is only the event's.
        const { fromState, toState, version } = recorded.transition;
        try {
          ctx.broadcastEvent(TASK_TRANSITIONED_EVENT, taskTransitioned({ taskId, from: fromState, to: toState, version }));
        } catch (err) {
          log.error(`[canva] Task ${taskId}: ${TASK_TRANSITIONED_EVENT} not sent:`, (err as Error)?.message || err);
        }
      }
      if (recorded.recorded) return { status:'recorded',revisionId:recorded.revisionId,
        qaPassed:recorded.qc.status==='passed'&&recorded.qc.criticalPass,
        checkedArtifactId:String(recorded.qc.qaReport.exportArtifactId) };
    } catch (err) {
      log.warn(`[canva] Task ${taskId}: the retrieved check could not be recorded as a QC run:`, (err as Error)?.message || err);
      return {status:'blocked',retryable:true,reason:'The export is retained, but its review could not be recorded. Resume this operation to retry safely.'};
    }
  };
  ctx.registerRoute('post','/tasks/:taskId/canva/exports',protect(async(c,s,api)=>{
    const body=await c.req.json().catch(()=>({}));
    const result=await api.startExport(s,c.req.param('taskId'),c.req.header('Idempotency-Key')||'',body.format,body.expectedVersion);
    const review=await recordCheck(s,c.req.param('taskId'),result);
    return c.json({...result,...(review?{review}:{})},202);
  }));
  ctx.registerRoute('post','/tasks/:taskId/canva/exports/:operationId/resume',protect(async(c,s,api)=>{
    const result=await api.exportStatus(s,c.req.param('taskId'),c.req.param('operationId'));
    const review=await recordCheck(s,c.req.param('taskId'),result);
    return c.json({...result,...(review?{review}:{})});
  }));
  ctx.registerRoute('get','/tasks/:taskId/canva/artifacts/:artifactId',protect(async(c,s,api)=>{
    const file=await api.artifact(s,c.req.param('taskId'),c.req.param('artifactId'));
    c.header('Content-Type',file.format==='png'?'image/png':file.format==='pptx'?'application/vnd.openxmlformats-officedocument.presentationml.presentation':'application/pdf');
    c.header('Content-Disposition',`attachment; filename="canva-${file.sha256}.${file.format==='png'?'png':file.format==='pptx'?'pptx':'pdf'}"`);
    c.header('X-Content-SHA256',file.sha256);
    return c.body(new Uint8Array(file.content));
  }));
}
