import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { withRlsContext } from '../client.js';
import { assertStudioBudgetAdmission, studioBudgetUsage, StudioBudgetExhaustedError, StudioBudgetEvidenceError, type StudioDailyBudget, type StudioBudgetUsage, validateStudioReservation, type StudioCallReservation, type StudioCostBasis } from '@hawa/domain';
import { parseBlobRef, sniffBlobMediaType, taskGenerationBlocker, type BlobRef } from '@hawa/contracts';
import { BlobCorruptError, BlobMissingError, type BlobStore } from '../blobs/store.js';
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
  /** Authenticated caller for the task's membership/RLS check; never provider input. */
  actorId?: string;
  stage: string;
  provider: string;
  model: string;
  requestedModel: string;
  /** Per-run sequence number for generation; parity checks use a content-only identity. */
  callOrdinal: number | null;
  logicalCallSha256: string;
  reservation: StudioCallReservation;
}

export class ModelCallAdmissionConflictError extends Error {
  readonly code = 'MODEL_CALL_ADMISSION_CONFLICT';
  constructor() {
    super('This logical Studio model call was already admitted by another process.');
    this.name = 'ModelCallAdmissionConflictError';
  }
}

export class TaskGenerationBlockedError extends Error {
  readonly code = 'TASK_GENERATION_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'TaskGenerationBlockedError';
  }
}

export class StudioCallUncertainError extends Error {
  readonly code = 'MODEL_CALL_UNCERTAIN';
  readonly status = 409;
  readonly isUncertain = true;
  constructor() {
    super('This task has an unresolved model call or active planner attempt. Reconcile its outcome before starting more paid work.');
    this.name = 'StudioCallUncertainError';
  }
}

