import { describe, it, expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { isModelCallHoldError } from '../src/services/design-studio/types.js';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';

/**
 * Bug hunt 2026-09-24. The studio's ledger wrapper (createStageContext) records every failed model
 * call at usdEstimate 0 and never adds it to the run's budget. A reply cut off at the token cap
 * (finish_reason 'length') or one that is not JSON was answered and billed by OpenAI; the client's
 * OpenAiModelTruncatedError / OpenAiModelParseError carry that cost (`costUsd`), and the wrapper drops
 * it. The run's spentUsd, the per-run cap and the Desk's "totalUsdEstimate" all miss that money.
 * No database: the repository is replaced by a recorder.
 */
describe('HUNT: studio ledger records billed failures at $0', () => {
  it('a truncated (billed) reply is recorded with its cost and counted in the budget', async () => {
    const usage = { prompt_tokens: 20000, completion_tokens: 4000 };
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: 'chatcmpl_cut',
        model: 'gpt-6-astra',
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"layout": {"version": 2, "wid' } }],
        usage,
      }),
    });
    const svc = new DesignStudioService({} as any, undefined, { fetcher: fetcher as any, apiKey: 'test-key' });
    const finalized: any[] = [];
    (svc as any).repo = {
      recordCallStart: async () => undefined,
      finalizeCall: async (p: any) => { finalized.push(p); },
      updateRunStatus: async () => undefined,
    };
    const budget = { maxUsd: 2, maxCalls: 24, spentUsd: 0, calls: 0 };
    const spent: number[] = [];
    const clientId = 'c1000000-0000-4000-8000-000000000002';
    const s = { tenantId: randomUUID(), actorId: randomUUID(), role: 'operator' };
    const { reference, logo } = await resolveClientDesignReference({} as any, s, clientId);
    const run = {
      id: randomUUID(),
      task_id: randomUUID(),
      client_id: clientId,
      tier: 'premium',
      request: JSON.stringify({ width: 1080, height: 1350, copyBlocks: [{ text: 'A', script: 'latin' }], instructions: 'x',
        clientId, referenceHash: createHash('sha256').update(JSON.stringify(reference)).digest('hex'),
        logoSha256: createHash('sha256').update(logo).digest('hex') }),
      stages: {},
    };
    const ctx = await (svc as any).createStageContext(
      s,
      run,
      'laying_out',
      budget,
      async (cost: number) => { spent.push(cost); budget.spentUsd += cost; }
    );

    const err: any = await ctx.client.completeJson({ prompt: 'lay it out '.repeat(2000), schema: { type: 'object' }, model: 'gpt-6-astra' }).catch((e: any) => e);
    expect(err?.name).toBe('OpenAiModelTruncatedError');
    // The client knows what the call cost.
    expect(err.costUsd).toBeGreaterThan(0);
    // The ledger row and the run's budget should carry that cost. Today: usdEstimate 0, spentUsd 0.
    expect({ ledgerUsd: finalized[0]?.usdEstimate, spentUsd: budget.spentUsd }).toEqual({ ledgerUsd: err.costUsd, spentUsd: err.costUsd });
  });

  it('records a lost model response as uncertain and keeps the attempt visible', async () => {
    const fetcher = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET', message: 'socket hang up' },
    }));
    const svc = new DesignStudioService({} as any, undefined, { fetcher: fetcher as any, apiKey: 'test-key' });
    const finalized: any[] = [];
    (svc as any).repo = {
      recordCallStart: async () => undefined,
      finalizeCall: async (p: any) => { finalized.push(p); },
      updateRunStatus: async () => undefined,
    };
    const budget = { maxUsd: 2, maxCalls: 24, spentUsd: 0, calls: 0 };
    const clientId = 'c1000000-0000-4000-8000-000000000002';
    const s = { tenantId: randomUUID(), actorId: randomUUID(), role: 'operator' };
    const { reference, logo } = await resolveClientDesignReference({} as any, s, clientId);
    const run = { id: randomUUID(), task_id: randomUUID(), client_id: clientId, tier: 'premium',
      request: JSON.stringify({ width: 1080, height: 1350, copyBlocks: [{ text: 'A', script: 'latin' }], instructions: 'x',
        clientId, referenceHash: createHash('sha256').update(JSON.stringify(reference)).digest('hex'),
        logoSha256: createHash('sha256').update(logo).digest('hex') }), stages: {} };
    const ctx = await (svc as any).createStageContext(s, run, 'laying_out', budget, async () => {});
    await expect(ctx.client.completeJson({ prompt: 'lay it out', schema: { type: 'object' }, model: 'gpt-6-astra' }))
      .rejects.toMatchObject({ code: 'UNCERTAIN_ACCEPTANCE', isUncertain: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(budget.calls).toBe(1);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({ status: 'uncertain', errorCode: 'UNCERTAIN_ACCEPTANCE' });
  });

  it('does not rewrite a paid success as a free error when saving the run budget fails', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({ id: 'chatcmpl_paid', model: 'gpt-6-astra',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100 } }),
    });
    const svc = new DesignStudioService({} as any, undefined, { fetcher: fetcher as any, apiKey: 'test-key' });
    const finalized: any[] = [];
    (svc as any).repo = {
      recordCallStart: async () => undefined,
      finalizeCall: async (p: any) => { finalized.push(p); },
      updateRunStatus: async () => undefined,
    };
    const clientId = 'c1000000-0000-4000-8000-000000000002';
    const s = { tenantId: randomUUID(), actorId: randomUUID(), role: 'operator' };
    const { reference, logo } = await resolveClientDesignReference({} as any, s, clientId);
    const run = { id: randomUUID(), task_id: randomUUID(), client_id: clientId, tier: 'premium',
      request: JSON.stringify({ width: 1080, height: 1350, copyBlocks: [{ text: 'A', script: 'latin' }], instructions: 'x',
        clientId, referenceHash: createHash('sha256').update(JSON.stringify(reference)).digest('hex'),
        logoSha256: createHash('sha256').update(logo).digest('hex') }), stages: {} };
    const budget = { maxUsd: 2, maxCalls: 24, spentUsd: 0, calls: 0 };
    const ctx = await (svc as any).createStageContext(s, run, 'laying_out', budget,
      async () => { throw new Error('budget write failed'); });
    await expect(ctx.client.completeJson({ prompt: 'paid call', schema: { type: 'object' }, model: 'gpt-6-astra' }))
      .rejects.toMatchObject({ code: 'MODEL_CALL_ACCOUNTING_FAILED', cause: { message: 'budget write failed' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({ status: 'ok', responseId: 'chatcmpl_paid' });
    expect(finalized[0].usdEstimate).toBeGreaterThan(0);
  });

  it('holds a provider reply when its ledger outcome conflicts instead of spending again', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(),
      json: async () => ({ id: 'chatcmpl_conflict', model: 'gpt-6-astra',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 } }) });
    const svc = new DesignStudioService({} as any, undefined, { fetcher: fetcher as any, apiKey: 'test-key' });
    const finalizations: any[] = [];
    (svc as any).repo = {
      recordCallStart: async () => undefined,
      finalizeCall: async (value: any) => {
        finalizations.push(value);
        throw Object.assign(new Error('receipt already finalized'), { code: 'MODEL_CALL_FINALIZATION_CONFLICT' });
      },
    };
    const clientId = 'c1000000-0000-4000-8000-000000000002';
    const s = { tenantId: randomUUID(), actorId: randomUUID(), role: 'operator' };
    const { reference, logo } = await resolveClientDesignReference({} as any, s, clientId);
    const run = { id: randomUUID(), task_id: randomUUID(), client_id: clientId, tier: 'premium',
      request: JSON.stringify({ width: 1080, height: 1350, copyBlocks: [{ text: 'A', script: 'latin' }], instructions: 'x',
        clientId, referenceHash: createHash('sha256').update(JSON.stringify(reference)).digest('hex'),
        logoSha256: createHash('sha256').update(logo).digest('hex') }), stages: {} };
    const ctx = await (svc as any).createStageContext(s, run, 'briefing',
      { maxUsd: 2, maxCalls: 24, spentUsd: 0, calls: 0 }, async () => { throw new Error('spent after conflict'); });
    const error = await ctx.client.completeJson({ prompt: 'one paid call', schema: { type: 'object' }, model: 'gpt-6-astra' })
      .catch((err: unknown) => err);
    expect(isModelCallHoldError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'MODEL_CALL_FINALIZATION_CONFLICT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(finalizations).toHaveLength(1);
    expect(finalizations[0].status).toBe('ok');
  });

  it('does not dispatch a second model request when the logical call reservation collides', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(),
      json: async () => ({ id: 'chatcmpl_once', model: 'gpt-6-astra',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 } }) });
    const clientId = 'c1000000-0000-4000-8000-000000000002';
    const s = { tenantId: randomUUID(), actorId: randomUUID(), role: 'operator' };
    const { reference, logo } = await resolveClientDesignReference({} as any, s, clientId);
    const run = { id: randomUUID(), task_id: randomUUID(), client_id: clientId, tier: 'premium',
      request: JSON.stringify({ width: 1080, height: 1350, copyBlocks: [{ text: 'A', script: 'latin' }], instructions: 'x',
        clientId, referenceHash: createHash('sha256').update(JSON.stringify(reference)).digest('hex'),
        logoSha256: createHash('sha256').update(logo).digest('hex') }), stages: {} };
    const admitted: any[] = [];
    const repo = {
      recordCallStart: async (p: any) => {
        admitted.push(p);
        if (admitted.length > 1) throw Object.assign(new Error('already admitted'), { code: 'MODEL_CALL_ADMISSION_CONFLICT' });
      },
      finalizeCall: async () => undefined,
      updateRunStatus: async () => undefined,
    };
    const makeContext = async () => {
      const svc = new DesignStudioService({} as any, undefined, { fetcher: fetcher as any, apiKey: 'test-key' });
      (svc as any).repo = repo;
      return (svc as any).createStageContext(s, run, 'laying_out',
        { maxUsd: 2, maxCalls: 24, spentUsd: 0, calls: 0 }, async () => {});
    };
    const [first, second] = await Promise.all([makeContext(), makeContext()]);
    const request = { prompt: 'same paid work', schema: { type: 'object' }, model: 'gpt-6-astra' };
    const reordered = { model: 'gpt-6-astra', schema: { type: 'object' }, prompt: 'same paid work' };
    const results = await Promise.allSettled([first.client.completeJson(request), second.client.completeJson(reordered)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(admitted).toHaveLength(2);
    expect(admitted[0].callOrdinal).toBe(1);
    expect(admitted[0].logicalCallSha256).toBe(admitted[1].logicalCallSha256);
  });

  it('refuses to resume a run with an unresolved model call', async () => {
    const svc = new DesignStudioService({} as any);
    const s = { tenantId: randomUUID(), actorId: randomUUID(), role: 'operator' };
    const taskId = randomUUID();
    const runId = randomUUID();
    (svc as any).repo = {
      getRunById: async () => ({ id: runId, task_id: taskId, actor_id: s.actorId, status: 'laying_out' }),
      getCallsForRun: async () => [{ id: randomUUID(), stage: 'laying_out', status: 'uncertain' }],
    };
    // Task admission (ADR-113) has its own PostgreSQL tests; this unit isolates the ledger hold.
    (svc as any).assertTaskCanGenerate = async () => {};
    await expect(svc.resume(s, taskId, runId)).rejects.toMatchObject({ code: 'MODEL_CALL_UNCERTAIN' });
  });

  it('refuses to repay a completed call after a crash before the stage result was saved', async () => {
    const svc = new DesignStudioService({} as any);
    const s = { tenantId: randomUUID(), actorId: randomUUID(), role: 'operator' };
    const taskId = randomUUID();
    const runId = randomUUID();
    (svc as any).repo = {
      getRunById: async () => ({ id: runId, task_id: taskId, actor_id: s.actorId, status: 'laying_out' }),
      getCallsForRun: async () => [{ id: randomUUID(), stage: 'art', status: 'ok', usd_estimate: '0.04' }],
    };
    (svc as any).assertTaskCanGenerate = async () => {};
    await expect(svc.resume(s, taskId, runId)).rejects.toMatchObject({ code: 'MODEL_STAGE_REPLAY_UNSAFE' });
  });
});
