import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type {
  Database,
  DesignStudioRunsTable,
  DesignStudioCandidatesTable,
  DesignStudioJudgmentsTable,
  DesignStudioCallsTable,
  DesignFeedbackTable,
  DesignStudioTier,
  DesignStudioStatus,
  DesignStudioJudgeStatus,
  DesignStudioCandidateStatus,
  DesignStudioJudgmentKind,
  DesignStudioCallStatus,
  DesignFeedbackSource,
  DesignFeedbackVerdict,
} from '../types.js';

export interface CreateDesignStudioRunParams {
  id: string;
  tenantId: string;
  taskId: string;
  clientId: string;
  actorId: string;
  requestKey: string;
  requestHash: string;
  request: Record<string, unknown>;
  tier: DesignStudioTier;
  budget?: Record<string, unknown>;
}

export interface InsertCandidateParams {
  id: string;
  runId: string;
  tenantId: string;
  ordinal: number;
  concept: Record<string, unknown>;
  layouts?: Record<string, unknown>[];
  metrics?: Record<string, unknown> | null;
  status?: DesignStudioCandidateStatus;
  previewPng?: Buffer | null;
  previewSha256?: string | null;
  compositePng?: Buffer | null;
  artPng?: Buffer | null;
  artSha256?: string | null;
  artProvenance?: Record<string, unknown> | null;
}

export interface InsertJudgmentParams {
  id: string;
  runId: string;
  tenantId: string;
  kind: DesignStudioJudgmentKind;
  candidateA?: string | null;
  candidateB?: string | null;
  orderSwapped?: boolean;
  verdict: Record<string, unknown>;
  callId?: string | null;
}

export interface RecordCallStartParams {
  id: string;
  runId: string;
  tenantId: string;
  stage: string;
  provider: string;
  model: string;
  requestedModel: string;
}

export interface FinalizeCallParams {
  id: string;
  tenantId: string;
  responseId?: string | null;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  images?: number;
  usdEstimate: number | string;
  status: DesignStudioCallStatus;
  errorCode?: string | null;
  finishedAt?: Date;
}

export interface RecordFeedbackParams {
  id: string;
  tenantId: string;
  taskId: string;
  runId?: string | null;
  candidateId?: string | null;
  actorId: string;
  source: DesignFeedbackSource;
  verdict: DesignFeedbackVerdict;
  rating?: number | null;
  notes?: string | null;
}

