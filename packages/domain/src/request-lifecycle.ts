/**
 * The request lifecycle's state machine (architecture programme Phase 2, slice 2.3; PHASE2_DESIGN.md
 * section 2.3, ADR-034). Pure: no Restate SDK, no HTTP, no storage. The RequestLifecycle object in
 * the worker is a thin shell around it:
 *
 *   s = upgrade(await ctx.get('lc'));  now = await ctx.date.now()
 *   p = plan(s, event, now)                       ignored → answer p.reply, change nothing
 *   r = await ctx.run(`project:${rev}`, () => core.project(requestId, projectionRequestFor(s, event, p)))
 *   { next, effects, reply } = apply(s, event, r, now)
 *   ctx.set('lc', next); emit the effects in order (sends, delayed self-sends, workflow starts)
 *
 * `plan` decides whether an event moves the request and what Postgres must record for it (the
 * projection ops, applied by Core in one transaction with an expected revision). `apply` folds what
 * Core answered into the next state and the effects. Both run the same rules (`decide`), so what was
 * projected and what the state says cannot drift apart.
 *
 * No handler waits for a person: waiting is a stage, and each event is a handler that runs for
 * seconds. A delayed event (a reminder, the expiry) carries the stage epoch it was scheduled in, and
 * one from an older stage does nothing.
 */
import { createHash } from 'node:crypto';
import {
  designRunId,
  deliveryWorkflowId,
  isLifecycleStage,
  type CanvaStatusReport,
  type DraftIntake,
  type LifecycleEvent,
  type LifecycleMessage,
  type LifecycleRound,
  type LifecycleStage,
  type LifecycleStateV1,
  type LifecycleView,
  type OfficeDecisionRefusal,
  type OfficeDecisionResult,
  type OpenEvent,
  type ProjectionOp,
  type ProjectionOpResult,
  type ProjectionRequest,
  type ProjectionResponse,
  type RemindEvent,
  type ExpireEvent,
  type RetryProjectionEvent,
} from '@hawa/contracts';
import { nextOfficeMoment } from './office-hours.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A draft or question is asked about again one day after it was sent, and once more after five. */
export const REMINDER_DAY_1_AFTER_MS = DAY_MS;
export const REMINDER_DAY_5_AFTER_MS = 5 * DAY_MS;
/** A draft or question nobody answered for two weeks expires (the office is told). */
export const EXPIRE_AFTER_MS = 14 * DAY_MS;
/** How long after Core could not take a design outcome it is offered again. */
export const RETRY_PROJECTION_AFTER_MS = 10 * 60_000;

const MAX_ROUNDS = 12;
const MAX_SEEN = 64;
const MAX_REMINDERS = 32;
const MAX_DECISIONS = 16;
const MAX_QUESTION_CHARS = 1000;
const MAX_OPTION_CHARS = 200;
const MAX_OPTIONS = 3;

// ---------------------------------------------------------------------------------------------
// Ids

/** A stable UUID-shaped id from a key: the same v5-style hash as the parked update's aggregate id. */
export function uuidFromKey(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The request the `index`-th brief of one Telegram update opens. */
export function requestIdFor(chatId: string | number, updateId: number, index = 0): string {
  return uuidFromKey(`req:${chatId}:${updateId}:${index}`);
}

/** The child request a size action of a request opens. */
export function sizeRequestId(requestId: string, action: string): string {
  return uuidFromKey(`req:size:${requestId}:${action}`);
}

// ---------------------------------------------------------------------------------------------
// Stage rules Core uses too: it writes hawa.requests.stage from the same functions.

/** A new request is designed at once only when it may be drafted automatically and has a client. */
export function stageAfterOpen(autoGenerate: boolean, clientId: string | null | undefined): LifecycleStage {
  return autoGenerate && clientId ? 'designing' : 'manual';
}

/** A change or an answer is designed at once unless the daily cap declined the automatic draft. */
export function stageAfterRound(autoGenerate: boolean): LifecycleStage {
  return autoGenerate ? 'designing' : 'manual';
}

/** A design outcome: a draft is reviewed, a question waits for the answer, anything else is the office's. */
export function stageAfterOutcome(outcome: { hasDraft: boolean; question?: unknown }): LifecycleStage {
  if (outcome.hasDraft) return 'in_review';
  if (outcome.question) return 'awaiting_answer';
  return 'manual';
}

// ---------------------------------------------------------------------------------------------
// State versions

/**
 * The stored state was written by a newer build (a `v` or a stage this build does not know). The
 * shell must not set state; it throws a retryable error so the invocation waits for that build to be
 * live again (PHASE2_DESIGN.md section 4, rule 4).
 */
export class LifecycleStateTooNewError extends Error {
  readonly code = 'LIFECYCLE_STATE_TOO_NEW';
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleStateTooNewError';
  }
}

/**
 * An event with no payload version, or one that is not a whole number: not a newer build's event
 * but a malformed one. Retrying cannot help; the shell answers it with a terminal error.
 */
export class LifecycleEventUnreadableError extends Error {
  readonly code = 'LIFECYCLE_EVENT_UNREADABLE';
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleEventUnreadableError';
  }
}

/** The stored state is not a lifecycle state at all. Retrying cannot help; the invocation pauses for a person. */
export class LifecycleStateUnreadableError extends Error {
  readonly code = 'LIFECYCLE_STATE_UNREADABLE';
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleStateUnreadableError';
  }
}

