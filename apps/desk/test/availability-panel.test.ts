// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AvailabilityPanel } from '../src/components/AvailabilityPanel.js';
import { summarizeAvailability } from '../../../packages/domain/src/availability.js';
import type { AvailabilityObservation } from '@hawa/contracts';
import { advance, byText, click, flush, json, mount, stubCore } from './support/desk-harness.js';
const monitor = { id: '00000000-0000-4000-a000-000000000020', targetOrigin: 'https://office.example.test', scopeSha256: 'a'.repeat(64), latest: null };
const window = { month: '2026-09', startAt: '2026-08-31T21:00:00.000Z', endAt: '2026-09-30T21:00:00.000Z', now: '2026-08-31T21:03:30.000Z' };
const good = { outcome: 'available', error: 'none', httpStatus: 200, durationMs: 20 } as const;
const observation:AvailabilityObservation = { schemaVersion: 1, observationId: '00000000-0000-4000-a000-000000000021', monitorId: monitor.id, targetOrigin: monitor.targetOrigin,
 slotStart: window.startAt, observedAt: window.startAt, completedAt: '2026-08-31T21:00:00.100Z', durationMs: 100, probes: { desk: good, office: good }, buildCommit: null };
const report = () => summarizeAvailability([observation], window, { ...monitor, latest: { observedAt: observation.observedAt, receivedAt: observation.completedAt! } });
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();document.body.innerHTML='';});
async function chooseMonth(container:HTMLElement,value:string){
 const input=container.querySelector('input')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
 await flush();
}
it('shows coverage, gaps, stale monitoring and limited probe latency beside the observed success ratio',async()=>{
 const calls=stubCore(()=>json(report()));const v=await mount(React.createElement(AvailabilityPanel));await flush();
 expect(v.text()).toContain('Provisional month');expect(v.text()).toContain('Collector: stale');
 expect(v.text()).toContain('100.000%');expect(v.text()).toContain('Coverage: 33.333%');expect(v.text()).toContain('2 unknown minute slots (2 missing observations)');
 expect(v.text()).toContain('Not established');expect(v.text()).toContain('round-trip latency: p50 100 ms');
 expect(v.text()).toContain('do not measure complete user journeys');expect(calls.every(c=>c.method==='GET')).toBe(true);await v.unmount();
});
it('renders zero observations with unknown latency and no compliant badge',async()=>{
 stubCore(()=>json(summarizeAvailability([],window,monitor)));const v=await mount(React.createElement(AvailabilityPanel));await flush();
 expect(v.text()).toContain('Known observations available: Unknown');expect(v.text()).toContain('p50 —');expect(v.text()).toContain('awaiting observations');
 expect(v.text()).not.toContain('Met for sampled readiness');await v.unmount();
});
it('clears current evidence when the selected historical month fails or lies about compliance',async()=>{
 stubCore(c=>c.search.get('month')?json({...report(),availability:{...report().availability,sloCompliant:true}}):json(report()));
 const v=await mount(React.createElement(AvailabilityPanel));await flush();expect(v.text()).toContain('Coverage: 33.333%');
 await chooseMonth(v.container,'2026-08');expect(v.text()).toContain('Reliability evidence unavailable');expect(v.text()).not.toContain('Coverage: 33.333%');
 await click(byText(v.container,'button','Current month'));await flush();expect(v.text()).toContain('Coverage: 33.333%');await v.unmount();
});
it('ignores an old month response that arrives after a new request',async()=>{
 let old:((r:Response)=>void)|undefined;
 const previous=summarizeAvailability([],{...window,month:'2026-08',startAt:'2026-07-31T21:00:00.000Z',endAt:window.startAt},monitor);
 stubCore(c=>c.search.get('month')?json(previous):new Promise<Response>(resolve=>{old=resolve;}));
 const v=await mount(React.createElement(AvailabilityPanel));await flush();await chooseMonth(v.container,'2026-08');
 expect(v.text()).toContain('Completed month · 2026-08');old!(json(report()));await flush();expect(v.text()).toContain('Completed month · 2026-08');
 expect(v.text()).not.toContain('Provisional month');await v.unmount();
});

it('refreshes each minute so a stopped monitor or failed read cannot remain apparently current',async()=>{
 let available=true;const calls=stubCore(()=>available?json(report()):json({detail:'Storage unavailable'},503));
 const v=await mount(React.createElement(AvailabilityPanel));await flush();expect(v.text()).toContain('Coverage: 33.333%');
 available=false;await advance(60000);expect(v.text()).toContain('Reliability evidence unavailable');expect(v.text()).not.toContain('Coverage: 33.333%');
 await v.unmount();const count=calls.length;await advance(60000);expect(calls.length).toBe(count);
});

it('retries only reliability evidence and recovers from an unavailable read',async()=>{
 let fail=true;
 const calls=stubCore(()=>fail?json({detail:'Unavailable'},503):json(report()));
 const v=await mount(React.createElement(AvailabilityPanel));await flush();expect(v.text()).toContain('Reliability evidence unavailable');
 fail=false;await click(byText(v.container,'button','Retry reliability read'));await flush();
 expect(v.text()).toContain('Coverage: 33.333%');expect(calls).toHaveLength(2);expect(calls.every(c=>c.path==='/v1/operations/slo' && c.method==='GET')).toBe(true);await v.unmount();
});
