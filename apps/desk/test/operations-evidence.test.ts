// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpsScreen } from '../src/screens/OpsScreen.js';
import { byText, click, flush, json, mount, stubCore } from './support/desk-harness.js';
const unmeasured={schemaVersion:1,evidenceKind:'unmeasured',checkedAt:'2026-09-27T12:00:00.000Z',availability:{targetPercent:99.5,window:'calendar_month',timeZone:'Asia/Baghdad',observedPercent:null,sloCompliant:null,observationCount:0},latency:{p50Ms:null,p95Ms:null,p99Ms:null,observationCount:0},nextAction:'Collect independent availability observations for office intake and review.'};
const audit={auditId:'audit-synthetic',timestamp:'2026-09-27T12:00:00.000Z',basis:'Stored PostgreSQL receipts. External services were not read.',simulated:false,totalTasksAudited:0,totalDriveDeliverablesChecked:0,totalSheetRowsAudited:0,inSyncCount:0,driftCount:0,status:'clean',anomalies:[]};
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();sessionStorage.clear();document.body.innerHTML='';});
it('shows unmeasured office reliability and an empty receipt audit; never calls the sample budget endpoints',async()=>{
 const calls=stubCore(c=>c.path.endsWith('/slo')?json(unmeasured):c.path.endsWith('/reconciliation')?json(audit):json({items:[]}));
 const v=await mount(React.createElement(OpsScreen));await flush();
 expect(v.text()).toContain('Availability unmeasured');expect(v.text()).toContain('99.5%');expect(v.text()).toContain('No tasks audited');
 expect(v.text()).not.toMatch(/SLO: COMPLIANT|100% In Sync|Drifts Repaired|Langfuse|Helicone|Monthly Spend/);
 expect(calls.some(c=>c.path.includes('/clients/budgets'))).toBe(false);
 expect(calls.filter(c=>c.method!=='GET')).toEqual([]);
 expect((fetch as ReturnType<typeof vi.fn>).mock.calls.every(([,options])=>options.cache==='no-store')).toBe(true);await v.unmount();
});
it('clears stale successful evidence on failed or malformed refresh',async()=>{
 let fail=false;
 stubCore(c=>c.path.endsWith('/slo')?json(fail?{summary:{sloCompliant:true,successRate:100}}:unmeasured):c.path.endsWith('/reconciliation')?json(fail?{detail:'Database unavailable'}:audit,fail?503:200):json({items:[]}));
 const v=await mount(React.createElement(OpsScreen));await flush();expect(v.text()).toContain('No tasks audited');
 fail=true;await click(byText(v.container,'button','Refresh telemetry'));await flush();
 expect(v.text()).toContain('Reliability evidence unavailable');expect(v.text()).toContain('No audit read');
 expect(v.text()).not.toContain('No tasks audited');expect(v.text()).not.toContain('SLO: COMPLIANT');await v.unmount();
});
it('ignores an older response which completes after a newer refresh',async()=>{
 let reads=0,resolveFirst:((r:Response)=>void)|undefined;
 stubCore(c=>{
  if(c.path.endsWith('/reconciliation')){reads++;if(reads===1)return new Promise<Response>(resolve=>{resolveFirst=resolve;});return json({...audit,auditId:'new-audit',totalTasksAudited:1,driftCount:1,status:'divergent'});}
  return c.path.endsWith('/slo')?json(unmeasured):json({items:[]});
 });
 const v=await mount(React.createElement(OpsScreen));await flush();
 await click(byText(v.container,'button','Refresh telemetry'));await flush();expect(v.text()).toContain('Drift found');
 resolveFirst!(json(audit));await flush();expect(v.text()).toContain('Drift found');expect(v.text()).not.toContain('No tasks audited');await v.unmount();
});

it('treats malformed successful telemetry as unknown instead of an empty healthy collection',async()=>{
 stubCore(c=>c.path.endsWith('/slo')?json(unmeasured):json({items:[null],status:'healthy',stageDurations:{broken:null}}));
 const v=await mount(React.createElement(OpsScreen));await flush();
 expect(v.text()).toContain('Integration results were not reported');expect(v.text()).toContain('Failure results were not reported');
 expect(v.text()).toContain('Design progress unknown');expect(v.text()).toContain('critical incidents');
 const stats=v.container.querySelector('.grid4')!;expect([...stats.querySelectorAll('b')].map(e=>e.textContent)).toEqual(['—','—','—','—']);await v.unmount();
});
