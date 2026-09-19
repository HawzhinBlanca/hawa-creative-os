import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  sql,
  withRlsContext,
  type Database,
  type Kysely,
  DesignStudioRepository,
  type DesignStudioStatus,
  type DesignStudioTier,
  type DesignStudioJudgeStatus,
  type DesignStudioCandidateStatus,
} from '@hawa/db';
import {
  OpenAiStudioClient,
  OpenAiImageProvider,
  type StudioLayoutV2,
  ExemplarRetrievalIndex,
  studioReferenceFromRaw,
} from '@hawa/creative';
import { checkCanvaPptx } from '@hawa/qa';
import { resolveModel, resolveImageSettings } from '@hawa/domain';
import { resolveOrnamentSettings, type OrnamentSettings } from '@hawa/creative';
import { requestedBackgroundFor } from './stages/brief.stage.js';

/** The owner's ornament settings; an invalid one is reported and the defaults stand. */
const ornamentSettings = (): OrnamentSettings => {
  try {
    return resolveOrnamentSettings();
  } catch (err) {
    console.error('[studio] ornament settings invalid, using the defaults:', err instanceof Error ? err.message : err);
    return resolveOrnamentSettings({});
  }
};

/** A run's stage record, whether the driver returned JSON or text. */
const runStages = (run: { stages?: unknown }): Record<string, any> => {
  if (typeof run.stages !== 'string') return (run.stages as Record<string, any>) || {};
  try { return JSON.parse(run.stages); } catch { return {}; }
};
import { CanvaConnectService, CanvaFlowError } from '../canva-connect-service.js';
import { CanvaDesignPlanner, savedDesignCopy, classifyCopyScript } from '../canva-design-planner.js';
import { runsPipelineV3 } from '../chat-intake.js';
import { StudioBudgetExhaustedError, type StageContext, type CandidateState, type CreativeBrief, type Concept, type ReferencePack, type CopyBlock, type ParityResult } from './types.js';
import {
  runBriefStage,
  runConceptsStage,
  runLayoutsStage,
  runArtStage,
  runRenderStage,
  runCritiqueStage,
  runReviseStage,
  runTournamentStage,
  runCanaryStage,
  runQAStage,
  runTransferStage,
  runParityStage,
  runCritiqueStageV3,
  runReviseStageV3,
  runJudgeStageV3,
  rankStudioCandidatesV3,
  V3_CANDIDATE_SLOTS,
  pendingV3Concept,
} from './stages/index.js';

export type Scope = { tenantId: string; actorId: string };

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/**
 * The official KAAE logo's path, from the repository in development and from /app in the image,
 * where the compiled file sits one directory deeper than its source. The stage context used a single
 * relative path that resolved to /app/apps/packages/... in production, found nothing there, and
 * every studio design reached Canva with its logo box empty (both pilots of 2026-09-18).
 */
