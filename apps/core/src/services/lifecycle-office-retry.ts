/**
 * ADR-142: the office runs a request's automatic design again after it ended without a draft.
 *
 * The owner's first request on the natural-language release (2026-09-29, task ba4469f2) failed at
 * its layout for a reason on the office's side, and nothing could start it again: RequestLifecycle
 * owns the request, the legacy re-drive refused it (LIFECYCLE_OWNED), a requester's reply to a
 * failed first design is kept for the office rather than designed, and the native handoff covers
 * only manual requests and revisions. The requester would have had to send the album and the brief
 * again, which a requester is never asked to do.
 *
 * The retry is an office action, signed and sent through the office gateway to the request's own
 * object (RequestLifecycle.officeRetry), which calls the projection below. The same task is designed
 * again under a new DesignRun `dr-<taskId>-a<n>` (the attempt run id Core's lifecycle guard already
 * admits) and a new Studio run key; the request moves manual → designing and the task
 * failed_operator → received, so its outcome is projected as the first one was. The requester sends
 * nothing and is told nothing more until the draft (or another outcome) arrives.
 */
import { createHash } from 'node:crypto';
import { CHANNEL_INGRESS_USER_ID, isServiceUserId } from '@hawa/contracts';
import { sql, withRlsContext, TaskRepository, type Database, type Kysely } from '@hawa/db';
import { signLifecycleOfficeEvent } from '@hawa/integrations';
import { LifecycleProjectionConflict } from './lifecycle-projection.js';
import { workerSigningSecretOf } from './worker-credential.js';
import { nativeRevisionIntent } from '@hawa/domain';
import { persistChatIntake, type ChatIntake } from './chat-intake.js';
import { freshDirectionLine, planPendingCopyChanges, type CopyFields } from './fresh-round-copy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { log } from '../logging.js';

/** Office roles that may spend on a design again. The worker's gateway admits the same set. */
export const OFFICE_RETRY_ROLES = ['operator', 'art_director', 'creative_director', 'office_admin', 'administrator'] as const;
/** Retries per task: each one pays for a design, and a request that keeps failing needs a person. */
export const MAX_OFFICE_RETRIES = 3;

export interface OfficeRetryProjection {
  requestId: string; tenantId: string; taskId: string; actionId: string;
  actor: { userId: string; role: string }; reason: string;
  expectedRev: number; rev: number; key: string;
}

export interface OfficeRetryResult {
  requestId: string; taskId: string; actionId: string; rev: number; stage: 'designing';
  runId: string; attempt: number; taskState: 'received';
  /**
   * ADR-233: the retried task was a redo or pending-changes round refused as a native revision before
   * fresh rounds existed (request 95eeb08d, task cdfadbf0). Its saved intent cannot change, so the retry
   * designs a fresh successor task (`runId` is `dr-<freshTaskId>`); the refused task is closed.
   */
  freshTaskId?: string;
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
};

/** The design run of retry attempt `n` of a task: the id Core's lifecycle write guard admits. */
export const attemptRunId = (taskId: string, attempt: number) => `dr-${taskId}-a${attempt}`;

