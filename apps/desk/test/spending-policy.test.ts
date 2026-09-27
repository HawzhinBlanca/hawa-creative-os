// @vitest-environment jsdom
import React,{act} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {SpendingPolicyDetail} from '@hawa/contracts';
import {SpendingPolicyPanel} from '../src/components/SpendingPolicyPanel.js';
import {byText,click,flush,json,mount,stubCore} from './support/desk-harness.js';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const detail:SpendingPolicyDetail={tenantId:id,userId:'named-admin',canEdit:true,
  current:{version:1,limits:{officeUsd:30,clientUsd:20,roleUsd:10,clients:{[id]:5},roles:{visual_judge:2}},limitsSha256:'a'.repeat(64),reason:'Initial policy',actionId:id,actorUserId:null,recordedBy:'database-owner',recordedAt:'2026-09-27T10:00:00Z'},
  history:[],nextBeforeVersion:null,clients:[{id,name:'Office client'}],daily:{day:'2026-09-27',timezone:'Asia/Baghdad',policyVersion:1,scopes:[{scope:'office',subject:'office',maxUsd:30,spentUsd:1,heldUsd:2,remainingUsd:27,historyIncomplete:false}]}};
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();sessionStorage.clear();document.body.innerHTML='';});
async function enter(container:HTMLElement,label:string,value:string){
  const field=container.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  await act(async()=>{Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));});
}
async function open(view:Awaited<ReturnType<typeof mount>>){await click(byText(view.container,'button','Review budget policy'));await flush();}
async function review(view:Awaited<ReturnType<typeof mount>>){await act(async()=>{view.container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();}
it('reviews exact changes and default inheritance before submitting, while retaining a lower-limit warning',async()=>{
  const calls=stubCore(()=>json(detail));const view=await mount(React.createElement(SpendingPolicyPanel));await open(view);
  await enter(view.container,'Office daily limit','0');await enter(view.container,'Default role daily limit','7');
  await enter(view.container,'visual_judge limit','');await enter(view.container,'Budget change reason','Pause while reviewing usage');
  await click(byText(view.container,'button','Use default for Office client'));await review(view);
  expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);expect(view.text()).toContain('$30.000000$0.000000');
  expect(view.text()).toContain('$2.000000Default $7.000000');expect(view.text()).toContain('$5.000000Default $20.000000');
  expect(view.text()).toContain('below current charges and reservations');
  await click(byText(view.container,'button','Apply reviewed limits'));await flush();
  expect(calls.find(c=>c.method==='POST')?.body.limits).toEqual({officeUsd:0,clientUsd:20,roleUsd:7,clients:{},roles:{}});
  await view.unmount();
});
it('retries the same action after lost response, remount and a newer current policy',async()=>{
  let attempts=0;
  const calls=stubCore(c=>c.method==='POST'?(++attempts===1?Promise.reject(new Error('lost after commit')):json({replayed:true})):
    json(attempts?{...detail,current:{...detail.current,version:2,limits:{...detail.current.limits,officeUsd:25}}}:detail));
  let view=await mount(React.createElement(SpendingPolicyPanel));await open(view);
  await enter(view.container,'Office daily limit','25');await enter(view.container,'Budget change reason','Reviewed office allowance');await review(view);
  await click(byText(view.container,'button','Apply reviewed limits'));await flush();
  const key=`hawa.spending-policy.${id}.named-admin`;expect(sessionStorage.getItem(key)).toBeTruthy();
  await view.unmount();view=await mount(React.createElement(SpendingPolicyPanel));await open(view);
  expect(view.text()).toContain('Current policy · revision 2');expect(view.text()).toContain('Based on policy revision 1');
  await click(byText(view.container,'button','Retry saved budget action'));await flush();
  const writes=calls.filter(c=>c.method==='POST');expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);
  const fetches=(fetch as ReturnType<typeof vi.fn>).mock.calls.filter(c=>c[1]?.method==='POST');expect(fetches[0][1].headers).toEqual(fetches[1][1].headers);
  expect(sessionStorage.getItem(key)).toBeNull();await view.unmount();
});
it('clears only a definite stale refusal and reloads the new policy before another proposal',async()=>{
  let refused=false;
  stubCore(c=>{if(c.method==='POST'){refused=true;return json({title:'SPENDING_POLICY_CHANGED',status:409,detail:'Reload current limits'},409);}
    return json(refused?{...detail,current:{...detail.current,version:2,limits:{...detail.current.limits,officeUsd:14}}}:detail);});
  const view=await mount(React.createElement(SpendingPolicyPanel));await open(view);
  await enter(view.container,'Office daily limit','25');await enter(view.container,'Budget change reason','Reviewed allowance');await review(view);
  await click(byText(view.container,'button','Apply reviewed limits'));await flush();expect(view.text()).toContain('Policy refused');
  expect(sessionStorage.getItem(`hawa.spending-policy.${id}.named-admin`)).toBeNull();
  await click(byText(view.container,'button','Reload budget policy'));await flush();
  expect((view.container.querySelector('[aria-label="Office daily limit"]') as HTMLInputElement).value).toBe('14');await view.unmount();
});
it('keeps unnamed sessions read-only and does not restore another administrator’s pending action',async()=>{
  sessionStorage.setItem(`hawa.spending-policy.${id}.someone-else`,JSON.stringify({actionId:id,before:detail.current.limits,
    body:{expectedVersion:1,expectedLimitsSha256:'a'.repeat(64),reason:'Unconfirmed',limits:detail.current.limits}}));
  stubCore(()=>json({...detail,canEdit:false,history:[detail.current]}));
  const view=await mount(React.createElement(SpendingPolicyPanel));await open(view);expect(view.container.querySelector('form')).toBeNull();
  expect(view.text()).toContain('Database setup · database-owner');expect(view.text()).not.toContain('Retry saved budget action');await view.unmount();
});
it('does not send a budget mutation if the action cannot be saved locally',async()=>{
  const calls=stubCore(()=>json(detail));const view=await mount(React.createElement(SpendingPolicyPanel));await open(view);
  await enter(view.container,'Office daily limit','20');await enter(view.container,'Budget change reason','Reviewed allowance');await review(view);
  vi.spyOn(Storage.prototype,'setItem').mockImplementationOnce(()=>{throw new Error('storage full');});
  await click(byText(view.container,'button','Apply reviewed limits'));await flush();
  expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);expect(view.text()).toContain('No new request was sent');await view.unmount();
});