export function officialLogoPath(): string {
  const candidates = [
    resolve(process.cwd(), 'packages/creative/assets/logos/kaae-official-logo.png'),
    resolve(process.cwd(), '../../packages/creative/assets/logos/kaae-official-logo.png'),
    new URL('../../../../../packages/creative/assets/logos/kaae-official-logo.png', import.meta.url).pathname,
    new URL('../../../../packages/creative/assets/logos/kaae-official-logo.png', import.meta.url).pathname,
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Could not find kaae-official-logo.png');
  return found;
}

/**
 * Whether a run executes the v3 pipeline. The run's own record decides — it was fixed when the run
 * was created, from the chat the task came from. The global flag is honoured too, which covers runs
 * created before the decision was recorded.
 */
export function isPipelineV3Run(run: { request?: unknown }): boolean {
  const request: any = typeof run?.request === 'string' ? JSON.parse(run.request) : run?.request;
  return request?.pipelineV3 === true || process.env.DESIGN_PIPELINE_V3 === 'on';
}

export interface CreateStudioRunInput {
  width: number;
  height: number;
  tier?: 'standard' | 'premium';
  imagery?: 'auto' | 'none' | 'generated';
  previews?: number;
  holdForSelection?: boolean;
}

export interface DesignStudioServiceOptions {
  apiKey?: string;
  geminiApiKey?: string;
  fetcher?: typeof fetch;
  maxUsd?: number;
  maxCalls?: number;
  defaultTier?: 'standard' | 'premium';
  defaultImagery?: 'auto' | 'none' | 'generated';
  planner?: CanvaDesignPlanner;
  maxRetries?: number;
  /** Minutes without a write after which an unfinished run no longer holds a studio slot. */
  staleRunMinutes?: number;
}

export interface StudioResumeResult {
  runId: string;
  status: DesignStudioStatus;
  stage?: string;
  spentUsd?: number;
  planId?: string;
  designId?: string;
  message?: string;
  diagnostic?: string;
  winnerCandidateId?: string;
  judgeStatus?: DesignStudioJudgeStatus;
}

export class DesignStudioService {
  private repo: DesignStudioRepository;
  private inFlightResumes = new Map<string, Promise<StudioResumeResult>>();

  constructor(
    private db: Kysely<Database>,
    private canva?: CanvaConnectService,
    private options: DesignStudioServiceOptions = {}
  ) {
    this.repo = new DesignStudioRepository(db);
  }

  private tx<T>(s: Scope, fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
    return withRlsContext(this.db, { tenantId: s.tenantId, userId: s.actorId, role: 'operator' }, fn);
  }

  /**
   * Builds the request context from task data, brand reference pack, and logo.
   */
  /** The image saved with the task at intake, as a data: URL, or undefined. */
  private async attachedImage(s: Scope, taskId: string): Promise<string | undefined> {
    const source = await this.tx(s, async (db) =>
      (
        await sql<any>`SELECT e.data FROM hawa.task_events e
        WHERE e.tenant_id=${s.tenantId}::uuid AND e.task_id=${taskId}::uuid AND e.event_type='task.created'
        ORDER BY e.aggregate_version LIMIT 1`.execute(db)
      ).rows[0]?.data
    );
    const payload = source?.payload || source || {};
    const url = payload.studioOptions?.referenceImageBase64 || payload.referenceImageBase64;
    return typeof url === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(url) ? url : undefined;
  }

  private async getTaskContext(s: Scope, taskId: string, width: number, height: number) {
    if (![width, height].every((n) => Number.isInteger(n) && n >= 640 && n <= 2400)) {
      throw new CanvaFlowError(422, 'DIMENSIONS_REQUIRED', 'Choose dimensions between 640 and 2400 pixels.');
    }

    const task = await this.tx(s, async (db) =>
      (
        await sql<any>`SELECT t.client_id, t.description,
        (SELECT e.data FROM hawa.task_events e WHERE e.task_id=t.id AND e.tenant_id=t.tenant_id AND e.event_type='task.created' ORDER BY e.aggregate_version LIMIT 1) AS source
        FROM hawa.tasks t WHERE t.tenant_id=${s.tenantId}::uuid AND t.id=${taskId}::uuid`.execute(db)
      ).rows[0]
    );

    if (!task?.client_id) {
      throw new CanvaFlowError(422, 'CLIENT_REQUIRED', 'Select the client before retrieving brand references.');
    }

    const refCandidates = [
      resolve(process.cwd(), 'packages/creative/assets/kaae-reference.json'),
      resolve(process.cwd(), '../../packages/creative/assets/kaae-reference.json'),
      new URL('../../../../../packages/creative/assets/kaae-reference.json', import.meta.url).pathname,
      new URL('../../../../packages/creative/assets/kaae-reference.json', import.meta.url).pathname,
    ];
    const refPath = refCandidates.find((p) => existsSync(p));
    if (!refPath) throw new Error('Could not find kaae-reference.json');

    const reference: ReferencePack & { clientId: string; logoSha256: string } = JSON.parse(
      await readFile(refPath, 'utf8')
    );

    if (task.client_id !== reference.clientId) {
      throw new CanvaFlowError(
        422,
        'CLIENT_REFERENCE_REQUIRED',
        'This client needs its own verified reference pack. KAAE references cannot be used for another client.'
      );
    }

    const content = savedDesignCopy(task.source, task.description || '');
    if (!content.copy.length || content.copy.join('').length > 16000) {
      throw new CanvaFlowError(422, 'COPY_UNSUPPORTED', 'This transfer supports bounded copy only. Review the source before generating.');
    }

    const copyScripts = content.copy.map(classifyCopyScript);
    if (copyScripts.includes('unsupported')) {
      throw new CanvaFlowError(
        422,
        'COPY_UNSUPPORTED',
        'This transfer sets English and Sorani Kurdish copy only; the request contains other scripts or symbols.'
      );
    }

    const logo = await readFile(officialLogoPath());
    if (hash(logo) !== reference.logoSha256) {
      throw new CanvaFlowError(409, 'LOGO_CHANGED', 'The official logo checksum changed; review the reference pack.');
    }

    const copyBlocks: CopyBlock[] = content.copy.map((text, idx) => ({
      text,
      script: copyScripts[idx] === 'arabic' ? 'arabic' : 'latin',
    }));

    return {
      task,
      reference,
      content,
      copyBlocks,
      copyScripts,
      logo,
      logoAspect: logo.readUInt32BE(16) / (logo.readUInt32BE(20) || 1),
    };
  }

  /**
   * Claims or retrieves a design studio run with advisory locking, RLS isolation, and idempotency.
   */
  public async createOrGetRun(
    s: Scope,
    taskId: string,
    key: string,
    params: CreateStudioRunInput
  ): Promise<{ run: any; created: boolean }> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
      throw new CanvaFlowError(422, 'REQUEST_KEY_REQUIRED', 'Use a stable studio generation request key (8-128 chars).');
    }

    const tier: DesignStudioTier =
      params.tier ||
      this.options.defaultTier ||
      (process.env.DESIGN_STUDIO_TIER_DEFAULT === 'standard' ? 'standard' : 'premium');

    const imagery =
      params.imagery ||
      this.options.defaultImagery ||
      (process.env.DESIGN_STUDIO_IMAGERY_DEFAULT as any) ||
      'auto';

    const taskCtx = await this.getTaskContext(s, taskId, params.width, params.height);

    // Which pipeline a run uses is decided once, here, from the chat the task came from, and
    // recorded on the run so every later stage and every resume agrees. The key is omitted rather
    // than written false so a non-v3 run's request hash is unchanged from before it existed.
    const pipelineV3 = runsPipelineV3(taskCtx.task.source?.sourceChannelId);

    const requestPayload = {
      width: params.width,
      height: params.height,
      tier,
      imagery,
      previews: params.previews || 1,
      holdForSelection: Boolean(params.holdForSelection),
      copyBlocks: taskCtx.copyBlocks,
      instructions: taskCtx.content.instructions,
      clientId: taskCtx.task.client_id,
      referenceHash: hash(JSON.stringify(taskCtx.reference)),
      logoSha256: hash(taskCtx.logo),
      logoAspect: taskCtx.logoAspect,
      ...(pipelineV3 ? { pipelineV3: true } : {}),
    };

    const requestHash = hash(JSON.stringify(requestPayload));

    return this.tx(s, async (db) => {
      // 1. Transaction-level advisory lock per tenant
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'design-studio:' + s.tenantId}, 0))`.execute(db);

      // 2. Lock task row FOR UPDATE to verify client scope immutability
      const lockedTask = (
        await sql<any>`SELECT client_id FROM hawa.tasks WHERE tenant_id=${s.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`.execute(db)
      ).rows[0];

      if (!lockedTask || lockedTask.client_id !== taskCtx.task.client_id) {
        throw new CanvaFlowError(409, 'CLIENT_CHANGED', 'Client changed while references were retrieved.');
      }

      // 3. Check for existing run by request_key OR in-flight active run for this task.
      // A task keeps at most one unfinished run however old (unique index design_studio_one_active_run):
      // it is resumed or abandoned, never silently replaced.
      const prior = (
        await sql<any>`SELECT * FROM hawa.design_studio_runs 
        WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid 
          AND (request_key=${key} OR status NOT IN ('transferred', 'degraded', 'failed', 'abandoned'))
        ORDER BY created_at DESC LIMIT 1`.execute(db)
      ).rows[0];

      if (prior) {
        if (prior.request_key === key) {
          if (prior.request_hash !== requestHash || prior.actor_id !== s.actorId) {
            throw new CanvaFlowError(409, 'GENERATION_CONFLICT', 'A different generation already exists with this key.');
          }
          return { run: prior, created: false };
        }

        // Different key, but an active run is in flight
        throw new CanvaFlowError(
          409,
          'STUDIO_RUN_IN_PROGRESS',
          'A studio run is already in progress for this task. Resume or abandon it before starting another.'
        );
      }

      // 4. Verify task is not already bound to Canva
      const bound = (
        await sql`SELECT id FROM hawa.canva_bindings WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid`.execute(db)
      ).rows;
      if (bound.length > 0) {
        throw new CanvaFlowError(409, 'CANVA_ALREADY_BOUND', 'Edit the existing Canva design; studio generation never overwrites it.');
      }

      // 5. Concurrency check: max 2 active studio runs per tenant.
      // A whole run takes minutes and writes on every stage. One left unadvanced (a Desk run nobody
      // resumed, a run cut off by a crash) stops holding a tenant slot, so it cannot block other tasks.
      const staleMinutes = this.options.staleRunMinutes ?? 30;
      const activeRuns = (
        await sql<any>`SELECT count(*) AS n FROM hawa.design_studio_runs 
        WHERE tenant_id=${s.tenantId}::uuid AND status NOT IN ('transferred', 'degraded', 'failed', 'abandoned')
          AND updated_at > now() - make_interval(mins => ${staleMinutes})`.execute(db)
      ).rows[0];

      if (Number(activeRuns.n) >= 2) {
        throw new CanvaFlowError(
          429,
          'STUDIO_BUSY',
          'Two studio designs are already in progress. Resume existing work before starting another.'
        );
      }

      // 6. Ensure model API key or fetcher is configured
      const apiKey = this.options.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey && !this.options.fetcher) {
        throw new CanvaFlowError(503, 'MODEL_NOT_CONFIGURED', 'Configure the requested design model first.');
      }

      // 7. Create run record
      const runId = randomUUID();
      const maxUsd =
        this.options.maxUsd ||
        (process.env.DESIGN_STUDIO_MAX_USD ? parseFloat(process.env.DESIGN_STUDIO_MAX_USD) : 6.0);
      const maxCalls =
        this.options.maxCalls ||
        (process.env.DESIGN_STUDIO_MAX_CALLS ? parseInt(process.env.DESIGN_STUDIO_MAX_CALLS, 10) : 40);

      const budget = {
        maxUsd,
        maxCalls,
        spentUsd: 0.0,
        calls: 0,
      };

      const [run] = await db
        .insertInto('design_studio_runs')
        .values({
          id: runId,
          tenant_id: s.tenantId,
          task_id: taskId,
          client_id: taskCtx.task.client_id,
          actor_id: s.actorId,
          request_key: key,
          request_hash: requestHash,
          request: JSON.stringify(requestPayload),
          tier,
          status: 'briefing',
          budget: JSON.stringify(budget),
          stages: JSON.stringify({}),
        })
        .returningAll()
        .execute();

      return { run, created: true };
    });
  }

  /**
   * Builds the StageContext with wrapped clients that enforce ledger-insert-before-dispatch and budget caps.
   */
  private createStageContext(
    s: Scope,
    run: any,
    currentStageName: string,
    currentBudget: { maxUsd: number; maxCalls: number; spentUsd: number; calls: number },
    onSpendUpdate: (cost: number) => Promise<void>
  ): StageContext {
    const request = typeof run.request === 'string' ? JSON.parse(run.request) : run.request;
    const fetchFn = this.options.fetcher || fetch;
    const apiKey = this.options.apiKey || process.env.OPENAI_API_KEY || 'mock-key';

    const baseClient = new OpenAiStudioClient({
      apiKey,
      fetcher: fetchFn,
      timeoutMs: 240000,
    });

    const baseArtProvider = new OpenAiImageProvider(apiKey, fetchFn);

    // Instrument client with ledger hooks and budget checks
    const ledgerClient: any = {
      calculateCost: baseClient.calculateCost.bind(baseClient),
      circuitBreaker: baseClient.circuitBreaker,
      primaryModel: baseClient.primaryModel,
      fallbackModel: baseClient.fallbackModel,
      completeJson: async <T>(params: any): Promise<any> => {
        // Check budget before dispatch
        if (currentBudget.spentUsd >= currentBudget.maxUsd || currentBudget.calls >= currentBudget.maxCalls) {
          throw new StudioBudgetExhaustedError('BUDGET_EXHAUSTED');
        }

        const callId = randomUUID();
        const model = params.model || baseClient.primaryModel || resolveModel('text');

        // Ledger insert-before-dispatch
        await this.repo.recordCallStart({
          id: callId,
          runId: run.id,
          tenantId: s.tenantId,
          stage: currentStageName,
          provider: 'openai',
          model,
          requestedModel: model,
        });
        currentBudget.calls++;

        try {
          const result = await baseClient.completeJson<T>(params);
          const cost = result.receipt.costUsd || baseClient.calculateCost(result.receipt.model, {
            input_tokens: result.receipt.inputTokens,
            output_tokens: result.receipt.outputTokens,
          });

          await this.repo.finalizeCall({
            id: callId,
            tenantId: s.tenantId,
            responseId: result.receipt.id,
            inputTokens: result.receipt.inputTokens,
            cachedInputTokens: result.receipt.cacheReadTokens || 0,
            outputTokens: result.receipt.outputTokens,
            usdEstimate: cost,
            status: 'ok',
          });

          await onSpendUpdate(cost);
          return result;
        } catch (err: any) {
          await this.repo.finalizeCall({
            id: callId,
            tenantId: s.tenantId,
            inputTokens: 0,
            outputTokens: 0,
            usdEstimate: 0,
            status: 'error',
            errorCode: err.message || 'CALL_FAILED',
          });
          throw err;
        }
      },
      createStructuredCompletion: async <T>(params: any): Promise<any> => {
        if (currentBudget.spentUsd >= currentBudget.maxUsd || currentBudget.calls >= currentBudget.maxCalls) {
          throw new StudioBudgetExhaustedError('BUDGET_EXHAUSTED');
        }

        const callId = randomUUID();
        const model = params.model || baseClient.primaryModel || resolveModel('text');

        await this.repo.recordCallStart({
          id: callId,
          runId: run.id,
          tenantId: s.tenantId,
          stage: currentStageName,
          provider: 'openai',
          model,
          requestedModel: model,
        });
        currentBudget.calls++;

        try {
          const result = await baseClient.createStructuredCompletion<T>(params);
          const cost = result.receipt.costUsd || baseClient.calculateCost(result.receipt.model, {
            input_tokens: result.receipt.inputTokens,
            output_tokens: result.receipt.outputTokens,
          });

          await this.repo.finalizeCall({
            id: callId,
            tenantId: s.tenantId,
            responseId: result.receipt.id || result.receipt.responseId,
            inputTokens: result.receipt.inputTokens,
            cachedInputTokens: result.receipt.cacheReadTokens || 0,
            outputTokens: result.receipt.outputTokens,
            usdEstimate: cost,
            status: 'ok',
          });

          await onSpendUpdate(cost);
          return result;
        } catch (err: any) {
          await this.repo.finalizeCall({
            id: callId,
            tenantId: s.tenantId,
            inputTokens: 0,
            outputTokens: 0,
            usdEstimate: 0,
            status: 'error',
            errorCode: err.message || 'CALL_FAILED',
          });
          throw err;
        }
      },
    };

    const ledgerArtProvider: any = {
      generateArt: async (params: any): Promise<any> => {
        if (currentBudget.spentUsd >= currentBudget.maxUsd || currentBudget.calls >= currentBudget.maxCalls) {
          throw new StudioBudgetExhaustedError('BUDGET_EXHAUSTED');
        }

        // The configured provider and model (HAWA_IMAGE_*), resolved once so the ledger and the
        // request agree. An invalid setting throws here, and the art stage falls back to a motif.
        const settings = resolveImageSettings();
        const callId = randomUUID();
        await this.repo.recordCallStart({
          id: callId,
          runId: run.id,
          tenantId: s.tenantId,
          stage: 'art',
          provider: settings.provider,
          model: settings.model,
          requestedModel: settings.model,
        });
        currentBudget.calls++;

        try {
          const result = await baseArtProvider.generateArt({ ...params, settings });
          // What the provider billed, across every attempt; never a made-up figure.
          const cost = Number(result.receipt?.costUsd ?? 0);

          await this.repo.finalizeCall({
            id: callId,
            tenantId: s.tenantId,
            responseId: result.receipt?.responseId || `${result.receipt?.provider || settings.provider}_art`,
            inputTokens: 0,
            outputTokens: 0,
            images: 1,
            usdEstimate: cost,
            status: 'ok',
          });

          await onSpendUpdate(cost);
          return result;
        } catch (err: any) {
          await this.repo.finalizeCall({
            id: callId,
            tenantId: s.tenantId,
            inputTokens: 0,
            outputTokens: 0,
            usdEstimate: 0,
            status: 'error',
            errorCode: err.message || 'ART_FAILED',
          });
          throw err;
        }
      },
    };

    let referencePack: ReferencePack = {
      palette: [
        '#0A1628',
        '#1E3A5F',
        '#4770A3',
        '#F7B500',
        '#FDF8F3',
        '#FFFFFF',
        '#1A1A1A',
      ],
      referenceFonts: {
        latin: 'Verdana',
        arabic: 'Noto Sans Arabic',
      },
    };
    let promotedRules = 'Keep title clear and centered. Do not crowd logo. Preserve hierarchy.';
    let latinFont = 'Verdana';
    let arabicFont = 'Noto Sans Arabic';

    try {
      const refCandidates = [
        resolve(process.cwd(), 'packages/creative/assets/kaae-reference.json'),
        resolve(import.meta.dirname, '../../../../packages/creative/assets/kaae-reference.json'),
        new URL('../../../../packages/creative/assets/kaae-reference.json', import.meta.url).pathname,
      ];
      const refPath = refCandidates.find((p) => existsSync(p));
      if (refPath) {
        const rawRef = JSON.parse(readFileSync(refPath, 'utf8'));
        // Read the way the qualification reads it (shared), so both design with the same rules.
        const rules = studioReferenceFromRaw(rawRef);
        referencePack.palette = rules.palette;
        latinFont = rules.latinFont;
        arabicFont = rules.arabicFont;
        promotedRules = rules.promotedRules;
        if (rawRef.rules?.fontFamily) {
          referencePack.referenceFonts = { latin: rules.latinFont, arabic: rules.arabicFont };
        }
      }
    } catch (err: any) {
      // Silently falling back meant a client's own script font and colour rules could stop
      // applying with nothing in the logs to say so, and the design would look generic for a
      // reason no one could trace.
      console.warn(
        `[design-studio] Reference pack could not be read (${err?.message || err}); ` +
          `falling back to default typography and colour rules for this design.`
      );
    }

    const exemplars: Array<{ path: string; label: string; sha256?: string; bytes?: Buffer; mimeType?: string }> = [];
    try {
      const retrievalIndex = new ExemplarRetrievalIndex();
      const briefQuery = {
        text: (s as any).instructions || (s as any).title || (run as any).title || '',
        format: (s as any).format,
        category: (s as any).topic,
      };
      const retrieval = retrievalIndex.retrieveTopExemplars(briefQuery, 3);
      for (const item of retrieval.retrievedExemplars) {
        const itemCandidates = [
          resolve(process.cwd(), item.path),
          resolve(process.cwd(), 'packages/creative/assets/exemplars', item.filename),
          resolve(import.meta.dirname, '../../../../', item.path),
          resolve(import.meta.dirname, '../../../../packages/creative/assets/exemplars', item.filename),
        ];
        const imgPath = itemCandidates.find((p) => existsSync(p));
        if (imgPath) {
          exemplars.push({
            path: imgPath,
            label: item.filename || item.descriptor || 'KAAE Exemplar',
            bytes: readFileSync(imgPath),
            mimeType: 'image/png',
          });
        }
      }
    } catch (err: any) {
      console.warn(
        `[design-studio] Exemplar images could not be loaded (${err?.message || err}); ` +
          `this design is being generated without exemplar conditioning.`
      );
    }

    // A KAAE design without the KAAE logo is not deliverable, so a missing or changed logo stops the
    // run. It used to pass silently: the only path tried did not exist in the image, and the design
    // went to Canva with the logo box empty.
    const logoBytes = readFileSync(officialLogoPath());
    const logoSha256 = createHash('sha256').update(logoBytes).digest('hex');
    if (request.logoSha256 && logoSha256 !== request.logoSha256) {
      throw new CanvaFlowError(409, 'LOGO_CHANGED', 'The official logo changed after this run started; review the reference pack.');
    }
    const logo = { bytes: logoBytes, sha256: logoSha256, mimeType: 'image/png' as const };

    return {
      runId: run.id,
      tenantId: s.tenantId,
      taskId: run.task_id,
      clientId: run.client_id,
      actorId: s.actorId,
      width: request.width,
      height: request.height,
      tier: run.tier as any,
      instructions: request.instructions,
      copyBlocks: request.copyBlocks,
      referencePack,
      promotedRules,
      latinFont,
      arabicFont,
      logoAspect: request.logoAspect || 1.0,
      logo,
      exemplars,
      client: ledgerClient as any,
      artProvider: ledgerArtProvider as any,
      pipelineV3: isPipelineV3Run(run),
      requestedBackground: requestedBackgroundFor(runStages(run).brief, referencePack.palette),
      ornament: ornamentSettings(),
    };
  }

  /**
   * Advances a design studio run by exactly one stage.
   * Interrupted runs resume from the current stage without duplicating prior stage calls.
   * Concurrent requests for the same run share the in-flight promise to prevent race conditions.
   */
  public async resume(s: Scope, taskId: string, runId: string): Promise<StudioResumeResult> {
    const lockKey = `${s.tenantId}:${runId}`;
    const existing = this.inFlightResumes.get(lockKey);
    if (existing) {
      return await existing;
    }
    const execPromise = this.doResume(s, taskId, runId);
    this.inFlightResumes.set(lockKey, execPromise);
    try {
      return await execPromise;
    } finally {
      this.inFlightResumes.delete(lockKey);
    }
  }

  private async doResume(s: Scope, taskId: string, runId: string): Promise<StudioResumeResult> {
    const run = await this.repo.getRunById(runId, s.tenantId);
    if (!run) {
      throw new CanvaFlowError(404, 'RUN_NOT_FOUND', 'Studio run not found.');
    }

    // Terminal statuses
    if (['transferred', 'degraded', 'failed', 'abandoned'].includes(run.status)) {
      return {
        runId,
        status: run.status,
        planId: run.plan_id || undefined,
        message: run.diagnostic || `Run is ${run.status}.`,
        diagnostic: run.diagnostic || undefined,
      };
    }

    if (run.status === 'awaiting_selection') {
      return {
        runId,
        status: 'awaiting_selection',
        message: 'Awaiting candidate selection before Canva transfer.',
      };
    }

    const stages: Record<string, any> =
      typeof run.stages === 'string' ? JSON.parse(run.stages || '{}') : run.stages || {};
    const budget: { maxUsd: number; maxCalls: number; spentUsd: number; calls: number } =
      typeof run.budget === 'string' ? JSON.parse(run.budget) : run.budget;

    const onSpendUpdate = async (cost: number) => {
      budget.spentUsd += cost;
      await this.repo.updateRunStatus(runId, s.tenantId, run.status, { budget });
    };

    const ctx = this.createStageContext(s, run, run.status, budget, onSpendUpdate);
    // An image the requester attached reaches the brief, which says what it is; a style reference
    // then reaches the layout generator, the critique and the judge. It was saved with every
    // Telegram task but only the legacy planner ever read it.
    ctx.attachedImage = await this.attachedImage(s, run.task_id);
    const briefSoFar = runStages(run).brief as CreativeBrief | undefined;
    if (ctx.attachedImage && briefSoFar?.referenceRole === 'style_reference') {
      ctx.reference = { dataUrl: ctx.attachedImage, notes: briefSoFar.referenceNotes || '' };
    }

    try {
      switch (run.status) {
        case 'briefing': {
          const brief = await runBriefStage(ctx);
          stages.brief = brief;
          await this.repo.updateRunStatus(runId, s.tenantId, 'conceiving', { stages, budget });
          return { runId, status: 'conceiving', stage: 'brief', spentUsd: budget.spentUsd };
        }

        case 'conceiving': {
          const brief: CreativeBrief = stages.brief;
          // A v3 run's layout call invents its own three archetypes and never reads these
          // concepts, so it spends nothing here: it reserves a row per layout the generator
          // returns, and each row's concept is filled from what the generator produced.
          const concepts = ctx.pipelineV3 ? [] : await runConceptsStage(ctx, brief);
          stages.concepts = concepts;
          const slots = ctx.pipelineV3 ? V3_CANDIDATE_SLOTS : concepts.length;

          // Create candidates in DB
          for (let i = 0; i < slots; i++) {
            await this.repo.insertCandidate({
              id: randomUUID(),
              runId: run.id,
              tenantId: s.tenantId,
              ordinal: i,
              concept: (concepts[i] ?? pendingV3Concept(i)) as any,
              status: 'draft',
            });
          }

          await this.repo.updateRunStatus(runId, s.tenantId, 'laying_out', { stages, budget });
          return { runId, status: 'laying_out', stage: 'concepts', spentUsd: budget.spentUsd };
        }

        case 'laying_out': {
          const brief: CreativeBrief = stages.brief;
          const concepts: Concept[] = stages.concepts;
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);

          const candidateStates = await runLayoutsStage(
            ctx,
            brief,
            concepts,
            candidateRows.map((r) => ({ id: r.id, ordinal: r.ordinal }))
          );
          const artCandidates = await runArtStage(ctx, candidateStates);

          for (const row of candidateRows) {
            const cand = artCandidates.find((c) => c.ordinal === row.ordinal);
            if (cand) {
              await this.repo.updateCandidate(row.id, s.tenantId, {
                layouts: [cand.currentLayout] as any,
                status: 'draft',
                artPng: cand.artPng,
                artSha256: cand.artSha256,
                artProvenance: cand.artProvenance as any,
                ...(ctx.pipelineV3 ? { concept: cand.concept as any } : {}),
              });
            } else {
              await this.repo.updateCandidate(row.id, s.tenantId, {
                status: 'eliminated',
              });
            }
          }

          stages.layouts = { count: artCandidates.length };
          await this.repo.updateRunStatus(runId, s.tenantId, 'rendering', { stages, budget });
          return { runId, status: 'rendering', stage: 'layouts', spentUsd: budget.spentUsd };
        }

        case 'rendering': {
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
          const activeRows = candidateRows.filter(
            (row) => row.status !== 'eliminated' && Array.isArray(row.layouts) && row.layouts.length > 0
          );
          if (activeRows.length === 0) {
            return this.executeRung4Fallback(s, run, 'No valid candidates with layouts for rendering');
          }

          const candidateStates: CandidateState[] = activeRows.map((row) => {
            const layouts = (row.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
            return {
              id: row.id,
              ordinal: row.ordinal,
              concept: typeof row.concept === 'string' ? JSON.parse(row.concept) : row.concept,
              layouts,
              currentLayout: layouts[layouts.length - 1],
              critiques: [],
              status: row.status as DesignStudioCandidateStatus,
              artPng: row.art_png ? Buffer.from(row.art_png) : undefined,
            };
          });

          const renderedCandidates = await runRenderStage(ctx, candidateStates);
          for (let i = 0; i < renderedCandidates.length; i++) {
            const cand = renderedCandidates[i];
            await this.repo.updateCandidate(cand.id, s.tenantId, {
              previewPng: cand.previewPng,
              previewSha256: cand.previewSha256,
              compositePng: cand.compositePng,
              metrics: cand.metrics as any,
            });
          }

          stages.render = { count: renderedCandidates.length };
          await this.repo.updateRunStatus(runId, s.tenantId, 'critiquing', { stages, budget });
          return { runId, status: 'critiquing', stage: 'render', spentUsd: budget.spentUsd };
        }

        case 'critiquing': {
          const brief: CreativeBrief = stages.brief;
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
          const activeRows = candidateRows.filter(
            (row) => row.status !== 'eliminated' && Array.isArray(row.layouts) && row.layouts.length > 0
          );
          if (activeRows.length === 0) {
            return this.executeRung4Fallback(s, run, 'No valid candidates for critiquing');
          }

          const candidateStates: CandidateState[] = activeRows.map((row) => {
            const layouts = (row.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
            return {
              id: row.id,
              ordinal: row.ordinal,
              concept: typeof row.concept === 'string' ? JSON.parse(row.concept) : row.concept,
              layouts,
              currentLayout: layouts[layouts.length - 1],
              metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics,
              previewPng: row.preview_png ? Buffer.from(row.preview_png) : undefined,
              compositePng: row.composite_png ? Buffer.from(row.composite_png) : undefined,
              critiques: [],
              status: row.status as DesignStudioCandidateStatus,
            };
          });

          if (ctx.pipelineV3) {
            // P05, as the qualification runs it: one box-grounded critique of the top-ranked
            // candidate, rendered with its copy. Every candidate's score becomes its composite,
            // the measure v3 ranks on.
            try {
              const { candidate, critique, compositeScores } = await runCritiqueStageV3(ctx, candidateStates);
              const { annotatedPng, ...critiqueRecord } = critique;
              await this.repo.insertJudgment({
                id: randomUUID(),
                runId: run.id,
                tenantId: s.tenantId,
                kind: 'critique',
                candidateA: candidate.id,
                verdict: { pipeline: 'v3', ...critiqueRecord, annotatedSha256: hash(annotatedPng) } as any,
              });
              for (const cand of candidateStates) {
                await this.repo.updateCandidate(cand.id, s.tenantId, { score: compositeScores.get(cand.id) ?? null });
              }
              stages.critique = { completed: true, pipeline: 'v3', candidateId: candidate.id };
            } catch (err) {
              if (err instanceof StudioBudgetExhaustedError) throw err;
              // The critique informs the Desk; refinement critiques for itself. A missing one is
              // recorded, not fatal.
              const message = err instanceof Error ? err.message : String(err);
              stages.critique = { completed: false, pipeline: 'v3', error: message };
              await this.repo.updateRunStatus(runId, s.tenantId, 'revising', {
                stages,
                budget,
                diagnostic: `v3 critique unavailable: ${message}`,
              });
              return { runId, status: 'revising', stage: 'critique', spentUsd: budget.spentUsd };
            }
            await this.repo.updateRunStatus(runId, s.tenantId, 'revising', { stages, budget });
            return { runId, status: 'revising', stage: 'critique', spentUsd: budget.spentUsd };
          }

          let critiquedCandidates: CandidateState[];
          try {
            critiquedCandidates = await runCritiqueStage(ctx, brief, candidateStates);
          } catch (err) {
            // Rung 3: Critic unavailable -> skip critique, note judge unavailable
            await this.repo.updateRunStatus(runId, s.tenantId, 'revising', {
              judgeStatus: 'SKIPPED',
              diagnostic: 'Critic unavailable; skipped to layout revision.',
            });
            return { runId, status: 'revising', stage: 'critique', judgeStatus: 'SKIPPED' };
          }

          for (const cand of critiquedCandidates) {
            const critique = cand.critiques[cand.critiques.length - 1];
            if (critique) {
              await this.repo.insertJudgment({
                id: randomUUID(),
                runId: run.id,
                tenantId: s.tenantId,
                kind: 'critique',
                candidateA: cand.id,
                verdict: critique as any,
              });
              await this.repo.updateCandidate(cand.id, s.tenantId, {
                critiques: cand.critiques as any,
                score: cand.score,
              });
            }
          }

          stages.critique = { completed: true };
          await this.repo.updateRunStatus(runId, s.tenantId, 'revising', { stages, budget });
          return { runId, status: 'revising', stage: 'critique', spentUsd: budget.spentUsd };
        }

        case 'revising': {
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
          const activeRows = candidateRows.filter(
            (row) => row.status !== 'eliminated' && Array.isArray(row.layouts) && row.layouts.length > 0
          );
          if (activeRows.length === 0) {
            return this.executeRung4Fallback(s, run, 'No valid candidates for revising');
          }

          const candidateStates: CandidateState[] = activeRows.map((row) => {
            const layouts = (row.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
            const critiques = (row.critiques as any[] || []).map((c) => (typeof c === 'string' ? JSON.parse(c) : c));
            return {
              id: row.id,
              ordinal: row.ordinal,
              concept: typeof row.concept === 'string' ? JSON.parse(row.concept) : row.concept,
              layouts,
              currentLayout: layouts[layouts.length - 1],
              metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics,
              previewPng: row.preview_png ? Buffer.from(row.preview_png) : undefined,
              compositePng: row.composite_png ? Buffer.from(row.composite_png) : undefined,
              critiques,
              score: row.score ? parseFloat(row.score.toString()) : undefined,
              status: row.status as DesignStudioCandidateStatus,
            };
          });

          if (ctx.pipelineV3) {
            // P06, as the qualification runs it: the engine refines the top-ranked candidate only
            // if it fails a metric or sits below the band, and a repair is kept only if it
            // measures better. The outcome is recorded either way.
            try {
              const { candidate, outcome, layout } = await runReviseStageV3(ctx, candidateStates);
              stages.revise = {
                completed: true,
                pipeline: 'v3',
                candidateId: candidate.id,
                adopted: outcome.adopted,
                reason: outcome.reason,
                stopReason: outcome.result.stopReason,
                rounds: outcome.result.rounds.map((r) => ({
                  round: r.round,
                  preScore: r.preScore,
                  postScore: r.postScore,
                  stopReason: r.stopReason,
                  calls: r.calls.map((c) => ({ stage: c.stage, model: c.model, responseId: c.responseId, costUsd: c.costUsd })),
                })),
              };
              if (outcome.adopted) {
                const row = activeRows.find((r) => r.id === candidate.id);
                const [rendered] = await runRenderStage(ctx, [
                  {
                    ...candidate,
                    layouts: [...candidate.layouts, layout],
                    currentLayout: layout,
                    artPng: row?.art_png ? Buffer.from(row.art_png) : undefined,
                  },
                ]);
                await this.repo.updateCandidate(candidate.id, s.tenantId, {
                  layouts: rendered.layouts as any,
                  previewPng: rendered.previewPng,
                  previewSha256: rendered.previewSha256,
                  compositePng: rendered.compositePng,
                  metrics: rendered.metrics as any,
                  score: outcome.metrics.compositeScore,
                });
              }
            } catch (err) {
              if (err instanceof StudioBudgetExhaustedError) throw err;
              // The unrefined candidate still stands; the run records why it was not refined.
              stages.revise = { completed: false, pipeline: 'v3', error: err instanceof Error ? err.message : String(err) };
            }
            await this.repo.updateRunStatus(runId, s.tenantId, 'judging', { stages, budget });
            return { runId, status: 'judging', stage: 'revise', spentUsd: budget.spentUsd };
          }

          const revisedCandidates = await runReviseStage(ctx, candidateStates, 1);
          for (let i = 0; i < revisedCandidates.length; i++) {
            const cand = revisedCandidates[i];
            const originalRow = activeRows.find((r) => r.id === cand.id);
            if (originalRow && cand.layouts.length > (originalRow.layouts as any[]).length) {
              await this.repo.updateCandidate(cand.id, s.tenantId, {
                layouts: cand.layouts as any,
                previewPng: cand.previewPng,
                previewSha256: cand.previewSha256,
                compositePng: cand.compositePng,
                metrics: cand.metrics as any,
              });
            }
          }

          stages.revise = { completed: true };
          await this.repo.updateRunStatus(runId, s.tenantId, 'judging', { stages, budget });
          return { runId, status: 'judging', stage: 'revise', spentUsd: budget.spentUsd };
        }

        case 'judging': {
          const brief: CreativeBrief = stages.brief;
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
          const activeRows = candidateRows.filter(
            (row) => row.status !== 'eliminated' && Array.isArray(row.layouts) && row.layouts.length > 0
          );
          if (activeRows.length === 0) {
            return this.executeRung4Fallback(s, run, 'No valid candidates for judging');
          }

          const candidateStates: CandidateState[] = activeRows.map((row) => {
            const layouts = (row.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
            const critiques = (row.critiques as any[] || []).map((c) => (typeof c === 'string' ? JSON.parse(c) : c));
            return {
              id: row.id,
              ordinal: row.ordinal,
              concept: typeof row.concept === 'string' ? JSON.parse(row.concept) : row.concept,
              layouts,
              currentLayout: layouts[layouts.length - 1],
              metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics,
              previewPng: row.preview_png ? Buffer.from(row.preview_png) : undefined,
              compositePng: row.composite_png ? Buffer.from(row.composite_png) : undefined,
              critiques,
              score: row.score ? parseFloat(row.score.toString()) : undefined,
              status: row.status as DesignStudioCandidateStatus,
            };
          });

          if (ctx.pipelineV3) {
            return this.judgeV3(s, run, ctx, stages, budget, candidateStates);
          }

          let tournamentResult;
          try {
            tournamentResult = await runTournamentStage(ctx, brief, candidateStates);
          } catch (err) {
            // Rung 3: Judge unavailable -> rank by deterministic metrics
            const sorted = [...candidateStates].sort(
              (a, b) => (b.metrics?.alignmentScore || 0) - (a.metrics?.alignmentScore || 0)
            );
            const winner = sorted[0];
            await this.repo.updateRunStatus(runId, s.tenantId, 'qa', {
              winnerCandidateId: winner.id,
              judgeStatus: 'SKIPPED',
              diagnostic: 'Judge unavailable during tournament; ranked by layout metrics.',
            });
            return { runId, status: 'qa', stage: 'tournament', winnerCandidateId: winner.id };
          }

          // Record pairwise judgments
          for (const match of tournamentResult.pairwiseJudgments) {
            await this.repo.insertJudgment({
              id: randomUUID(),
              runId: run.id,
              tenantId: s.tenantId,
              kind: 'pairwise',
              candidateA: match.candidateAId,
              candidateB: match.candidateBId,
              orderSwapped: match.orderSwapped,
              verdict: match.verdict as any,
            });
          }

          // Update candidate statuses in DB
          const winnerCandidate = tournamentResult.winnerCandidate;
          for (const cand of candidateStates) {
            const isWinner = cand.id === winnerCandidate.id;
            await this.repo.updateCandidate(cand.id, s.tenantId, {
              status: isWinner ? 'winner' : 'runner_up',
              rank: isWinner ? 1 : 2,
            });
          }

          // Execute Canary Stage on winner
          let canaryPassed = true;
          try {
            const canaryResult = await runCanaryStage(ctx, brief, winnerCandidate);
            canaryPassed = canaryResult.passed;

            await this.repo.insertJudgment({
              id: randomUUID(),
              runId: run.id,
              tenantId: s.tenantId,
              kind: 'canary',
              candidateA: winnerCandidate.id,
              verdict: canaryResult as any,
            });
          } catch (err) {
            canaryPassed = false;
          }

          const judgeStatus: DesignStudioJudgeStatus = canaryPassed ? 'RELIABLE' : 'UNRELIABLE';
          stages.tournament = { winnerId: winnerCandidate.id };
          stages.canary = { passed: canaryPassed };

          await this.repo.updateRunStatus(runId, s.tenantId, 'qa', {
            stages,
            budget,
            winnerCandidateId: winnerCandidate.id,
            judgeStatus,
            diagnostic: canaryPassed ? null : 'Canary detected visual judge degradation.',
          });

          return {
            runId,
            status: 'qa',
            stage: 'judging',
            winnerCandidateId: winnerCandidate.id,
            judgeStatus,
            spentUsd: budget.spentUsd,
          };
        }

        case 'qa': {
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
          const activeRows = candidateRows.filter(
            (row) => row.status !== 'eliminated' && Array.isArray(row.layouts) && row.layouts.length > 0
          );
          const winnerRow = activeRows.find((r) => r.id === run.winner_candidate_id) || activeRows[0];
          if (!winnerRow) {
            return this.executeRung4Fallback(s, run, 'No valid candidate found for QA stage');
          }
          const layouts = (winnerRow.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));

          const winnerState: CandidateState = {
            id: winnerRow.id,
            ordinal: winnerRow.ordinal,
            concept: typeof winnerRow.concept === 'string' ? JSON.parse(winnerRow.concept) : winnerRow.concept,
            layouts,
            currentLayout: layouts[layouts.length - 1],
            metrics: typeof winnerRow.metrics === 'string' ? JSON.parse(winnerRow.metrics) : winnerRow.metrics,
            previewPng: winnerRow.preview_png ? Buffer.from(winnerRow.preview_png) : undefined,
            compositePng: winnerRow.composite_png ? Buffer.from(winnerRow.composite_png) : undefined,
            critiques: [],
            status: 'winner',
          };

          const qaResult = await runQAStage(ctx, winnerState);
          stages.qa = qaResult;

          if (!qaResult.passed) {
            // Attempt to find any other candidate that passes QA
            for (const otherRow of activeRows) {
              if (otherRow.id === winnerRow.id) continue;
              const otherLayouts = (otherRow.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
              if (otherLayouts.length === 0) continue;
              const otherState: CandidateState = {
                id: otherRow.id,
                ordinal: otherRow.ordinal,
                concept: typeof otherRow.concept === 'string' ? JSON.parse(otherRow.concept) : otherRow.concept,
                layouts: otherLayouts,
                currentLayout: otherLayouts[otherLayouts.length - 1],
                critiques: [],
                status: 'runner_up',
              };
              const otherQA = await runQAStage(ctx, otherState);
              if (otherQA.passed) {
                await this.repo.updateRunStatus(runId, s.tenantId, 'transferring', {
                  winnerCandidateId: otherRow.id,
                  stages,
                  budget,
                });
                return { runId, status: 'transferring', stage: 'qa', winnerCandidateId: otherRow.id };
              }
            }

            // Rung 4 fallback: trigger planner fallback
            return this.executeRung4Fallback(s, run, `Winner failed hard QA: ${qaResult.defectCodes.join(', ')}`);
          }

          // Check if operator requested holdForSelection
          const request = typeof run.request === 'string' ? JSON.parse(run.request) : run.request;
          if (request.holdForSelection) {
            await this.repo.updateRunStatus(runId, s.tenantId, 'awaiting_selection', { stages, budget });
            return { runId, status: 'awaiting_selection', stage: 'qa', spentUsd: budget.spentUsd };
          }

          await this.repo.updateRunStatus(runId, s.tenantId, 'transferring', { stages, budget });
          return { runId, status: 'transferring', stage: 'qa', spentUsd: budget.spentUsd };
        }

        case 'transferring': {
          const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
          const activeRows = candidateRows.filter(
            (row) => row.status !== 'eliminated' && Array.isArray(row.layouts) && row.layouts.length > 0
          );
          const winnerRow = activeRows.find((r) => r.id === run.winner_candidate_id) || activeRows[0];
          if (!winnerRow) {
            return this.executeRung4Fallback(s, run, 'No valid candidate found for transfer stage');
          }
          const layouts = (winnerRow.layouts as any[]).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));

          const winnerState: CandidateState = {
            id: winnerRow.id,
            ordinal: winnerRow.ordinal,
            concept: typeof winnerRow.concept === 'string' ? JSON.parse(winnerRow.concept) : winnerRow.concept,
            layouts,
            currentLayout: layouts[layouts.length - 1],
            metrics: typeof winnerRow.metrics === 'string' ? JSON.parse(winnerRow.metrics) : winnerRow.metrics,
            previewPng: winnerRow.preview_png ? Buffer.from(winnerRow.preview_png) : undefined,
            compositePng: winnerRow.composite_png ? Buffer.from(winnerRow.composite_png) : undefined,
            artPng: winnerRow.art_png ? Buffer.from(winnerRow.art_png) : undefined,
            critiques: [],
            status: 'winner',
          };

          const transferResult = await runTransferStage(ctx, winnerState);

          // Hard QA verification on v2 PPTX bytes
          const pptxCheck = checkCanvaPptx(
            new Uint8Array(transferResult.pptxBytes),
            ctx.copyBlocks.map((b) => b.text),
            ctx.latinFont || 'Verdana',
            {
              documentKind: (ctx as any).documentKind || 'design_piece',
              scriptFonts: { arabic: ctx.arabicFont || 'Noto Sans Arabic' },
            }
          );

          if (!pptxCheck.copyPass) {
            throw new Error('PPTX_TRANSFER_CORRUPTED: copyPass failed on generated PPTX');
          }

          // Save plan row in hawa.canva_design_plans
          const planId = randomUUID();
          const evidence = {
            manifest: transferResult.manifest,
            receipt: {
              source: 'design_studio_v2',
              runId: run.id,
              winnerCandidateId: winnerRow.id,
              completedAt: new Date().toISOString(),
            },
          };

          await this.tx(s, async (db) => {
            await sql`INSERT INTO hawa.canva_design_plans(
              id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request,
              status, result, source_content, source_sha256
            ) VALUES(
              ${planId}::uuid, ${s.tenantId}::uuid, ${run.task_id}::uuid, ${run.client_id}::uuid, ${s.actorId},
              ${'studio-' + run.request_key}, ${run.request_hash}, ${JSON.stringify(transferResult.plan)}::jsonb,
              'planned', ${JSON.stringify(evidence)}::jsonb, ${transferResult.pptxBytes}, ${transferResult.sha256}
            )`.execute(db);
          });

          let designId: string | undefined;
          if (this.canva) {
            let imported = await this.canva.importEditableDesign(s, run.task_id, 'studio-' + planId, {
              bytes: transferResult.pptxBytes,
              sha256: transferResult.sha256,
              manifest: transferResult.manifest as any,
            });
            const opId = (imported as any).operationId;
            let attempts = 0;
            while (
              imported.status === 'submitted' &&
              !(imported as any).designId &&
              attempts < 30 &&
              opId &&
              typeof (this.canva as any).resumeImport === 'function'
            ) {
              await new Promise((r) => setTimeout(r, 1500));
              attempts++;
              imported = await this.canva.resumeImport(s, run.task_id, opId);
            }
            if (imported.status !== 'retrieved' && !(imported as any).designId) {
              throw new Error(
                `Canva PPTX import did not settle: status=${imported.status} ${'message' in imported ? (imported as any).message : ''}`
              );
            }
            designId = (imported as any).designId;
          }

          stages.transfer = { planId, designId, completed: true };
          await this.repo.updateRunStatus(runId, s.tenantId, 'transferred', {
            stages,
            budget,
            planId,
          });

          return {
            runId,
            status: 'transferred',
            stage: 'transfer',
            planId,
            designId,
            spentUsd: budget.spentUsd,
            message: 'Design Studio v2 transferred editable PPTX to Canva.',
          };
        }

        default:
          return { runId, status: run.status };
      }
    } catch (err: any) {
      if (err instanceof StudioBudgetExhaustedError) {
        // Budget exhausted: gracefully handle by selecting best candidate so far
        return this.handleBudgetExhaustion(s, run, ctx);
      }

      if (ctx.pipelineV3) {
        const errorMsg = err.message || String(err);
        await this.repo.updateRunStatus(runId, s.tenantId, 'failed', {
          diagnostic: `Studio v3 failed at stage ${run.status}: ${errorMsg}`,
        });
        return {
          runId,
          status: 'failed',
          stage: run.status,
          diagnostic: `Studio v3 failed: ${errorMsg}`,
          message: errorMsg,
        };
      }

      // If failure happened during generation stages, execute Rung 4 fallback
      return this.executeRung4Fallback(s, run, err.message || 'Studio stage failed');
    }
  }

  /**
   * Graceful budget exhaustion handling: selects best candidate so far that passes hard QA.
   */
  private async handleBudgetExhaustion(s: Scope, run: any, ctx: StageContext): Promise<StudioResumeResult> {
    const candidateRows = await this.repo.getCandidatesForRun(run.id, s.tenantId);
    let bestCandidate: any = null;

    for (const row of candidateRows) {
      const layouts = (row.layouts as any[] || []).map((l) => (typeof l === 'string' ? JSON.parse(l) : l));
      if (layouts.length === 0) continue;

      const state: CandidateState = {
        id: row.id,
        ordinal: row.ordinal,
        concept: typeof row.concept === 'string' ? JSON.parse(row.concept) : row.concept,
        layouts,
        currentLayout: layouts[layouts.length - 1],
        critiques: [],
        status: row.status as DesignStudioCandidateStatus,
      };

      const qa = await runQAStage(ctx, state);
      if (qa.passed) {
        bestCandidate = row;
        break;
      }
    }

    if (bestCandidate) {
      await this.repo.updateRunStatus(run.id, s.tenantId, 'transferring', {
        winnerCandidateId: bestCandidate.id,
        diagnostic: 'BUDGET_EXHAUSTED: proceeded with best candidate passing hard QA.',
      });
      return {
        runId: run.id,
        status: 'transferring',
        diagnostic: 'BUDGET_EXHAUSTED',
        winnerCandidateId: bestCandidate.id,
      };
    }

    await this.repo.updateRunStatus(run.id, s.tenantId, 'failed', {
      diagnostic: 'BUDGET_EXHAUSTED: no candidates passed hard QA before budget cap was reached.',
    });
    return {
      runId: run.id,
      status: 'failed',
      diagnostic: 'BUDGET_EXHAUSTED',
      message: 'Budget exhausted without a valid candidate passing hard QA.',
    };
  }

  /**
   * P07 for a v3 run, as the qualification runs it: the judge compares the top two candidates in
   * both orders, and its pick stands only if it holds in both and the judge then beats a degraded
   * copy of it in both. Every judgement is stored, the canary's against the candidate it tested.
   */
  private async judgeV3(
    s: Scope,
    run: any,
    ctx: StageContext,
    stages: Record<string, any>,
    budget: { maxUsd: number; maxCalls: number; spentUsd: number; calls: number },
    candidateStates: CandidateState[]
  ): Promise<StudioResumeResult> {
    let outcome: Awaited<ReturnType<typeof runJudgeStageV3>>;
    try {
      outcome = await runJudgeStageV3(ctx, candidateStates);
    } catch (err) {
      if (err instanceof StudioBudgetExhaustedError) throw err;
      // Judge unavailable: the higher composite stands, and the run says so.
      const message = err instanceof Error ? err.message : String(err);
      const ranked = rankStudioCandidatesV3(ctx, candidateStates).map((r) => r.candidate);
      const winner = ranked[0];
      await this.recordV3Ranking(s, ranked, winner);
      stages.tournament = { pipeline: 'v3', winnerId: winner.id, decidedBy: 'composite_judge_unavailable', error: message };
      await this.repo.updateRunStatus(run.id, s.tenantId, 'qa', {
        stages,
        budget,
        winnerCandidateId: winner.id,
        judgeStatus: 'SKIPPED',
        diagnostic: `v3 judge unavailable (${message}); the higher composite stands.`,
      });
      return { runId: run.id, status: 'qa', stage: 'judging', winnerCandidateId: winner.id, judgeStatus: 'SKIPPED', spentUsd: budget.spentUsd };
    }

    const { selection, winner, ranked } = outcome;
    const idFor = (judgeId: string | number) =>
      ranked.find((x) => `candidate_${x.sourceIndex}` === String(judgeId))?.candidate.id;

    if (selection.match) {
      const orders = [
        [selection.match.orderAB, false],
        [selection.match.orderBA, true],
      ] as const;
      for (const [order, swapped] of orders) {
        await this.repo.insertJudgment({
          id: randomUUID(),
          runId: run.id,
          tenantId: s.tenantId,
          kind: 'pairwise',
          candidateA: idFor(order.candidateAId),
          candidateB: idFor(order.candidateBId),
          orderSwapped: swapped,
          verdict: {
            pipeline: 'v3',
            votes: order.votes,
            rationales: order.rationales,
            winnerVotesA: order.winnerVotesA,
            winnerVotesB: order.winnerVotesB,
            majorityWinner: order.majorityWinner,
            winnerCandidateId: idFor(order.winnerCandidateId),
            receipt: order.receipt,
          } as any,
        });
      }
    }
    if (selection.canary) {
      const subject = ranked.find((x) => x.sourceIndex === selection.canary!.subject.sourceIndex)!.candidate;
      const m = selection.canary.match;
      await this.repo.insertJudgment({
        id: randomUUID(),
        runId: run.id,
        tenantId: s.tenantId,
        kind: 'canary',
        candidateA: subject.id,
        verdict: {
          pipeline: 'v3',
          passed: selection.canary.passed,
          consistentWinner: m.winnerId,
          orderAB: { votes: m.orderAB.votes, majorityWinner: m.orderAB.majorityWinner, receipt: m.orderAB.receipt },
          orderBA: { votes: m.orderBA.votes, majorityWinner: m.orderBA.majorityWinner, receipt: m.orderBA.receipt },
        } as any,
      });
    }

    await this.recordV3Ranking(s, [winner, ...ranked.map((r) => r.candidate).filter((c) => c.id !== winner.id)], winner);

    const judgeStatus: DesignStudioJudgeStatus =
      selection.judgeReliable === null ? 'SKIPPED' : selection.judgeReliable ? 'RELIABLE' : 'UNRELIABLE';
    stages.tournament = {
      pipeline: 'v3',
      winnerId: winner.id,
      decidedBy: selection.decidedBy,
      judgeWinner: selection.match ? idFor(selection.match.winnerId) ?? selection.match.winnerId : null,
      consistent: selection.match?.isConsistent ?? null,
    };
    stages.canary = { passed: selection.canary?.passed ?? null };

    await this.repo.updateRunStatus(run.id, s.tenantId, 'qa', {
      stages,
      budget,
      winnerCandidateId: winner.id,
      judgeStatus,
      diagnostic:
        selection.judgeReliable === false
          ? 'The judge did not beat a degraded copy of its choice in both orders; the higher composite stands.'
          : null,
    });
    return { runId: run.id, status: 'qa', stage: 'judging', winnerCandidateId: winner.id, judgeStatus, spentUsd: budget.spentUsd };
  }

  /** Winner first, then the rest in the order given; every candidate keeps a rank. */
  private async recordV3Ranking(s: Scope, ordered: CandidateState[], winner: CandidateState): Promise<void> {
    for (let i = 0; i < ordered.length; i++) {
      await this.repo.updateCandidate(ordered[i].id, s.tenantId, {
        status: ordered[i].id === winner.id ? 'winner' : 'runner_up',
        rank: i + 1,
      });
    }
  }

  /**
   * Degradation ladder Rung 4: Studio stage fails after retries -> fallback to single-shot planner path.
   */
  private async executeRung4Fallback(s: Scope, run: any, reason: string): Promise<StudioResumeResult> {
    if (isPipelineV3Run(run)) {
      await this.repo.updateRunStatus(run.id, s.tenantId, 'failed', {
        diagnostic: `Studio v3 failed: ${reason}. Legacy single-shot fallback is disabled for v3 runs.`,
      });
      return {
        runId: run.id,
        status: 'failed',
        diagnostic: `Studio v3 failed: ${reason}`,
      };
    }
    const request = typeof run.request === 'string' ? JSON.parse(run.request) : run.request;
    const planner =
      this.options.planner ||
      (this.canva
        ? new CanvaDesignPlanner(this.db, this.canva, {
            apiKey: this.options.apiKey,
            fetcher: this.options.fetcher,
          })
        : null);

    if (planner) {
      try {
        const fallbackKey = `fb-${run.request_key}`.slice(0, 128);
        let fallbackResult: any = await planner.generate(s, run.task_id, fallbackKey, request.width, request.height);

        // If Canva import is submitted, poll until retrieved so designId is acquired
        let attempts = 0;
        while (fallbackResult.status === 'submitted' && attempts < 30 && this.canva) {
          await new Promise((r) => setTimeout(r, 2000));
          attempts++;
          fallbackResult = await this.canva.resumeImport(s, run.task_id, fallbackResult.operationId);
        }

        await this.repo.updateRunStatus(run.id, s.tenantId, 'degraded', {
          planId: fallbackResult.planId,
          diagnostic: `Rung 4 studio fallback: ${reason}. Single-shot planner called (studioFallback: true).`,
        });

        return {
          runId: run.id,
          status: 'degraded',
          planId: fallbackResult.planId,
          designId: fallbackResult.designId,
          message: `Rung 4 studio fallback: single-shot planner called with studioFallback: true (${reason}).`,
          diagnostic: `Rung 4 fallback: ${reason}`,
        };
      } catch (fbErr: any) {
        // Fallback also failed
        await this.repo.updateRunStatus(run.id, s.tenantId, 'failed', {
          diagnostic: `Studio failed (${reason}) and Rung 4 fallback failed (${fbErr.message}).`,
        });
        return {
          runId: run.id,
          status: 'failed',
          diagnostic: `Studio failed (${reason}) and Rung 4 fallback failed: ${fbErr.message}`,
        };
      }
    }

    await this.repo.updateRunStatus(run.id, s.tenantId, 'failed', {
      diagnostic: `Studio stage failed: ${reason}.`,
    });
    return {
      runId: run.id,
      status: 'failed',
      diagnostic: reason,
    };
  }

  /**
   * Selects a candidate when run is in awaiting_selection.
   */
  public async selectCandidate(s: Scope, taskId: string, runId: string, candidateId: string): Promise<StudioResumeResult> {
    const run = await this.repo.getRunById(runId, s.tenantId);
    if (!run) throw new CanvaFlowError(404, 'RUN_NOT_FOUND', 'Studio run not found.');
    if (run.status !== 'awaiting_selection') {
      throw new CanvaFlowError(409, 'NOT_AWAITING_SELECTION', `Run is in status '${run.status}', not 'awaiting_selection'.`);
    }

    const candidates = await this.repo.getCandidatesForRun(runId, s.tenantId);
    const candidate = candidates.find((c) => c.id === candidateId);
    if (!candidate) throw new CanvaFlowError(404, 'CANDIDATE_NOT_FOUND', 'Candidate not found for this run.');

    await this.repo.updateRunStatus(runId, s.tenantId, 'transferring', {
      winnerCandidateId: candidateId,
    });

    return {
      runId,
      status: 'transferring',
      winnerCandidateId: candidateId,
      message: 'Candidate selected; ready for Canva transfer.',
    };
  }

  /**
   * Abandons an active studio run so another generation can be requested.
   */
  public async abandon(s: Scope, taskId: string, runId: string, reason: string): Promise<StudioResumeResult> {
    const why = String(reason || '').trim();
    if (why.length < 3 || why.length > 500) {
      throw new CanvaFlowError(422, 'REASON_REQUIRED', 'Give a short reason (3-500 chars) for abandoning this studio run.');
    }

    return this.tx(s, async () => {
      const run = await this.repo.getRunById(runId, s.tenantId);
      if (!run) throw new CanvaFlowError(404, 'RUN_NOT_FOUND', 'Studio run not found.');
      if (['transferred', 'abandoned'].includes(run.status)) {
        throw new CanvaFlowError(409, 'CANNOT_ABANDON', `Cannot abandon run in status '${run.status}'.`);
      }

      await this.repo.updateRunStatus(runId, s.tenantId, 'abandoned', {
        diagnostic: `Abandoned by ${s.actorId}: ${why}`,
      });

      return {
        runId,
        status: 'abandoned',
        message: 'Studio run abandoned. A new generation may now be started.',
      };
    });
  }

  /**
   * P8 — Canva parity check on the exported Canva PNG.
   * Compares the winner preview PNG with the exported Canva PNG.
   */
  public async runParityCheck(s: Scope, runId: string): Promise<ParityResult> {
    const run = await this.repo.getRunById(runId, s.tenantId);
    if (!run) throw new CanvaFlowError(404, 'RUN_NOT_FOUND', 'Studio run not found.');
    if (!run.winner_candidate_id) {
      throw new CanvaFlowError(422, 'NO_WINNER_CANDIDATE', 'Studio run has no selected winner candidate.');
    }

    const candidate = await this.repo.getCandidateById(run.winner_candidate_id, s.tenantId);
    if (!candidate?.preview_png) {
      throw new CanvaFlowError(404, 'PREVIEW_NOT_FOUND', 'Winner candidate has no rendered preview image.');
    }

    const canvaExportRow = await this.tx(s, async (db) =>
      (await sql<any>`SELECT content FROM hawa.canva_export_bytes
        WHERE task_id = ${run.task_id}::uuid AND tenant_id = ${s.tenantId}::uuid AND format = 'png'
        ORDER BY created_at DESC LIMIT 1`.execute(db)).rows[0]
    );
    if (!canvaExportRow?.content) {
      throw new CanvaFlowError(404, 'CANVA_PNG_NOT_FOUND', 'Exported Canva PNG not found for task.');
    }

    const budget = typeof run.budget === 'string' ? JSON.parse(run.budget) : (run.budget || { maxUsd: 5.0, maxCalls: 30, spentUsd: 0, calls: 0 });
    const stageCtx = this.createStageContext(s, run, 'parity', budget, async (cost) => {
      budget.spentUsd += cost;
      budget.calls += 1;
    });
    const parityResult = await runParityStage(stageCtx, candidate.preview_png, canvaExportRow.content);

    // Record judgment in append-only table
    await this.repo.insertJudgment({
      id: randomUUID(),
      runId: run.id,
      tenantId: s.tenantId,
      kind: 'parity',
      candidateA: run.winner_candidate_id,
      candidateB: null,
      orderSwapped: false,
      verdict: parityResult as any,
    });

    if (!['transferred', 'degraded', 'failed', 'abandoned'].includes(run.status)) {
      const stages = typeof run.stages === 'string' ? JSON.parse(run.stages || '{}') : run.stages || {};
      stages.parity = parityResult;
      await this.repo.updateRunStatus(runId, s.tenantId, run.status, { stages });
    }

    return parityResult;
  }
}

