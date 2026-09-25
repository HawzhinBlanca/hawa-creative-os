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
import { sql, withRlsContext, TaskRepository, RevisionRepository, type Kysely, type Database, type TaskState, type CreateRevisionParams } from '@hawa/db';

export const DRAFT_READY_STATUSES = new Set(['DRAFT_READY', 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW']);

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

/**
 * Whether this outcome left a design a person can review. The worker names the design only once it
 * is bound to the task, so a design id is a draft whatever the status says. Until 2026-09-24 only a
 * list of status names counted: a preview export Canva refused once (CANVA_PREVIEW_UNCERTAIN, _STALE,
 * _SUBMITTED) left a bound design with no Desk revision, and the task with nothing to approve.
 */
export function outcomeHasDraft(status: string, designId?: string): boolean {
  return DRAFT_READY_STATUSES.has(status) || Boolean(designId);
}

export interface OutcomeTransition {
  changed: boolean;
  fromState: string;
  toState: string;
  /** tasks.version after this call: the new version when it moved the task, the current one when not. */
  version: number;
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
  if (from !== 'paused') return { changed: false, fromState: from, toState: from, version: Number(task.version) };
  const moved = await repo.transitionState({
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
  return { changed: true, fromState: from, toState: 'cancelled', version: Number(moved.version) };
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
  // A draft after an operator was called (a re-drive that worked) goes back to review, and a re-drive
  // that stopped to ask the requester a question waits for the answer rather than the operator.
  const allowed = params.toState === 'human_review' || params.toState === 'paused' ? [...PRE_OUTCOME_STATES, 'failed_operator'] : PRE_OUTCOME_STATES;
  if (from === params.toState || !allowed.includes(from)) return { changed: false, fromState: from, toState: from, version: Number(task.version) };
  const moved = await repo.transitionState({
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
  return { changed: true, fromState: from, toState: params.toState, version: Number(moved.version) };
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
  | { created: false; reason: 'REVISION_EXISTS'; qcRecorded: boolean }
  | { created: true; revisionId: string; qc: CanvaQcEvaluation; transition: OutcomeTransition };

export type ExportQcResult =
  | { recorded: false; reason: 'NO_REVISION' | 'NO_NEWER_CHECKED_EXPORT' | 'REVISION_REQUESTED' }
  | { recorded: true; revisionId: string; revisionCreated: boolean; qc: CanvaQcEvaluation; transition?: OutcomeTransition };

/**
 * Records a QC run for the task's current revision from a copy-and-font check (a PPTX export of the
 * bound design, with its check) retrieved after that revision's latest QC run. The draft's first QC
 * run is written once, with the revision, so a check that timed out or failed then left approval
 * blocked for good: nothing wrote another, however the office captured again (2026-09-24). Called
 * when an export is retrieved, when the worker reports again, and on a re-drive; it writes nothing
 * when no newer checked export exists, so calling it twice records one run.
 *
 * A task whose revision had changes requested (`revision_requested`) cannot approve that revision
 * again. A check captured through the Canva routes after the request (`rework`: the Desk's capture,
 * not a sweep, a report or a re-drive) is the changed design: it is recorded as a new revision, with
 * its QC run, and the task goes back to review. Nothing recorded one until 2026-09-24, so a Desk
 * "Request Revision" left the task unapprovable for good.
 */
export async function recordCheckedExportQc(
  trx: Kysely<Database>,
  evaluateQc: BridgeDeps['evaluateQc'],
  p: { tenantId: string; taskId: string; fallbackCopy?: string[]; actorId?: string | null; rework?: boolean }
): Promise<ExportQcResult> {
  const task = await new TaskRepository(trx).findById(p.taskId, p.tenantId, trx);
  let revisionId = task?.current_design_revision_id;
  if (!task || !revisionId) return { recorded: false, reason: 'NO_REVISION' };
  if (task.state === 'revision_requested' && !p.rework) return { recorded: false, reason: 'REVISION_REQUESTED' };
  // Changes requested: only a check made after the request (the task's last update) shows them.
  const reworkedSince = task.state === 'revision_requested' ? task.updated_at : null;
  const exportRow = (await sql<ExportRow>`SELECT b.sha256, b.format, b.content, b.content_check FROM hawa.canva_export_bytes b
    JOIN hawa.canva_remote_operations o ON o.id = b.operation_id AND o.tenant_id = b.tenant_id AND o.status = 'retrieved'
    JOIN hawa.canva_bindings g ON g.tenant_id = b.tenant_id AND g.task_id = b.task_id AND g.status = 'bound'
      AND g.canva_design_id = o.design_id AND g.version = o.binding_version
    WHERE b.tenant_id = ${p.tenantId}::uuid AND b.task_id = ${p.taskId}::uuid AND b.format = 'pptx' AND b.content_check IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM hawa.qc_runs q WHERE q.tenant_id = b.tenant_id AND q.design_revision_id = ${revisionId}::uuid AND q.started_at >= b.created_at)
      AND (${reworkedSince}::timestamptz IS NULL OR b.created_at > ${reworkedSince}::timestamptz)
    ORDER BY b.created_at DESC LIMIT 1`.execute(trx)).rows[0];
  if (!exportRow) return { recorded: false, reason: 'NO_NEWER_CHECKED_EXPORT' };
  const copy = (await sql<{ copy: string[] | null }>`SELECT result->'manifest'->'copy' AS copy FROM hawa.canva_design_plans
    WHERE tenant_id = ${p.tenantId}::uuid AND task_id = ${p.taskId}::uuid AND status NOT IN ('failed','abandoned')
    ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0]?.copy;
  const qc = evaluateQc(exportRow, copy || p.fallbackCopy);
  let transition: OutcomeTransition | undefined;
  if (reworkedSince) {
    // The move is recorded as an event first, as the bridge does; createRevision then points the
    // task at the new revision. The new revision keeps the changed revision's document.
    const prior = (await sql<{ neutral_manifest: Record<string, unknown> | null }>`SELECT neutral_manifest FROM hawa.design_revisions
      WHERE tenant_id = ${p.tenantId}::uuid AND id = ${revisionId}::uuid`.execute(trx)).rows[0]?.neutral_manifest;
    const moved = await new TaskRepository(trx).transitionState({
      taskId: p.taskId, tenantId: p.tenantId, expectedVersion: Number(task.version), fromState: 'revision_requested', toState: 'human_review',
      actorType: 'workflow', actorId: p.actorId || null,
      reason: 'The requested changes were captured from Canva with a copy-and-font check; the capture is the revision to review.',
      data: { changedRevisionId: revisionId, exportSha256: exportRow.sha256 },
    }, trx);
    const newId = crypto.randomUUID();
    const revision = await new RevisionRepository(trx).createRevision({
      id: newId, tenantId: p.tenantId, taskId: p.taskId, studio: 'canva',
      sourceStorageKey: `tasks/${p.taskId}/revisions/${newId}/source.json`, sourceSha256: exportRow.sha256,
      neutralManifest: { ...(prior || {}), revisedFrom: revisionId },
      authorType: p.actorId ? 'user' : 'workflow', authorId: p.actorId || 'canva_capture', status: 'review',
    }, trx);
    revisionId = revision?.id || newId;
    transition = { changed: true, fromState: 'revision_requested', toState: 'human_review', version: Number(moved.version) };
  }
  const profileId = await resolveQcProfileId(trx, p.tenantId);
  // A revision's runs under one profile are numbered (UNIQUE design_revision_id, qc_profile_id, attempt).
  const attempt = Number((await sql<{ n: number | string | null }>`SELECT max(attempt) AS n FROM hawa.qc_runs
    WHERE tenant_id = ${p.tenantId}::uuid AND design_revision_id = ${revisionId}::uuid AND qc_profile_id = ${profileId}::uuid`.execute(trx)).rows[0]?.n || 0) + 1;
  await trx.insertInto('qc_runs').values({
    tenant_id: p.tenantId,
    task_id: p.taskId,
    design_revision_id: revisionId,
    qc_profile_id: profileId,
    attempt,
    status: qc.status as 'passed' | 'failed',
    critical_pass: qc.criticalPass,
    report: qc.qaReport,
    report_sha256: crypto.createHash('sha256').update(JSON.stringify(qc.qaReport)).digest('hex'),
  }).execute();
  return { recorded: true, revisionId, revisionCreated: Boolean(reworkedSince), qc, ...(transition ? { transition } : {}) };
}

/**
 * Records a Canva draft as the task's Desk revision, with its QC run, and moves the task to review
 * with its event. All in the caller's transaction: either the Desk can show the draft and the task
 * says so, or neither happened and the caller hears why.
 */
export async function bridgeCanvaDraftRevision(trx: Kysely<Database>, deps: BridgeDeps, p: BridgeParams): Promise<BridgeResult> {
  const task = await new TaskRepository(trx).findById(p.taskId, p.tenantId, trx);
  if (!task) throw new Error(`Task ${p.taskId} is not visible in tenant ${p.tenantId}; the Canva draft cannot be recorded`);
  if (task.current_design_revision_id) {
    // The draft is already the Desk's revision. A check captured since its last QC run is recorded now.
    const recheck = await recordCheckedExportQc(trx, deps.evaluateQc, { tenantId: p.tenantId, taskId: p.taskId, fallbackCopy: p.fallbackCopy });
    return { created: false, reason: 'REVISION_EXISTS', qcRecorded: recheck.recorded };
  }

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

type ExportFormat = 'png' | 'pptx';
type CanvaScope = { tenantId: string; actorId: string };

export interface DraftRecheckDeps extends BridgeDeps {
  canva: {
    startExport(s: CanvaScope, taskId: string, key: string, format: ExportFormat, expectedVersion: number): Promise<{ operationId?: string; status: string }>;
    exportStatus(s: CanvaScope, taskId: string, id: string): Promise<{ status: string }>;
  };
  /** Between two reads of an export Canva is still making. */
  wait?: (ms: number) => Promise<void>;
}

export interface DraftRecheckResult {
  /** Each format's export as it ended here: retrieved, submitted (left to the sweeper), failed, or the refusal. */
  exports: Record<ExportFormat, string>;
  revisionId?: string;
  revisionCreated: boolean;
  qc?: CanvaQcEvaluation;
  /** The task's move, when the re-check made one (a first revision, or the capture after a revision request). */
  transition?: OutcomeTransition;
}

/**
 * A re-drive of a task whose design is already in Canva runs that draft's exports and checks again
 * (the preview PNG and the copy-and-font PPTX), then records the draft as the Desk's revision if it is
 * not one yet, or the new check as its QC run. Nothing is designed again. It answered ALREADY_BOUND
 * and did nothing until 2026-09-24, which left a draft whose automatic check had timed out, or whose
 * preview Canva had refused once, with no way to be approved.
 *
 * The exports are made with the Canva connection that made the design, and a pending export of a
 * format (the worker's, which ran out of polls) is followed rather than refused as CANVA_EXPORT_PENDING.
 */
export async function recheckBoundDraft(
  db: Kysely<Database>,
  deps: DraftRecheckDeps,
  p: {
    tenantId: string; taskId: string; actorId: string; designId: string; bindingVersion: number; canvaUrl?: string; fallbackCopy?: string[]; polls?: number;
    /** Only make the exports again: a lifecycle-owned draft is recorded by its projection (captureBoundDraftIn). */
    exportsOnly?: boolean;
  }
): Promise<DraftRecheckResult> {
  const scope = { tenantId: p.tenantId, userId: p.actorId, role: 'operator' };
  const wait = deps.wait || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const owner = (await withRlsContext(db, scope, async (trx) =>
    (await sql<{ actor_id: string }>`SELECT actor_id FROM hawa.canva_remote_operations
      WHERE tenant_id = ${p.tenantId}::uuid AND task_id = ${p.taskId}::uuid AND kind = 'create' AND design_id = ${p.designId}
      ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0]?.actor_id)) || p.actorId;
  const canvaScope = { tenantId: p.tenantId, actorId: owner };

  const rerun = async (format: ExportFormat): Promise<string> => {
    let res: { operationId?: string; status: string };
    try {
      res = await deps.canva.startExport(canvaScope, p.taskId, `recheck-${format}-${crypto.randomUUID()}`, format, p.bindingVersion);
    } catch (err) {
      if ((err as { code?: string })?.code !== 'CANVA_EXPORT_PENDING') return `refused: ${(err as { code?: string })?.code || (err as Error)?.message || err}`;
      const pending = await withRlsContext(db, scope, async (trx) =>
        (await sql<{ id: string }>`SELECT id FROM hawa.canva_remote_operations
          WHERE tenant_id = ${p.tenantId}::uuid AND task_id = ${p.taskId}::uuid AND kind = 'export' AND design_id = ${p.designId}
            AND metadata->>'format' = ${format} AND status = 'submitted' AND actor_id = ${owner}
          ORDER BY created_at DESC LIMIT 1`.execute(trx)).rows[0]?.id);
      if (!pending) return 'refused: CANVA_EXPORT_PENDING';
      res = { operationId: pending, status: 'submitted' };
    }
    try {
      for (let n = 0; n < (p.polls ?? 8) && res.status === 'submitted' && res.operationId; n++) {
        await wait(2000);
        res = { ...res, ...(await deps.canva.exportStatus(canvaScope, p.taskId, res.operationId)) };
      }
    } catch (err) {
      return `refused: ${(err as { code?: string })?.code || (err as Error)?.message || err}`;
    }
    return res.status;
  };
  const [png, pptx] = await Promise.all([rerun('png'), rerun('pptx')]);
  if (p.exportsOnly) return { exports: { png, pptx }, revisionCreated: false };

  return withRlsContext(db, scope, async (trx) => ({ exports: { png, pptx }, ...await captureBoundDraftIn(trx, deps, p) }));
}

/**
 * The recording half of a re-check, in the caller's transaction: the bound draft's newest check
 * becomes the draft's QC run when the task has its Desk revision (with `rework`, after a revision
 * request, the new revision), or the draft becomes the revision. The request lifecycle's projection
 * runs it for a captured draft (slice 2.4, op bridgeCapturedRevision); a re-drive runs it after
 * making the exports again.
 */
export async function captureBoundDraftIn(
  trx: Kysely<Database>,
  deps: BridgeDeps,
  p: { tenantId: string; taskId: string; actorId: string; designId: string; bindingVersion: number; canvaUrl?: string; fallbackCopy?: string[]; rework?: boolean }
): Promise<Omit<DraftRecheckResult, 'exports'>> {
  const task = await new TaskRepository(trx).findById(p.taskId, p.tenantId, trx);
  if (!task) throw new Error(`Task ${p.taskId} is not visible in tenant ${p.tenantId}; its draft cannot be re-checked`);
  if (task.current_design_revision_id) {
    const recorded = await recordCheckedExportQc(trx, deps.evaluateQc, { tenantId: p.tenantId, taskId: p.taskId, fallbackCopy: p.fallbackCopy, actorId: p.actorId, ...(p.rework ? { rework: true } : {}) });
    return recorded.recorded
      ? { revisionId: recorded.revisionId, revisionCreated: recorded.revisionCreated, qc: recorded.qc, ...(recorded.transition ? { transition: recorded.transition } : {}) }
      : { revisionId: task.current_design_revision_id, revisionCreated: false };
  }
  // No revision yet: the draft becomes one, its QC run from whatever check the bound design has.
  const checked = (await sql<{ id: string }>`SELECT b.id FROM hawa.canva_export_bytes b
    JOIN hawa.canva_remote_operations o ON o.id = b.operation_id AND o.tenant_id = b.tenant_id AND o.status = 'retrieved'
    WHERE b.tenant_id = ${p.tenantId}::uuid AND b.task_id = ${p.taskId}::uuid AND b.format = 'pptx' AND b.content_check IS NOT NULL
      AND o.design_id = ${p.designId} AND o.binding_version = ${p.bindingVersion}
    LIMIT 1`.execute(trx)).rows[0];
  const status = checked ? 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' : 'CANVA_CHECK_REQUIRED';
  const bridged = await bridgeCanvaDraftRevision(trx, deps, {
    tenantId: p.tenantId, taskId: p.taskId, actorId: p.actorId, status, designId: p.designId, canvaUrl: p.canvaUrl, fallbackCopy: p.fallbackCopy,
    reason: `Canva draft ${p.designId} re-checked by a re-drive (${status}); awaiting visual review.`,
  });
  return bridged.created
    ? { revisionId: bridged.revisionId, revisionCreated: true, qc: bridged.qc, transition: bridged.transition }
    : { revisionCreated: false };
}