/** Core could not take a projection this event needs, and the event has no way to wait for it. */
export class LifecycleProjectionUnavailableError extends Error {
  readonly code = 'LIFECYCLE_PROJECTION_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleProjectionUnavailableError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Reads the stored state, whatever version of this code wrote it, as the current version. Only v1
 * exists; fields added to v1 later are optional, and one missing here gets its empty value. Nothing
 * stored → undefined (a request not opened yet).
 */
export function upgrade(raw: unknown): LifecycleStateV1 | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new LifecycleStateUnreadableError(`lifecycle state is a ${Array.isArray(raw) ? 'list' : typeof raw}, not an object`);
  if (raw.v !== 1) {
    if (typeof raw.v === 'number' && Number.isInteger(raw.v) && raw.v > 1) throw new LifecycleStateTooNewError(`lifecycle state v${raw.v} was written by a newer build; this one reads v1`);
    throw new LifecycleStateUnreadableError(`lifecycle state has no version this build knows (v=${JSON.stringify(raw.v)})`);
  }
  if (!isLifecycleStage(raw.stage)) throw new LifecycleStateTooNewError(`lifecycle stage ${JSON.stringify(raw.stage)} is not one this build knows`);
  if (typeof raw.requestId !== 'string' || typeof raw.tenantId !== 'string' || !isRecord(raw.origin) || !Number.isInteger(raw.rev)) {
    throw new LifecycleStateUnreadableError('lifecycle state lacks its request id, tenant, origin or revision');
  }
  const s = raw as unknown as LifecycleStateV1;
  return {
    ...s,
    clientId: typeof s.clientId === 'string' ? s.clientId : null,
    chatId: typeof s.chatId === 'string' ? s.chatId : null,
    owner: 'restate',
    stageEpoch: Number.isInteger(s.stageEpoch) ? s.stageEpoch : 0,
    stageSince: Number.isFinite(s.stageSince) ? s.stageSince : 0,
    round: Number.isInteger(s.round) ? s.round : 0,
    rounds: Array.isArray(s.rounds) ? s.rounds.map((r) => ({ ...r, runAttempt: Number.isInteger(r.runAttempt) ? r.runAttempt : 0 })) : [],
    requester: isRecord(s.requester) ? s.requester : {},
    reminders: strings(s.reminders),
    sizes: isRecord(s.sizes) ? (s.sizes as Record<string, string>) : {},
    seen: strings(s.seen),
    ...(isRecord(s.outcomeDeferred) ? { outcomeDeferred: deferredOf(s.outcomeDeferred) } : {}),
  };
}

/** A deferred outcome as stored; a first projection that is not whole is dropped (the retry projects afresh). */
function deferredOf(d: NonNullable<LifecycleStateV1['outcomeDeferred']>): NonNullable<LifecycleStateV1['outcomeDeferred']> {
  const p = d.projection as Partial<NonNullable<typeof d.projection>> | undefined;
  const whole = isRecord(p) && typeof p.key === 'string' && Number.isSafeInteger(p.expectedRev) && p.rev === (p.expectedRev as number) + 1 && (p.stage === undefined || isLifecycleStage(p.stage));
  const { projection: _dropped, ...rest } = d;
  void _dropped;
  return whole ? d : rest;
}

// ---------------------------------------------------------------------------------------------
// Effects: what the shell does after `ctx.set`, in order. Only one-way sends and workflow starts: a
// Virtual Object never awaits another object or a workflow (it would stay pinned to its deployment).

export type LifecycleEffect =
  | { type: 'send'; message: LifecycleMessage }
  | { type: 'answerCallback'; chatId: string | null; callbackQueryId: string }
  | { type: 'startDesignRun'; requestId: string; tenantId: string; runId: string; taskId: string; round: number; attempt: number }
  | { type: 'startDelivery'; requestId: string; tenantId: string; deliveryId: string; approvalId: string; taskId: string; revisionId: string; run: number; chatId: string | null }
  | { type: 'schedule'; handler: 'remind'; delayMs: number; idempotencyKey: string; event: RemindEvent }
  | { type: 'schedule'; handler: 'expire'; delayMs: number; idempotencyKey: string; event: ExpireEvent }
  | { type: 'schedule'; handler: 'retryProjection'; delayMs: number; idempotencyKey: string; event: RetryProjectionEvent }
  | { type: 'openChild'; requestId: string; event: OpenEvent }
  | { type: 'cancelRun'; runId: string; invocationId?: string }
  /** Core did not take a design outcome: the worker tells the requester and the office itself. */
  | { type: 'outcomeUnrecorded'; requestId: string; taskId: string; runId: string; status: string; chatId: string | null };

export type Plan =
  | { ignored: true; reason: string; reply?: unknown }
  | { ignored: false; ops: ProjectionOp[]; stage?: LifecycleStage };

/** Core's answer to the projection, or 'unavailable' when the step gave up waiting for Core. */
export type ProjectionOutcome = ProjectionResponse | { status: 'unavailable' };

export type Applied =
  | { ignored: true; reason: string; reply?: unknown }
  | { ignored: false; next: LifecycleStateV1; effects: LifecycleEffect[]; reply?: unknown };

export interface ApplyOptions {
  /**
   * Multiplies the delays of reminders and the expiry (HAWA_LIFECYCLE_REMINDER_SCALE, read once per
   * invocation in a journaled step). The chaos suite uses 0.0001: a day becomes under nine seconds.
   */
  reminderScale?: number;
}

// ---------------------------------------------------------------------------------------------
// Rules

interface Fold {
  prev: LifecycleStateV1 | undefined;
  next: LifecycleStateV1;
  results: ProjectionOpResult[];
  effects: LifecycleEffect[];
  now: number;
  scale: number;
  reply?: unknown;
}

interface Rule {
  ops: ProjectionOp[];
  /** Known before projecting; otherwise Core and the fold derive it from the results. */
  stage?: LifecycleStage;
  fold: (f: Fold) => void;
  /**
   * For an event that can wait for Core (a design outcome): what to do when the step gave up.
   * `sent` is the projection the step was sending, which Core may have committed unanswered.
   */
  unavailable?: (f: Fold, sent: DeferredProjection) => void;
}

