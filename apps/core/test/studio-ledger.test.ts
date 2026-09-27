import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';

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
    const run = {
      id: randomUUID(),
      task_id: randomUUID(),
      // Runs exist only for a client with a verified reference pack (ADR-038): KAAE's.
      client_id: 'c1000000-0000-4000-8000-000000000002',
      tier: 'premium',
      request: JSON.stringify({ width: 1080, height: 1350, copyBlocks: [{ text: 'A', script: 'latin' }], instructions: 'x' }),
      stages: {},
    };
    const ctx = (svc as any).createStageContext(
      { tenantId: randomUUID(), actorId: randomUUID(), role: 'operator' },
      run,
      'laying_out',
      budget,
      async (cost: number) => { spent.push(cost); budget.spentUsd += cost; }
    );

    const err: any = await ctx.client.completeJson({ prompt: 'lay it out', schema: { type: 'object' }, model: 'gpt-6-astra' }).catch((e: any) => e);
    expect(err?.name).toBe('OpenAiModelTruncatedError');
    // The client knows what the call cost.
    expect(err.costUsd).toBeGreaterThan(0);
    // The ledger row and the run's budget should carry that cost. Today: usdEstimate 0, spentUsd 0.
    expect({ ledgerUsd: finalized[0]?.usdEstimate, spentUsd: budget.spentUsd }).toEqual({ ledgerUsd: err.costUsd, spentUsd: err.costUsd });
  });
});
