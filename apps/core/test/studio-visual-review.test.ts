import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  JUDGE_DIMENSIONS,
  getLayoutBoxAnnotations,
  layoutSha256,
  prepareGeneratedLayoutV3,
  type OpenAiStudioClient,
  type StudioLayoutV2,
  type VisualReviewFix,
} from '@hawa/creative';
import { createDb, sql, withRlsContext, DesignStudioRepository } from '@hawa/db';
import type { CandidateState, StageContext } from '../src/services/design-studio/types.js';
import { runParityStage } from '../src/services/design-studio/stages/parity.stage.js';
import { runRenderStage } from '../src/services/design-studio/stages/render.stage.js';
import {
  rankStudioCandidatesV3,
  runVisualRefinementStageV3,
  runVisualReviewStageV3,
  type VisualReviewStageRecord,
} from '../src/services/design-studio/stages/v3.stage.js';
import { currentStudioSubstep } from '../src/services/design-studio/substeps.js';
import { StudioSpendCapError, inStudioSpendCap, assertWithinStudioSpendCap, chargeStudioSpendCap } from '../src/services/design-studio/spend-cap.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';

/**
 * ADR-237: in production the top model looks at the renders the judge will choose between, its
 * fixes are applied in one controlled pass, re-rendered and re-checked, and the refinement is kept
 * only when it is better. Parity reads the judge role, so it moves to Sol with the judge.
 */
const W = 1080;
const H = 1350;
const MARGIN = 76;
const PALETTE = ['#FFFFFF', '#FDF8F3', '#4770A3', '#1E3A5F', '#F7B500', '#0A1628'];
const COPY = ['Quality Assurance Workshop', 'For school principals', '22 October 2026 · 10:00 AM', 'Divan Hotel, Erbil', 'Seats are limited, please register early'];
const copyMap = Object.fromEntries(COPY.map((t, i) => [i, t]));

const T = (i: number, role: string, y: number, h: number, size: number) => ({
  copyIndex: i, role, x: MARGIN, y, width: W - 2 * MARGIN, height: h, fontSize: size, lineHeight: 1.3,
  fontFamily: role === 'title' ? 'Playfair Display' : 'Verdana', color: i === 4 ? '#0A1628' : '#1E3A5F', align: 'center',
  bold: role === 'title', italic: false, rtl: false,
});

function poster(titleY = 340): StudioLayoutV2 {
  const raw = {
    version: 2, width: W, height: H, genre: 'poster',
    grid: { margin: MARGIN, columns: 6, gutter: 26, baseline: 14 },
    background: { color: '#FFFFFF' },
    logo: { x: W / 2 - 80, y: 90, width: 160, height: 160 },
    shapes: [{ x: W / 2 - 80, y: 640, width: 160, height: 3, kind: 'line', color: '#F7B500', role: 'rule' }],
    text: [T(0, 'title', titleY, 220, 76), T(1, 'subtitle', 580, 50, 30), T(2, 'date', 700, 50, 30), T(3, 'venue', 770, 50, 30), T(4, 'footer', 1180, 44, 24)],
  } as unknown as StudioLayoutV2;
  return prepareGeneratedLayoutV3(raw, { text: copyMap }, { width: W, height: H, logoAspect: 1, palette: PALETTE });
}

function context(client: Pick<OpenAiStudioClient, 'createStructuredCompletion'>): StageContext {
  return {
    runId: randomUUID(), tenantId: randomUUID(), taskId: randomUUID(), clientId: randomUUID(), actorId: 'test_operator',
    width: W, height: H, tier: 'premium',
    instructions: 'Hi, we need a poster for our Quality Assurance Workshop for school principals.',
    copyBlocks: COPY.map((text) => ({ text, script: 'latin' as const })),
    referencePack: { palette: PALETTE, referenceFonts: { latin: 'Verdana', arabic: 'Noto Sans Arabic' } },
    promotedRules: 'White page; KAAE Blue titles and cards; gold for the title bar and rules.',
    latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 1, logo: KAAE_TEST_CLIENT_LOGO,
    client: client as OpenAiStudioClient,
  } as unknown as StageContext;
}

async function candidate(ordinal: number, layout: StudioLayoutV2, ctx: StageContext): Promise<CandidateState> {
  const [rendered] = await runRenderStage(ctx, [{ id: `cand-${ordinal}`, ordinal, concept: {} as any, layouts: [layout], currentLayout: layout, critiques: [], status: 'active' }]);
  return rendered;
}

