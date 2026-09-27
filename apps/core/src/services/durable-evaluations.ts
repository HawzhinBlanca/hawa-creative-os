import { createHash } from 'node:crypto';
import { sql, withRlsContext, withSessionAdvisoryLock, type Database, type Kysely, type RlsContext } from '@hawa/db';
import { EvaluationRunner, fixtureEvaluationIdentity, projectFixtureScore } from '@hawa/evals';
import type { AppError, ModelGateway, RequestContext, Result, StructuredModelRequest, StructuredModelResponse } from '@hawa/contracts';

type Report = Awaited<ReturnType<EvaluationRunner['runFullTournament']>>;
type RunRow = { id: string; action_id: string; name: string; request_hash: string; candidate: { suiteHash: string }; status: string; summary: Report; started_at: Date; completed_at: Date | null };
type Outcome = Result<StructuredModelResponse<unknown>, AppError>;
type CallRow = { id: string; request_hash: string; status: string; outcome: Outcome | null };
export type EvaluationScope = RlsContext & { userId: string };
export class EvaluationError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const hold = (code: string): Outcome => ({ ok: false, error: { code, message: 'Evaluation model work is held pending reconciliation.', retryable: false,
  safeAction: 'Inspect the saved evaluation call before starting further model work.', detail: { requiresReconciliation: true, estimatedCostUsd: null } } });
const safeWord = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) ? value : null;
function safeError(error: AppError): AppError {
  const detail = error.detail || {};
  return { code: safeWord(error.code) || 'EVALUATION_MODEL_ERROR', message: 'Evaluation model call did not produce a usable result.', retryable: false,
    safeAction: detail.requiresReconciliation === true ? 'Inspect the saved evaluation call before starting further model work.' : 'Review the model configuration and evaluation result.',
    detail: { requiresReconciliation: detail.requiresReconciliation === true, estimatedCostUsd: null,
      provider: safeWord(detail.provider), model: safeWord(detail.model), providerRequestId: safeWord(detail.providerRequestId),
      httpStatus: typeof detail.httpStatus === 'number' ? detail.httpStatus : null, attempts: typeof detail.attempts === 'number' ? detail.attempts : null,
      acceptance: ['unknown', 'response_received', 'not_dispatched'].includes(String(detail.acceptance)) ? detail.acceptance : null } };
}
const view = (row: RunRow) => ({ runId: row.id, actionId: row.action_id, name: row.name, status: row.status,
  createdAt: new Date(row.started_at).toISOString(), report: row.completed_at ? row.summary : null,
  resumable: row.status === 'running', completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null });

