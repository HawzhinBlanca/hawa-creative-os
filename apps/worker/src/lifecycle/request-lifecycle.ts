/**
 * RequestLifecycle's versioned request owner (ADR-034, Phase 2.3): open, terminal design outcome,
 * office review, a delivery claim, and its final outcome.
 * ChatInbox cutover remains controlled by the request lifecycle flag.
 * Once bound, the service name stays in every worker build for blue/green drain compatibility.
 */
import { createHash } from 'node:crypto';
import * as restate from '@restatedev/restate-sdk';
import type { BlobRef, DeliveryInput, DeliveryOutcome, DraftImageRef, OutboundMessage } from '@hawa/contracts';
import { nextOfficeMoment, parseCompleteRevisionRequest, parseOfficeApprovalProof, parseRejectionCategory, type OfficeApprovalProof, type RejectionCategory, type StructuredRevisionRequest } from '@hawa/domain';
import { log, withInvocationLogContext } from '../logging.js';
import { coreInternalFromEnv, DeliveryApi, outcomeReportCore, type CoreInternal } from './delivery.js';
import { officeAlertKey, officeAlertRoute, officeChatIdsFromEnv } from './office-chats.js';
import { TelegramSenderApi } from './telegram-sender.js';
import { DesignRunApi, validStartNotice, type DesignRunInput, type DesignStartNotice } from './design-run.js';
import { chatInbox } from './chat-inbox.js';
import { parseNativeReviewSubmission, type NativeReviewSubmission, type NativeReviewReply } from '@hawa/domain';
import { INBOX_MESSAGES, LIFECYCLE_MESSAGES, OUTCOME_MESSAGES, ROUTING_MESSAGES, bold, escapeTelegramHtml, requesterLang, requesterTitleName, say, type Phrase, type RequesterLang } from '@hawa/integrations';

const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A projection step asks Core again, backing off to 30 s, with no limit of its own (ADR-155): the
 * object's retry policy pauses the invocation after its 300 attempts (about five hours), where a person
 * sees it (/v1/health restateInvocations) and resumes it once Core is back. The 30-minute limit it had
 * ended the invocation for good after a longer Core outage: a brief that never became a request, and
 * nobody told.
 */
export const PROJECT_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 30_000 };
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
    platform: 'telegram'|'hawzhin_web';
    sourceEventId: string;
    sourceChannelId: string;
    rawText: string;
    title: string;
    designInstructions: string;
    exactCopy: unknown[];
    clientId: string | null;
    autoGenerate: false;
    isInstructionOnly?: boolean;
    lifecycleImage?: BlobRef & { updateId: number };
    lifecycleAlbum?: import('@hawa/contracts').LifecycleAlbumRef;
    customerWebPhotos?: import('@hawa/contracts').CustomerPhotoManifest;
    lifecycleSource?: import('@hawa/contracts').LifecycleSourceRef;
  };
}

export interface ManualLifecycleState {
  initialRequesterHold?: {officeAlerts:Array<{chatId:string;text:string}>};
  initialOfficeAlerts?:Array<{chatId:string;text:string}>;
  v: 1;
  requestId: string;
  tenantId: string;
  chatId: string;
  owner: 'restate';
  /** `cancelled`: withdrawn (ADR-230). */
  stage: 'manual' | 'cancelled';
  rev: number;
  taskId: string;
  openEventId: string;
  openSha256: string;
  /**
   * ADR-145: the language the requester wrote the brief in (requesterLang on its words) and the
   * design's name, for what this object says to them. Added fields: state saved before they existed
   * has neither, and is answered by `requesterOf`.
   */
  lang?: RequesterLang;
  title?: string;
  /** ADR-230: how the request was withdrawn (its stage is then `cancelled`). */
  withdrawal?: Withdrawal;
}

/** ADR-230: a withdraw, as this object recorded it; replays send its notices again under the same keys. */
export interface Withdrawal {
  eventId: string; sha256: string; actor: 'requester' | 'office'; rev: number; fromStage: string;
  requesterNotice?: { chatId: string; text: string }; officeAlerts: Array<{ chatId: string; text: string }>;
  /** The finished run of a design already being made when the request was withdrawn, once recorded. */
  finishedRunEventId?: string;
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
  nativeReview?: { eventId: string; sha256: string; reply: Extract<NativeReviewReply,{accepted:true}> };
  stage: 'designing' | 'awaiting_answer' | 'in_review' | 'manual' | 'approved' | 'rejected' | 'delivering' | 'delivered' | 'cancelled';
  rev: number;
  runId: string;
  /** Current design round (0 = original, 1+ = revision rounds). */
  round?: number;
  designInput: DesignRunInput;
  outcome?: { eventId: string; sha256: string; status: string; revisionId?: string;
    message?: { text: string; parseMode: 'HTML' }; officeAlert?: { chatId: string; text: string };
    /** ADR-155: the alert to every office member (the first is `officeAlert`, kept for older receipts). */
    officeAlerts?: Array<{ chatId: string; text: string }>;
    /** ADR-155 addendum: the same alerts with the draft's picture, sent in their place when Core gives them. */
    officePhotoAlerts?: OfficePhotoAlert[] };
  question?: { id: string; text: string; options: string[]; taskId: string; rev: number;
    /** Derived from the confirmed Telegram send mark, never from outcome projection time. */
    sentAtMs?: number; messageId?: string };
  officeRevision?: { eventId: string; sha256: string; actionId: string; revisionId: string; approvalId: string;
    kind?: 'revise' | 'approve' | 'reject' };
  /** Filled when the requester submits a revision directive after the office marks "revise". */
  revisionRound?: { eventId: string; sha256: string; round: number; newTaskId: string; runId: string };
  /** ADR-230 addendum: the design-finished event whose outcome started a round for pending changes. */
  pendingRoundFrom?: string;
  /** The office's latest retry of a design that ended without a draft (ADR-142). */
  officeRetry?: { eventId: string; sha256: string; actionId: string; attempt: number; runId: string; rev: number;
    /** ADR-233: the retry designed a fresh successor of a refused redo or pending-changes round. */
    freshTaskId?: string };
  delivery?: { startEventId: string; startSha256: string; actionId: string; input: DeliveryInput;
    finishEventId?: string; finishSha256?: string; finishResult?: DeliveryFinishedReply;
    /** ADR-230: a chat-only delivery finished before it closed its request, closed by the repair. */
    reconciledEventId?: string };
}

/**
 * ADR-126: an initial manual request after its owner-controlled native review. It has no design
 * run, never starts one, and has no requester revision round: the office approves or rejects it.
 */
export interface ManualOriginLifecycleState extends Omit<AutomaticLifecycleState,
  'stage' | 'runId' | 'round' | 'designInput' | 'question' | 'revisionRound'> {
  origin: 'manual';
  stage: 'in_review' | 'approved' | 'rejected' | 'delivering' | 'delivered' | 'cancelled';
}

export type LifecycleState = ManualLifecycleState | AutomaticLifecycleState | ManualOriginLifecycleState;
/** States that own a reviewed draft: an automatic request, or a manual one after native review. */
type ReviewOwnedState = AutomaticLifecycleState | ManualOriginLifecycleState;
const reviewOwned = (state: LifecycleState): state is ReviewOwnedState =>
  'runId' in state || ('origin' in state && state.origin === 'manual');

export interface OfficeRevisionEvent {
  v: 1; eventId: string; requestId: string; taskId: string; revisionId: string;
  actionId: string;
  /** expectedRev ≥ 2: first decision is at 2; subsequent revision rounds use 2+2k. */
  expectedRev: number; kind: 'revise' | 'approve' | 'reject';
  /** `telegram_office`: an office member's reply in their private Telegram chat (ADR-040 addendum). */
  actor: { userId: string; role: string; authMethod?: 'google_oidc' | 'telegram_office'; sessionHash?: string; telegramChatId?: string };
  reason: string;
  rejectionCategory?: RejectionCategory;
  /** Optional only for signed decisions already in flight before the structured-feedback rollout. */
  revisionRequest?: StructuredRevisionRequest;
  approvalProof?: OfficeApprovalProof;
  deskRequestFingerprint?: string;
}

export type OfficeRevisionReply =
  | { accepted: true; requestId: string; taskId: string; revisionId: string; actionId: string;
      approvalId: string; stage: 'manual' | 'approved' | 'rejected'; rev: number }
  | { accepted: false; code: 'WRONG_STAGE' | 'NOT_CURRENT_DRAFT' };

/** ADR-142: the office runs the current task's automatic design again after it ended without a draft. */
export interface OfficeRetryEvent {
  v: 1; kind: 'retry'; eventId: string; requestId: string; taskId: string; actionId: string;
  expectedRev: number; actor: { userId: string; role: string }; reason: string;
}

export type OfficeRetryReply =
  | { accepted: true; requestId: string; taskId: string; actionId: string; runId: string; attempt: number;
      stage: 'designing'; rev: number; freshTaskId?: string }
  | { accepted: false; code: 'WRONG_STAGE' | 'NOT_CURRENT_DRAFT' };

/** The roles Core's projection admits for a retry (lifecycle-office-retry.ts OFFICE_RETRY_ROLES). */
export const OFFICE_RETRY_ROLES = new Set(['operator', 'art_director', 'creative_director', 'office_admin', 'administrator']);

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
  /**
   * ADR-233: what the requester hears once the round's design has started (Core's "I'll redo …", or
   * "I'm making those changes now"). ChatInbox no longer sends it at once: the DesignRun sends it when
   * Core admits the run, so a round refused at admission is answered once, by its outcome.
   */
  startNotice?: DesignStartNotice;
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

export interface QuestionSentEvent {
  v: 1; requestId: string; expectedRev: number; taskId: string; questionId: string;
  messageKey: string; messageId: string;
}

