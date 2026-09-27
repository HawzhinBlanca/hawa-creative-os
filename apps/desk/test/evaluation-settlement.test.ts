// @vitest-environment jsdom
import React,{act} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EvaluationSettlementPanel} from '../src/components/EvaluationSettlementPanel.js';
import {flush,json,mount,stubCore} from './support/desk-harness.js';

const runId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',callId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const detail={runId,status:'failed',snapshotHash:'a'.repeat(64),canSettle:true,settlement:null,calls:[{id:callId,ordinal:1,status:'uncertain'}]};
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();sessionStorage.clear();document.body.innerHTML='';});
async function enter(container:HTMLElement,label:string,value:string){
  const field=container.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  await act(async()=>{Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));});
}
it('retains the complete action through lost response and remount without permitting changed evidence',async()=>{
  let attempts=0;
  stubCore(c=>c.path.endsWith('/settlement')? (++attempts===1?Promise.reject(new Error('lost after commit')):json({replayed:true})):undefined);
  const refreshed=vi.fn(async()=>{});
  let view=await mount(React.createElement(EvaluationSettlementPanel,{detail,onSettled:refreshed}));
  expect(view.container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  await enter(view.container,'Call 1 final cost','0.125');await enter(view.container,'Call 1 evidence reference','support-123');
  await enter(view.container,'Call 1 evidence hash','b'.repeat(64));await enter(view.container,'Settlement reason','Provider confirmed completion and final charge');
  expect(view.container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
  await act(async()=>{view.container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();
  expect(view.text()).toContain('Settlement was not confirmed');
  const saved=sessionStorage.getItem(`hawa.evaluation-settlement.${runId}`);expect(saved).toBeTruthy();
  await view.unmount();view=await mount(React.createElement(EvaluationSettlementPanel,{detail,onSettled:refreshed}));
  expect(view.text()).toContain('Retry saved settlement');expect(view.container.querySelector('fieldset')!.disabled).toBe(true);
  await act(async()=>{view.container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();
  const calls=(fetch as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls).toHaveLength(2);expect(calls[0][1]).toEqual(calls[1][1]);expect(refreshed).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(`hawa.evaluation-settlement.${runId}`)).toBeNull();await view.unmount();
});
it('does not offer settlement to shared or non-administrator sessions',async()=>{
  const view=await mount(React.createElement(EvaluationSettlementPanel,{detail:{...detail,canSettle:false},onSettled:async()=>{}}));
  expect(view.container.querySelector('form')).toBeNull();expect(view.text()).toContain('named office administrator');await view.unmount();
});
it('storage failure prevents dispatch and preserves evidence for correction',async()=>{
  const transport=vi.fn();vi.stubGlobal('fetch',transport);
  const key=`hawa.evaluation-settlement.${runId}`;
  sessionStorage.setItem(key,JSON.stringify({actionId:runId,body:{expectedSnapshot:detail.snapshotHash,reason:'Confirmed',calls:[]}}));
  const view=await mount(React.createElement(EvaluationSettlementPanel,{detail,onSettled:async()=>{}}));
  const storage=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Storage disabled');});
  await act(async()=>{view.container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();
  expect(transport).not.toHaveBeenCalled();storage.mockRestore();await view.unmount();
});
