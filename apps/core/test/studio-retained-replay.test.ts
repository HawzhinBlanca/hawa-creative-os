import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { NEUTRAL_STYLE_SPEC, renderMotifPng } from '@hawa/creative';
import { createDb, sql, withRlsContext, DesignStudioRepository } from '@hawa/db';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';
import type { StageContext } from '../src/services/design-studio/types.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const brief = { occasion: 'Launch', audience: 'Officials', formality: 5, toneWords: ['Formal', 'National', 'Clear'],
  readingOrder: [0], roles: [{ copyIndex: 0, role: 'title', importance: 5 }], must: [], mustNot: [],
  imageryStrategy: 'none', imageryRationale: '', kurdishLeads: false, riskFlags: [], requestedBackground: '',
  imageRoles: [], referenceRole: 'none', referenceNotes: '', styleSpec: NEUTRAL_STYLE_SPEC };
const response = (data: unknown) => new Response(JSON.stringify({ id: 'synthetic-retained-response', model: 'gpt-6-astra',
  usage: { prompt_tokens: 1000, completion_tokens: 200 },
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }));
type Scope = { tenantId: string; actorId: string; role: 'operator' };
type Budget = { maxUsd: number; maxCalls: number; spentUsd: number; calls: number };
type ContextHarness = { createStageContext(s: Scope, run: Record<string, unknown>, stage: string,
  budget: Budget, update: (cost: number) => Promise<void>, calls: Awaited<ReturnType<DesignStudioRepository['getCallsForRun']>>): Promise<StageContext> };

