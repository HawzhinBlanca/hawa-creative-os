/**
 * The office's decisions on a request the lifecycle owns (architecture programme Phase 2, slice 2.4;
 * PHASE2_DESIGN.md sections 2.3, 2.9 and 3, ADR-034). For such a task the Desk's routes (decisions,
 * publish, redrive, cancel, capture) keep their read-only checks, write nothing, and ask
 * RequestLifecycle.officeDecision through Restate's ingress, synchronously, under the idempotency key
 * `desk:<actionId>`. The Desk makes the action id per click and sends it again on a retry, so a double
 * click, or a retry after Core died with the answer, reaches the object once and gets the first answer.
 *
 * One place decides whether a change is pending, whether the draft is current and whether the stage
 * takes the decision: the object's state machine (packages/domain/src/request-lifecycle.ts). Core's own
 * rule (pendingChangeOf) is not asked for these tasks.
 */
import crypto from 'node:crypto';
import {
  SYSTEM_AUTOMATION_USER_ID,
  isLifecycleStage,
  isOfficeActionId,
  officeDecisionKey,
  type OfficeDecisionEvent,
  type OfficeDecisionResult,
  type TaskLifecycle,
} from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { chaosPoint } from '@hawa/observability';
import { isValidUuid } from '../core-helpers.js';
import { log } from '../logging.js';
import { pendingChangeWords } from './pending-change.js';

/** How long Core waits for the object's answer before telling the Desk to press again. */
export const OFFICE_DECISION_TIMEOUT_MS = 30_000;

/**
 * The request a task belongs to, as Postgres has it; null for a task Core owns (no request). Throws
 * when Postgres cannot be read: a guess either way would let both paths act, or neither.
 */
export async function readTaskLifecycle(db: Kysely<Database>, tenantId: string, taskId: string): Promise<TaskLifecycle | null> {
  if (!isValidUuid(taskId) || !isValidUuid(tenantId)) return null;
  const row = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
    (await sql<{ request_id: string; rev: string; stage: string; owner: string }>`SELECT r.request_id::text, r.rev::text, r.stage, r.owner
      FROM hawa.tasks t JOIN hawa.requests r ON r.request_id = t.request_id AND r.tenant_id = t.tenant_id
      WHERE t.tenant_id = ${tenantId}::uuid AND t.id = ${taskId}::uuid`.execute(trx)).rows[0]);
  if (!row) return null;
  return {
    requestId: row.request_id,
    rev: Number(row.rev),
    stage: isLifecycleStage(row.stage) ? row.stage : 'manual',
    owner: row.owner === 'restate' ? 'restate' : 'core',
  };
}

/**
 * The action id of this press: the Desk's Idempotency-Key when it is one, else a new one (a caller
 * that sends none, such as a script, gets no protection from a double press, and its second press is
 * answered by the state machine instead).
 */
export function officeActionIdOf(header: string | undefined | null): { actionId: string; fromCaller: boolean } {
  const presented = String(header ?? '').trim();
  if (isOfficeActionId(presented)) return { actionId: presented, fromCaller: true };
  return { actionId: crypto.randomUUID(), fromCaller: false };
}

