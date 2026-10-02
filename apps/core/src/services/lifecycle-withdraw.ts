/**
 * ADR-230: a request is withdrawn (closed, `cancelled`) by its requester's cancel or the office's Cancel.
 *
 * Until now nobody could close a Telegram request: RequestLifecycle had no cancel transition (ADR-144),
 * the Desk's Cancel answered LIFECYCLE_OWNED, and a requester's "cancel it" was a note for the office.
 * A request opened by mistake (production request 3a4c6ac4, 2026-10-01) stayed open for good, and later
 * words bound to it.
 *
 * RequestLifecycle stays the only writer of a request's revisions: its `withdraw` handler calls the
 * projection below, which closes the task and the request in one transaction under one receipt. The
 * requester's cancel is admitted only when Core's intake recorded that decision for that Telegram
 * update (lifecycleAction `withdraw`); the office's only through the signed office gateway, from the
 * Desk's Cancel (`requestLifecycleWithdraw`).
 *
 * A request can be withdrawn while nothing has been approved: designing, awaiting an answer, with a
 * designer or sent back for changes (`manual`), or in review. Once approved, being delivered or
 * delivered, it cannot: the requester's cancel is kept for the office as before, and they are told
 * truthfully that it came too late; the office's Cancel is refused.
 */
import { createHash } from 'node:crypto';
import { CHANNEL_INGRESS_USER_ID, isServiceUserId, toApiTaskStatus } from '@hawa/contracts';
import { sql, withRlsContext, TaskRepository, type Database, type Kysely } from '@hawa/db';
import { WITHDRAW_MESSAGES, requesterLang, say, signLifecycleOfficeEvent, type RequesterLang } from '@hawa/integrations';
import { LifecycleProjectionConflict } from './lifecycle-projection.js';
import { lateChangeOfficeAlert, recordRoutingRefusal, type LateChangeStage, type LateRequesterChange } from './lifecycle-chat-target.js';
import { officeChatsFor } from './office-chats.js';
import { designName, distinctNames, openingWords, requestLabel, sentWhen, shortTitle } from './requester-turn.js';
import { workerSigningSecretOf } from './worker-credential.js';
import { log } from '../logging.js';

/** Stages a request can be withdrawn from: nothing approved yet. */
export const WITHDRAWABLE_STAGES = ['designing', 'awaiting_answer', 'manual', 'in_review'] as const;
const withdrawable = (stage: string) => (WITHDRAWABLE_STAGES as readonly string[]).includes(stage);
/** Stages too late for a withdraw: the requester's cancel is kept for the office. */
const TOO_LATE = ['approved', 'delivering', 'delivered'] as const;
/** Office roles that may cancel a request in the Desk (the Desk's task controls admit the same). */
export const OFFICE_WITHDRAW_ROLES = ['operator', 'administrator', 'art_director', 'creative_director', 'designer', 'office_admin'] as const;
const TERMINAL_TASK_STATES = new Set(['complete', 'cancelled', 'rejected']);

export type WithdrawActor =
  | { kind: 'requester'; updateId: number }
  | { kind: 'office'; userId: string; role: string };

export interface WithdrawProjection {
  requestId: string; tenantId: string; taskId: string;
  /** `chatinbox:withdraw:<update>` for a requester, `desk:<action>` for the office. */
  eventId: string;
  actor: WithdrawActor;
  reason: string;
  expectedRev: number; rev: number; key: string;
}

type Alert = { chatId: string; text: string };

export type WithdrawResult =
  | { withdrawn: true; requestId: string; taskId: string; rev: number; stage: 'cancelled'; fromStage: string;
      actor: 'requester' | 'office'; requesterNotice?: Alert; officeAlerts: Alert[] }
  /** A requester's cancel that came too late: kept for the office as a note; the request is unchanged. */
  | { withdrawn: false; requestId: string; taskId: string; rev: number; stage: string;
      actor: 'requester'; requesterNotice?: Alert; officeAlerts: Alert[] };

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
};

const STAGE_WORDS: Record<string, string> = {
  designing: 'still being designed', awaiting_answer: 'waiting for their answer to a question',
  manual: 'with a designer', in_review: 'waiting for office review',
};

/**
 * What a requester hears when their cancel came too late: the design was already approved, is being
 * sent, or was sent. `told`: an office member heard of it; otherwise the words are kept for the office.
 */
