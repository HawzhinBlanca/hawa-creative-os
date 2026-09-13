import { describe,it,expect,vi,afterEach } from 'vitest';
import { runCanvaDraft } from '../src/canva-draft-workflow.js';
import { DurableStepJournal } from '../src/durable-context.js';
import { TaskWorkflowDispatcher } from '../src/workflow-dispatcher.js';
const input={taskId:'00000000-0000-4000-c000-000000000001',tenantId:'tenant',clientId:'client',rawText:'',sourcePlatform:'telegram',idempotencyKey:'key',canvaAutoGenerate:true};
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('native Canva workflow',()=>{
  it('resumes known operations and retrieves a real-shaped preview without approving',async()=>{
    vi.stubEnv('HAWA_BEARER_TOKEN','test-only');
    const replies=[{tenantId:'tenant',clientId:'client'},{status:'submitted',planId:'plan'},
      {status:'retrieved',planId:'plan',designId:'DA_test'},{binding:{designId:'DA_test',version:1}},
      {status:'submitted',operationId:'export'},{status:'retrieved',artifact:{id:'artifact'}},
      {status:'submitted',operationId:'check'},{status:'retrieved',artifact:{content_check:{copyPass:true,fontPass:true}}}];
    const remote=vi.fn(async()=>Response.json(replies.shift())),ctx=new DurableStepJournal();
    const result=await runCanvaDraft(input,ctx,remote);
    expect(result.status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');expect(result.qcPassed).toBe(false);
    expect(remote.mock.calls[1][1].headers['Idempotency-Key']).toBe('workflow-'+input.taskId);
    const firstCalls=remote.mock.calls.length;await runCanvaDraft(input,ctx,remote);expect(remote).toHaveBeenCalledTimes(firstCalls);
  });
  it('recovers a stale preview with a fresh bounded export without another generation',async()=>{
    vi.stubEnv('HAWA_BEARER_TOKEN','test-only');
    const replies=[{tenantId:'tenant',clientId:'client'},{status:'retrieved',designId:'DA_test'},
      {binding:{designId:'DA_test',version:1}},{status:'stale'},
      {binding:{designId:'DA_test',version:1}},{status:'submitted',operationId:'fresh'},
      {status:'retrieved',artifact:{id:'artifact'}},{status:'retrieved',artifact:{content_check:{copyPass:true,fontPass:false}}}];
    const remote=vi.fn(async()=>Response.json(replies.shift()));
    expect((await runCanvaDraft(input,new DurableStepJournal(),remote)).status).toBe('CANVA_FONT_MISMATCH');
    expect(remote.mock.calls.filter(c=>String(c[0]).endsWith('/canva/generate'))).toHaveLength(1);
    expect(remote.mock.calls[5][1].headers['Idempotency-Key']).toContain('-retry-1');
  });
  it('does not spend on the historical backlog without an explicit generation marker',async()=>{
    const remote=vi.fn();expect((await runCanvaDraft({...input,canvaAutoGenerate:false},new DurableStepJournal(),remote)).status).toBe('MANUAL_DESIGN_REQUIRED');expect(remote).not.toHaveBeenCalled();
  });
  it('rejects a different client before model or Canva actions',async()=>{
    vi.stubEnv('HAWA_BEARER_TOKEN','test-only');const remote=vi.fn(async()=>Response.json({tenantId:'tenant',clientId:'OTHER'}));
    await expect(runCanvaDraft(input,new DurableStepJournal(),remote)).rejects.toThrow('mismatch');expect(remote).toHaveBeenCalledTimes(1);
  });
  it('never turns an uncertain generation into an approval or new request',async()=>{
    vi.stubEnv('HAWA_BEARER_TOKEN','test-only');const responses=[{tenantId:'tenant',clientId:'client'},{status:'uncertain',planId:'plan'}];
    const remote=vi.fn(async()=>Response.json(responses.shift()));const result=await runCanvaDraft(input,new DurableStepJournal(),remote);
    expect(result.status).toBe('DESIGN_UNCERTAIN');expect(result.qcPassed).toBe(false);expect(remote).toHaveBeenCalledTimes(2);
  });
  it('requires an engine invocation receipt, not just HTTP success',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ok:true})));
    const dispatcher=new TaskWorkflowDispatcher({restateIngressUrl:'http://restate.test'});
    await expect(dispatcher.dispatch({aggregate_id:input.taskId,tenant_id:'tenant',idempotency_key:'key',payload:{}} as any)).rejects.toThrow('invocation receipt');
  });
  it('uses workflow-key idempotency without the header rejected by the live Restate server',async()=>{
    const remote=vi.fn(async()=>Response.json({invocationId:'inv_test123',status:'Accepted'}));vi.stubGlobal('fetch',remote);
    const dispatcher=new TaskWorkflowDispatcher({restateIngressUrl:'http://restate.test'});
    const receipt=await dispatcher.dispatch({aggregate_id:input.taskId,tenant_id:'tenant',idempotency_key:'key',payload:{workflow:'canva',autoGenerate:true}} as any);
    expect(receipt.receiptId).toBe('inv_test123');expect(remote.mock.calls[0][1].headers).not.toHaveProperty('idempotency-key');
    expect(JSON.parse(remote.mock.calls[0][1].body).canvaAutoGenerate).toBe(true);
  });
});
