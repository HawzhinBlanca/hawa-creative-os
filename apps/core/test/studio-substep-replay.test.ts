import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { NEUTRAL_STYLE_SPEC, renderMotifPng } from '@hawa/creative';
import { createDb, sql, withRlsContext, DesignStudioRepository, type DesignStudioStatus } from '@hawa/db';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { inStudioSubstep } from '../src/services/design-studio/substeps.js';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';
import type { StageContext } from '../src/services/design-studio/types.js';

// ADR-122: retained work is consumed by semantic substep and attempt, not by the run's
// global call order. Every provider transport here is synthetic; no paid call is made.
const url = process.env.HAWA_ISOLATED_TEST_DB;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const brief = { occasion: 'Launch', audience: 'Officials', formality: 5, toneWords: ['Formal', 'National', 'Clear'],
  readingOrder: [0], roles: [{ copyIndex: 0, role: 'title', importance: 5 }], must: [], mustNot: [],
  imageryStrategy: 'none', imageryRationale: '', kurdishLeads: false, riskFlags: [], requestedBackground: '',
  imageRoles: [], referenceRole: 'none', referenceNotes: '', styleSpec: NEUTRAL_STYLE_SPEC };
const completion = (data: unknown) => new Response(JSON.stringify({ id: `synthetic-${randomUUID()}`, model: 'gpt-6-astra',
  usage: { prompt_tokens: 1000, completion_tokens: 200 },
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }));
const schemaOf = (init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  return String(body.response_format?.json_schema?.name ?? body.text?.format?.name ?? '');
};
type Scope = { tenantId: string; actorId: string; role: 'operator' };
type Budget = { maxUsd: number; maxCalls: number; spentUsd: number; calls: number };
type Calls = Awaited<ReturnType<DesignStudioRepository['getCallsForRun']>>;
type ContextHarness = { createStageContext(s: Scope, run: Record<string, unknown>, stage: string,
  budget: Budget, update: (cost: number) => Promise<void>, calls: Calls): Promise<StageContext> };
const harness = (service: DesignStudioService) => service as unknown as ContextHarness;
const ARCHETYPES = ['editorial-centered', 'asymmetric-grid', 'typographic-poster', 'framed-invitation', 'split-band'];

