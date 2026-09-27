import { afterEach, expect, it, vi } from 'vitest';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { SyntheticTrafficDaemon } from '@hawa/testkit';
import { globalCostGovernor } from '@hawa/integrations';

afterEach(()=>vi.restoreAllMocks());
it('reports unmeasured production availability without substituting a fake benchmark',async()=>{
 const app=createAppWithClientFixtures({testAuth:{principal:{role:'administrator'}}});
 const probe=vi.spyOn(SyntheticTrafficDaemon.prototype,'runProbe');
 const r=await app.request('/v1/operations/slo');expect(r.status).toBe(200);
 expect(await r.json()).toMatchObject({schemaVersion:1,evidenceKind:'unmeasured',availability:{targetPercent:99.5,observedPercent:null,sloCompliant:null,observationCount:0},latency:{p50Ms:null,p95Ms:null,p99Ms:null,observationCount:0}});
 expect(probe).not.toHaveBeenCalled();
});
it('refuses synthetic publication through the operational probe endpoint',async()=>{
 const app=createAppWithClientFixtures({testAuth:{principal:{role:'administrator'}}});const probe=vi.spyOn(SyntheticTrafficDaemon.prototype,'runProbe');
 const r=await app.request('/v1/operations/slo/run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 expect(r.status).toBe(410);expect(probe).not.toHaveBeenCalled();
});
it('retires sample monthly budget inspection and mutation without changing stored governor state',async()=>{
 const app=createAppWithClientFixtures({testAuth:{principal:{role:'administrator'}}});const before=JSON.stringify(globalCostGovernor.exportState());
 for(const [path,method] of [['/clients/budgets','GET'],['/clients/client-drustee/budget','GET'],['/clients/client-drustee/budget/allocate','POST']]){
  const r=await app.request('/v1'+path,{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify({capUsd:444})}:{})});
  expect(r.status).toBe(410);expect((await r.json()).detail).toContain('/spending/policy');
 }
 expect(JSON.stringify(globalCostGovernor.exportState())).toBe(before);
});