type Decision = { ignored: true; reason: string; reply?: unknown } | ({ ignored: false } & Rule);
type DeferredProjection = NonNullable<NonNullable<LifecycleStateV1['outcomeDeferred']>['projection']>;

const ignore = (reason: string, reply?: unknown): Decision => ({ ignored: true, reason, ...(reply !== undefined ? { reply } : {}) });
const refuse = (code: OfficeDecisionRefusal, message: string): Decision => ignore(`office decision refused: ${code}`, { accepted: false, code, message } satisfies OfficeDecisionResult);

function currentRound(s: LifecycleStateV1): LifecycleRound | undefined {
  return s.rounds.find((r) => r.round === s.round);
}

export function currentTaskId(s: LifecycleStateV1): string | null {
  return currentRound(s)?.taskId ?? null;
}

/** "A change is pending": the current round is a change or an answer whose design has not finished. */
export function openChangeRound(s: LifecycleStateV1): boolean {
  const cur = currentRound(s);
  return Boolean(cur && (cur.kind === 'change' || cur.kind === 'answer') && !cur.outcome);
}

/** A design run was started for the current round and has not reported. */
export function liveRun(s: LifecycleStateV1): boolean {
  const cur = currentRound(s);
  return Boolean(cur?.runId && !cur.outcome);
}

function resultOf<K extends ProjectionOpResult['op']>(results: ProjectionOpResult[], op: K): Extract<ProjectionOpResult, { op: K }> {
  const found = results.find((r) => r.op === op);
  if (!found) throw new LifecycleProjectionUnavailableError(`Core's projection answer has no result for ${op}`);
  return found as Extract<ProjectionOpResult, { op: K }>;
}

function sendAll(f: Fold): void {
  for (const r of f.results) {
    const messages = (r as { messages?: LifecycleMessage[] }).messages;
    if (Array.isArray(messages)) for (const message of messages) f.effects.push({ type: 'send', message });
  }
}

function moveTo(f: Fold, stage: LifecycleStage): void {
  if (f.next.stage === stage) return;
  f.next.stage = stage;
  f.next.stageEpoch += 1;
  f.next.stageSince = f.now;
}

const scaled = (f: Fold, atMs: number): number => Math.max(0, Math.round((atMs - f.now) * f.scale));

function scheduleReminder(f: Fold, kind: 'draft' | 'question', day: 1 | 5, taskId: string, since: number): void {
  const key = `remind:${f.next.requestId}:${kind}:${day}:${taskId}`;
  const at = nextOfficeMoment(since + (day === 1 ? REMINDER_DAY_1_AFTER_MS : REMINDER_DAY_5_AFTER_MS));
  f.effects.push({
    type: 'schedule', handler: 'remind', delayMs: scaled(f, at), idempotencyKey: key,
    event: { v: 1, eventId: key, kind, day, stageEpoch: f.next.stageEpoch, taskId },
  });
}

function scheduleExpiry(f: Fold, since: number): void {
  const key = `expire:${f.next.requestId}:${f.next.stageEpoch}`;
  f.effects.push({
    type: 'schedule', handler: 'expire', delayMs: scaled(f, since + EXPIRE_AFTER_MS), idempotencyKey: key,
    event: { v: 1, eventId: key, stageEpoch: f.next.stageEpoch },
  });
}

function startRun(f: Fold, round: LifecycleRound): void {
  if (!round.runId) return;
  f.effects.push({
    type: 'startDesignRun', requestId: f.next.requestId, tenantId: f.next.tenantId,
    runId: round.runId, taskId: round.taskId, round: round.round, attempt: round.runAttempt,
  });
}

function compactRounds(rounds: LifecycleRound[]): LifecycleRound[] {
  return [...rounds].sort((a, b) => a.round - b.round).slice(-MAX_ROUNDS);
}

/** A change or an answer: the next round, designed at once unless the daily cap declined it. */
function beginRound(f: Fold, kind: 'change' | 'answer', created: { taskId: string; autoGenerate: boolean }): void {
  const stage = stageAfterRound(created.autoGenerate);
  const round: LifecycleRound = {
    round: f.next.round + 1, taskId: created.taskId, kind, runAttempt: 0,
    ...(stage === 'designing' ? { runId: designRunId(created.taskId, 0) } : {}),
  };
  f.next.round = round.round;
  f.next.rounds = compactRounds([...f.next.rounds, round]);
  f.next.question = undefined;
  moveTo(f, stage);
  startRun(f, round);
}