const REVISION_REMINDER_DELAY_MS = 24 * 60 * 60_000;
const QUESTION_SECOND_REMINDER_DELAY_MS = 5 * 24 * 60 * 60_000;

export interface AutomaticOpenContext {
  key: string;
  get(name: string): Promise<LifecycleState | null>;
  run<T>(name: string, action: () => Promise<T>): Promise<T>;
  /** Durable wait for an explicit task hold; absent only in plain test harnesses. */
  sleep?(millis: number): Promise<void>;
  set(name: string, value: LifecycleState): void;
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

export interface QuestionSentContext extends Pick<AutomaticOpenContext,
  'key' | 'get' | 'run' | 'set' | 'scheduleQuestionReminder'> {
  now(): Promise<number>;
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

/**
 * The requester's language and the design's name as they see it (bold HTML). State saved before
 * ADR-145 carries neither: the language is then read from the design run's words when there are any,
 * else English, and the design is "your design".
 */
function requesterOf(state: Pick<ManualLifecycleState, 'lang' | 'title'> & { designInput?: { rawText?: string } }):
  { lang: RequesterLang; title: string } {
  const lang = state.lang ?? requesterLang(state.designInput?.rawText, 'en');
  // ADR-200 addendum: a request named neutrally ("New design request from Sewa") is "your design" to them.
  // ADR-231: no direction mark at the name's edges.
  const short = requesterTitleName(state.title);
  return { lang, title: short ? bold(short) : say(LIFECYCLE_MESSAGES.yourDesign, lang) };
}

/** A requester-facing line in their language, in Telegram HTML; `params` values are HTML already. */
function requesterText(state: Parameters<typeof requesterOf>[0], phrase: Phrase, params: Record<string, string> = {}): string {
  const { lang, title } = requesterOf(state);
  return say(phrase, lang, { title, ...params });
}

/** The language and name recorded when a request opens (ADR-145). */
const requesterFields = (draft: { rawText: string; title: string }): Pick<ManualLifecycleState, 'lang' | 'title'> => ({
  lang: requesterLang(draft.rawText, 'en'),
  ...(typeof draft.title === 'string' && draft.title.trim() ? { title: draft.title.trim().slice(0, 200) } : {}),
});

function sendAcknowledgement(ctx: Pick<OpenContext, 'send'>,
  state: Pick<ManualLifecycleState, 'requestId' | 'chatId' | 'tenantId' | 'taskId' | 'lang' | 'title' | 'initialRequesterHold' | 'initialOfficeAlerts'>): void {
  ctx.send({
    v: 1, key: `${state.requestId}:1:ack`, chatId: state.chatId, kind: 'text',
    text: requesterText(state, state.initialRequesterHold ? ROUTING_MESSAGES.statusHeld : LIFECYCLE_MESSAGES.receivedForDesigner), parseMode: 'HTML', class: 'critical',
    tenantId: state.tenantId, taskId: state.taskId,
  });
  sendInitialHoldAlerts(ctx,state);
}

function sendInitialHoldAlerts(ctx: Pick<OpenContext,'send'>,state:Pick<ManualLifecycleState,'requestId'|'chatId'|'tenantId'|'taskId'|'initialRequesterHold'|'initialOfficeAlerts'>): void {
  const perChat=new Map<string,number>();
  for (const alert of state.initialRequesterHold?.officeAlerts ?? []) {
    const index=perChat.get(alert.chatId) ?? 0;perChat.set(alert.chatId,index+1);
    ctx.send({v:1,key:`${state.requestId}:1:early-hold-office:${alert.chatId}${index ? `:${index}` : ''}`,
      ...officeAlertRoute(alert.chatId,state.chatId),kind:'text',text:alert.text,parseMode:'HTML',class:'critical',tenantId:state.tenantId,taskId:state.taskId});
  }
  for (const [index,alert] of (state.initialOfficeAlerts ?? []).entries()) ctx.send({v:1,
    key:`${state.requestId}:1:initial-office:${index}:${alert.chatId}`,...officeAlertRoute(alert.chatId,state.chatId),kind:'text',text:alert.text,
    parseMode:'HTML',class:'critical',tenantId:state.tenantId,taskId:state.taskId});
}

/** What a step Core refused for good was doing, and whose words it carried (ADR-155). */
interface TerminalFailure {
  /** Names the alert's keys and the journaled read of the office: unique within the invocation. */
  step: string;
  requestId: string; tenantId: string; taskId?: string;
  /** "start this brief", "record the finished design", ... */
  what: string;
  /** The requester's own words, quoted to the office so nothing they sent is lost. */
  words?: string;
  /**
   * Who to tell, and in which words: `officeTold` when an office member heard of it, else `alone`.
   * Without `alone`, a requester with no office to hand it to is told nothing rather than something
   * untrue ("the office will follow up"), and the failure is logged.
   */
  requester?: { chatId: string; state: Parameters<typeof requesterOf>[0]; officeTold: Phrase; alone?: Phrase };
}

/**
 * ADR-155: a step Core refused for good ends the invocation (a genuine conflict, or an answer asking
 * again cannot change), but never silently. Every office member hears which request and task, what
 * Core said and the requester's own words; the requester, when there is one to tell, is told the truth:
 * that it went wrong on our side, and that the office has it (only when an office member was told).
 * Who the office is, is read in a journaled step, so a replay alerts the same people under the same keys.
 */
async function reportTerminalFailure(ctx: Pick<AutomaticOpenContext, 'run' | 'send'>, failure: TerminalFailure, error: unknown): Promise<void> {
  const members = await ctx.run(`office-chats:${failure.step}`, async () => officeChatIdsFromEnv());
  const refusal = Array.from(error instanceof Error ? error.message : String(error)).slice(0, 300).join('');
  const words = failure.words?.trim() ? `\nThe requester wrote: ${Array.from(failure.words.trim()).slice(0, 800).join('')}` : '';
  const text = `Hawa could not ${failure.what} for request ${failure.requestId}${failure.taskId ? ` (task ${failure.taskId})` : ''}: ` +
    `${refusal}\nA person needs to follow it up in Hawa Desk.${words}`;
  const about = { tenantId: failure.tenantId, ...(failure.taskId ? { taskId: failure.taskId } : {}) };
  for (const [index, chatId] of members.entries()) {
    // ADR-240: a canary brief's failure is recorded in the canary chat (TelegramSender), never the office's.
    ctx.send({ v: 1, key: officeAlertKey(`${failure.requestId}:${failure.step}:failed-alert`, index, chatId),
      ...officeAlertRoute(chatId, failure.requester?.chatId), kind: 'text', text, class: 'critical', ...about });
  }
  const phrase = members.length ? failure.requester?.officeTold : failure.requester?.alone;
  if (failure.requester && phrase) {
    ctx.send({ v: 1, key: `${failure.requestId}:${failure.step}:failed-notice`, chatId: failure.requester.chatId, kind: 'text',
      text: requesterText(failure.requester.state, phrase), parseMode: 'HTML', class: 'critical', ...about });
  }
  if (!members.length) {
    log.error(`[RequestLifecycle] could not ${failure.what} for request ${failure.requestId}, and no office chat is configured to hear of it: ${refusal}`);
  }
}

/** The step's answer; a refusal for good is reported (reportTerminalFailure) before it is thrown on. */
async function reportedIfRefused<T>(ctx: Pick<AutomaticOpenContext, 'run' | 'send'>, step: () => Promise<T>, failure: TerminalFailure): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof restate.TerminalError) await reportTerminalFailure(ctx, failure, error);
    throw error;
  }
}

/** ADR-155: a brief Core refused to open; the office has its words, the requester hears the truth. */
const openFailure = (event: OpenManualEvent | OpenAutomaticEvent): TerminalFailure => ({
  step: 'open', requestId: event.requestId, tenantId: event.tenantId, what: 'start this brief',
  words: event.draft.rawText,
  requester: { chatId: event.chatId, state: requesterFields(event.draft),
    officeTold: OUTCOME_MESSAGES.couldNotStart },
});

