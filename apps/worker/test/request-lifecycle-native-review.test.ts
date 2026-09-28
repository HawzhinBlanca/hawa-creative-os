import { randomUUID } from 'node:crypto';
import { describe,it,expect,vi } from 'vitest';
import { signLifecycleOfficeEvent } from '@hawa/integrations';
import { parseNativeReviewSubmission,type NativeReviewSubmission } from '@hawa/domain';
import { checkSignedNativeReview } from '../src/lifecycle/office-decision-gateway.js';
import { recordNativeReview,type AutomaticLifecycleState,type AutomaticOpenContext } from '../src/lifecycle/request-lifecycle.js';

function setup(){
  const requestId=randomUUID(),taskId=randomUUID(),actionId=randomUUID();
  const event:NativeReviewSubmission={v:1,kind:'native_review',eventId:`desk:${actionId}`,actionId,requestId,taskId,
    expectedRev:4,expectedTaskVersion:2,artifactId:randomUUID(),confirmationEventId:randomUUID(),actor:{userId:randomUUID(),role:'operator'}};
  let state:AutomaticLifecycleState={v:1,requestId,tenantId:randomUUID(),chatId:'73005000',owner:'restate',stage:'manual',rev:4,
    taskId,openEventId:'fixture',openSha256:'a'.repeat(64),runId:`dr-${taskId}`,
    designInput:{v:1,taskId,tenantId:randomUUID(),clientId:randomUUID(),rawText:'Fixture',sourcePlatform:'telegram',idempotencyKey:'fixture',canvaAutoGenerate:true,
      lifecycle:{requestId,round:1,runId:`dr-${taskId}`}}};
  const journal=new Map<string,unknown>();
  const ctx:AutomaticOpenContext={key:requestId,get:async()=>state,run:async<T>(name:string,action:()=>Promise<T>)=>{
    if(journal.has(name))return journal.get(name) as T;
    const value=await action();journal.set(name,value);return value;
  },set:(_name,value)=>{state=value as AutomaticLifecycleState;},send:()=>{throw new Error('No notices');},startDesign:()=>{throw new Error('No generation');}};
  const result={accepted:true as const,requestId,taskId,actionId,revisionId:randomUUID(),rev:5,stage:'in_review' as const,qaPassed:true};
  return {event,ctx,result,state:()=>state};
}

describe('request-owned native revision submission',()=>{
  it('requires the exact signed typed human event',()=>{
    const {event}=setup(),secret=randomUUID();
    const signed={v:1 as const,event,signature:signLifecycleOfficeEvent(secret,event)};
    expect(checkSignedNativeReview(signed,secret)).toBe('ok');
    expect(checkSignedNativeReview({...signed,event:{...event,artifactId:randomUUID()}},secret)).toBe('unauthorized');
    expect(checkSignedNativeReview(signed,'wrong')).toBe('unauthorized');
    for(const patch of [{actor:{...event.actor,role:'service'}},{expectedRev:1},{expectedTaskVersion:0},{extra:true},{artifactId:'bad'}])
      expect(parseNativeReviewSubmission({...event,...patch})).toBeUndefined();
  });
  it('recovers lost Core response and state-save failure without accepting altered action content',async()=>{
    const {event,ctx,result,state}=setup();
    const core={post:vi.fn().mockRejectedValueOnce(new Error('Core answer lost')).mockResolvedValue(result)};
    await expect(recordNativeReview(ctx,core,event)).rejects.toThrow('answer lost');expect(state().stage).toBe('manual');
    const original=ctx.set;let crash=true;
    ctx.set=(name,value)=>{original(name,value);if(crash){crash=false;throw new Error('Stopped after state save');}};
    await expect(recordNativeReview(ctx,core,event)).rejects.toThrow('after state save');
    expect(state().stage).toBe('in_review');
    expect(await recordNativeReview(ctx,core,event)).toEqual(result);expect(core.post).toHaveBeenCalledTimes(2);
    expect(state().outcome?.revisionId).toBe(result.revisionId);
    await expect(recordNativeReview(ctx,core,{...event,artifactId:randomUUID()})).rejects.toThrow('different content');
    expect(await recordNativeReview(ctx,core,{...event,actionId:randomUUID(),eventId:'wrong'}).catch(()=> 'invalid')).toBe('invalid');
  });
  it('refuses stale/other task work and does not adopt malformed Core proof',async()=>{
    const {event,ctx,result,state}=setup(),core={post:vi.fn().mockResolvedValue({...result,taskId:randomUUID()})};
    expect(await recordNativeReview(ctx,core,{...event,expectedRev:3})).toEqual({accepted:false,code:'WRONG_STAGE'});
    expect(await recordNativeReview(ctx,core,{...event,taskId:randomUUID()})).toEqual({accepted:false,code:'WRONG_STAGE'});
    expect(core.post).not.toHaveBeenCalled();
    await expect(recordNativeReview(ctx,core,event)).rejects.toThrow('valid native review projection');
    expect(state().stage).toBe('manual');
  });
});