export function withdrawTooLateText(stage: string, title: string, lang: RequesterLang, told: boolean, label?: string): string {
  // ADR-230 addendum (L16): `label` names a request whose title names nothing (requestLabel).
  const t = { title: label ?? designName(title, lang) };
  if (!told) return say(WITHDRAW_MESSAGES.tooLateKept, lang, t);
  return say(stage === 'delivered' ? WITHDRAW_MESSAGES.tooLateDelivered
    : stage === 'delivering' ? WITHDRAW_MESSAGES.tooLateDelivering : WITHDRAW_MESSAGES.tooLateApproved, lang, t);
}

/** Whether a cancel can no longer withdraw a request at this stage (it is kept for the office). */
export const tooLateToWithdraw = (stage: string) => (TOO_LATE as readonly string[]).includes(stage);

/**
 * The office's word that a requester withdrew their request (ADR-230; ADR-200's office style: who and
 * which design, no chat ids; the task's short id only on the last line).
 */
export function withdrawnOfficeAlert(input: { senderName?: string | null; title: string; fromStage: string; taskId: string;
  askedAt?: string; words?: string | null; now?: number }): string {
  const who = input.senderName?.trim() ? Array.from(input.senderName.trim()).slice(0, 60).join('') : 'The requester';
  const running = input.fromStage === 'designing'
    ? ' A design already being made may still finish; it will not go to review or to them.' : '';
  // ADR-230 addendum (L16): a request whose title names nothing is the one they sent then, with their words.
  const at = input.askedAt ? Date.parse(input.askedAt) : NaN;
  const quote = openingWords(input.words, false) || openingWords(input.title.replace(/^[^:]{1,40}:\s*/, ''), false);
  const name = shortTitle(input.title) !== 'your design' ? `"${shortTitle(input.title)}"`
    : `the request they sent ${Number.isFinite(at) ? sentWhen(at, input.now ?? Date.now(), 'en') : 'earlier'}${quote ? ` (${quote})` : ''}`;
  return [`${who} cancelled ${name} in the chat while it was ${STAGE_WORDS[input.fromStage] ?? input.fromStage}. ` +
    `It is closed, and nothing more will be made for it.${running}`, '', `Task ${input.taskId.slice(0, 8)}`].join('\n');
}

/**
 * ADR-239 follow-up (live 2026-10-01): the office cancelled a K-12 Pilot Study request and its redo, and
 * the requester got "The office has cancelled KAAE K-12 Pilot Study…" twice, word for word. A request is
 * named among this chat's requests of the same name by ADR-231's `distinctNames` ("… (asked for today at
 * 08:44)", or "(version 2)"); one with a name of its own is named as before.
 */
async function namedInChat(trx: Kysely<Database>, tenantId: string, chatId: string,
  self: { requestId: string; title: string; askedAt: string; words?: string }, lang: RequesterLang): Promise<string> {
  const key = shortTitle(self.title).toLowerCase();
  const rows = (await sql<{ request_id: string; created_at: Date | string; title: string | null; description: string | null }>`
    SELECT r.request_id::text, r.created_at, root.title, root.description FROM hawa.requests r
      LEFT JOIN hawa.tasks root ON root.tenant_id = r.tenant_id AND root.id = r.root_task_id
    WHERE r.tenant_id = ${tenantId}::uuid AND r.chat_id = ${chatId} AND r.owner = 'restate' AND r.request_id <> ${self.requestId}::uuid
    ORDER BY r.created_at DESC LIMIT 50`.execute(trx)).rows;
  const siblings = rows.filter((r) => shortTitle(r.title || 'your design').toLowerCase() === key)
    .map((r) => ({ requestId: r.request_id, title: r.title || 'your design', askedAt: new Date(r.created_at).toISOString(), words: r.description ?? undefined }));
  return distinctNames([self, ...siblings], lang, Date.now()).get(self.requestId) ?? requestLabel(self, lang);
}

/** The decision Core's intake recorded for a requester's Telegram update, as stored. */
async function recordedWithdraw(trx: Kysely<Database>, tenantId: string, updateId: number) {
  const row = (await sql<{ payload: Record<string, any>; payload_hash: string }>`SELECT payload, payload_hash
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_intent'
      AND source_event_id = ${String(updateId)} LIMIT 1`.execute(trx)).rows[0];
  const extra = row?.payload?.answer?.extra;
  if (!row || extra?.lifecycleAction !== 'withdraw' || typeof extra.requestId !== 'string') return null;
  const plan = row.payload.plan as { words?: unknown } | undefined;
  // ADR-255: one decision may withdraw several requests the requester named together ("cancel both of them").
  const requestIds = Array.isArray(extra.requestIds) && extra.requestIds.every((id: unknown) => typeof id === 'string')
    ? extra.requestIds as string[] : [extra.requestId as string];
  return { requestId: extra.requestId as string, requestIds, chatId: String(row.payload.chatId ?? ''), payloadHash: row.payload_hash,
    words: typeof plan?.words === 'string' ? plan.words : '',
    senderName: typeof row.payload.senderName === 'string' ? row.payload.senderName as string : null };
}