export class DesignStudioRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createRun(params: CreateDesignStudioRunParams, trx?: Kysely<Database>) {
    const client = trx || this.db;
    const [row] = await client
      .insertInto('design_studio_runs')
      .values({
        id: params.id,
        tenant_id: params.tenantId,
        task_id: params.taskId,
        client_id: params.clientId,
        actor_id: params.actorId,
        request_key: params.requestKey,
        request_hash: params.requestHash,
        request: JSON.stringify(params.request),
        tier: params.tier,
        status: 'briefing',
        budget: params.budget ? JSON.stringify(params.budget) : JSON.stringify({ maxUsd: 6.0, maxCalls: 40, spentUsd: 0.0, calls: 0 }),
      })
      .returningAll()
      .execute();
    return row;
  }

  async getRunById(id: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db).selectFrom('design_studio_runs').selectAll().where('id', '=', id);
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.executeTakeFirst();
  }

  async getActiveRunForTask(taskId: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db)
      .selectFrom('design_studio_runs')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('status', 'not in', ['transferred', 'degraded', 'failed', 'abandoned']);
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.executeTakeFirst();
  }

  async updateRunStatus(
    id: string,
    tenantId: string,
    status: DesignStudioStatus,
    extra?: {
      judgeStatus?: DesignStudioJudgeStatus | null;
      winnerCandidateId?: string | null;
      planId?: string | null;
      diagnostic?: string | null;
      budget?: Record<string, unknown>;
      stages?: Record<string, unknown>[];
    },
    trx?: Kysely<Database>
  ) {
    const client = trx || this.db;
    const updates: Record<string, unknown> = {
      status,
      updated_at: new Date(),
    };
    if (extra?.judgeStatus !== undefined) updates.judge_status = extra.judgeStatus;
    if (extra?.winnerCandidateId !== undefined) updates.winner_candidate_id = extra.winnerCandidateId;
    if (extra?.planId !== undefined) updates.plan_id = extra.planId;
    if (extra?.diagnostic !== undefined) updates.diagnostic = extra.diagnostic;
    if (extra?.budget !== undefined) updates.budget = JSON.stringify(extra.budget);
    if (extra?.stages !== undefined) updates.stages = JSON.stringify(extra.stages);

    const [row] = await client
      .updateTable('design_studio_runs')
      .set(updates)
      .where('id', '=', id)
      .where('tenant_id', '=', tenantId)
      .returningAll()
      .execute();
    return row;
  }

  async insertCandidate(params: InsertCandidateParams, trx?: Kysely<Database>) {
    const client = trx || this.db;
    const [row] = await client
      .insertInto('design_studio_candidates')
      .values({
        id: params.id,
        run_id: params.runId,
        tenant_id: params.tenantId,
        ordinal: params.ordinal,
        concept: JSON.stringify(params.concept),
        layouts: params.layouts ? params.layouts.map((l) => JSON.stringify(l)) : [],
        metrics: params.metrics ? JSON.stringify(params.metrics) : null,
        status: params.status || 'draft',
        preview_png: params.previewPng || null,
        preview_sha256: params.previewSha256 || null,
        composite_png: params.compositePng || null,
        art_png: params.artPng || null,
        art_sha256: params.artSha256 || null,
        art_provenance: params.artProvenance ? JSON.stringify(params.artProvenance) : null,
      })
      .returningAll()
      .execute();
    return row;
  }

  async getCandidatesForRun(runId: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db)
      .selectFrom('design_studio_candidates')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('ordinal', 'asc');
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.execute();
  }

  async updateCandidate(
    id: string,
    tenantId: string,
    updates: {
      status?: DesignStudioCandidateStatus;
      score?: number | null;
      rank?: number | null;
      metrics?: Record<string, unknown> | null;
      critiques?: Record<string, unknown>[];
      layouts?: Record<string, unknown>[];
      previewPng?: Buffer | null;
      previewSha256?: string | null;
      compositePng?: Buffer | null;
      artPng?: Buffer | null;
      artSha256?: string | null;
      artProvenance?: Record<string, unknown> | null;
    },
    trx?: Kysely<Database>
  ) {
    const client = trx || this.db;
    const setClause: Record<string, unknown> = {
      updated_at: new Date(),
    };
    if (updates.status !== undefined) setClause.status = updates.status;
    if (updates.score !== undefined) setClause.score = updates.score;
    if (updates.rank !== undefined) setClause.rank = updates.rank;
    if (updates.metrics !== undefined) setClause.metrics = updates.metrics ? JSON.stringify(updates.metrics) : null;
    if (updates.critiques !== undefined) {
      setClause.critiques = updates.critiques.map((c) => JSON.stringify(c));
    }
    if (updates.layouts !== undefined) {
      setClause.layouts = updates.layouts.map((l) => JSON.stringify(l));
    }
    if (updates.previewPng !== undefined) setClause.preview_png = updates.previewPng;
    if (updates.previewSha256 !== undefined) setClause.preview_sha256 = updates.previewSha256;
    if (updates.compositePng !== undefined) setClause.composite_png = updates.compositePng;
    if (updates.artPng !== undefined) setClause.art_png = updates.artPng;
    if (updates.artSha256 !== undefined) setClause.art_sha256 = updates.artSha256;
    if (updates.artProvenance !== undefined) setClause.art_provenance = updates.artProvenance ? JSON.stringify(updates.artProvenance) : null;

    const [row] = await client
      .updateTable('design_studio_candidates')
      .set(setClause)
      .where('id', '=', id)
      .where('tenant_id', '=', tenantId)
      .returningAll()
      .execute();
    return row;
  }

  async insertJudgment(params: InsertJudgmentParams, trx?: Kysely<Database>) {
    const client = trx || this.db;
    const [row] = await client
      .insertInto('design_studio_judgments')
      .values({
        id: params.id,
        run_id: params.runId,
        tenant_id: params.tenantId,
        kind: params.kind,
        candidate_a: params.candidateA || null,
        candidate_b: params.candidateB || null,
        order_swapped: params.orderSwapped || false,
        verdict: JSON.stringify(params.verdict),
        call_id: params.callId || null,
      })
      .returningAll()
      .execute();
    return row;
  }

  async getJudgmentsForRun(runId: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db)
      .selectFrom('design_studio_judgments')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('created_at', 'asc');
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.execute();
  }

  /**
   * Financial Ledger: records a call at start BEFORE the external API call begins.
   * This guarantees that any initiated spend is journaled prior to network dispatch.
   */
  async recordCallStart(params: RecordCallStartParams, trx?: Kysely<Database>) {
    const client = trx || this.db;
    const [row] = await client
      .insertInto('design_studio_calls')
      .values({
        id: params.id,
        run_id: params.runId,
        tenant_id: params.tenantId,
        stage: params.stage,
        provider: params.provider,
        model: params.model,
        requested_model: params.requestedModel,
        status: 'uncertain',
      })
      .returningAll()
      .execute();
    return row;
  }

  /**
   * Finalizes the call in the ledger with exact tokens and USD spend.
   */
  async finalizeCall(params: FinalizeCallParams, trx?: Kysely<Database>) {
    const client = trx || this.db;
    const [row] = await client
      .updateTable('design_studio_calls')
      .set({
        response_id: params.responseId || null,
        input_tokens: params.inputTokens,
        cached_input_tokens: params.cachedInputTokens || 0,
        output_tokens: params.outputTokens,
        images: params.images || 0,
        usd_estimate: params.usdEstimate.toString(),
        status: params.status,
        error_code: params.errorCode || null,
        finished_at: params.finishedAt || new Date(),
      })
      .where('id', '=', params.id)
      .where('tenant_id', '=', params.tenantId)
      .returningAll()
      .execute();
    return row;
  }

  async getCallsForRun(runId: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db)
      .selectFrom('design_studio_calls')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('started_at', 'asc');
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.execute();
  }

  async recordFeedback(params: RecordFeedbackParams, trx?: Kysely<Database>) {
    const client = trx || this.db;
    const [row] = await client
      .insertInto('design_feedback')
      .values({
        id: params.id,
        tenant_id: params.tenantId,
        task_id: params.taskId,
        run_id: params.runId || null,
        candidate_id: params.candidateId || null,
        actor_id: params.actorId,
        source: params.source,
        verdict: params.verdict,
        rating: params.rating !== undefined ? params.rating : null,
        notes: params.notes || null,
      })
      .returningAll()
      .execute();
    return row;
  }

  async listFeedbackForTask(taskId: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db)
      .selectFrom('design_feedback')
      .selectAll()
      .where('task_id', '=', taskId)
      .orderBy('created_at', 'desc');
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.execute();
  }

  async listFeedbackForCandidate(candidateId: string, tenantId?: string, trx?: Kysely<Database>) {
    let query = (trx || this.db)
      .selectFrom('design_feedback')
      .selectAll()
      .where('candidate_id', '=', candidateId)
      .orderBy('created_at', 'desc');
    if (tenantId) {
      query = query.where('tenant_id', '=', tenantId);
    }
    return await query.execute();
  }
}
