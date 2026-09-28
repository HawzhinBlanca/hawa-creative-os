// @vitest-environment jsdom
import React,{act} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CanvaTaskPanel} from '../src/components/CanvaTaskPanel.js';
import {byText,click,flush,json,mount,stubCore} from './support/desk-harness.js';
const taskId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',planId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();sessionStorage.clear();document.body.innerHTML='';});
it('shows a retained result and accounting hold; resume uses the saved operation without generating again',async()=>{
 const calls=stubCore(c=>{
  if(c.path.endsWith('/resume'))return json({status:'uncertain',message:'Terminal cost evidence required.'});
  if(c.path.endsWith('/plans'))return json({plans:[{id:planId,status:'uncertain',call_id:planId,retained_layout:true,cost_evidence_required:true}]});
  if(c.path.includes('/canva/status'))return json({authorized:true});
  return json({operations:[],artifacts:[]});
 });
 const view=await mount(React.createElement(CanvaTaskPanel,{taskId,taskStatus:'PLANNING'}));await flush();
 expect(view.text()).toContain('A validated layout is saved');expect(view.text()).toContain('terminal cost evidence');
 await click(byText(view.container,'button','Resume saved design'));await flush();
 expect(calls.filter(c=>c.method==='POST').map(c=>c.path)).toEqual([`/v1/tasks/${taskId}/canva/plans/${planId}/resume`]);
 expect(view.text()).toContain('Terminal cost evidence required.');await view.unmount();
});
it('requires a reason to retire a plan and retains the warning about unresolved paid calls',async()=>{
 const calls=stubCore(c=>{
  if(c.method==='POST')return json({status:'abandoned',message:'Original evidence retained.'});
  if(c.path.endsWith('/plans'))return json({plans:[{id:planId,status:'planning'}]});
  if(c.path.includes('/canva/status'))return json({authorized:true});
  return json({operations:[],artifacts:[]});
 });
 const view=await mount(React.createElement(CanvaTaskPanel,{taskId,taskStatus:'PLANNING'}));await flush();
 expect((byText(view.container,'button','Retire plan') as HTMLButtonElement).disabled).toBe(true);
 const field=view.container.querySelector('textarea')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,'Provider confirmed terminal execution.');field.dispatchEvent(new Event('input',{bubbles:true}));});
 await click(byText(view.container,'button','Retire plan'));await flush();
 expect(calls.filter(c=>c.method==='POST').map(c=>c.path)).toEqual([`/v1/tasks/${taskId}/canva/plans/${planId}/abandon`]);
 expect(view.text()).toContain('Unresolved paid calls still require reconciliation');await view.unmount();
});
