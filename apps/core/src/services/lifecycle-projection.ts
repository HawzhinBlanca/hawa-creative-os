/**
 * The request lifecycle's projection into Postgres (architecture programme Phase 2, slice 2.3;
 * PHASE2_DESIGN.md section 2.8, ADR-034). The RequestLifecycle object in Restate decides where a
 * request is; this writes what it decided to the rows the Desk and every legacy query read, and is
 * the only writer of a lifecycle-owned request's rows.
 *
 * One projection is one transaction, under a lock on the request:
 *   1. the request's row, read FOR UPDATE (none yet for the projection that opens it);
 *   2. a projection already recorded under this key is answered from its record ('replayed'), or
 *      refused (KEY_REUSED) when the key comes with other ops;
 *   3. the revision must be the one the object expects: Postgres ahead of the object is AHEAD (the
 *      object was restored and must take Postgres's revision), behind it is STALE_REVISION;
 *   4. the ops run in order, each task move with the state and version read under the same lock;
 *   5. the request takes the new revision and stage, and the projection is recorded with its answer.
 * Any op that fails rolls all of it back.
 *
 * The tenant comes from the object's state (the body), never from an event's payload, and the
 * transaction runs as the system automation identity under row-level security.
 *
 * Part A of slice 2.3 carries the ops that only write rows (open, rounds, task moves, questions
 * closed, sends recorded); part C the ops that need Core's composition (a design outcome, a
 * requester's button, a reminder: lifecycle-compose.ts), and the acknowledgements of a new request
 * and a round. Slice 2.4 the office's: a decision on a draft (an approvals row, as the decisions route
 * records one), a captured draft, a re-drive, the claim of a publication for the Delivery workflow and
 * its report.
 */
import { createHash } from 'node:crypto';
import { sql, RevisionRepository, TaskRepository, withRlsContext, type Database, type Kysely, type TaskState } from '@hawa/db';
import {
  SYSTEM_AUTOMATION_USER_ID,
  canTransitionTaskStatus,
  isOfficeActionId,
  isLifecycleStage,
  isTaskDbState,
  toApiTaskStatus,
  type DraftIntake,
  type LifecycleRecord,
  type LifecycleOrigin,
  type LifecycleStage,
  type ProjectionConflict,
  type ProjectionOp,
  type ProjectionOpResult,
  type ProjectionRequest,
  type ProjectionResponse,
} from '@hawa/contracts';
import { stageAfterOpen, stageAfterRound } from '@hawa/domain';
import { isValidUuid } from '../core-helpers.js';
import { persistChatIntakeIn } from './chat-intake.js';
import { captureBoundDraftIn, closeAnsweredQuestion, transitionTaskForOutcome } from './canva-task-outcome.js';
import { claimPublicationForWorkflowIn, recordWorkflowDeliveryIn } from './workflow-delivery-record.js';
import { composeReminderIn, messageOf, recordOutcomeIn, recordRequesterActionIn, type ComposeRun } from './lifecycle-compose.js';
import { composeRequestSavedAck } from './chat-campaign-intake.js';
import { OTHER_SIZES, composeAnswerTaken, composeSizeStarted, type SizeAction } from './requester-actions.js';
import { escapeTelegramHtml } from '@hawa/integrations';
import { cutText, evaluateCanvaExportQc } from '../core-helpers.js';

const OPS: ReadonlySet<string> = new Set([
  'createRequest', 'createRound', 'recordOutcome', 'recordRequesterAction', 'recordDraftSent', 'recordQuestionSent',
  'closeQuestion', 'composeReminder', 'recordApproval', 'bridgeCapturedRevision', 'prepareRedrive', 'transition', 'recordDelivery',
]);
const MAX_OPS = 10;
/** An approval's recorded payload (the pinned exports and the QC evidence) is small; this bounds it. */
const MAX_APPROVAL_PAYLOAD = 64_000;
const DECISIONS: ReadonlySet<string> = new Set(['approved', 'revision_requested', 'rejected']);
const DELIVERY_OUTCOMES: ReadonlySet<string> = new Set(['delivered', 'chat_only', 'uncertain', 'failed']);
const ACTOR = 'request_lifecycle';

/** What the projection answers, before HTTP. */
export type ProjectionAnswer =
  | { ok: true; response: ProjectionResponse; createdTaskIds: string[]; moves: Array<{ taskId: string; from: string; to: string; version: number }> }
  | { ok: false; status: 403 | 404 | 409 | 422 | 500 | 503; code: string; message: string; conflict?: ProjectionConflict };

/** A refusal thrown inside the transaction, which rolls it back. */
class Refusal extends Error {
  constructor(readonly status: 403 | 404 | 409 | 422 | 500 | 503, readonly code: string, message: string, readonly conflict?: ProjectionConflict) {
    super(message);
  }
}

