import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { renderMotifPng } from '@hawa/creative';
import type { Database, Kysely, DesignStudioRepository, RecordCallStartParams, FinalizeCallParams } from '@hawa/db';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { resolveClientDesignReference } from '../src/services/client-design-reference.js';
import type { StageContext } from '../src/services/design-studio/types.js';

const imageBytes = renderMotifPng('gradient-wash', { width: 16, height: 16, palette: ['#1E3A5F'], seed: 1 });
const request = { artPrompt: 'Navy paper shapes', palette: ['#1E3A5F'], width: 16, height: 16 };
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'x-request-id': 'synthetic-request' } });
const imageResponse = () => response({ model: 'gpt-image-2.5-sunburst',
  data: [{ b64_json: imageBytes.toString('base64') }],
  usage: { input_tokens: 400, output_tokens: 1000, input_tokens_details: { text_tokens: 400, image_tokens: 0 } } });
const visionResponse = (containsForbidden = false) => response({ id: 'synthetic-vision', model: 'gpt-6-astra',
  usage: { prompt_tokens: 1000, completion_tokens: 200 },
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ containsForbidden, what: 'Synthetic verdict' }) } }] });

type Scope = { tenantId: string; actorId: string; role: 'operator' };
type Budget = { maxUsd: number; maxCalls: number; spentUsd: number; calls: number };
type ContextHarness = { createStageContext(s: Scope, run: Record<string, unknown>, stage: string,
  budget: Budget, update: (cost: number) => Promise<void>): Promise<StageContext> };

async function harness(fetcher: typeof fetch, options: { maxCalls?: number; maxUsd?: number;
  failFinalize?: boolean; failAdmission?: boolean; failSpend?: boolean;
  repository?: Pick<DesignStudioRepository, 'recordCallStart' | 'finalizeCall'>;
  scope?: Scope; runId?: string } = {}) {
  const db = {} as Kysely<Database>; // This harness supplies the packaged client reference, without SQL.
  const svc = new DesignStudioService(db, undefined, { fetcher, apiKey: 'synthetic-key' });
  const admissions: RecordCallStartParams[] = [], outcomes: FinalizeCallParams[] = [];
  const budget = { maxUsd: options.maxUsd ?? 2, maxCalls: options.maxCalls ?? 20, spentUsd: 0, calls: 0 };
  const repository = options.repository ?? {
    recordCallStart: async (p: RecordCallStartParams) => {
      if (options.failAdmission) throw new Error('synthetic admission failure');
      admissions.push(p);
    },
    finalizeCall: async (p: FinalizeCallParams) => {
      if (options.failFinalize) throw new Error('synthetic local receipt failure');
      outcomes.push(p);
    },
  };
  Object.assign(svc, { repo: repository });
  const scope: Scope = options.scope ?? { tenantId: randomUUID(), actorId: randomUUID(), role: 'operator' };
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const { reference, logo } = await resolveClientDesignReference(db, scope, clientId);
  const run = { id: options.runId ?? randomUUID(), task_id: randomUUID(), client_id: clientId, tier: 'premium',
    request: { width: 1080, height: 1350, copyBlocks: [{ text: 'Fixture', script: 'latin' }],
      clientId, referenceHash: createHash('sha256').update(JSON.stringify(reference)).digest('hex'),
      logoSha256: createHash('sha256').update(logo).digest('hex') }, stages: {} };
  const ctx = await (svc as unknown as ContextHarness).createStageContext(scope, run, 'laying_out', budget,
    async cost => {
      if (options.failSpend) throw new Error('synthetic budget snapshot failure');
      budget.spentUsd += cost;
    });
  return { ctx, admissions, outcomes, budget };
}