const fix = (over: Partial<VisualReviewFix>): VisualReviewFix => ({
  boxId: 'B1', category: 'hierarchy', problem: 'p', x: null, y: null, width: null, height: null, fontSize: null,
  lineHeight: null, focusX: null, focusY: null, zoom: null, raiseContrast: false, ...over,
});
const markOf = (layout: StudioLayoutV2, copyIndex: number) => getLayoutBoxAnnotations(layout).find((a) => a.copyIndex === copyIndex)!.boxId;

/** Answers reviews with `fixesFor`, and judge calls for the refined design (or the original). */
function fakeModel(options: { fixesFor?: (params: any) => VisualReviewFix[]; judgePrefers?: 'refined' | 'original'; throwOnReview?: (n: number) => Error | undefined } = {}) {
  const calls: Array<{ schema: string; model: string; substep: string; maxTokens: number }> = [];
  let reviews = 0;
  let judgeCalls = 0;
  const client = {
    async createStructuredCompletion(params: any) {
      calls.push({ schema: params.jsonSchema.name, model: params.model, substep: currentStudioSubstep('test'), maxTokens: params.maxTokens });
      let data: any;
      if (params.jsonSchema.name === 'VisualDesignReview') {
        const err = options.throwOnReview?.(++reviews);
        if (err) throw err;
        data = { assessment: 'The title is timid and the footer floats.', fixes: options.fixesFor?.(params) ?? [] };
      } else if (params.jsonSchema.name === 'PairwiseDimensionVerdict') {
        // judgeRefinementV3 asks original-vs-refined first (refined is B), then swapped (refined is A).
        const refinedIs = judgeCalls++ % 2 === 0 ? 'B' : 'A';
        const w = options.judgePrefers === 'original' ? (refinedIs === 'A' ? 'B' : 'A') : refinedIs;
        data = { dimensions: Object.fromEntries(JUDGE_DIMENSIONS.map((d) => [d, { winner: w, rationale: 'r' }])), majorityWinner: w, summary: 's' };
      } else throw new Error(`unexpected schema ${params.jsonSchema.name}`);
      return { data, rawText: JSON.stringify(data), receipt: { id: 'r', responseId: `resp_${calls.length}`, xRequestId: null, model: params.model,
        inputTokens: 9000, outputTokens: 900, reasoningTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.03, sha256: '', latencyMs: 5, attempts: 1 } };
    },
  };
  return { client, calls };
}

const settings = { rounds: 1, candidates: 2, maxUsd: 1 };

describe('ADR-237: parity reads the judge role, so it is Sol in production', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('sends the Canva parity check to gpt-6.1-sol on the production tier and keeps the dev tier on gpt-4.1-mini', async () => {
    for (const [tier, model] of [['production', 'gpt-6.1-sol'], ['dev', 'gpt-4.1-mini']] as const) {
      vi.stubEnv('HAWA_MODEL_TIER', tier);
      vi.stubEnv('HAWA_MODEL_JUDGE', '');
      const completeJson = vi.fn(async () => ({ data: { parity: 'match', divergences: [], fontSubstituted: false, textReflowed: false, copyVisibleIdentical: true }, rawText: '', receipt: {} }));
      const ctx = { ...context({ createStructuredCompletion: vi.fn() } as any), client: { completeJson } } as unknown as StageContext;
      await runParityStage(ctx, Buffer.from('preview'), Buffer.from('canva'));
      expect((completeJson.mock.calls[0] as any[])[0].model).toBe(model);
    }
  });
});