/** Closes the request (`cancelled`) and its current task, or keeps a late cancel for the office. */
export async function projectLifecycleWithdraw(db: Kysely<Database>, input: WithdrawProjection): Promise<WithdrawResult> {
  const { requestId, tenantId, taskId, eventId, actor, expectedRev, rev, key } = input;
  if (!Number.isInteger(expectedRev) || expectedRev < 1 || rev !== expectedRev + 1 ||
      key !== `${requestId}:${rev}:withdraw:${eventId}` ||
      (actor.kind === 'requester' ? eventId !== `chatinbox:withdraw:${actor.updateId}` : !/^desk:[0-9a-f-]{36}$/i.test(eventId))) {
    throw new LifecycleProjectionConflict('STALE_REVISION', 'A withdraw names one request revision and the event that asks for it');
  }
  if (actor.kind === 'office' && (!(OFFICE_WITHDRAW_ROLES as readonly string[]).includes(actor.role) || isServiceUserId(actor.userId))) {
    throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR', 'An office member must cancel a request');
  }
  const hash = createHash('sha256').update(canonical(input)).digest('hex');
  return withRlsContext(db, { tenantId, userId: CHANNEL_INGRESS_USER_ID, role: 'operator' }, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle:${requestId}`}, 0))`.execute(trx);
    const receipt = await trx.selectFrom('lifecycle_projections').selectAll()
      .where('tenant_id', '=', tenantId).where('request_id', '=', requestId).where('rev', '=', rev).executeTakeFirst();
    if (receipt) {
      if (receipt.idempotency_key !== key || receipt.payload_sha256 !== hash) {
        throw new LifecycleProjectionConflict('IDEMPOTENCY_CONFLICT', 'This request revision already records a different action');
      }
      return receipt.result as unknown as WithdrawResult;
    }
    const request = await trx.selectFrom('requests').selectAll()
      .where('tenant_id', '=', tenantId).where('request_id', '=', requestId).executeTakeFirst();
    if (!request || request.owner !== 'restate') throw new LifecycleProjectionConflict('WRONG_STAGE', 'No request-owned request has this id');
    // The requester's cancel must be the one Core's intake decided for that update, in that chat.
    const decided = actor.kind === 'requester' ? await recordedWithdraw(trx, tenantId, actor.updateId) : null;
    if (actor.kind === 'requester' && (!decided || !decided.requestIds.includes(requestId) || decided.chatId !== request.chat_id)) {
      throw new LifecycleProjectionConflict('UNAUTHORIZED_ACTOR', 'No recorded requester decision withdraws this request');
    }
    if (Number(request.rev) !== expectedRev) {
      throw new LifecycleProjectionConflict('STALE_REVISION', `Request is not at expected revision ${expectedRev}`);
    }
    if (request.current_task_id !== taskId) throw new LifecycleProjectionConflict('NOT_CURRENT_DRAFT', 'The named task is not the request\'s current task');
    const root = await trx.selectFrom('tasks').select(['title', 'description'])
      .where('tenant_id', '=', tenantId).where('id', '=', request.root_task_id).executeTakeFirst();
    const title = root?.title || 'your design';
    const lang = requesterLang(decided?.words || root?.description || title);
    const chatId = request.chat_id;
    // ADR-230 addendum (L16): named by when it was sent and the requester's words when its title names nothing.
    const askedAt = new Date(request.created_at).toISOString();
    const label = chatId ? await namedInChat(trx, tenantId, chatId, { requestId, title, askedAt, words: root?.description ?? undefined }, lang)
      : requestLabel({ title, askedAt, words: root?.description }, lang);
    if (!withdrawable(request.stage)) {
      if (actor.kind === 'office') {
        throw new LifecycleProjectionConflict('NOT_WITHDRAWABLE', `The request is ${request.stage}; only a request nothing has been approved for can be cancelled`);
      }
      if (!tooLateToWithdraw(request.stage)) {
        // Already closed (an earlier cancel, a rejection): a cancelled one is said again; nothing is changed.
        return { withdrawn: false, requestId, taskId, rev: expectedRev, stage: request.stage, actor: 'requester',
          ...(chatId && request.stage === 'cancelled'
            ? { requesterNotice: { chatId, text: say(WITHDRAW_MESSAGES.withdrawn, lang, { title: label }) } } : {}),
          officeAlerts: [] };
      }
      // Too late: the cancel is kept for the office as any late cancel is (Deliver waits until it is read).
      const office = officeChatsFor(chatId);
      const stage = request.stage as LateChangeStage;
      const late: LateRequesterChange = { requestId, taskId, requestRev: expectedRev, requestStage: stage,
        text: decided!.words || '(cancel)', kind: 'cancel', title: shortTitle(title),
        answer: withdrawTooLateText(request.stage, title, lang, office.length > 0, label) };
      // ADR-255: a decision that withdraws several requests keeps each late cancel under its own key.
      const keptAs = decided!.requestIds.length > 1 ? `${actor.updateId}:${requestId}` : actor.updateId;
      const kept = chatId
        ? (await recordRoutingRefusal(trx, tenantId, keptAs, { code: 'LATE_REQUESTER_CHANGE', chatId,
          payloadHash: decided!.payloadHash, late })).late ?? late : late;
      const alert = chatId ? lateChangeOfficeAlert(kept, chatId, office[0]) : null;
      return { withdrawn: false, requestId, taskId, rev: expectedRev, stage: request.stage, actor: 'requester',
        ...(chatId && kept.answer ? { requesterNotice: { chatId, text: kept.answer } } : {}),
        officeAlerts: alert ? office.map((member) => ({ chatId: member, text: alert.text })) : [] };
    }
    const task = await trx.selectFrom('tasks').select(['state', 'version', 'request_id'])
      .where('tenant_id', '=', tenantId).where('id', '=', taskId).forUpdate().executeTakeFirst();
    if (!task || task.request_id !== requestId) throw new LifecycleProjectionConflict('TASK_ALREADY_OWNED', 'The task is not owned by this request');
    if (TERMINAL_TASK_STATES.has(task.state)) throw new LifecycleProjectionConflict('WRONG_STAGE', `The task is already ${task.state}`);
    await new TaskRepository(trx).transitionState({ taskId, tenantId, expectedVersion: Number(task.version),
      fromState: task.state, toState: 'cancelled',
      actorType: actor.kind === 'office' ? 'user' : 'adapter',
      actorId: actor.kind === 'office' ? actor.userId : `telegram:${chatId}`,
      reason: (actor.kind === 'office' ? `The office cancelled the request: ${input.reason}`
        : 'The requester cancelled the request in the chat').slice(0, 1000),
      data: { withdrawn: { requestId, eventId, actor: actor.kind, fromStage: request.stage, rev } } }, trx);
    const changed = await trx.updateTable('requests').set({ stage: 'cancelled', rev, updated_at: new Date() })
      .where('tenant_id', '=', tenantId).where('request_id', '=', requestId).where('rev', '=', expectedRev)
      .returning('request_id').executeTakeFirst();
    if (!changed) throw new LifecycleProjectionConflict('STALE_REVISION', 'Request changed during the withdraw');
    const named = { title: label };
    const officeText = actor.kind === 'requester'
      ? withdrawnOfficeAlert({ senderName: decided?.senderName, title, fromStage: request.stage, taskId, askedAt, words: root?.description }) : null;
    const result: WithdrawResult = { withdrawn: true, requestId, taskId, rev, stage: 'cancelled', fromStage: request.stage,
      actor: actor.kind,
      ...(chatId ? { requesterNotice: { chatId, text: say(actor.kind === 'requester'
        ? WITHDRAW_MESSAGES.withdrawn : WITHDRAW_MESSAGES.withdrawnByOffice, lang, named) } } : {}),
      officeAlerts: officeText ? officeChatsFor(chatId).map((member) => ({ chatId: member, text: officeText })) : [] };
    await trx.insertInto('lifecycle_projections').values({
      tenant_id: tenantId, request_id: requestId, rev, idempotency_key: key,
      payload_sha256: hash, result: result as unknown as Record<string, unknown>,
    }).execute();
    return result;
  });
}

