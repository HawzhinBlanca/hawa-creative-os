/**
 * RequestLifecycle's versioned request owner (ADR-034, Phase 2.3): open, terminal design outcome,
 * office review, a delivery claim, and its final outcome.
 * ChatInbox cutover remains controlled by the request lifecycle flag.
 * Once bound, the service name stays in every worker build for blue/green drain compatibility.
 */
import { createHash } from 'node:crypto';
import * as restate from '@restatedev/restate-sdk';
import type { DeliveryInput, DeliveryOutcome, OutboundMessage } from '@hawa/contracts';
import { parseCompleteRevisionRequest, parseOfficeApprovalProof, type OfficeApprovalProof, type StructuredRevisionRequest } from '@hawa/domain';
import { withInvocationLogContext } from '../logging.js';
import { coreInternalFromEnv, DeliveryApi, type CoreInternal } from './delivery.js';
import { TelegramSenderApi } from './telegram-sender.js';
import { DesignRunApi, type DesignRunInput } from './design-run.js';
import { chatInbox } from './chat-inbox.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 30_000, maxRetryDuration: 30 * 60_000 };
// A DesignRun has already ended when it sends this event. Keep its sole outcome pending through a
// Core outage; a bounded step here could abandon the only report of paid work.
const OUTCOME_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 30_000 };

export interface OpenManualEvent {
  v: 1;
  eventId: string;
  requestId: string;
  tenantId: string;
  chatId: string;
  draft: {
    platform: 'telegram';
    sourceEventId: string;
    sourceChannelId: string;
    rawText: string;
    title: string;
    designInstructions: string;
    exactCopy: unknown[];
    clientId: string | null;
    autoGenerate: false;
  };
}

export interface ManualLifecycleState {
  v: 1;
  requestId: string;
  tenantId: string;
  chatId: string;
  owner: 'restate';
  stage: 'manual';
  rev: 1;
  taskId: string;
  openEventId: string;
  openSha256: string;
}

export interface OpenManualResult { accepted: true; taskId: string; stage: 'manual'; rev: 1 }

export interface OpenAutomaticEvent extends Omit<OpenManualEvent, 'draft'> {
  draft: Omit<OpenManualEvent['draft'], 'autoGenerate'> & {
    autoGenerate: true;
    variant?: { width: number; height: number };
    designStudio?: boolean;
    studioOptions?: DesignRunInput['studioOptions'];
  };
}

export interface AutomaticLifecycleState extends Omit<ManualLifecycleState, 'stage' | 'rev'> {
  stage: 'designing' | 'awaiting_answer' | 'in_review' | 'manual' | 'approved' | 'delivering' | 'delivered';
  rev: number;
  runId: string;
  /** Current design round (0 = original, 1+ = revision rounds). */
  round?: number;
  designInput: DesignRunInput;
  outcome?: { eventId: string; sha256: string; status: string; revisionId?: string;
    message?: { text: string; parseMode: 'HTML' }; officeAlert?: { chatId: string; text: string } };
  question?: { id: string; text: string; options: string[]; taskId: string; rev: number };
  officeRevision?: { eventId: string; sha256: string; actionId: string; revisionId: string; approvalId: string;
    kind?: 'revise' | 'approve' };
  /** Filled when the requester submits a revision directive after the office marks "revise". */
  revisionRound?: { eventId: string; sha256: string; round: number; newTaskId: string; runId: string };
  delivery?: { startEventId: string; startSha256: string; actionId: string; input: DeliveryInput;
    finishEventId?: string; finishSha256?: string; finishResult?: DeliveryFinishedReply };
}

export interface OfficeRevisionEvent {
  v: 1; eventId: string; requestId: string; taskId: string; revisionId: string;
  actionId: string;
  /** expectedRev ≥ 2: first decision is at 2; subsequent revision rounds use 2+2k. */
  expectedRev: number; kind: 'revise' | 'approve';
  actor: { userId: string; role: string }; reason: string;
  /** Optional only for signed decisions already in flight before the structured-feedback rollout. */
  revisionRequest?: StructuredRevisionRequest;
  approvalProof?: OfficeApprovalProof;
  deskRequestFingerprint?: string;
}

export type OfficeRevisionReply =
  | { accepted: true; requestId: string; taskId: string; revisionId: string; actionId: string;
      approvalId: string; stage: 'manual' | 'approved'; rev: number }
  | { accepted: false; code: 'WRONG_STAGE' | 'NOT_CURRENT_DRAFT' };

export interface OfficeDeliveryStartEvent {
  v: 1; kind: 'deliver'; eventId: string; requestId: string; taskId: string;
  revisionId: string; approvalId: string; actionId: string; expectedRev: number;
  actor: { userId: string; role: string }; reason: string;
}

export type OfficeDeliveryStartReply =
  | { accepted: true; requestId: string; taskId: string; approvalId: string; actionId: string;
      deliveryId: string; stage: 'delivering' | 'delivered' | 'approved'; rev: number }
  | { accepted: false; code: 'WRONG_STAGE' | 'NOT_CURRENT_DRAFT' };

/** The requester submits their revision directive after the office marks the draft "revise". */
export interface RequesterDecisionEvent {
  v: 1;
  /** Unique event ID stable across retries. */
  eventId: string;
  requestId: string;
  /** Revision round ≥ 1 (incremented by the worker each time the office marks "revise"). */
  round: number;
  directive: string;
  /** The prior task id that is in revision_requested state. */
  priorTaskId: string;
  /** Formatted Telegram chat message text (the requester’s raw reply to the office note). */
  rawText?: string;
  /** Present only when answering the current verified Studio clarification question. */
  questionId?: string;
}

export type RequesterDecisionReply =
  | { accepted: true; requestId: string; newTaskId: string; runId: string; round: number; rev: number; stage: 'designing' }
  | { accepted: false; code: 'WRONG_STAGE' };

export interface DeliveryFinishedEvent {
  v: 1; eventId: string; requestId: string; taskId: string; approvalId: string;
  deliveryId: string; run: number; expectedRev: number; outcome: DeliveryOutcome;
}

