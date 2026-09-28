// @vitest-environment jsdom
import React,{act} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ReceiptAuditPanel} from '../src/components/ReceiptAuditPanel.js';
import {receiptAudit as audit,receiptAuditState as state} from './support/receipt-audit-fixture.js';
import {byText,click,flush,json,mount,stubCore} from './support/desk-harness.js';
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();sessionStorage.clear();document.body.innerHTML='';});
async function fill(container:HTMLElement,value:string){await act(async()=>{const el=container.querySelector('textarea')!;
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});}
async function submit(container:HTMLElement){await act(async()=>{container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();}
it('retains the exact audit action across a lost response and reload, and retries without a new ID',async()=>{
 let saved:any=null,posts=0;
 const calls=stubCore(c=>{
  if(c.method==='GET')return json(state());
  posts++;if(posts===1){saved=c.body;throw new TypeError('Synthetic lost reply');}
  return json({...audit,auditId:saved.actionId,reason:saved.reason,replayed:true});
 });
 const first=await mount(React.createElement(ReceiptAuditPanel));await flush();await fill(first.container,'Inspect failed delivery');await submit(first.container);
 expect(first.text()).toContain('Audit not confirmed');expect(first.text()).toContain('Retry saved audit');await first.unmount();
 const reopened=await mount(React.createElement(ReceiptAuditPanel));await flush();expect(reopened.text()).toContain('Retry saved audit');
 await submit(reopened.container);expect(calls.filter(c=>c.method==='POST').map(c=>c.body)).toEqual([saved,saved]);
 expect(reopened.text()).toContain('Original audit recovered');expect(reopened.text()).toContain('Inspect failed delivery');
 expect(sessionStorage.length).toBe(0);await reopened.unmount();
});
it('refuses dispatch when the exact action cannot be saved',async()=>{
 const calls=stubCore(()=>json(state(null))),view=await mount(React.createElement(ReceiptAuditPanel));await flush();
 await fill(view.container,'Inspect stored receipts');vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Storage unavailable');});
 await submit(view.container);expect(calls.filter(c=>c.method==='POST')).toEqual([]);expect(view.text()).toContain('No request was sent');await view.unmount();
});
it('clears old evidence on failed reads and rejects a report belonging to another actor',async()=>{
 let fail=false,foreign=false;stubCore(()=>fail?json({detail:'Unavailable'},503):json(state(foreign?{...audit,actorUserId:'00000000-0000-4000-a000-000000000013'}:audit)));
 const view=await mount(React.createElement(ReceiptAuditPanel));await flush();expect(view.text()).toContain('No tasks audited');
 fail=true;await click(byText(view.container,'button','Reload receipt audits'));await flush();expect(view.text()).toContain('Receipt audit evidence unavailable');expect(view.text()).not.toContain('No tasks audited');
 fail=false;foreign=true;await click(byText(view.container,'button','Reload receipt audits'));await flush();expect(view.text()).toContain('Unsupported or incomplete');await view.unmount();
});
it('ignores a slow older response and shows only the newer authorized scope',async()=>{
 let resolve:((r:Response)=>void)|undefined,n=0;stubCore(()=>++n===1?new Promise<Response>(r=>{resolve=r;}):json({...state(null),scope:{...state().scope,sha256:'d'.repeat(64),clientIds:[]}}));
 const view=await mount(React.createElement(ReceiptAuditPanel));await flush();
 // A parent telemetry refresh may supersede a pending read; remount models route cleanup as well.
 await view.unmount();const newer=await mount(React.createElement(ReceiptAuditPanel,{refreshKey:1}));await flush();
 resolve!(json(state()));await flush();expect(newer.text()).toContain('0 authorized client(s)');expect(newer.text()).not.toContain('No tasks audited');await newer.unmount();
});
it('a rapid duplicate submission retains one saved identity and sends one request',async()=>{
 let finish:((r:Response)=>void)|undefined,body:any;
 const calls=stubCore(c=>c.method==='GET'?json(state(null)):(body=c.body,new Promise<Response>(r=>{finish=r;})));
 const view=await mount(React.createElement(ReceiptAuditPanel));await flush();await fill(view.container,'Inspect once');
 await act(async()=>{const form=view.container.querySelector('form')!;for(let i=0;i<2;i++)form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await flush();
 expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);
 expect(JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!).actionId).toBe(body.actionId);
 finish!(json({...audit,auditId:body.actionId,reason:body.reason,replayed:false}));await flush();await view.unmount();
});
it.each([
 {...state(),latest:null},
 {...state(),history:[{...audit,revision:2}]},
 {...state(),history:[{...audit,auditId:'00000000-0000-4000-a000-000000000014'}]},
 {...state(),nextBeforeRevision:1},
])('refuses contradictory audit history instead of using an unsafe predecessor %#',async response=>{
 stubCore(()=>json(response));const view=await mount(React.createElement(ReceiptAuditPanel));await flush();
 expect(view.text()).toContain('Unsupported or incomplete');expect(view.container.querySelector('form')).toBeNull();await view.unmount();
});
