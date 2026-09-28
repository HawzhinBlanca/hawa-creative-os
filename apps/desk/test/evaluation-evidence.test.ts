// @vitest-environment jsdom
import React, {act} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EvalScreen} from '../src/screens/EvalScreen.js';
import {caseOutcome,statsFromReport} from '../src/services/evaluation-evidence.js';
import {byText,click,flush,json,mount,stubCore} from './support/desk-harness.js';
const source={file:'evals/routing_brief.jsonl',sha256:'a'.repeat(64)};
const suite={dataset:'routing_brief.jsonl',source,totalCases:3,passedCases:1,failedCases:1,passRate:null,criticalViolations:1,unreportedCases:0,
  execution:{status:'stopped',attemptedCases:2,unexecutedCases:1},caseResults:[{caseId:'RB-1',status:'passed'},{caseId:'RB-2',status:'failed'},{caseId:'RB-3',status:'not_executed'}]};
const run={runId:'saved-run-1',createdAt:'2026-09-25T10:00:00Z',status:'completed',report:{routing:suite,executionStatus:'stopped',overallPassRate:null},resumable:false};
const cases={datasetId:'brief',source,cases:[{id:'RB-1',message:'one'},{id:'RB-2',message:'two'},{id:'RB-3',message:'three'}]};
const catalog=[{id:'brief',name:'Routing',casesCount:3,status:'available'},{id:'rtl',name:'RTL',casesCount:1,status:'available'}];
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();sessionStorage.clear();document.body.innerHTML='';});

it('shows actual mixed case results and suite counts across tabs without inventing candidate quality',async()=>{
  const requests=stubCore(c=>c.path.endsWith('/datasets')?json(catalog):c.path.endsWith('/runs')?json([run]):c.path.endsWith('/cases')?json(cases):undefined);
  const view=await mount(React.createElement(EvalScreen));await flush();
  const rows=[...view.container.querySelectorAll('tbody tr')];
  expect(rows.map(row=>row.children[4].textContent)).toEqual(['Passed','Failed','Not executed']);
  await click(byText(view.container,'button','Suite Breakdown'));
  expect(view.text()).toContain('Passed: 1 · Failed: 1 · Total: 3');expect(view.text()).toContain('Not executed: 1');
  expect(view.text()).not.toMatch(/420ms|0.988|7.2:1|40\/40 Passed/);
  await click(byText(view.container,'button','Candidates'));
  expect(view.text()).toContain('Candidate ranking, human scores and canary status: Not reported');
  expect(view.text()).not.toMatch(/Gemini 3.8 Flash|94.8|active canary|GPT-5.6 Sol/);
  expect(requests.every(c=>c.method==='GET')).toBe(true);await view.unmount();
});
it('never promotes legacy aggregates, different hashes, missing or duplicate case evidence into passes',()=>{
  expect(caseOutcome({routing:{totalCases:200,passedCases:200}},source,'RB-1')).toBe('Not reported');
  expect(caseOutcome(run.report,{...source,sha256:'b'.repeat(64)},'RB-1')).toBe('Dataset changed');
  expect(caseOutcome(run.report,source,'absent')).toBe('Not reported');
  expect(caseOutcome({routing:{...suite,caseResults:[suite.caseResults[0],suite.caseResults[0]]}},source,'RB-1')).toBe('Not reported');
  expect(caseOutcome(run.report,{file:'evals/rtl_golden_cases.jsonl',sha256:'a'.repeat(64)},'RTL-1')).toBe('Not executed by this tournament');
  expect(statsFromReport({routing:{totalCases:2,passedCases:3,passRate:150},overallPassRate:150}).overall).toBe('—');
  expect(statsFromReport({routing:{totalCases:2}}).testsPassed).toBeNull();
});
it('ignores a late corpus response after switching datasets',async()=>{
  let resolve!: (response:Response)=>void;
  stubCore(c=>c.path.endsWith('/datasets')?json(catalog):c.path.endsWith('/runs')?json([run]):
    c.path.includes('/brief/cases')?new Promise<Response>(r=>resolve=r):json({datasetId:'rtl',source:{...source,file:'evals/rtl_golden_cases.jsonl'},cases:[{id:'RTL-1',text:'RTL text'}]}));
  const view=await mount(React.createElement(EvalScreen));await flush();
  await click(byText(view.container,'.listitem','RTL'));await flush();
  expect(view.text()).toContain('RTL-1');expect(view.text()).toContain('Not executed by this tournament');
  await act(async()=>resolve(json(cases)));await flush();
  expect(view.text()).toContain('RTL-1');expect(view.text()).not.toContain('RB-1');await view.unmount();
});
it('switches selected run evidence and never carries another run’s calls into candidate results',async()=>{
  const older={...run,runId:'older-id-2',report:{routing:{...suite,caseResults:[]}}};
  stubCore(c=>c.path.endsWith('/datasets')?json(catalog):c.path.endsWith('/runs')?json([older,run]):c.path.endsWith('/cases')?json(cases):
    json({...run,snapshotHash:'snapshot',canSettle:false,settlement:null,calls:[{id:'call',ordinal:1,provider:'observed-provider',model:'observed-model',status:'completed',latencyMs:27}]}));
  const view=await mount(React.createElement(EvalScreen));await flush();
  await click(byText(view.container,'button','Candidates'));await click(byText(view.container,'button','Load calls for selected run'));await flush();
  expect(view.text()).toContain('observed-model');expect(view.text()).toContain('27 ms');
  await click(byText(view.container,'button','older-id'));await flush();
  expect(view.text()).not.toContain('observed-model');await click(byText(view.container,'button','Cases'));
  expect(view.container.querySelector('tbody tr')?.children[4].textContent).toBe('Not reported');await view.unmount();
});
it('uses the persisted start time on action replay and does not invent undeclared checks',async()=>{
  stubCore(c=>c.path.endsWith('/datasets')?json(catalog):c.method==='POST'?json({...run,completedAt:'2026-09-25T10:01:00Z'}):c.path.endsWith('/runs')?json([]):json(cases));
  const view=await mount(React.createElement(EvalScreen));await flush();
  await click(byText(view.container,'button','Run fixture evaluation'));await flush();
  expect(view.text()).toContain('2026-09-25 10:00:00 UTC');
  await click(byText(view.container,'button','Inspect'));expect(view.text()).toContain('Not declared in this case');
  expect(view.text()).not.toContain('fact_isolation, zero_leakage');await view.unmount();
});
it('does not let a delayed history read replace a newly returned run',async()=>{
  let resolve!: (response:Response)=>void;
  stubCore(c=>c.path.endsWith('/datasets')?json(catalog):c.method==='POST'?json({...run,completedAt:run.createdAt}):
    c.path.endsWith('/runs')?new Promise<Response>(r=>resolve=r):json(cases));
  const view=await mount(React.createElement(EvalScreen));await flush();
  await click(byText(view.container,'button','Run fixture evaluation'));await flush();
  await act(async()=>resolve(json([{...run,runId:'old-history-run',report:null}])));await flush();
  expect(view.text()).toContain('Selected saved run: saved-run-1');
  expect(view.container.querySelector('tbody tr')?.children[4].textContent).toBe('Passed');await view.unmount();
});
