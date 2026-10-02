import { openCustomerWebRequest, signCustomerOpenCommand } from '../src/lifecycle/customer-web-entry.js';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { OutboundMessage } from '@hawa/contracts';
import { TaskWorkflowDispatcher } from '../src/workflow-dispatcher.js';
import type { OutboxCommandRecord } from '../src/outbox-consumer.js';
import { sendWebMessage } from '../src/lifecycle/telegram-sender.js';
import { openAutomaticRequest, type AutomaticOpenContext, type LifecycleState, type OpenAutomaticEvent } from '../src/lifecycle/request-lifecycle.js';
import type { DesignRunInput } from '../src/lifecycle/design-run.js';
import { coreInternalFixture } from './core-internal-fixture.js';

const tenantId='00000000-0000-4000-a000-000000000001';
function command():OutboxCommandRecord {
  const requestId=randomUUID(),accountId=randomUUID();
  return {id:randomUUID(),tenant_id:tenantId,aggregate_id:requestId,aggregate_type:'request',command_type:'customer.request.open',
    idempotency_key:`customer:${accountId}:request_001`,payload:{v:1,requestId,accountId},state:'leased',attempts:1};
}
const secret=['isolated','web','entry','test','secret'].join('-');
const refs=(cmd:OutboxCommandRecord)=>({v:1 as const,requestId:cmd.aggregate_id,tenantId:cmd.tenant_id,
  accountId:cmd.payload.accountId as string,commandId:cmd.id,key:cmd.idempotency_key});