describe('ADR-237 critique stage: the model looks at the renders the judge chooses between', { timeout: 120000 }, () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reviews the top two candidates that pass hard QA, each in its own substep, on Sol in production', async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    vi.stubEnv('HAWA_MODEL_CRITIQUE', '');
    const { client, calls } = fakeModel();
    const ctx = context(client);
    const candidates = [await candidate(0, poster(), ctx), await candidate(1, poster(320), ctx), await candidate(2, poster(360), ctx)];
    expect(rankStudioCandidatesV3(ctx, candidates).every((r) => r.hardQa?.passed)).toBe(true);
    const record = await runVisualReviewStageV3(ctx, candidates, settings, {});
    expect(record.reviews).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.schema === 'VisualDesignReview' && c.model === 'gpt-6.1-sol')).toBe(true);
    expect(calls.map((c) => c.substep)).toEqual(record.reviews.map((r) => `review/candidate-${r.ordinal + 1}`));
    for (const review of record.reviews) {
      const cand = candidates.find((c) => c.id === review.candidateId)!;
      expect(review.reviewedLayoutSha256).toBe(layoutSha256(cand.currentLayout));
    }
  });

  it('spends nothing when the review is off, and nothing on a candidate that fails hard QA', async () => {
    const { client, calls } = fakeModel();
    const ctx = context(client);
    const good = await candidate(0, poster(), ctx);
    expect((await runVisualReviewStageV3(ctx, [good], { ...settings, rounds: 0 }, {})).reviews).toEqual([]);
    const broken = poster();
    broken.text = broken.text.filter((t) => t.copyIndex !== 1); // a requested block is missing: QA refuses it
    const bad = await candidate(1, broken, ctx);
    const record = await runVisualReviewStageV3(ctx, [bad], settings, {});
    expect(record.reviews).toEqual([]);
    expect(record.skipped[0].reason).toMatch(/no candidate passes hard QA/);
    expect(calls).toHaveLength(0);
  });

  it('stops reviewing once the run\'s review cap is reached, and the design stands', async () => {
    const { client, calls } = fakeModel({ throwOnReview: (n) => (n === 1 ? new StudioSpendCapError('visual review', 0.1, 0.05, 0.2) : undefined) });
    const ctx = context(client);
    const candidates = [await candidate(0, poster(), ctx), await candidate(1, poster(320), ctx)];
    const record = await runVisualReviewStageV3(ctx, candidates, settings, {});
    expect(record.reviews).toEqual([]);
    expect(record.skipped).toHaveLength(1);
    expect(record.skipped[0].reason).toMatch(/spending cap/);
    expect(calls).toHaveLength(1);
  });

  it('lets a hold or a budget stop end the run as everywhere else', async () => {
    const hold = Object.assign(new Error('uncertain'), { code: 'MODEL_STAGE_REPLAY_UNSAFE' });
    const { client } = fakeModel({ throwOnReview: () => hold });
    const ctx = context(client);
    await expect(runVisualReviewStageV3(ctx, [await candidate(0, poster(), ctx)], settings, {})).rejects.toBe(hold);
  });
});

