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
    const remote=vi.fn(async()=>Response.json(replies.shift() ?? { ok: true })),ctx=new DurableStepJournal();
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
    const remote=vi.fn(async()=>Response.json(replies.shift() ?? { ok: true }));
    expect((await runCanvaDraft(input,new DurableStepJournal(),remote)).status).toBe('CANVA_FONT_MISMATCH');
    expect(remote.mock.calls.filter(c=>String(c[0]).endsWith('/canva/generate'))).toHaveLength(1);
    expect(remote.mock.calls[5][1].headers['Idempotency-Key']).toContain('-retry-1');
  });
  it('does not spend on the historical backlog without an explicit generation marker',async()=>{
    vi.stubEnv('HAWA_BEARER_TOKEN','test-only');
    const remote=vi.fn(async()=>Response.json({ok:true}));
    const result=await runCanvaDraft({...input,canvaAutoGenerate:false},new DurableStepJournal(),remote);
    expect(result.status).toBe('MANUAL_DESIGN_REQUIRED');
    expect(remote).toHaveBeenCalledTimes(1);
    expect(String(remote.mock.calls[0][0])).toContain('/notifications/canva-status');
    expect(JSON.parse(remote.mock.calls[0][1].body)).toMatchObject({status:'MANUAL_DESIGN_REQUIRED'});
  });
  it('stops a different client before model or Canva actions, and reports it instead of retrying forever',async()=>{
    vi.stubEnv('HAWA_BEARER_TOKEN','test-only');
    const replies=[{tenantId:'tenant',clientId:'OTHER'},{ok:true}];
    const remote=vi.fn(async()=>Response.json(replies.shift()));
    // It used to throw an ordinary error outside any step: Restate retried the invocation without
    // end and the requester was never told. It now ends the run with a reported outcome.
    const result=await runCanvaDraft(input,new DurableStepJournal(),remote);
    expect(result.status).toBe('DESIGN_BLOCKED');
    expect(remote).toHaveBeenCalledTimes(2);
    expect(remote.mock.calls.some(c=>/\/canva\/(generate|studio)/.test(String(c[0])))).toBe(false);
    expect(String(remote.mock.calls[1][0])).toContain('/notifications/canva-status');
    const body=JSON.parse(remote.mock.calls[1][1].body);
    expect(body).toMatchObject({status:'DESIGN_BLOCKED',code:'SCOPE_MISMATCH'});
    expect(body.detail).toMatch(/mismatch/);
  });
  it('never turns an uncertain generation into an approval or new request',async()=>{
    vi.stubEnv('HAWA_BEARER_TOKEN','test-only');const responses=[{tenantId:'tenant',clientId:'client'},{status:'uncertain',planId:'plan'}];
    const remote=vi.fn(async()=>Response.json(responses.shift() ?? { ok: true }));const result=await runCanvaDraft(input,new DurableStepJournal(),remote);
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
  it('reports DESIGN_SERVER_ERROR to requester when retry attempts are exhausted on persistent 5xx', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const responses = [
      Response.json({ tenantId: 'tenant', clientId: 'client' }),
      Response.json({ ok: true }),
    ];
    const remote = vi.fn(async () => responses.shift());
    const exhaustedContext = {
      run: vi.fn(async (name: string, action: () => Promise<any>) => {
        if (name === 'canva-create-draft') {
          const terminalErr = new Error('Canva workflow Core boundary HTTP 500 INTERNAL_SERVER_ERROR');
          terminalErr.name = 'TerminalError';
          throw terminalErr;
        }
        return action();
      }),
      sleep: vi.fn(),
    };
    const result = await runCanvaDraft(input, exhaustedContext, remote);
    expect(result.status).toBe('DESIGN_SERVER_ERROR');
    expect(remote.mock.calls.some(c => String(c[0]).includes('/notifications/canva-status'))).toBe(true);
    const notifyCall = remote.mock.calls.find(c => String(c[0]).includes('/notifications/canva-status'));
    expect(JSON.parse(notifyCall[1].body)).toMatchObject({
      status: 'DESIGN_SERVER_ERROR',
      code: 'INTERNAL_SERVER_ERROR',
    });
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
    const remote = vi.fn(async () => Response.json(replies.shift() ?? { ok: true }));
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
  it('reports a refusal to the requester even when Restate hands back only the journaled message', async () => {
    // Production, 2026-09-18: a step's failure comes back from Restate's journal as a new error that
    // carries only its message, so the CoreBoundaryError and the cause set on it are gone. The pilot's
    // copy and font check was refused (422) and the workflow ended as a failure: no message was sent.
    const journaled = {
      key: 'k',
      run: async <T,>(_name: string, action: () => Promise<T>): Promise<T> => {
        try {
          return await action();
        } catch (error: any) {
          const replayed = new Error(error?.message);
          replayed.name = 'TerminalError';
          throw replayed;
        }
      },
      sleep: async () => {},
    };
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const checkRefused = [
      Response.json({ tenantId: 'tenant', clientId: 'client' }),
      Response.json({ status: 'retrieved', planId: 'plan', designId: 'DA_test' }),
      Response.json({ binding: { designId: 'DA_test', version: 1 } }),
      Response.json({ status: 'retrieved', artifact: { id: 'art1' } }),
      Response.json({ title: 'SOURCE_REQUIRED' }, { status: 422 }),
      Response.json({ ok: true }),
    ];
    const remote = vi.fn(async () => checkRefused.shift()!);
    const result = await runCanvaDraft(input, journaled as any, remote);
    expect(result).toMatchObject({ status: 'CANVA_CHECK_REQUIRED', documentId: 'DA_test' });
    expect(JSON.parse((remote.mock.calls.at(-1) as any)[1].body)).toMatchObject({ status: 'CANVA_CHECK_REQUIRED', designId: 'DA_test' });

    // The refusal code survives too: the requester is told why.
    const generationRefused = [Response.json({ tenantId: 'tenant', clientId: 'client' }), Response.json({ title: 'COPY_UNSUPPORTED' }, { status: 422 }), Response.json({ ok: true })];
    const remote2 = vi.fn(async () => generationRefused.shift()!);
    expect((await runCanvaDraft(input, journaled as any, remote2)).status).toBe('DESIGN_REJECTED');
    expect(JSON.parse((remote2.mock.calls[2] as any)[1].body)).toMatchObject({ status: 'DESIGN_REJECTED', code: 'COPY_UNSUPPORTED' });
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
    expect(sentBody.requesterToldAtIntake).toBe(false);
  });

  it('dispatches a re-drive as its own Restate workflow, carrying the attempt', async () => {
    const remote = vi.fn(async () => Response.json({ invocationId: 'inv_redrive_test', status: 'Accepted' }));
    vi.stubGlobal('fetch', remote);
    const dispatcher = new TaskWorkflowDispatcher({ restateIngressUrl: 'http://restate.test' });
    const receipt = await dispatcher.dispatch({
      aggregate_id: input.taskId,
      tenant_id: 'tenant',
      idempotency_key: `redrive:${input.taskId}:2`,
      payload: { workflow: 'canva', autoGenerate: true, designStudio: true, clientId: 'client', redriveAttempt: 2 },
    } as any);
    // The first run's key would answer 409 ("reconciled") and nothing would run.
    expect(String(remote.mock.calls[0][0])).toBe(`http://restate.test/TaskWorkflow/task-wf-${input.taskId}-redrive-2/run/send`);
    expect(receipt.workflowId).toBe(`task-wf-${input.taskId}-redrive-2`);
    expect(JSON.parse(remote.mock.calls[0][1].body)).toMatchObject({ redriveAttempt: 2, designStudio: true, canvaAutoGenerate: true });
  });

  it('marks a dispatch without an automatic draft as already explained at intake', async () => {
    const remote = vi.fn(async () => Response.json({ invocationId: 'inv_manual_test', status: 'Accepted' }));
    vi.stubGlobal('fetch', remote);
    await new TaskWorkflowDispatcher({ restateIngressUrl: 'http://restate.test' }).dispatch({
      aggregate_id: input.taskId,
      tenant_id: 'tenant',
      idempotency_key: 'manual-key',
      payload: { workflow: 'canva', autoGenerateDeclined: 'SENDER_DAILY_CAP', sourcePlatform: 'telegram' },
    } as any);
    expect(JSON.parse(remote.mock.calls[0][1].body)).toMatchObject({ canvaAutoGenerate: false, requesterToldAtIntake: true });
  });

  it('ends a BINDING_MISMATCH as a reported outcome, without a design link, instead of retrying forever', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const studioInput = { ...input, designStudio: true };
    const replies = [
      { tenantId: 'tenant', clientId: 'client' }, // verify scope
      { runId: 'run-studio-bad', status: 'briefing' }, // canva-studio-start
      { runId: 'run-studio-bad', status: 'transferred', planId: 'plan-bad', designId: 'DA_imported' }, // canva-studio-resume-0
      { binding: { designId: 'DA_different', version: 1 } }, // canva-read-binding
      { ok: true }, // canva-notify-design_blocked
    ];
    const remote = vi.fn(async () => Response.json(replies.shift()));
    const ctx = new DurableStepJournal();

    const result = await runCanvaDraft(studioInput, ctx, remote);
    expect(result.status).toBe('DESIGN_BLOCKED');
    expect(remote.mock.calls.some((c) => String(c[0]).includes('/canva/exports'))).toBe(false);
    const notifyCall = remote.mock.calls[remote.mock.calls.length - 1];
    expect(String(notifyCall[0])).toContain('/notifications/canva-status');
    const body = JSON.parse(notifyCall[1].body);
    expect(body).toMatchObject({ status: 'DESIGN_BLOCKED', code: 'BINDING_MISMATCH', runId: 'run-studio-bad' });
    // Which design belongs to the task is what is in doubt, so no link is offered.
    expect(body.designId).toBeUndefined();
    expect(body.detail).toContain('DA_imported');
  });

  it('reports a failed studio run with a short code, and the diagnostic only as detail', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const diagnostic = 'Studio v3 failed: Winner failed hard QA: TEXT_OVERFLOW, LOGO_CLEARANCE';
    const replies = [
      { tenantId: 'tenant', clientId: 'client' },
      { runId: 'run-qa', status: 'briefing' },
      { runId: 'run-qa', status: 'failed', diagnostic },
      { ok: true },
    ];
    const remote = vi.fn(async () => Response.json(replies.shift()));
    const result = await runCanvaDraft({ ...input, designStudio: true }, new DurableStepJournal(), remote);
    expect(result.status).toBe('DESIGN_FAILED');
    const body = JSON.parse(remote.mock.calls[remote.mock.calls.length - 1][1].body);
    // The diagnostic used to be the code, which Core squashed and printed to the requester.
    expect(body.code).toBe('HARD_QA_REFUSED');
    expect(body.detail).toBe(diagnostic);
  });

  it('gives a re-drive its own idempotency keys, so Core starts a new studio run', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const replies = [
      { tenantId: 'tenant', clientId: 'client' },
      { runId: 'run-r2', status: 'failed', diagnostic: 'BUDGET_EXHAUSTED' },
      { ok: true },
    ];
    const remote = vi.fn(async () => Response.json(replies.shift()));
    await runCanvaDraft({ ...input, designStudio: true, redriveAttempt: 2 }, new DurableStepJournal(), remote);
    const start = remote.mock.calls.find((c) => String(c[0]).endsWith('/canva/studio'))!;
    expect(start[1].headers['Idempotency-Key']).toBe(`workflow-studio-${input.taskId}-redrive-2`);
  });

  it('passes parity: unavailable with parityError code to status notification when parity check fails', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const studioInput = { ...input, designStudio: true };
    const replies = [
      { tenantId: 'tenant', clientId: 'client' }, // verify scope
      { runId: 'run-studio-parity', status: 'briefing' }, // canva-studio-start
      { runId: 'run-studio-parity', status: 'transferred', planId: 'plan-1', designId: 'DA_parity' }, // canva-studio-resume-0
      { binding: { designId: 'DA_parity', version: 1 } }, // canva-read-binding
      { status: 'submitted', operationId: 'exp-1' }, // canva-submit-export
      { status: 'retrieved', artifact: { id: 'art-1' } }, // canva-poll-export-0
      { status: 'submitted', operationId: 'chk-1' }, // canva-submit-qc
      { status: 'retrieved', artifact: { content_check: { copyPass: true, fontPass: true } } }, // canva-poll-qc-0
      new Response(JSON.stringify({ error: 'PARITY_IMAGE_TOO_LARGE' }), { status: 500 }), // canva-parity-check fails
      { ok: true }, // canva-notify-canva_draft_ready_for_visual_review
    ];
    const remote = vi.fn(async () => {
      const rep = replies.shift();
      return rep instanceof Response ? rep : Response.json(rep);
    });
    const ctx = new DurableStepJournal();
    const result = await runCanvaDraft(studioInput, ctx, remote);

    expect(result.status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    const notifyCall = remote.mock.calls[remote.mock.calls.length - 1];
    expect(String(notifyCall[0])).toContain('/notifications/canva-status');
    const body = JSON.parse(notifyCall[1].body);
    expect(body.parity).toBe('unavailable');
    expect(body.parityError).toBe('PARITY_IMAGE_TOO_LARGE');
  });

  it('proves terminal notification transient 503 throws and replaying after Core recovery does not re-run design generation', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const replies = [
      { tenantId: 'tenant', clientId: 'client' }, // scope check
      { status: 'submitted', planId: 'plan-1' }, // canva-design-plan
      { status: 'retrieved', planId: 'plan-1', designId: 'DA_test' }, // canva-poll-draft
      { binding: { designId: 'DA_test', version: 1 } }, // canva-read-binding
      { status: 'submitted', operationId: 'exp-1' }, // canva-submit-export
      { status: 'retrieved', artifact: { id: 'art-1' } }, // canva-poll-export-0
      { status: 'submitted', operationId: 'chk-1' }, // canva-submit-qc
      { status: 'retrieved', artifact: { content_check: { copyPass: true, fontPass: true } } }, // canva-poll-qc-0
      new Response('Synthetic Core 503 during notification', { status: 503 }), // canva-notify-canva_draft_ready_for_visual_review fails
    ];
    const remote = vi.fn(async () => {
      const rep = replies.shift();
      return rep instanceof Response ? rep : Response.json(rep);
    });
    const ctx = new DurableStepJournal();

    // First attempt: should throw CoreBoundaryError(503) during notification
    await expect(runCanvaDraft(input, ctx, remote)).rejects.toThrow('HTTP 503');

    // Verify all design generation steps were committed to journal
    expect(ctx.hasStep('canva-create-draft')).toBe(true);
    expect(ctx.hasStep('canva-read-binding')).toBe(true);
    expect(ctx.hasStep('canva-notify-canva_draft_ready_for_visual_review')).toBe(false);

    // Replay after Core recovery: only terminal notification should be called
    const replayRemote = vi.fn(async () => Response.json({ ok: true, notificationSent: true }));
    const result = await runCanvaDraft(input, ctx, replayRemote);

    expect(result.status).toBe('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW');
    // Replay made exactly 1 call: to notifications/canva-status
    expect(replayRemote).toHaveBeenCalledTimes(1);
    expect(String(replayRemote.mock.calls[0][0])).toContain('/notifications/canva-status');
    // Journal now records notification completed
    expect(ctx.hasStep('canva-notify-canva_draft_ready_for_visual_review')).toBe(true);
  });
});


