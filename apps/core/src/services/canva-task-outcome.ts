/**
 * What a terminal Canva outcome does to the task record.
 *
 * On 2026-09-23 almost every production task still read RECEIVED after its design had been made and
 * sent: only a "ready" outcome moved a task, the move was a raw UPDATE with no event, and the backup
 * move read the task outside any tenant context, which row-level security answers with no row, so it
 * was skipped without a word. Every failed, stuck or refused run left its task in RECEIVED for good,
 * indistinguishable from work nobody had touched.
 *
 * The rules now:
 *  - a draft that exists (ready, or made with a check still to resolve) moves the task to review
 *    (`human_review`, AWAITING_APPROVAL) and is recorded as a Desk revision with its QC run;
 *  - an outcome with no draft moves the task to `failed_operator` (OPERATOR_REQUIRED): a person has
 *    to follow up, which is what the requester is told;
 *  - every move is a `task.state_changed` event under the caller's tenant context, and only ever
 *    forward from the states that precede a first outcome, so an approved or delivered task is
 *    never dragged back by a late or repeated notification.
 */
import crypto from 'node:crypto';
import { sql, TaskRepository, type Kysely, type Database, type TaskState, type CreateRevisionParams } from '@hawa/db';

export const DRAFT_READY_STATUSES = new Set(['DRAFT_READY', 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW']);
/** A Canva design exists, but an automatic check did not pass or could not run. */
export const DRAFT_NEEDS_CHECK_STATUSES = new Set(['CANVA_CHECK_REQUIRED', 'CANVA_COPY_MISMATCH', 'CANVA_FONT_MISMATCH', 'CANVA_PREVIEW_FAILED']);

/** The states a task is in before its first design outcome. Nothing else is moved by one. */
const PRE_OUTCOME_STATES = [
  'received', 'promotion_pending', 'routing', 'routing_review', 'brief_draft', 'brief_review', 'context_ready',
  'design_planning', 'asset_production', 'studio_composition', 'qa', 'auto_repair', 'failed_retryable',
];

/**
 * `paused`: no draft yet, because a question was sent to the requester before the change is made
 * (edit stage, NEEDS_CLARIFICATION). Their answer starts the change again as a new revision, and
 * this task is then closed (`closeAnsweredQuestion`).
 */
export type OutcomeState = 'human_review' | 'failed_operator' | 'paused';

/** Whether this outcome left a design a person can review. */
export function outcomeHasDraft(status: string, designId?: string): boolean {
  return DRAFT_READY_STATUSES.has(status) || (DRAFT_NEEDS_CHECK_STATUSES.has(status) && Boolean(designId));
}

export interface OutcomeTransition {
  changed: boolean;
  fromState: string;
  toState: string;
}

/**
 * Closes a task that was waiting for the requester's answer (`paused`), once the answer has started
 * the change again as `revisionTaskId`. Only a paused task is moved; anything else is left alone.
 */
export async function closeAnsweredQuestion(
  trx: Kysely<Database>,
  params: { tenantId: string; taskId: string; revisionTaskId: string; actorId?: string | null }
): Promise<OutcomeTransition> {
  const repo = new TaskRepository(trx);
  const task = await repo.findById(params.taskId, params.tenantId, trx);
  if (!task) throw new Error(`Task ${params.taskId} is not visible in tenant ${params.tenantId}`);
  const from = String(task.state);
  if (from !== 'paused') return { changed: false, fromState: from, toState: from };
  await repo.transitionState({
    taskId: params.taskId,
    tenantId: params.tenantId,
    expectedVersion: Number(task.version),
    fromState: 'paused',
    toState: 'cancelled',
    actorType: 'workflow',
    actorId: params.actorId || null,
    reason: `The requester answered the question; the change continues as task ${params.revisionTaskId}.`,
    data: { answeredBy: params.revisionTaskId },
  }, trx);
  return { changed: true, fromState: from, toState: 'cancelled' };
}

/**
 * Moves the task to the outcome's state, with its event, inside the caller's transaction (which must
 * carry the tenant context: `withRlsContext`). A task already there, or past the outcome (approved,
 * delivered, rejected), is left as it is. Throws if the task is not visible, so the caller logs it.
 */
export async function transitionTaskForOutcome(
  trx: Kysely<Database>,
  params: { tenantId: string; taskId: string; toState: OutcomeState; actorId?: string | null; reason: string; data?: Record<string, unknown> }
): Promise<OutcomeTransition> {
  const repo = new TaskRepository(trx);
  const task = await repo.findById(params.taskId, params.tenantId, trx);
  if (!task) throw new Error(`Task ${params.taskId} is not visible in tenant ${params.tenantId}; its outcome could not be recorded`);
  const from = String(task.state);
  // A draft after an operator was called (a re-drive that worked) goes back to review.
  const allowed = params.toState === 'human_review' ? [...PRE_OUTCOME_STATES, 'failed_operator'] : PRE_OUTCOME_STATES;
  if (from === params.toState || !allowed.includes(from)) return { changed: false, fromState: from, toState: from };
  await repo.transitionState({
    taskId: params.taskId,
    tenantId: params.tenantId,
    expectedVersion: Number(task.version),
    fromState: from as TaskState,
    toState: params.toState,
    actorType: 'workflow',
    actorId: params.actorId || null,
    reason: params.reason.slice(0, 1000),
    data: params.data,
  }, trx);
  return { changed: true, fromState: from, toState: params.toState };
}

/**
 * The QC profile a Canva draft's QC run is recorded under: the tenant's own active profile, else the
 * seeded office-wide one. The bridge used to fall back to a hard-coded id that exists in no database,
 * so a missing profile surfaced as a foreign-key error that rolled back the revision and the state.
 */
export async function resolveQcProfileId(trx: Kysely<Database>, tenantId: string): Promise<string> {
  const row = (
    await sql<{ id: string }>`SELECT id FROM hawa.qc_profiles
      WHERE (tenant_id = ${tenantId}::uuid OR tenant_id IS NULL)
      ORDER BY (status = 'active') DESC, (tenant_id IS NULL) ASC, (name = 'office-critical') DESC, created_at DESC
      LIMIT 1`.execute(trx)
  ).rows[0];
  if (!row?.id) {
    throw new Error(`No QC profile is visible to tenant ${tenantId} (the seeded office-critical profile is missing); the Canva draft cannot be recorded as a Desk revision`);
  }
  return row.id;
}

/** A stored Canva export as the QC evaluator reads it. */
export interface ExportRow {
  sha256: string;
  format: string;
  content: Buffer;
  content_check: unknown;
}

export interface CanvaQcEvaluation {
  status: string;
  criticalPass: boolean;
  qaReport: Record<string, unknown> & { errors?: unknown; checks?: unknown };
}

/**
 * A draft the worker reported with a failed or missing check never passes QC here, whatever the
 * export bytes say: approval stays blocked until the check is resolved in Canva and captured again.
 */
export function withWorkerCheckFailure(qc: CanvaQcEvaluation, status: string): CanvaQcEvaluation {
  if (DRAFT_READY_STATUSES.has(status)) return qc;
  const message = `The automatic Canva check reported ${status}; resolve it in Canva and capture again before approval`;
  const report = { ...(qc.qaReport || {}) };
  report.status = 'failed';
  report.criticalPass = false;
  report.passed = false;
  report.errors = [...(Array.isArray(report.errors) ? report.errors : []), message];
  report.checks = [...(Array.isArray(report.checks) ? report.checks : []), { name: 'workerCheck', passed: false, detail: status }];
  return { status: 'failed', criticalPass: false, qaReport: report };
}

export interface BridgeDeps {
  revisionRepo: { createRevision(params: CreateRevisionParams, trx?: Kysely<Database>): Promise<{ id?: string } | undefined> };
  evaluateQc(exportRow: ExportRow | undefined, expectedCopy?: string[]): CanvaQcEvaluation;
}

export interface BridgeParams {
  tenantId: string;
  taskId: string;
  actorId?: string | null;
  status: string;
  designId?: string;
  canvaUrl?: string;
  fallbackCopy?: string[];
  reason: string;
}

export type BridgeResult =
  | { created: false; reason: 'REVISION_EXISTS' }
  | { created: true; revisionId: string; qc: CanvaQcEvaluation; transition: OutcomeTransition };

/**
 * Records a Canva draft as the task's Desk revision, with its QC run, and moves the task to review
 * with its event. All in the caller's transaction: either the Desk can show the draft and the task
 * says so, or neither happened and the caller hears why.
 */
export async function bridgeCanvaDraftRevision(trx: Kysely<Database>, deps: BridgeDeps, p: BridgeParams): Promise<BridgeResult> {
  const task = await new TaskRepository(trx).findById(p.taskId, p.tenantId, trx);
  if (!task) throw new Error(`Task ${p.taskId} is not visible in tenant ${p.tenantId}; the Canva draft cannot be recorded`);
  if (task.current_design_revision_id) return { created: false, reason: 'REVISION_EXISTS' };

  const manifest = (await sql<{ manifest: ({ nodes?: unknown[]; copy?: string[] } & Record<string, unknown>) | null }>`SELECT result->'manifest' AS manifest FROM hawa.canva_design_plans
    WHERE tenant_id = ${p.tenantId}::uuid AND task_id = ${p.taskId}::uuid AND status NOT IN ('failed','abandoned')
    ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0]?.manifest;
  const exportRow = (await sql<ExportRow>`SELECT sha256, format, content, content_check FROM hawa.canva_export_bytes
    WHERE tenant_id = ${p.tenantId}::uuid AND task_id = ${p.taskId}::uuid AND format = 'pptx'
    ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0];
  const candidateLayouts = (await sql<{ layouts: Array<{ shapes?: unknown[] }> | null }>`SELECT c.layouts FROM hawa.design_studio_candidates c
    JOIN hawa.design_studio_runs r ON r.id = c.run_id
    WHERE r.tenant_id = ${p.tenantId}::uuid AND r.task_id = ${p.taskId}::uuid AND c.status = 'winner'
    ORDER BY c.created_at DESC LIMIT 1`.execute(trx)).rows[0]?.layouts;

  const revisionId = crypto.randomUUID();
  const baseNodes = manifest?.nodes || candidateLayouts?.[0]?.shapes || [
    { id: 'canva-page-1', type: 'frame', name: 'Canva Composition', width: 1080, height: 1350 },
    { id: 'canva-text-1', type: 'text', text: task.title || 'Canva Draft' },
  ];
  const neutralManifest = {
    documentId: p.designId || revisionId,
    title: task.title || 'Canva Draft',
    studio: 'canva',
    designId: p.designId,
    canvaUrl: p.canvaUrl,
    nodes: baseNodes,
    ...(manifest || {}),
  };
  const sourceSha256 = exportRow?.sha256 || crypto.createHash('sha256').update(JSON.stringify(neutralManifest)).digest('hex');

  // The move to review is recorded first, as an event. createRevision below sets the same state on
  // its own, without one, which is how the history came to show no move at all.
  const transition = await transitionTaskForOutcome(trx, {
    tenantId: p.tenantId, taskId: p.taskId, toState: 'human_review', actorId: p.actorId, reason: p.reason,
    data: { outcome: p.status, ...(p.designId ? { designId: p.designId } : {}) },
  });

  const revision = await deps.revisionRepo.createRevision({
    id: revisionId,
    tenantId: p.tenantId,
    taskId: p.taskId,
    studio: 'canva',
    sourceStorageKey: `tasks/${p.taskId}/revisions/${revisionId}/source.json`,
    sourceSha256,
    neutralManifest,
    authorType: 'model',
    authorId: 'canva_generator',
    status: 'review',
  }, trx);
  const finalRevisionId = revision?.id || revisionId;

  const profileId = await resolveQcProfileId(trx, p.tenantId);
  const qc = withWorkerCheckFailure(deps.evaluateQc(exportRow, manifest?.copy || p.fallbackCopy), p.status);
  await trx.insertInto('qc_runs').values({
    tenant_id: p.tenantId,
    task_id: p.taskId,
    design_revision_id: finalRevisionId,
    qc_profile_id: profileId,
    status: qc.status as 'passed' | 'failed',
    critical_pass: qc.criticalPass,
    report: qc.qaReport,
    report_sha256: crypto.createHash('sha256').update(JSON.stringify(qc.qaReport)).digest('hex'),
  }).execute();

  return { created: true, revisionId: finalRevisionId, qc, transition };
}