describe.skipIf(!url)('retained paid replies recover across service instances', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const repo = new DesignStudioRepository(db);
  const scope: Scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '', role: 'operator' };
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  let taskId: string, runId: string, request: Record<string, unknown>;
  beforeEach(async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    scope.actorId = randomUUID(); taskId = randomUUID(); runId = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${scope.actorId}::uuid,${scope.actorId+'@example.test'},'Replay operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${scope.tenantId}::uuid,${scope.actorId}::uuid,'operator')`.execute(db);
    await withRlsContext(db, { tenantId: scope.tenantId, userId: scope.actorId }, async tx => {
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${scope.tenantId}::uuid,'replay-kaae','Synthetic KAAE') ON CONFLICT(id) DO NOTHING`.execute(tx);
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${scope.tenantId}::uuid,${clientId}::uuid,'Replay task')`.execute(tx);
    });
    const { reference, logo } = await resolveClientDesignReference(db, scope, clientId);
    request = { clientId, width: 1080, height: 1350, instructions: 'A clear institutional announcement',
      copyBlocks: [{ text: 'Synthetic exact title', script: 'latin' }], referenceHash: sha(JSON.stringify(reference)), logoSha256: sha(logo) };
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => db.destroy());
  async function create(maxCalls = 1) {
    await repo.createRun({ id: runId, taskId, tenantId: scope.tenantId, clientId, actorId: scope.actorId,
      requestKey: runId, requestHash: sha(JSON.stringify(request)), request, tier: 'premium',
      budget: { maxUsd: 2, maxCalls, spentUsd: 0, calls: 0 } });
  }
  async function interrupted(legacyEmptyStages = false) {
    await create();
    if (legacyEmptyStages) await sql`UPDATE hawa.design_studio_runs SET stages='[]'::jsonb WHERE id=${runId}::uuid`.execute(db);
    const fetcher = vi.fn<typeof fetch>(async () => response(brief));
    const service = new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' });
    const brokenRepo = new DesignStudioRepository(db);
    const update = brokenRepo.updateRunStatus.bind(brokenRepo);
    let fail = true;
    vi.spyOn(brokenRepo, 'updateRunStatus').mockImplementation(async (...args) => {
      if (fail && args[2] === 'briefing' && args[3]?.budget && !args[3]?.stages) {
        fail = false; throw new Error('Synthetic crash after retained receipt, before budget/stage snapshot');
      }
      return update(...args);
    });
    Object.assign(service, { repo: brokenRepo });
    await expect(service.resume(scope, taskId, runId)).rejects.toMatchObject({ code: 'MODEL_CALL_ACCOUNTING_FAILED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await repo.getCallsForRun(runId, scope.tenantId)).toMatchObject([{ status: 'ok', has_retained_result: true }]);
    return fetcher;
  }

  it.each([false, true])('recovers a paid brief at the call cap without repeated charge (legacy empty stages: %s)', async (legacyEmptyStages) => {
    await interrupted(legacyEmptyStages);
    const before = await repo.getBudgetUsage(runId, scope.tenantId, scope.actorId);
    expect(before).toMatchObject({ admittedCalls: 1, blocker: 'BUDGET_EXHAUSTED' });
    const runtimeUrl = new URL(url!);
    runtimeUrl.searchParams.set('options', '-c role=hawa_app');
    const peer = createDb(runtimeUrl.toString());
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('No second transport is authorized'); });
    try {
      const result = await new DesignStudioService(peer, undefined, { fetcher, apiKey: 'synthetic-key' }).resume(scope, taskId, runId);
      expect(result.status).toBe('conceiving');
      expect(fetcher).not.toHaveBeenCalled();
      const recovered = await new DesignStudioRepository(peer).getRunById(runId, scope.tenantId);
      expect(recovered?.stages).toMatchObject({ brief: { occasion: brief.occasion, roles: brief.roles } });
      expect(recovered?.budget).toMatchObject({ calls: 1, spentUsd: before?.accountedUsd });
      expect(await repo.getBudgetUsage(runId, scope.tenantId, scope.actorId)).toEqual(before);
    } finally { await peer.destroy(); }
  });

  it('holds a changed prompt instead of returning a stale answer or dispatching again', async () => {
    await interrupted();
    // Inject a changed derivation without altering the immutable run request.
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected transport'); });
    const service = new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' });
    Object.assign(service, { withClientRules: async (_scope: Scope, ctx: StageContext) => ({ ...ctx, instructions: 'Changed request' }) });
    await expect(service.resume(scope, taskId, runId)).rejects.toMatchObject({ code: 'MODEL_STAGE_REPLAY_UNSAFE' });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await repo.getRunById(runId, scope.tenantId))?.status).toBe('briefing');
    expect(await repo.getCallsForRun(runId, scope.tenantId)).toHaveLength(1);
  });

  it('rechecks task cancellation before consuming retained results', async () => {
    await interrupted();
    await sql`UPDATE hawa.tasks SET state='cancelled' WHERE id=${taskId}::uuid`.execute(db);
    const fetcher = vi.fn<typeof fetch>();
    const service = new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' });
    await expect(service.resume(scope, taskId, runId)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await repo.getRunById(runId, scope.tenantId))?.status).toBe('briefing');
  });

  it('holds legacy successes that have no retained response', async () => {
    await create();
    const id = randomUUID();
    await repo.recordCallStart({ id, runId, tenantId: scope.tenantId, actorId: scope.actorId, stage: 'briefing', provider: 'openai',
      model: 'synthetic', requestedModel: 'synthetic', callOrdinal: 1, logicalCallSha256: sha(id),
      reservation: { version: 1, policy: 'synthetic-test', requestSha256: sha(id), usd: .5, inputTokens: 100, outputTokens: 100 } });
    await repo.finalizeCall({ id, tenantId: scope.tenantId, inputTokens: 1, outputTokens: 1, usdEstimate: .01, status: 'ok' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' }).resume(scope, taskId, runId))
      .rejects.toMatchObject({ code: 'MODEL_STAGE_REPLAY_UNSAFE' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])('recovers art without repeating generation (interrupted before vision: %s)', async (beforeVision) => {
    await create(2);
    await repo.updateRunStatus(runId, scope.tenantId, 'laying_out');
    const bytes = renderMotifPng('gradient-wash', { width: 16, height: 16, palette: ['#1E3A5F'], seed: 1 });
    const fetcher = vi.fn<typeof fetch>(async url => String(url).includes('/images/')
      ? new Response(JSON.stringify({ model: 'gpt-image-2.5-sunburst', data: [{ b64_json: bytes.toString('base64') }],
          usage: { input_tokens: 400, output_tokens: 1000, input_tokens_details: { text_tokens: 400, image_tokens: 0 } } }))
      : response({ containsForbidden: false, what: 'Synthetic verdict' }));
    const run = (await repo.getRunById(runId, scope.tenantId))!;
    const budget: Budget = { maxUsd: 2, maxCalls: 2, spentUsd: 0, calls: 0 };
    const artRequest = { artPrompt: 'Navy paper shapes', palette: ['#1E3A5F'], width: 16, height: 16 };
    const first = await (new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' }) as unknown as ContextHarness)
      .createStageContext(scope, run, 'laying_out', budget, async cost => {
        budget.spentUsd += cost;
        if (beforeVision) throw new Error('Synthetic interruption before vision');
      }, []);
    const original = beforeVision ? undefined : await first.artProvider!.generateArt(artRequest);
    if (beforeVision) await expect(first.artProvider!.generateArt(artRequest)).rejects.toMatchObject({ code: 'MODEL_CALL_ACCOUNTING_FAILED' });
    expect(fetcher).toHaveBeenCalledTimes(beforeVision ? 1 : 2);
    const spend = budget.spentUsd;
    const calls = await repo.getCallsForRun(runId, scope.tenantId);
    expect(calls).toMatchObject(beforeVision ? [{ stage: 'art', has_retained_result: true }]
      : [{ stage: 'art', has_retained_result: true }, { stage: 'laying_out', has_retained_result: true }]);
    const peer = createDb(url!);
    const noTransport = vi.fn<typeof fetch>(async url => {
      if (!beforeVision || String(url).includes('/images/')) throw new Error('Unexpected replay transport');
      return response({ containsForbidden: false, what: 'Synthetic verdict' });
    });
    const noSpend = vi.fn(async (cost: number) => { budget.spentUsd += cost; });
    try {
      const second = await (new DesignStudioService(peer, undefined, { fetcher: noTransport, apiKey: 'synthetic-key' }) as unknown as ContextHarness)
        .createStageContext(scope, run, 'laying_out', budget, noSpend, calls);
      const recovered = await second.artProvider!.generateArt(artRequest);
      if (original) expect(recovered).toEqual(original);
      expect(noTransport).toHaveBeenCalledTimes(beforeVision ? 1 : 0);
      expect(noSpend).toHaveBeenCalledTimes(beforeVision ? 1 : 0);
      expect(budget.spentUsd).toBeCloseTo(spend + (beforeVision ? .02 : 0), 6);
      expect(await repo.getCallsForRun(runId, scope.tenantId)).toHaveLength(2);
    } finally { await peer.destroy(); }
  });

  it('retains Sol image counts in admission and recovers the answer without any provider transport', async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'dev');
    await create();
    await repo.updateRunStatus(runId, scope.tenantId, 'laying_out');
    const run = (await repo.getRunById(runId, scope.tenantId))!;
    const png = renderMotifPng('gradient-wash', { width: 16, height: 16, palette: ['#1E3A5F'], seed: 1 });
    const params = { model: 'gpt-6.1-sol', maxTokens: 1000,
      messages: [{ role: 'user' as const, content: [{ type: 'image_url' as const,
        image_url: { url: `data:image/png;base64,${png.toString('base64')}`, detail: 'high' as const } }] }],
      jsonSchema: { name: 'test', schema: { type: 'object' } } };
    const fetcher = vi.fn<typeof fetch>(async transport => String(transport).endsWith('/responses/input_tokens')
      ? new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 100 }))
      : new Response(JSON.stringify({ id: 'synthetic-sol', model: 'gpt-6.1-sol',
        usage: { prompt_tokens: 120, completion_tokens: 20 },
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] })));
    const budget: Budget = { maxUsd: 2, maxCalls: 1, spentUsd: 0, calls: 0 };
    const first = await (new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' }) as unknown as ContextHarness)
      .createStageContext(scope, run, 'laying_out', budget, async cost => { budget.spentUsd += cost; }, []);
    const original = await first.client.createStructuredCompletion(params);
    const calls = await repo.getCallsForRun(runId, scope.tenantId);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(calls).toMatchObject([{ status: 'ok', has_retained_result: true,
      reservation: { policy: 'studio-sol61-2026-09-30-v2-counted-images',
        nativeInputCount: { model: 'gpt-6.1-sol', inputTokens: 100, object: 'response.input_tokens' } } }]);
    const noTransport = vi.fn<typeof fetch>(async () => { throw new Error('No replay transport permitted'); });
    const noSpend = vi.fn(async (_cost: number) => {});
    const second = await (new DesignStudioService(db, undefined, { fetcher: noTransport, apiKey: 'synthetic-key' }) as unknown as ContextHarness)
      .createStageContext(scope, run, 'laying_out', budget, noSpend, calls);
    expect(await second.client.createStructuredCompletion(params)).toEqual(original);
    expect(noTransport).not.toHaveBeenCalled(); expect(noSpend).not.toHaveBeenCalled();
    expect(await repo.getCallsForRun(runId, scope.tenantId)).toHaveLength(1);
  });

  it('admits no paid call when Sol input counting fails', async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'dev'); await create();
    await repo.updateRunStatus(runId, scope.tenantId, 'laying_out');
    const run = (await repo.getRunById(runId, scope.tenantId))!;
    const fetcher = vi.fn<typeof fetch>(async () => new Response('Unavailable', { status: 503 }));
    const spend = vi.fn(async (_cost: number) => {});
    const ctx = await (new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' }) as unknown as ContextHarness)
      .createStageContext(scope, run, 'laying_out', { maxUsd: 2, maxCalls: 1, spentUsd: 0, calls: 0 }, spend, []);
    await expect(ctx.client.createStructuredCompletion({ model: 'gpt-6.1-sol', maxTokens: 1000,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] }],
      jsonSchema: { name: 'test', schema: { type: 'object' } } })).rejects.toMatchObject({ code: 'STUDIO_BUDGET_UNQUOTABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(spend).not.toHaveBeenCalled();
    expect(await repo.getCallsForRun(runId, scope.tenantId)).toHaveLength(0);
  });
});