/** Caller holds the task row lock, shared by run replacement, abandonment and call admission. */
export async function assertStudioCallsResolved(
  db: Kysely<Database>, tenantId: string, taskId: string, executingRunId?: string, executingPlanId?: string
): Promise<void> {
  let query = db.selectFrom('design_studio_calls as c')
    .innerJoin('design_studio_runs as r', join => join.onRef('r.id', '=', 'c.run_id')
      .onRef('r.tenant_id', '=', 'c.tenant_id'))
    .select('c.id').where('r.tenant_id', '=', tenantId).where('r.task_id', '=', taskId)
    .where('c.status', '=', 'uncertain')
    .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM hawa.studio_run_settlements s
      WHERE s.tenant_id=c.tenant_id AND s.run_id=c.run_id
        AND s.calls @> jsonb_build_array(jsonb_build_object('callId',c.id::text)))`);
  if (executingRunId) query = query.where(eb => eb.or([
    eb('r.id', '!=', executingRunId), eb('c.finished_at', 'is not', null),
  ]));
  if (await query.executeTakeFirst()) throw new StudioCallUncertainError();
  const planner=(await sql`SELECT p.id FROM hawa.canva_design_plans p
    LEFT JOIN hawa.canva_planner_calls c ON c.tenant_id=p.tenant_id AND c.id=p.id
    WHERE p.tenant_id=${tenantId}::uuid AND p.task_id=${taskId}::uuid
      AND p.id IS DISTINCT FROM ${executingPlanId??null}::uuid AND (
        p.status='planning' OR ((p.paid_protocol IS NULL OR c.reconciliation_required) AND NOT EXISTS(
          SELECT 1 FROM hawa.call_cost_attestations a WHERE a.tenant_id=p.tenant_id
            AND a.call_kind='canva_planner' AND a.call_id=p.id))) LIMIT 1`.execute(db)).rows[0];
  if(planner)throw new StudioCallUncertainError();
}

export class ModelCallFinalizationConflictError extends Error {
  readonly code = 'MODEL_CALL_FINALIZATION_CONFLICT';
  constructor() {
    super('This Studio model call is missing or already has a recorded outcome.');
    this.name = 'ModelCallFinalizationConflictError';
  }
}

export interface FinalizeCallParams {
  /** Private content, committed atomically with the successful receipt; not exposed in call lists. */
  retainedResult?: { kind: 'structured' | 'image'; payload: unknown; image?: Buffer };
  actorId?: string;
  id: string;
  tenantId: string;
  responseId?: string | null;
  servedModel?: string | null;
  providerRequestId?: string | null;
  responseSha256?: string | null;
  latencyMs?: number | null;
  attempts?: number | null;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  images?: number;
  usdEstimate: number | string;
  costBasis?: StudioCostBasis;
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

/** A candidate's three pictures, each a bytea column (until migration 021) and a hash naming its file. */
export type CandidateImageKind = 'preview' | 'composite' | 'art';
/**
 * The hash a picture column must carry for these bytes. The preview and art columns are checked
 * against their bytes (migration 013), so when a put failed and the caller gave no hash, the row still
 * names the new picture, never the old one: readers then miss in the store and use the bytes.
 */
function pictureSha(bytes: Buffer | null | undefined, stored: string | undefined, given: string | null | undefined): string | null {
  if (stored) return stored;
  if (given) return given;
  return bytes && bytes.length ? createHash('sha256').update(bytes).digest('hex') : null;
}

const CANDIDATE_IMAGE_COLUMNS = {
  preview: { bytes: 'preview_png', sha: 'preview_sha256' },
  composite: { bytes: 'composite_png', sha: 'composite_sha256' },
  art: { bytes: 'art_png', sha: 'art_sha256' },
} as const;
type CandidateImageRow = Partial<Pick<DesignStudioCandidatesTable, 'preview_png' | 'preview_sha256' | 'composite_png' | 'composite_sha256' | 'art_png' | 'art_sha256'>>;

export class DesignStudioRepository {
  /**
   * `blobStore`: where candidate pictures are also written (ADR-035, release A dual-write). Without
   * one (a process with no HAWA_BLOB_DIR), pictures stay in their bytea columns only, as before.
   */
  constructor(
    private readonly db: Kysely<Database>,
    private readonly blobStore: BlobStore | null = null
  ) {}

  /**
   * Puts each picture to the file store and returns the hash columns to write with it. The file and
   * its hawa.blobs row commit before the candidate row does, in the store's own short transaction, so
   * the candidate's transaction never waits on a disk write; a candidate write that then fails leaves
   * an unreferenced file, which the collector removes after its grace. The bytes are still written to
   * the row as well until the strip (FILESTORE_DESIGN.md section 5), so a failed put only logs.
   */
  private async storeCandidateImages(images: Partial<Record<CandidateImageKind, Buffer | null | undefined>>): Promise<Partial<Record<CandidateImageKind, string>>> {
    const out: Partial<Record<CandidateImageKind, string>> = {};
    if (!this.blobStore) return out;
    for (const kind of Object.keys(images) as CandidateImageKind[]) {
      const bytes = images[kind];
      if (!bytes || !bytes.length) continue;
      const mediaType = sniffBlobMediaType(bytes);
      if (!mediaType || !mediaType.startsWith('image/')) continue;
      try {
        out[kind] = (await this.blobStore.put(bytes, mediaType)).sha256;
      } catch (err) {
        console.warn(`[design-studio] the ${kind} picture was not written to the file store (its bytes stay in the row): ${err instanceof Error ? err.message : err}`);
      }
    }
    return out;
  }

  /**
   * A candidate's picture: from the file store when the row names a stored file, else from the row's
   * bytes (a row written before the store, or a file the store does not have).
   */
  async readCandidateImage(row: CandidateImageRow | null | undefined, kind: CandidateImageKind): Promise<Buffer | undefined> {
    if (!row) return undefined;
    const columns = CANDIDATE_IMAGE_COLUMNS[kind];
    const sha = row[columns.sha];
    const bytes = row[columns.bytes];
    if (this.blobStore && sha) {
      try {
        // Verified: a same-size corrupted file must not be shown or judged as the candidate.
        return await this.blobStore.read(sha, { verify: true });
      } catch (err) {
        if (err instanceof BlobCorruptError) console.warn(`[design-studio] ${err.message}; the row's ${kind} bytes are used`);
        // A store that cannot be read at all (a missed mount) must not stop a run whose rows still
        // have their bytes; only a row without them fails with it.
        if (!(err instanceof BlobMissingError) && !(err instanceof BlobCorruptError)) {
          if (!bytes) throw err;
          console.warn(`[design-studio] the file store could not be read, so the row's ${kind} bytes are used: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    return bytes ? Buffer.from(bytes) : undefined;
  }

  /** The rows with each picture as readCandidateImage reads it, in the bytea columns' places. */
  private async withCandidateImages<T extends CandidateImageRow>(rows: T[]): Promise<T[]> {
    if (!this.blobStore) return rows;
    return Promise.all(
      rows.map(async (row) => {
        const [preview, composite, art] = await Promise.all([
          this.readCandidateImage(row, 'preview'),
          this.readCandidateImage(row, 'composite'),
          this.readCandidateImage(row, 'art'),
        ]);
        return { ...row, preview_png: preview ?? null, composite_png: composite ?? null, art_png: art ?? null };
      })
    );
  }

  private async withClient<T>(
    trx: Kysely<Database> | undefined,
    scope: { tenantId?: string; clientId?: string; actorId?: string } | string | undefined,
    fn: (client: Kysely<Database>) => Promise<T>
  ): Promise<T> {
    const base = trx || this.db;
    const tenantId = typeof scope === 'string' ? scope : scope?.tenantId;
    const clientId = typeof scope === 'object' ? scope?.clientId : undefined;
    if (tenantId) {
      return withRlsContext(base, { tenantId, clientId, userId: typeof scope === 'object' ? scope.actorId : undefined }, fn);
    }
    return fn(base);
  }

  async createRun(params: CreateDesignStudioRunParams, trx?: Kysely<Database>) {
    return this.withClient(trx, { tenantId: params.tenantId, clientId: params.clientId }, async (client) => {
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
          stages: JSON.stringify({}),
          budget: params.budget ? JSON.stringify(params.budget) : JSON.stringify({ maxUsd: 6.0, maxCalls: 40, spentUsd: 0.0, calls: 0 }),
        })
        .returningAll()
        .execute();
      return row;
    });
  }

  async getRunById(id: string, tenantId?: string, trx?: Kysely<Database>) {
    return this.withClient(trx, tenantId, async (client) => {
      let query = client.selectFrom('design_studio_runs').selectAll().where('id', '=', id);
      if (tenantId) {
        query = query.where('tenant_id', '=', tenantId);
      }
      return await query.executeTakeFirst();
    });
  }

  async getActiveRunForTask(taskId: string, tenantId?: string, trx?: Kysely<Database>) {
    return this.withClient(trx, tenantId, async (client) => {
      let query = client
        .selectFrom('design_studio_runs')
        .selectAll()
        .where('task_id', '=', taskId)
        .where('status', 'not in', ['transferred', 'degraded', 'failed', 'abandoned']);
      if (tenantId) {
        query = query.where('tenant_id', '=', tenantId);
      }
      return await query.executeTakeFirst();
    });
  }

  async getLatestRunForTask(taskId: string, tenantId?: string, trx?: Kysely<Database>) {
    return this.withClient(trx, tenantId, async (client) => {
      let query = client
        .selectFrom('design_studio_runs')
        .selectAll()
        .where('task_id', '=', taskId)
        .orderBy('created_at', 'desc');
      if (tenantId) {
        query = query.where('tenant_id', '=', tenantId);
      }
      return await query.executeTakeFirst();
    });
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
      stages?: Record<string, unknown> | Record<string, unknown>[];
      /** Write only if the run is still at this status; otherwise nothing is written and undefined is returned. */
      expectedStatus?: DesignStudioStatus;
    },
    trx?: Kysely<Database>
  ) {
    return this.withClient(trx, tenantId, async (client) => {
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

      let query = client
        .updateTable('design_studio_runs')
        .set(updates)
        .where('id', '=', id)
        .where('tenant_id', '=', tenantId);
      if (extra?.expectedStatus !== undefined) query = query.where('status', '=', extra.expectedStatus);
      const [row] = await query.returningAll().execute();
      return row;
    });
  }

  async insertCandidate(params: InsertCandidateParams, trx?: Kysely<Database>) {
    const stored = await this.storeCandidateImages({ preview: params.previewPng, composite: params.compositePng, art: params.artPng });
    return this.withClient(trx, params.tenantId, async (client) => {
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
          preview_sha256: pictureSha(params.previewPng, stored.preview, params.previewSha256),
          composite_png: params.compositePng || null,
          composite_sha256: stored.composite ?? null,
          art_png: params.artPng || null,
          art_sha256: pictureSha(params.artPng, stored.art, params.artSha256),
          art_provenance: params.artProvenance ? JSON.stringify(params.artProvenance) : null,
        })
        .returningAll()
        .execute();
      return row;
    });
  }

  /** A run's candidates; their pictures come from the file store where it has them (readCandidateImage). */
  async getCandidatesForRun(runId: string, tenantId?: string, trx?: Kysely<Database>, opts: { images?: boolean } = {}) {
    const rows = await this.candidatesForRun(runId, tenantId, trx);
    return opts.images === false ? rows : this.withCandidateImages(rows);
  }

  private async candidatesForRun(runId: string, tenantId?: string, trx?: Kysely<Database>) {
    return this.withClient(trx, tenantId, async (client) => {
      let query = client
        .selectFrom('design_studio_candidates')
        .selectAll()
        .where('run_id', '=', runId)
        .orderBy('ordinal', 'asc');
      if (tenantId) {
        query = query.where('tenant_id', '=', tenantId);
      }
      return await query.execute();
    });
  }

  /**
   * What serving one of a candidate's pictures needs, read under row-level security: its run, the
   * hash the row names, the stored file's reference when the store has that file, and the row's bytes
   * only when it does not (a row written before the store). Undefined when the candidate is not the
   * tenant's.
   */
  async getCandidateImageSource(
    id: string,
    tenantId: string,
    kind: CandidateImageKind,
    trx?: Kysely<Database>,
    /** withBytes: the row's bytes even when the store has the file (a route whose file was lost). */
    opts: { withBytes?: boolean } = {}
  ): Promise<{ runId: string; taskId: string; sha256: string | null; ref: BlobRef | null; bytes: Buffer | null } | undefined> {
    const columns = CANDIDATE_IMAGE_COLUMNS[kind];
    const withBytes = opts.withBytes === true;
    return this.withClient(trx, tenantId, async (client) => {
      const row = (
        await sql<{ run_id: string; task_id: string; sha256: string | null; media_type: string | null; size: string | null; bytes: Buffer | null }>`
          SELECT c.run_id, r.task_id, c.${sql.ref(columns.sha)} AS sha256, b.media_type, b.size,
                 CASE WHEN b.sha256 IS NULL OR ${withBytes} THEN c.${sql.ref(columns.bytes)} END AS bytes
          FROM hawa.design_studio_candidates c
          JOIN hawa.design_studio_runs r ON r.id = c.run_id AND r.tenant_id = c.tenant_id
          LEFT JOIN hawa.blobs b ON b.sha256 = c.${sql.ref(columns.sha)}
          WHERE c.id = ${id}::uuid AND c.tenant_id = ${tenantId}::uuid`.execute(client)
      ).rows[0];
      if (!row) return undefined;
      const ref = row.sha256 && row.media_type ? parseBlobRef({ sha256: row.sha256, mediaType: row.media_type, size: Number(row.size) }) ?? null : null;
      return { runId: String(row.run_id), taskId: String(row.task_id), sha256: row.sha256, ref, bytes: row.bytes ? Buffer.from(row.bytes) : null };
    });
  }

  /** One candidate; its pictures come from the file store where it has them (readCandidateImage). */
  async getCandidateById(id: string, tenantId?: string, trx?: Kysely<Database>) {
    const row = await this.withClient(trx, tenantId, async (client) => {
      let query = client
        .selectFrom('design_studio_candidates')
        .selectAll()
        .where('id', '=', id);
      if (tenantId) {
        query = query.where('tenant_id', '=', tenantId);
      }
      return await query.executeTakeFirst();
    });
    return row ? (await this.withCandidateImages([row]))[0] : row;
  }

  async updateCandidate(
    id: string,
    tenantId: string,
    updates: {
      status?: DesignStudioCandidateStatus;
      /** Set once the design exists: a v3 run learns each candidate's archetype from its layout. */
      concept?: Record<string, unknown>;
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
    const stored = await this.storeCandidateImages({ preview: updates.previewPng, composite: updates.compositePng, art: updates.artPng });
    return this.withClient(trx, tenantId, async (client) => {
      const setClause: Record<string, unknown> = {
        updated_at: new Date(),
      };
      if (updates.status !== undefined) setClause.status = updates.status;
      if (updates.concept !== undefined) setClause.concept = JSON.stringify(updates.concept);
      if (updates.score !== undefined) setClause.score = updates.score;
      if (updates.rank !== undefined) setClause.rank = updates.rank;
      if (updates.metrics !== undefined) setClause.metrics = updates.metrics ? JSON.stringify(updates.metrics) : null;
      if (updates.critiques !== undefined) {
        setClause.critiques = updates.critiques.map((c) => JSON.stringify(c));
      }
      if (updates.layouts !== undefined) {
        setClause.layouts = updates.layouts.map((l) => JSON.stringify(l));
      }
      if (updates.previewPng !== undefined) {
        setClause.preview_png = updates.previewPng;
        setClause.preview_sha256 = pictureSha(updates.previewPng, stored.preview, updates.previewSha256);
      } else if (updates.previewSha256 !== undefined) setClause.preview_sha256 = updates.previewSha256;
      if (updates.compositePng !== undefined) {
        setClause.composite_png = updates.compositePng;
        // A new composite replaces the old one's file too; none leaves none.
        setClause.composite_sha256 = stored.composite ?? null;
      }
      if (updates.artPng !== undefined) {
        // New art (or none) replaces the old art's hash too, even when its put failed.
        setClause.art_png = updates.artPng;
        setClause.art_sha256 = pictureSha(updates.artPng, stored.art, updates.artSha256);
      } else if (updates.artSha256 !== undefined) setClause.art_sha256 = updates.artSha256;
      if (updates.artProvenance !== undefined) setClause.art_provenance = updates.artProvenance ? JSON.stringify(updates.artProvenance) : null;

      const [row] = await client
        .updateTable('design_studio_candidates')
        .set(setClause)
        .where('id', '=', id)
        .where('tenant_id', '=', tenantId)
        .returningAll()
        .execute();
      return row;
    });
  }

  async insertJudgment(params: InsertJudgmentParams, trx?: Kysely<Database>) {
    return this.withClient(trx, params.tenantId, async (client) => {
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
    });
  }

  async getJudgmentsForRun(runId: string, tenantId?: string, trx?: Kysely<Database>) {
    return this.withClient(trx, tenantId, async (client) => {
      let query = client
        .selectFrom('design_studio_judgments')
        .selectAll()
        .where('run_id', '=', runId)
        .orderBy('created_at', 'asc');
      if (tenantId) {
        query = query.where('tenant_id', '=', tenantId);
      }
      return await query.execute();
    });
  }

  /**
   * Financial Ledger: records a call at start BEFORE the external API call begins.
   * This guarantees that any initiated spend is journaled prior to network dispatch.
   */
  async recordCallStart(params: RecordCallStartParams, trx?: Kysely<Database>) {
    validateStudioReservation(params.reservation);
    if (params.callOrdinal !== null && (!Number.isSafeInteger(params.callOrdinal) || params.callOrdinal < 1)) {
      throw new TypeError('Studio call ordinal must be a positive safe integer.');
    }
    if (!/^[0-9a-f]{64}$/.test(params.logicalCallSha256)) {
      throw new TypeError('Studio logical call identity must be a SHA-256 digest.');
    }
    return withRlsContext(trx || this.db, { tenantId: params.tenantId, userId: params.actorId }, async (client) => {
      // Cancellation and admission serialize on the same task row. Do not gate finalization:
      // a request admitted before closure may still return a paid response afterwards.
      const task = await client.selectFrom('tasks as t')
        .innerJoin('design_studio_runs as r', join => join.onRef('r.task_id', '=', 't.id')
          .onRef('r.tenant_id', '=', 't.tenant_id').onRef('r.client_id', '=', 't.client_id'))
        .select(['t.id', 't.state']).where('r.id', '=', params.runId).where('t.tenant_id', '=', params.tenantId)
        .forUpdate('t').executeTakeFirst();
      const blocker = taskGenerationBlocker(task?.state);
      if (blocker) throw new TaskGenerationBlockedError(blocker);
      // Read after acquiring the task lock: abandonment may have committed while we waited.
      const run = await client.selectFrom('design_studio_runs').select(['status', 'budget'])
        .where('id', '=', params.runId).where('tenant_id', '=', params.tenantId).executeTakeFirst();
      if (!run || ['abandoned', 'failed', 'degraded'].includes(run.status) ||
          (run.status === 'transferred' && params.stage !== 'parity')) {
        throw new TaskGenerationBlockedError('This Studio run is closed to new model requests.');
      }
      await assertStudioCallsResolved(client, params.tenantId, task!.id, params.runId);
      // Different logical calls must compete for the same remaining slots under the task lock.
      // The run JSON may be stale after a crash or permanently frozen after Canva transfer.
      assertStudioBudgetAdmission(await this.readBudgetUsage(client, params.runId, params.tenantId, run.budget), params.reservation.usd);
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
          call_ordinal: params.callOrdinal,
          logical_call_sha256: params.logicalCallSha256,
          reservation: params.reservation,
          status: 'uncertain',
        })
        .onConflict((oc) => oc.doNothing())
        .returningAll()
        .execute();
      if (!row) throw new ModelCallAdmissionConflictError();
      return row;
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      if (message.startsWith('STUDIO_SCOPE_BUDGET_EXHAUSTED:')) throw new StudioBudgetExhaustedError(message);
      for (const code of ['STUDIO_BUDGET_INVALID', 'STUDIO_BUDGET_HISTORY_INCOMPLETE'] as const) {
        if (message.startsWith(`${code}:`)) throw new StudioBudgetEvidenceError(code, message);
      }
      throw error;
    });
  }

  /**
   * Finalizes the call in the ledger with exact tokens and USD spend.
   */
  async finalizeCall(params: FinalizeCallParams, trx?: Kysely<Database>) {
    const retained = params.retainedResult;
    let retainedValues: Omit<import('../types.js').DesignStudioCallResultsTable, 'created_at'> | undefined;
    if (retained) {
      if (params.status !== 'ok') throw new TypeError('Only a successful validated result may be retained.');
      const payload = JSON.stringify(retained.payload);
      if (!payload || !retained.payload || typeof retained.payload !== 'object' || Array.isArray(retained.payload) || Buffer.byteLength(payload) > 4194304) {
        throw new TypeError('Retained Studio payload must be a bounded JSON object.');
      }
      const image = retained.image;
      if (retained.kind === 'image' && (!image?.length || image.length > 33554432) || retained.kind === 'structured' && image) {
        throw new TypeError('Retained Studio image is missing, oversized or incompatible with its result kind.');
      }
      const imageSha = image ? createHash('sha256').update(image).digest('hex') : null;
      const imageType = image ? sniffBlobMediaType(image) : null;
      if (image && (!imageType || !imageType.startsWith('image/'))) throw new TypeError('Retained image bytes have an unsupported format.');
      const imageBlob = image && imageType && this.blobStore ? await this.blobStore.put(image, imageType) : null;
      retainedValues = { tenant_id: params.tenantId, call_id: params.id, kind: retained.kind,
        payload_text: payload, payload_sha256: createHash('sha256').update(payload).digest('hex'),
        image_sha256: imageSha, image_blob_sha256: imageBlob?.sha256 ?? null, image_bytes: imageBlob ? null : image ?? null };
    }
    const usdEstimate = typeof params.usdEstimate === 'string' && !params.usdEstimate.trim() ? NaN : Number(params.usdEstimate);
    if (!Number.isFinite(usdEstimate) || usdEstimate < 0) {
      throw new TypeError('Studio call cost must be a finite nonnegative estimate.');
    }
    if (params.responseSha256 != null && !/^[0-9a-f]{64}$/.test(params.responseSha256)) {
      throw new TypeError('Studio response identity must be a SHA-256 digest.');
    }
    if (params.latencyMs != null && (!Number.isSafeInteger(params.latencyMs) || params.latencyMs < 0)) {
      throw new TypeError('Studio call latency must be a nonnegative integer.');
    }
    if (params.attempts != null && (!Number.isSafeInteger(params.attempts) || params.attempts < 1)) {
      throw new TypeError('Studio call attempts must be a positive integer.');
    }
    return this.withClient(trx, { tenantId: params.tenantId, actorId: params.actorId }, async (client) => {
      const [row] = await client
        .updateTable('design_studio_calls')
        .set({
          response_id: params.responseId || null,
          served_model: params.servedModel || null,
          provider_request_id: params.providerRequestId || null,
          response_sha256: params.responseSha256 || null,
          latency_ms: params.latencyMs ?? null,
          attempts: params.attempts ?? null,
          input_tokens: params.inputTokens,
          cached_input_tokens: params.cachedInputTokens || 0,
          output_tokens: params.outputTokens,
          images: params.images || 0,
          usd_estimate: usdEstimate.toString(),
          cost_basis: params.costBasis ?? (params.status === 'uncertain' ? 'unavailable' : 'estimate'),
          status: params.status,
          error_code: params.errorCode || null,
          finished_at: params.finishedAt || new Date(),
        })
        .where('id', '=', params.id)
        .where('tenant_id', '=', params.tenantId)
        .where('finished_at', 'is', null)
        .returningAll()
        .execute();
      if (!row) throw new ModelCallFinalizationConflictError();
      if (retainedValues) await client.insertInto('design_studio_call_results').values(retainedValues).execute();
      return row;
    });
  }

  async getCallsForRun(runId: string, tenantId?: string, trx?: Kysely<Database>, actorId?: string) {
    return this.withClient(trx, { tenantId, actorId }, async (client) => {
      let query = client
        .selectFrom('design_studio_calls')
        .selectAll()
        .select(sql<boolean>`EXISTS(SELECT 1 FROM hawa.design_studio_call_results retained
          WHERE retained.tenant_id=design_studio_calls.tenant_id AND retained.call_id=design_studio_calls.id)`.as('has_retained_result'))
        .where('run_id', '=', runId)
        .orderBy('started_at', 'asc');
      if (tenantId) {
        query = query.where('tenant_id', '=', tenantId);
      }
      return await query.execute();
    });
  }

  async getRetainedCallResult(callId: string, tenantId: string, actorId?: string) {
    const row = await this.withClient(undefined, { tenantId, actorId }, client => client.selectFrom('design_studio_call_results')
      .selectAll().where('call_id', '=', callId).where('tenant_id', '=', tenantId).executeTakeFirst());
    if (!row) return null;
    if (createHash('sha256').update(row.payload_text).digest('hex') !== row.payload_sha256) throw new Error('STUDIO_RETAINED_RESULT_CORRUPT');
    let image: Buffer | undefined;
    if (row.kind === 'image') {
      if (row.image_blob_sha256) {
        if (!this.blobStore) throw new Error('STUDIO_RETAINED_BLOB_STORE_UNAVAILABLE');
        image = await this.blobStore.read(row.image_blob_sha256, { verify: true });
      } else image = row.image_bytes ? Buffer.from(row.image_bytes) : undefined;
      if (!image || createHash('sha256').update(image).digest('hex') !== row.image_sha256) throw new Error('STUDIO_RETAINED_IMAGE_CORRUPT');
    }
    return { kind: row.kind, payload: JSON.parse(row.payload_text) as unknown, image };
  }

  private async readBudgetUsage(client: Kysely<Database>, runId: string, tenantId: string, snapshot: unknown): Promise<StudioBudgetUsage> {
    const calls = await sql<{ status: 'ok' | 'error' | 'uncertain'; estimated_usd: string; settled_usd: string | null; attested_usd: string | null; reservation: StudioCallReservation | null; cost_basis: StudioCostBasis | null }>`
      SELECT c.status, c.reservation, c.cost_basis, c.usd_estimate AS estimated_usd,
        (SELECT max((e.value->>'reportedCostUsd')::numeric)
         FROM hawa.studio_run_settlements s CROSS JOIN LATERAL jsonb_array_elements(s.calls) e
         WHERE s.tenant_id=c.tenant_id AND s.run_id=c.run_id AND e.value->>'callId'=c.id::text) AS settled_usd,
        (SELECT max(a.reported_cost_usd) FROM hawa.call_cost_attestations a
         WHERE a.tenant_id=c.tenant_id AND a.call_kind='studio' AND a.call_id=c.id) AS attested_usd
      FROM hawa.design_studio_calls c WHERE c.tenant_id=${tenantId}::uuid AND c.run_id=${runId}::uuid
      ORDER BY c.started_at,c.id`.execute(client);
    return studioBudgetUsage(snapshot, calls.rows.map(c => ({ status: c.status,
      reservedUsd: c.reservation?.usd ?? null, costBasis: c.cost_basis,
      estimatedUsd: Number(c.estimated_usd), settledUsd: c.settled_usd === null ? null : Number(c.settled_usd),
      attestedUsd: c.attested_usd === null ? null : Number(c.attested_usd) })));
  }

  async getBudgetUsage(runId: string, tenantId: string, actorId?: string): Promise<StudioBudgetUsage | null> {
    return withRlsContext(this.db, { tenantId, userId: actorId }, async client => {
      const run = await client.selectFrom('design_studio_runs').select(['budget', 'client_id'])
        .where('tenant_id', '=', tenantId).where('id', '=', runId).executeTakeFirst();
      if (!run) return null;
      const usage = await this.readBudgetUsage(client, runId, tenantId, run.budget);
      const daily = await sql<{ daily: StudioDailyBudget | null }>`SELECT hawa.studio_scope_budget(${run.client_id}::uuid) AS daily`.execute(client);
      return { ...usage, daily: daily.rows[0]?.daily ?? null };
    });
  }

  async recordFeedback(params: RecordFeedbackParams, trx?: Kysely<Database>) {
    return this.withClient(trx, params.tenantId, async (client) => {
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
    });
  }

  async listFeedbackForTask(taskId: string, tenantId?: string, trx?: Kysely<Database>) {
    return this.withClient(trx, tenantId, async (client) => {
      let query = client
        .selectFrom('design_feedback')
        .selectAll()
        .where('task_id', '=', taskId)
        .orderBy('created_at', 'desc');
      if (tenantId) {
        query = query.where('tenant_id', '=', tenantId);
      }
      return await query.execute();
    });
  }

  async listFeedbackForCandidate(candidateId: string, tenantId?: string, trx?: Kysely<Database>) {
    return this.withClient(trx, tenantId, async (client) => {
      let query = client
        .selectFrom('design_feedback')
        .selectAll()
        .where('candidate_id', '=', candidateId)
        .orderBy('created_at', 'desc');
      if (tenantId) {
        query = query.where('tenant_id', '=', tenantId);
      }
      return await query.execute();
    });
  }

  async listFeedbackForRun(runId: string, tenantId?: string, trx?: Kysely<Database>) {
    return this.withClient(trx, tenantId, async (client) => {
      let query = client
        .selectFrom('design_feedback')
        .selectAll()
        .where('run_id', '=', runId)
        .orderBy('created_at', 'desc');
      if (tenantId) {
        query = query.where('tenant_id', '=', tenantId);
      }
      return await query.execute();
    });
  }

  async listRecentFeedback(limit = 100, tenantId?: string, trx?: Kysely<Database>) {
    return this.withClient(trx, tenantId, async (client) => {
      let query = client
        .selectFrom('design_feedback')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(limit);
      if (tenantId) {
        query = query.where('tenant_id', '=', tenantId);
      }
      return await query.execute();
    });
  }
}