describe('each Studio art request has its own durable admission', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('admits and charges the image and its vision check separately before each transport', async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    let h: Awaited<ReturnType<typeof harness>>;
    let transports = 0;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(h.admissions).toHaveLength(++transports);
      expect(h.admissions.at(-1)?.reservation.requestSha256)
        .toBe(createHash('sha256').update(String(init?.body)).digest('hex'));
      return String(url).includes('/images/') ? imageResponse() : visionResponse();
    });
    h = await harness(fetcher);
    const art = await h.ctx.artProvider!.generateArt(request);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(h.admissions.map(c => c.model)).toEqual(['gpt-image-2.5-sunburst', 'gpt-6-astra']);
    expect(h.admissions.map(c => c.callOrdinal)).toEqual([1, 2]);
    expect(h.outcomes).toHaveLength(2);
    expect(h.outcomes[0]).toMatchObject({ inputTokens: 400, outputTokens: 1000,
      responseSha256: createHash('sha256').update(imageBytes).digest('hex'), images: 1, status: 'ok' });
    expect(h.budget.spentUsd).toBeCloseTo(0.032 + 0.02, 6);
    expect(art.receipt.costUsd).toBeCloseTo(h.budget.spentUsd, 6);
  });

  it('records an image overrun and stops before another verifier or image request', async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ b64_json: imageBytes.toString('base64') }],
      usage: { input_tokens: 400, output_tokens: 100000, input_tokens_details: { text_tokens: 400 } },
    }), { status: 200 }));
    const h = await harness(fetcher, { maxUsd: 10 });
    await expect(h.ctx.artProvider!.generateArt(request))
      .rejects.toMatchObject({ code: 'STUDIO_BUDGET_RESERVATION_EXCEEDED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(h.outcomes).toMatchObject([{ usdEstimate: 3.002, status: 'ok', costBasis: 'usage' }]);
    expect(h.budget.spentUsd).toBe(3.002);
  });

  it('holds a lost vision reply after saving the image receipt, without fallback or another image', async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    const fetcher = vi.fn<typeof fetch>(async url => {
      if (String(url).includes('/images/')) return imageResponse();
      throw new TypeError('synthetic lost vision reply');
    });
    const h = await harness(fetcher);
    await expect(h.ctx.artProvider!.generateArt(request)).rejects.toMatchObject({ isUncertain: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(h.outcomes).toMatchObject([{ status: 'ok' }, { status: 'uncertain' }]);
    expect(h.budget.spentUsd).toBeCloseTo(0.032, 6);
  });

  it('counts verification towards the call cap and refuses a second image at the boundary', async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    const fetcher = vi.fn<typeof fetch>(async url => String(url).includes('/images/') ? imageResponse() : visionResponse(true));
    const h = await harness(fetcher, { maxCalls: 2 });
    await expect(h.ctx.artProvider!.generateArt(request)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(h.outcomes).toHaveLength(2);
  });

  it('stops before vision or another image if saving the first paid receipt fails', async () => {
    const fetcher = vi.fn<typeof fetch>(async url => String(url).includes('/images/') ? imageResponse() : visionResponse());
    const h = await harness(fetcher, { failFinalize: true });
    await expect(h.ctx.artProvider!.generateArt(request)).rejects.toMatchObject({ code: 'MODEL_CALL_ACCOUNTING_FAILED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses all transport when durable image admission fails', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const h = await harness(fetcher, { failAdmission: true });
    await expect(h.ctx.artProvider!.generateArt(request)).rejects.toMatchObject({ code: 'MODEL_CALL_ACCOUNTING_FAILED' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.outcomes).toHaveLength(0);
  });

  it('keeps the image receipt and stops when its budget snapshot cannot be saved', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => imageResponse());
    const h = await harness(fetcher, { failSpend: true });
    await expect(h.ctx.artProvider!.generateArt(request)).rejects.toMatchObject({ code: 'MODEL_CALL_ACCOUNTING_FAILED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(h.outcomes).toMatchObject([{ status: 'ok', usdEstimate: 0.032 }]);
  });

  it('checks the recorded USD threshold before the verifier dispatch', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => imageResponse());
    const h = await harness(fetcher, { maxUsd: 0.032 });
    await expect(h.ctx.artProvider!.generateArt(request)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(h.outcomes).toMatchObject([{ status: 'ok', usdEstimate: 0.032 }]);
  });

  it('records both generations and both verdicts when the first image needs replacement', async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    let verdicts = 0;
    const fetcher = vi.fn<typeof fetch>(async url => String(url).includes('/images/')
      ? imageResponse() : visionResponse(++verdicts === 1));
    const h = await harness(fetcher);
    const art = await h.ctx.artProvider!.generateArt(request);
    expect(art.receipt.provider).toBe('openai');
    expect(art.receipt.attempts).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(h.outcomes).toHaveLength(4);
    expect(h.admissions.map(c => c.callOrdinal)).toEqual([1, 2, 3, 4]);
    expect(new Set(h.admissions.map(c => c.logicalCallSha256)).size).toBe(4);
    expect(art.receipt.costUsd).toBeCloseTo(0.104, 6);
    expect(h.budget.spentUsd).toBeCloseTo(art.receipt.costUsd, 6);
  });
});