export async function projectLifecycleOfficeRetry(db: Kysely<Database>, input: OfficeRetryProjection): Promise<OfficeRetryResult> {
  const { requestId, tenantId, taskId, actionId, actor, reason, expectedRev, rev, key } = input;
  if (!Number.isInteger(expectedRev) || expectedRev < 2 || rev !== expectedRev + 1) {
    throw new LifecycleProjectionConflict('STALE_REVISION', 'The office retry has an invalid revision pair');
  }
  if (!(OFFICE_RETRY_ROLES as readonly string[]).includes(actor.role) || isServiceUserId(actor.userId)) {
    throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR', 'An office operator or director must retry a design');
  }
  const hash = createHash('sha256').update(canonical(input)).digest('hex');
  return withRlsContext(db, { tenantId, userId: CHANNEL_INGRESS_USER_ID, role: 'operator' }, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle:${requestId}`}, 0))`.execute(trx);
    const receipt = await trx.selectFrom('lifecycle_projections').selectAll()
      .where('tenant_id', '=', tenantId).where('request_id', '=', requestId).where('rev', '=', rev).executeTakeFirst();
    if (receipt) {
      if (receipt.idempotency_key !== key || receipt.payload_sha256 !== hash) {
        throw new LifecycleProjectionConflict('IDEMPOTENCY_CONFLICT', 'This revision was already recorded by a different action');
      }
      return receipt.result as unknown as OfficeRetryResult;
    }
    const request = await trx.selectFrom('requests').selectAll()
      .where('tenant_id', '=', tenantId).where('request_id', '=', requestId).executeTakeFirst();
    if (!request || Number(request.rev) !== expectedRev) {
      throw new LifecycleProjectionConflict('STALE_REVISION', `Request is not at expected revision ${expectedRev}`);
    }
    if (request.owner !== 'restate' || request.stage !== 'manual' || request.current_task_id !== taskId) {
      throw new LifecycleProjectionConflict('WRONG_STAGE', 'Only a request whose automatic design ended without a draft can be retried');
    }
    // The revision being left must be a design outcome with no draft and no question: not a manual
    // request, not a draft the office sent back for changes (its reply starts the next round).
    const last = await trx.selectFrom('lifecycle_projections').select(['idempotency_key', 'result'])
      .where('tenant_id', '=', tenantId).where('request_id', '=', requestId).where('rev', '=', expectedRev).executeTakeFirst();
    const lastResult = (last?.result ?? {}) as Record<string, unknown>;
    if (!last || !String(last.idempotency_key).startsWith(`${requestId}:${expectedRev}:designFinished:`) ||
        lastResult.taskId !== taskId || lastResult.stage !== 'manual' || lastResult.revisionId || lastResult.question) {
      throw new LifecycleProjectionConflict('WRONG_STAGE', 'The request\'s last design did not end without a draft; there is nothing to retry');
    }
    const task = await trx.selectFrom('tasks').select(['id', 'request_id', 'state', 'version'])
      .where('tenant_id', '=', tenantId).where('id', '=', taskId).executeTakeFirst();
    if (!task || task.request_id !== requestId) {
      throw new LifecycleProjectionConflict('TASK_ALREADY_OWNED', 'The task is not owned by this request');
    }
    if (task.state !== 'failed_operator') {
      throw new LifecycleProjectionConflict('WRONG_STAGE', `The task is ${task.state}, not waiting for an operator`);
    }
    const unfinished = (await sql<{ id: string }>`SELECT id FROM hawa.design_studio_runs WHERE tenant_id = ${tenantId}::uuid
      AND task_id = ${taskId}::uuid AND status NOT IN ('transferred', 'degraded', 'failed', 'abandoned') LIMIT 1`.execute(trx)).rows[0];
    if (unfinished) {
      throw new LifecycleProjectionConflict('WRONG_STAGE', `Studio run ${unfinished.id} of this task has not finished; abandon it before retrying`);
    }
    const earlier = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.lifecycle_projections
      WHERE tenant_id = ${tenantId}::uuid AND request_id = ${requestId}::uuid
        AND idempotency_key LIKE ${`${requestId}:%:officeRetry:%`} AND result->>'taskId' = ${taskId}`.execute(trx)).rows[0]?.n ?? 0);
    const attempt = earlier + 1;
    if (attempt > MAX_OFFICE_RETRIES) {
      throw new LifecycleProjectionConflict('RETRY_LIMIT_REACHED', `This design was already retried ${earlier} times; a designer should take it over`);
    }
    const fresh = await freshSuccessor(trx, { tenantId, requestId, taskId, chatId: request.chat_id, attempt, actionId,
      actorId: actor.userId, reason, taskVersion: Number(task.version) });
    if (fresh) {
      const changed = await trx.updateTable('requests').set({ stage: 'designing', rev, current_task_id: fresh, updated_at: new Date() })
        .where('tenant_id', '=', tenantId).where('request_id', '=', requestId).where('rev', '=', expectedRev)
        .returning('request_id').executeTakeFirst();
      if (!changed) throw new LifecycleProjectionConflict('STALE_REVISION', 'Request changed during the office retry');
      const result: OfficeRetryResult = { requestId, taskId, actionId, rev, stage: 'designing',
        runId: `dr-${fresh}`, attempt, taskState: 'received', freshTaskId: fresh };
      await trx.insertInto('lifecycle_projections').values({
        tenant_id: tenantId, request_id: requestId, rev, idempotency_key: key,
        payload_sha256: hash, result: result as unknown as Record<string, unknown>,
      }).execute();
      return result;
    }
    await new TaskRepository(trx).transitionState({
      taskId, tenantId, expectedVersion: Number(task.version), fromState: 'failed_operator', toState: 'received',
      actorType: 'user', actorId: actor.userId,
      reason: `The office retried the automatic design (attempt ${attempt}): ${reason}`.slice(0, 1000),
      data: { officeRetry: { attempt, actionId, runId: attemptRunId(taskId, attempt) } },
    }, trx);
    const changed = await trx.updateTable('requests').set({ stage: 'designing', rev, updated_at: new Date() })
      .where('tenant_id', '=', tenantId).where('request_id', '=', requestId).where('rev', '=', expectedRev)
      .returning('request_id').executeTakeFirst();
    if (!changed) throw new LifecycleProjectionConflict('STALE_REVISION', 'Request changed during the office retry');
    const result: OfficeRetryResult = { requestId, taskId, actionId, rev, stage: 'designing',
      runId: attemptRunId(taskId, attempt), attempt, taskState: 'received' };
    await trx.insertInto('lifecycle_projections').values({
      tenant_id: tenantId, request_id: requestId, rev, idempotency_key: key,
      payload_sha256: hash, result: result as unknown as Record<string, unknown>,
    }).execute();
    return result;
  });
}

/**
 * ADR-233: the fresh successor of a redo or pending-changes round that the native-revision guard refused
 * (its saved intent named the parent as a native revision, as every round did before fresh rounds). Null
 * for any other task, which is retried as it is. Only a round of words alone, refused before any spend
 * with NATIVE_REVISION_HANDOFF_REQUIRED, whose parent is this request's delivered design (a redo) or its
 * draft superseded by pending changes, is converted. The successor is a new design of the request with the
 * parent's copy, photos and format and the round's words as art direction; the refused task is closed.
 */
async function freshSuccessor(trx: Kysely<Database>, input: { tenantId: string; requestId: string; taskId: string;
  chatId: string | null; attempt: number; actionId: string; actorId: string; reason: string; taskVersion: number }): Promise<string | null> {
  const { tenantId, requestId, taskId } = input;
  const created = await trx.selectFrom('outbox_commands').select('payload').where('tenant_id', '=', tenantId)
    .where('aggregate_id', '=', taskId).where('command_type', '=', 'task.created').executeTakeFirst();
  const own = created?.payload as Record<string, unknown> | undefined;
  const options = own?.studioOptions && typeof own.studioOptions === 'object' ? own.studioOptions as Record<string, unknown> : {};
  const intent = nativeRevisionIntent(own);
  if (!own || !intent || !UUID.test(intent.parentTaskId) || !intent.directive.trim() || !input.chatId ||
      ['clarified', 'answers', 'reformat', 'freshFrom'].some((k) => options[k] !== undefined) || own.reviewedSource || own.lifecycleAlbum) return null;
  const refusal = (await sql<{ code: string | null }>`SELECT e.data->>'code' AS code FROM hawa.task_events e
    WHERE e.tenant_id = ${tenantId}::uuid AND e.task_id = ${taskId}::uuid AND e.data ? 'outcome'
    ORDER BY e.aggregate_version DESC LIMIT 1`.execute(trx)).rows[0];
  if (refusal?.code !== 'NATIVE_REVISION_HANDOFF_REQUIRED') return null;
  const media = (await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.task_files WHERE tenant_id = ${tenantId}::uuid
    AND task_id = ${taskId}::uuid`.execute(trx)).rows[0];
  if (Number(media?.n ?? 0) > 0) return null;
  const parent = await trx.selectFrom('tasks').select(['id', 'state', 'request_id', 'client_id'])
    .where('tenant_id', '=', tenantId).where('id', '=', intent.parentTaskId).executeTakeFirst();
  const task = await trx.selectFrom('tasks').select(['client_id']).where('tenant_id', '=', tenantId).where('id', '=', taskId).executeTakeFirst();
  if (!parent || parent.request_id !== requestId || parent.client_id !== task?.client_id) return null;
  const superseded = parent.state === 'revision_requested' && (await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM hawa.task_events e
    WHERE e.tenant_id = ${tenantId}::uuid AND e.task_id = ${parent.id}::uuid AND e.data->>'revisionTaskId' = ${taskId}
      AND jsonb_typeof(e.data->'pendingChanges') = 'array') AS ok`.execute(trx)).rows[0]?.ok;
  const kind = parent.state === 'complete' ? 'redo' as const : superseded ? 'pending_changes' as const : null;
  if (!kind) return null;
  const from = await trx.selectFrom('outbox_commands').select('payload').where('tenant_id', '=', tenantId)
    .where('aggregate_id', '=', parent.id).where('command_type', '=', 'task.created').executeTakeFirst();
  const p = from?.payload as Record<string, unknown> | undefined;
  if (!p || !Array.isArray(p.exactCopy) || typeof p.designInstructions !== 'string') {
    throw new LifecycleProjectionConflict('PARENT_BRIEF_MISSING', 'The earlier design has no complete brief to make again');
  }
  const directive = intent.directive.trim().slice(0, 2000);
  const copy = kind === 'pending_changes'
    ? planPendingCopyChanges(p.exactCopy, p as CopyFields, directive.split('\n').filter((line) => line.trim()))
    : { ok: true as const, exactCopy: p.exactCopy, fields: p as CopyFields };
  if (!copy.ok) throw new LifecycleProjectionConflict('WRONG_STAGE', `A change to the design's words cannot be applied safely (${copy.why}); make it by hand`);
  const parentOptions = p.studioOptions && typeof p.studioOptions === 'object' ? p.studioOptions as Record<string, unknown> : {};
  const inherited = Object.fromEntries(['tier', 'imagery', 'previews', 'holdForSelection']
    .filter((name) => parentOptions[name] !== undefined).map((name) => [name, parentOptions[name]]));
  const round = Number.isInteger(options.revisionRound) ? Number(options.revisionRound) : 1;
  const persisted = await persistChatIntake(trx, {
    tenantId, platform: 'telegram', sourceEventId: `lc-${requestId}-r${round}-fresh-${taskId}`, sourceChannelId: input.chatId,
    rawText: directive, rawJson: { freshRetryOf: taskId, actionId: input.actionId, kind }, title: directive.slice(0, 200),
    designInstructions: `${p.designInstructions}\n${freshDirectionLine(kind, directive)}`,
    exactCopy: copy.exactCopy, clientId: task!.client_id, autoGenerate: true,
    ...Object.fromEntries((['headlineEn', 'headlineCkb', 'copyEn', 'copyCkb'] as const)
      .filter((k) => typeof copy.fields[k] === 'string').map((k) => [k, copy.fields[k]])),
    ...(p.variant && typeof p.variant === 'object' ? { variant: p.variant as { width: number; height: number } } : {}),
    ...(typeof p.designStudio === 'boolean' ? { designStudio: p.designStudio } : {}),
    studioOptions: { ...inherited, revisionRound: round, freshFrom: { parentTaskId: parent.id, kind, directive } } as ChatIntake['studioOptions'],
  }, { outboxState: 'recorded' });
  if (persisted.autoGenerateDeclined) throw new LifecycleProjectionConflict('DAILY_CAP_REACHED', 'The automatic design allowance for today is used up');
  const fresh = String(persisted.task.id);
  const claimed = await trx.updateTable('tasks').set({ request_id: requestId }).where('tenant_id', '=', tenantId)
    .where('id', '=', fresh).where('request_id', 'is', null).returning('id').executeTakeFirst();
  if (!claimed) throw new LifecycleProjectionConflict('TASK_ALREADY_OWNED', 'The fresh round task acquired another owner');
  await new TaskRepository(trx).transitionState({
    taskId, tenantId, expectedVersion: input.taskVersion, fromState: 'failed_operator', toState: 'cancelled',
    actorType: 'user', actorId: input.actorId,
    reason: `The office retried it as a new design (attempt ${input.attempt}): ${input.reason}`.slice(0, 1000),
    data: { officeRetry: { attempt: input.attempt, actionId: input.actionId, runId: `dr-${fresh}` }, supersededBy: fresh, freshRound: kind },
  }, trx);
  return fresh;
}