export interface DeliveryFinishedReply {
  accepted: true; requestId: string; taskId: string; approvalId: string;
  deliveryId: string; stage: 'approved' | 'delivering' | 'delivered'; taskState: string; rev: number;
}

/** Delayed self-message to remind the requester if they haven't submitted a directive. */
export interface ReminderTickEvent {
  v: 1;
  requestId: string;
  /** Rev at the time the reminder was scheduled; stale if the request has advanced. */
  expectedRev: number;
  kind?: 'revision' | 'question';
  questionId?: string;
  day?: 1 | 5;
}

const REVISION_REMINDER_DELAY_MS = 24 * 60 * 60_000;
const QUESTION_SECOND_REMINDER_DELAY_MS = 5 * 24 * 60 * 60_000;

export interface AutomaticOpenContext {
  key: string;
  get(name: string): Promise<ManualLifecycleState | AutomaticLifecycleState | null>;
  run<T>(name: string, action: () => Promise<T>): Promise<T>;
  set(name: string, value: ManualLifecycleState | AutomaticLifecycleState): void;
  send(message: OutboundMessage): void;
  startDesign(input: DesignRunInput): void;
  startDelivery?(input: DeliveryInput): void;
  /** Fire-and-forget: upgrade a Telegram chat to lifecycle mode (exclusive, idempotent). */
  setChatMode?(chatId: string, requestId: string): void;
  /** Schedule a delayed self-call to send a requester reminder if still waiting. */
  scheduleReminder?(requestId: string, rev: number, delayMs: number): void;
  scheduleQuestionReminder?(requestId: string, rev: number, questionId: string,
    day: 1 | 5, delayMs: number): void;
}

export interface DesignFinishedEvent {
  v: 1; eventId: string; requestId: string; runId: string;
  /** 0 for the initial design; ≥ 1 for revision rounds. */
  round: number; taskId: string;
  report: { status: string; designId?: string; code?: string; runId?: string;
    parity?: string; parityError?: string; detail?: string; notifyRequester?: boolean };
}