export type ForwardedDecision =
  | { kind: 'answered'; result: OfficeDecisionResult }
  /** The object did not answer, or refused the event as unreadable: nothing is known to have changed. */
  | { kind: 'failed'; status: 422 | 503; code: string; message: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Asks RequestLifecycle.officeDecision and waits for its answer. The key is the action's, so the same
 * press asked again (a retry, a double click in flight) is answered with the first invocation's result.
 */
export async function forwardOfficeDecision(
  requestId: string,
  event: Omit<OfficeDecisionEvent, 'v' | 'eventId'>,
  options: { env?: Record<string, string | undefined>; fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<ForwardedDecision> {
  const env = options.env ?? process.env;
  const ingress = (env.RESTATE_INGRESS_URL || '').trim().replace(/\/+$/, '');
  if (!ingress) return { kind: 'failed', status: 503, code: 'RESTATE_NOT_CONFIGURED', message: 'RESTATE_INGRESS_URL is not set, so the request lifecycle cannot be asked; nothing was changed' };
  const key = officeDecisionKey(event.actionId);
  const body: OfficeDecisionEvent = { v: 1, eventId: key, ...event };
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(`${ingress}/RequestLifecycle/${encodeURIComponent(requestId)}/officeDecision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? OFFICE_DECISION_TIMEOUT_MS),
    });
  } catch (err) {
    log.error(`[core:office] RequestLifecycle ${requestId} did not answer ${event.kind} (${key}):`, err);
    return { kind: 'failed', status: 503, code: 'LIFECYCLE_UNAVAILABLE', message: 'The request lifecycle did not answer in time. Press again: the same press is never applied twice' };
  }
  const text = await res.text().catch(() => '');
  if (res.ok) {
    let answer: unknown = null;
    try { answer = JSON.parse(text); } catch { answer = null; }
    if (answer && typeof answer === 'object' && typeof (answer as { accepted?: unknown }).accepted === 'boolean') {
      return { kind: 'answered', result: answer as OfficeDecisionResult };
    }
    log.error(`[core:office] RequestLifecycle ${requestId} answered ${event.kind} (${key}) with something that is not a decision: ${text.slice(0, 200)}`);
    return { kind: 'failed', status: 503, code: 'LIFECYCLE_ANSWER_UNREADABLE', message: 'The request lifecycle\'s answer could not be read' };
  }
  const detail = (() => {
    try { return String((JSON.parse(text) as { message?: unknown }).message ?? text); } catch { return text; }
  })().replace(/\s+/g, ' ').slice(0, 300);
  // A terminal refusal (the event unreadable, a projection Core refused) is final: asking again with
  // the same key gets the same answer. Anything else may pass.
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
    log.warn(`[core:office] RequestLifecycle ${requestId} refused ${event.kind} (${key}): HTTP ${res.status} ${detail}`);
    return { kind: 'failed', status: 422, code: 'LIFECYCLE_REFUSED', message: detail || `The request lifecycle refused the decision (HTTP ${res.status})` };
  }
  log.error(`[core:office] RequestLifecycle ${requestId} failed ${event.kind} (${key}): HTTP ${res.status} ${detail}`);
  return { kind: 'failed', status: 503, code: 'LIFECYCLE_UNAVAILABLE', message: `The request lifecycle could not take the decision now (HTTP ${res.status}). Press again: the same press is never applied twice` };
}

/** What the Desk is told, as HTTP: 200 accepted; 409 for a change pending, another draft or an older revision; 422 for the wrong stage. */
export interface DecisionAnswer {
  status: 200 | 409 | 422 | 503;
  title: string;
  detail: string;
  code: string;
}

/**
 * The pending change in words the Desk already uses (pending-change.ts), naming the round being made.
 * Read-only; a database that cannot be read gives the object's own words.
 */
async function changePendingWords(db: Kysely<Database> | undefined, tenantId: string, requestId: string, fallback: string): Promise<string> {
  if (!db) return fallback;
  try {
    const row = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ id: string; state: string; stage: string }>`SELECT t.id::text, t.state::text, r.stage FROM hawa.requests r
        JOIN hawa.tasks t ON t.id = r.current_task_id AND t.tenant_id = r.tenant_id
        WHERE r.tenant_id = ${tenantId}::uuid AND r.request_id = ${requestId}::uuid`.execute(trx)).rows[0]);
    return row ? pendingChangeWords({ id: row.id, state: row.state, live: row.stage === 'designing' }) : fallback;
  } catch (err) {
    log.warn('[core:office] The pending change could not be read for its words:', err);
    return fallback;
  }
}

/** The object's answer as HTTP. */
export async function decisionAnswer(db: Kysely<Database> | undefined, tenantId: string, requestId: string, forwarded: ForwardedDecision): Promise<DecisionAnswer> {
  if (forwarded.kind === 'failed') {
    return { status: forwarded.status, title: forwarded.status === 503 ? 'Request Lifecycle Unavailable' : 'Refused By The Request Lifecycle', detail: forwarded.message, code: forwarded.code };
  }
  const r = forwarded.result;
  if (r.accepted) return { status: 200, title: 'Accepted', detail: `The request is ${r.stage} (revision ${r.rev})`, code: 'ACCEPTED' };
  switch (r.code) {
    case 'CHANGE_PENDING':
      return { status: 409, title: 'Replaced By A Newer Revision', detail: await changePendingWords(db, tenantId, requestId, r.message), code: r.code };
    case 'NOT_CURRENT_DRAFT':
      return { status: 409, title: 'Not The Current Draft', detail: r.message, code: r.code };
    case 'STALE_REVISION':
      return { status: 409, title: 'Stale Revision', detail: r.message, code: r.code };
    case 'WRONG_STAGE':
    default:
      return { status: 422, title: 'Not In This Stage', detail: r.message, code: r.code || 'WRONG_STAGE' };
  }
}

/**
 * Forwards one office decision and answers it as HTTP: the whole path every route takes for a task
 * the lifecycle owns. The chaos suite kills Core after the object answered and before the Desk heard
 * (point core.office.after-forward): the Desk's retry with the same action id gets the same answer.
 */
export async function decideForLifecycle(
  db: Kysely<Database> | undefined,
  tenantId: string,
  lifecycle: TaskLifecycle,
  event: Omit<OfficeDecisionEvent, 'v' | 'eventId'>,
  options: { env?: Record<string, string | undefined>; fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<{ answer: DecisionAnswer; forwarded: ForwardedDecision }> {
  const forwarded = await forwardOfficeDecision(lifecycle.requestId, event, options);
  await chaosPoint('core.office.after-forward', {
    requestId: lifecycle.requestId, taskId: event.taskId, kind: event.kind, actionId: event.actionId,
    answer: forwarded.kind === 'answered' ? (forwarded.result.accepted ? 'accepted' : forwarded.result.code) : forwarded.code,
  });
  return { answer: await decisionAnswer(db, tenantId, lifecycle.requestId, forwarded), forwarded };
}

/** A refused or failed decision as the problem document the Desk reads (its `code` says which). */
export function decisionProblem(c: { json: (body: unknown, status: number) => Response; req: { url: string } }, answer: DecisionAnswer, extra: Record<string, unknown> = {}): Response {
  return c.json({
    type: `https://hawa.design/errors/${answer.status}`, title: answer.title, status: answer.status, detail: answer.detail, code: answer.code,
    instance: c.req.url, ...extra,
  }, answer.status);
}

/**
 * The approval a Deliver press on a lifecycle task would deliver, read only: the one named, else the
 * task's newest approval; with how many exports it pins and, once a run is claimed, the run's number.
 * Null when the task has none.
 */
export async function approvalToDeliver(db: Kysely<Database>, tenantId: string, taskId: string, approvalId?: string): Promise<{ approvalId: string; pins: number; run: number } | null> {
  if (!isValidUuid(taskId) || (approvalId !== undefined && !isValidUuid(approvalId))) return null;
  return withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
    const row = (await sql<{ id: string; pins: number | string | null; run: number | string | null }>`SELECT a.id::text,
        jsonb_array_length(CASE WHEN jsonb_typeof(a.decision_payload->'pinnedExports') = 'array' THEN a.decision_payload->'pinnedExports' ELSE '[]'::jsonb END) AS pins,
        (SELECT p.executor_run FROM hawa.publications p WHERE p.tenant_id = a.tenant_id AND p.publication_key = 'pub_key_' || a.task_id::text || '_' || a.id::text) AS run
      FROM hawa.approvals a
      WHERE a.tenant_id = ${tenantId}::uuid AND a.task_id = ${taskId}::uuid AND a.decision = 'approved'
        ${approvalId ? sql`AND a.id = ${approvalId}::uuid` : sql``}
      ORDER BY a.created_at DESC LIMIT 1`.execute(trx)).rows[0];
    return row ? { approvalId: row.id, pins: Number(row.pins ?? 0), run: Number(row.run ?? 0) } : null;
  });
}
