import { createHash } from 'node:crypto';
import { z } from 'zod';
import { studioTextUsage } from '@hawa/creative';
import type { StudioCallReservation } from '@hawa/domain';

const box={x:z.number().finite().nonnegative(),y:z.number().finite().nonnegative(),width:z.number().finite().positive(),height:z.number().finite().positive()};
export const plannerLayout=z.object({width:z.number().int().positive(),height:z.number().int().positive(),background:z.string().max(80),
  text:z.array(z.object({...box,copyIndex:z.number().int().nonnegative(),role:z.enum(['headline','title','subtitle','body','caption','date','location','meta']).optional(),fontSize:z.number().finite().positive(),fontFamily:z.string().max(80),color:z.string().max(80),align:z.enum(['left','center','right']),bold:z.boolean().optional()}).strict()).min(1).max(40),
  shapes:z.array(z.object({...box,color:z.string().max(80)}).strict()).max(40),logo:z.object(box).strict()}).strict();
export type PlannerLayout=z.infer<typeof plannerLayout>;
export interface PlannerCallOutcome {
  acceptance:'response_received'|'not_accepted'|'unknown';
  costBasis:'usage'|'not_accepted'|'unavailable'; costUsd:number|null; requiresReconciliation:boolean;
  inputTokens:number|null; outputTokens:number|null; providerRequestId:string|null; responseId:string|null;
  servedModel:string|null; responseSha256:string|null; latencyMs:number; diagnostic:string; layout:PlannerLayout|null;
}
export interface PlannerCallMetadata {
  expectedTaskVersion:number; isRevision:boolean; conversationalRevision:boolean; isRedesign:boolean; hasReferenceImage:boolean;
  exemplars:Array<{label:string;sha256?:string}>; priorPlanId:string|null; turns:number;
}
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const id=(v:unknown,max=200):string|null=>typeof v==='string'&&v.length<=max&&/^[a-zA-Z0-9_.:-]+$/.test(v)?v:null;
async function boundedText(response:Response):Promise<string>{
  if(!response.body)return '';
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>512*1024){await reader.cancel();throw new Error('RESPONSE_TOO_LARGE');}chunks.push(value);}
    return Buffer.concat(chunks).toString('utf8');
  }finally{reader.releaseLock();}
}
/** Called only after durable admission. No retries, credentials or raw provider errors in outcomes. */
export async function executePlannerCall(key:string,body:string,model:string,reservation:StudioCallReservation,fetcher:typeof fetch):Promise<PlannerCallOutcome>{
  const started=performance.now();
  const out:PlannerCallOutcome={acceptance:'unknown',costBasis:'unavailable',costUsd:null,requiresReconciliation:true,
    inputTokens:null,outputTokens:null,providerRequestId:null,responseId:null,servedModel:null,responseSha256:null,
    latencyMs:0,diagnostic:'MODEL_RESPONSE_UNCERTAIN',layout:null};
  try{
    const response=await fetcher('https://api.openai.com/v1/chat/completions',{method:'POST',body,
      headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(90000),redirect:'error'});
    out.providerRequestId=id(response.headers.get('x-request-id'));
    if([400,401,403,422,429].includes(response.status)){
      out.acceptance='not_accepted';out.costBasis='not_accepted';out.costUsd=0;out.requiresReconciliation=false;
    }else if(response.ok)out.acceptance='response_received';
    out.diagnostic=`MODEL_HTTP_${response.status}`;
    const raw=await boundedText(response);out.responseSha256=createHash('sha256').update(raw).digest('hex');
    if(!response.ok)return out;
    out.diagnostic='MODEL_RESPONSE_INVALID';
    const data=object(JSON.parse(raw));out.responseId=id(data.id);out.servedModel=id(data.model,160);
    const usage=studioTextUsage(model,out.servedModel,data.usage);
    if(usage){out.inputTokens=usage.inputTokens;out.outputTokens=usage.outputTokens;out.costUsd=usage.estimatedCostUsd;out.costBasis='usage';}
    const modelMatches=out.servedModel===model||Boolean(usage?.modelMatches);
    if(!out.responseId||!modelMatches){out.diagnostic='MODEL_RECEIPT_INVALID';return out;}
    const withinBound=usage&&usage.outputTokens>0&&usage.inputTokens<=reservation.inputTokens&&usage.outputTokens<=reservation.outputTokens&&usage.estimatedCostUsd<=reservation.usd;
    out.requiresReconciliation=!withinBound;
    out.diagnostic=usage?(withinBound?'LAYOUT_SCHEMA_INVALID':'MODEL_RESERVATION_EXCEEDED'):'MODEL_USAGE_INCOMPLETE';
    const choice=object(Array.isArray(data.choices)?data.choices[0]:null),message=object(choice.message);
    // Native structured output must be complete JSON. Do not rescue prose/code fences into success.
    if(typeof message.content!=='string'||message.refusal||choice.finish_reason!=='stop')return out;
    const parsed=plannerLayout.safeParse(JSON.parse(message.content));
    if(parsed.success&&parsed.data.text.every(t=>t.role!==undefined&&t.bold!==undefined)){
      out.layout=parsed.data;if(!out.requiresReconciliation)out.diagnostic='LAYOUT_SAVED';
    }
    return out;
  }catch{return out;}
  finally{out.latencyMs=Math.min(2147483647,Math.max(0,Math.round(performance.now()-started)));}
}
