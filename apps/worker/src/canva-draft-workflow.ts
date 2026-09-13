import type { WorkflowDurableContext } from './durable-context.js';
import type { WorkflowInput,WorkflowOutput } from './workflow.js';

/** Restate orchestrates retries; Core journals model charges and Canva side effects. */
export async function runCanvaDraft(input:WorkflowInput,ctx:WorkflowDurableContext,fetcher:typeof fetch=fetch):Promise<WorkflowOutput>{
  const output=(status:string,documentId?:string):WorkflowOutput=>({taskId:input.taskId,status,documentId,qcPassed:false,auditEventsCount:0,executedSteps:[],replayedSteps:[]});
  if(!input.canvaAutoGenerate)return output('MANUAL_DESIGN_REQUIRED');
  const base=process.env.HAWA_CORE_INTERNAL_URL||'http://core:3001';
  const token=process.env.HAWA_BEARER_TOKEN;
  if(!token)throw new Error('Worker Core credential is not configured');
  const call=async(path:string,body?:unknown,key?:string)=>{
    const res=await fetcher(base+'/v1/tasks/'+encodeURIComponent(input.taskId)+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(140000)});
    if(!res.ok)throw new Error(`Canva workflow Core boundary HTTP ${res.status}`);
    return res.json() as Promise<any>;
  };
  const task=await ctx.run('canva-verify-task-scope',()=>call(''));
  if(task.clientId!==input.clientId||task.tenantId!==input.tenantId)throw new Error('Workflow task/client/tenant mismatch');
  let result=await ctx.run('canva-create-draft',()=>call('/canva/generate',{width:1200,height:1697},'workflow-'+input.taskId));
  for(let n=0;n<30&&['planning','submitted','creating'].includes(result.status);n++){
    if(ctx.sleep)await ctx.sleep(2000);
    result=await ctx.run('canva-resume-draft-'+n,()=>call('/canva/plans/'+encodeURIComponent(result.planId)+'/resume',{}));
  }
  if(result.status!=='retrieved')return output('DESIGN_'+String(result.status).toUpperCase());
  const state=await ctx.run('canva-read-binding',()=>call('/canva'));
  if(state.binding?.designId!==result.designId)throw new Error('Workflow binding differs from imported document');
  let capture=await ctx.run('canva-export-preview',()=>call('/canva/exports',{format:'png',expectedVersion:state.binding.version},'workflow-preview-'+input.taskId));
  for(let n=0;n<30&&['submitted','creating'].includes(capture.status);n++){
    if(ctx.sleep)await ctx.sleep(2000);
    capture=await ctx.run('canva-resume-preview-'+n,()=>call('/canva/exports/'+encodeURIComponent(capture.operationId)+'/resume',{}));
  }
  // Canva may finish settling an import during the first export. A stale capture
  // stays rejected; take at most two new snapshots without regenerating the design.
  for(let attempt=1;attempt<=2&&capture.status==='stale';attempt++){
    if(ctx.sleep)await ctx.sleep(2000);
    const fresh=await ctx.run('canva-preview-refresh-binding-'+attempt,()=>call('/canva'));
    if(fresh.binding?.designId!==result.designId)throw new Error('Workflow binding changed during preview recovery');
    capture=await ctx.run('canva-preview-recovery-'+attempt,()=>call('/canva/exports',{format:'png',expectedVersion:fresh.binding.version},'workflow-preview-'+input.taskId+'-retry-'+attempt));
    for(let n=0;n<30&&['submitted','creating'].includes(capture.status);n++){
      if(ctx.sleep)await ctx.sleep(2000);
      capture=await ctx.run('canva-resume-preview-recovery-'+attempt+'-'+n,()=>call('/canva/exports/'+encodeURIComponent(capture.operationId)+'/resume',{}));
    }
  }
  if(capture.status!=='retrieved')return output('CANVA_PREVIEW_'+String(capture.status).toUpperCase(),result.designId);
  let check=await ctx.run('canva-export-copy-font-check',()=>call('/canva/exports',{format:'pptx',expectedVersion:state.binding.version},'workflow-check-'+input.taskId));
  for(let n=0;n<30&&['submitted','creating'].includes(check.status);n++){
    if(ctx.sleep)await ctx.sleep(2000);
    check=await ctx.run('canva-resume-copy-font-check-'+n,()=>call('/canva/exports/'+encodeURIComponent(check.operationId)+'/resume',{}));
  }
  if(check.status!=='retrieved'||!check.artifact?.content_check)return output('CANVA_CHECK_REQUIRED',result.designId);
  await ctx.run('canva-notify-result',()=>call('/notifications/canva-ready',{designId:result.designId,status:'DRAFT_READY'}).catch(()=>({})));
  if(!check.artifact.content_check.copyPass)return output('CANVA_COPY_MISMATCH',result.designId);
  if(!check.artifact.content_check.fontPass)return output('CANVA_FONT_MISMATCH',result.designId);
  return output('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',result.designId);
}