/** A replay after `set` still emits the same fenced message key, so a crash cannot lose the ack. */
export async function openManualRequest(ctx: OpenContext, core: CoreInternal, event: OpenManualEvent): Promise<OpenManualResult> {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      event.eventId !== `open:${event.requestId}` || event.tenantId !== DEFAULT_TENANT_ID ||
      !(event.draft?.platform==='hawzhin_web' ? /^web:[0-9a-f-]{36}$/i.test(event.chatId) : event.draft?.platform==='telegram' && /^-?\d{1,20}$/.test(event.chatId)) ||
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
  const projected = await reportedIfRefused(ctx, () => ctx.run('project:1', () => core.post<{ v: 1; taskId: string; stage: string; rev: number; autoGenerate: boolean;
    requesterHold?:true;officeAlerts?:Array<{chatId:string;text:string}> }>(
    `/internal/lifecycle/${encodeURIComponent(event.requestId)}/project`,
    { v: 1, expectedRev: 0, rev: 1, key: `${event.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: event.draft }] },
  )), openFailure(event));
  if (projected?.v !== 1 || !UUID.test(projected.taskId) || projected.stage !== 'manual' || projected.rev !== 1 || projected.autoGenerate !== false) {
    throw new Error('Core did not return a manual request projection; do not acknowledge it');
  }
  const state: ManualLifecycleState = {
    v: 1, requestId: event.requestId, tenantId: event.tenantId, chatId: event.chatId,
    owner: 'restate', stage: 'manual', rev: 1, taskId: projected.taskId,
    openEventId: event.eventId, openSha256: fingerprint, ...requesterFields(event.draft),
    ...(projected.requesterHold ? {initialRequesterHold:{officeAlerts:projected.officeAlerts ?? []}} : {}),
    ...(!projected.requesterHold && projected.officeAlerts?.length ? {initialOfficeAlerts:projected.officeAlerts} : {}),
  };
  ctx.set('lc', state);
  ctx.setChatMode?.(event.chatId, event.requestId);
  sendAcknowledgement(ctx, state);
  return { accepted: true, taskId: state.taskId, stage: 'manual', rev: 1 };
}

function sendAutomaticAcknowledgement(ctx: AutomaticOpenContext, state: AutomaticLifecycleState): void {
  ctx.send({ v: 1, key: `${state.requestId}:1:ack`, chatId: state.chatId, kind: 'text',
    text: requesterText(state, state.initialRequesterHold ? ROUTING_MESSAGES.statusHeld : LIFECYCLE_MESSAGES.receivedDrafting), parseMode: 'HTML', class: 'critical',
    tenantId: state.tenantId, taskId: state.taskId });
  sendInitialHoldAlerts(ctx,state);
}

/** The persisted Core projection, not the untrusted open event, supplies the run's execution policy. */
export async function openAutomaticRequest(ctx: AutomaticOpenContext, core: CoreInternal, event: OpenAutomaticEvent) {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      event.eventId !== `open:${event.requestId}` || event.tenantId !== DEFAULT_TENANT_ID ||
      !(event.draft?.platform==='hawzhin_web' ? /^web:[0-9a-f-]{36}$/i.test(event.chatId) : event.draft?.platform==='telegram' && /^-?\d{1,20}$/.test(event.chatId)) ||
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
  const projected = await reportedIfRefused(ctx, () => ctx.run('project:1', () => core.post<{
    v: 1; taskId: string; stage: string; rev: number; autoGenerate: boolean;
    requesterHold?:true;officeAlerts?:Array<{chatId:string;text:string}>;
    design?: { clientId: string; rawText: string; sourcePlatform: string;
      variant?: { width: number; height: number }; designStudio: boolean; studioOptions?: DesignRunInput['studioOptions'] };
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/project`,
    { v: 1, expectedRev: 0, rev: 1, key: `${event.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: event.draft }] })),
    openFailure(event));
  if (projected?.v !== 1 || !UUID.test(projected.taskId) || projected.rev !== 1) {
    throw new Error('Core did not return an automatic design projection; do not start the run');
  }
  if (projected.stage === 'manual' && projected.autoGenerate === false) {
    const manual: ManualLifecycleState = {
      v: 1, requestId: event.requestId, tenantId: event.tenantId, chatId: event.chatId,
      owner: 'restate', stage: 'manual', rev: 1, taskId: projected.taskId,
      openEventId: event.eventId, openSha256: fingerprint, ...requesterFields(event.draft),
      ...(projected.requesterHold ? {initialRequesterHold:{officeAlerts:projected.officeAlerts ?? []}} : {}),
    ...(!projected.requesterHold && projected.officeAlerts?.length ? {initialOfficeAlerts:projected.officeAlerts} : {}),
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
    openEventId: event.eventId, openSha256: fingerprint, runId, designInput, ...requesterFields(event.draft),
    ...(projected.requesterHold ? {initialRequesterHold:{officeAlerts:projected.officeAlerts ?? []}} : {}),
    ...(!projected.requesterHold && projected.officeAlerts?.length ? {initialOfficeAlerts:projected.officeAlerts} : {}),
  };
  ctx.set('lc', state);
  ctx.setChatMode?.(event.chatId, event.requestId);
  sendAutomaticAcknowledgement(ctx, state);
  ctx.startDesign(designInput);
  return { accepted: true as const, taskId: state.taskId, stage: state.stage, rev: state.rev };
}

/**
 * The only report of a finished design (ADR-155). Core is asked through outcomeReportCore: only a
 * genuine idempotency conflict is final, anything else is asked again until the invocation pauses.
 * A refusal for good is reported to every office member, and the requester is told the truth.
 */
export async function recordDesignFinished(ctx: AutomaticOpenContext, core: CoreInternal, event: DesignFinishedEvent) {
  try {
    return await applyDesignFinished(ctx, outcomeReportCore(core), event);
  } catch (error) {
    if (!(error instanceof restate.TerminalError) || !UUID.test(String(event?.requestId)) || ctx.key !== event.requestId) throw error;
    const state = await ctx.get('lc');
    // An outcome already recorded (a replay with other content) is not lost: nobody needs telling.
    if (state && 'runId' in state && state.outcome?.eventId === event.eventId) throw error;
    const draftMade = Boolean(event.report?.designId) && event.report?.status === 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW';
    await reportTerminalFailure(ctx, {
      step: `design-finished:${String(event.runId).slice(0, 80)}`, requestId: event.requestId,
      tenantId: state?.tenantId || DEFAULT_TENANT_ID, taskId: UUID.test(String(event.taskId)) ? event.taskId : undefined,
      what: `record the finished design (${String(event.report?.status).slice(0, 60)}${event.report?.designId ? `, Canva ${String(event.report.designId).slice(0, 40)}` : ''})`,
      ...(state && 'runId' in state && state.runId === event.runId ? { requester: { chatId: state.chatId, state,
        officeTold: draftMade ? OUTCOME_MESSAGES.draftMadeNotSaved : OUTCOME_MESSAGES.couldNotFinish } } : {}),
    }, error);
    throw error;
  }
}

async function applyDesignFinished(ctx: AutomaticOpenContext, core: CoreInternal, event: DesignFinishedEvent) {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId || !UUID.test(event.taskId) ||
      (event.runId !== `dr-${event.taskId}` && !new RegExp(`^dr-${event.taskId}-a[1-9][0-9]*$`).test(event.runId)) ||
      event.eventId !== `dr-finished:${event.runId}` ||
      typeof event.round !== 'number' || !Number.isInteger(event.round) || event.round < 0 ||
      !event.report || typeof event.report.status !== 'string') throw invalid('invalid design finish identity');
  const prior = await ctx.get('lc');
  // ADR-230 addendum: after a pending-change round started, the run that finished is no longer the
  // object's, but a replay of its finish still gets the same outcome (resent under the same keys).
  const pendingReplay = Boolean(prior && 'runId' in prior && prior.pendingRoundFrom === event.eventId &&
    prior.outcome?.eventId === event.eventId);
  if (!prior || !('runId' in prior) || prior.requestId !== event.requestId ||
      ((prior.taskId !== event.taskId || prior.runId !== event.runId) && !pendingReplay)) return { ignored: true as const };
  const fingerprint = hashOf(event);
  const nextRev = prior.rev + 1;
  // Replay detection: if the outcome for this event was already stored (crash after set, before send),
  // replay the fenced messages rather than projecting again. Works across all revision rounds.
  if (prior.outcome?.eventId === event.eventId) {
    if (prior.outcome.sha256 !== fingerprint) {
      throw invalid('the design outcome was already recorded with different content');
    }
    sendDesignOutcome(ctx, prior);
    // ADR-230 addendum: the round for the requester's pending changes; its workflow key makes it once.
    if (prior.pendingRoundFrom === event.eventId && prior.stage === 'designing') ctx.startDesign(prior.designInput);
    return { ignored: false as const, stage: prior.stage, rev: prior.rev };
  }

  // ADR-230: the request was withdrawn while this run was being made. Its report is kept against the
  // closed task, once; nothing goes to review, and neither the office nor the requester hears of a draft.
  if (prior.stage === 'cancelled' && prior.withdrawal) {
    if (prior.withdrawal.finishedRunEventId !== event.eventId) {
      await ctx.run(`withdrawn-outcome:${event.runId}`, () => core.post(
        `/internal/lifecycle/${encodeURIComponent(event.requestId)}/withdrawn-outcome`,
        { v: 1, eventId: event.eventId, runId: event.runId, taskId: event.taskId, report: event.report }));
      ctx.set('lc', { ...prior, withdrawal: { ...prior.withdrawal, finishedRunEventId: event.eventId } });
    }
    return { ignored: false as const, stage: prior.stage, rev: prior.rev };
  }
  if (prior.stage !== 'designing') throw invalid('request is not designing');
  const project = () => core.post<{
    v: 1; requestId: string; taskId: string; rev: number; stage: 'in_review' | 'manual' | 'awaiting_answer' | 'designing';
    status: string; revisionId?: string; message?: { text: string; parseMode: 'HTML' };
    pendingRound?: { newTaskId: string; runId: string; round: number; directive: string; updateIds: string[] };
    question?: { id: string; text: string; options: string[] };
    officeAlert?: { chatId: string; text: string };
    officeAlerts?: Array<{ chatId: string; text: string }>;
    officePhotoAlerts?: OfficePhotoAlert[];
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/design-outcome`, {
    v: 1, expectedRev: prior.rev, rev: nextRev,
    key: `${event.requestId}:${nextRev}:designFinished:${event.runId}`,
    ops: [{ kind: 'recordOutcome', taskId: event.taskId, runId: event.runId, report: event.report }],
  });
  let held = 0;
  let projected: Awaited<ReturnType<typeof project>>;
  for (;;) {
    const attempt = await ctx.run(held ? `project:${nextRev}:after-task-pause:${held}` : `project:${nextRev}`, async () => {
      try { return await project(); }
      catch (error) {
        if (/\bHTTP 409 TASK_PAUSED\b/.test(String((error as Error)?.message))) return { __hawaTaskPaused: true as const };
        throw error;
      }
    });
    if (!attempt || typeof attempt !== 'object') throw new Error('Core did not return a valid design outcome projection');
    if ('__hawaTaskPaused' in attempt) {
      if (attempt.__hawaTaskPaused !== true) throw new Error('Core did not return a valid design pause checkpoint');
      if (!ctx.sleep) throw new Error('TASK_PAUSED: the design outcome remains pending until the office resumes it');
      held++;
      await ctx.sleep(Math.min(300_000,30_000 * 2 ** Math.min(held - 1,4)));
      continue;
    }
    projected = attempt;
    break;
  }
  if (projected?.v !== 1 || projected.requestId !== event.requestId ||
      projected.taskId !== event.taskId || projected.rev !== nextRev ||
      !['in_review', 'manual', 'awaiting_answer', 'designing'].includes(projected.stage) ||
      // ADR-230 addendum: `designing` only with the round Core started for the requester's pending changes.
      ((projected.stage === 'designing') !== Boolean(projected.pendingRound)) ||
      (projected.pendingRound && (!UUID.test(projected.pendingRound.newTaskId) || projected.pendingRound.newTaskId === event.taskId ||
        projected.pendingRound.runId !== `dr-${projected.pendingRound.newTaskId}` || !Number.isInteger(projected.pendingRound.round) ||
        projected.pendingRound.round < 1 || typeof projected.pendingRound.directive !== 'string' || !projected.pendingRound.directive.trim())) ||
      (projected.stage === 'awaiting_answer' &&
        (!projected.question || !UUID.test(projected.question.id) ||
         typeof projected.question.text !== 'string' || !Array.isArray(projected.question.options)))) {
    throw new Error('Core did not return a valid design outcome projection');
  }
  const next: AutomaticLifecycleState = { ...prior, stage: projected.stage, rev: nextRev, pendingRoundFrom: undefined,
    question: projected.question ? { ...projected.question, taskId: event.taskId, rev: nextRev } : undefined,
    outcome: { eventId: event.eventId, sha256: fingerprint, status: projected.status,
      ...(projected.revisionId ? { revisionId: projected.revisionId } : {}),
      ...(projected.message ? { message: projected.message } : {}),
      ...(projected.officeAlert ? { officeAlert: projected.officeAlert } : {}),
      ...(Array.isArray(projected.officeAlerts) && projected.officeAlerts.length ? { officeAlerts: projected.officeAlerts } : {}),
      ...photoAlertsOf(projected.officePhotoAlerts),
    },
  };
  if (projected.pendingRound) {
    // ADR-230 addendum (L8): the draft finished before the requester's changes; Core started the next
    // round with them. The outcome's message tells the requester; the new run starts here.
    const round = projected.pendingRound;
    const designInput: DesignRunInput = { ...prior.designInput, rawText: round.directive,
      lifecycle: { requestId: prior.requestId, round: round.round, runId: round.runId },
      taskId: round.newTaskId, idempotencyKey: `lifecycle:${prior.requestId}:${round.newTaskId}` };
    delete designInput.redriveAttempt;
    delete designInput.startNotice;
    // ADR-233: "I'm now adding what you asked …" is said once the new round's design has started (its
    // DesignRun sends it when Core admits the run), under the key the outcome message would have used.
    const startMessage = next.outcome?.message;
    if (startMessage) designInput.startNotice = { key: `${prior.requestId}:${nextRev}:design-outcome`, chatId: prior.chatId,
      text: startMessage.text, parseMode: startMessage.parseMode };
    const outcome = next.outcome ? { ...next.outcome } : undefined;
    if (outcome) delete outcome.message;
    const folded: AutomaticLifecycleState = { ...next, outcome, taskId: round.newTaskId, runId: round.runId, round: round.round,
      designInput, pendingRoundFrom: event.eventId, officeRetry: undefined, revisionRound: undefined };
    ctx.set('lc', folded);
    sendDesignOutcome(ctx, folded);
    ctx.startDesign(designInput);
    return { ignored: false as const, stage: folded.stage, rev: folded.rev };
  }
  ctx.set('lc', next);
  sendDesignOutcome(ctx, next);
  return { ignored: false as const, stage: next.stage, rev: next.rev };
}

/** A confirmed Telegram send starts the question's office-hour reminder clock. */
export async function recordQuestionSent(ctx: QuestionSentContext, core: CoreInternal,
  event: QuestionSentEvent): Promise<{ skipped: true } | { recorded: true; sentAtMs: number }> {
  if (event?.v !== 1 || ctx.key !== event.requestId ||
      ![event.requestId, event.taskId, event.questionId].every((id) => UUID.test(id)) ||
      !Number.isInteger(event.expectedRev) || event.expectedRev < 2 ||
      event.messageKey !== `${event.requestId}:${event.expectedRev}:design-outcome` ||
      !/^[1-9][0-9]*$/.test(event.messageId) || !Number.isSafeInteger(Number(event.messageId))) {
    throw invalid('invalid confirmed question notice identity');
  }
  const prior = await ctx.get('lc');
  if (!prior || !('runId' in prior) || prior.stage !== 'awaiting_answer' ||
      prior.rev !== event.expectedRev || prior.taskId !== event.taskId ||
      prior.question?.id !== event.questionId || prior.question.taskId !== event.taskId) {
    return { skipped: true };
  }
  if (prior.question.messageId && prior.question.messageId !== event.messageId) {
    throw invalid('question notice was confirmed with a different Telegram message ID');
  }
  let sentAtMs = prior.question.sentAtMs;
  if (sentAtMs === undefined) {
    const result = await ctx.run(`question-sent:${prior.rev}`, () => core.post<{
      v: 1; requestId: string; rev: number; taskId: string; questionId: string;
      messageId: string; sentAtMs: number;
    } | { v: 1; skipped: true }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/question-sent`, event));
    if (result?.v !== 1) throw new Error('Core did not answer the question send confirmation');
    if ('skipped' in result) {
      if (result.skipped) return { skipped: true };
      throw new Error('Core returned an invalid question send confirmation');
    }
    if (result?.v !== 1 || result.requestId !== event.requestId ||
        result.rev !== event.expectedRev || result.taskId !== event.taskId ||
        result.questionId !== event.questionId || result.messageId !== event.messageId ||
        !Number.isFinite(result.sentAtMs) || result.sentAtMs <= 0) {
      throw new Error('Core did not confirm the question send mark');
    }
    sentAtMs = result.sentAtMs;
    ctx.set('lc', { ...prior, question: { ...prior.question, sentAtMs,
      messageId: event.messageId } });
  }
  if (sentAtMs === undefined) throw new Error('Confirmed question has no send timestamp');
  const now = await ctx.now();
  if (!Number.isFinite(now) || now <= 0) throw invalid('invalid reminder clock');
  for (const day of [1, 5] as const) {
    const due = nextOfficeMoment(Math.max(sentAtMs + day * REVISION_REMINDER_DELAY_MS, now));
    ctx.scheduleQuestionReminder?.(event.requestId, event.expectedRev, event.questionId,
      day, Math.max(0, due - now));
  }
  return { recorded: true, sentAtMs };
}

const OFFICE_ROLES = new Set(['approver', 'art_director', 'creative_director', 'account_lead', 'office_admin', 'administrator']);
const APPROVAL_ROLES = new Set(['approver', 'art_director', 'creative_director', 'office_admin', 'administrator']);

export async function recordNativeReview(ctx: AutomaticOpenContext, core: CoreInternal, raw: NativeReviewSubmission): Promise<NativeReviewReply> {
  const event=parseNativeReviewSubmission(raw);
  if (!event || ctx.key !== event.requestId) throw invalid('invalid native review submission');
  const prior=await ctx.get('lc'),fingerprint=hashOf(event);
  if (!prior || prior.requestId !== event.requestId) return {accepted:false,code:'WRONG_STAGE'};
  if ('nativeReview' in prior && prior.nativeReview?.eventId === event.eventId) {
    if (prior.nativeReview.sha256 !== fingerprint) throw invalid('native review action has different content');
    return prior.nativeReview.reply;
  }
  // An automatic revision (ADR-114) or the initial manual request itself at revision 1 (ADR-126).
  const initial=!reviewOwned(prior);
  if (prior.stage !== 'manual' || prior.rev !== event.expectedRev || prior.taskId !== event.taskId || (initial && prior.rev !== 1))
    return {accepted:false,code:'WRONG_STAGE'};
  const reply=await ctx.run(`native-review:${event.actionId}`,()=>core.post<NativeReviewReply>(
    `/internal/lifecycle/${encodeURIComponent(event.requestId)}/native-review`,event));
  if (!reply || reply.accepted !== true || reply.requestId !== event.requestId || reply.taskId !== event.taskId ||
      reply.actionId !== event.actionId || reply.rev !== event.expectedRev+1 || reply.stage !== 'in_review' ||
      !UUID.test(reply.revisionId) || typeof reply.qaPassed !== 'boolean') throw new Error('Core did not return a valid native review projection');
  const reviewed={eventId:event.eventId,sha256:fingerprint,status:'NEEDS_REVIEW',revisionId:reply.revisionId};
  ctx.set('lc',initial
    ? {...prior,origin:'manual',stage:'in_review',rev:reply.rev,outcome:reviewed,nativeReview:{eventId:event.eventId,sha256:fingerprint,reply}}
    : {...prior,stage:'in_review',rev:reply.rev,question:undefined,officeRevision:undefined,outcome:reviewed,
      nativeReview:{eventId:event.eventId,sha256:fingerprint,reply}});
  return reply;
}

/** A request-owned office action (revision-request or proof-bound approval) at any revision round. */
export async function recordOfficeRevision(ctx: AutomaticOpenContext, core: CoreInternal, event: OfficeRevisionEvent): Promise<OfficeRevisionReply> {
  if (event?.v !== 1 || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      !UUID.test(event.taskId) || !UUID.test(event.revisionId) || !UUID.test(event.actionId) ||
      event.eventId !== `desk:${event.actionId}` || !['revise', 'approve', 'reject'].includes(event.kind) ||
      !Number.isInteger(event.expectedRev) || event.expectedRev < 2 ||
      !event.actor || !UUID.test(event.actor.userId) ||
      !(event.kind === 'approve' || event.kind === 'reject' ? APPROVAL_ROLES : OFFICE_ROLES).has(event.actor.role) || typeof event.reason !== 'string' ||
      !event.reason.trim() || event.reason.length > 2000 ||
      (event.revisionRequest !== undefined &&
        (!parseCompleteRevisionRequest(event.revisionRequest) ||
          event.revisionRequest.comment.trim() !== event.reason.trim())) ||
      (event.kind === 'approve' && (!parseOfficeApprovalProof(event.approvalProof) ||
        !/^[a-f0-9]{64}$/.test(event.deskRequestFingerprint || '') || event.revisionRequest !== undefined)) ||
      (event.kind === 'revise' && (event.approvalProof !== undefined || event.deskRequestFingerprint !== undefined || event.rejectionCategory !== undefined)) ||
      (event.kind === 'reject' && (!parseRejectionCategory(event.rejectionCategory) ||
        event.approvalProof !== undefined || event.deskRequestFingerprint !== undefined || event.revisionRequest !== undefined)) ||
      (event.kind === 'approve' && event.rejectionCategory !== undefined)) {
    throw invalid('invalid office revision identity, reviewer or audit reason');
  }
  const fingerprint = hashOf(event);
  const prior = await ctx.get('lc');
  if (!prior || !reviewOwned(prior)) return { accepted: false, code: 'WRONG_STAGE' };
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
      approvalId: prior.officeRevision.approvalId, stage: prior.stage as 'manual' | 'approved' | 'rejected', rev: nextRev };
  }
  if (prior.rev !== expectedRev || prior.stage !== 'in_review') return { accepted: false, code: 'WRONG_STAGE' };
  // ADR-126: a manual stage after revise would route the requester's reply into a new design run.
  if (event.kind === 'revise' && !('runId' in prior)) return { accepted: false, code: 'WRONG_STAGE' };
  if (prior.taskId !== event.taskId || prior.outcome?.revisionId !== event.revisionId) {
    return { accepted: false, code: 'NOT_CURRENT_DRAFT' };
  }
  const projected = await ctx.run(`project:${nextRev}`, () => core.post<{
    v: 1; requestId: string; taskId: string; revisionId: string; actionId: string;
    approvalId: string; taskState: string; rev: number; stage: 'manual' | 'approved' | 'rejected';
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/office-decision`, {
    v: 1, expectedRev, rev: nextRev,
    key: `${event.requestId}:${nextRev}:officeDecision:${event.eventId}`,
    ops: [{ kind: event.kind === 'approve' ? 'recordOfficeApproval' : event.kind === 'reject' ? 'recordOfficeRejection' : 'recordOfficeRevision', taskId: event.taskId, revisionId: event.revisionId,
      actionId: event.actionId, actor: event.actor, reason: event.reason.trim(),
      ...(event.rejectionCategory ? { rejectionCategory: event.rejectionCategory } : {}),
      ...(event.revisionRequest ? { revisionRequest: parseCompleteRevisionRequest(event.revisionRequest) } : {}),
      ...(event.approvalProof ? { approvalProof: parseOfficeApprovalProof(event.approvalProof),
        deskRequestFingerprint: event.deskRequestFingerprint } : {}) }],
  }));
  const expectedStage = event.kind === 'approve' ? 'approved' : event.kind === 'reject' ? 'rejected' : 'manual';
  const expectedTaskState = event.kind === 'approve' ? 'approved' : event.kind === 'reject' ? 'rejected' : 'revision_requested';
  if (projected?.v !== 1 || projected.requestId !== event.requestId || projected.taskId !== event.taskId ||
      projected.revisionId !== event.revisionId || projected.actionId !== event.actionId ||
      !UUID.test(projected.approvalId) || projected.taskState !== expectedTaskState ||
      projected.rev !== nextRev || projected.stage !== expectedStage) {
    throw new Error('Core did not return a valid office revision projection');
  }
  const officeRevision = { eventId: event.eventId, sha256: fingerprint,
    actionId: event.actionId, revisionId: event.revisionId, approvalId: projected.approvalId, kind: event.kind };
  const next: ReviewOwnedState = 'runId' in prior ? { ...prior, stage: expectedStage, rev: nextRev, officeRevision }
    : { ...prior, stage: expectedStage as 'approved' | 'rejected', rev: nextRev, officeRevision };
  ctx.set('lc', next);
  if (event.kind === 'revise') sendOfficeRevisionNotice(ctx, next, event);
  return { accepted: true, requestId: event.requestId, taskId: event.taskId, revisionId: event.revisionId,
    actionId: event.actionId, approvalId: projected.approvalId, stage: expectedStage, rev: nextRev };
}

function sendOfficeRevisionNotice(ctx: AutomaticOpenContext,
  state: Pick<ReviewOwnedState, 'requestId' | 'rev' | 'chatId' | 'tenantId' | 'taskId' | 'lang' | 'title'> & { designInput?: { rawText?: string } },
  event: OfficeRevisionEvent): void {
  const comment = event.revisionRequest?.comment?.trim() || event.reason.trim();
  // #11 (ADR-145): the office's note in its own words, with no round number and no reply target.
  ctx.send({ v: 1, key: `${state.requestId}:${state.rev}:office-revision-notify`,
    chatId: state.chatId, kind: 'text',
    text: requesterText(state, LIFECYCLE_MESSAGES.officeNote, { comment: escapeTelegramHtml(comment) }), parseMode: 'HTML',
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
      text: requesterText(state, LIFECYCLE_MESSAGES.questionReminder, {
        question: `<b>${escapeTelegramHtml(state.question.text)}</b>`,
        options: state.question.options.map((option, i) => `${i + 1}. ${escapeTelegramHtml(option)}`).join('\n'),
      }), parseMode: 'HTML',
      class: 'critical', tenantId: state.tenantId, taskId: state.taskId });
    return { reminded: true };
  }
  if (!state || !('runId' in state) || state.rev !== event.expectedRev || state.stage !== 'manual') {
    return { skipped: true };
  }
  ctx.send({ v: 1, key: `${state.requestId}:${event.expectedRev}:revision-reminder`,
    chatId: state.chatId, kind: 'text',
    text: requesterText(state, LIFECYCLE_MESSAGES.changesReminder), parseMode: 'HTML',
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
  if (!prior || !reviewOwned(prior)) return { accepted: false, code: 'WRONG_STAGE' };
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
  const next: ReviewOwnedState = { ...prior, stage: 'delivering', rev: nextRev,
    delivery: { startEventId: event.eventId, startSha256: sha256, actionId: event.actionId,
      input: projected.delivery } };
  ctx.set('lc', next);
  ctx.startDelivery(projected.delivery);
  return { accepted: true, requestId: event.requestId, taskId: event.taskId,
    approvalId: event.approvalId, actionId: event.actionId,
    deliveryId: projected.delivery.deliveryId, stage: 'delivering', rev: nextRev };
}

/**
 * The workflow reports only to its private request owner; Core applies a versioned final projection.
 * It is the only report of the delivery (ADR-155): asked through outcomeReportCore, and a refusal for
 * good is reported to every office member (the requester already has the files, or the office's word).
 */
export async function recordDeliveryFinished(ctx: AutomaticOpenContext, core: CoreInternal,
  event: DeliveryFinishedEvent): Promise<DeliveryFinishedReply> {
  try {
    return await applyDeliveryFinished(ctx, outcomeReportCore(core), event);
  } catch (error) {
    if (!(error instanceof restate.TerminalError) || !UUID.test(String(event?.requestId)) || ctx.key !== event.requestId) throw error;
    const state = await ctx.get('lc');
    // A result already recorded (a replay with other content) is not lost: nobody needs telling.
    if (state && reviewOwned(state) && state.delivery?.finishEventId === event.eventId) throw error;
    await reportTerminalFailure(ctx, {
      step: `delivery-finished:${String(event.deliveryId).slice(0, 120)}`, requestId: event.requestId,
      tenantId: state?.tenantId || DEFAULT_TENANT_ID, taskId: UUID.test(String(event.taskId)) ? event.taskId : undefined,
      what: `record how the delivery ended (${String(event.outcome?.outcome).slice(0, 20)})`,
    }, error);
    throw error;
  }
}

async function applyDeliveryFinished(ctx: AutomaticOpenContext, core: CoreInternal,
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
  if (!prior || !reviewOwned(prior) || !prior.delivery) throw invalid('this request has no delivery to finish');
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
  const next: ReviewOwnedState = { ...prior, stage: projected.stage, rev: nextRev,
    delivery: { ...prior.delivery, finishEventId: event.eventId, finishSha256: sha256,
      finishResult: reply } };
  ctx.set('lc', next);
  return reply;
}

/**
 * ADR-142: the office runs the current task's automatic design again, after it ended without a draft
 * (the request is manual, its outcome had no draft and no question, and the office has not sent a
 * draft back for changes). Core records the retry, moves the task back to received and names the
 * attempt run; the same task is designed again under `dr-<taskId>-a<n>`. Nothing is sent to the
 * requester: they were told the office is on it, and they hear the outcome as they would the first.
 */
export async function recordOfficeRetry(ctx: AutomaticOpenContext, core: CoreInternal, event: OfficeRetryEvent): Promise<OfficeRetryReply> {
  if (event?.v !== 1 || event.kind !== 'retry' || ctx.key !== event.requestId || !UUID.test(event.requestId) ||
      !UUID.test(event.taskId) || !UUID.test(event.actionId) || event.eventId !== `desk:${event.actionId}` ||
      !Number.isInteger(event.expectedRev) || event.expectedRev < 2 ||
      !event.actor || !UUID.test(event.actor.userId) || !OFFICE_RETRY_ROLES.has(event.actor.role) ||
      typeof event.reason !== 'string' || !event.reason.trim() || event.reason.length > 2000) {
    throw invalid('invalid office retry identity, actor or reason');
  }
  const sha256 = hashOf(event);
  const prior = await ctx.get('lc');
  if (!prior || !('runId' in prior)) return { accepted: false, code: 'WRONG_STAGE' };
  if (prior.officeRetry?.eventId === event.eventId) {
    if (prior.officeRetry.sha256 !== sha256) throw invalid('this office retry was recorded with different content');
    // A worker can stop after saving state and before the run started; the workflow key makes it once.
    if (prior.stage === 'designing' && prior.runId === prior.officeRetry.runId) ctx.startDesign(prior.designInput);
    return { accepted: true, requestId: prior.requestId, taskId: event.taskId, actionId: event.actionId,
      runId: prior.officeRetry.runId, attempt: prior.officeRetry.attempt, stage: 'designing', rev: prior.officeRetry.rev,
      ...(prior.officeRetry.freshTaskId ? { freshTaskId: prior.officeRetry.freshTaskId } : {}) };
  }
  if (prior.stage !== 'manual' || prior.rev !== event.expectedRev || prior.officeRevision || prior.question ||
      !prior.outcome || prior.outcome.revisionId) return { accepted: false, code: 'WRONG_STAGE' };
  if (prior.taskId !== event.taskId) return { accepted: false, code: 'NOT_CURRENT_DRAFT' };
  const nextRev = prior.rev + 1;
  const projected = await ctx.run(`project:${nextRev}`, () => core.post<{
    v: 1; requestId: string; taskId: string; actionId: string; rev: number; stage: 'designing';
    runId: string; attempt: number; taskState: string; freshTaskId?: string;
  }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/office-retry`, {
    v: 1, expectedRev: prior.rev, rev: nextRev,
    key: `${event.requestId}:${nextRev}:officeRetry:${event.eventId}`,
    ops: [{ kind: 'retryDesign', taskId: event.taskId, actionId: event.actionId,
      actor: { userId: event.actor.userId, role: event.actor.role }, reason: event.reason.trim() }],
  }));
  if (projected?.v !== 1 || projected.requestId !== event.requestId || projected.taskId !== event.taskId ||
      projected.actionId !== event.actionId || projected.rev !== nextRev || projected.stage !== 'designing' ||
      !Number.isInteger(projected.attempt) || projected.attempt < 1 ||
      (projected.freshTaskId === undefined
        ? projected.runId !== `dr-${event.taskId}-a${projected.attempt}`
        : !UUID.test(projected.freshTaskId) || projected.freshTaskId === event.taskId || projected.runId !== `dr-${projected.freshTaskId}`)) {
    throw new Error('Core did not return a valid office retry projection');
  }
  // ADR-233: a redo or pending-changes round refused as a native revision is retried as a fresh successor
  // task, designed under its own first run (`dr-<task>`); any other task is designed again as it is.
  const fresh = projected.freshTaskId;
  const designInput: DesignRunInput = fresh
    ? { ...prior.designInput, taskId: fresh, idempotencyKey: `lifecycle:${prior.requestId}:${fresh}`,
      lifecycle: { ...prior.designInput.lifecycle, runId: projected.runId } }
    : { ...prior.designInput, lifecycle: { ...prior.designInput.lifecycle, runId: projected.runId }, redriveAttempt: projected.attempt };
  if (fresh) delete designInput.redriveAttempt;
  // ADR-142: the retry tells the requester nothing; a round's start notice is not said again.
  delete designInput.startNotice;
  const next: AutomaticLifecycleState = { ...prior, stage: 'designing', rev: nextRev, runId: projected.runId, designInput,
    ...(fresh ? { taskId: fresh } : {}),
    outcome: undefined, question: undefined,
    officeRetry: { eventId: event.eventId, sha256, actionId: event.actionId, attempt: projected.attempt,
      runId: projected.runId, rev: nextRev, ...(fresh ? { freshTaskId: fresh } : {}) } };
  ctx.set('lc', next);
  ctx.startDesign(designInput);
  return { accepted: true, requestId: event.requestId, taskId: event.taskId, actionId: event.actionId,
    runId: projected.runId, attempt: projected.attempt, stage: 'designing', rev: nextRev, ...(fresh ? { freshTaskId: fresh } : {}) };
}

function sendDesignOutcome(ctx: AutomaticOpenContext, state: AutomaticLifecycleState): void {
  const message = state.outcome?.message;
  // Key is scoped to rev so a retried send after a revision round uses the correct idempotency key.
  if (message) ctx.send({ v: 1, key: `${state.requestId}:${state.rev}:design-outcome`, chatId: state.chatId,
    kind: 'text', text: message.text, parseMode: message.parseMode, class: 'critical',
    tenantId: state.tenantId, taskId: state.taskId,
    ...(state.stage === 'awaiting_answer' && state.question ? { onSent: {
      kind: 'question' as const, requestId: state.requestId, requestRev: state.rev,
      taskId: state.taskId, questionId: state.question.id,
    } } : {}),
  });
  // ADR-155: every office member hears it; a receipt from before names only the first (officeAlert).
  const alerts = state.outcome?.officeAlerts ?? (state.outcome?.officeAlert ? [state.outcome.officeAlert] : []);
  // ADR-155 addendum: a draft's alert goes as a photo of it, under the same key as its text, so each
  // member hears of each revision once, whichever build sends it. Only office members get the picture;
  // a requester who is not one gets their message alone (the draft reaches them on approval, ADR-022).
  const photos = new Map((state.outcome?.officePhotoAlerts ?? []).map((photo) => [photo.chatId, photo]));
  for (const [index, alert] of alerts.entries()) {
    const photo = photos.get(alert.chatId);
    const key = officeAlertKey(`${state.requestId}:${state.rev}:office-alert`, index, alert.chatId);
    // ADR-240: a canary request's draft alert is recorded in the canary chat, never shown to the office.
    const to = officeAlertRoute(alert.chatId, state.chatId);
    ctx.send(photo
      ? { v: 1, key, ...to, kind: 'photo', imageRef: photo.image, caption: photo.text, text: alert.text,
        class: 'critical', tenantId: state.tenantId, taskId: state.taskId }
      : { v: 1, key, ...to, kind: 'text', text: alert.text, class: 'critical', tenantId: state.tenantId, taskId: state.taskId });
  }
}

/** An office draft alert as Core gives it (ADR-155 addendum); the picture is read by the sender. */
export interface OfficePhotoAlert { chatId: string; text: string; image: DraftImageRef }

/** Core's photo alerts, kept only when each names a chat, its words and a picture by hash. */
function photoAlertsOf(value: unknown): { officePhotoAlerts?: OfficePhotoAlert[] } {
  if (!Array.isArray(value)) return {};
  const valid = value.filter((a): a is OfficePhotoAlert => typeof a?.chatId === 'string' && typeof a.text === 'string' &&
    (a.image?.source === 'canva_export' || a.image?.source === 'studio_preview') &&
    [a.image.tenantId, a.image.taskId, a.image.id].every((id: unknown) => typeof id === 'string' && UUID.test(id)) &&
    typeof a.image.sha256 === 'string' && /^[0-9a-f]{64}$/.test(a.image.sha256))
    .map((a) => ({ chatId: a.chatId, text: a.text, image: { source: a.image.source, tenantId: a.image.tenantId,
      taskId: a.image.taskId, id: a.image.id, sha256: a.image.sha256 } }));
  return valid.length ? { officePhotoAlerts: valid } : {};
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
  if (event.startNotice !== undefined && !validStartNotice(event.startNotice, prior.chatId)) {
    throw invalid('the requester decision carries an invalid start notice');
  }
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
  // ADR-200 addendum: redo words about a design delivered recently ("do a better design") reopen it
  // for a new round. Core admitted that round from the requester's own Telegram update (its receipt is
  // checked below), only for a request with a design run, so a delivered request takes it the same way.
  const reopening = prior.stage === 'delivered' && !event.questionId && /^chatinbox:revision:[1-9][0-9]*$/.test(event.eventId);
  if (prior.stage !== (event.questionId ? 'awaiting_answer' : 'manual') && !reopening) {
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
  const projected = await reportedIfRefused(ctx, () => ctx.run(`project:${nextRev}`, () => core.post<{
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
          round: event.round, directive: event.directive.trim() }] })), {
    // ADR-155: the requester's change, refused for good, is not lost: the office has their words.
    step: `requester-decision:${nextRev}`, requestId: event.requestId, tenantId: prior.tenantId, taskId: prior.taskId,
    what: `start the requester's change (round ${event.round})`, words: event.directive,
    requester: { chatId: prior.chatId, state: prior, officeTold: INBOX_MESSAGES.changeToOfficeToFinish, alone: INBOX_MESSAGES.changeNotStarted },
  });
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
  // ADR-233: the round's own start notice, sent by its DesignRun once Core admits it; never an earlier round's.
  delete newDesignInput.startNotice;
  delete newDesignInput.redriveAttempt;
  if (event.startNotice) newDesignInput.startNotice = event.startNotice;
  const next: AutomaticLifecycleState = { ...prior, stage: 'designing', rev: nextRev,
    taskId: newTaskId, runId: newRunId, round: event.round, designInput: newDesignInput,
    revisionRound: { eventId: event.eventId, sha256: fingerprint, round: event.round,
      newTaskId, runId: newRunId },
    // Clear prior-round transient fields so the next design-outcome projects cleanly; a reopened
    // design's finished delivery belongs to the round before (its next approval delivers anew).
    outcome: undefined, officeRevision: undefined, question: undefined, delivery: undefined,
  };
  ctx.set('lc', next);
  ctx.startDesign(newDesignInput);
  return { accepted: true, requestId: prior.requestId, newTaskId, runId: newRunId,
    round: event.round, rev: nextRev, stage: 'designing' };
}

/**
 * ADR-230: the request is withdrawn, by its requester (a cancel Core's intake recorded for that Telegram
 * update: `chatinbox:withdraw:<update>`) or by the office (the Desk's Cancel, signed through the office
 * gateway: `desk:<action>`). Core closes the request and its task under one receipt; this object then
 * says so to the requester and, for a requester's cancel, to the office. A cancel that came too late (the
 * design was approved or sent) changes nothing: Core keeps it for the office and words the truthful
 * answer, which is sent here. A design run still being made is not stopped; its finish is recorded and
 * goes nowhere (applyDesignFinished).
 */
export interface WithdrawEvent {
  v: 1; kind: 'withdraw'; eventId: string; requestId: string;
  /** The requester's Telegram update (requester's cancel only). */
  updateId?: number;
  /** The office's Cancel only: the request revision and task it saw, who pressed it, and why. */
  taskId?: string; actionId?: string; expectedRev?: number; actor?: { userId: string; role: string }; reason?: string;
}

export type WithdrawReply =
  | { accepted: true; requestId: string; taskId: string; stage: 'cancelled'; rev: number; fromStage: string }
  | { accepted: false; code: 'WRONG_STAGE' | 'NOT_CURRENT_DRAFT' | 'TOO_LATE' | 'STALE_REVISION'; stage?: string };

/** Office roles that may cancel a request (Core's OFFICE_WITHDRAW_ROLES; the gateway admits the same). */
export const OFFICE_WITHDRAW_ROLES = new Set(['operator', 'administrator', 'art_director', 'creative_director', 'designer', 'office_admin']);

type WithdrawProjected = { v: 1; withdrawn: boolean; requestId: string; taskId: string; rev: number; stage: string;
  fromStage?: string; requesterNotice?: { chatId: string; text: string }; officeAlerts?: Array<{ chatId: string; text: string }> };

function sendWithdrawNotices(ctx: Pick<AutomaticOpenContext, 'send'>, state: Pick<ManualLifecycleState, 'requestId' | 'chatId' | 'tenantId' | 'taskId'>,
  base: string, notices: Pick<Withdrawal, 'requesterNotice' | 'officeAlerts'>): void {
  const about = { tenantId: state.tenantId, taskId: state.taskId };
  if (notices.requesterNotice) {
    ctx.send({ v: 1, key: `${base}:requester`, chatId: notices.requesterNotice.chatId, kind: 'text',
      text: notices.requesterNotice.text, parseMode: 'HTML', class: 'critical', ...about });
  }
  for (const [index, alert] of notices.officeAlerts.entries()) {
    ctx.send({ v: 1, key: officeAlertKey(`${base}:office`, index, alert.chatId), ...officeAlertRoute(alert.chatId, state.chatId),
      kind: 'text', text: alert.text, class: 'critical', ...about });
  }
}

export async function recordWithdraw(ctx: AutomaticOpenContext, core: CoreInternal, event: WithdrawEvent): Promise<WithdrawReply> {
  const requesterUpdate = /^chatinbox:withdraw:([1-9][0-9]{0,17})$/.exec(String(event?.eventId));
  const office = /^desk:([0-9a-f-]{36})$/i.exec(String(event?.eventId));
  if (event?.v !== 1 || event.kind !== 'withdraw' || !UUID.test(event.requestId) || ctx.key !== event.requestId ||
      (!requesterUpdate && !office) ||
      (requesterUpdate && (event.updateId !== Number(requesterUpdate[1]) || event.actor !== undefined || event.expectedRev !== undefined)) ||
      (office && (event.actionId !== office[1] || !UUID.test(event.taskId || '') || !Number.isInteger(event.expectedRev) ||
        Number(event.expectedRev) < 1 || !UUID.test(event.actor?.userId || '') || !OFFICE_WITHDRAW_ROLES.has(event.actor?.role || '') ||
        typeof event.reason !== 'string' || !event.reason.trim() || event.reason.length > 2000))) {
    throw invalid('invalid withdraw identity, actor or reason');
  }
  const sha256 = hashOf(event);
  const prior = await ctx.get('lc');
  if (!prior || prior.requestId !== event.requestId) return { accepted: false, code: 'WRONG_STAGE' };
  if (prior.withdrawal?.eventId === event.eventId) {
    if (prior.withdrawal.sha256 !== sha256) throw invalid('this withdraw was recorded with different content');
    // A worker can stop after saving state and before the notices; the same keys send them once.
    sendWithdrawNotices(ctx, prior, `${prior.requestId}:${prior.withdrawal.rev}:withdrawn`, prior.withdrawal);
    return { accepted: true, requestId: prior.requestId, taskId: prior.taskId, stage: 'cancelled', rev: prior.withdrawal.rev,
      fromStage: prior.withdrawal.fromStage };
  }
  if (prior.stage === 'cancelled' && office) return { accepted: false, code: 'WRONG_STAGE', stage: prior.stage };
  if (office && prior.rev !== event.expectedRev) return { accepted: false, code: 'STALE_REVISION', stage: prior.stage };
  if (office && prior.taskId !== event.taskId) return { accepted: false, code: 'NOT_CURRENT_DRAFT', stage: prior.stage };
  const nextRev = prior.rev + 1;
  const key = `${event.requestId}:${nextRev}:withdraw:${event.eventId}`;
  // Core's refusal of a stale or moved request is an answer, not a failure: it is journaled as one.
  const projected = await ctx.run(`withdraw:${nextRev}`, async () => {
    try {
      return await core.post<WithdrawProjected>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/withdraw`, {
        v: 1, expectedRev: prior.rev, rev: nextRev, key,
        ops: [{ kind: 'withdraw', taskId: prior.taskId, eventId: event.eventId,
          actor: requesterUpdate ? { kind: 'requester', updateId: Number(requesterUpdate[1]) }
            : { kind: 'office', userId: event.actor!.userId, role: event.actor!.role },
          reason: requesterUpdate ? '' : event.reason!.trim() }],
      });
    } catch (error) {
      const refused = /\bHTTP 409 (STALE_REVISION|WRONG_STAGE|NOT_CURRENT_DRAFT|NOT_WITHDRAWABLE)\b/.exec(String((error as Error)?.message));
      if (error instanceof restate.TerminalError && refused) return { __hawaRefused: refused[1] };
      throw error;
    }
  });
  if (projected && '__hawaRefused' in projected) {
    const code = projected.__hawaRefused === 'NOT_WITHDRAWABLE' ? 'TOO_LATE' : projected.__hawaRefused === 'NOT_CURRENT_DRAFT'
      ? 'NOT_CURRENT_DRAFT' : projected.__hawaRefused === 'STALE_REVISION' ? 'STALE_REVISION' : 'WRONG_STAGE';
    if (requesterUpdate) log.warn(`[RequestLifecycle] the requester's cancel ${event.eventId} of ${event.requestId} was refused: ${projected.__hawaRefused}`);
    return { accepted: false, code, stage: prior.stage };
  }
  if (projected?.v !== 1 || projected.requestId !== event.requestId || projected.taskId !== prior.taskId ||
      (projected.withdrawn && (projected.stage !== 'cancelled' || projected.rev !== nextRev)) ||
      (!projected.withdrawn && (projected.rev !== prior.rev || !requesterUpdate))) {
    throw new Error('Core did not return a valid withdraw projection');
  }
  const notices = { ...(projected.requesterNotice ? { requesterNotice: projected.requesterNotice } : {}),
    officeAlerts: Array.isArray(projected.officeAlerts) ? projected.officeAlerts : [] };
  if (!projected.withdrawn) {
    // Too late (approved, being sent, sent) or already closed: the request is unchanged. Core kept the
    // cancel for the office and gave the words; they are sent under this update's keys.
    sendWithdrawNotices(ctx, prior, `${prior.requestId}:withdraw-refused:${event.eventId}`, notices);
    return { accepted: false, code: projected.stage === 'cancelled' ? 'WRONG_STAGE' : 'TOO_LATE', stage: projected.stage };
  }
  const withdrawal: Withdrawal = { eventId: event.eventId, sha256, actor: requesterUpdate ? 'requester' : 'office', rev: nextRev,
    fromStage: projected.fromStage ?? prior.stage, ...notices };
  // The design run's identity stays, so its finish is recognised and recorded (applyDesignFinished).
  ctx.set('lc', { ...prior, stage: 'cancelled', rev: nextRev, withdrawal,
    ...('runId' in prior ? { question: undefined } : {}) } as LifecycleState);
  sendWithdrawNotices(ctx, prior, `${prior.requestId}:${nextRev}:withdrawn`, withdrawal);
  return { accepted: true, requestId: prior.requestId, taskId: prior.taskId, stage: 'cancelled', rev: nextRev, fromStage: withdrawal.fromStage };
}

/**
 * ADR-230 repair: a request whose delivery finished chat-only before such a delivery closed its request
 * (production request 95eeb08d, 2026-10-01) is in `delivering` with its finish recorded. Core reads the
 * report it stored and its own Telegram send marks again, and delivers it when they show every file and
 * the notice sent; otherwise nothing changes. Reached only through the signed office gateway.
 */
export interface DeliveryReconcileEvent { v: 1; kind: 'reconcile-delivery'; requestId: string }

export type DeliveryReconcileReply =
  | { accepted: true; requestId: string; taskId: string; deliveryId: string; stage: 'delivered'; rev: number; replayed: boolean }
  | { accepted: false; code: string; stage?: string };

export async function reconcileDelivery(ctx: AutomaticOpenContext, core: CoreInternal, event: DeliveryReconcileEvent): Promise<DeliveryReconcileReply> {
  if (event?.v !== 1 || event.kind !== 'reconcile-delivery' || !UUID.test(event.requestId) || ctx.key !== event.requestId) {
    throw invalid('invalid delivery repair');
  }
  const prior = await ctx.get('lc');
  if (!prior || !reviewOwned(prior) || !prior.delivery?.finishResult) return { accepted: false, code: 'NO_FINISHED_DELIVERY', stage: prior?.stage };
  const delivery = prior.delivery;
  const eventId = `reconcile:${delivery.input.deliveryId}`;
  if (delivery.reconciledEventId === eventId && prior.stage === 'delivered') {
    return { accepted: true, requestId: prior.requestId, taskId: prior.taskId, deliveryId: delivery.input.deliveryId,
      stage: 'delivered', rev: delivery.finishResult!.rev, replayed: true };
  }
  if (prior.stage !== 'delivering' || delivery.finishResult!.stage !== 'delivering') return { accepted: false, code: 'WRONG_STAGE', stage: prior.stage };
  const nextRev = prior.rev + 1;
  const projected = await ctx.run(`reconcile:${nextRev}`, async () => {
    try {
      return await core.post<{ v: 1; requestId: string; taskId: string; approvalId: string; deliveryId: string;
        stage: 'delivered'; taskState: string; rev: number }>(`/internal/lifecycle/${encodeURIComponent(event.requestId)}/delivery-reconcile`, {
        v: 1, expectedRev: prior.rev, rev: nextRev, key: `${event.requestId}:${nextRev}:deliveryReconciled:${delivery.input.deliveryId}`,
        ops: [{ kind: 'reconcileDelivery', taskId: prior.taskId, approvalId: delivery.input.approvalId,
          deliveryId: delivery.input.deliveryId, run: Number(delivery.input.run || 1) }],
      });
    } catch (error) {
      const refused = /\bHTTP 409 ([A-Z_]+)\b/.exec(String((error as Error)?.message));
      if (error instanceof restate.TerminalError && refused && refused[1] !== 'IDEMPOTENCY_CONFLICT') return { __hawaRefused: refused[1] };
      throw error;
    }
  });
  if (projected && '__hawaRefused' in projected) return { accepted: false, code: projected.__hawaRefused, stage: prior.stage };
  if (projected?.v !== 1 || projected.requestId !== event.requestId || projected.taskId !== prior.taskId ||
      projected.deliveryId !== delivery.input.deliveryId || projected.stage !== 'delivered' || projected.rev !== nextRev) {
    throw new Error('Core did not return a valid delivery repair');
  }
  const finishResult: DeliveryFinishedReply = { ...delivery.finishResult!, stage: 'delivered', taskState: projected.taskState, rev: nextRev };
  ctx.set('lc', { ...prior, stage: 'delivered', rev: nextRev, delivery: { ...delivery, finishResult, reconciledEventId: eventId } });
  return { accepted: true, requestId: prior.requestId, taskId: prior.taskId, deliveryId: delivery.input.deliveryId,
    stage: 'delivered', rev: nextRev, replayed: false };
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
              get: (name) => ctx.get<LifecycleState>(name),
              run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
              set: (name, value) => ctx.set(name, value),
              send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
                .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
              startDesign: (input) => ctx.workflowSendClient(DesignRunApi, input.lifecycle.runId).run(input),
              setChatMode: (chatId, requestId) => { if(chatId.startsWith('web:')) return; return ctx.objectSendClient(chatInbox, chatId)
                .setMode(requestId, restate.rpc.sendOpts({ idempotencyKey: `chatinbox:setMode:${requestId}` })); },
            }, core, event as OpenAutomaticEvent) : openManualRequest({
              key: ctx.key,
              get: (name) => ctx.get<ManualLifecycleState>(name),
              run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
              set: (name, value) => ctx.set(name, value),
              send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
                .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
              setChatMode: (chatId, requestId) => { if(chatId.startsWith('web:')) return; return ctx.objectSendClient(chatInbox, chatId)
                .setMode(requestId, restate.rpc.sendOpts({ idempotencyKey: `chatinbox:setMode:${requestId}` })); },
            }, core, event as OpenManualEvent)),
      ),
      designFinished: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: DesignFinishedEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, () => recordDesignFinished({
            key: ctx.key,
            get: (name) => ctx.get<LifecycleState>(name),
            run: (name, action) => ctx.run(name, action, OUTCOME_RETRY),
            sleep: millis => ctx.sleep(millis),
            set: (name, value) => ctx.set(name, value),
            send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
              .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
            // ADR-230 addendum: only the round Core started for the requester's pending changes.
            startDesign: (input) => ctx.workflowSendClient(DesignRunApi, input.lifecycle.runId).run(input),
          }, core, event)),
      ),
      questionSent: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: QuestionSentEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, () => recordQuestionSent({
            key: ctx.key,
            get: (name) => ctx.get<LifecycleState>(name),
            run: (name, action) => ctx.run(name, action, OUTCOME_RETRY),
            set: (name, value) => ctx.set(name, value),
            now: () => ctx.date.now(),
            scheduleQuestionReminder: (requestId, rev, questionId, day, delayMs) =>
              ctx.objectSendClient(RequestLifecycleApi, requestId)
                .reminderTick({ v: 1, requestId, expectedRev: rev, kind: 'question', questionId, day },
                  restate.rpc.sendOpts({
                    idempotencyKey: `lifecycle:question-reminder:${requestId}:${rev}:${day}`,
                    delay: delayMs,
                  })),
          }, core, event)),
      ),
      nativeReview: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext,event: NativeReviewSubmission)=>withInvocationLogContext(ctx,{requestId:event?.requestId},()=>recordNativeReview({
          key:ctx.key,get:name=>ctx.get<LifecycleState>(name),
          run:(name,action)=>ctx.run(name,action,PROJECT_RETRY),set:(name,value)=>ctx.set(name,value),
          send:()=>{throw new Error('nativeReview does not send unverified notices');},
          startDesign:()=>{throw new Error('nativeReview cannot start generation');},
        },core,event)),
      ),
      officeDecision: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: OfficeRevisionEvent | OfficeDeliveryStartEvent) =>
          withInvocationLogContext<OfficeDeliveryStartReply | OfficeRevisionReply>(ctx, { requestId: event?.requestId }, () => {
            const handlers: AutomaticOpenContext = {
            key: ctx.key,
            get: (name) => ctx.get<LifecycleState>(name),
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
      /** ADR-142: reached only through the signed office gateway (OfficeDecisionGateway.retryDesign). */
      officeRetry: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: OfficeRetryEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, () => recordOfficeRetry({
            key: ctx.key,
            get: (name) => ctx.get<LifecycleState>(name),
            run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
            set: (name, value) => ctx.set(name, value),
            send: () => { throw new Error('officeRetry does not message the requester'); },
            startDesign: (input) => ctx.workflowSendClient(DesignRunApi, input.lifecycle.runId).run(input),
          }, core, event)),
      ),
      requesterDecision: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: RequesterDecisionEvent & { newTaskId: string }) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, () => recordRequesterDecision({
            key: ctx.key,
            get: (name) => ctx.get<LifecycleState>(name),
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
            get: (name) => ctx.get<LifecycleState>(name),
            run: (name, action) => ctx.run(name, action, OUTCOME_RETRY),
            set: (name, value) => ctx.set(name, value),
            // Only a refusal for good sends anything here: the office's alert (ADR-155).
            send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
              .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
            startDesign: () => { throw new Error('deliveryFinished cannot start a design run'); },
          }, core, event)),
      ),
      /** ADR-230: from ChatInbox (a requester's cancel) or OfficeDecisionGateway.withdraw (the Desk's Cancel). */
      withdraw: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: WithdrawEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, () => recordWithdraw({
            key: ctx.key,
            get: (name) => ctx.get<LifecycleState>(name),
            run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
            set: (name, value) => ctx.set(name, value),
            send: (message) => ctx.objectSendClient(TelegramSenderApi, message.chatId)
              .send(message, restate.rpc.sendOpts({ idempotencyKey: message.key })),
            startDesign: () => { throw new Error('withdraw cannot start a design run'); },
          }, core, event)),
      ),
      /** ADR-230 repair: reached only through OfficeDecisionGateway.reconcileDelivery (scripts/repair_chat_only_delivery.ts). */
      reconcileDelivery: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 7 }, journalRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, event: DeliveryReconcileEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, () => reconcileDelivery({
            key: ctx.key,
            get: (name) => ctx.get<LifecycleState>(name),
            run: (name, action) => ctx.run(name, action, PROJECT_RETRY),
            set: (name, value) => ctx.set(name, value),
            send: () => { throw new Error('reconcileDelivery does not message anyone'); },
            startDesign: () => { throw new Error('reconcileDelivery cannot start a design run'); },
          }, core, event)),
      ),
      get: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext): Promise<LifecycleState | null> =>
        (await ctx.get<LifecycleState>('lc')) ?? null),
      /** Fires after a delay when the requester has not submitted a revision directive. */
      reminderTick: restate.handlers.object.exclusive(
        { idempotencyRetention: { days: 2 }, journalRetention: { days: 2 } },
        async (ctx: restate.ObjectContext, event: ReminderTickEvent) =>
          withInvocationLogContext(ctx, { requestId: event?.requestId }, async () => {
            return recordReminderTick({ key: ctx.key,
              get: (name) => ctx.get<LifecycleState>(name),
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
