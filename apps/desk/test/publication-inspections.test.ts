// @vitest-environment jsdom
import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {PublicationInspectionState} from '@hawa/contracts';
import {PublicationInspectionPanel} from '../src/components/PublicationInspectionPanel.js';
import {byText,click,flush,json,mount,stubCore} from './support/desk-harness.js';
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();document.body.innerHTML='';});
const id=(n:number)=>`00000000-0000-4000-a000-${String(n).padStart(12,'0')}`;
const state=():PublicationInspectionState=>({schemaVersion:1,tenantId:id(1),userId:id(2),checkedAt:new Date().toISOString(),schedule:{enabled:true,intervalMinutes:60},nextAfter:null,
  items:[{publicationId:id(3),taskId:id(4),clientId:id(5),inspectionId:id(6),state:'finished',status:'consistent',stale:false,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),
    inputsSha256:'a'.repeat(64),resultSha256:'b'.repeat(64),checkedFiles:1,findings:[]}]});
it('loads stored evidence without writes and clears old success after a failed read',async()=>{
  let fail=false;const calls=stubCore(()=>fail?json({detail:'Unavailable'},503):json(state()));
  const view=await mount(React.createElement(PublicationInspectionPanel));await flush();expect(view.text()).toContain('Matched at last check');
  fail=true;await click(byText(view.container,'button','Reload Google checks'));await flush();
  expect(view.text()).toContain('Google inspection evidence unavailable');expect(view.text()).not.toContain('Matched at last check');
  expect(calls.every(c=>c.method==='GET')).toBe(true);await view.unmount();
});
it('rejects malformed evidence instead of presenting a success',async()=>{
  const response=state();response.items[0].resultSha256=null;stubCore(()=>json(response));
  const view=await mount(React.createElement(PublicationInspectionPanel));await flush();
  expect(view.text()).toContain('Incomplete or unsupported');expect(view.text()).not.toContain('Matched at last check');await view.unmount();
});
it('shows stale uncertainty, absent permission policy and all findings with safe provider links',async()=>{
  const response=state(),row=response.items[0];row.stale=true;row.status='unverified';
  row.findings=Array.from({length:13},()=>({code:'PERMISSIONS_BASELINE_UNAVAILABLE',resource:'file',resourceId:'file?unsafe=value',status:'unverified'}));
  stubCore(()=>json(response));const view=await mount(React.createElement(PublicationInspectionPanel));await flush();
  expect(view.text()).toContain('Observation is out of date');expect(view.text()).toContain('Verification incomplete');
  expect(view.text()).toContain('Show 1 more findings');expect(view.container.querySelectorAll('li')).toHaveLength(13);
  expect(view.container.querySelector('a')!.href).toBe('https://drive.google.com/open?id=file%3Funsafe%3Dvalue');await view.unmount();
});
it('does not restore evidence from a slow response after leaving the screen',async()=>{
  let resolve:((r:Response)=>void)|undefined,n=0;stubCore(()=>++n===1?new Promise<Response>(r=>{resolve=r;}):json({...state(),items:[]}));
  const first=await mount(React.createElement(PublicationInspectionPanel));await flush();await first.unmount();
  const current=await mount(React.createElement(PublicationInspectionPanel));await flush();resolve!(json(state()));await flush();
  expect(current.text()).toContain('No current publications');expect(current.text()).not.toContain('Matched at last check');await current.unmount();
});
