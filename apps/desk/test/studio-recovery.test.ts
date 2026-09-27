// @vitest-environment jsdom
import React,{act} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {StudioRecoveryPanel} from '../src/components/StudioRecoveryPanel.js';
import {flush,json,mount,stubCore} from './support/desk-harness.js';
const taskId='11111111-1111-4111-8111-111111111111',runId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',callId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const detail={taskId,runId,status:'abandoned',snapshotHash:'a'.repeat(64),canSettle:true,requiresStop:false,unresolvedCalls:1,settlements:[],
  calls:[{id:callId,ordinal:1,stage:'briefing',provider:'openai',model:'synthetic',status:'uncertain',estimatedCostUsd:null,settlement:null}]};
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();sessionStorage.clear();document.body.innerHTML='';});
it('retains the Studio action and frozen evidence across lost response and remount',async()=>{
  const key=`hawa.studio-settlement.${runId}`;
  const action={actionId:taskId,body:{expectedSnapshot:detail.snapshotHash,reason:'Terminal provider evidence',calls:[{
    callId,conclusion:'provider_finished',reportedCostUsd:0.125,evidenceReference:'support-123',evidenceSha256:'b'.repeat(64)}]}};
  sessionStorage.setItem(key,JSON.stringify(action));let attempts=0;
  const calls=stubCore(c=>c.path.endsWith('/settlement')?(++attempts===1?Promise.reject(new Error('lost after commit')):json({replayed:true})):json(detail));
  let view=await mount(React.createElement(StudioRecoveryPanel,{taskId,runId,status:'abandoned'}));await flush();
  expect(view.text()).toContain('original cost unknown');expect(view.text()).toContain('Retry saved settlement');
  await act(async()=>{view.container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(action);
  await view.unmount();view=await mount(React.createElement(StudioRecoveryPanel,{taskId,runId,status:'abandoned'}));await flush();
  await act(async()=>{view.container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();
  const writes=calls.filter(c=>c.method==='POST');expect(writes).toHaveLength(2);expect(writes[0]).toEqual(writes[1]);
  expect(writes[0].path).toBe(`/v1/tasks/${taskId}/studio-recovery/${runId}/settlement`);
  expect(sessionStorage.getItem(key)).toBeNull();expect(sessionStorage.getItem(`hawa.evaluation-settlement.${runId}`)).toBeNull();
  await view.unmount();
});
it('requires a stopped run before presenting an administrator evidence form',async()=>{
  stubCore(()=>json({...detail,status:'briefing',requiresStop:true,canSettle:false}));
  const view=await mount(React.createElement(StudioRecoveryPanel,{taskId,runId,status:'briefing'}));await flush();
  expect(view.container.querySelector('form')).toBeNull();expect(view.text()).toContain('owning workflow');await view.unmount();
});
it('shows original uncertainty separately from an attested final cost and never labels it a pass',async()=>{
  const receipt={id:taskId,actionId:taskId,actorUserId:taskId,reason:'Provider evidence',recordedAt:'2026-09-27T00:00:00Z',calls:[{
    callId,conclusion:'provider_finished',reportedCostUsd:0.125,evidenceReference:'support-123',evidenceSha256:'b'.repeat(64)}]};
  stubCore(()=>json({...detail,unresolvedCalls:0,canSettle:false,settlements:[receipt],calls:[{...detail.calls[0],settlement:receipt.calls[0]}]}));
  const view=await mount(React.createElement(StudioRecoveryPanel,{taskId,runId,status:'abandoned'}));await flush();
  expect(view.text()).toContain('original outcome: uncertain');expect(view.text()).toContain('original cost unknown');
  expect(view.text()).toContain('separately attested final cost $0.125');expect(view.text()).toContain('does not establish design quality or approval');
  expect(view.container.querySelector('form')).toBeNull();await view.unmount();
});
it('clears a pending action only after durable history confirms it',async()=>{
  const actionId=taskId,key=`hawa.studio-settlement.${runId}`;
  sessionStorage.setItem(key,JSON.stringify({actionId,body:{reason:'Saved',calls:[]}}));
  stubCore(()=>json({...detail,unresolvedCalls:0,canSettle:false,settlements:[{id:taskId,actionId,actorUserId:taskId,
    reason:'Saved',recordedAt:'2026-09-27T00:00:00Z',calls:[]}],calls:[]}));
  const view=await mount(React.createElement(StudioRecoveryPanel,{taskId,runId,status:'abandoned'}));await flush();
  expect(sessionStorage.getItem(key)).toBeNull();await view.unmount();
});