export class DurableEvaluationService {
  constructor(private db: Kysely<Database>, private gateway: ModelGateway) {}
  private scoped<T>(scope: EvaluationScope, fn: (tx: Kysely<Database>) => Promise<T>) { return withRlsContext(this.db, scope, fn); }
  async list(scope: EvaluationScope) {
    const rows = await this.scoped(scope, tx => sql<RunRow>`SELECT * FROM hawa.eval_runs WHERE tenant_id=${scope.tenantId}::uuid AND action_id IS NOT NULL ORDER BY started_at DESC LIMIT 100`.execute(tx));
    return rows.rows.reverse().map(view);
  }
  async get(scope: EvaluationScope, id: string) {
    if (!uuid(id)) return null;
    const rows = await this.scoped(scope, tx => sql<RunRow>`SELECT * FROM hawa.eval_runs WHERE tenant_id=${scope.tenantId}::uuid AND id=${id}::uuid AND action_id IS NOT NULL`.execute(tx));
    if (!rows.rows[0]) return null;
    const calls = await this.scoped(scope, tx => sql<{ ordinal:number; role:string; deployment:Record<string,unknown>; status:string; outcome:Outcome|null; started_at:Date; finished_at:Date|null }>`
      SELECT ordinal,role,deployment,status,outcome,started_at,finished_at FROM hawa.eval_model_calls
      WHERE tenant_id=${scope.tenantId}::uuid AND run_id=${id}::uuid ORDER BY ordinal`.execute(tx));
    return {...view(rows.rows[0]), calls:calls.rows.map(call=>({ordinal:call.ordinal,role:call.role,status:call.status,
      requestedDeployment:call.deployment,
      provider:call.outcome?.ok ? call.outcome.value.deployment.provider : call.outcome?.error.detail?.provider ?? null,
      model:call.outcome?.ok ? call.outcome.value.deployment.exactModelId : call.outcome?.error.detail?.model ?? null,
      estimatedCostUsd:call.outcome?.ok ? call.outcome.value.usage.estimatedCostUsd ?? null : null,
      latencyMs:call.outcome?.ok ? call.outcome.value.latencyMs : null,
      responseHash:call.outcome?.ok ? call.outcome.value.responseHash : null,
      error:call.outcome && !call.outcome.ok ? call.outcome.error : null,
      startedAt:new Date(call.started_at).toISOString(),finishedAt:call.finished_at ? new Date(call.finished_at).toISOString() : null,
    }))};
  }
  async run(scope: EvaluationScope, input: { actionId: unknown; name: unknown }) {
    if (!['administrator', 'operator'].includes(scope.role || '')) throw new EvaluationError('EVALUATION_ROLE_REQUIRED', 403, 'An administrator or operator must run evaluations.');
    if (!uuid(input.actionId) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160) throw new EvaluationError('EVALUATION_INPUT_INVALID', 400, 'Provide an action UUID and an evaluation name of at most 160 characters.');
    const actionId = input.actionId; const name = input.name.trim();
    const identity = fixtureEvaluationIdentity();
    const requestHash = digest({ name });
    const execution = await withSessionAdvisoryLock(this.db, `evaluation:${scope.tenantId}`, async () => {
      const run = await this.scoped(scope, async tx => {
        // This lock also guards admission if a prior executor loses its session lock.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`evaluation-admit:${scope.tenantId}`},0))`.execute(tx);
        const existing = (await sql<RunRow>`SELECT * FROM hawa.eval_runs WHERE tenant_id=${scope.tenantId}::uuid AND action_id=${actionId}::uuid`.execute(tx)).rows[0];
        if (existing) {
          if (existing.request_hash !== requestHash) throw new EvaluationError('EVALUATION_ACTION_CONFLICT',409,'This action ID belongs to different evaluation inputs.');
          if (!existing.completed_at && existing.candidate.suiteHash !== identity.hash) throw new EvaluationError('EVALUATION_VERSION_CONFLICT',409,'The saved evaluation requires its original evaluator and corpus version.');
          return existing;
        }
        const unsettled = (await sql<{ id: string }>`SELECT r.id FROM hawa.eval_runs r WHERE r.tenant_id=${scope.tenantId}::uuid AND r.action_id IS NOT NULL
          AND (r.completed_at IS NULL OR EXISTS(SELECT 1 FROM hawa.eval_model_calls c WHERE c.tenant_id=r.tenant_id AND c.run_id=r.id AND c.status IN ('pending','uncertain'))) LIMIT 1`.execute(tx)).rows[0];
        if (unsettled) throw new EvaluationError('EVALUATION_PRIOR_RUN_UNSETTLED',409,'Resume or reconcile the existing evaluation before starting another run.');
        const dataset = (await sql<{ id: string }>`INSERT INTO hawa.eval_datasets(tenant_id,name,version,description,content_hash,frozen)
          VALUES(${scope.tenantId}::uuid,'Hawa fixture tournament',${identity.hash},'Fixed fixture diagnostics; not model admission evidence',${identity.hash},true)
          ON CONFLICT(tenant_id,name,version) DO UPDATE SET content_hash=EXCLUDED.content_hash RETURNING id`.execute(tx)).rows[0];
        return (await sql<RunRow>`INSERT INTO hawa.eval_runs(tenant_id,dataset_id,candidate,status,action_id,request_hash,actor_id,name)
          VALUES(${scope.tenantId}::uuid,${dataset.id}::uuid,${JSON.stringify({kind:'fixture_tournament_v1',suiteHash:identity.hash})}::jsonb,'running',${actionId}::uuid,${requestHash},${scope.userId}::uuid,${name}) RETURNING *`.execute(tx)).rows[0];
      });
      if (run.completed_at) return view(run);
      let ordinal = 0;
      const gateway: ModelGateway = {
        resolve: this.gateway.resolve.bind(this.gateway),
        embed: async () => ({ok:false,error:{code:'EVALUATION_OPERATION_UNSUPPORTED',message:'Embedding is outside this fixture protocol.',retryable:false,safeAction:'Use the supported fixture evaluation protocol.'}}),
        rerank: async () => ({ok:false,error:{code:'EVALUATION_OPERATION_UNSUPPORTED',message:'Reranking is outside this fixture protocol.',retryable:false,safeAction:'Use the supported fixture evaluation protocol.'}}),
        generateStructured: async <T>(_ctx: RequestContext, request: StructuredModelRequest): Promise<Result<StructuredModelResponse<T>, AppError>> => {
          ordinal++;
          const context: RequestContext = {tenantId:scope.tenantId,actor:{type:'user',id:scope.userId},correlationId:run.id,
            deadline:new Date(Date.now()+request.budget.maxLatencyMs).toISOString(),idempotencyKey:`${run.id}:${ordinal}`};
          const result = await this.call(scope,run.id,ordinal,context,request,identity);
          return result as Result<StructuredModelResponse<T>,AppError>;
        },
      };
      const report = await new EvaluationRunner(gateway).runFullTournament();
      const finished = await this.scoped(scope, tx => sql<RunRow>`UPDATE hawa.eval_runs SET status=${report.executionStatus === 'stopped' ? 'failed' : 'completed'},
        summary=${JSON.stringify(report)}::jsonb,completed_at=now() WHERE tenant_id=${scope.tenantId}::uuid AND id=${run.id}::uuid AND completed_at IS NULL RETURNING *`.execute(tx));
      if (!finished.rows[0]) throw new EvaluationError('EVALUATION_FINALIZATION_CONFLICT',409,'The evaluation outcome was already recorded; reload its saved result.');
      return view(finished.rows[0]);
    });
    if (!execution.acquired) throw new EvaluationError('EVALUATION_BUSY',409,'An evaluation is already executing; reload its saved status.');
    return execution.value;
  }