describe.skipIf(!url)('semantic Studio substeps recover retained work across branches and failed attempts', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const repo = new DesignStudioRepository(db);
  const scope: Scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '', role: 'operator' };
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  let taskId: string, runId: string, request: Record<string, unknown>, palette: string[];
  beforeEach(async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    scope.actorId = randomUUID(); taskId = randomUUID(); runId = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${scope.actorId}::uuid,${scope.actorId+'@example.test'},'Substep operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${scope.tenantId}::uuid,${scope.actorId}::uuid,'operator')`.execute(db);
    await withRlsContext(db, { tenantId: scope.tenantId, userId: scope.actorId }, async tx => {
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${scope.tenantId}::uuid,'replay-kaae','Synthetic KAAE') ON CONFLICT(id) DO NOTHING`.execute(tx);
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${scope.tenantId}::uuid,${clientId}::uuid,'Substep task')`.execute(tx);
    });
    const { reference, logo } = await resolveClientDesignReference(db, scope, clientId);
    palette = (reference.rules as { palette: string[] }).palette;
    request = { clientId, width: 1080, height: 1350, instructions: 'A clear institutional announcement',
      copyBlocks: [{ text: 'Synthetic exact title', script: 'latin' }], referenceHash: sha(JSON.stringify(reference)), logoSha256: sha(logo) };
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  afterAll(() => db.destroy());

  async function create(maxCalls: number, status?: DesignStudioStatus, stages?: Record<string, unknown>) {
    await repo.createRun({ id: runId, taskId, tenantId: scope.tenantId, clientId, actorId: scope.actorId,
      requestKey: runId, requestHash: sha(JSON.stringify(request)), request, tier: 'premium',
      budget: { maxUsd: 5, maxCalls, spentUsd: 0, calls: 0 } });
    if (status) await repo.updateRunStatus(runId, scope.tenantId, status, stages ? { stages } : undefined);
  }
  const concepts = () => ({ concepts: ARCHETYPES.map((archetype, i) => ({ id: `c${i + 1}`, name: `Concept ${i + 1}`, archetype,
    artStrategy: 'none', typographicScale: { ratio: 1.25, titleSize: 96, bodySize: 32 },
    colourRoles: { background: palette[0], title: palette[1] ?? palette[0], body: palette[1] ?? palette[0], accent: palette[0], rule: palette[0] },
    layoutIdea: `Idea ${i + 1}`, whyDifferent: `Different ${i + 1}` })) });
  const photo = (seed: number) => `data:image/png;base64,${renderMotifPng('gradient-wash', { width: 24, height: 24, palette: ['#1E3A5F', '#C9A227'], seed }).toString('base64')}`;
  const rebriefed = { ...brief, imageRoles: [{ index: 0, role: 'content_photo', notes: 'Speaker' }, { index: 1, role: 'content_photo', notes: 'Hall' }] };

  /** Original run: an images rebrief persists, then the concept board is retained and the budget snapshot fails. */
  async function interruptedAfterRebrief() {
    await create(6, 'conceiving', { brief: { ...brief, imageRoles: [{ index: 0, role: 'content_photo', notes: 'Speaker' }], photosSent: 1 } });
    const images = [photo(1), photo(2)];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => completion(schemaOf(init) === 'ConceptBoard' ? concepts() : rebriefed));
    const service = new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' });
    const brokenRepo = new DesignStudioRepository(db);
    const update = brokenRepo.updateRunStatus.bind(brokenRepo);
    let budgetSnapshots = 0;
    vi.spyOn(brokenRepo, 'updateRunStatus').mockImplementation(async (...args) => {
      if (args[2] === 'conceiving' && args[3]?.budget && !args[3]?.stages && ++budgetSnapshots === 2) {
        throw new Error('Synthetic crash after the retained concept board, before its budget/stage snapshot');
      }
      return update(...args);
    });
    Object.assign(service, { repo: brokenRepo, imagesForRun: async () => images });
    await expect(service.resume(scope, taskId, runId)).rejects.toMatchObject({ code: 'MODEL_CALL_ACCOUNTING_FAILED' });
    expect(fetcher.mock.calls.map(([, init]) => schemaOf(init))).toEqual(['CreativeBrief', 'ConceptBoard']);
    const run = await repo.getRunById(runId, scope.tenantId);
    expect(run?.status).toBe('conceiving');
    expect(run?.stages).toMatchObject({ brief: { imagesRebrief: true } });
    expect(await repo.getCallsForRun(runId, scope.tenantId)).toMatchObject([
      { stage: 'conceiving', status: 'ok', has_retained_result: true },
      { stage: 'conceiving', status: 'ok', has_retained_result: true }]);
    return images;
  }

  it('resumes a persisted rebrief branch from the retained concept board without transport or charge', async () => {
    const images = await interruptedAfterRebrief();
    const before = await repo.getBudgetUsage(runId, scope.tenantId, scope.actorId);
    const runtimeUrl = new URL(url!);
    runtimeUrl.searchParams.set('options', '-c role=hawa_app');
    const peer = createDb(runtimeUrl.toString());
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('No second transport is authorized'); });
    try {
      const service = new DesignStudioService(peer, undefined, { fetcher, apiKey: 'synthetic-key' });
      Object.assign(service, { imagesForRun: async () => images });
      const result = await service.resume(scope, taskId, runId);
      expect(result.status).toBe('laying_out');
      expect(fetcher).not.toHaveBeenCalled();
      const recovered = await new DesignStudioRepository(peer).getRunById(runId, scope.tenantId);
      expect((recovered?.stages as { concepts?: unknown[] }).concepts).toHaveLength(5);
      expect(await repo.getBudgetUsage(runId, scope.tenantId, scope.actorId)).toEqual(before);
      expect(await repo.getCallsForRun(runId, scope.tenantId)).toHaveLength(2);
    } finally { await peer.destroy(); }
  });

  it('still holds the rebrief branch when the persisted brief no longer matches the retained concept board', async () => {
    const images = await interruptedAfterRebrief();
    const run = await repo.getRunById(runId, scope.tenantId);
    const stages = run!.stages as Record<string, unknown>;
    await repo.updateRunStatus(runId, scope.tenantId, 'conceiving', { stages: { ...stages, brief: { ...(stages.brief as object), occasion: 'A different branch' } } });
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected transport'); });
    const service = new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' });
    Object.assign(service, { imagesForRun: async () => images });
    await expect(service.resume(scope, taskId, runId)).rejects.toMatchObject({ code: 'MODEL_STAGE_REPLAY_UNSAFE' });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await repo.getRunById(runId, scope.tenantId))?.status).toBe('conceiving');
    expect(await repo.getCallsForRun(runId, scope.tenantId)).toHaveLength(2);
  });

  const artRequest = { artPrompt: 'Navy paper shapes', palette: ['#1E3A5F'], width: 16, height: 16 };
  const artBytes = renderMotifPng('gradient-wash', { width: 16, height: 16, palette: ['#1E3A5F'], seed: 1 });
  const imageReply = () => new Response(JSON.stringify({ model: 'gpt-image-2.5-sunburst', data: [{ b64_json: artBytes.toString('base64') }],
    usage: { input_tokens: 400, output_tokens: 1000, input_tokens_details: { text_tokens: 400, image_tokens: 0 } } }));
  const verdict = () => completion({ containsForbidden: false, what: 'Synthetic verdict' });

  /** A definite image refusal, then a retained image and verdict; the crash follows the verdict's receipt. */
  async function interleavedArt() {
    await create(4, 'laying_out');
    let images = 0;
    const fetcher = vi.fn<typeof fetch>(async target => {
      if (!String(target).includes('/images/')) return verdict();
      return ++images === 1 ? new Response(JSON.stringify({ error: { message: 'Synthetic refusal' } }), { status: 400 }) : imageReply();
    });
    const run = (await repo.getRunById(runId, scope.tenantId))!;
    const budget: Budget = { maxUsd: 5, maxCalls: 4, spentUsd: 0, calls: 0 };
    let receipts = 0;
    const first = await harness(new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' }))
      .createStageContext(scope, run, 'laying_out', budget, async cost => {
        budget.spentUsd += cost;
        if (++receipts === 3) throw new Error('Synthetic interruption after the retained verdict');
      }, []);
    await expect(first.artProvider!.generateArt(artRequest)).rejects.toMatchObject({ code: 'MODEL_CALL_ACCOUNTING_FAILED' });
    const calls = await repo.getCallsForRun(runId, scope.tenantId);
    expect(calls).toMatchObject([
      { stage: 'art', status: 'error', cost_basis: 'not_accepted', error_code: 'IMAGE_REQUEST_REJECTED', has_retained_result: false },
      { stage: 'art', status: 'ok', has_retained_result: true },
      { stage: 'laying_out', status: 'ok', has_retained_result: true }]);
    return { run, budget, calls };
  }

  it('replays an interleaved definite image refusal and resumes the retained image and verdict', async () => {
    const { run, budget, calls } = await interleavedArt();
    const spend = budget.spentUsd;
    const noTransport = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected replay transport'); });
    const noSpend = vi.fn(async (cost: number) => { budget.spentUsd += cost; });
    const second = await harness(new DesignStudioService(db, undefined, { fetcher: noTransport, apiKey: 'synthetic-key' }))
      .createStageContext(scope, run, 'laying_out', budget, noSpend, calls);
    const recovered = await second.artProvider!.generateArt(artRequest);
    expect(sha(recovered.imageBuffer)).toBe(sha(artBytes));
    expect(recovered.receipt).toMatchObject({ provider: 'openai', attempts: 2 });
    expect(noTransport).not.toHaveBeenCalled();
    expect(noSpend).not.toHaveBeenCalled();
    expect(budget.spentUsd).toBe(spend);
    expect(await repo.getCallsForRun(runId, scope.tenantId)).toHaveLength(3);
  });

  it('changing a date keeps the retained art and its asset hash, and holds the layout that carried the old date', async () => {
    await create(4, 'laying_out');
    const fetcher = vi.fn<typeof fetch>(async (target, init) => String(target).includes('/images/') ? imageReply()
      : completion(schemaOf(init) === 'StudioLayoutV2Output' ? { layout: {} } : { containsForbidden: false, what: 'Synthetic verdict' }));
    const run = (await repo.getRunById(runId, scope.tenantId))!;
    const budget: Budget = { maxUsd: 5, maxCalls: 4, spentUsd: 0, calls: 0 };
    const layoutCall = (ctx: StageContext) => inStudioSubstep('layout/concept-1', () => ctx.client.completeJson({
      system: 'Layout', prompt: `Place ${ctx.copyBlocks.map(b => b.text).join(' | ')}`, schema: { type: 'object' }, schemaName: 'StudioLayoutV2Output' }));
    const artCall = (ctx: StageContext) => inStudioSubstep('art/candidate-1', () => ctx.artProvider!.generateArt(artRequest));
    const first = await harness(new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' }))
      .createStageContext(scope, run, 'laying_out', budget, async cost => { budget.spentUsd += cost; }, []);
    await layoutCall(first);
    const original = await artCall(first);
    const calls = await repo.getCallsForRun(runId, scope.tenantId);
    expect(calls.map(c => c.substep_key)).toEqual(['layout/concept-1', 'art/candidate-1', 'art/candidate-1']);
    const spend = budget.spentUsd;
    const corrected = { ...run, request: { ...request, copyBlocks: [{ text: 'Synthetic exact title — 12 October', script: 'latin' }] } };
    const noTransport = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected replay transport'); });
    const second = await harness(new DesignStudioService(db, undefined, { fetcher: noTransport, apiKey: 'synthetic-key' }))
      .createStageContext(scope, corrected, 'laying_out', budget, async cost => { budget.spentUsd += cost; }, calls);
    expect(second.copyBlocks[0].text).toContain('12 October');
    const art = await artCall(second);
    expect(sha(art.imageBuffer)).toBe(sha(original.imageBuffer));
    expect(art.receipt.sha256).toBe(original.receipt.sha256);
    // The retained layout was derived from the old date; nothing declared this change, so it holds.
    await expect(layoutCall(second)).rejects.toMatchObject({ code: 'MODEL_STAGE_REPLAY_UNSAFE' });
    expect(noTransport).not.toHaveBeenCalled();
    expect(budget.spentUsd).toBe(spend);
    expect(await repo.getCallsForRun(runId, scope.tenantId)).toHaveLength(3);
  });

  it('still holds an interleaved failure whose outcome cannot be reproduced before later retained work', async () => {
    await create(4, 'conceiving');
    const run = (await repo.getRunById(runId, scope.tenantId))!;
    const budget: Budget = { maxUsd: 5, maxCalls: 4, spentUsd: 0, calls: 0 };
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async () => ++calls === 1
      ? new Response(JSON.stringify({ error: { message: 'Synthetic refusal' } }), { status: 400 }) : completion(concepts()));
    const first = await harness(new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' }))
      .createStageContext(scope, run, 'conceiving', budget, async cost => { budget.spentUsd += cost; }, []);
    const call = { system: 'Concepts', prompt: 'Board', schema: { type: 'object' }, schemaName: 'ConceptBoard' };
    await expect(first.client.completeJson(call)).rejects.toMatchObject({ status: 400 });
    await first.client.completeJson(call);
    const recorded = await repo.getCallsForRun(runId, scope.tenantId);
    expect(recorded).toMatchObject([{ status: 'error', cost_basis: 'not_accepted' }, { status: 'ok', has_retained_result: true }]);
    const noTransport = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected replay transport'); });
    const second = await harness(new DesignStudioService(db, undefined, { fetcher: noTransport, apiKey: 'synthetic-key' }))
      .createStageContext(scope, run, 'conceiving', budget, async () => {}, recorded);
    await expect(second.client.completeJson(call)).rejects.toMatchObject({ code: 'MODEL_STAGE_REPLAY_UNSAFE' });
    expect(noTransport).not.toHaveBeenCalled();
  });

  it('applies one retained reply once: a repeated request in the same substep is a new admission, and replay is stable', async () => {
    await create(4, 'conceiving');
    const run = (await repo.getRunById(runId, scope.tenantId))!;
    const budget: Budget = { maxUsd: 5, maxCalls: 4, spentUsd: 0, calls: 0 };
    const fetcher = vi.fn<typeof fetch>(async () => completion(concepts()));
    const first = await harness(new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' }))
      .createStageContext(scope, run, 'conceiving', budget, async cost => { budget.spentUsd += cost; }, []);
    const call = { system: 'Concepts', prompt: 'Board', schema: { type: 'object' }, schemaName: 'ConceptBoard' };
    const original = await first.client.completeJson(call);
    const secondTransport = vi.fn<typeof fetch>(async () => completion({ concepts: [] }));
    const second = await harness(new DesignStudioService(db, undefined, { fetcher: secondTransport, apiKey: 'synthetic-key' }))
      .createStageContext(scope, run, 'conceiving', budget, async cost => { budget.spentUsd += cost; }, await repo.getCallsForRun(runId, scope.tenantId));
    expect(await second.client.completeJson(call)).toEqual(original);
    expect(secondTransport).not.toHaveBeenCalled();
    const repeated = await second.client.completeJson<{ concepts: unknown[] }>(call);
    expect(repeated.data.concepts).toEqual([]);
    expect(secondTransport).toHaveBeenCalledTimes(1);
    const recorded = await repo.getCallsForRun(runId, scope.tenantId);
    expect(recorded).toHaveLength(2);
    const spend = budget.spentUsd;
    const thirdTransport = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected replay transport'); });
    const third = await harness(new DesignStudioService(db, undefined, { fetcher: thirdTransport, apiKey: 'synthetic-key' }))
      .createStageContext(scope, run, 'conceiving', budget, async cost => { budget.spentUsd += cost; }, recorded);
    expect(await third.client.completeJson(call)).toEqual(original);
    expect((await third.client.completeJson<{ concepts: unknown[] }>(call)).data.concepts).toEqual([]);
    expect(thirdTransport).not.toHaveBeenCalled();
    expect(budget.spentUsd).toBe(spend);
  });

  it('re-authorizes retained work: a changed authorization holds even when the request bytes are unchanged', async () => {
    await create(4, 'conceiving');
    const run = (await repo.getRunById(runId, scope.tenantId))!;
    const budget: Budget = { maxUsd: 5, maxCalls: 4, spentUsd: 0, calls: 0 };
    const fetcher = vi.fn<typeof fetch>(async () => completion(concepts()));
    const first = await harness(new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' }))
      .createStageContext(scope, run, 'conceiving', budget, async cost => { budget.spentUsd += cost; }, []);
    const call = { system: 'Concepts', prompt: 'Board', schema: { type: 'object' }, schemaName: 'ConceptBoard' };
    await first.client.completeJson(call);
    const noTransport = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected replay transport'); });
    const second = await harness(new DesignStudioService(db, undefined, { fetcher: noTransport, apiKey: 'synthetic-key' }))
      .createStageContext(scope, run, 'conceiving', budget, async () => {}, await repo.getCallsForRun(runId, scope.tenantId));
    // Injected: an exemplar approval was withdrawn after the reply was retained; the exemplar bytes are unchanged.
    second.exemplarPolicySha256 = sha('approval withdrawn');
    await expect(second.client.completeJson(call)).rejects.toMatchObject({ code: 'MODEL_STAGE_REPLAY_UNSAFE' });
    expect(noTransport).not.toHaveBeenCalled();
  });
});
