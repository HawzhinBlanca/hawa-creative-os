import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { CustomerActionEvent, CustomerActionResult, OutboundMessage } from '@hawa/contracts';
import { signCustomerActionCommand, forwardCustomerAction, recordCustomerAction } from '../src/lifecycle/customer-web-actions.js';
import type { AutomaticLifecycleState, AutomaticOpenContext, LifecycleState } from '../src/lifecycle/request-lifecycle.js';
import type { DesignRunInput } from '../src/lifecycle/design-run.js';
import { coreInternalFixture } from './core-internal-fixture.js';
import { TaskWorkflowDispatcher } from '../src/workflow-dispatcher.js';
import type { OutboxCommandRecord } from '../src/outbox-consumer.js';
const tenantId='00000000-0000-4000-a000-000000000001',secret=['synthetic','action','signing','secret'].join('-');
function fixture(kind:CustomerActionEvent['kind']='revise') {
 const requestId=randomUUID(),taskId=randomUUID(),accountId=randomUUID();
 const event:CustomerActionEvent={v:1,requestId,taskId,accountId,tenantId,actionId:randomUUID(),commandId:randomUUID(),
 key:`customer:${accountId}:action:action_001`,expectedRev:2,kind,bodyHash:'1'.repeat(64)};
 const old:AutomaticLifecycleState={v:1,owner:'restate',openEventId:'open:'+requestId,openSha256:'3'.repeat(64),requestId,taskId,tenantId,chatId:`web:${accountId}`,stage:'in_review',rev:2,runId:`dr-${taskId}`,round:0,
  designInput:{v:1,tenantId,taskId,clientId:randomUUID(),rawText:'Exact retained text',sourcePlatform:'hawzhin_web',canvaAutoGenerate:true,
    lifecycle:{requestId,round:0,runId:`dr-${taskId}`},idempotencyKey:'original',startNotice:{key:'old',text:'old',chatId:`web:${accountId}`}},
  outcome:{eventId:'old-result',sha256:'2'.repeat(64),status:'CANVA_CHECK_REQUIRED'}};
 let state:LifecycleState|null=old;
 const sent:OutboundMessage[]=[],started:DesignRunInput[]=[];
 const reminders=vi.fn();
 const ctx:AutomaticOpenContext={key:requestId,get:async()=>state,set:(_n,v)=>{state=v;},run:async(_n,fn)=>fn(),send:m=>{sent.push(m);},
  startDesign:i=>{started.push(i);},scheduleQuestionReminder:reminders};
 return {event,old,ctx,sent,started,reminders,get:()=>state,set:(v:LifecycleState|null)=>{state=v;}};
}
function revision(f:ReturnType<typeof fixture>):CustomerActionResult {
 const taskId=randomUUID();return {v:1,actionId:f.event.actionId,requestId:f.event.requestId,kind:f.event.kind,
 accepted:true,taskId,runId:`dr-${taskId}`,stage:'designing',rev:3,round:1,directive:'Calmer composition'};
}
it('dispatches signed action references with a real required invocation receipt and stable retry key',async()=>{
 const f=fixture(),e=f.event,cmd:OutboxCommandRecord={id:e.commandId,tenant_id:tenantId,aggregate_id:e.requestId,aggregate_type:'request',command_type:'customer.request.action',
 idempotency_key:e.key,payload:{v:1,requestId:e.requestId,accountId:e.accountId,actionId:e.actionId},state:'leased',attempts:1};
 const fetcher=vi.fn<typeof fetch>(async()=>Response.json({invocationId:'inv_action001'},{status:202}));
 for(let i=0;i<2;i++)expect((await new TaskWorkflowDispatcher({restateIngressUrl:'http://restate.test',customerSigningSecret:secret,fetcher}).dispatchCustomer(cmd)).receiptId).toBe('inv_action001');
 const refs={v:1 as const,requestId:e.requestId,tenantId,accountId:e.accountId,commandId:e.commandId,actionId:e.actionId,key:e.key};
 for(const [url,opt] of fetcher.mock.calls) {
  expect(url).toBe(`http://restate.test/ChatInbox/web:${e.accountId}/webAction/send`);
  expect(new Headers(opt?.headers).get('Idempotency-Key')).toBe(e.key);
  expect(JSON.parse(String(opt?.body))).toEqual(signCustomerActionCommand(refs,secret));
 }
 fetcher.mockResolvedValue(Response.json({}, {status:202}));
 await expect(new TaskWorkflowDispatcher({restateIngressUrl:'http://restate.test',customerSigningSecret:secret,fetcher}).dispatchCustomer(cmd)).rejects.toThrow('RECEIPT_MISSING');
});
it('authenticates references before Core and refuses changed stored event scope',async()=>{
 const f=fixture(),e=f.event,refs={v:1 as const,requestId:e.requestId,tenantId,accountId:e.accountId,commandId:e.commandId,actionId:e.actionId,key:e.key};
 const signed=signCustomerActionCommand(refs,secret),core=coreInternalFixture(e),send=vi.fn(),ctx={key:`web:${e.accountId}`,run:async<T>(_n:string,fn:()=>Promise<T>)=>fn(),send};
 await expect(forwardCustomerAction(ctx,core,signed,[secret])).resolves.toMatchObject({forwarded:true});
 expect(send).toHaveBeenCalledWith(e.requestId,e);expect(core.postSpy).toHaveBeenCalledWith(`/internal/customer/actions/${e.actionId}/event`,refs);
 core.postSpy.mockClear();send.mockClear();
 for(const bad of [{...signed,signature:'0'.repeat(64)},{...signed,actionId:randomUUID()},{...signed,key:'foreign'}])
  await expect(forwardCustomerAction(ctx,core,bad,[secret])).rejects.toThrow('signature');
 await expect(forwardCustomerAction({...ctx,key:`web:${randomUUID()}`},core,signed,[secret])).rejects.toThrow('signature');
 expect(core.postSpy).not.toHaveBeenCalled();
 await expect(forwardCustomerAction(ctx,coreInternalFixture({...e,taskId:'invalid'}),signed,[secret])).rejects.toThrow('different scope');
 expect(send).not.toHaveBeenCalled();
});
it('adopts one new round, clears stale state and never starts it again on receipt replay',async()=>{
 const f=fixture(),result=revision(f),core=coreInternalFixture(result);
 expect(await recordCustomerAction(f.ctx,core,f.event)).toEqual(result);
 expect(f.get()).toMatchObject({stage:'designing',taskId:result.taskId,runId:result.runId,rev:3,round:1,question:undefined,outcome:undefined});
 expect(f.started).toHaveLength(1);expect(f.started[0]).toMatchObject({sourcePlatform:'hawzhin_web',clientId:f.old.designInput.clientId,rawText:result.directive,
 idempotencyKey:`lifecycle:${f.event.requestId}:${result.taskId}`});expect(f.started[0].startNotice).toBeUndefined();
 await recordCustomerAction(f.ctx,core,f.event);expect(f.started).toHaveLength(1);
 const next={...(f.get() as AutomaticLifecycleState),stage:'in_review' as const,rev:4};f.set(next);
 await recordCustomerAction(f.ctx,core,f.event);expect(f.get()).toEqual(next);expect(f.started).toHaveLength(1);
});
it('reconciles an applied owner state after an acknowledgement reply is lost',async()=>{
 const f=fixture(),result=revision(f),core=coreInternalFixture(result);let fail=true;
 core.remote.mockImplementation(async url=>{
  if(String(url).endsWith('/ack') && fail){fail=false;return Response.json({}, {status:503});}
  return Response.json(result);
 });
 await expect(recordCustomerAction(f.ctx,core,f.event)).rejects.toThrow();
 expect(f.started).toHaveLength(1);expect(f.get()).toMatchObject({rev:3});
 await recordCustomerAction(f.ctx,core,f.event);expect(f.started).toHaveLength(1);
});
it('records cancellation through the same withdrawal state and emits a stable web notice',async()=>{
 const f=fixture('cancel'),result:CustomerActionResult={v:1,actionId:f.event.actionId,requestId:f.event.requestId,kind:'cancel',accepted:true,
 taskId:f.old.taskId,stage:'cancelled',rev:3,fromStage:'in_review'},core=coreInternalFixture(result);
 await recordCustomerAction(f.ctx,core,f.event);await recordCustomerAction(f.ctx,core,f.event);
 expect(f.get()).toMatchObject({stage:'cancelled',rev:3,withdrawal:{actor:'requester',fromStage:'in_review',sha256:f.event.bodyHash}});
 expect(f.sent).toHaveLength(1);expect(f.sent[0]).toMatchObject({chatId:f.old.chatId,key:`${f.event.requestId}:3:customer-cancel:${f.event.actionId}`});expect(f.started).toHaveLength(0);
});
it('uses an actual web message UUID for explicit reading and schedules the current question reminders',async()=>{
 const f=fixture('seen'),questionId=randomUUID(),messageId=randomUUID(),seenAtMs=Date.now();
 f.set({...f.old,stage:'awaiting_answer',question:{id:questionId,text:'Which date?',options:['Today','Tomorrow'],taskId:f.old.taskId,rev:2}});
 const result:CustomerActionResult={v:1,actionId:f.event.actionId,requestId:f.event.requestId,kind:'seen',accepted:true,
 taskId:f.old.taskId,stage:'awaiting_answer',rev:2,questionId,messageId,seenAtMs};
 await recordCustomerAction(f.ctx,coreInternalFixture(result),f.event);
 expect(f.get()).toMatchObject({question:{webMessageId:messageId,sentAtMs:seenAtMs}});expect((f.get() as AutomaticLifecycleState).question?.messageId).toBeUndefined();
 expect(f.reminders.mock.calls.map(c=>c[3])).toEqual([1,5]);expect(f.started).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
it('keeps owner state intact for refusal and rejects malformed or foreign projections before adoption',async()=>{
 const f=fixture(),no:CustomerActionResult={v:1,actionId:f.event.actionId,requestId:f.event.requestId,kind:f.event.kind,accepted:false,code:'DESIGN_ACTION_STALE'};
 const core=coreInternalFixture(no);await recordCustomerAction(f.ctx,core,f.event);
 expect(core.postSpy).toHaveBeenCalledTimes(1);expect(f.get()).toEqual(f.old);expect(f.started).toHaveLength(0);
 for(const bad of [{...revision(f),taskId:f.old.taskId},{...revision(f),actionId:randomUUID()},{...revision(f),round:4},{...revision(f),rev:2}])
  await expect(recordCustomerAction(f.ctx,coreInternalFixture(bad),f.event)).rejects.toThrow();
 expect(f.get()).toEqual(f.old);expect(f.started).toHaveLength(0);
 await expect(recordCustomerAction({...f.ctx,key:randomUUID()},core,f.event)).rejects.toThrow('Invalid customer action');
 f.set({...f.old,chatId:`web:${randomUUID()}`});await expect(recordCustomerAction(f.ctx,core,f.event)).rejects.toThrow('workspace');
});
it('does not report gateway completion until its asynchronous private send is awaited',async()=>{
 const f=fixture(),e=f.event,refs={v:1 as const,requestId:e.requestId,tenantId,accountId:e.accountId,commandId:e.commandId,actionId:e.actionId,key:e.key};
 let release!:()=>void,finished=false;
 const send=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;})),ctx={key:`web:${e.accountId}`,run:async<T>(_n:string,fn:()=>Promise<T>)=>fn(),send};
 const completion=forwardCustomerAction(ctx,coreInternalFixture(e),signCustomerActionCommand(refs,secret),[secret]).then(result=>{finished=true;return result;});
 await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(1));expect(finished).toBe(false);release();await completion;expect(finished).toBe(true);
 await expect(forwardCustomerAction({...ctx,send:async()=>{throw new Error('private send failed');}},coreInternalFixture(e),signCustomerActionCommand(refs,secret),[secret])).rejects.toThrow('private send failed');
});