function answerCallback(f: Fold, callbackQueryId: string | undefined): void {
  if (callbackQueryId) f.effects.push({ type: 'answerCallback', chatId: f.next.chatId, callbackQueryId });
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Folds a design outcome Core recorded (designFinished, or retryProjection after Core was down). */
function foldOutcome(f: Fold, report: CanvaStatusReport): void {
  const res = resultOf(f.results, 'recordOutcome');
  const cur = f.next.rounds.find((r) => r.round === f.next.round);
  const designId = res.designId ?? report.designId;
  if (cur) {
    cur.outcome = {
      status: report.status,
      ...(report.code ? { code: report.code } : {}),
      ...(designId ? { designId } : {}),
      ...(res.revisionId ? { revisionId: res.revisionId } : {}),
    };
  }
  const taskId = cur?.taskId ?? '';
  f.next.outcomeDeferred = undefined;
  if (res.hasDraft) {
    f.next.draft = { taskId, ...(res.revisionId ? { revisionId: res.revisionId } : {}), ...(designId ? { designId } : {}) };
    f.next.question = undefined;
  } else if (res.question) {
    f.next.question = {
      id: res.question.id,
      taskId,
      question: cut(res.question.question, MAX_QUESTION_CHARS),
      options: res.question.options.slice(0, MAX_OPTIONS).map((o) => cut(o, MAX_OPTION_CHARS)),
    };
  }
  moveTo(f, stageAfterOutcome(res));
  sendAll(f);
}

function deferOutcome(f: Fold, runId: string, report: CanvaStatusReport, taskId: string, sent: DeferredProjection): void {
  const prev = f.prev?.outcomeDeferred?.runId === runId ? f.prev.outcomeDeferred : undefined;
  const attempts = (prev ? prev.attempts ?? 1 : 0) + 1;
  // The report is kept whole, not cut to size: the retry must send the very ops Core may hold under
  // the first key, or Core refuses it (KEY_REUSED) and the outcome is lost. It is kept only while
  // Core is down, and the designFinished event carried the same bytes into the journal.
  f.next.outcomeDeferred = { runId, since: prev?.since ?? f.now, report, attempts, projection: sent };
  // The requester and the office hear once that the outcome is not recorded yet; later attempts only retry.
  if (attempts === 1) f.effects.push({ type: 'outcomeUnrecorded', requestId: f.next.requestId, taskId, runId, status: report.status, chatId: f.next.chatId });
  const key = `retry:${f.next.requestId}:${runId}:${attempts}`;
  f.effects.push({
    type: 'schedule', handler: 'retryProjection', delayMs: RETRY_PROJECTION_AFTER_MS, idempotencyKey: key,
    event: { v: 1, eventId: key, runId },
  });
}

function outcomeRule(s: LifecycleStateV1, runId: string, report: CanvaStatusReport): Decision {
  const taskId = currentTaskId(s) ?? '';
  return {
    ignored: false,
    ops: [{ op: 'recordOutcome', taskId, runId, report }],
    fold: (f) => foldOutcome(f, report),
    unavailable: (f, sent) => deferOutcome(f, runId, report, taskId, sent),
  };
}

function cancelRule(s: LifecycleStateV1, reason: string): Decision {
  if (s.stage === 'cancelled' || s.stage === 'delivered') return ignore(`a ${s.stage} request cannot be cancelled`);
  const taskId = currentTaskId(s);
  if (!taskId) return ignore('the request has no task to cancel');
  const cur = currentRound(s);
  const running = s.stage === 'designing' && liveRun(s);
  return {
    ignored: false,
    stage: 'cancelled',
    ops: [{ op: 'transition', taskId, toState: 'cancelled', ifIllegal: 'keep', reason }],
    fold: (f) => {
      moveTo(f, 'cancelled');
      if (running && cur?.runId) f.effects.push({ type: 'cancelRun', runId: cur.runId, ...(cur.runInvocationId ? { invocationId: cur.runInvocationId } : {}) });
      sendAll(f);
    },
  };
}

function officeDecision(s: LifecycleStateV1, ev: Extract<LifecycleEvent, { type: 'officeDecision' }>): Decision {
  if (ev.expectedRev !== undefined && ev.expectedRev !== s.rev) {
    return refuse('STALE_REVISION', `The request is at revision ${s.rev}, not ${ev.expectedRev}: reload it`);
  }
  const wrongStage = () => refuse('WRONG_STAGE', `A request that is ${s.stage} cannot take "${ev.kind}"`);
  const draft = s.draft;
  switch (ev.kind) {
    case 'approve': {
      if (s.stage !== 'in_review' && s.stage !== 'expired') return wrongStage();
      if (!draft || ev.taskId !== draft.taskId || !ev.revisionId || ev.revisionId !== draft.revisionId) return refuse('NOT_CURRENT_DRAFT', 'Only the current draft can be approved');
      if (openChangeRound(s)) return refuse('CHANGE_PENDING', 'A change to this design is being made');
      const revisionId = ev.revisionId;
      return {
        ignored: false,
        stage: 'approved',
        ops: [{ op: 'recordApproval', taskId: ev.taskId, revisionId, actionId: ev.actionId, actor: ev.actor, ...(ev.approval ? { approval: ev.approval } : {}) }],
        fold: (f) => {
          const res = resultOf(f.results, 'recordApproval');
          f.next.approval = { approvalId: res.approvalId, taskId: ev.taskId, revisionId, actionId: ev.actionId, at: f.now };
          moveTo(f, 'approved');
        },
      };
    }
    case 'revise': {
      if (s.stage !== 'in_review') return wrongStage();
      if (!draft || ev.taskId !== draft.taskId) return refuse('NOT_CURRENT_DRAFT', 'Only the current draft can be sent back for a revision');
      return {
        ignored: false,
        stage: 'manual',
        ops: [{ op: 'transition', taskId: ev.taskId, toState: 'revision_requested', reason: cut(ev.comment?.trim() || 'The office asked for a revision', 1000) }],
        fold: (f) => {
          moveTo(f, 'manual');
          sendAll(f);
        },
      };
    }
    case 'draftCaptured': {
      if (s.stage !== 'manual') return wrongStage();
      if (!s.rounds.some((r) => r.taskId === ev.taskId)) return refuse('NOT_CURRENT_DRAFT', 'That task is not a round of this request');
      return {
        ignored: false,
        stage: 'in_review',
        ops: [{ op: 'bridgeCapturedRevision', taskId: ev.taskId, ...(ev.revisionId ? { revisionId: ev.revisionId } : {}) }],
        fold: (f) => {
          const res = resultOf(f.results, 'bridgeCapturedRevision');
          f.next.draft = { taskId: ev.taskId, revisionId: res.revisionId, ...(res.designId ? { designId: res.designId } : {}) };
          moveTo(f, 'in_review');
          sendAll(f);
        },
      };
    }
    case 'redrive': {
      if (s.stage !== 'manual') return wrongStage();
      const cur = currentRound(s);
      if (!cur || ev.taskId !== cur.taskId) return refuse('NOT_CURRENT_DRAFT', 'Only the current round can be designed again');
      if (liveRun(s)) return refuse('WRONG_STAGE', 'A design run of this round has not reported yet');
      const attempt = cur.runId ? cur.runAttempt + 1 : cur.runAttempt;
      return {
        ignored: false,
        stage: 'designing',
        ops: [{ op: 'prepareRedrive', taskId: cur.taskId, attempt }],
        fold: (f) => {
          const round = f.next.rounds.find((r) => r.round === f.next.round)!;
          round.runAttempt = attempt;
          round.runId = designRunId(round.taskId, attempt);
          delete round.outcome;
          delete round.runInvocationId;
          moveTo(f, 'designing');
          startRun(f, round);
        },
      };
    }
    case 'deliver': {
      if (s.stage !== 'approved') return wrongStage();
      const approval = s.approval;
      if (!approval || ev.taskId !== approval.taskId || (ev.approvalId && ev.approvalId !== approval.approvalId)) return refuse('NOT_CURRENT_DRAFT', 'Only the approved draft can be delivered');
      if (openChangeRound(s)) return refuse('CHANGE_PENDING', 'A change to this design is being made');
      // A failed delivery of this approval was run 1: the next one needs a new workflow key.
      const run = s.delivery?.approvalId === approval.approvalId ? (s.delivery.run ?? 1) + 1 : 1;
      return {
        ignored: false,
        stage: 'delivering',
        ops: [{ op: 'transition', taskId: approval.taskId, toState: 'publishing', reason: 'The office asked for delivery' }],
        fold: (f) => {
          const deliveryId = deliveryWorkflowId(f.next.requestId, approval.approvalId, run);
          f.next.delivery = { deliveryId, approvalId: approval.approvalId, startedAt: f.now, run };
          moveTo(f, 'delivering');
          f.effects.push({
            type: 'startDelivery', requestId: f.next.requestId, tenantId: f.next.tenantId, deliveryId, approvalId: approval.approvalId,
            taskId: approval.taskId, revisionId: approval.revisionId, run, chatId: f.next.chatId,
          });
        },
      };
    }
    case 'retryArchive': {
      if (s.stage !== 'delivered' || !s.delivery || !s.approval) return wrongStage();
      if (s.delivery.sheetsConfirmed) return refuse('WRONG_STAGE', 'The delivery is archived already');
      const approval = s.approval;
      const run = (s.delivery.run ?? 1) + 1;
      return {
        ignored: false,
        stage: 'delivering',
        ops: [{ op: 'transition', taskId: approval.taskId, reason: 'The office asked to archive the delivery again' }],
        fold: (f) => {
          const deliveryId = deliveryWorkflowId(f.next.requestId, approval.approvalId, run);
          f.next.delivery = { deliveryId, approvalId: approval.approvalId, startedAt: f.now, run };
          moveTo(f, 'delivering');
          f.effects.push({
            type: 'startDelivery', requestId: f.next.requestId, tenantId: f.next.tenantId, deliveryId, approvalId: approval.approvalId,
            taskId: approval.taskId, revisionId: approval.revisionId, run, chatId: f.next.chatId,
          });
        },
      };
    }
    case 'cancel':
      return cancelRule(s, cut(ev.comment?.trim() || 'The office cancelled the request', 1000));
    case 'reject':
    default:
      // Rejection stays with Core's decisions route until the office decisions slice (2.4).
      return wrongStage();
  }
}

function decide(s: LifecycleStateV1 | undefined, ev: LifecycleEvent): Decision {
  const version = (ev as { v?: unknown }).v;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new LifecycleEventUnreadableError(`event ${ev.type} has no payload version this build can read (v=${JSON.stringify(version) ?? 'undefined'})`);
  }
  if (version !== 1) throw new LifecycleStateTooNewError(`event ${ev.type} v${String(version)} was written by a newer build`);

  if (s && s.seen.includes(ev.eventId)) {
    // Handled before: Restate's own idempotency usually answers first; this covers the rest.
    if (ev.type === 'officeDecision') {
      const stored = s.decisions?.find((d) => d.eventId === ev.eventId)?.reply;
      return ignore('duplicate event', stored ?? ({ accepted: true, rev: s.rev, stage: s.stage } satisfies OfficeDecisionResult));
    }
    if (ev.type === 'open') return ignore('duplicate event', { accepted: true, taskId: s.rounds[0]?.taskId });
    return ignore('duplicate event');
  }

  if (ev.type === 'open') {
    if (s) return ignore('the request is open already', { accepted: s.requestId === ev.requestId, taskId: s.rounds[0]?.taskId });
    const op: ProjectionOp = {
      op: 'createRequest', requestId: ev.requestId, chatId: ev.chatId, origin: ev.origin, draft: ev.draft,
      ...(ev.parentRequestId ? { parentRequestId: ev.parentRequestId } : {}),
      ...(ev.parentTaskId ? { parentTaskId: ev.parentTaskId } : {}),
    };
    return {
      ignored: false,
      ops: [op],
      fold: (f) => {
        const res = resultOf(f.results, 'createRequest');
        const stage = stageAfterOpen(res.autoGenerate, ev.draft.clientId);
        const round: LifecycleRound = { round: 0, taskId: res.taskId, kind: 'design', runAttempt: 0, ...(stage === 'designing' ? { runId: designRunId(res.taskId, 0) } : {}) };
        f.next = {
          v: 1, requestId: ev.requestId, tenantId: ev.tenantId, clientId: ev.draft.clientId, chatId: ev.chatId, owner: 'restate',
          origin: ev.origin, rev: 0, stage, stageEpoch: 0, stageSince: f.now, round: 0, rounds: [round],
          requester: {}, reminders: [], sizes: {}, seen: [],
        };
        sendAll(f);
        startRun(f, round);
        f.reply = { accepted: true, taskId: res.taskId };
      },
    };
  }

  if (!s) {
    return ev.type === 'officeDecision' ? refuse('WRONG_STAGE', 'This request was never opened') : ignore('the request was never opened');
  }

  switch (ev.type) {
    case 'designFinished': {
      const cur = currentRound(s);
      if (s.stage !== 'designing' || !cur || cur.runId !== ev.runId || cur.outcome) return ignore(`stale run ${ev.runId}`);
      return outcomeRule(s, ev.runId, ev.report);
    }

    case 'retryProjection': {
      const deferred = s.outcomeDeferred;
      const cur = currentRound(s);
      if (s.stage !== 'designing' || !deferred || deferred.runId !== ev.runId || !deferred.report || cur?.runId !== ev.runId) return ignore('nothing deferred for this run');
      return outcomeRule(s, ev.runId, deferred.report);
    }

    case 'answer': {
      const q = s.question;
      if (s.stage !== 'awaiting_answer' || !q) return ignore('no question is waiting');
      if (ev.questionId !== q.id) return ignore(`stale question ${ev.questionId}`);
      const chosen = ev.answer.option && q.options[ev.answer.option - 1];
      const directive = (ev.answer.text?.trim() || chosen || '').trim();
      return {
        ignored: false,
        ops: [
          {
            op: 'createRound', kind: 'answer', round: s.round + 1, parentTaskId: q.taskId, directive, answers: q.taskId, question: q.question, answer: ev.answer,
            ...(ev.answer.photoFileIds?.length ? { photoFileIds: ev.answer.photoFileIds } : {}),
          },
          { op: 'closeQuestion', taskId: q.taskId, questionId: q.id },
        ],
        fold: (f) => {
          beginRound(f, 'answer', resultOf(f.results, 'createRound'));
          sendAll(f);
          answerCallback(f, ev.callbackQueryId);
        },
      };
    }

    case 'requesterDecision': {
      const draft = s.draft;
      const isCurrent = s.stage === 'in_review' && Boolean(draft) && ev.taskId === draft!.taskId && !openChangeRound(s);
      if (ev.kind === 'size') {
        if (!['in_review', 'approved', 'delivered'].includes(s.stage)) return ignore(`a size cannot be asked for while the request is ${s.stage}`);
        const action = ev.sizeAction;
        if (!action) return ignore('a size decision names no size');
        if (s.sizes[action]) return ignore(`size ${action} was asked for already`);
        return {
          ignored: false,
          ops: [{ op: 'recordRequesterAction', taskId: ev.taskId, action: 'size', current: true, sizeAction: action, actorId: ev.actorId, ...(ev.callbackQueryId ? { callbackQueryId: ev.callbackQueryId } : {}) }],
          fold: (f) => {
            const res = resultOf(f.results, 'recordRequesterAction');
            sendAll(f);
            answerCallback(f, ev.callbackQueryId);
            // Core answers without a draft when the size cannot be made (not the new pipeline's chat).
            if (!res.childDraft) return;
            const childId = sizeRequestId(f.next.requestId, action);
            f.next.sizes = { ...f.next.sizes, [action]: childId };
            f.effects.push({
              type: 'openChild', requestId: childId,
              event: {
                v: 1, eventId: `open:${childId}`, requestId: childId, tenantId: f.next.tenantId, chatId: f.next.chatId,
                origin: { kind: 'size', parentRequestId: f.next.requestId, action }, draft: res.childDraft as DraftIntake,
                parentRequestId: f.next.requestId, parentTaskId: ev.taskId,
              },
            });
          },
        };
      }
      if (ev.kind === 'dsg') {
        if (s.stage !== 'in_review' && s.stage !== 'expired') return ignore(`a designer cannot be asked for while the request is ${s.stage}`);
        return {
          ignored: false,
          stage: 'manual',
          ops: [{ op: 'recordRequesterAction', taskId: ev.taskId, action: 'dsg', current: Boolean(draft && ev.taskId === draft.taskId), actorId: ev.actorId, ...(ev.callbackQueryId ? { callbackQueryId: ev.callbackQueryId } : {}) }],
          fold: (f) => {
            f.next.requester = { ...f.next.requester, designerAsked: { at: f.now } };
            moveTo(f, 'manual');
            sendAll(f);
            answerCallback(f, ev.callbackQueryId);
          },
        };
      }
      // ok, chg, change: on the current draft they act; on another one Core only says why not.
      if (!isCurrent) {
        if (!draft || s.stage === 'cancelled' || s.stage === 'delivered') return ignore(`no draft to act on while the request is ${s.stage}`);
        return {
          ignored: false,
          ops: [{ op: 'recordRequesterAction', taskId: ev.taskId, action: ev.kind, current: false, actorId: ev.actorId, ...(ev.callbackQueryId ? { callbackQueryId: ev.callbackQueryId } : {}) }],
          fold: (f) => {
            sendAll(f);
            answerCallback(f, ev.callbackQueryId);
          },
        };
      }
      if (ev.kind === 'change') {
        return {
          ignored: false,
          ops: [{
            op: 'createRound', kind: 'change', round: s.round + 1, parentTaskId: draft!.taskId, directive: (ev.directive ?? '').trim(),
            ...(ev.photoFileIds?.length ? { photoFileIds: ev.photoFileIds } : {}),
          }],
          fold: (f) => {
            beginRound(f, 'change', resultOf(f.results, 'createRound'));
            sendAll(f);
          },
        };
      }
      return {
        ignored: false,
        ops: [{ op: 'recordRequesterAction', taskId: ev.taskId, action: ev.kind, current: true, actorId: ev.actorId, ...(ev.callbackQueryId ? { callbackQueryId: ev.callbackQueryId } : {}) }],
        fold: (f) => {
          if (ev.kind === 'ok') f.next.requester = { ...f.next.requester, signedOff: { taskId: ev.taskId, at: f.now } };
          sendAll(f);
          answerCallback(f, ev.callbackQueryId);
        },
      };
    }

    case 'messageSent': {
      if (ev.what === 'draft') {
        const draft = s.draft;
        if (s.stage !== 'in_review' || !draft || ev.taskId !== draft.taskId) return ignore('the draft sent is not the current one');
        if (draft.sentAt) return ignore('the draft was recorded as sent already');
        return {
          ignored: false,
          ops: [{ op: 'recordDraftSent', taskId: ev.taskId, key: ev.key, at: ev.at, ...(ev.messageId ? { messageId: ev.messageId } : {}) }],
          fold: (f) => {
            f.next.draft = { ...f.next.draft!, sentAt: ev.at };
            scheduleReminder(f, 'draft', 1, ev.taskId, ev.at);
            scheduleExpiry(f, ev.at);
          },
        };
      }
      if (ev.what === 'question') {
        const q = s.question;
        if (s.stage !== 'awaiting_answer' || !q || ev.taskId !== q.taskId) return ignore('the question sent is not the one waiting');
        if (q.askedAt) return ignore('the question was recorded as sent already');
        return {
          ignored: false,
          ops: [{ op: 'recordQuestionSent', taskId: ev.taskId, questionId: q.id, key: ev.key, at: ev.at, ...(ev.messageId ? { messageId: ev.messageId } : {}) }],
          fold: (f) => {
            f.next.question = { ...f.next.question!, askedAt: ev.at };
            scheduleReminder(f, 'question', 1, ev.taskId, ev.at);
            scheduleExpiry(f, ev.at);
          },
        };
      }
      return ignore(`nothing is recorded when a ${ev.what} is sent`);
    }

    case 'remind': {
      if (s.stage !== 'in_review' && s.stage !== 'awaiting_answer') return ignore(`no reminder while the request is ${s.stage}`);
      if (ev.stageEpoch !== s.stageEpoch) return ignore(`stale reminder (epoch ${ev.stageEpoch}, now ${s.stageEpoch})`);
      const mark = `${ev.kind}:${ev.day}:${ev.taskId}`;
      if (s.reminders.includes(mark)) return ignore(`reminder ${mark} was sent already`);
      const since = ev.kind === 'draft'
        ? (s.draft?.taskId === ev.taskId ? s.draft.sentAt : undefined)
        : (s.question?.taskId === ev.taskId ? s.question.askedAt : undefined);
      if (since === undefined) return ignore(`the ${ev.kind} reminded about is not the current one`);
      return {
        ignored: false,
        ops: [{ op: 'composeReminder', taskId: ev.taskId, kind: ev.kind, day: ev.day, since }],
        fold: (f) => {
          const res = resultOf(f.results, 'composeReminder');
          f.next.reminders = [...f.next.reminders, mark].slice(-MAX_REMINDERS);
          if (!res.skip) sendAll(f);
          if (ev.day === 1) scheduleReminder(f, ev.kind, 5, ev.taskId, since);
        },
      };
    }

    case 'expire': {
      if (s.stage !== 'in_review' && s.stage !== 'awaiting_answer') return ignore(`nothing expires while the request is ${s.stage}`);
      if (ev.stageEpoch !== s.stageEpoch) return ignore(`stale expiry (epoch ${ev.stageEpoch}, now ${s.stageEpoch})`);
      const taskId = s.stage === 'in_review' ? s.draft?.taskId : s.question?.taskId;
      if (!taskId) return ignore('nothing is waiting to expire');
      return {
        ignored: false,
        stage: 'expired',
        ops: [{ op: 'transition', taskId, reason: 'Nobody answered for 14 days; the request expired' }],
        fold: (f) => {
          moveTo(f, 'expired');
          sendAll(f);
        },
      };
    }

    case 'officeDecision':
      return officeDecision(s, ev);

    case 'deliveryFinished': {
      if (s.stage !== 'delivering' || !s.delivery || ev.deliveryId !== s.delivery.deliveryId) return ignore(`delivery ${ev.deliveryId} is not the one running`);
      const approval = s.approval;
      const stage: LifecycleStage = ev.outcome === 'failed' ? 'approved' : 'delivered';
      return {
        ignored: false,
        stage,
        ops: [{
          op: 'recordDelivery', taskId: approval?.taskId ?? currentTaskId(s) ?? '', deliveryId: ev.deliveryId, approvalId: s.delivery.approvalId,
          outcome: ev.outcome, sheetsConfirmed: ev.sheetsConfirmed, uncertain: ev.uncertain.slice(0, 50),
        }],
        fold: (f) => {
          f.next.delivery = { ...f.next.delivery!, outcome: ev.outcome, sheetsConfirmed: ev.sheetsConfirmed };
          moveTo(f, stage);
          sendAll(f);
        },
      };
    }

    case 'cancel':
      return cancelRule(s, cut(ev.reason?.trim() || (ev.by === 'requester' ? 'The requester cancelled the request' : 'The office cancelled the request'), 1000));

    default:
      return ignore(`unknown event ${(ev as { type?: string }).type}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The public surface

/** Whether an event moves the request, and what Postgres must record for it. */
export function plan(s: LifecycleStateV1 | undefined, ev: LifecycleEvent, now: number): Plan {
  void now;
  const d = decide(s, ev);
  if (d.ignored) return d;
  return { ignored: false, ops: d.ops, ...(d.stage ? { stage: d.stage } : {}) };
}

/** The body of Core's projection call for a plan (POST /v1/internal/lifecycle/:requestId/project). */
export function projectionRequestFor(s: LifecycleStateV1 | undefined, ev: LifecycleEvent, p: Extract<Plan, { ignored: false }>): ProjectionRequest {
  const requestId = s?.requestId ?? (ev.type === 'open' ? ev.requestId : '');
  const tenantId = s?.tenantId ?? (ev.type === 'open' ? ev.tenantId : '');
  const sent = ev.type === 'retryProjection' && s?.outcomeDeferred?.runId === ev.runId ? s.outcomeDeferred.projection : undefined;
  if (sent) {
    // The outcome offered again is the projection first sent, key, revision and ops alike: if Core
    // committed it and died before answering, it answers 'replayed' with what it recorded.
    return { v: 1, expectedRev: sent.expectedRev, rev: sent.rev, key: sent.key, tenantId, ...(sent.stage ? { stage: sent.stage } : {}), ops: p.ops };
  }
  const expectedRev = s?.rev ?? 0;
  // A retry stands in for the designFinished it offers again, and is named as that event (2.9).
  const eventType = ev.type === 'retryProjection' ? 'designFinished' : ev.type;
  return { v: 1, expectedRev, rev: expectedRev + 1, key: `${requestId}:${expectedRev + 1}:${eventType}`, tenantId, ...(p.stage ? { stage: p.stage } : {}), ops: p.ops };
}

/**
 * The next state, the effects and the reply, from what Core answered. `projected` is Core's answer,
 * or `{status:'unavailable'}` when the projection step gave up: only a design outcome can wait for
 * Core (it is offered again later); any other event throws, so the invocation is retried.
 */
export function apply(
  s: LifecycleStateV1 | undefined,
  ev: LifecycleEvent,
  projected: ProjectionOutcome,
  now: number,
  options: ApplyOptions = {}
): Applied {
  const d = decide(s, ev);
  if (d.ignored) return d;
  const scale = options.reminderScale !== undefined && options.reminderScale > 0 ? options.reminderScale : 1;
  const next: LifecycleStateV1 = s ? structuredClone(s) : ({} as LifecycleStateV1);
  const f: Fold = { prev: s, next, results: [], effects: [], now, scale };
  if (projected.status === 'unavailable') {
    if (!d.unavailable || !s) throw new LifecycleProjectionUnavailableError(`Core did not take the projection of ${ev.type}; it must be retried`);
    const sent = projectionRequestFor(s, ev, { ignored: false, ops: d.ops, ...(d.stage ? { stage: d.stage } : {}) });
    d.unavailable(f, { key: sent.key, expectedRev: sent.expectedRev, rev: sent.rev, ...(sent.stage ? { stage: sent.stage } : {}) });
  } else {
    f.results = projected.results;
    d.fold(f);
    // The revision Postgres now holds: the next projection expects it. A replayed answer of an
    // older projection never takes the state back.
    f.next.rev = Math.max(f.next.rev ?? 0, projected.rev);
    // Another event was projected at the revision a deferred outcome was sent at: Postgres was still
    // there, so Core never recorded the outcome, and its retry must project it afresh.
    const held = f.next.outcomeDeferred?.projection;
    if (s && held && s.rev === held.expectedRev && ev.type !== 'designFinished' && ev.type !== 'retryProjection') {
      const { projection: _stale, ...rest } = f.next.outcomeDeferred!;
      void _stale;
      f.next.outcomeDeferred = rest;
    }
  }
  f.next.seen = [...(f.next.seen ?? []), ev.eventId].slice(-MAX_SEEN);
  let reply = f.reply;
  if (ev.type === 'officeDecision') {
    const accepted: OfficeDecisionResult = { accepted: true, rev: f.next.rev, stage: f.next.stage };
    f.next.decisions = [...(f.next.decisions ?? []), { eventId: ev.eventId, reply: accepted }].slice(-MAX_DECISIONS);
    reply = accepted;
  }
  return { ignored: false, next: f.next, effects: f.effects, ...(reply !== undefined ? { reply } : {}) };
}

/** What the shared `get` handler answers. */
export function viewOf(s: LifecycleStateV1): LifecycleView {
  return {
    requestId: s.requestId,
    stage: s.stage,
    rev: s.rev,
    round: s.round,
    currentTaskId: currentTaskId(s),
    ...(s.question ? { question: s.question } : {}),
    ...(s.draft ? { draft: s.draft } : {}),
    ...(s.approval ? { approval: s.approval } : {}),
    ...(s.delivery ? { delivery: s.delivery } : {}),
  };
}

/** The invocation id Restate gave a started design run, kept so a cancellation can reach it. */
export function recordRunInvocation(s: LifecycleStateV1, runId: string, invocationId: string): LifecycleStateV1 {
  return { ...s, rounds: s.rounds.map((r) => (r.runId === runId ? { ...r, runInvocationId: invocationId } : r)) };
}

/**
 * After Core answered AHEAD (Postgres holds projections this state does not know, as after a
 * Restate restore): take Postgres's revision, so the next projection is accepted. The shell alerts
 * the office; what the lost projections did is in Postgres, and send marks stop any resend.
 */
export function reconcileAhead(s: LifecycleStateV1, pgRev: number): LifecycleStateV1 {
  return pgRev > s.rev ? { ...s, rev: pgRev } : s;
}
