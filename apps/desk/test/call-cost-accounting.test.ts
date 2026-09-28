// @vitest-environment jsdom
import React,{act} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {CallCostDetail} from '@hawa/contracts';
import {CallCostAccountingPanel} from '../src/components/CallCostAccountingPanel.js';
import {byText,click,flush,json,mount,stubCore} from './support/desk-harness.js';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const detail:CallCostDetail={id,kind:'voice',clientId:null,taskId:null,runId:null,provider:'openai',model:'whisper-1',status:'received',
  startedAt:'2026-09-27T10:00:00Z',providerRequestId:null,costBasis:'unavailable',originalCostUsd:null,reservedUsd:.006,
  settledCostUsd:null,attestedCostUsd:null,accountedCostUsd:0,originalAccepted:true,requiresCostEvidence:true,
  evidenceConflict:false,revision:0,attestations:[],snapshotHash:'b'.repeat(64),canRecord:true};
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();sessionStorage.clear();document.body.innerHTML='';});
async function enter(container:HTMLElement,label:string,value:string){
  const field=container.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  await act(async()=>{Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));});
}
async function open(view:Awaited<ReturnType<typeof mount>>){
  await click(byText(view.container,'button','Review call costs'));await flush();
  await click(byText(view.container,'button','Review aaaaaaaa'));await flush();
}
it('shows unknown original billing, original outcome and separate accounting history',async()=>{
  const recorded={...detail,revision:1,requiresCostEvidence:false,attestedCostUsd:0,settledCostUsd:.2,accountedCostUsd:.2,evidenceConflict:true,
    attestations:[{id,revision:1,actorUserId:'named-admin',recordedAt:detail.startedAt,reason:'No charge confirmed',conclusion:'provider_finished',reportedCostUsd:0,evidenceReference:'support-123',evidenceSha256:'c'.repeat(64)}]};
  stubCore(c=>json(c.path==='/v1/spending/calls'?{items:[recorded],nextCursor:null}:recorded));
  const view=await mount(React.createElement(CallCostAccountingPanel));await open(view);
  expect(view.text()).toContain('Unknown');expect(view.text()).toContain('Original outcome: received');
  expect(view.text()).toContain('$0.000000');expect(view.text()).toContain('Attested by named-admin');
  expect(view.text()).toContain('Prior run settlement$0.200000');expect(view.text()).toContain('Retained evidence disagrees');
  expect(view.text()).toContain('Record final call cost');expect(view.text()).not.toContain('Close held evaluation');
  await view.unmount();
});
it('retries identical cost evidence after a lost response and remount',async()=>{
  let attempts=0;
  const calls=stubCore(c=>c.method==='POST'?(++attempts===1?Promise.reject(new Error('lost after commit')):json({replayed:true})):
    json(c.path==='/v1/spending/calls'?{items:[detail],nextCursor:null}:detail));
  let view=await mount(React.createElement(CallCostAccountingPanel));await open(view);
  await enter(view.container,'Call 1 final cost','.003');await enter(view.container,'Call 1 evidence reference','support-123');
  await enter(view.container,'Call 1 evidence hash','c'.repeat(64));await enter(view.container,'Settlement reason','Provider confirmed billing');
  await act(async()=>{view.container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();
  const key=`hawa.accounting-settlement.voice:${id}`,saved=sessionStorage.getItem(key);expect(saved).toBeTruthy();
  await view.unmount();view=await mount(React.createElement(CallCostAccountingPanel));await open(view);
  expect(view.text()).toContain('Retry saved settlement');expect(view.container.querySelector('fieldset')!.disabled).toBe(true);
  await act(async()=>{view.container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();
  const writes=calls.filter(c=>c.method==='POST');expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);
  expect(sessionStorage.getItem(key)).toBeNull();expect(view.text()).toContain('Original recorded cost');expect(writes[0].path).toBe(`/v1/spending/calls/voice/${id}/evidence`);
  const fetches=(fetch as ReturnType<typeof vi.fn>).mock.calls.filter(c=>c[1]?.method==='POST');
  expect(fetches[0][1].headers).toEqual(fetches[1][1].headers);await view.unmount();
});
it('shows read-only evidence to unnamed sessions and allows reload and close',async()=>{
  stubCore(c=>json(c.path==='/v1/spending/calls'?{items:[detail],nextCursor:null}:{...detail,canRecord:false}));
  const view=await mount(React.createElement(CallCostAccountingPanel));await open(view);
  expect(view.container.querySelector('form')).toBeNull();expect(view.text()).toContain('named office administrator');
  await click(byText(view.container,'button','Reload selected call'));await flush();
  expect(view.text()).toContain('Original outcome: received');
  await click(byText(view.container,'button','Close call'));expect(view.container.querySelector('[aria-label="Selected call accounting"]')).toBeNull();
  await view.unmount();
});

it('explains the scheduled-probe recovery boundary and posts evidence to its own call',async()=>{
  const probe={...detail,kind:'health_probe' as const,model:'gpt-4.1-mini',status:'unreachable',originalAccepted:false};
  const calls=stubCore(c=>json(c.method==='POST'?{replayed:false}:c.path==='/v1/spending/calls'?{items:[probe],nextCursor:null}:probe));
  const view=await mount(React.createElement(CallCostAccountingPanel));await open(view);
  expect(view.text()).toContain('Terminal evidence permits a new scheduled health probe');
  expect(view.text()).toContain('It does not retry this call or establish provider health');
  await enter(view.container,'Call 1 final cost','0');await enter(view.container,'Call 1 evidence reference','synthetic-probe');
  await enter(view.container,'Call 1 evidence hash','c'.repeat(64));await enter(view.container,'Settlement reason','Provider confirmed terminal probe');
  await act(async()=>{view.container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();
  expect(calls.filter(c=>c.method==='POST').map(c=>c.path)).toEqual([`/v1/spending/calls/health_probe/${id}/evidence`]);
  await view.unmount();
});
it('clears stale list and selected accounting evidence when refreshing fails',async()=>{
 let fail=false;stubCore(c=>fail?json({detail:'Database unavailable'},503):json(c.path.endsWith('/calls')?{items:[detail],nextCursor:null}:detail));
 const view=await mount(React.createElement(CallCostAccountingPanel));await open(view);
 expect(view.text()).toContain('Original recorded cost');fail=true;
 await click(byText(view.container,'button','Reload costs'));await flush();
 expect(view.text()).toContain('Call costs unavailable');expect(view.text()).not.toContain('Original recorded cost');
 expect(view.container.querySelector('table')).toBeNull();await view.unmount();
});
