// @vitest-environment jsdom
import {receiptAudit as audit,receiptAuditState as state} from './support/receipt-audit-fixture.js';
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpsScreen } from '../src/screens/OpsScreen.js';
import { byText, click, flush, json, mount, stubCore } from './support/desk-harness.js';
const unmeasured={schemaVersion:1,evidenceKind:'unmeasured',checkedAt:'2026-09-27T12:00:00.000Z',availability:{targetPercent:99.5,window:'calendar_month',timeZone:'Asia/Baghdad',observedPercent:null,sloCompliant:null,observationCount:0},latency:{p50Ms:null,p95Ms:null,p99Ms:null,observationCount:0},nextAction:'Collect independent availability observations for office intake and review.'};

beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();sessionStorage.clear();document.body.innerHTML='';});
it('shows unmeasured office reliability and an empty receipt audit; never calls the sample budget endpoints',async()=>{
 const calls=stubCore(c=>c.path.endsWith('/slo')?json(unmeasured):c.path.endsWith('/reconciliation')?json(state(audit)):json({items:[]}));
 const v=await mount(React.createElement(OpsScreen));await flush();
 expect(v.text()).toContain('Availability unmeasured');expect(v.text()).toContain('99.5%');expect(v.text()).toContain('No tasks audited');
 expect(v.text()).not.toMatch(/SLO: COMPLIANT|100% In Sync|Drifts Repaired|Langfuse|Helicone|Monthly Spend/);
 expect(calls.some(c=>c.path.includes('/clients/budgets'))).toBe(false);
 expect(calls.filter(c=>c.method!=='GET')).toEqual([]);
 expect((fetch as ReturnType<typeof vi.fn>).mock.calls.every(([,options])=>options.cache==='no-store')).toBe(true);await v.unmount();
});
it('clears stale successful evidence on failed or malformed refresh',async()=>{
 let fail=false;
 stubCore(c=>c.path.endsWith('/slo')?json(fail?{summary:{sloCompliant:true,successRate:100}}:unmeasured):c.path.endsWith('/reconciliation')?json(fail?{detail:'Database unavailable'}:state(audit),fail?503:200):json({items:[]}));
 const v=await mount(React.createElement(OpsScreen));await flush();expect(v.text()).toContain('No tasks audited');
 fail=true;await click(byText(v.container,'button','Refresh telemetry'));await flush();
 expect(v.text()).toContain('Reliability evidence unavailable');expect(v.text()).toContain('No audit read');
 expect(v.text()).not.toContain('No tasks audited');expect(v.text()).not.toContain('SLO: COMPLIANT');await v.unmount();
});
it('ignores an older response which completes after a newer refresh',async()=>{
 let reads=0,resolveFirst:((r:Response)=>void)|undefined;
 stubCore(c=>{
  if(c.path.endsWith('/reconciliation')){reads++;if(reads===1)return new Promise<Response>(resolve=>{resolveFirst=resolve;});return json(state({...audit,totalTasksAudited:1,driftCount:1,status:'divergent',anomalies:[{taskId:'00000000-0000-4000-a000-000000000014',kind:'MISSING_SHEET_ROW',severity:'medium',description:'Missing receipt',detectedAt:audit.timestamp}]}));}
  return c.path.endsWith('/slo')?json(unmeasured):json({items:[]});
 });
 const v=await mount(React.createElement(OpsScreen));await flush();
 await click(byText(v.container,'button','Refresh telemetry'));await flush();expect(v.text()).toContain('Drift found');
 resolveFirst!(json(state(audit)));await flush();expect(v.text()).toContain('Drift found');expect(v.text()).not.toContain('No tasks audited');await v.unmount();
});

it('treats malformed successful telemetry as unknown instead of an empty healthy collection',async()=>{
 stubCore(c=>c.path.endsWith('/slo')?json(unmeasured):json({items:[null],status:'healthy',stageDurations:{broken:null}}));
 const v=await mount(React.createElement(OpsScreen));await flush();
 expect(v.text()).toContain('Integration results were not reported');expect(v.text()).toContain('Failure results were not reported');
 expect(v.text()).toContain('Design progress unknown');expect(v.text()).toContain('critical incidents');
 const stats=v.container.querySelector('.grid4')!;expect([...stats.querySelectorAll('b')].map(e=>e.textContent)).toEqual(['—','—','—','—']);await v.unmount();
});

it('prioritizes actionable failures and labels the progress as a timestamped snapshot', async () => {
 stubCore(c => c.path.endsWith('/funnel/health') ? json({status:'healthy',windowHours:48,briefsCount:2,draftsCount:2,stalledTaskCount:0,stageDurations:{briefToDraft:{samples:2,p50Hours:1/60,p95Hours:1/120}}}) : json({items:[]}));
 const v=await mount(React.createElement(OpsScreen));await flush();
 expect(v.text().indexOf('Actionable operations')).toBeLessThan(v.text().indexOf('Daily spending policy'));
 expect(v.text()).toContain('Snapshot read');expect(v.container.querySelector('time')?.dateTime).toMatch(/^\d{4}-/);
 expect(v.text()).toContain('Brief → draft: 2 completed · p50 1m · p95 30s');
 expect(v.text()).toContain('not live service availability');expect(v.text()).not.toContain('· healthy');
 expect(v.container.querySelectorAll('h1')).toHaveLength(0);await v.unmount();
});

it('expires successful telemetry on the next visible refresh and ignores late responses after unmount', async () => {
 let failed=false;
 const calls=stubCore(c=>c.path.endsWith('/funnel/health')&&!failed ? json({status:'healthy',windowHours:48,briefsCount:2,draftsCount:2,stalledTaskCount:0}) : json({detail:'Unavailable'},503));
 const v=await mount(React.createElement(OpsScreen));await flush();expect(v.text()).toContain('2 requests');
 failed=true;await import('./support/desk-harness.js').then(m=>m.advance(60000));
 expect(v.text()).not.toContain('2 requests');expect(v.text()).toContain('Design progress unknown');
 await v.unmount();const total=calls.length;await import('./support/desk-harness.js').then(m=>m.advance(60000));expect(calls).toHaveLength(total);
});
