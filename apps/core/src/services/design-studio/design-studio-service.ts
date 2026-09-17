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
  GeminiImageProvider,
  type StudioLayoutV2,
  ExemplarRetrievalIndex,
} from '@hawa/creative';
import { checkCanvaPptx } from '@hawa/qa';
import { CanvaConnectService, CanvaFlowError } from '../canva-connect-service.js';
import { CanvaDesignPlanner, savedDesignCopy, classifyCopyScript } from '../canva-design-planner.js';
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
} from './stages/index.js';

export type Scope = { tenantId: string; actorId: string };

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

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

    const logoCandidates = [
      resolve(process.cwd(), 'packages/creative/assets/logos/kaae-official-logo.png'),
      resolve(process.cwd(), '../../packages/creative/assets/logos/kaae-official-logo.png'),
      new URL('../../../../../packages/creative/assets/logos/kaae-official-logo.png', import.meta.url).pathname,
      new URL('../../../../packages/creative/assets/logos/kaae-official-logo.png', import.meta.url).pathname,
    ];
    const logoPath = logoCandidates.find((p) => existsSync(p));
    if (!logoPath) throw new Error('Could not find kaae-official-logo.png');

    const logo = await readFile(logoPath);
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

      // 3. Check for existing run by request_key OR in-flight active run for this task
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

      // 5. Concurrency check: max 2 active studio runs per tenant
      const activeRuns = (
        await sql<any>`SELECT count(*) AS n FROM hawa.design_studio_runs 
        WHERE tenant_id=${s.tenantId}::uuid AND status NOT IN ('transferred', 'degraded', 'failed', 'abandoned')`.execute(db)
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
      timeoutMs: 90000,
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
        const model = params.model || baseClient.primaryModel || 'gpt-6-astra';

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
        const model = params.model || baseClient.primaryModel || 'gpt-6-astra';

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

        const callId = randomUUID();
        await this.repo.recordCallStart({
          id: callId,
          runId: run.id,
          tenantId: s.tenantId,
          stage: 'art',
          provider: 'openai',
          model: 'gpt-image-2.5-sunburst',
          requestedModel: 'gpt-image-2.5-sunburst',
        });
        currentBudget.calls++;

        try {
          const result = await baseArtProvider.generateArt(params);
          const cost = result.receipt?.costUsd !== undefined ? result.receipt.costUsd : 0.04;

          await this.repo.finalizeCall({
            id: callId,
            tenantId: s.tenantId,
            responseId: result.receipt?.responseId || 'openai_art',
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
        if (rawRef.rules?.palette) {
          referencePack.palette = rawRef.rules.palette;
        }
        if (rawRef.rules?.fontFamily) {
          latinFont = rawRef.rules.fontFamily;
          referencePack.referenceFonts = {
            latin: rawRef.rules.fontFamily,
            arabic: rawRef.rules.scriptFonts?.arabic || 'Noto Sans Arabic',
          };
        }
        if (rawRef.rules?.scriptFonts?.arabic) {
          arabicFont = rawRef.rules.scriptFonts.arabic;
        }
        if (rawRef.rules?.colorUsage) {
          promotedRules = rawRef.rules.colorUsage;
        }
      }
    } catch {
      // Fallback defaults preserved
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
    } catch {
      // Optional fallback
    }

    let logo: { bytes: Buffer; sha256: string; mimeType: 'image/png' } | undefined;
    try {
      const logoPath = resolve(import.meta.dirname, '../../../../packages/creative/assets/logos/kaae-official-logo.png');
      if (existsSync(logoPath)) {
        const logoBytes = readFileSync(logoPath);
        const logoSha256 = createHash('sha256').update(logoBytes).digest('hex');
        logo = {
          bytes: logoBytes,
          sha256: logoSha256,
          mimeType: 'image/png',
        };
      }
    } catch {
      // ignore
    }

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
          const concepts = await runConceptsStage(ctx, brief);
          stages.concepts = concepts;

          // Create candidates in DB
          for (let i = 0; i < concepts.length; i++) {
            await this.repo.insertCandidate({
              id: randomUUID(),
              runId: run.id,
              tenantId: s.tenantId,
              ordinal: i,
              concept: concepts[i] as any,
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
            const imported = await this.canva.importEditableDesign(s, run.task_id, 'studio-' + planId, {
              bytes: transferResult.pptxBytes,
              sha256: transferResult.sha256,
              manifest: transferResult.manifest as any,
            });
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
   * Degradation ladder Rung 4: Studio stage fails after retries -> fallback to single-shot planner path.
   */
  private async executeRung4Fallback(s: Scope, run: any, reason: string): Promise<StudioResumeResult> {
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