/** The action key of "retry this design" for one request revision, when the caller names none. */
export function officeRetryActionId(requestId: string, rev: number): string {
  const h = createHash('sha256').update(`hawa:office-retry:${requestId}:${rev}`).digest('hex');
  // A version-4 shaped UUID: the gateway admits only RFC 4122 identifiers.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type OfficeRetryRequestResult =
  | { ok: true; status: 200 | 202; body: OfficeRetryResult & { replayed: boolean } }
  | { ok: false; status: 403 | 404 | 409 | 503; code: string; message: string };

/**
 * The Desk's (and the office API's) "retry this design" for a request-owned task. Reads the current
 * request, signs the office event and sends it to the office gateway on Restate, which hands it to
 * the request's own object. A repeated call for the same revision is the same action.
 */
export async function requestLifecycleDesignRetry(db: Kysely<Database>, input: {
  tenantId: string; taskId: string; actor: { userId: string; role: string }; reason: string; actionId?: string;
  fetcher?: typeof fetch;
}): Promise<OfficeRetryRequestResult> {
  const { tenantId, taskId, actor } = input;
  const reason = input.reason.trim().slice(0, 2000) || 'The office retried the automatic design.';
  if (!(OFFICE_RETRY_ROLES as readonly string[]).includes(actor.role) || isServiceUserId(actor.userId)) {
    return { ok: false, status: 403, code: 'OFFICE_RETRY_FORBIDDEN', message: 'An office operator or director must retry a design' };
  }
  const state = await withRlsContext(db, { tenantId, userId: CHANNEL_INGRESS_USER_ID, role: 'operator' }, async (trx) => {
    const task = await trx.selectFrom('tasks').select(['request_id', 'state']).where('tenant_id', '=', tenantId)
      .where('id', '=', taskId).executeTakeFirst();
    if (!task?.request_id) return { task };
    const request = await trx.selectFrom('requests').select(['request_id', 'owner', 'stage', 'rev', 'current_task_id'])
      .where('tenant_id', '=', tenantId).where('request_id', '=', task.request_id).executeTakeFirst();
    const done = await trx.selectFrom('lifecycle_projections').select(['rev', 'result'])
      .where('tenant_id', '=', tenantId).where('request_id', '=', task.request_id)
      .where('idempotency_key', 'like', `${task.request_id}:%:officeRetry:desk:${input.actionId ?? '%'}`)
      .orderBy('rev', 'desc').executeTakeFirst();
    return { task, request, done };
  });
  if (!state.task) return { ok: false, status: 404, code: 'TASK_NOT_FOUND', message: 'Task not found' };
  if (!state.task.request_id || !state.request || state.request.owner !== 'restate') {
    return { ok: false, status: 409, code: 'NOT_LIFECYCLE_OWNED', message: 'This task has no request owner; use its legacy re-drive' };
  }
  const requestId = state.request.request_id as string;
  const doneResult = state.done?.result as unknown as OfficeRetryResult | undefined;
  // The retry of this revision already committed (a lost answer, a second click): answer with it.
  if (doneResult && doneResult.taskId === taskId && (input.actionId ? doneResult.actionId === input.actionId
    : Number(state.request.rev) >= doneResult.rev && state.request.stage !== 'manual')) {
    return { ok: true, status: 200, body: { ...doneResult, replayed: true } };
  }
  if (state.request.stage !== 'manual' || state.request.current_task_id !== taskId) {
    return { ok: false, status: 409, code: 'NOT_RETRYABLE', message: `The request is ${state.request.stage}; only a design that ended without a draft can be retried` };
  }
  const expectedRev = Number(state.request.rev);
  const actionId = input.actionId ?? officeRetryActionId(requestId, expectedRev);
  const ingress = (process.env.RESTATE_INGRESS_URL || '').trim().replace(/\/+$/, '');
  const secret = workerSigningSecretOf() || '';
  if (!ingress || !secret) {
    return { ok: false, status: 503, code: 'LIFECYCLE_GATEWAY_UNAVAILABLE', message: 'The office gateway is not configured; retry this action later' };
  }
  const event = { v: 1 as const, kind: 'retry' as const, eventId: `desk:${actionId}`, requestId, taskId, actionId,
    expectedRev, actor: { userId: actor.userId, role: actor.role }, reason };
  const signature = signLifecycleOfficeEvent(secret, event);
  try {
    const response = await (input.fetcher ?? fetch)(`${ingress}/OfficeDecisionGateway/retryDesign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, event, signature }), signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text().catch(() => '');
    let result: Record<string, unknown> | null = null;
    try { result = JSON.parse(text) as Record<string, unknown>; } catch { result = null; }
    if (response.ok && result?.accepted === true && result.requestId === requestId && result.taskId === taskId &&
        result.actionId === actionId && result.stage === 'designing' && result.rev === expectedRev + 1 &&
        typeof result.runId === 'string' && Number.isInteger(result.attempt)) {
      return { ok: true, status: 202, body: { requestId, taskId, actionId, rev: expectedRev + 1, stage: 'designing',
        runId: result.runId, attempt: result.attempt as number, taskState: 'received', replayed: false,
        ...(typeof result.freshTaskId === 'string' ? { freshTaskId: result.freshTaskId } : {}) } };
    }
    if (response.ok && result?.accepted === false) {
      return { ok: false, status: 409, code: String(result.code || 'NOT_RETRYABLE'), message: 'The request is no longer waiting for an office retry; refresh the task' };
    }
    if (response.status === 400 || response.status === 409) {
      // The request object's refusal carries Core's reason (a terminal error from its projection).
      if (/RETRY_LIMIT_REACHED/.test(text)) {
        return { ok: false, status: 409, code: 'RETRY_LIMIT_REACHED', message: `This design was already retried ${MAX_OFFICE_RETRIES} times; a designer should take it over` };
      }
      return { ok: false, status: 409, code: 'OFFICE_RETRY_CONFLICT', message: 'The request refused this retry; refresh the task' };
    }
    log.warn(`[core:office-retry] gateway HTTP ${response.status} for request ${requestId}`);
  } catch (error) {
    log.warn(`[core:office-retry] gateway did not answer for request ${requestId}:`, error);
  }
  return { ok: false, status: 503, code: 'OFFICE_RETRY_UNCERTAIN',
    message: 'The retry may have started. Send the same action again; no second design will start for it' };
}