  private async call(scope: EvaluationScope, runId: string, ordinal: number, context: RequestContext, request: StructuredModelRequest,
    identity: ReturnType<typeof fixtureEvaluationIdentity>): Promise<Outcome> {
    const requestHash = digest(request);
    // Recovery reads the original admission before consulting mutable provider availability.
    const prior = (await this.scoped(scope,tx=>sql<CallRow>`SELECT id,request_hash,status,outcome FROM hawa.eval_model_calls
      WHERE tenant_id=${scope.tenantId}::uuid AND run_id=${runId}::uuid AND ordinal=${ordinal}`.execute(tx))).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) return hold('EVALUATION_CALL_IDENTITY_CHANGED');
      return prior.outcome || hold('EVALUATION_CALL_UNCERTAIN');
    }
    const deployment = await this.gateway.resolve(context,request.role);
    if (!deployment.ok) return {ok:false,error:safeError(deployment.error)};
    const reserved = await this.scoped(scope, async tx => {
      const parent = (await sql<{status:string}>`SELECT status FROM hawa.eval_runs WHERE tenant_id=${scope.tenantId}::uuid AND id=${runId}::uuid AND completed_at IS NULL FOR UPDATE`.execute(tx)).rows[0];
      if (!parent) throw new EvaluationError('EVALUATION_ALREADY_STOPPED',409,'The evaluation is no longer running.');
      const existing = (await sql<CallRow>`SELECT id,request_hash,status,outcome FROM hawa.eval_model_calls WHERE tenant_id=${scope.tenantId}::uuid AND run_id=${runId}::uuid AND ordinal=${ordinal}`.execute(tx)).rows[0];
      if (existing) return {fresh:false,row:existing};
      const row = (await sql<CallRow>`INSERT INTO hawa.eval_model_calls(tenant_id,run_id,ordinal,request_hash,role,deployment)
        VALUES(${scope.tenantId}::uuid,${runId}::uuid,${ordinal},${requestHash},${request.role},${JSON.stringify(deployment.value)}::jsonb) RETURNING *`.execute(tx)).rows[0];
      return {fresh:true,row};
    });
    if (reserved.row.request_hash !== requestHash) return hold('EVALUATION_CALL_IDENTITY_CHANGED');
    if (!reserved.fresh) return reserved.row.status === 'completed' && reserved.row.outcome ? reserved.row.outcome : hold('EVALUATION_CALL_UNCERTAIN');
    let outcome: Outcome;
    try {
      const response = await this.gateway.generateStructured<unknown>(context,request);
      if (response.ok) {
        const r=response.value;
        outcome={ok:true,value:{deployment:r.deployment,value:projectFixtureScore(r.value,request.role,identity),responseHash:r.responseHash,
          invocationId:r.invocationId,usage:r.usage,latencyMs:r.latencyMs,attempts:r.attempts,completedAt:r.completedAt,...(r.traceId ? {traceId:r.traceId} : {})}};
      } else outcome={ok:false,error:safeError(response.error)};
    } catch { outcome=hold('EVALUATION_CALL_OUTCOME_UNKNOWN'); }
    const status=!outcome.ok && outcome.error.detail?.requiresReconciliation===true ? 'uncertain' : 'completed';
    try {
      const saved=await this.scoped(scope,tx=>sql<{id:string}>`UPDATE hawa.eval_model_calls SET status=${status},outcome=${JSON.stringify(outcome)}::jsonb,finished_at=now()
        WHERE tenant_id=${scope.tenantId}::uuid AND id=${reserved.row.id}::uuid AND finished_at IS NULL RETURNING id`.execute(tx));
      if (!saved.rows.length) return hold('EVALUATION_CALL_FINALIZATION_CONFLICT');
    } catch { return hold('EVALUATION_CALL_SAVE_UNKNOWN'); }
    return outcome;
  }
}