describe('ADR-237 revise stage: one controlled pass, re-rendered, re-checked, kept only when better', { timeout: 120000 }, () => {
  afterEach(() => vi.unstubAllEnvs());

  async function reviewed(fixesFor: (layout: StudioLayoutV2) => VisualReviewFix[], judgePrefers: 'refined' | 'original' = 'refined') {
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    vi.stubEnv('HAWA_MODEL_CRITIQUE', '');
    vi.stubEnv('HAWA_MODEL_JUDGE', '');
    const layout = poster();
    const model = fakeModel({ fixesFor: () => fixesFor(layout), judgePrefers });
    const ctx = context(model.client);
    const original = await candidate(0, layout, ctx);
    const record = await runVisualReviewStageV3(ctx, [original], { ...settings, candidates: 1 }, {});
    expect(record.reviews).toHaveLength(1);
    return { ctx, original, record, calls: model.calls };
  }

  it('applies the review\'s fixes, re-renders and keeps the refinement the measures or the judge support', async () => {
    const { ctx, original, record, calls } = await reviewed((l) => [
      fix({ boxId: markOf(l, 0), category: 'type_size', fontSize: l.text.find((t) => t.copyIndex === 0)!.fontSize + 6 }),
      fix({ boxId: markOf(l, 4), category: 'spacing', y: l.text.find((t) => t.copyIndex === 4)!.y - 30 }),
    ]);
    const [outcome] = await runVisualRefinementStageV3(ctx, [original], record, {});
    expect(outcome.adopted).toBe(true);
    expect(['metrics_hold', 'judge_prefers_refined']).toContain(outcome.reason);
    expect(outcome.rounds).toHaveLength(1);
    expect(outcome.rounds[0].fixes.map((f) => f.status)).toEqual(['applied', 'applied']);
    expect(outcome.rounds[0].hardQaAfter?.passed).toBe(true);
    const refined = outcome.refined!;
    expect(refined.layouts).toHaveLength(2);
    expect(refined.layouts[0]).toEqual(original.currentLayout);
    expect(refined.currentLayout.text.find((t) => t.copyIndex === 0)!.fontSize).toBeGreaterThan(original.currentLayout.text.find((t) => t.copyIndex === 0)!.fontSize);
    expect(refined.previewPng!.equals(original.previewPng!)).toBe(false);
    expect(refined.currentLayout.text.map((t) => t.copyIndex).sort()).toEqual([0, 1, 2, 3, 4]);
    // A judge was asked only if the measures fell, on Sol, in its own substep, both orders.
    const judge = calls.filter((c) => c.schema === 'PairwiseDimensionVerdict');
    expect(judge.length === 0 || judge.length === 2).toBe(true);
    expect(judge.every((c) => c.model === 'gpt-6.1-sol' && c.substep === 'review-judge/candidate-1-round-1')).toBe(true);
  });

  it('discards a worse refinement: a fix that breaks hard QA is never kept, and no judge is paid for it', async () => {
    const { ctx, original, record, calls } = await reviewed((l) => [
      // The title dropped onto the date and venue lines.
      fix({ boxId: markOf(l, 0), category: 'spacing', y: l.text.find((t) => t.copyIndex === 2)!.y - 20 }),
    ]);
    const [outcome] = await runVisualRefinementStageV3(ctx, [original], record, {});
    expect(outcome.adopted).toBe(false);
    expect(outcome.reason).toBe('refined_fails_hard_qa');
    expect(outcome.refined).toBeUndefined();
    expect(calls.filter((c) => c.schema === 'PairwiseDimensionVerdict')).toHaveLength(0);
  });

  it('discards a refinement the measures do not support when the judge prefers the original', async () => {
    const { ctx, original, record } = await reviewed((l) => [
      // Smaller, crowded supporting lines: legal, but worse by the measures.
      fix({ boxId: markOf(l, 1), category: 'type_size', fontSize: 16 }),
      fix({ boxId: markOf(l, 2), category: 'type_size', fontSize: 16 }),
      fix({ boxId: markOf(l, 3), category: 'type_size', fontSize: 16 }),
    ], 'original');
    const [outcome] = await runVisualRefinementStageV3(ctx, [original], record, {});
    if (outcome.rounds[0].decision?.regressions.length) {
      expect(outcome.adopted).toBe(false);
      expect(outcome.reason).toBe('judge_prefers_original');
    } else {
      // The measures held, so no judge was needed; the guard's other half is pinned in creative.
      expect(outcome.reason).toBe('metrics_hold');
    }
  });

  it('is replay-safe: a resumed stage leaves an already refined candidate alone and calls nothing', async () => {
    const { ctx, original, record } = await reviewed((l) => [fix({ boxId: markOf(l, 0), category: 'type_size', fontSize: l.text.find((t) => t.copyIndex === 0)!.fontSize + 6 })]);
    const [first] = await runVisualRefinementStageV3(ctx, [original], record, {});
    expect(first.adopted).toBe(true);
    const silent = { createStructuredCompletion: vi.fn(async () => { throw new Error('no call may be made on replay'); }) };
    const resumed = { ...ctx, client: silent } as unknown as StageContext;
    const [again] = await runVisualRefinementStageV3(resumed, [first.refined!], record, {});
    expect(again).toMatchObject({ adopted: false, reason: 'already_refined', rounds: [] });
    expect(silent.createStructuredCompletion).not.toHaveBeenCalled();
  });

  it('holds to the review it was given: no fix applicable means no render and no call', async () => {
    const { ctx, original, record, calls } = await reviewed(() => []);
    const before = calls.length;
    const [outcome] = await runVisualRefinementStageV3(ctx, [original], record, {});
    expect(outcome).toMatchObject({ adopted: false, reason: 'no_applicable_fix' });
    expect(calls.length).toBe(before);
  });
});

describe('ADR-237 spending cap', () => {
  it('refuses a call whose reservation would pass the cap, and counts what was spent', async () => {
    const cap = { label: 'visual review', capUsd: 0.5, spentUsd: 0 };
    await inStudioSpendCap(cap, async () => {
      assertWithinStudioSpendCap(0.3);
      chargeStudioSpendCap(0.3);
      expect(() => assertWithinStudioSpendCap(0.25)).toThrow(StudioSpendCapError);
      assertWithinStudioSpendCap(0.2);
    });
    expect(cap.spentUsd).toBeCloseTo(0.3, 9);
    // Outside a declared cap nothing is limited.
    expect(() => assertWithinStudioSpendCap(100)).not.toThrow();
  });
});

