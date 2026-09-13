import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { RouteContext } from './types.js';
import { CanvaConnectService, CanvaFlowError, type CanvaServiceOptions } from '../services/canva-connect-service.js';
import { CanvaDesignPlanner } from '../services/canva-design-planner.js';

export function registerCanvaRoutes(ctx: RouteContext, options?: CanvaServiceOptions) {
  const service = ctx.db ? new CanvaConnectService(ctx.db,options) : null;
  const planner = ctx.db && service ? new CanvaDesignPlanner(ctx.db,service) : null;
  const protect = (fn: (c: any,s: {tenantId:string;actorId:string},api:CanvaConnectService) => Promise<Response>) => async (c: any) => {
    c.header('Cache-Control','no-store');
    const auth=ctx.verifyRequestAuth(c);
    if (!auth.authenticated || !auth.tenantId || !auth.userId) return ctx.problem(c,401,'Authentication Required','Sign in to Hawa first');
    if (!['administrator','art_director','creative_director','operator','designer'].includes(auth.role || '')) return ctx.problem(c,403,'Canva Access Forbidden','This role cannot operate the Canva integration');
    if (!service) return ctx.problem(c,503,'Database Required','Canva operations require durable storage');
    for (const name of ['taskId','operationId','artifactId']) {
      const value=c.req.param(name); if (value && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return ctx.problem(c,422,'Invalid Identifier','Use a valid task or operation identifier');
    }
    try { return await fn(c,{tenantId:auth.tenantId,actorId:auth.userId},service); }
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
  ctx.registerRoute('get','/tasks/:taskId/canva/editor',protect(async(c,s,api)=>c.json(await api.editor(s,c.req.param('taskId')))));
  ctx.registerRoute('get','/tasks/:taskId/canva/plans',protect(async(c,s)=>c.json({plans:await planner!.state(s,c.req.param('taskId'))})));
  ctx.registerRoute('post','/tasks/:taskId/canva/generate',protect(async(c,s)=>{
    const body=await c.req.json().catch(()=>({}));
    return c.json(await planner!.generate(s,c.req.param('taskId'),c.req.header('Idempotency-Key')||'',body.width,body.height),202);
  }));
  ctx.registerRoute('post','/tasks/:taskId/canva/plans/:operationId/resume',protect(async(c,s)=>c.json(await planner!.resume(s,c.req.param('taskId'),c.req.param('operationId')))));
  ctx.registerRoute('post','/tasks/:taskId/canva/imports/:operationId/resume',protect(async(c,s,api)=>c.json(await api.resumeImport(s,c.req.param('taskId'),c.req.param('operationId')))));
  ctx.registerRoute('post','/tasks/:taskId/canva/design',protect(async(c,s,api)=>{
    const body=await c.req.json().catch(()=>({}));
    const result=await api.createDesign(s,c.req.param('taskId'),c.req.header('Idempotency-Key')||'',body.width,body.height);
    return c.json(result,result.status==='retrieved'?201:202);
  }));
  ctx.registerRoute('post','/tasks/:taskId/canva/exports',protect(async(c,s,api)=>{
    const body=await c.req.json().catch(()=>({}));
    return c.json(await api.startExport(s,c.req.param('taskId'),c.req.header('Idempotency-Key')||'',body.format,body.expectedVersion),202);
  }));
  ctx.registerRoute('post','/tasks/:taskId/canva/exports/:operationId/resume',protect(async(c,s,api)=>
    c.json(await api.exportStatus(s,c.req.param('taskId'),c.req.param('operationId')))));
  ctx.registerRoute('get','/tasks/:taskId/canva/artifacts/:artifactId',protect(async(c,s,api)=>{
    const file=await api.artifact(s,c.req.param('taskId'),c.req.param('artifactId'));
    c.header('Content-Type',file.format==='png'?'image/png':file.format==='pptx'?'application/vnd.openxmlformats-officedocument.presentationml.presentation':'application/pdf');
    c.header('Content-Disposition',`attachment; filename="canva-${file.sha256}.${file.format==='png'?'png':file.format==='pptx'?'pptx':'pdf'}"`);
    c.header('X-Content-SHA256',file.sha256);
    return c.body(new Uint8Array(file.content));
  }));
}