/**
 * ADR-230: a design run that finishes after its request was withdrawn. Nothing goes to review and
 * nobody is told; the run's report is kept against the closed task, once per run (the spend it made is
 * on record elsewhere; this says the design exists and why nobody saw it).
 */
export async function recordWithdrawnOutcome(db: Kysely<Database>, input: {
  requestId: string; tenantId: string; taskId: string; runId: string; eventId: string; report: Record<string, unknown>;
}): Promise<{ recorded: true; requestId: string; taskId: string; runId: string }> {
  return withRlsContext(db, { tenantId: input.tenantId, userId: CHANNEL_INGRESS_USER_ID, role: 'operator' }, async (trx) => {
    const request = await trx.selectFrom('requests').select(['stage', 'owner'])
      .where('tenant_id', '=', input.tenantId).where('request_id', '=', input.requestId).executeTakeFirst();
    const task = await trx.selectFrom('tasks').select(['request_id', 'state'])
      .where('tenant_id', '=', input.tenantId).where('id', '=', input.taskId).executeTakeFirst();
    if (!request || request.owner !== 'restate' || request.stage !== 'cancelled' || task?.request_id !== input.requestId) {
      throw new LifecycleProjectionConflict('WRONG_STAGE', 'Only a withdrawn request\'s own run is recorded this way');
    }
    const payload = JSON.stringify({ requestId: input.requestId, taskId: input.taskId, runId: input.runId, report: input.report });
    await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
      VALUES (${input.tenantId}::uuid, 'lifecycle_withdrawn_outcome', ${`${input.requestId}:${input.eventId}`},
        'lifecycle_withdrawn_design_finished', ${payload}::jsonb, ${createHash('sha256').update(payload).digest('hex')}, true)
      ON CONFLICT DO NOTHING`.execute(trx);
    return { recorded: true, requestId: input.requestId, taskId: input.taskId, runId: input.runId };
  });
}

/** The action key of the office's Cancel when the Desk's own key is not a UUID: one per key. */
export function withdrawActionId(key: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) return key.toLowerCase();
  const h = createHash('sha256').update(`hawa:office-withdraw:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** What the Desk's Cancel answers: the task-control receipt it already reads. */
export interface WithdrawControlReceipt {
  commandId: string; taskId: string; workflowId: string; acceptedAt: string; fromStatus: string;
  status: 'CANCELLED'; version: number; replayed: boolean; requestId: string; rev: number;
}

export type WithdrawRequestResult =
  | { ok: true; status: 200 | 202; body: WithdrawControlReceipt }
  | { ok: false; status: 403 | 404 | 409 | 503; code: string; message: string };

const TOO_LATE_WORDS: Record<string, string> = {
  approved: 'This design was already approved, so it can no longer be cancelled. Reject or deliver it from its review instead.',
  delivering: 'This design is being sent to the requester, so it can no longer be cancelled.',
  delivered: 'This design was already sent to the requester, so it can no longer be cancelled.',
};

/**
 * The Desk's Cancel for a request-owned task (POST /tasks/:id/cancel): the request is withdrawn by its
 * own object, through the signed office gateway, with the office member as its actor. Null when the
 * task belongs to no request (the task controls handle it as before). A second press with the same key
 * answers with the first.
 */
export async function requestLifecycleWithdraw(db: Kysely<Database>, input: {
  tenantId: string; taskId: string; actor: { userId: string; role: string }; reason: string; key: string;
  expectedVersion: number; fetcher?: typeof fetch;
}): Promise<WithdrawRequestResult | null> {
  const { tenantId, taskId, actor } = input;
  const state = await withRlsContext(db, { tenantId, userId: CHANNEL_INGRESS_USER_ID, role: 'operator' }, async (trx) => {
    const task = await trx.selectFrom('tasks').select(['request_id', 'state', 'version'])
      .where('tenant_id', '=', tenantId).where('id', '=', taskId).executeTakeFirst();
    if (!task?.request_id) return { task };
    const request = await trx.selectFrom('requests').select(['request_id', 'owner', 'stage', 'rev', 'current_task_id'])
      .where('tenant_id', '=', tenantId).where('request_id', '=', task.request_id).executeTakeFirst();
    return { task, request };
  });
  if (!state.task) return { ok: false, status: 404, code: 'TASK_NOT_FOUND', message: 'Task not found' };
  if (!state.task.request_id || !state.request || state.request.owner !== 'restate') return null;
  if (!(OFFICE_WITHDRAW_ROLES as readonly string[]).includes(actor.role) || isServiceUserId(actor.userId)) {
    return { ok: false, status: 403, code: 'TASK_CONTROL_FORBIDDEN', message: 'An office operator or designer must cancel a request' };
  }
  const requestId = state.request.request_id as string;
  const actionId = withdrawActionId(input.key);
  const done = await withRlsContext(db, { tenantId, userId: CHANNEL_INGRESS_USER_ID, role: 'operator' }, (trx) =>
    trx.selectFrom('lifecycle_projections').select(['rev', 'result']).where('tenant_id', '=', tenantId)
      .where('request_id', '=', requestId).where('idempotency_key', 'like', `${requestId}:%:withdraw:desk:${actionId}`)
      .executeTakeFirst());
  const receiptOf = (rev: number, fromStatus: string, version: number, replayed: boolean, acceptedAt: string): WithdrawControlReceipt =>
    ({ commandId: actionId, taskId, workflowId: requestId, acceptedAt, fromStatus, status: 'CANCELLED', version, replayed, requestId, rev });
  if (done) {
    return { ok: true, status: 200, body: receiptOf(Number(done.rev), toApiTaskStatus(state.task.state),
      Number(state.task.version), true, new Date().toISOString()) };
  }
  if (Number(state.task.version) !== input.expectedVersion) {
    return { ok: false, status: 409, code: 'TASK_VERSION_CONFLICT', message: 'The task changed. Refresh it before applying this control.' };
  }
  if (state.request.current_task_id !== taskId) {
    return { ok: false, status: 409, code: 'NOT_CURRENT_TASK', message: 'This is an earlier round of the request; cancel its current task' };
  }
  if (!withdrawable(state.request.stage)) {
    return { ok: false, status: 409, code: 'REQUEST_NOT_WITHDRAWABLE',
      message: TOO_LATE_WORDS[state.request.stage] ?? `This request is already ${state.request.stage}.` };
  }
  const expectedRev = Number(state.request.rev);
  const ingress = (process.env.RESTATE_INGRESS_URL || '').trim().replace(/\/+$/, '');
  const secret = workerSigningSecretOf() || '';
  if (!ingress || !secret) {
    return { ok: false, status: 503, code: 'LIFECYCLE_GATEWAY_UNAVAILABLE', message: 'The office gateway is not configured; retry this action later' };
  }
  const reason = input.reason.trim().slice(0, 2000);
  const event = { v: 1 as const, kind: 'withdraw' as const, eventId: `desk:${actionId}`, requestId, taskId, actionId,
    expectedRev, actor: { userId: actor.userId, role: actor.role }, reason };
  const signature = signLifecycleOfficeEvent(secret, event);
  try {
    const response = await (input.fetcher ?? fetch)(`${ingress}/OfficeDecisionGateway/withdraw`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, event, signature }), signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text().catch(() => '');
    let result: Record<string, unknown> | null = null;
    try { result = JSON.parse(text) as Record<string, unknown>; } catch { result = null; }
    if (response.ok && result?.accepted === true && result.requestId === requestId && result.taskId === taskId &&
        result.stage === 'cancelled' && result.rev === expectedRev + 1) {
      return { ok: true, status: 202, body: receiptOf(expectedRev + 1, toApiTaskStatus(state.task.state),
        Number(state.task.version) + 1, false, new Date().toISOString()) };
    }
    if (response.ok && result?.accepted === false) {
      return { ok: false, status: 409, code: String(result.code || 'REQUEST_NOT_WITHDRAWABLE'),
        message: 'The request moved on before it could be cancelled; refresh the task' };
    }
    if (response.status === 400 || response.status === 409) {
      return { ok: false, status: 409, code: 'WITHDRAW_CONFLICT', message: 'The request refused this cancel; refresh the task' };
    }
    log.warn(`[core:withdraw] gateway HTTP ${response.status} for request ${requestId}`);
  } catch (error) {
    log.warn(`[core:withdraw] gateway did not answer for request ${requestId}:`, error);
  }
  return { ok: false, status: 503, code: 'WITHDRAW_UNCERTAIN',
    message: 'The cancel may have been recorded. Send the same action again; it will not be applied twice' };
}

/**
 * ADR-230 addendum (L12): the answer to a cancel with nothing it could withdraw. It says so, and names the
 * designs the chat has that were already delivered, so the requester knows why.
 */
export function nothingToCancelText(shown: Array<{ title: string; stage: string; createdAt?: string; words?: string }>, lang: RequesterLang): string {
  return [say(WITHDRAW_MESSAGES.nothingToCancel, lang),
    ...shown.filter((r) => r.stage === 'delivered').map((r) => say(WITHDRAW_MESSAGES.deliveredNotCancellable, lang,
      { title: requestLabel({ title: r.title, askedAt: r.createdAt, words: r.words }, lang) }))]
    .join('\n');
}