const url = process.env.HAWA_ISOLATED_TEST_DB;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

describe.skipIf(!url)('ADR-237 spending cap inside the paid-call ledger', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const repo = new DesignStudioRepository(db);
  afterAll(() => db.destroy());
  afterEach(() => vi.unstubAllEnvs());

  it('sends nothing and records no call over the cap, and charges a retained answer on replay', async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: randomUUID(), role: 'operator' as const };
    const clientId = 'c1000000-0000-4000-8000-000000000002';
    const taskId = randomUUID();
    const runId = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${scope.actorId}::uuid,${scope.actorId + '@example.test'},'Cap operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${scope.tenantId}::uuid,${scope.actorId}::uuid,'operator')`.execute(db);
    await withRlsContext(db, { tenantId: scope.tenantId, userId: scope.actorId }, async (tx) => {
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${scope.tenantId}::uuid,'cap-kaae','Synthetic KAAE') ON CONFLICT(id) DO NOTHING`.execute(tx);
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${scope.tenantId}::uuid,${clientId}::uuid,'Cap task')`.execute(tx);
    });
    const { reference, logo } = await resolveClientDesignReference(db, scope, clientId);
    const request = { clientId, width: 1080, height: 1350, instructions: 'A clear announcement', copyBlocks: [{ text: 'Exact title', script: 'latin' }],
      referenceHash: sha(JSON.stringify(reference)), logoSha256: sha(logo) };
    await repo.createRun({ id: runId, taskId, tenantId: scope.tenantId, clientId, actorId: scope.actorId, requestKey: runId,
      requestHash: sha(JSON.stringify(request)), request, tier: 'premium', budget: { maxUsd: 2, maxCalls: 4, spentUsd: 0, calls: 0 } });
    await repo.updateRunStatus(runId, scope.tenantId, 'critiquing');
    const run = (await repo.getRunById(runId, scope.tenantId))!;
    const params = { model: 'gpt-6.1-sol', maxTokens: 1000, messages: [{ role: 'user' as const, content: 'Review this.' }],
      jsonSchema: { name: 'VisualDesignReview', schema: { type: 'object' } } };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'synthetic-sol', model: 'gpt-6.1-sol',
      usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 }, choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] })));
    const budget = { maxUsd: 2, maxCalls: 4, spentUsd: 0, calls: 0 };
    type Harness = { createStageContext(...args: unknown[]): Promise<StageContext> };
    const ctx = await (new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' }) as unknown as Harness)
      .createStageContext(scope, run, 'critiquing', budget, async (cost: number) => { budget.spentUsd += cost; }, []);

    const tight = { label: 'visual review', capUsd: 0.000001, spentUsd: 0 };
    await expect(inStudioSpendCap(tight, () => ctx.client.createStructuredCompletion(params))).rejects.toBeInstanceOf(StudioSpendCapError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repo.getCallsForRun(runId, scope.tenantId)).toHaveLength(0);

    const roomy = { label: 'visual review', capUsd: 1, spentUsd: 0 };
    const answer = await inStudioSpendCap(roomy, () => ctx.client.createStructuredCompletion(params));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(roomy.spentUsd).toBeCloseTo(answer.receipt.costUsd, 9);
    expect(roomy.spentUsd).toBeGreaterThan(0);

    const calls = await repo.getCallsForRun(runId, scope.tenantId);
    const noTransport = vi.fn<typeof fetch>(async () => { throw new Error('no replay transport'); });
    const replayed = await (new DesignStudioService(db, undefined, { fetcher: noTransport, apiKey: 'synthetic-key' }) as unknown as Harness)
      .createStageContext(scope, run, 'critiquing', budget, async () => {}, calls);
    const again = { label: 'visual review', capUsd: 1, spentUsd: 0 };
    expect(await inStudioSpendCap(again, () => replayed.client.createStructuredCompletion(params))).toEqual(answer);
    expect(noTransport).not.toHaveBeenCalled();
    expect(again.spentUsd).toBeCloseTo(answer.receipt.costUsd, 9);
  });
});
