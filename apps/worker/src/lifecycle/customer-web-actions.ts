import {createHmac,timingSafeEqual} from 'node:crypto';
import * as restate from '@restatedev/restate-sdk';
import {nextOfficeMoment} from '@hawa/domain';
import {isCustomerActionCommand,isCustomerActionEvent,type CustomerActionCommand,type CustomerActionEvent,type CustomerActionResult} from '@hawa/contracts';
import {acceptedWorkerSecrets} from './worker-secrets.js';
import type {CoreInternal} from './delivery.js';
import type {AutomaticOpenContext,AutomaticLifecycleState} from './request-lifecycle.js';
const TENANT='00000000-0000-4000-a000-000000000001';
export interface SignedCustomerActionCommand extends CustomerActionCommand {signature:string}
const bytes=(c:CustomerActionCommand)=>JSON.stringify(['hawa.customer.web.action.v1',c.v,c.requestId,c.tenantId,c.accountId,c.commandId,c.actionId,c.key]);
export function signCustomerActionCommand(c:CustomerActionCommand,secret:string):SignedCustomerActionCommand {
 if(!isCustomerActionCommand(c) || c.tenantId!==TENANT || !secret.trim())throw new Error('INVALID_CUSTOMER_ACTION_COMMAND');
 return {...c,signature:createHmac('sha256',secret.trim()).update(bytes(c)).digest('hex')};
}
export async function forwardCustomerAction(ctx:{key:string;run<T>(name:string,fn:()=>Promise<T>):Promise<T>;send(requestId:string,event:CustomerActionEvent):void|Promise<void>},
 core:CoreInternal,input:SignedCustomerActionCommand,secrets=acceptedWorkerSecrets()) {
 if(!isCustomerActionCommand(input) || input.tenantId!==TENANT || ctx.key!==`web:${input.accountId}` || Buffer.byteLength(JSON.stringify(input))>2048 || !/^[a-f0-9]{64}$/.test(input.signature ?? '') ||
  !secrets.some(s=>s && timingSafeEqual(Buffer.from(input.signature,'hex'),createHmac('sha256',s).update(bytes(input)).digest())))
  throw new restate.TerminalError('Invalid customer action signature',{errorCode:403});
 const refs:CustomerActionCommand={v:1,requestId:input.requestId,tenantId:input.tenantId,accountId:input.accountId,actionId:input.actionId,commandId:input.commandId,key:input.key};
 const event=await ctx.run('customer-action-evidence',()=>core.post<CustomerActionEvent>(`/internal/customer/actions/${input.actionId}/event`,refs));
 if(!isCustomerActionEvent(event) || Object.entries(refs).some(([key,value])=>event[key as keyof CustomerActionCommand]!==value))
  throw new restate.TerminalError('Customer action evidence has different scope',{errorCode:403});
 await ctx.send(input.requestId,event);return {forwarded:true,requestId:input.requestId,actionId:input.actionId};
}
export async function recordCustomerAction(ctx:AutomaticOpenContext & {now?():Promise<number>;scheduleQuestionReminder?(requestId:string,rev:number,questionId:string,day:1|5,delayMs:number):void},
 core:CoreInternal,event:CustomerActionEvent):Promise<CustomerActionResult> {
 if(!isCustomerActionEvent(event) || ctx.key!==event.requestId)throw new restate.TerminalError('Invalid customer action',{errorCode:403});
 const prior=await ctx.get('lc');
 if(prior && (prior.tenantId!==event.tenantId || prior.chatId!==`web:${event.accountId}`))
  throw new restate.TerminalError('Customer action belongs to another workspace',{errorCode:403});
 const basis={taskId:prior?.taskId ?? event.taskId,rev:prior?.rev ?? 0,stage:prior?.stage ?? '',
  round:prior && 'round' in prior ? prior.round ?? 0 : 0,
  ...(prior && 'question' in prior && prior.question ? {questionId:prior.question.id} : {})};
 const result=await ctx.run('customer-action-project:'+event.actionId,()=>core.post<CustomerActionResult>(`/internal/customer/actions/${event.actionId}/project`,{event,basis}));
 if(result?.v!==1 || result.actionId!==event.actionId || result.requestId!==event.requestId || result.kind!==event.kind || typeof result.accepted!=='boolean')
  throw new restate.TerminalError('Invalid customer action projection',{errorCode:409});
 if(!result.accepted)return result;
 if(!prior || !result.rev || !result.taskId)throw new restate.TerminalError('Customer action has no owner basis',{errorCode:409});
 if(prior.rev===event.expectedRev && prior.taskId===event.taskId) {
  if(event.kind==='cancel') {
   if(result.stage!=='cancelled' || result.rev!==prior.rev+1 || result.taskId!==prior.taskId || result.fromStage!==prior.stage)
    throw new restate.TerminalError('Invalid cancellation projection',{errorCode:409});
   ctx.set('lc',{...prior,stage:'cancelled',rev:result.rev,withdrawal:{eventId:`web:${event.actionId}`,sha256:event.bodyHash,
    actor:'requester',rev:result.rev,fromStage:prior.stage,officeAlerts:[]}});
   ctx.send({v:1,key:`${event.requestId}:${result.rev}:customer-cancel:${event.actionId}`,chatId:prior.chatId,kind:'text',text:'Your design request was cancelled.',
     class:'critical',tenantId:prior.tenantId,taskId:prior.taskId});
  } else if(event.kind==='seen') {
   if(!('question' in prior) || !prior.question || result.rev!==prior.rev || result.questionId!==prior.question.id ||
    !result.messageId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result.messageId) || !Number.isSafeInteger(result.seenAtMs) || !result.seenAtMs || result.seenAtMs<0 || result.stage!=='awaiting_answer')throw new restate.TerminalError('Invalid question acknowledgement',{errorCode:409});
   ctx.set('lc',{...prior,question:{...prior.question,sentAtMs:result.seenAtMs,webMessageId:result.messageId}});
   const now=ctx.now ? await ctx.now() : result.seenAtMs;
   if(!Number.isFinite(now) || now<=0)throw new restate.TerminalError('Invalid reminder clock',{errorCode:409});
   for(const day of [1,5] as const) {
    const due=nextOfficeMoment(Math.max(result.seenAtMs+day*86400000,now));
    ctx.scheduleQuestionReminder?.(event.requestId,prior.rev,result.questionId,day,Math.max(0,due-now));
   }
  } else {
   if(!('runId' in prior) || !result.runId || result.runId!==`dr-${result.taskId}` || result.taskId===prior.taskId ||
     result.rev!==prior.rev+1 || result.stage!=='designing' || result.round!==basis.round+1 || !result.directive)
    throw new restate.TerminalError('Invalid requester revision projection',{errorCode:409});
   const input={...prior.designInput,rawText:result.directive,taskId:result.taskId,lifecycle:{requestId:event.requestId,round:result.round,runId:result.runId},
    idempotencyKey:`lifecycle:${event.requestId}:${result.taskId}`};
   delete input.startNotice;delete input.redriveAttempt;
   const next:AutomaticLifecycleState={...prior,stage:'designing',rev:result.rev,taskId:result.taskId,runId:result.runId,round:result.round,designInput:input,
    revisionRound:{eventId:`web:${event.actionId}`,sha256:event.bodyHash,round:result.round,newTaskId:result.taskId,runId:result.runId},
    outcome:undefined,officeRevision:undefined,question:undefined,delivery:undefined};
   ctx.set('lc',next);ctx.startDesign(input);
  }
 } else if(prior.rev<result.rev)throw new restate.TerminalError('Customer owner state cannot reconcile the projection',{errorCode:409});
 await ctx.run('customer-action-applied:'+event.actionId,()=>core.post(`/internal/customer/actions/${event.actionId}/ack`,{event,result}));
 return result;
}
