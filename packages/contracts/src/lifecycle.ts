/**
 * What the RequestLifecycle object, Core and the worker exchange (architecture programme Phase 2,
 * slice 2.3; PHASE2_DESIGN.md sections 2.1, 2.3, 2.8 and 2.9, ADR-034): the object's state, the
 * events its handlers take, and the projection it writes to Postgres through Core.
 *
 * The rules of section 4 hold for every type here, because a delayed or retried invocation may reach
 * a build newer or older than the one that wrote it, and Restate keeps object state across builds:
 * - every handler input and the stored state carry `v: 1`;
 * - fields are only ever added, and only as optional ones; a type never changes and a field never
 *   gets a new meaning (add a field instead);
 * - a build that meets a `v` or a stage it does not know refuses to guess (upgrade() in
 *   packages/domain/src/request-lifecycle.ts), so the invocation waits for a build that knows it.
 *
 * Nothing here imports Node: the Desk may read these types.
 */
import type { OutboundMessage } from './lifecycle-delivery.js';
import type { TaskDbState } from './task-status.js';

/** Who owns a request's life. Written once, when the request is opened, and never changed. */
export type LifecycleOwner = 'core' | 'restate';

/** Every handler input and the stored state. */
export interface Versioned {
  v: 1;
}

/** Where a request is in its life. Also `hawa.requests.stage` (migration 023), which the Desk reads. */
export const LIFECYCLE_STAGES = [
  'designing', 'awaiting_answer', 'in_review', 'manual', 'approved',
  'delivering', 'delivered', 'expired', 'cancelled',
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export function isLifecycleStage(word: unknown): word is LifecycleStage {
  return typeof word === 'string' && (LIFECYCLE_STAGES as readonly string[]).includes(word);
}

/** Stages no event leaves (a size request of a delivered design is a new request). */
export const TERMINAL_LIFECYCLE_STAGES: readonly LifecycleStage[] = ['delivered', 'cancelled'];

/** What a message was, when the lifecycle wants to hear that it was sent (messageSent). */
export type SentWhat = 'draft' | 'question' | 'reminder' | 'delivery_notice' | 'ack';

export interface SentHook {
  requestId: string;
  what: SentWhat;
  taskId: string;
}

/**
 * A message the lifecycle asks TelegramSender to send: slice 2.2's OutboundMessage, plus the
 * lifecycle's own optional fields. `onSent` makes the sender report the send back (messageSent);
 * `replyMarkup` carries the requester's buttons. Core composes every message; the lifecycle only
 * forwards them.
 */
export interface LifecycleMessage extends OutboundMessage {
  onSent?: SentHook;
  replyMarkup?: unknown;
}

/** What Core's classifier decided a new request is. No image bytes: photos travel as Telegram file ids. */
export interface DraftIntake {
  title: string;
  rawText: string;
  clientId: string | null;
  headlineEn?: string;
  headlineCkb?: string;
  copyEn?: string;
  copyCkb?: string;
  designInstructions: string;
  exactCopy: unknown[];
  autoGenerate: boolean;
  variant?: { width: number; height: number };
  designStudio?: boolean;
  /** Never `referenceImageBase64`: Core refuses a draft that carries one. */
  studioOptions?: Record<string, unknown>;
  /** Telegram file ids; Core downloads them. */
  photoFileIds?: string[];
  /** Who sent it, as Telegram names them: the acknowledgement's client line for a client it does not know. */
  senderName?: string;
}

/** A "new request or a change?" question ChatInbox keeps until the sender answers it. */
export interface PendingClarification {
  rawText: string;
  photoFileIds?: string[];
  taskId?: string;
  askedAt: number;
  updateId: number;
}

/** Core's answer to an update in decide mode: what ChatInbox routes, and to whom. */
export type IntakeDecision =
  | { kind: 'handled'; messages?: LifecycleMessage[] }
  | { kind: 'clarify'; remember: PendingClarification; messages: LifecycleMessage[] }
  /** `tenantId`: the tenant intake read the request in; the requests are opened in it. */
  | { kind: 'new_request'; requests: Array<{ index: number; draft: DraftIntake }>; messages?: LifecycleMessage[]; tenantId?: string }
  | { kind: 'answer'; requestId: string; questionId: string; answer: RequesterAnswer; callbackQueryId?: string }
  | { kind: 'requester'; requestId: string; taskId: string; action: 'ok' | 'chg' | 'dsg' | 'sst' | 'ssq' | 'sls'; callbackQueryId?: string; actorId: string }
  | { kind: 'change'; requestId: string; replyToTaskId: string; directive: string; photoFileIds?: string[] }
  | { kind: 'park'; reason: string };

/**
 * What ChatInbox keeps for its chat between updates (PHASE2_DESIGN.md 2.2) and hands to intake with
 * each update of a lifecycle chat: the "new request or a change?" question waiting for its answer
 * (it replaced Core's in-memory map), and the albums already answered (album id → when, ms), so an
 * album of ten photos gets one answer across restarts. Intake answers with the state after the update.
 */
export interface ChatIntakeState {
  pendingClarification?: PendingClarification;
  albumsAcked?: Record<string, number>;
}

/**
 * POST /v1/internal/telegram/intake's answer (slice 2.1, extended in 2.3). `handled`: intake did
 * what the update asked itself (today's path, or a rule, a command, a greeting). `decision`: intake
 * decided and saved nothing; ChatInbox routes `decision` (to RequestLifecycle, or the messages to
 * TelegramSender). `chat` is the chat's state after the update, in lifecycle mode. `replayed`: the
 * decision was read from its record (the same update asked again), not decided afresh.
 */
export interface IntakeAnswerBody {
  v: 1;
  kind: 'handled' | 'decision';
  intakeStatus: number;
  duplicate?: boolean;
  code?: string;
  decision?: IntakeDecision;
  chat?: ChatIntakeState;
  replayed?: boolean;
  taskIds?: string[];
}

/**
 * The id of the question a round's design run asked (recordOutcome), which the requester's answer
 * names. A round asks at most one question: its answer is the next round, and a re-drive starts only
 * from the office's manual stage, never while a question waits.
 */
export function questionIdOf(taskId: string): string {
  return `q:${taskId}`;
}

export interface RequesterAnswer {
  text?: string;
  /** 1-based, the button the requester tapped (rq:a1..a3). */
  option?: number;
  photoFileIds?: string[];
}

export type LifecycleOrigin =
  | { kind: 'telegram'; chatId: string; updateId: number }
  | { kind: 'size'; parentRequestId: string; action: string };

/** What a design run reported (the body the worker posts to canva-status today). */
export interface CanvaStatusReport {
  status: string;
  code?: string;
  designId?: string;
  message?: string;
  [field: string]: unknown;
}

export interface LifecycleRound {
  round: number;
  taskId: string;
  kind: 'design' | 'change' | 'answer';
  /** The DesignRun workflow key (designRunId); absent while no run was started for the round. */
  runId?: string;
  runAttempt: number;
  runInvocationId?: string;
  outcome?: { status: string; code?: string; designId?: string; revisionId?: string };
}

export interface LifecycleQuestion {
  id: string;
  taskId: string;
  question: string;
  options: string[];
  askedAt?: number;
}

export interface LifecycleDraft {
  taskId: string;
  revisionId?: string;
  designId?: string;
  sentAt?: number;
}

export interface LifecycleApproval {
  approvalId: string;
  taskId: string;
  revisionId: string;
  actionId: string;
  at: number;
}

export interface LifecycleDelivery {
  deliveryId: string;
  approvalId: string;
  startedAt: number;
  outcome?: 'delivered' | 'chat_only' | 'uncertain' | 'failed';
  sheetsConfirmed?: boolean;
  /** Which run of the delivery this is: 1 for the first, n for the n-th archive retry. */
  run?: number;
}

/**
 * The RequestLifecycle object's state, one key `lc`. Kept small: no image bytes, texts capped,
 * rounds, reminders and seen ids bounded.
 */
export interface LifecycleStateV1 {
  v: 1;
  requestId: string;
  tenantId: string;
  clientId: string | null;
  chatId: string | null;
  owner: 'restate';
  origin: LifecycleOrigin;
  /** +1 per projection Postgres accepted: the expected revision of the next one. */
  rev: number;
  stage: LifecycleStage;
  /** +1 per stage change; delayed events carry it, and one from an older stage does nothing. */
  stageEpoch: number;
  stageSince: number;
  /** 0 = the first design. */
  round: number;
  /** At most 12; older ones are dropped. */
  rounds: LifecycleRound[];
  question?: LifecycleQuestion;
  draft?: LifecycleDraft;
  requester: { signedOff?: { taskId: string; at: number }; designerAsked?: { at: number } };
  approval?: LifecycleApproval;
  delivery?: LifecycleDelivery;
  /** Reminders already sent: `draft:1:<taskId>`, `question:5:<taskId>`, … */
  reminders: string[];
  /** Core did not take a design outcome within the projection's retry window. */
  outcomeDeferred?: {
    runId: string;
    since: number;
    /** The report exactly as it was first projected: the retry must send the same ops. */
    report?: CanvaStatusReport;
    attempts?: number;
    /**
     * The projection first sent for this outcome. Core may have committed it and died before
     * answering, so the retry sends it again under the same key and revision, and Core replays its
     * record instead of refusing a new key as AHEAD. Dropped once another projection is applied at
     * that revision, which proves the outcome was never recorded.
     */
    projection?: { key: string; expectedRev: number; rev: number; stage?: LifecycleStage };
  };
  /** Size action → the child request opened for it. */
  sizes: Record<string, string>;
  /** The last 64 event ids handled: duplicates beyond Restate's idempotency retention do nothing. */
  seen: string[];
  /** The answers given to the last office decisions, so a repeated decision gets the same answer. */
  decisions?: Array<{ eventId: string; reply: OfficeDecisionResult }>;
}

/** The stored state, whatever version wrote it. upgrade() reads it. */
export type LifecycleState = LifecycleStateV1;

// ---------------------------------------------------------------------------------------------
// Handler inputs. Each handler of RequestLifecycle takes one of these.

export interface OpenEvent extends Versioned {
  eventId: string;
  requestId: string;
  tenantId: string;
  chatId: string | null;
  origin: LifecycleOrigin;
  draft: DraftIntake;
  parentRequestId?: string;
  parentTaskId?: string;
}

export interface DesignFinishedEvent extends Versioned {
  /** `dr-finished:<runId>` */
  eventId: string;
  runId: string;
  round: number;
  taskId: string;
  report: CanvaStatusReport;
}

export interface AnswerEvent extends Versioned {
  eventId: string;
  questionId: string;
  answer: RequesterAnswer;
  callbackQueryId?: string;
  actorId: string;
}

export interface RequesterDecisionEvent extends Versioned {
  eventId: string;
  /** The task the requester's button or reply names (for `change`: the task replied to). */
  taskId: string;
  kind: 'ok' | 'chg' | 'dsg' | 'size' | 'change';
  /** sst | ssq | sls */
  sizeAction?: string;
  directive?: string;
  photoFileIds?: string[];
  callbackQueryId?: string;
  actorId: string;
}

/** The approval the Desk recorded: what recordApproval stores. */
export type ApprovalDraft = Record<string, unknown>;

export type OfficeDecisionKind = 'approve' | 'revise' | 'reject' | 'deliver' | 'redrive' | 'draftCaptured' | 'cancel' | 'retryArchive';

export interface OfficeDecisionEvent extends Versioned {
  /** `desk:<actionId>` */
  eventId: string;
  actionId: string;
  actor: { userId: string; role: string };
  kind: OfficeDecisionKind;
  taskId: string;
  revisionId?: string;
  /** The request revision the Desk showed; a decision on an older one is refused (STALE_REVISION). */
  expectedRev?: number;
  approval?: ApprovalDraft;
  /** For `deliver`: the approval delivered. */
  approvalId?: string;
  comment?: string;
}

export type OfficeDecisionRefusal = 'STALE_REVISION' | 'CHANGE_PENDING' | 'WRONG_STAGE' | 'NOT_CURRENT_DRAFT';

export type OfficeDecisionResult =
  | { accepted: true; rev: number; stage: LifecycleStage }
  | { accepted: false; code: OfficeDecisionRefusal; message: string };

export interface DeliveryFinishedEvent extends Versioned {
  /** `dl-finished:<deliveryId>` */
  eventId: string;
  deliveryId: string;
  outcome: 'delivered' | 'chat_only' | 'uncertain' | 'failed';
  uncertain: string[];
  sheetsConfirmed: boolean;
}

export interface MessageSentEvent extends Versioned {
  /** `sent:<key>` */
  eventId: string;
  key: string;
  what: SentWhat;
  taskId: string;
  at: number;
  messageId?: string;
  uncertain?: boolean;
}

export interface RemindEvent extends Versioned {
  eventId: string;
  kind: 'draft' | 'question';
  day: 1 | 5;
  stageEpoch: number;
  taskId: string;
}

export interface ExpireEvent extends Versioned {
  eventId: string;
  stageEpoch: number;
}

export interface CancelEvent extends Versioned {
  eventId: string;
  by: 'office' | 'requester';
  actor?: { userId: string; role: string };
  reason?: string;
}

export interface RetryProjectionEvent extends Versioned {
  eventId: string;
  runId: string;
}

/** Every event, tagged with the handler that took it (the worker's shell adds `type`). */
export type LifecycleEvent =
  | ({ type: 'open' } & OpenEvent)
  | ({ type: 'designFinished' } & DesignFinishedEvent)
  | ({ type: 'answer' } & AnswerEvent)
  | ({ type: 'requesterDecision' } & RequesterDecisionEvent)
  | ({ type: 'officeDecision' } & OfficeDecisionEvent)
  | ({ type: 'deliveryFinished' } & DeliveryFinishedEvent)
  | ({ type: 'messageSent' } & MessageSentEvent)
  | ({ type: 'remind' } & RemindEvent)
  | ({ type: 'expire' } & ExpireEvent)
  | ({ type: 'cancel' } & CancelEvent)
  | ({ type: 'retryProjection' } & RetryProjectionEvent);

export type LifecycleEventType = LifecycleEvent['type'];

/** What the shared `get` handler answers. */
export interface LifecycleView {
  requestId: string;
  stage: LifecycleStage;
  rev: number;
  round: number;
  currentTaskId: string | null;
  question?: LifecycleQuestion;
  draft?: LifecycleDraft;
  approval?: LifecycleApproval;
  delivery?: LifecycleDelivery;
}

// ---------------------------------------------------------------------------------------------
// The projection: POST /v1/internal/lifecycle/:requestId/project, the only writer of a
// lifecycle-owned request's rows in Postgres.

export type ProjectionOp =
  | {
      op: 'createRequest';
      requestId: string;
      chatId: string | null;
      origin: LifecycleOrigin;
      draft: DraftIntake;
      parentRequestId?: string;
      parentTaskId?: string;
    }
  | {
      op: 'createRound';
      kind: 'change' | 'answer';
      round: number;
      parentTaskId: string;
      directive: string;
      /** For an answer: the task whose question it answers. */
      answers?: string;
      /** For an answer: the question as it was asked, which Core writes into the change with the answer. */
      question?: string;
      answer?: RequesterAnswer;
      photoFileIds?: string[];
    }
  | { op: 'recordOutcome'; taskId: string; runId: string; report: CanvaStatusReport }
  /**
   * `current: false`: the button or reply names a draft that is not the request's current one (a
   * newer version exists, or a change is being made); Core only composes the answer that says so.
   */
  | { op: 'recordRequesterAction'; taskId: string; action: 'ok' | 'chg' | 'dsg' | 'size' | 'change'; current: boolean; sizeAction?: string; actorId: string; callbackQueryId?: string }
  | { op: 'recordDraftSent'; taskId: string; key: string; at: number; messageId?: string }
  | { op: 'recordQuestionSent'; taskId: string; questionId: string; key: string; at: number; messageId?: string }
  /** Closes the question's task; the answer's round task is the one createRound made in the same projection. */
  | { op: 'closeQuestion'; taskId: string; questionId: string }
  | { op: 'composeReminder'; taskId: string; kind: 'draft' | 'question'; day: 1 | 5; since: number }
  | { op: 'recordApproval'; taskId: string; revisionId: string; actionId: string; actor: { userId: string; role: string }; approval?: ApprovalDraft }
  | { op: 'bridgeCapturedRevision'; taskId: string; revisionId?: string }
  | { op: 'prepareRedrive'; taskId: string; attempt: number }
  | {
      op: 'transition';
      taskId: string;
      /** Absent: the task's state is kept (only the request's stage moves). */
      toState?: TaskDbState;
      /** 'keep': a move the task's vocabulary does not allow leaves the task as it is instead of refusing. */
      ifIllegal?: 'refuse' | 'keep';
      reason: string;
    }
  | { op: 'recordDelivery'; taskId: string; deliveryId: string; approvalId: string; outcome: DeliveryFinishedEvent['outcome']; sheetsConfirmed: boolean; uncertain: string[] };

export type ProjectionOpName = ProjectionOp['op'];

export interface ProjectionRequest extends Versioned {
  /** The request's revision in Postgres this projection expects (the object's `rev`). */
  expectedRev: number;
  /** expectedRev + 1. */
  rev: number;
  /** `<requestId>:<rev>:<eventType>`: the same projection asked again is answered from the record. */
  key: string;
  /** The request's tenant, from the object's state; never from an event's payload. */
  tenantId: string;
  /** The stage after this event, when it is known before projecting; else Core derives it from the ops. */
  stage?: LifecycleStage;
  ops: ProjectionOp[];
}

export type ProjectionOpResult =
  | { op: 'createRequest'; taskId: string; autoGenerate: boolean; autoGenerateDeclined?: string; stage: LifecycleStage; messages: LifecycleMessage[] }
  | { op: 'createRound'; taskId: string; autoGenerate: boolean; autoGenerateDeclined?: string; messages: LifecycleMessage[] }
  | {
      op: 'recordOutcome';
      hasDraft: boolean;
      revisionId?: string;
      designId?: string;
      toState?: string;
      question?: { id: string; question: string; options: string[] };
      stage: LifecycleStage;
      messages: LifecycleMessage[];
    }
  | { op: 'recordRequesterAction'; messages: LifecycleMessage[]; childDraft?: DraftIntake }
  | { op: 'recordDraftSent' }
  | { op: 'recordQuestionSent' }
  | { op: 'closeQuestion'; changed: boolean }
  | { op: 'composeReminder'; skip: boolean; messages: LifecycleMessage[] }
  | { op: 'recordApproval'; approvalId: string }
  | { op: 'bridgeCapturedRevision'; revisionId: string; designId?: string; messages: LifecycleMessage[] }
  | { op: 'prepareRedrive' }
  | { op: 'transition'; taskId: string; fromState: string | null; toState: string | null; changed: boolean; version: number | null; messages: LifecycleMessage[] }
  | { op: 'recordDelivery'; messages: LifecycleMessage[] };

export interface ProjectionResponse extends Versioned {
  /** 'replayed': this key was projected before, and this is what it answered then. */
  status: 'applied' | 'replayed';
  rev: number;
  stage: LifecycleStage;
  results: ProjectionOpResult[];
}

/**
 * Core's 409 to a projection:
 * - AHEAD: Postgres has projections the object does not know (after a Restate restore); the object
 *   takes Postgres's revision and the office is told.
 * - STALE_REVISION: Postgres is behind the object; only a second writer or a Postgres restore
 *   explains that, so the object pauses and the office is told.
 * - KEY_REUSED: the key was projected before with different ops.
 */
export interface ProjectionConflict {
  code: 'AHEAD' | 'STALE_REVISION' | 'KEY_REUSED';
  pgRev: number;
  expectedRev: number;
  rev: number;
}

/** GET /v1/internal/lifecycle/:requestId: the request as Postgres has it, for reconciliation. */
export interface LifecycleRecord extends Versioned {
  requestId: string;
  tenantId: string;
  owner: LifecycleOwner;
  stage: LifecycleStage;
  rev: number;
  rootTaskId: string;
  currentTaskId: string;
  parentRequestId: string | null;
  chatId: string | null;
  draftSentAt: string | null;
  questionAskedAt: string | null;
  tasks: Array<{ id: string; state: string; version: number }>;
  lastProjection: { rev: number; key: string; appliedAt: string } | null;
}

/** The DesignRun workflow key of a round's task: `dr-<taskId>`, or `dr-<taskId>-a<n>` for the n-th re-drive. */
export function designRunId(taskId: string, attempt = 0): string {
  return attempt > 0 ? `dr-${taskId}-a${attempt}` : `dr-${taskId}`;
}