export interface OpenContext {
  key: string;
  get(name: string): Promise<ManualLifecycleState | null>;
  run<T>(name: string, action: () => Promise<T>): Promise<T>;
  set(name: string, value: ManualLifecycleState): void;
  send(message: OutboundMessage): void;
  /** Fire-and-forget: upgrade a Telegram chat to lifecycle mode (exclusive, idempotent). */
  setChatMode?(chatId: string, requestId: string): void;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

const hashOf = (event: unknown) => createHash('sha256').update(canonical(event)).digest('hex');
const invalid = (reason: string) => new restate.TerminalError(`LIFECYCLE_OPEN_REFUSED: ${reason}`, { errorCode: 409 });

function sendAcknowledgement(ctx: Pick<OpenContext, 'send'>, state: ManualLifecycleState): void {
  ctx.send({
    v: 1, key: `${state.requestId}:1:ack`, chatId: state.chatId, kind: 'text',
    text: 'Request received. An art director will review it.', class: 'critical',
    tenantId: state.tenantId, taskId: state.taskId,
  });
}

/** A replay after `set` still emits the same fenced message key, so a crash cannot lose the ack. */
export async function openManualRequest(ctx: OpenContext, core: CoreInternal, event: OpenManualEvent): Promise<OpenManualResult> {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      event.eventId !== `open:${event.requestId}` || event.tenantId !== DEFAULT_TENANT_ID ||
      !/^-?\d{1,20}$/.test(event.chatId) || event.draft?.platform !== 'telegram' ||
      event.draft?.sourceEventId !== `lc-${event.requestId}-r0` ||
      event.draft?.sourceChannelId !== event.chatId || event.draft?.autoGenerate !== false) {
    throw invalid('this handler accepts only a versioned manual round-zero request under its own key');
  }
  const fingerprint = hashOf(event);
  const prior = await ctx.get('lc');
  if (prior) {
    if (prior.requestId !== event.requestId || prior.openEventId !== event.eventId || prior.openSha256 !== fingerprint) {
      throw invalid('this request was opened with different content');
    }
    sendAcknowledgement(ctx, prior);
    return { accepted: true, taskId: prior.taskId, stage: 'manual', rev: 1 };
  }
  const projected = await ctx.run('project:1', () => core.post<{ v: 1; taskId: string; stage: string; rev: number; autoGenerate: boolean }>(
    `/internal/lifecycle/${encodeURIComponent(event.requestId)}/project`,
    { v: 1, expectedRev: 0, rev: 1, key: `${event.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: event.draft }] },
  ));
  if (projected?.v !== 1 || !UUID.test(projected.taskId) || projected.stage !== 'manual' || projected.rev !== 1 || projected.autoGenerate !== false) {
    throw new Error('Core did not return a manual request projection; do not acknowledge it');
  }
  const state: ManualLifecycleState = {
    v: 1, requestId: event.requestId, tenantId: event.tenantId, chatId: event.chatId,
    owner: 'restate', stage: 'manual', rev: 1, taskId: projected.taskId,
    openEventId: event.eventId, openSha256: fingerprint,
  };
  ctx.set('lc', state);
  ctx.setChatMode?.(event.chatId, event.requestId);
  sendAcknowledgement(ctx, state);
  return { accepted: true, taskId: state.taskId, stage: 'manual', rev: 1 };
}

function sendAutomaticAcknowledgement(ctx: AutomaticOpenContext, state: AutomaticLifecycleState): void {
  ctx.send({ v: 1, key: `${state.requestId}:1:ack`, chatId: state.chatId, kind: 'text',
    text: 'Request received. I am preparing a draft for art director review.', class: 'critical',
    tenantId: state.tenantId, taskId: state.taskId });
}

/** The persisted Core projection, not the untrusted open event, supplies the run's execution policy. */
export async function openAutomaticRequest(ctx: AutomaticOpenContext, core: CoreInternal, event: OpenAutomaticEvent) {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      event.eventId !== `open:${event.requestId}` || event.tenantId !== DEFAULT_TENANT_ID ||
      !/^-?\d{1,20}$/.test(event.chatId) || event.draft?.platform !== 'telegram' ||
      event.draft?.sourceEventId !== `lc-${event.requestId}-r0` ||
      event.draft?.sourceChannelId !== event.chatId || event.draft?.autoGenerate !== true ||
      !event.draft.clientId || !UUID.test(event.draft.clientId)) {
    throw invalid('automatic round-zero request has an invalid owner, source or client');
  }
  const fingerprint = hashOf(event);
  const prior = await ctx.get('lc');
  if (prior) {
    if (prior.requestId !== event.requestId || prior.openEventId !== event.eventId ||
        prior.openSha256 !== fingerprint) {
      throw invalid('this request was opened with different content');
    }
    if (!('runId' in prior)) {
      sendAcknowledgement(ctx, prior);
      return { accepted: true as const, taskId: prior.taskId, stage: 'manual' as const, rev: 1 as const };
    }
    sendAutomaticAcknowledgement(ctx, prior);
    if (prior.rev === 1) ctx.startDesign(prior.designInput);
    return { accepted: true as const, taskId: prior.taskId, stage: prior.stage, rev: prior.rev };
  }
  const projected = await ctx.run('project:1', () => core.post<{
    v: 1; taskId: string; stage: string; rev: number; autoGenerate: boolean;
    design?: { clientId: string; rawText: string; sourcePlatform: string;
      variant?: { width: number; height: number }; designStudio: boolean; studioOptions?: DesignRunInput['studioOptions'] };
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/project`,
    { v: 1, expectedRev: 0, rev: 1, key: `${event.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: event.draft }] }));
  if (projected?.v !== 1 || !UUID.test(projected.taskId) || projected.rev !== 1) {
    throw new Error('Core did not return an automatic design projection; do not start the run');
  }
  if (projected.stage === 'manual' && projected.autoGenerate === false) {
    const manual: ManualLifecycleState = {
      v: 1, requestId: event.requestId, tenantId: event.tenantId, chatId: event.chatId,
      owner: 'restate', stage: 'manual', rev: 1, taskId: projected.taskId,
      openEventId: event.eventId, openSha256: fingerprint,
    };
    ctx.set('lc', manual);
    ctx.setChatMode?.(event.chatId, event.requestId);
    sendAcknowledgement(ctx, manual);
    return { accepted: true as const, taskId: manual.taskId, stage: 'manual' as const, rev: 1 as const };
  }
  if (projected.stage !== 'designing' || projected.autoGenerate !== true ||
      !projected.design || projected.design.clientId !== event.draft.clientId) {
    throw new Error('Core returned an inconsistent automatic design projection; do not start the run');
  }
  const runId = `dr-${projected.taskId}`;
  const designInput: DesignRunInput = {
    v: 1, lifecycle: { requestId: event.requestId, round: 0, runId },
    taskId: projected.taskId, tenantId: event.tenantId, clientId: projected.design.clientId,
    rawText: projected.design.rawText, sourcePlatform: projected.design.sourcePlatform,
    idempotencyKey: `lifecycle:${event.requestId}:${projected.taskId}`, canvaAutoGenerate: true,
    ...(projected.design.variant ? { canvaVariant: projected.design.variant } : {}),
    designStudio: projected.design.designStudio,
    ...(projected.design.studioOptions ? { studioOptions: projected.design.studioOptions } : {}),
  };
  const state: AutomaticLifecycleState = {
    v: 1, requestId: event.requestId, tenantId: event.tenantId, chatId: event.chatId,
    owner: 'restate', stage: 'designing', rev: 1, taskId: projected.taskId,
    openEventId: event.eventId, openSha256: fingerprint, runId, designInput,
  };
  ctx.set('lc', state);
  ctx.setChatMode?.(event.chatId, event.requestId);
  sendAutomaticAcknowledgement(ctx, state);
  ctx.startDesign(designInput);
  return { accepted: true as const, taskId: state.taskId, stage: state.stage, rev: state.rev };
}

export async function recordDesignFinished(ctx: AutomaticOpenContext, core: CoreInternal, event: DesignFinishedEvent) {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      !UUID.test(event.taskId) || event.runId !== `dr-${event.taskId}` ||
      event.eventId !== `dr-finished:${event.runId}` ||
      typeof event.round !== 'number' || !Number.isInteger(event.round) || event.round < 0 ||
      !event.report || typeof event.report.status !== 'string') throw invalid('invalid design finish identity');
  const prior = await ctx.get('lc');
  if (!prior || !('runId' in prior) || prior.requestId !== event.requestId ||
      prior.taskId !== event.taskId || prior.runId !== event.runId) return { ignored: true as const };
  const fingerprint = hashOf(event);
  const nextRev = prior.rev + 1;
  // Replay detection: if the outcome for this event was already stored (crash after set, before send),
  // replay the fenced messages rather than projecting again. Works across all revision rounds.
  if (prior.outcome?.eventId === event.eventId) {
    if (prior.outcome.sha256 !== fingerprint) {
      throw invalid('the design outcome was already recorded with different content');
    }
    sendDesignOutcome(ctx, prior);
    if (prior.stage === 'awaiting_answer' && prior.question) {
      ctx.scheduleQuestionReminder?.(prior.requestId, prior.rev, prior.question.id, 1,
        REVISION_REMINDER_DELAY_MS);
      ctx.scheduleQuestionReminder?.(prior.requestId, prior.rev, prior.question.id, 5,
        QUESTION_SECOND_REMINDER_DELAY_MS);
    }
    return { ignored: false as const, stage: prior.stage, rev: prior.rev };
  }

  if (prior.stage !== 'designing') throw invalid('request is not designing');
  const projected = await ctx.run(`project:${nextRev}`, () => core.post<{
    v: 1; requestId: string; taskId: string; rev: number; stage: 'in_review' | 'manual' | 'awaiting_answer';
    status: string; revisionId?: string; message?: { text: string; parseMode: 'HTML' };
    question?: { id: string; text: string; options: string[] };
    officeAlert?: { chatId: string; text: string };
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/design-outcome`, {
    v: 1, expectedRev: prior.rev, rev: nextRev,
    key: `${event.requestId}:${nextRev}:designFinished:${event.runId}`,
    ops: [{ kind: 'recordOutcome', taskId: event.taskId, runId: event.runId, report: event.report }],
  }));
  if (projected?.v !== 1 || projected.requestId !== event.requestId ||
      projected.taskId !== event.taskId || projected.rev !== nextRev ||
      !['in_review', 'manual', 'awaiting_answer'].includes(projected.stage) ||
      (projected.stage === 'awaiting_answer' &&
        (!projected.question || !UUID.test(projected.question.id) ||
         typeof projected.question.text !== 'string' || !Array.isArray(projected.question.options)))) {
    throw new Error('Core did not return a valid design outcome projection');
  }
  const next: AutomaticLifecycleState = { ...prior, stage: projected.stage, rev: nextRev,
    question: projected.question ? { ...projected.question, taskId: event.taskId, rev: nextRev } : undefined,
    outcome: { eventId: event.eventId, sha256: fingerprint, status: projected.status,
      ...(projected.revisionId ? { revisionId: projected.revisionId } : {}),
      ...(projected.message ? { message: projected.message } : {}),
      ...(projected.officeAlert ? { officeAlert: projected.officeAlert } : {}),
    },
  };
  ctx.set('lc', next);
  sendDesignOutcome(ctx, next);
  if (next.stage === 'awaiting_answer' && next.question) {
    ctx.scheduleQuestionReminder?.(next.requestId, next.rev, next.question.id, 1,
      REVISION_REMINDER_DELAY_MS);
    ctx.scheduleQuestionReminder?.(next.requestId, next.rev, next.question.id, 5,
      QUESTION_SECOND_REMINDER_DELAY_MS);
  }
  return { ignored: false as const, stage: next.stage, rev: next.rev };
}

const OFFICE_ROLES = new Set(['art_director', 'creative_director', 'account_lead', 'office_admin', 'administrator']);
const APPROVAL_ROLES = new Set(['art_director', 'creative_director', 'office_admin', 'administrator']);

/** A request-owned office action (revision-request or proof-bound approval) at any revision round. */
export async function recordOfficeRevision(ctx: AutomaticOpenContext, core: CoreInternal, event: OfficeRevisionEvent): Promise<OfficeRevisionReply> {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      !UUID.test(event.taskId) || !UUID.test(event.revisionId) || !UUID.test(event.actionId) ||
      event.eventId !== `desk:${event.actionId}` || !['revise', 'approve'].includes(event.kind) ||
      !Number.isInteger(event.expectedRev) || event.expectedRev < 2 ||
      !event.actor || !UUID.test(event.actor.userId) ||
      !(event.kind === 'approve' ? APPROVAL_ROLES : OFFICE_ROLES).has(event.actor.role) || typeof event.reason !== 'string' ||
      !event.reason.trim() || event.reason.length > 2000 ||
      (event.revisionRequest !== undefined &&
        (!parseCompleteRevisionRequest(event.revisionRequest) ||
          event.revisionRequest.comment.trim() !== event.reason.trim())) ||
      (event.kind === 'approve' && (!parseOfficeApprovalProof(event.approvalProof) ||
        !/^[a-f0-9]{64}$/.test(event.deskRequestFingerprint || '') || event.revisionRequest !== undefined)) ||
      (event.kind === 'revise' && (event.approvalProof !== undefined || event.deskRequestFingerprint !== undefined))) {
    throw invalid('invalid office revision identity, reviewer or audit reason');
  }
  const fingerprint = hashOf(event);
  const prior = await ctx.get('lc');
  if (!prior || !('runId' in prior)) return { accepted: false, code: 'WRONG_STAGE' };
  const expectedRev = event.expectedRev;
  const nextRev = expectedRev + 1;
  if (prior.rev === nextRev) {
    if (prior.officeRevision?.eventId !== event.eventId || prior.officeRevision.sha256 !== fingerprint) {
      throw invalid('this office decision was already recorded with different content');
    }
    // A worker can stop after saving state and before sending either message. Reissue the same
    // stable keys on replay; TelegramSender fences the critical send in Postgres.
    if (event.kind === 'revise') sendOfficeRevisionNotice(ctx, prior, event);
    return { accepted: true, requestId: prior.requestId, taskId: prior.taskId,
      revisionId: prior.officeRevision.revisionId, actionId: prior.officeRevision.actionId,
      approvalId: prior.officeRevision.approvalId, stage: prior.stage as 'manual' | 'approved', rev: nextRev };
  }
  if (prior.rev !== expectedRev || prior.stage !== 'in_review') return { accepted: false, code: 'WRONG_STAGE' };
  if (prior.taskId !== event.taskId || prior.outcome?.revisionId !== event.revisionId) {
    return { accepted: false, code: 'NOT_CURRENT_DRAFT' };
  }
  const projected = await ctx.run(`project:${nextRev}`, () => core.post<{
    v: 1; requestId: string; taskId: string; revisionId: string; actionId: string;
    approvalId: string; taskState: string; rev: number; stage: 'manual' | 'approved';
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/office-decision`, {
    v: 1, expectedRev, rev: nextRev,
    key: `${event.requestId}:${nextRev}:officeDecision:${event.eventId}`,
    ops: [{ kind: event.kind === 'approve' ? 'recordOfficeApproval' : 'recordOfficeRevision', taskId: event.taskId, revisionId: event.revisionId,
      actionId: event.actionId, actor: event.actor, reason: event.reason.trim(),
      ...(event.revisionRequest ? { revisionRequest: parseCompleteRevisionRequest(event.revisionRequest) } : {}),
      ...(event.approvalProof ? { approvalProof: parseOfficeApprovalProof(event.approvalProof),
        deskRequestFingerprint: event.deskRequestFingerprint } : {}) }],
  }));
  const expectedStage = event.kind === 'approve' ? 'approved' : 'manual';
  const expectedTaskState = event.kind === 'approve' ? 'approved' : 'revision_requested';
  if (projected?.v !== 1 || projected.requestId !== event.requestId || projected.taskId !== event.taskId ||
      projected.revisionId !== event.revisionId || projected.actionId !== event.actionId ||
      !UUID.test(projected.approvalId) || projected.taskState !== expectedTaskState ||
      projected.rev !== nextRev || projected.stage !== expectedStage) {
    throw new Error('Core did not return a valid office revision projection');
  }
  const next: AutomaticLifecycleState = { ...prior, stage: expectedStage, rev: nextRev,
    officeRevision: { eventId: event.eventId, sha256: fingerprint,
      actionId: event.actionId, revisionId: event.revisionId, approvalId: projected.approvalId, kind: event.kind } };
  ctx.set('lc', next);
  if (event.kind === 'revise') sendOfficeRevisionNotice(ctx, next, event);
  return { accepted: true, requestId: event.requestId, taskId: event.taskId, revisionId: event.revisionId,
    actionId: event.actionId, approvalId: projected.approvalId, stage: expectedStage, rev: nextRev };
}

function sendOfficeRevisionNotice(ctx: AutomaticOpenContext, state: AutomaticLifecycleState,
  event: OfficeRevisionEvent): void {
  const comment = event.revisionRequest?.comment?.trim() || event.reason.trim();
  const round = Math.floor((state.rev - 1) / 2);
  ctx.send({ v: 1, key: `${state.requestId}:${state.rev}:office-revision-notify`,
    chatId: state.chatId, kind: 'text',
    text: `Your design needs adjustments (revision ${round}).\n\n${comment}\n\nPlease reply with your updated direction or the changes you want.`,
    class: 'critical', tenantId: state.tenantId, taskId: state.taskId });
  ctx.scheduleReminder?.(state.requestId, state.rev, REVISION_REMINDER_DELAY_MS);
}

/** A delayed tick only has an effect while this exact revision still awaits the requester. */
export async function recordReminderTick(ctx: Pick<AutomaticOpenContext, 'key' | 'get' | 'send'>,
  event: ReminderTickEvent): Promise<{ skipped: true } | { reminded: true }> {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      !Number.isInteger(event.expectedRev) || event.expectedRev < (event.kind === 'question' ? 2 : 3) ||
      (event.kind !== undefined && event.kind !== 'revision' && event.kind !== 'question') ||
      (event.kind === 'question' && (!UUID.test(event.questionId || '') ||
        (event.day !== 1 && event.day !== 5))) ||
      (event.kind !== 'question' && (event.questionId !== undefined || event.day !== undefined))) {
    throw invalid('invalid revision reminder identity');
  }
  const state = await ctx.get('lc');
  if (event.kind === 'question') {
    if (!state || !('runId' in state) || state.rev !== event.expectedRev ||
        state.stage !== 'awaiting_answer' || !state.question ||
        state.question.id !== event.questionId) {
      return { skipped: true };
    }
    ctx.send({ v: 1, key: `${state.requestId}:${state.rev}:question-reminder-${event.day}`,
      chatId: state.chatId, kind: 'text',
      text: `Reminder: This design is waiting for your answer.\n\n${state.question.text}\n\nPlease reply to this message when you are ready.`,
      class: 'critical', tenantId: state.tenantId, taskId: state.taskId });
    return { reminded: true };
  }
  if (!state || !('runId' in state) || state.rev !== event.expectedRev || state.stage !== 'manual') {
    return { skipped: true };
  }
  ctx.send({ v: 1, key: `${state.requestId}:${event.expectedRev}:revision-reminder`,
    chatId: state.chatId, kind: 'text',
    text: 'Reminder: Your design is waiting for your revision direction. Please reply when you are ready.',
    class: 'critical', tenantId: state.tenantId, taskId: state.taskId });
  return { reminded: true };
}

/** A signed office action claims a publication in Core before the workflow can prepare any effect. */
export async function recordOfficeDeliveryStart(ctx: AutomaticOpenContext, core: CoreInternal,
  event: OfficeDeliveryStartEvent): Promise<OfficeDeliveryStartReply> {
  if (event?.v !== 1 || event.kind !== 'deliver' || ctx.key !== event.requestId ||
      !UUID.test(event.requestId) || !UUID.test(event.taskId) || !UUID.test(event.revisionId) ||
      !UUID.test(event.approvalId) || !UUID.test(event.actionId) ||
      event.eventId !== `desk:${event.actionId}` || !Number.isInteger(event.expectedRev) ||
      event.expectedRev < 3 || !UUID.test(event.actor?.userId || '') ||
      !['art_director', 'creative_director', 'office_admin', 'administrator'].includes(event.actor?.role) ||
      typeof event.reason !== 'string' || !event.reason.trim() || event.reason.length > 2000) {
    throw invalid('invalid signed delivery action');
  }
  const sha256 = hashOf(event);
  const prior = await ctx.get('lc');
  if (!prior || !('runId' in prior)) return { accepted: false, code: 'WRONG_STAGE' };
  if (prior.delivery?.startEventId === event.eventId) {
    if (prior.delivery.startSha256 !== sha256) throw invalid('this delivery action was recorded with different content');
    if (!prior.delivery.finishResult) ctx.startDelivery?.(prior.delivery.input);
    return { accepted: true, requestId: prior.requestId, taskId: prior.taskId,
      approvalId: prior.delivery.input.approvalId, actionId: prior.delivery.actionId,
      deliveryId: prior.delivery.input.deliveryId,
      stage: prior.stage as 'approved' | 'delivering' | 'delivered', rev: prior.rev };
  }
  if (prior.rev !== event.expectedRev || !['approved', 'delivering'].includes(prior.stage)) {
    return { accepted: false, code: 'WRONG_STAGE' };
  }
  if (prior.taskId !== event.taskId || prior.officeRevision?.revisionId !== event.revisionId ||
      prior.officeRevision.approvalId !== event.approvalId || prior.officeRevision.kind !== 'approve') {
    return { accepted: false, code: 'NOT_CURRENT_DRAFT' };
  }
  if (!ctx.startDelivery) throw new Error('RequestLifecycle has no Delivery workflow client');
  const nextRev = prior.rev + 1;
  const projected = await ctx.run(`project:${nextRev}`, () => core.post<{
    v: 1; requestId: string; taskId: string; approvalId: string; actionId: string;
    stage: 'delivering'; rev: number; delivery: DeliveryInput;
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/delivery-start`, {
    v: 1, expectedRev: prior.rev, rev: nextRev,
    key: `${event.requestId}:${nextRev}:officeDecision:${event.eventId}`,
    ops: [{ kind: 'startDelivery', taskId: event.taskId, revisionId: event.revisionId,
      approvalId: event.approvalId, actionId: event.actionId, actor: event.actor,
      reason: event.reason.trim() }],
  }));
  if (projected?.v !== 1 || projected.requestId !== event.requestId || projected.taskId !== event.taskId ||
      projected.approvalId !== event.approvalId || projected.actionId !== event.actionId ||
      projected.stage !== 'delivering' || projected.rev !== nextRev ||
      projected.delivery?.requestId !== event.requestId || projected.delivery.taskId !== event.taskId ||
      projected.delivery.approvalId !== event.approvalId || projected.delivery.revisionId !== event.revisionId ||
      projected.delivery.reportTo !== 'lifecycle' || projected.delivery.requestRev !== nextRev) {
    throw new Error('Core did not return a valid request-owned delivery claim');
  }
  const next: AutomaticLifecycleState = { ...prior, stage: 'delivering', rev: nextRev,
    delivery: { startEventId: event.eventId, startSha256: sha256, actionId: event.actionId,
      input: projected.delivery } };
  ctx.set('lc', next);
  ctx.startDelivery(projected.delivery);
  return { accepted: true, requestId: event.requestId, taskId: event.taskId,
    approvalId: event.approvalId, actionId: event.actionId,
    deliveryId: projected.delivery.deliveryId, stage: 'delivering', rev: nextRev };
}

/** The workflow reports only to its private request owner; Core applies a versioned final projection. */
export async function recordDeliveryFinished(ctx: AutomaticOpenContext, core: CoreInternal,
  event: DeliveryFinishedEvent): Promise<DeliveryFinishedReply> {
  if (event?.v !== 1 || ctx.key !== event.requestId || !UUID.test(event.requestId) ||
      !UUID.test(event.taskId) || !UUID.test(event.approvalId) ||
      event.eventId !== `delivery:${event.deliveryId}` || !Number.isInteger(event.run) || event.run < 1 ||
      !Number.isInteger(event.expectedRev) || event.expectedRev < 4 ||
      !['delivered', 'chat_only', 'uncertain', 'failed'].includes(event.outcome?.outcome) ||
      !Array.isArray(event.outcome.uncertain)) {
    throw invalid('invalid delivery-finished event');
  }
  const sha256 = hashOf(event);
  const prior = await ctx.get('lc');
  if (!prior || !('runId' in prior) || !prior.delivery) throw invalid('this request has no delivery to finish');
  if (prior.delivery.finishEventId === event.eventId) {
    if (prior.delivery.finishSha256 !== sha256 || !prior.delivery.finishResult) {
      throw invalid('the delivery result was recorded with different content');
    }
    return prior.delivery.finishResult;
  }
  if (prior.stage !== 'delivering' || prior.rev !== event.expectedRev ||
      prior.taskId !== event.taskId || prior.delivery.input.deliveryId !== event.deliveryId ||
      prior.delivery.input.approvalId !== event.approvalId || prior.delivery.input.run !== event.run) {
    throw invalid('the current request is not delivering this workflow run');
  }
  const nextRev = prior.rev + 1;
  const projected = await ctx.run(`project:${nextRev}`, () => core.post<{
    v: 1; requestId: string; taskId: string; approvalId: string; deliveryId: string;
    stage: 'approved' | 'delivering' | 'delivered'; taskState: string; rev: number;
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/delivery-finished`, {
    v: 1, expectedRev: prior.rev, rev: nextRev,
    key: `${event.requestId}:${nextRev}:deliveryFinished:${event.deliveryId}`,
    ops: [{ kind: 'finishDelivery', taskId: event.taskId, approvalId: event.approvalId,
      deliveryId: event.deliveryId, run: event.run, outcome: event.outcome }],
  }));
  if (projected?.v !== 1 || projected.requestId !== event.requestId || projected.taskId !== event.taskId ||
      projected.approvalId !== event.approvalId || projected.deliveryId !== event.deliveryId ||
      projected.rev !== nextRev || !['approved', 'delivering', 'delivered'].includes(projected.stage)) {
    throw new Error('Core did not return a valid request-owned delivery result');
  }
  const reply: DeliveryFinishedReply = { accepted: true, requestId: event.requestId, taskId: event.taskId,
    approvalId: event.approvalId, deliveryId: event.deliveryId,
    stage: projected.stage, taskState: projected.taskState, rev: nextRev };
  const next: AutomaticLifecycleState = { ...prior, stage: projected.stage, rev: nextRev,
    delivery: { ...prior.delivery, finishEventId: event.eventId, finishSha256: sha256,
      finishResult: reply } };
  ctx.set('lc', next);
  return reply;
}

function sendDesignOutcome(ctx: AutomaticOpenContext, state: AutomaticLifecycleState): void {
  const message = state.outcome?.message;
  // Key is scoped to rev so a retried send after a revision round uses the correct idempotency key.
  if (message) ctx.send({ v: 1, key: `${state.requestId}:${state.rev}:design-outcome`, chatId: state.chatId,
    kind: 'text', text: message.text, parseMode: message.parseMode, class: 'critical',
    tenantId: state.tenantId, taskId: state.taskId });
  const alert = state.outcome?.officeAlert;
  if (alert) ctx.send({ v: 1, key: `${state.requestId}:${state.rev}:office-alert`, chatId: alert.chatId,
    kind: 'text', text: alert.text, class: 'critical', tenantId: state.tenantId, taskId: state.taskId });
}

/**
 * Records the requester's revision directive and starts the next design round.
 * The worker must have already intake-persisted the new task via Core with source event
 * `lc-<requestId>-r<round>` and lifecycleOwner 'restate', then pass its id here.
 * Rev path: manual (rev N) → designing (rev N+1) with the new task.
 */
export async function recordRequesterDecision(
  ctx: AutomaticOpenContext,
  core: CoreInternal,
  event: RequesterDecisionEvent,
): Promise<RequesterDecisionReply> {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      !Number.isInteger(event.round) || event.round < 1 ||
      !UUID.test(event.priorTaskId) ||
      typeof event.directive !== 'string' || !event.directive.trim() || event.directive.length > 5000 ||
      typeof event.eventId !== 'string' || !event.eventId) {
    throw invalid('invalid requester decision event');
  }
  const fingerprint = hashOf(event);
  const prior = await ctx.get('lc');
  if (!prior || !('runId' in prior)) return { accepted: false, code: 'WRONG_STAGE' };
  // Idempotent replay: already in designing for this round.
  if (prior.revisionRound?.eventId === event.eventId) {
    if (prior.revisionRound.sha256 !== fingerprint) throw invalid('requester decision replayed with different content');
    if (prior.stage === 'designing') ctx.startDesign({
      ...prior.designInput,
      lifecycle: { requestId: prior.requestId, round: prior.revisionRound.round, runId: prior.revisionRound.runId },
      taskId: prior.revisionRound.newTaskId,
    });
    return { accepted: true, requestId: prior.requestId, newTaskId: prior.revisionRound.newTaskId,
      runId: prior.revisionRound.runId, round: prior.revisionRound.round, rev: prior.rev, stage: 'designing' };
  }
  if (prior.stage !== (event.questionId ? 'awaiting_answer' : 'manual')) {
    return { accepted: false, code: 'WRONG_STAGE' };
  }
  if (event.questionId && (!UUID.test(event.questionId) ||
      prior.question?.id !== event.questionId || prior.question.taskId !== event.priorTaskId ||
      prior.question.rev !== prior.rev)) return { accepted: false, code: 'WRONG_STAGE' };
  if (prior.taskId !== event.priorTaskId) return { accepted: false, code: 'WRONG_STAGE' };
  // The worker must pass a newTaskId it obtained by intaking via /internal/telegram/intake.
  // We inline the Core call here to get the new task's id back from the route.
  // The worker sends the new task id as part of the event, pre-fetched before calling this handler.
  // Validate the new task: it must be a UUID distinct from the prior task.
  if (!('newTaskId' in event) || !UUID.test((event as unknown as { newTaskId: string }).newTaskId) ||
      (event as unknown as { newTaskId: string }).newTaskId === event.priorTaskId) {
    throw invalid('requester decision must carry a new task id that is distinct from the prior task');
  }
  const newTaskId = (event as unknown as { newTaskId: string }).newTaskId;
  const expectedRev = prior.rev;
  const nextRev = expectedRev + 1;
  const updateMatch = /^chatinbox:revision:([1-9][0-9]*)$/.exec(event.eventId);
  if (event.eventId.startsWith('chatinbox:revision:') &&
      (!updateMatch || !Number.isSafeInteger(Number(updateMatch[1])))) {
    throw invalid('requester decision has an invalid Telegram update identity');
  }
  if (event.questionId && !updateMatch) {
    throw invalid('clarification answers require the persisted Telegram update identity');
  }
  const projected = await ctx.run(`project:${nextRev}`, () => core.post<{
    v: 1; requestId: string; priorTaskId: string; newTaskId: string;
    round: number; rev: number; stage: 'designing'; runId: string; directive?: string;
    questionId?: string;
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/${updateMatch
    ? 'requester-revision-intake' : 'requester-revision'}`, updateMatch
    ? { v: 1, updateId: Number(updateMatch[1]), expectedRev,
        priorTaskId: event.priorTaskId, newTaskId, round: event.round,
        directive: event.directive.trim(),
        ...(event.questionId ? { questionId: event.questionId } : {}) }
    : { v: 1, expectedRev, rev: nextRev,
        key: `${event.requestId}:${nextRev}:requesterRevision:r${event.round}`,
        ops: [{ kind: 'requesterRevision', priorTaskId: event.priorTaskId, newTaskId,
          round: event.round, directive: event.directive.trim() }] }));
  if (projected?.v !== 1 || projected.requestId !== event.requestId ||
      projected.priorTaskId !== event.priorTaskId || projected.newTaskId !== newTaskId ||
      projected.round !== event.round || projected.rev !== nextRev || projected.stage !== 'designing' ||
      projected.runId !== `dr-${newTaskId}` ||
      projected.questionId !== event.questionId ||
      (updateMatch && projected.directive !== event.directive.trim())) {
    throw new Error('Core did not return a valid requester revision projection');
  }
  const newRunId = projected.runId;
  const newDesignInput: DesignRunInput = {
    ...prior.designInput,
    rawText: event.directive.trim(),
    lifecycle: { requestId: prior.requestId, round: event.round, runId: newRunId },
    taskId: newTaskId,
    idempotencyKey: `lifecycle:${prior.requestId}:${newTaskId}`,
  };
  const next: AutomaticLifecycleState = { ...prior, stage: 'designing', rev: nextRev,
    taskId: newTaskId, runId: newRunId, round: event.round, designInput: newDesignInput,
    revisionRound: { eventId: event.eventId, sha256: fingerprint, round: event.round,
      newTaskId, runId: newRunId },
    // Clear prior-round transient fields so the next design-outcome projects cleanly.
    outcome: undefined, officeRevision: undefined, question: undefined,
  };
  ctx.set('lc', next);
  ctx.startDesign(newDesignInput);
  return { accepted: true, requestId: prior.requestId, newTaskId, runId: newRunId,
    round: event.round, rev: nextRev, stage: 'designing' };
}

export function createRequestLifecycle(core: CoreInternal = coreInternalFromEnv()) {
  return restate.object({
    name: 'RequestLifecycle',
    handlers: {
      open: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: OpenManualEvent | OpenAutomaticEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId, tenantId: event?.tenantId }, () =>
            event?.draft?.autoGenerate === true ? openAutomaticRequest({
              key: ctx.key,
              get: (name) => ctx.get<ManualLifecycleState | AutomaticLifecycleState>(name),
              run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
              set: (name, value) => ctx.set(name, value),
              send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
                .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
              startDesign: (input) => ctx.workflowSendClient(DesignRunApi, input.lifecycle.runId).run(input),
              setChatMode: (chatId, requestId) => ctx.objectSendClient(chatInbox, chatId)
                .setMode(requestId, restate.rpc.sendOpts({ idempotencyKey: `chatinbox:setMode:${requestId}` })),
            }, core, event as OpenAutomaticEvent) : openManualRequest({
              key: ctx.key,
              get: (name) => ctx.get<ManualLifecycleState>(name),
              run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
              set: (name, value) => ctx.set(name, value),
              send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
                .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
              setChatMode: (chatId, requestId) => ctx.objectSendClient(chatInbox, chatId)
                .setMode(requestId, restate.rpc.sendOpts({ idempotencyKey: `chatinbox:setMode:${requestId}` })),
            }, core, event as OpenManualEvent)),
      ),
      designFinished: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: DesignFinishedEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, () => recordDesignFinished({
            key: ctx.key,
            get: (name) => ctx.get<ManualLifecycleState | AutomaticLifecycleState>(name),
            run: (name, action) => ctx.run(name, action, OUTCOME_RETRY),
            set: (name, value) => ctx.set(name, value),
            send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
              .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
            startDesign: () => { throw new Error('designFinished cannot start a new run'); },
            scheduleQuestionReminder: (requestId, rev, questionId, day, delayMs) =>
              ctx.objectSendClient(RequestLifecycleApi, requestId)
                .reminderTick({ v: 1, requestId, expectedRev: rev, kind: 'question', questionId, day },
                  restate.rpc.sendOpts({
                    idempotencyKey: `lifecycle:question-reminder:${requestId}:${rev}:${day}`,
                    delay: delayMs,
                  })),
          }, core, event)),
      ),
      officeDecision: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: OfficeRevisionEvent | OfficeDeliveryStartEvent) =>
          withInvocationLogContext<OfficeDeliveryStartReply | OfficeRevisionReply>(ctx, { requestId: event?.requestId }, () => {
            const handlers: AutomaticOpenContext = {
            key: ctx.key,
            get: (name) => ctx.get<ManualLifecycleState | AutomaticLifecycleState>(name),
            run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
            set: (name, value) => ctx.set(name, value),
            send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
              .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
            startDesign: () => { throw new Error('officeDecision cannot start a run from this transition'); },
            startDelivery: (input) => ctx.workflowSendClient(DeliveryApi, input.deliveryId).run(input),
            scheduleReminder: (requestId, rev, delayMs) =>
              ctx.objectSendClient(RequestLifecycleApi, requestId)
                .reminderTick({ v: 1, requestId, expectedRev: rev },
                  restate.rpc.sendOpts({
                    idempotencyKey: `lifecycle:reminder:${requestId}:${rev}`,
                    delay: delayMs,
                  })),
            };
            return event?.kind === 'deliver'
              ? recordOfficeDeliveryStart(handlers, core, event)
              : recordOfficeRevision(handlers, core, event as OfficeRevisionEvent);
          }),
      ),
      requesterDecision: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: RequesterDecisionEvent & { newTaskId: string }) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, () => recordRequesterDecision({
            key: ctx.key,
            get: (name) => ctx.get<ManualLifecycleState | AutomaticLifecycleState>(name),
            run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
            set: (name, value) => ctx.set(name, value),
            send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
              .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
            startDesign: (input) => ctx.workflowSendClient(DesignRunApi, input.lifecycle.runId).run(input),
          }, core, event)),
      ),
      deliveryFinished: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: DeliveryFinishedEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, () => recordDeliveryFinished({
            key: ctx.key,
            get: (name) => ctx.get<ManualLifecycleState | AutomaticLifecycleState>(name),
            run: (name, action) => ctx.run(name, action, OUTCOME_RETRY),
            set: (name, value) => ctx.set(name, value),
            send: () => { throw new Error('deliveryFinished cannot send from this transition'); },
            startDesign: () => { throw new Error('deliveryFinished cannot start a design run'); },
          }, core, event)),
      ),
      get: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext): Promise<ManualLifecycleState | AutomaticLifecycleState | null> =>
        (await ctx.get<ManualLifecycleState | AutomaticLifecycleState>('lc')) ?? null),
      /** Fires after a delay when the requester has not submitted a revision directive. */
      reminderTick: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 2 }, journalRetention: { days: 2 } },
        async (ctx: restate.ObjectContext, event: ReminderTickEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, async () => {
            return recordReminderTick({ key: ctx.key,
              get: (name) => ctx.get<ManualLifecycleState | AutomaticLifecycleState>(name),
              send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
                .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
            }, event);
          }),
      ),
    },
    options: {
      ingressPrivate: true,
      inactivityTimeout: { minutes: 1 }, abortTimeout: { minutes: 5 },
      retryPolicy: { initialInterval: 1000, exponentiationFactor: 2, maxInterval: 60_000, maxAttempts: 300, onMaxAttempts: 'pause' },
    },
  });
}

/** Stable client definition shared by DesignRun and the worker endpoint. */
export const RequestLifecycleApi = createRequestLifecycle();
