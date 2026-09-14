import { describe,it,expect,vi,afterEach } from 'vitest';
import { runCanvaDraft, resolveCanvaVariant } from '../src/canva-draft-workflow.js';
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
    expect(result.status).toBe('DESIGN_UNCERTAIN');expect(result.qcPassed).toBe(false);
    // scope check, generation, and one outcome notification; never a second generation
    expect(remote).toHaveBeenCalledTimes(3);
    expect(String(remote.mock.calls[2][0])).toContain('/notifications/canva-status');
    expect(JSON.parse(remote.mock.calls[2][1].body)).toMatchObject({status:'DESIGN_UNCERTAIN'});
  });
  it('reports a refused generation (4xx) as a terminal outcome instead of retrying it',async()=>{
    vi.stubEnv('HAWA_BEARER_TOKEN','test-only');
    const responses=[Response.json({tenantId:'tenant',clientId:'client'}),Response.json({title:'COPY_UNSUPPORTED'},{status:422}),Response.json({ok:true})];
    const remote=vi.fn(async()=>responses.shift());const result=await runCanvaDraft(input,new DurableStepJournal(),remote);
    expect(result.status).toBe('DESIGN_REJECTED');expect(remote).toHaveBeenCalledTimes(3);
    expect(JSON.parse(remote.mock.calls[2][1].body)).toMatchObject({status:'DESIGN_REJECTED',code:'COPY_UNSUPPORTED'});
  });
  it('keeps retrying transient Core failures (5xx) rather than reporting a false outcome',async()=>{
    vi.stubEnv('HAWA_BEARER_TOKEN','test-only');
    const responses=[Response.json({tenantId:'tenant',clientId:'client'}),new Response('down',{status:503})];
    const remote=vi.fn(async()=>responses.shift());
    await expect(runCanvaDraft(input,new DurableStepJournal(),remote)).rejects.toThrow('HTTP 503');
    expect(remote.mock.calls.some(c=>String(c[0]).includes('/notifications/'))).toBe(false);
  });
  it('drafts the size recorded at intake and falls back to the historical default without one',async()=>{
    vi.stubEnv('HAWA_BEARER_TOKEN','test-only');
    const sized=[Response.json({tenantId:'tenant',clientId:'client'}),Response.json({status:'uncertain',planId:'plan'}),Response.json({ok:true})];
    const remote=vi.fn(async()=>sized.shift());
    await runCanvaDraft({...input,canvaVariant:{width:1080,height:1350}},new DurableStepJournal(),remote);
    expect(JSON.parse(remote.mock.calls[1][1].body)).toEqual({width:1080,height:1350});
    expect(resolveCanvaVariant({canvaVariant:{width:10,height:10}})).toEqual({width:1200,height:1697});
    expect(resolveCanvaVariant({})).toEqual({width:1200,height:1697});
  });
  it('never starts model or Canva work for an unscoped task; it tells the requester instead',async()=>{
    vi.stubEnv('HAWA_BEARER_TOKEN','test-only');
    const remote=vi.fn(async()=>Response.json({ok:true}));
    const result=await runCanvaDraft({...input,clientId:undefined},new DurableStepJournal(),remote);
    expect(result.status).toBe('CLIENT_REQUIRED');expect(remote).toHaveBeenCalledTimes(1);
    expect(String(remote.mock.calls[0][0])).toContain('/notifications/canva-status');
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
  it('reconciles 409 Conflict when workflow is already running in Restate without throwing', async () => {
    const remote = vi.fn(async () => new Response('Workflow execution already started', { status: 409, statusText: 'Conflict' }));
    vi.stubGlobal('fetch', remote);
    const dispatcher = new TaskWorkflowDispatcher({ restateIngressUrl: 'http://restate.test' });
    const receipt = await dispatcher.dispatch({ aggregate_id: input.taskId, tenant_id: 'tenant', idempotency_key: 'conflict-key', payload: {} } as any);
    expect(receipt.status).toBe('submitted');
    expect(receipt.reconciled).toBe(true);
    expect(receipt.receiptId).toContain('inv_conflict_reconciled_');
  });
  it('passes updated binding version to pptx check after preview recovery bumps version', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const replies = [
      { tenantId: 'tenant', clientId: 'client' },
      { status: 'retrieved', planId: 'plan', designId: 'DA_test' },
      { binding: { designId: 'DA_test', version: 1 } },
      { status: 'stale' },
      { binding: { designId: 'DA_test', version: 2 } }, // Version bumped by recovery
      { status: 'retrieved', artifact: { id: 'art1' } },
      { status: 'retrieved', artifact: { content_check: { copyPass: true, fontPass: true } } },
    ];
    const remote = vi.fn(async () => Response.json(replies.shift()));
    const result = await runCanvaDraft(input, new DurableStepJournal(), remote);
    expect(result.status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    const pptxCall = remote.mock.calls.find((c) => String(c[0]).endsWith('/canva/exports') && JSON.parse(c[1].body).format === 'pptx');
    expect(pptxCall).toBeDefined();
    expect(JSON.parse(pptxCall![1].body).expectedVersion).toBe(2);
  });
  it('gracefully falls back to CANVA_CHECK_REQUIRED when copy/font check export fails with 4xx terminal error', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const responses = [
      Response.json({ tenantId: 'tenant', clientId: 'client' }),
      Response.json({ status: 'retrieved', planId: 'plan', designId: 'DA_test' }),
      Response.json({ binding: { designId: 'DA_test', version: 1 } }),
      Response.json({ status: 'retrieved', artifact: { id: 'art1' } }),
      Response.json({ title: 'EXPORT_FAILED' }, { status: 422 }),
      Response.json({ ok: true }), // notification
    ];
    const remote = vi.fn(async () => responses.shift()!);
    const result = await runCanvaDraft(input, new DurableStepJournal(), remote);
    expect(result.status).toBe('CANVA_CHECK_REQUIRED');
    expect(result.documentId).toBe('DA_test');
  });
  it('gracefully transitions to CANVA_PREVIEW_FAILED when preview export fails with 4xx terminal error', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const responses = [
      Response.json({ tenantId: 'tenant', clientId: 'client' }),
      Response.json({ status: 'retrieved', planId: 'plan', designId: 'DA_test' }),
      Response.json({ binding: { designId: 'DA_test', version: 1 } }),
      Response.json({ title: 'CANVA_PREVIEW_REJECTED' }, { status: 422 }),
      Response.json({ ok: true }), // notification
    ];
    const remote = vi.fn(async () => responses.shift()!);
    const result = await runCanvaDraft(input, new DurableStepJournal(), remote);
    expect(result.status).toBe('CANVA_PREVIEW_FAILED');
    expect(result.documentId).toBe('DA_test');
  });

  it('gracefully transitions to DESIGN_REJECTED when resume draft fails with 4xx terminal error', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const responses = [
      Response.json({ tenantId: 'tenant', clientId: 'client' }),
      Response.json({ status: 'planning', planId: 'plan_123' }),
      Response.json({ title: 'PLAN_NOT_FOUND' }, { status: 404 }),
      Response.json({ ok: true }), // notification
    ];
    const remote = vi.fn(async () => responses.shift()!);
    const result = await runCanvaDraft(input, new DurableStepJournal(), remote);
    expect(result.status).toBe('DESIGN_REJECTED');
    expect(remote.mock.calls.some((c) => String(c[0]).includes('/notifications/canva-status'))).toBe(true);
  });

  it('executes Design Studio v2 workflow: studio-start -> studio-resume -> binding -> exports -> parity -> ready', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const studioInput = {
      ...input,
      designStudio: true,
      studioOptions: { tier: 'quality' as const, previews: 3 },
    };
    const replies = [
      { tenantId: 'tenant', clientId: 'client' }, // verify scope
      { runId: 'run-studio-123', status: 'briefing' }, // canva-studio-start
      { runId: 'run-studio-123', status: 'transferred', planId: 'plan-studio-1', designId: 'DA_studio_winner' }, // canva-studio-resume-0
      { binding: { designId: 'DA_studio_winner', version: 1 } }, // canva-read-binding
      { status: 'submitted', operationId: 'export_preview' }, // canva-export-preview
      { status: 'retrieved', artifact: { id: 'artifact_preview' } }, // canva-resume-preview
      { status: 'submitted', operationId: 'check_pptx' }, // canva-export-copy-font-check
      { status: 'retrieved', artifact: { content_check: { copyPass: true, fontPass: true } } }, // canva-resume-check
      { ok: true, parity: 'match' }, // canva-parity-check
      { ok: true }, // canva-notify-canva_draft_ready_for_visual_review
    ];
    const remote = vi.fn(async () => Response.json(replies.shift()));
    const ctx = new DurableStepJournal();
    const result = await runCanvaDraft(studioInput, ctx, remote);

    expect(result.status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    expect(result.documentId).toBe('DA_studio_winner');

    // 1. studio start verification
    const startCall = remote.mock.calls[1];
    expect(String(startCall[0])).toContain('/canva/studio');
    expect(startCall[1].headers['Idempotency-Key']).toBe('workflow-studio-' + studioInput.taskId);
    expect(JSON.parse(startCall[1].body)).toMatchObject({
      width: 1200,
      height: 1697,
      tier: 'quality',
      previews: 3,
    });

    // 2. studio resume verification
    const resumeCall = remote.mock.calls[2];
    expect(String(resumeCall[0])).toContain('/canva/studio/run-studio-123/resume');

    // 3. parity check verification
    const parityCall = remote.mock.calls.find((c) => String(c[0]).includes('/canva/parity-check'));
    expect(parityCall).toBeDefined();
    expect(JSON.parse(parityCall![1].body)).toMatchObject({ runId: 'run-studio-123' });

    // 4. status notification verification
    const notifyCall = remote.mock.calls[remote.mock.calls.length - 1];
    expect(String(notifyCall[0])).toContain('/notifications/canva-status');
    expect(JSON.parse(notifyCall[1].body)).toMatchObject({
      status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW',
      designId: 'DA_studio_winner',
      runId: 'run-studio-123',
    });
  });

  it('reports DESIGN_FAILED when design studio returns failed status after ladder', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const studioInput = { ...input, designStudio: true };
    const replies = [
      { tenantId: 'tenant', clientId: 'client' }, // verify scope
      { runId: 'run-studio-fail', status: 'briefing' }, // canva-studio-start
      { runId: 'run-studio-fail', status: 'failed', diagnostic: 'RUNG_4_FALLBACK_FAILED', code: 'BUDGET_EXHAUSTED' }, // canva-studio-resume-0
      { ok: true }, // canva-notify-design_failed
    ];
    const remote = vi.fn(async () => Response.json(replies.shift()));
    const ctx = new DurableStepJournal();
    const result = await runCanvaDraft(studioInput, ctx, remote);

    expect(result.status).toBe('DESIGN_FAILED');
    const notifyCall = remote.mock.calls[remote.mock.calls.length - 1];
    expect(String(notifyCall[0])).toContain('/notifications/canva-status');
    expect(JSON.parse(notifyCall[1].body)).toMatchObject({
      status: 'DESIGN_FAILED',
      code: 'BUDGET_EXHAUSTED',
      runId: 'run-studio-fail',
    });
  });

  it('proves both studio path and legacy path reach CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');

    // Legacy path
    const legacyReplies = [
      { tenantId: 'tenant', clientId: 'client' },
      { status: 'retrieved', planId: 'plan-legacy', designId: 'DA_legacy' },
      { binding: { designId: 'DA_legacy', version: 1 } },
      { status: 'retrieved', artifact: { id: 'art1' } },
      { status: 'retrieved', artifact: { content_check: { copyPass: true, fontPass: true } } },
      { ok: true },
    ];
    const legacyRemote = vi.fn(async () => Response.json(legacyReplies.shift()));
    const legacyResult = await runCanvaDraft(input, new DurableStepJournal(), legacyRemote);
    expect(legacyResult.status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    expect(legacyRemote.mock.calls.some((c) => String(c[0]).includes('/canva/generate'))).toBe(true);
    expect(legacyRemote.mock.calls.some((c) => String(c[0]).includes('/canva/studio'))).toBe(false);

    // Studio v2 path
    const studioReplies = [
      { tenantId: 'tenant', clientId: 'client' },
      { runId: 'run-s1', status: 'transferred', planId: 'plan-s1', designId: 'DA_studio' },
      { binding: { designId: 'DA_studio', version: 1 } },
      { status: 'retrieved', artifact: { id: 'art2' } },
      { status: 'retrieved', artifact: { content_check: { copyPass: true, fontPass: true } } },
      { ok: true, parity: 'match' },
      { ok: true },
    ];
    const studioRemote = vi.fn(async () => Response.json(studioReplies.shift()));
    const studioResult = await runCanvaDraft({ ...input, designStudio: true }, new DurableStepJournal(), studioRemote);
    expect(studioResult.status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    expect(studioRemote.mock.calls.some((c) => String(c[0]).includes('/canva/studio'))).toBe(true);
    expect(studioRemote.mock.calls.some((c) => String(c[0]).includes('/canva/generate'))).toBe(false);
  });

  it('forwards designStudio and studioOptions through TaskWorkflowDispatcher', async () => {
    const remote = vi.fn(async () => Response.json({ invocationId: 'inv_studio_test', status: 'Accepted' }));
    vi.stubGlobal('fetch', remote);
    const dispatcher = new TaskWorkflowDispatcher({ restateIngressUrl: 'http://restate.test' });
    const receipt = await dispatcher.dispatch({
      aggregate_id: input.taskId,
      tenant_id: 'tenant',
      idempotency_key: 'studio-key',
      payload: {
        workflow: 'canva',
        autoGenerate: true,
        designStudio: true,
        studioOptions: { tier: 'quality', previews: 2 },
      },
    } as any);

    expect(receipt.receiptId).toBe('inv_studio_test');
    const sentBody = JSON.parse(remote.mock.calls[0][1].body);
    expect(sentBody.designStudio).toBe(true);
    expect(sentBody.studioOptions).toEqual({ tier: 'quality', previews: 2 });
  });
});