it('dispatches signed references through the public inbox with a stable action key after restart',async()=>{
  const cmd=command(),fetcher=vi.fn<typeof fetch>(async()=>Response.json({invocationId:'inv_web_001'},{status:202}));
  for(let i=0;i<2;i++) {
    const dispatcher=new TaskWorkflowDispatcher({restateIngressUrl:'http://restate.test',customerSigningSecret:secret,fetcher});
    expect(await dispatcher.dispatchCustomer(cmd)).toMatchObject({receiptId:'inv_web_001',aggregateId:cmd.aggregate_id,status:'submitted'});
  }
  for(const [url,options] of fetcher.mock.calls) {
    expect(url).toBe(`http://restate.test/ChatInbox/web:${cmd.payload.accountId}/webOpen/send`);
    expect(new Headers(options?.headers).get('Idempotency-Key')).toBe(cmd.idempotency_key);
    expect(JSON.parse(String(options?.body))).toEqual(signCustomerOpenCommand(refs(cmd),secret));
    expect(String(options?.body)).not.toContain('rawText');
  }
});
it('requires a genuine invocation receipt and refuses invalid scope before ingress',async()=>{
  const cmd=command();
  await expect(new TaskWorkflowDispatcher().dispatchCustomer(cmd)).rejects.toThrow('INGRESS_NOT_CONFIGURED');
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json({}, {status:202}));
  const options={customerSigningSecret:secret,restateIngressUrl:'http://restate.test',fetcher};
  await expect(new TaskWorkflowDispatcher(options).dispatchCustomer(cmd)).rejects.toThrow('RECEIPT_MISSING');
  fetcher.mockClear();
  await expect(new TaskWorkflowDispatcher(options).dispatchCustomer({...cmd,tenant_id:randomUUID()})).rejects.toThrow('INVALID_CUSTOMER_OPEN_COMMAND');
  expect(fetcher).not.toHaveBeenCalled();
});
it('authenticates the gateway, reads stored Core evidence, and hands off only the matching event',async()=>{
  const cmd=command(),signed=signCustomerOpenCommand(refs(cmd),secret),chatId=`web:${cmd.payload.accountId}`;
  const event={v:1 as const,requestId:cmd.aggregate_id,tenantId,eventId:`open:${cmd.aggregate_id}`,chatId,
    draft:{platform:'hawzhin_web' as const,sourceChannelId:chatId,rawText:'retained copy'}};
  const core=coreInternalFixture(event),sendOpen=vi.fn(async()=>{});
  const ctx={key:chatId,run:async<T>(_name:string,action:()=>Promise<T>)=>action(),sendOpen};
  await expect(openCustomerWebRequest(ctx,core,signed,[secret])).resolves.toEqual({requestId:cmd.aggregate_id,forwarded:true});
  expect(core.postSpy.mock.calls).toEqual([[`/internal/customer/${cmd.aggregate_id}/open-event`,refs(cmd)]]);
  expect(sendOpen.mock.calls).toEqual([[cmd.aggregate_id,event]]);
  core.postSpy.mockClear();sendOpen.mockClear();
  for(const bad of [{...signed,requestId:randomUUID()},{...signed,signature:'0'.repeat(64)},{...signed,key:'foreign'},null])
    await expect(openCustomerWebRequest(ctx,core,bad,[secret])).rejects.toThrow('Invalid signed customer command');
  await expect(openCustomerWebRequest({...ctx,key:`web:${randomUUID()}`},core,signed,[secret])).rejects.toThrow('Invalid signed customer command');
  expect(core.postSpy).not.toHaveBeenCalled();expect(sendOpen).not.toHaveBeenCalled();
  const wrong=coreInternalFixture({...event,chatId:`web:${randomUUID()}`});
  await expect(openCustomerWebRequest(ctx,wrong,signed,[secret])).rejects.toThrow('different scope');
  expect(sendOpen).not.toHaveBeenCalled();
});
it('records a web notification through Core and never returns a Telegram send or a question-seen receipt',async()=>{
  const id=randomUUID(),message:OutboundMessage={v:1,key:`${id}:2:question`,chatId:`web:${randomUUID()}`,
    tenantId,kind:'text',class:'critical',text:'Which date?',onSent:{kind:'question',requestId:id,requestRev:2,taskId:randomUUID(),questionId:randomUUID()}};
  const receiptId=randomUUID(),core=coreInternalFixture({outcome:'web_recorded',receiptId});
  expect(await sendWebMessage(core,message)).toEqual({outcome:'web_recorded',receiptId});
  expect(core.postSpy.mock.calls).toEqual([['/internal/customer/web-message',message]]);
  await expect(sendWebMessage(core,{...message,chatId:'12345'})).rejects.toThrow('INVALID_WEB_CHANNEL');
});
it('opens a web request through the same lifecycle and preserves its web source in the paid design input',async()=>{
  const requestId=randomUUID(),taskId=randomUUID(),clientId=randomUUID(),chatId=`web:${randomUUID()}`;
  const event:OpenAutomaticEvent={v:1,eventId:`open:${requestId}`,requestId,tenantId,chatId,
    draft:{platform:'hawzhin_web',sourceEventId:`lc-${requestId}-r0`,sourceChannelId:chatId,
      rawText:'Exact website copy',title:'Website design',designInstructions:'Content-aware composition',
      exactCopy:[{text:'Exact website copy',language:'en'}],clientId,autoGenerate:true,designStudio:true}};
  let state:LifecycleState|null=null;
  const sent:OutboundMessage[]=[],started:DesignRunInput[]=[];
  const ctx:AutomaticOpenContext={key:requestId,get:async()=>state,set:(_name,value)=>{state=value;},
    run:async(_name,action)=>action(),send:m=>{sent.push(m);},startDesign:i=>{started.push(i);}};
  const core=coreInternalFixture({v:1,taskId,stage:'designing',rev:1,autoGenerate:true,
    design:{clientId,rawText:event.draft.rawText,sourcePlatform:'hawzhin_web',designStudio:true}});
  expect(await openAutomaticRequest(ctx,core,event)).toMatchObject({taskId,stage:'designing',rev:1});
  expect(started).toHaveLength(1);expect(started[0].sourcePlatform).toBe('hawzhin_web');
  expect(sent[0]).toMatchObject({chatId,key:`${requestId}:1:ack`});
  await openAutomaticRequest(ctx,core,event);
  expect(started[1].lifecycle.runId).toBe(started[0].lifecycle.runId);
});