const refuse = (code: string, message: string, status: 403 | 404 | 422 = 422): never => {
  throw new Refusal(status, code, message);
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** The hash a key is bound to: what the projection asks for, not how it was sent. */
export function projectionHash(body: Pick<ProjectionRequest, 'expectedRev' | 'rev' | 'stage' | 'ops'>): string {
  return createHash('sha256').update(canonical({ expectedRev: body.expectedRev, rev: body.rev, stage: body.stage, ops: body.ops })).digest('hex');
}

/** Checks the body's shape; the ops' own fields are checked where each op runs. */
export function readProjectionRequest(requestId: string, raw: unknown): { ok: true; body: ProjectionRequest } | { ok: false; message: string } {
  if (!isValidUuid(requestId)) return { ok: false, message: 'The request id is not a UUID' };
  if (!raw || typeof raw !== 'object') return { ok: false, message: 'The body must be a projection' };
  const b = raw as Partial<ProjectionRequest>;
  if (b.v !== 1) return { ok: false, message: `This Core reads projection v1, not ${JSON.stringify(b.v)}` };
  if (!Number.isSafeInteger(b.expectedRev) || (b.expectedRev as number) < 0) return { ok: false, message: 'expectedRev must be a revision (0 or more)' };
  if (b.rev !== (b.expectedRev as number) + 1) return { ok: false, message: 'rev must be expectedRev + 1' };
  if (typeof b.key !== 'string' || b.key.length > 300 || !b.key.startsWith(`${requestId}:${b.rev}:`) || b.key.length === `${requestId}:${b.rev}:`.length) {
    return { ok: false, message: 'key must be <requestId>:<rev>:<event>, at most 300 characters' };
  }
  if (!isValidUuid(b.tenantId)) return { ok: false, message: 'tenantId must be the request\'s tenant' };
  if (b.stage !== undefined && !isLifecycleStage(b.stage)) return { ok: false, message: `Unknown stage ${JSON.stringify(b.stage)}` };
  if (!Array.isArray(b.ops) || b.ops.length === 0 || b.ops.length > MAX_OPS) return { ok: false, message: `ops must be 1 to ${MAX_OPS} operations` };
  for (const op of b.ops) {
    if (!op || typeof op !== 'object' || !OPS.has(String((op as { op?: unknown }).op))) return { ok: false, message: `Unknown op ${JSON.stringify((op as { op?: unknown })?.op)}` };
  }
  return { ok: true, body: b as ProjectionRequest };
}

interface RequestRow {
  tenant_id: string;
  rev: string;
  stage: string;
  owner: string;
  current_task_id: string;
  chat_id: string | null;
}

interface Run {
  trx: Kysely<Database>;
  tenantId: string;
  requestId: string;
  body: ProjectionRequest;
  row: RequestRow | null;
  currentTaskId: string | null;
  derivedStage?: LifecycleStage;
  results: ProjectionOpResult[];
  createdTaskIds: string[];
  moves: Array<{ taskId: string; from: string; to: string; version: number }>;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A draft Core can save as it is: no image bytes, no photos until Core downloads them (part B). */
function checkDraft(draft: unknown): DraftIntake {
  if (!draft || typeof draft !== 'object') refuse('INVALID_DRAFT', 'createRequest carries the classified draft');
  const d = draft as DraftIntake;
  if (!text(d.title, 500) || !text(d.rawText, 20000)) refuse('INVALID_DRAFT', 'The draft needs a title and the original text');
  if (d.clientId !== null && !isValidUuid(d.clientId)) refuse('INVALID_DRAFT', 'The draft\'s client must be an id or null');
  if (!Array.isArray(d.exactCopy)) refuse('INVALID_DRAFT', 'exactCopy must be a list');
  const options = d.studioOptions as Record<string, unknown> | undefined;
  if (options && ('referenceImageBase64' in options || 'reference' in options)) refuse('INVALID_DRAFT', 'A draft carries no image bytes: photos travel as Telegram file ids');
  if (Array.isArray(d.photoFileIds) && d.photoFileIds.length) refuse('PHOTOS_NOT_SUPPORTED_YET', 'Photos of a lifecycle request are fetched by Core from slice 2.3 part B on');
  return d;
}

/** The task, if it is a round of this request (read under the projection's lock). */
async function requestTask(run: Run, taskId: unknown): Promise<{ id: string; state: string; version: number; title: string; client_id: string | null }> {
  if (!isValidUuid(taskId)) refuse('NOT_IN_REQUEST', 'The op names no task');
  const task = (await sql<{ id: string; state: string; version: string; title: string; client_id: string | null }>`
    SELECT id::text, state::text, version::text, title, client_id::text FROM hawa.tasks
    WHERE tenant_id = ${run.tenantId}::uuid AND id = ${taskId as string}::uuid AND request_id = ${run.requestId}::uuid
    FOR UPDATE`.execute(run.trx)).rows[0];
  if (!task) refuse('NOT_IN_REQUEST', `Task ${String(taskId)} is not a round of request ${run.requestId}`);
  return { ...task!, version: Number(task!.version) };
}

async function taskCreatedPayload(run: Run, taskId: string): Promise<Record<string, unknown>> {
  const row = (await sql<{ payload: Record<string, unknown> }>`
    SELECT payload FROM hawa.outbox_commands WHERE tenant_id = ${run.tenantId}::uuid AND aggregate_id = ${taskId}::uuid AND command_type = 'task.created'
    ORDER BY created_at LIMIT 1`.execute(run.trx)).rows[0];
  const payload = row?.payload;
  return payload && typeof payload === 'object' ? (typeof payload === 'string' ? JSON.parse(payload) : payload) : {};
}

/**
 * Where a request came from, as it is written into the task's raw record: the Telegram update of the
 * chat it names, or a size of the parent request it names. Only the known fields are kept, so a
 * newer worker's added fields do not reach the row unread.
 */
function checkOrigin(op: Extract<ProjectionOp, { op: 'createRequest' }>): LifecycleOrigin {
  const o = op.origin as Partial<Record<string, unknown>> | undefined;
  if (!o || typeof o !== 'object') return refuse('INVALID_OP', 'createRequest carries where the request came from');
  if (o.kind === 'telegram') {
    if (o.chatId !== op.chatId) refuse('INVALID_OP', 'The origin names another chat than the request');
    if (!Number.isSafeInteger(o.updateId) || (o.updateId as number) < 0) refuse('INVALID_OP', 'A Telegram origin names its update');
    return { kind: 'telegram', chatId: op.chatId as string, updateId: o.updateId as number };
  }
  if (o.kind === 'size') {
    if (!op.parentRequestId || o.parentRequestId !== op.parentRequestId) refuse('INVALID_OP', 'A size origin names the parent request of the op');
    if (typeof o.action !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(o.action)) refuse('INVALID_OP', 'A size origin names its size action');
    return { kind: 'size', parentRequestId: op.parentRequestId as string, action: o.action as string };
  }
  return refuse('INVALID_OP', `Unknown origin ${JSON.stringify(o.kind)}`);
}

async function createRequest(run: Run, op: Extract<ProjectionOp, { op: 'createRequest' }>): Promise<ProjectionOpResult> {
  if (op.requestId !== run.requestId) refuse('INVALID_OP', 'createRequest names another request');
  if (run.row) refuse('INVALID_OP', 'The request is open already');
  if (typeof op.chatId !== 'string' || !/^-?\d{1,20}$/.test(op.chatId)) refuse('INVALID_OP', 'A lifecycle request comes from a Telegram chat');
  const origin = checkOrigin(op);
  const draft = checkDraft(op.draft);
  if (op.parentRequestId !== undefined) {
    if (!isValidUuid(op.parentRequestId)) refuse('INVALID_OP', 'parentRequestId must be a request id');
    const parent = (await sql`SELECT 1 FROM hawa.requests WHERE request_id = ${op.parentRequestId}::uuid`.execute(run.trx)).rows[0];
    if (!parent) refuse('INVALID_OP', `Parent request ${op.parentRequestId} is not in this tenant`);
  }
  const persisted = await persistChatIntakeIn(run.trx, {
    tenantId: run.tenantId,
    userId: SYSTEM_AUTOMATION_USER_ID,
    platform: 'telegram',
    // One task per request (a Telegram update may open several), keyed by request and round.
    sourceEventId: `lc-${run.requestId}-r0`,
    sourceChannelId: op.chatId as string,
    rawText: draft.rawText,
    rawJson: { lifecycle: { requestId: run.requestId, round: 0, origin }, text: draft.rawText },
    clientId: draft.clientId,
    title: text(draft.title, 500),
    headlineEn: draft.headlineEn, headlineCkb: draft.headlineCkb, copyEn: draft.copyEn, copyCkb: draft.copyCkb,
    designInstructions: String(draft.designInstructions ?? ''),
    exactCopy: draft.exactCopy,
    // Only a scoped request with copy is designed automatically (ingestChatCampaignTask's rule): the
    // saved flag counts against the sender's daily allowance, and a draft from an intake that did not
    // apply the rule must not use it up for a request nobody designs.
    autoGenerate: draft.autoGenerate === true && Boolean(draft.clientId) && draft.isInstructionOnly !== true,
    ...(draft.isInstructionOnly === true ? { isInstructionOnly: true } : {}),
    ...(draft.variant ? { variant: draft.variant } : {}),
    ...(typeof draft.designStudio === 'boolean' ? { designStudio: draft.designStudio } : {}),
    ...(draft.studioOptions ? { studioOptions: draft.studioOptions as never } : {}),
  }, { requestId: run.requestId });
  const taskId = String(persisted.task.id);
  const stage = stageAfterOpen(persisted.autoGenerate, draft.clientId);
  await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id)
    VALUES (${run.requestId}::uuid, ${run.tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, ${op.parentRequestId ?? null}::uuid, 'restate', ${stage}, 0, ${op.chatId})`.execute(run.trx);
  run.row = { tenant_id: run.tenantId, rev: '0', stage, owner: 'restate', current_task_id: taskId, chat_id: op.chatId };
  run.currentTaskId = taskId;
  run.derivedStage = stage;
  if (persisted.created) run.createdTaskIds.push(taskId);
  // The requester's acknowledgement, as intake sends it for a request it saves (the same words); a
  // size of a design is told which size is being made.
  const variant = draft.variant ?? { width: 1080, height: 1080 };
  const size = origin.kind === 'size' && origin.action in OTHER_SIZES ? OTHER_SIZES[origin.action as SizeAction] : undefined;
  const ack = size && !persisted.autoGenerateDeclined
    ? composeSizeStarted(size.label, size.width, size.height, taskId)
    : composeRequestSavedAck({
        taskId, clientId: draft.clientId, savedClientId: draft.clientId, senderName: text(draft.senderName, 200) || 'Telegram Client', title: text(draft.title, 500), variant,
        automaticDraft: Boolean(persisted.autoGenerate && draft.clientId), autoGenerateDeclined: persisted.autoGenerateDeclined,
      });
  return {
    op: 'createRequest', taskId, autoGenerate: persisted.autoGenerate, stage,
    ...(persisted.autoGenerateDeclined ? { autoGenerateDeclined: persisted.autoGenerateDeclined } : {}),
    messages: [messageOf(`${run.requestId}:${run.body.rev}:ack`, op.chatId as string, ack, { tenantId: run.tenantId, taskId, class: 'courtesy' })],
  };
}

async function createRound(run: Run, op: Extract<ProjectionOp, { op: 'createRound' }>): Promise<ProjectionOpResult> {
  if (op.kind !== 'change' && op.kind !== 'answer') refuse('INVALID_OP', 'A round is a change or an answer');
  if (!Number.isSafeInteger(op.round) || op.round < 1) refuse('INVALID_OP', 'A round after the first design is numbered from 1');
  if (op.photoFileIds?.length || op.answer?.photoFileIds?.length) refuse('PHOTOS_NOT_SUPPORTED_YET', 'Photos of a lifecycle request are fetched by Core from slice 2.3 part B on');
  const parent = await requestTask(run, op.parentTaskId);
  const payload = await taskCreatedPayload(run, parent.id);
  const options = (payload.studioOptions && typeof payload.studioOptions === 'object' ? payload.studioOptions : {}) as Record<string, unknown>;
  const chat = run.row?.chat_id ?? String(payload.sourceChannelId ?? '');
  if (!chat) refuse('INVALID_OP', 'The request has no chat to save the round under');
  const directive = text(op.directive, 2000);
  const base = {
    tenantId: run.tenantId,
    userId: SYSTEM_AUTOMATION_USER_ID,
    platform: 'telegram' as const,
    sourceEventId: `lc-${run.requestId}-r${op.round}`,
    sourceChannelId: chat,
    rawText: String(payload.rawRequestText || parent.title || 'Design'),
    rawJson: { lifecycle: { requestId: run.requestId, round: op.round, kind: op.kind }, directive },
    clientId: parent.client_id,
    headlineEn: (payload.headlineEn as string) || undefined,
    headlineCkb: (payload.headlineCkb as string) || undefined,
    copyEn: (payload.copyEn as string) || undefined,
    copyCkb: (payload.copyCkb as string) || undefined,
    exactCopy: Array.isArray(payload.exactCopy) ? payload.exactCopy : [],
    autoGenerate: true,
    ...(payload.variant ? { variant: payload.variant as { width: number; height: number } } : {}),
    ...(typeof payload.designStudio === 'boolean' ? { designStudio: payload.designStudio } : {}),
  };
  let persisted: Awaited<ReturnType<typeof persistChatIntakeIn>>;
  if (op.kind === 'answer') {
    // As the legacy answer does (telegram-intake/questions.ts answerQuestion): the waiting task's own
    // request again, with the answer written into the change, never asked about again.
    const question = text(op.question, 1000);
    const answer = directive || 'the attached picture';
    const asked = question ? `Asked "${question}", the client answered: ${answer}` : `The client answered: ${answer}`;
    const prior = typeof options.revisionDirective === 'string' ? options.revisionDirective.trim() : '';
    persisted = await persistChatIntakeIn(run.trx, {
      ...base,
      title: parent.title || 'Design (Revision)',
      designInstructions: `${String(payload.designInstructions || '')}\n${question ? `Answer to "${question}"` : 'Answer'}: ${answer}`.trim(),
      studioOptions: { ...options, revisionDirective: prior ? `${prior}\n\n${asked}` : asked, clarified: true, answers: op.answers ?? parent.id } as never,
    }, { requestId: run.requestId });
  } else {
    // As the legacy change does (telegram-intake/changes.ts): the change made to the design replied to.
    const cleanTitle = (parent.title || 'Design').replace(/ \(Revision.*\)/, '');
    persisted = await persistChatIntakeIn(run.trx, {
      ...base,
      title: `${cleanTitle} (Revision)`,
      designInstructions: `${String(payload.designInstructions || '')}\nOperator Revision Directive: ${directive}`.trim(),
      variant: (payload.variant as { width: number; height: number }) || { width: 1080, height: 1350 },
      studioOptions: { parentTaskId: parent.id, revisionRound: (Number(options.revisionRound) || 0) + 1, revisionDirective: directive } as never,
    }, { requestId: run.requestId });
  }
  const taskId = String(persisted.task.id);
  run.currentTaskId = taskId;
  run.derivedStage = stageAfterRound(persisted.autoGenerate);
  if (persisted.created) run.createdTaskIds.push(taskId);
  // What the requester is told, in the legacy path's words (telegram-intake/changes.ts, questions.ts).
  const said = cutText(op.kind === 'answer' ? (directive || 'the attached picture') : directive, op.kind === 'answer' ? 300 : 500);
  const reply = persisted.autoGenerateDeclined
    ? {
        text: op.kind === 'answer'
          ? `👍 <b>Got it:</b> ${escapeTelegramHtml(said)}\n\n⏳ <i>The daily limit for automatic drafts has been reached for this chat. Your change is saved and queued for the art director in Hawa Desk.</i>\n\n🆔 Task ID: <code>${escapeTelegramHtml(taskId)}</code>`
          : `✏️ <b>Revision instruction received:</b> "${escapeTelegramHtml(said)}"\n\n⏳ <i>The daily limit for automatic drafts has been reached for this chat. Your revision is saved and queued for manual review in Hawa Desk.</i>`,
        parse_mode: 'HTML' as const,
      }
    : op.kind === 'answer'
      ? composeAnswerTaken(said, taskId)
      : {
          text: `✏️ <b>Change received:</b> "${escapeTelegramHtml(said)}"\n\n🎨 <b>Making this change to the same design.</b>\n` +
            `<i>The new draft and its editable Canva link come to this chat when ready. To change it again, reply to the new draft.</i>\n\n` +
            `🆔 Task ID: <code>${escapeTelegramHtml(taskId)}</code>`,
          parse_mode: 'HTML' as const,
        };
  return {
    op: 'createRound', taskId, autoGenerate: persisted.autoGenerate,
    ...(persisted.autoGenerateDeclined ? { autoGenerateDeclined: persisted.autoGenerateDeclined } : {}),
    messages: [messageOf(`${run.requestId}:${run.body.rev}:round`, chat, reply, { tenantId: run.tenantId, taskId, class: 'courtesy' })],
  };
}

async function transition(run: Run, op: Extract<ProjectionOp, { op: 'transition' }>): Promise<ProjectionOpResult> {
  const task = await requestTask(run, op.taskId);
  const unchanged: ProjectionOpResult = { op: 'transition', taskId: task.id, fromState: task.state, toState: task.state, changed: false, version: task.version, messages: [] };
  if (op.toState === undefined || op.toState === task.state) return unchanged;
  if (!isTaskDbState(op.toState)) return refuse('INVALID_OP', `Unknown task state ${JSON.stringify(op.toState)}`);
  if (op.fallbackState !== undefined && !isTaskDbState(op.fallbackState)) return refuse('INVALID_OP', `Unknown task state ${JSON.stringify(op.fallbackState)}`);
  // The one vocabulary's moves (packages/contracts task-status.ts) hold here as everywhere.
  const legal = (to: string) => canTransitionTaskStatus(toApiTaskStatus(task.state), toApiTaskStatus(to));
  const toState = legal(op.toState) ? op.toState : op.fallbackState && op.fallbackState !== task.state && legal(op.fallbackState) ? op.fallbackState : null;
  if (!toState) {
    if (op.ifIllegal === 'keep') return unchanged;
    return refuse('ILLEGAL_TRANSITION', `A task cannot move from ${task.state} to ${op.toState}`);
  }
  const moved = await new TaskRepository(run.trx).transitionState({
    taskId: task.id, tenantId: run.tenantId, expectedVersion: task.version, fromState: task.state as TaskState, toState,
    actorType: 'workflow', actorId: ACTOR, reason: text(op.reason, 1000) || 'The request lifecycle moved the task',
    data: { requestId: run.requestId, rev: run.body.rev },
  }, run.trx);
  run.moves.push({ taskId: task.id, from: task.state, to: toState, version: Number(moved.version) });
  return { op: 'transition', taskId: task.id, fromState: task.state, toState, changed: true, version: Number(moved.version), messages: [] };
}

/**
 * A move that starts a run of the Delivery workflow (slice 2.4): the approval's publication is claimed
 * for that run in the same transaction, after the move (creating the publication bumps the task's
 * version, which the move checks).
 */
async function transitionAndClaim(run: Run, op: Extract<ProjectionOp, { op: 'transition' }>): Promise<ProjectionOpResult> {
  const delivery = op.delivery;
  if (!delivery) return transition(run, op);
  if (!isValidUuid(delivery.approvalId) || !Number.isSafeInteger(delivery.run) || delivery.run < 1 || !text(delivery.deliveryId, 300)) {
    refuse('INVALID_OP', 'A delivery names its approval, its run (1 or more) and its workflow id');
  }
  const moved = await transition(run, op);
  const task = await requestTask(run, op.taskId);
  if (task.state !== 'publishing') refuse('NOT_PUBLISHING', `Task ${task.id} is ${task.state}, so it cannot be delivered`);
  const claim = await claimPublicationForWorkflowIn(run.trx, { tenantId: run.tenantId, taskId: task.id, approvalId: delivery.approvalId, run: delivery.run });
  if (!claim.ok) refuse(claim.code, claim.message);
  return moved;
}

/**
 * The office's decision on a draft, recorded as the decisions route records it: an approvals row on the
 * revision (the nonce `lc:<actionId>`), the revision's status and the task's move with its event. The
 * payload is the route's (pinned exports, QC evidence), checked there before it was forwarded.
 */
async function recordApproval(run: Run, op: Extract<ProjectionOp, { op: 'recordApproval' }>): Promise<ProjectionOpResult> {
  const task = await requestTask(run, op.taskId);
  if (!isValidUuid(op.revisionId)) refuse('INVALID_OP', 'recordApproval names the revision decided on');
  if (!isOfficeActionId(op.actionId)) refuse('INVALID_OP', 'recordApproval carries the office action id');
  const decision = op.decision ?? 'approved';
  if (!DECISIONS.has(decision)) refuse('INVALID_OP', `Unknown decision ${JSON.stringify(decision)}`);
  const nonce = `lc:${op.actionId}`;
  // The same action recorded before (under another projection key): its row answers.
  const earlier = (await sql<{ id: string }>`SELECT id::text FROM hawa.approvals
    WHERE tenant_id = ${run.tenantId}::uuid AND task_id = ${task.id}::uuid AND nonce = ${nonce} LIMIT 1`.execute(run.trx)).rows[0];
  if (earlier) return { op: 'recordApproval', approvalId: earlier.id };
  const payload = op.approval && typeof op.approval === 'object' && !Array.isArray(op.approval) ? op.approval : {};
  if (JSON.stringify(payload).length > MAX_APPROVAL_PAYLOAD) refuse('INVALID_OP', `The approval's payload is over ${MAX_APPROVAL_PAYLOAD} characters`);
  const decidedBy = isValidUuid(op.actor?.userId) ? op.actor.userId : SYSTEM_AUTOMATION_USER_ID;
  const reason = text(op.reason, 1000) || (decision === 'approved' ? 'Approved by operator' : decision === 'rejected' ? 'Rejected by operator' : 'Revision requested');
  let approval: { id: string };
  try {
    approval = await new RevisionRepository(run.trx).recordApproval({
      tenantId: run.tenantId, taskId: task.id, revisionId: op.revisionId, decision: decision as 'approved', decidedBy, reason, nonce,
      decisionPayload: {
        ...payload,
        taskId: task.id, revisionId: op.revisionId, approverId: decidedBy, approverRole: text(op.actor?.role, 40) || 'operator',
        ...(decision === 'approved' ? { approvedAt: new Date().toISOString() } : {}),
        lifecycle: { requestId: run.requestId, rev: run.body.rev, actionId: op.actionId },
      },
    }, run.trx) as { id: string };
  } catch (err) {
    // A database error is the database's (503 or 500 below); the repository's own refusals (a stale
    // revision, no passing QC run, approved already) say why the decision cannot be recorded.
    if (err instanceof Refusal || pgCode(err)) throw err;
    return refuse('DECISION_REFUSED', String((err as Error)?.message ?? err).slice(0, 300));
  }
  const after = (await sql<{ state: string; version: string }>`SELECT state::text, version::text FROM hawa.tasks
    WHERE tenant_id = ${run.tenantId}::uuid AND id = ${task.id}::uuid`.execute(run.trx)).rows[0];
  if (after && after.state !== task.state) run.moves.push({ taskId: task.id, from: task.state, to: after.state, version: Number(after.version) });
  return { op: 'recordApproval', approvalId: String(approval.id) };
}

/**
 * A draft the office made or changed in Canva, captured (its exports made again by the route that
 * forwarded the decision) and recorded as the round's Desk revision in review: a first revision, the
 * new revision after a revision request, or the check of the current one.
 */
async function bridgeCapturedRevision(run: Run, op: Extract<ProjectionOp, { op: 'bridgeCapturedRevision' }>): Promise<ProjectionOpResult> {
  const task = await requestTask(run, op.taskId);
  const binding = (await sql<{ canva_design_id: string; version: string; edit_url: string | null }>`SELECT canva_design_id, version::text, edit_url
    FROM hawa.canva_bindings WHERE tenant_id = ${run.tenantId}::uuid AND task_id = ${task.id}::uuid AND status = 'bound'
    ORDER BY created_at DESC LIMIT 1`.execute(run.trx)).rows[0];
  if (!binding) return refuse('NO_CANVA_DESIGN', `Task ${task.id} has no Canva design to capture`);
  const payload = await taskCreatedPayload(run, task.id);
  const copy = Array.isArray(payload.exactCopy) && payload.exactCopy.every((c) => typeof c === 'string') ? payload.exactCopy as string[] : undefined;
  const captured = await captureBoundDraftIn(run.trx, { revisionRepo: new RevisionRepository(run.trx), evaluateQc: evaluateCanvaExportQc }, {
    tenantId: run.tenantId, taskId: task.id, actorId: SYSTEM_AUTOMATION_USER_ID, designId: binding.canva_design_id, bindingVersion: Number(binding.version),
    ...(binding.edit_url ? { canvaUrl: binding.edit_url } : {}), ...(copy ? { fallbackCopy: copy } : {}), rework: true,
  });
  if (captured.transition?.changed) run.moves.push({ taskId: task.id, from: captured.transition.fromState, to: captured.transition.toState, version: captured.transition.version });
  const now = (await sql<{ state: string; rev: string | null }>`SELECT state::text, current_design_revision_id::text AS rev FROM hawa.tasks
    WHERE tenant_id = ${run.tenantId}::uuid AND id = ${task.id}::uuid`.execute(run.trx)).rows[0];
  const revisionId = captured.revisionId ?? now?.rev ?? null;
  if (!revisionId) return refuse('NOTHING_CAPTURED', `No checked export of Canva design ${binding.canva_design_id} is stored: capture it first`);
  if (op.revisionId && op.revisionId !== revisionId) return refuse('NOT_CURRENT_DRAFT', `The captured revision is ${revisionId}, not ${op.revisionId}`);
  // A round the office took over after a failed design goes back to review with its captured draft.
  if (now && now.state !== 'human_review') {
    const moved = await transitionTaskForOutcome(run.trx, {
      tenantId: run.tenantId, taskId: task.id, toState: 'human_review', actorId: ACTOR,
      reason: `The office captured Canva draft ${binding.canva_design_id}; awaiting visual review.`, data: { requestId: run.requestId, rev: run.body.rev },
    });
    if (!moved.changed) return refuse('NOT_REVIEWABLE', `Task ${task.id} is ${now.state}; a captured draft cannot put it in review`);
    run.moves.push({ taskId: task.id, from: moved.fromState, to: moved.toState, version: moved.version });
  }
  return { op: 'bridgeCapturedRevision', revisionId, designId: binding.canva_design_id, messages: [] };
}

/**
 * Before a round is designed again: a studio run of the round nobody follows any more (its design run
 * reported, or was cut off) is abandoned, so the new run is not refused as one in progress, and the
 * requester hears that a new design was started (the words of the legacy re-drive).
 */
async function prepareRedrive(run: Run, op: Extract<ProjectionOp, { op: 'prepareRedrive' }>): Promise<ProjectionOpResult> {
  const task = await requestTask(run, op.taskId);
  if (!Number.isSafeInteger(op.attempt) || op.attempt < 0) refuse('INVALID_OP', 'prepareRedrive names the attempt (0 or more)');
  if (!task.client_id) refuse('CLIENT_REQUIRED', `Task ${task.id} has no client, so it cannot be designed automatically`);
  await sql`UPDATE hawa.design_studio_runs
    SET status = 'abandoned', diagnostic = ${`Abandoned by the request lifecycle: the office re-drove round task ${task.id} (attempt ${op.attempt})`}, updated_at = now()
    WHERE tenant_id = ${run.tenantId}::uuid AND task_id = ${task.id}::uuid AND status NOT IN ('transferred', 'degraded', 'failed', 'abandoned')`.execute(run.trx);
  run.derivedStage = 'designing';
  const chat = run.row?.chat_id ?? null;
  const words = `🔄 <b>A new automatic design has been started</b> for task <code>${escapeTelegramHtml(task.id)}</code>.\n<i>You will receive the Canva link here when it is ready, or an explanation if it cannot be made.</i>`;
  return {
    op: 'prepareRedrive',
    messages: chat ? [messageOf(`${run.requestId}:${run.body.rev}:redrive`, chat, { text: words, parse_mode: 'HTML' }, { tenantId: run.tenantId, taskId: task.id, class: 'courtesy' })] : [],
  };
}

/** The Delivery workflow's report, recorded as Core's delivery-finished endpoint records it. */
async function recordDelivery(run: Run, op: Extract<ProjectionOp, { op: 'recordDelivery' }>): Promise<ProjectionOpResult> {
  const task = await requestTask(run, op.taskId);
  const deliveryRun = op.run ?? 1;
  if (!isValidUuid(op.approvalId) || !Number.isSafeInteger(deliveryRun) || deliveryRun < 1 || !DELIVERY_OUTCOMES.has(String(op.outcome)) || !text(op.deliveryId, 300)) {
    refuse('INVALID_OP', 'A delivery report names its approval, its run, its workflow id and an outcome');
  }
  const recorded = await recordWorkflowDeliveryIn(run.trx, {
    tenantId: run.tenantId, taskId: task.id, approvalId: op.approvalId, deliveryId: op.deliveryId, run: deliveryRun,
    outcome: {
      outcome: op.outcome, sheetsConfirmed: op.sheetsConfirmed === true, archived: typeof op.archived === 'boolean' ? op.archived : op.sheetsConfirmed === true,
      ...(op.reason ? { reason: text(op.reason, 500) } : {}),
    },
  });
  if (!recorded.ok) return refuse(recorded.code, recorded.message);
  if (recorded.status === 'applied' && recorded.taskState !== recorded.fromState) {
    const v = (await sql<{ version: string }>`SELECT version::text FROM hawa.tasks WHERE tenant_id = ${run.tenantId}::uuid AND id = ${task.id}::uuid`.execute(run.trx)).rows[0];
    run.moves.push({ taskId: task.id, from: recorded.fromState, to: recorded.taskState, version: Number(v?.version ?? 0) });
  }
  return { op: 'recordDelivery', messages: [] };
}

async function closeQuestion(run: Run, op: Extract<ProjectionOp, { op: 'closeQuestion' }>): Promise<ProjectionOpResult> {
  const task = await requestTask(run, op.taskId);
  const round = [...run.results].reverse().find((r): r is Extract<ProjectionOpResult, { op: 'createRound' }> => r.op === 'createRound');
  if (!round) refuse('INVALID_OP', 'closeQuestion follows the round that answers the question, in the same projection');
  const closed = await closeAnsweredQuestion(run.trx, { tenantId: run.tenantId, taskId: task.id, revisionTaskId: round!.taskId, actorId: ACTOR });
  if (closed.changed) run.moves.push({ taskId: task.id, from: closed.fromState, to: closed.toState, version: closed.version });
  return { op: 'closeQuestion', changed: closed.changed };
}

/**
 * A send the lifecycle confirmed, recorded as the legacy queries read a sent message: a delivered
 * notify.telegram row of the task (draftsToRemind, questionsToRemind, replyDesign and others read
 * these rows as "the draft was sent", finding 1.2.1), dated when Telegram took it.
 */
async function recordSent(run: Run, op: Extract<ProjectionOp, { op: 'recordDraftSent' | 'recordQuestionSent' }>): Promise<ProjectionOpResult> {
  const task = await requestTask(run, op.taskId);
  if (!Number.isFinite(op.at) || op.at <= 0) refuse('INVALID_OP', 'A send is recorded with the time Telegram took it');
  const key = text(op.key, 250);
  if (!key) refuse('INVALID_OP', 'A send is recorded with its message key');
  const draft = op.op === 'recordDraftSent';
  const status = draft ? 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' : 'CANVA_NEEDS_CLARIFICATION';
  const at = new Date(op.at);
  const payload = {
    chatId: run.row?.chat_id ?? null, taskId: task.id, status, lifecycleOwner: 'restate', requestId: run.requestId, messageKey: key,
    ...(op.messageId ? { messageId: String(op.messageId).slice(0, 40) } : {}),
    ...(op.op === 'recordQuestionSent' ? { questionId: text(op.questionId, 200) } : {}),
  };
  await sql`INSERT INTO hawa.outbox_commands (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload, state, delivered_at, created_at, available_at, last_error)
    VALUES (${run.tenantId}::uuid, 'task', ${task.id}::uuid, 'notify.telegram', ${`notify.telegram:${task.id}:${status}:lc:${key}`}, ${JSON.stringify(payload)}::jsonb,
      'delivered', ${at}, ${at}, ${at}, 'SENT_BY_LIFECYCLE')
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`.execute(run.trx);
  if (draft) await sql`UPDATE hawa.requests SET draft_sent_at = ${at} WHERE request_id = ${run.requestId}::uuid`.execute(run.trx);
  else await sql`UPDATE hawa.requests SET question_asked_at = ${at} WHERE request_id = ${run.requestId}::uuid`.execute(run.trx);
  return draft ? { op: 'recordDraftSent' } : { op: 'recordQuestionSent' };
}

/** What the composing ops (lifecycle-compose.ts) read of this projection. */
function composeRun(run: Run): ComposeRun {
  return {
    trx: run.trx, tenantId: run.tenantId, requestId: run.requestId, rev: run.body.rev, chatId: run.row?.chat_id ?? null,
    stage: run.row?.stage ?? '', currentTaskId: run.currentTaskId, moves: run.moves,
  };
}

async function runOp(run: Run, op: ProjectionOp): Promise<ProjectionOpResult> {
  if (op.op !== 'createRequest' && !run.row) refuse('REQUEST_NOT_FOUND', `Request ${run.requestId} is not open in this tenant`, 404);
  switch (op.op) {
    case 'createRequest': return createRequest(run, op);
    case 'createRound': return createRound(run, op);
    case 'transition': return transitionAndClaim(run, op);
    case 'closeQuestion': return closeQuestion(run, op);
    case 'recordDraftSent':
    case 'recordQuestionSent': return recordSent(run, op);
    case 'recordOutcome': {
      const task = await requestTask(run, op.taskId);
      const { derivedStage, ...result } = await recordOutcomeIn(composeRun(run), task, op);
      run.derivedStage = derivedStage;
      return result;
    }
    case 'recordRequesterAction': return recordRequesterActionIn(composeRun(run), await requestTask(run, op.taskId), op);
    case 'composeReminder': return composeReminderIn(composeRun(run), await requestTask(run, op.taskId), op);
    case 'recordApproval': return recordApproval(run, op);
    case 'bridgeCapturedRevision': return bridgeCapturedRevision(run, op);
    case 'prepareRedrive': return prepareRedrive(run, op);
    case 'recordDelivery': return recordDelivery(run, op);
    default: return refuse('INVALID_OP', `Unknown op ${(op as { op: string }).op}`);
  }
}

const pgCode = (err: unknown): string => String((err as { code?: unknown })?.code ?? '');
const unavailable = (err: unknown): boolean =>
  ['57P01', '57P02', '57P03', '08000', '08003', '08006', '53300'].includes(pgCode(err)) ||
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|Connection terminated|timeout exceeded when trying to connect/i.test(String((err as Error)?.message ?? err));

/** Applies one projection. */
export async function applyProjection(db: Kysely<Database>, requestId: string, body: ProjectionRequest): Promise<ProjectionAnswer> {
  const hash = projectionHash(body);
  try {
    return await withRlsContext(db, { tenantId: body.tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
      // One projection of a request at a time, including the one that opens it (no row to lock yet).
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle:${requestId}`}, 0))`.execute(trx);
      const row = (await sql<RequestRow>`SELECT tenant_id::text, rev::text, stage, owner, current_task_id::text, chat_id FROM hawa.requests
        WHERE request_id = ${requestId}::uuid FOR UPDATE`.execute(trx)).rows[0] ?? null;
      const pgRev = row ? Number(row.rev) : 0;

      const recorded = (await sql<{ request_hash: string; result: ProjectionResponse }>`SELECT request_hash, result FROM hawa.lifecycle_projections
        WHERE tenant_id = ${body.tenantId}::uuid AND idempotency_key = ${body.key}`.execute(trx)).rows[0];
      if (recorded) {
        if (recorded.request_hash !== hash) throw new Refusal(409, 'KEY_REUSED', 'This key was projected before with other ops', { code: 'KEY_REUSED', pgRev, expectedRev: body.expectedRev, rev: body.rev });
        const stored = typeof recorded.result === 'string' ? (JSON.parse(recorded.result) as ProjectionResponse) : recorded.result;
        return { ok: true as const, response: { ...stored, status: 'replayed' as const }, createdTaskIds: [], moves: [] };
      }
      if (pgRev !== body.expectedRev) {
        const code = pgRev > body.expectedRev ? 'AHEAD' : 'STALE_REVISION';
        throw new Refusal(409, code, `Postgres holds request ${requestId} at revision ${pgRev}, not ${body.expectedRev}`, { code, pgRev, expectedRev: body.expectedRev, rev: body.rev });
      }
      if (row && row.owner !== 'restate') refuse('NOT_LIFECYCLE_OWNED', `Request ${requestId} is Core's`);

      const run: Run = { trx, tenantId: body.tenantId, requestId, body, row, currentTaskId: row?.current_task_id ?? null, results: [], createdTaskIds: [], moves: [] };
      for (const op of body.ops) run.results.push(await runOp(run, op));
      if (!run.row) refuse('REQUEST_NOT_FOUND', `Request ${requestId} is not open in this tenant`, 404);

      const stage = (body.stage ?? run.derivedStage ?? run.row!.stage) as LifecycleStage;
      await sql`UPDATE hawa.requests SET rev = ${body.rev}, stage = ${stage}, current_task_id = ${run.currentTaskId}::uuid
        WHERE request_id = ${requestId}::uuid`.execute(trx);
      const response: ProjectionResponse = { v: 1, status: 'applied', rev: body.rev, stage, results: run.results };
      await sql`INSERT INTO hawa.lifecycle_projections (tenant_id, request_id, rev, idempotency_key, request_hash, result)
        VALUES (${body.tenantId}::uuid, ${requestId}::uuid, ${body.rev}, ${body.key}, ${hash}, ${JSON.stringify(response)}::jsonb)`.execute(trx);
      return { ok: true as const, response, createdTaskIds: run.createdTaskIds, moves: run.moves };
    });
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, status: err.status, code: err.code, message: err.message, ...(err.conflict ? { conflict: err.conflict } : {}) };
    const code = pgCode(err);
    // A request id another tenant holds (invisible here), or a key written by a projection at once.
    if (code === '23505') return { ok: false, status: 409, code: 'REQUEST_ID_TAKEN', message: 'A row this projection writes exists already where this tenant cannot see it' };
    if (code === '42501') return { ok: false, status: 403, code: 'FORBIDDEN_BY_POLICY', message: 'Row-level security refused this projection for the tenant' };
    if (code === '23503' || code === '23514' || code === '22P02') return { ok: false, status: 422, code: 'INVALID_OP', message: String((err as Error).message).slice(0, 300) };
    if (unavailable(err)) return { ok: false, status: 503, code: 'DATABASE_UNAVAILABLE', message: String((err as Error).message).slice(0, 300) };
    return { ok: false, status: 500, code: 'PROJECTION_FAILED', message: String((err as Error)?.message ?? err).slice(0, 300) };
  }
}

/** GET /v1/internal/lifecycle/:requestId: the request as Postgres has it. */
export async function readLifecycleRecord(db: Kysely<Database>, requestId: string, tenantId: string): Promise<LifecycleRecord | null> {
  return withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
    const r = (await sql<{ tenant_id: string; owner: string; stage: string; rev: string; root_task_id: string; current_task_id: string; parent_request_id: string | null; chat_id: string | null; draft_sent_at: Date | null; question_asked_at: Date | null }>`
      SELECT tenant_id::text, owner, stage, rev::text, root_task_id::text, current_task_id::text, parent_request_id::text, chat_id, draft_sent_at, question_asked_at
      FROM hawa.requests WHERE request_id = ${requestId}::uuid`.execute(trx)).rows[0];
    if (!r) return null;
    const tasks = (await sql<{ id: string; state: string; version: string }>`SELECT id::text, state::text, version::text FROM hawa.tasks
      WHERE tenant_id = ${tenantId}::uuid AND request_id = ${requestId}::uuid ORDER BY created_at, id`.execute(trx)).rows;
    const last = (await sql<{ rev: string; idempotency_key: string; applied_at: Date }>`SELECT rev::text, idempotency_key, applied_at FROM hawa.lifecycle_projections
      WHERE tenant_id = ${tenantId}::uuid AND request_id = ${requestId}::uuid ORDER BY rev DESC LIMIT 1`.execute(trx)).rows[0];
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    return {
      v: 1, requestId, tenantId: r.tenant_id, owner: r.owner as LifecycleRecord['owner'], stage: r.stage as LifecycleStage, rev: Number(r.rev),
      rootTaskId: r.root_task_id, currentTaskId: r.current_task_id, parentRequestId: r.parent_request_id, chatId: r.chat_id,
      draftSentAt: iso(r.draft_sent_at), questionAskedAt: iso(r.question_asked_at),
      tasks: tasks.map((t) => ({ id: t.id, state: t.state, version: Number(t.version) })),
      lastProjection: last ? { rev: Number(last.rev), key: last.idempotency_key, appliedAt: iso(last.applied_at)! } : null,
    };
  });
}
