/**
 * The projection ops that need Core's composition (architecture programme Phase 2, slice 2.3 part C;
 * PHASE2_DESIGN.md sections 2.3 and 2.8): a design outcome, a requester's button, a reminder. Each is
 * the legacy path's own logic with its sends taken out: what the requester and the office are told
 * comes back as messages, which the RequestLifecycle object hands to TelegramSender, and nothing here
 * talks to Telegram.
 *
 * - recordOutcome is canvaStatusHandler (routes/canva-outcome.routes.ts): the draft becomes the Desk's
 *   revision with its QC run, the task moves to review (or waits on a question, or goes to an
 *   operator), and the requester's message, the draft's picture (by reference to its stored export,
 *   never its bytes) and the office's alerts are composed.
 * - recordRequesterAction is handleRequesterAction (telegram-intake/requester-actions.ts): approve,
 *   change, a designer, another size, and the answer to a button on a draft that is not current.
 * - composeReminder is the reminder pass (draft-reminders.ts) for one draft or question and day, skipped
 *   when the requester wrote in the chat since it was sent.
 *
 * Everything runs inside the projection's transaction (its tenant context and its lock on the
 * request), so an op that fails rolls the whole projection back and the worker asks again.
 */
import { questionIdOf, type DraftIntake, type LifecycleMessage, type LifecycleStage, type ProjectionOp, type ProjectionOpResult } from '@hawa/contracts';
import { RevisionRepository, sql, type Database, type Kysely } from '@hawa/db';
import { stageAfterOutcome } from '@hawa/domain';
import { chaosPoint } from '@hawa/observability';
import { evaluateCanvaExportQc } from '../core-helpers.js';
import { log } from '../logging.js';
import { bridgeCanvaDraftRevision, outcomeHasDraft, transitionTaskForOutcome, type OutcomeState } from './canva-task-outcome.js';
import { composeCanvaStatusMessage, composeChangeNeedsDesignerAlert } from './canva-status-message.js';
import { studioStatusNote, requesterDraftNotes, type StudioStatusNoteInput } from './design-studio/studio-status-note.js';
import {
  OTHER_SIZES,
  composeChangeInProgress,
  composeChangePrompt,
  composeDesignerHandoff,
  composeDesignerTakesOver,
  composeReplacedDraft,
  composeRequesterApproved,
  composeRequesterApprovedAlert,
  type AskRecord,
  type SizeAction,
} from './requester-actions.js';
import { composeDraftReminder, composeQuestionReminder } from './draft-reminders.js';
import { runsPipelineV3 } from './chat-intake.js';

/** What an op of this module reads from the projection it runs in. */
export interface ComposeRun {
  trx: Kysely<Database>;
  tenantId: string;
  requestId: string;
  /** The revision this projection writes: message keys carry it, so a replay composes the same keys. */
  rev: number;
  chatId: string | null;
  stage: string;
  currentTaskId: string | null;
  moves: Array<{ taskId: string; from: string; to: string; version: number }>;
}

export interface ComposeTask {
  id: string;
  state: string;
  version: number;
  title: string;
  client_id: string | null;
}

/** The office chat (the first TELEGRAM_ALLOWED_USERS entry): the one that hears what a person must do. */
export function officeChatId(): string | null {
  return (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((v) => v.trim()).find(Boolean) || null;
}

type Reply = { text: string; parse_mode?: 'HTML'; reply_markup?: unknown };

/** What a studio run records of a directed edit (edit.stage.ts), as far as the outcome reads it. */
interface StudioStages {
  directed?: {
    refused?: unknown;
    clarify?: { question?: unknown; options?: unknown };
    asks?: unknown;
    frustrated?: unknown;
  };
}

/** A composed Telegram message as a lifecycle message: one key, one chat, critical unless said otherwise. */
export function messageOf(key: string, chatId: string, reply: Reply, extra: Partial<LifecycleMessage> & { tenantId: string; taskId?: string }): LifecycleMessage {
  return {
    v: 1, key, chatId, kind: 'text', text: reply.text, class: 'critical',
    ...(reply.parse_mode ? { parseMode: reply.parse_mode } : {}),
    ...(reply.reply_markup ? { replyMarkup: reply.reply_markup } : {}),
    ...extra,
  };
}

/**
 * An alert to the office, keyed as the legacy outbox keyed it (`notify.office:<reason>`), and not sent
 * when the office chat is the requester's own: they read the requester's message already.
 */
function officeAlert(run: ComposeRun, reason: string, taskId: string, reply: Reply): LifecycleMessage | null {
  const office = officeChatId();
  if (!office || office === run.chatId) return null;
  return messageOf(`notify.office:${reason}`, office, reply, { tenantId: run.tenantId, taskId });
}

const parsed = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return v as T;
};

async function taskCreatedPayload(run: ComposeRun, taskId: string): Promise<Record<string, any>> {
  const row = (await sql<{ payload: unknown }>`SELECT payload FROM hawa.outbox_commands WHERE tenant_id = ${run.tenantId}::uuid
    AND aggregate_id = ${taskId}::uuid AND command_type = 'task.created' ORDER BY created_at LIMIT 1`.execute(run.trx)).rows[0];
  return parsed<Record<string, any>>(row?.payload, {});
}

/** The Canva design bound to a task, for the office's alerts. */
async function canvaUrlOf(run: ComposeRun, taskId: string): Promise<string | undefined> {
  const row = (await sql<{ edit_url: string | null }>`SELECT edit_url FROM hawa.canva_bindings WHERE tenant_id = ${run.tenantId}::uuid
    AND task_id = ${taskId}::uuid AND status = 'bound' ORDER BY created_at DESC LIMIT 1`.execute(run.trx)).rows[0];
  return row?.edit_url || undefined;
}

/** What was asked of a design across its rounds (ask-history.ts's query), inside the projection. */
async function askHistoryIn(run: ComposeRun, taskId: string): Promise<{ asks: AskRecord[]; rounds: number }> {
  const rows = (await sql<{ asks: unknown; depth: number; reformat: boolean }>`WITH RECURSIVE chain(id, depth) AS (
      SELECT ${taskId}::uuid, 0
      UNION ALL
      SELECT (o.payload->'studioOptions'->>'parentTaskId')::uuid, chain.depth + 1
      FROM chain JOIN hawa.outbox_commands o ON o.aggregate_id = chain.id AND o.command_type = 'task.created'
      WHERE o.tenant_id = ${run.tenantId}::uuid
        AND o.payload->'studioOptions'->>'parentTaskId' ~ '^[0-9a-f-]{36}$' AND chain.depth < 12
    )
    SELECT r.stages->'directed'->'asks' AS asks, chain.depth,
      EXISTS (SELECT 1 FROM hawa.outbox_commands f WHERE f.aggregate_id = chain.id AND f.command_type = 'task.created'
        AND COALESCE(f.payload->'studioOptions'->>'reformat', '') <> '') AS reformat
    FROM chain
    LEFT JOIN hawa.design_studio_runs r ON r.task_id = chain.id AND r.tenant_id = ${run.tenantId}::uuid
    ORDER BY chain.depth DESC, r.created_at`.execute(run.trx)).rows;
  const asks: AskRecord[] = [];
  for (const row of rows) {
    for (const a of Array.isArray(row.asks) ? (row.asks as Array<Record<string, unknown>>) : []) {
      if (typeof a?.ask === 'string' && a.ask.trim()) asks.push({ ask: a.ask.trim(), status: String(a.status || ''), ...(typeof a.reason === 'string' && a.reason ? { reason: a.reason } : {}) });
    }
  }
  const deepest = rows.reduce((m, r) => Math.max(m, Number(r.depth) || 0), 0);
  const changes = new Set(rows.filter((r) => Number(r.depth) < deepest && !r.reformat).map((r) => Number(r.depth)));
  return { asks, rounds: changes.size };
}

/** The question a task's latest studio run stopped to ask (edit stage, NEEDS_CLARIFICATION), if any. */
async function studioQuestionOf(run: ComposeRun, taskId: string): Promise<{ question: string; options: string[] } | undefined> {
  const row = (await sql<{ stages: unknown }>`SELECT stages FROM hawa.design_studio_runs WHERE tenant_id = ${run.tenantId}::uuid
    AND task_id = ${taskId}::uuid ORDER BY created_at DESC LIMIT 1`.execute(run.trx)).rows[0];
  const stages = parsed<StudioStages>(row?.stages, {});
  const clarify = stages?.directed?.refused === 'NEEDS_CLARIFICATION' ? stages.directed.clarify : undefined;
  if (!clarify || typeof clarify.question !== 'string' || !Array.isArray(clarify.options)) return undefined;
  return { question: clarify.question, options: clarify.options.filter((o: unknown): o is string => typeof o === 'string' && o.trim() !== '') };
}

// ---------------------------------------------------------------------------------------------
// recordOutcome

const clean = (v: unknown) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64) : undefined);

export async function recordOutcomeIn(run: ComposeRun, task: ComposeTask, op: Extract<ProjectionOp, { op: 'recordOutcome' }>): Promise<Extract<ProjectionOpResult, { op: 'recordOutcome' }> & { derivedStage: LifecycleStage }> {
  const report = (op.report && typeof op.report === 'object' ? op.report : {}) as Record<string, unknown>;
  const status = clean(report.status) || 'DRAFT_READY';
  const code = clean(report.code);
  const designId = typeof report.designId === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(report.designId) ? report.designId : undefined;
  const canvaUrl = designId ? `https://www.canva.com/design/${designId}/edit` : undefined;
  const detail = typeof report.detail === 'string' ? report.detail.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500) : undefined;
  const source = await taskCreatedPayload(run, task.id);
  const taskId = task.id;

  // A Sorani draft set in a provisional typeface is said with the result (ADR-028).
  const notes: string[] = [];
  const manifest = parsed<{ rtlFontProvisional?: unknown; rtlFont?: unknown } | null>((await sql<{ manifest: unknown }>`SELECT result->'manifest' AS manifest FROM hawa.canva_design_plans
    WHERE tenant_id = ${run.tenantId}::uuid AND task_id = ${taskId}::uuid AND status NOT IN ('failed','abandoned')
    ORDER BY created_at DESC LIMIT 1`.execute(run.trx)).rows[0]?.manifest, null);
  if (manifest?.rtlFontProvisional && typeof manifest?.rtlFont === 'string') {
    notes.push(`Kurdish text is set in a provisional typeface (${manifest.rtlFont}) until the brand's Kurdish font is confirmed by the art director.`);
  }

  // What the studio run recorded: its notes for the requester, the asks no edit can make, the
  // question it stopped to ask, and whether the requester read as losing patience.
  let notPossible: Array<{ ask: string; reason: string }> = [];
  let question: { question: string; options: string[] } | undefined;
  let frustrated = false;
  const studioRun = (await sql<StudioStatusNoteInput['run'] & { id: string }>`SELECT * FROM hawa.design_studio_runs WHERE tenant_id = ${run.tenantId}::uuid AND task_id = ${taskId}::uuid
    ORDER BY created_at DESC LIMIT 1`.execute(run.trx)).rows[0];
  if (studioRun) {
    const candidates = (await sql<StudioStatusNoteInput['candidates'][number]>`SELECT * FROM hawa.design_studio_candidates WHERE tenant_id = ${run.tenantId}::uuid AND run_id = ${studioRun.id}::uuid
      ORDER BY ordinal ASC`.execute(run.trx)).rows;
    log.info(`[lifecycle] Task ${taskId} studio summary: ${studioStatusNote({ run: studioRun, candidates, parityNote: '', models: [] })}`);
    notes.push(...requesterDraftNotes({ run: studioRun, candidates }));
    const stages = parsed<StudioStages>(studioRun.stages, {});
    const asks = Array.isArray(stages?.directed?.asks) ? stages.directed.asks : [];
    notPossible = (asks as Array<{ ask?: unknown; status?: unknown; reason?: unknown } | null>)
      .filter((a) => a?.status === 'not_possible' && typeof a?.ask === 'string' && a.ask.trim())
      .map((a) => ({ ask: String(a!.ask).trim(), reason: typeof a!.reason === 'string' ? a!.reason.trim() : '' }));
    const clarify = stages?.directed?.refused === 'NEEDS_CLARIFICATION' ? stages.directed.clarify : undefined;
    if (clarify && typeof clarify.question === 'string' && Array.isArray(clarify.options)) {
      question = { question: clarify.question, options: clarify.options.filter((o: unknown): o is string => typeof o === 'string' && o.trim() !== '') };
    }
    frustrated = stages?.directed?.frustrated === true;
  }

  let hasDraft = outcomeHasDraft(status, designId);
  const waitingForAnswer = !hasDraft && code === 'NEEDS_CLARIFICATION' && Boolean(question) && question!.options.length >= 2;
  let outcomeState: OutcomeState = hasDraft ? 'human_review' : waitingForAnswer ? 'paused' : 'failed_operator';
  let outcomeReason = hasDraft
    ? `Canva draft delivered (${status})${designId ? ` as ${designId}` : ''}; awaiting visual review.`
    : waitingForAnswer
      ? `A question was sent to the requester before the change is made: ${question!.question}`
      : `Automatic draft ended ${status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}. An operator has to follow up.`;

  if (hasDraft) {
    // A draft that cannot be recorded as the Desk's revision goes to an operator, as it does on the
    // legacy path; the savepoint keeps the rest of the projection when the bridge fails.
    await sql`SAVEPOINT lifecycle_bridge`.execute(run.trx);
    try {
      const bridged = await bridgeCanvaDraftRevision(run.trx, { revisionRepo: new RevisionRepository(run.trx), evaluateQc: evaluateCanvaExportQc }, {
        tenantId: run.tenantId, taskId, actorId: null, status, designId, canvaUrl,
        fallbackCopy: source.exactCopy, reason: outcomeReason,
      });
      await sql`RELEASE SAVEPOINT lifecycle_bridge`.execute(run.trx);
      if (bridged.created && bridged.transition.changed) {
        run.moves.push({ taskId, from: bridged.transition.fromState, to: bridged.transition.toState, version: bridged.transition.version });
      }
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT lifecycle_bridge`.execute(run.trx);
      log.error(`[lifecycle] Task ${taskId}: Canva draft ${designId || '(no design id)'} (${status}) could NOT be recorded as a Desk revision; the task goes to an operator:`, err);
      hasDraft = false;
      outcomeState = 'failed_operator';
      outcomeReason = `Canva draft ${designId || '(no design id)'} exists (${status}) but its Desk revision could not be recorded: ${String((err as Error)?.message || err).slice(0, 300)}`;
    }
  }
  // Chaos suite point: the draft is bridged, nothing is committed; a Core killed here rolls it all back.
  await chaosPoint('core.outcome.after-bridge', { requestId: run.requestId, taskId, status });

  const moved = await transitionTaskForOutcome(run.trx, {
    tenantId: run.tenantId, taskId, toState: outcomeState, actorId: null, reason: outcomeReason,
    data: { outcome: status, requestId: run.requestId, ...(code ? { code } : {}), ...(designId ? { designId } : {}), ...(detail ? { detail } : {}) },
  });
  if (moved.changed) run.moves.push({ taskId, from: moved.fromState, to: moved.toState, version: moved.version });

  const revisionId = hasDraft
    ? (await sql<{ id: string | null }>`SELECT current_design_revision_id::text AS id FROM hawa.tasks WHERE tenant_id = ${run.tenantId}::uuid AND id = ${taskId}::uuid`.execute(run.trx)).rows[0]?.id ?? undefined
    : undefined;

  const messages: LifecycleMessage[] = [];
  const chat = run.chatId;
  const asked = waitingForAnswer ? question : undefined;
  if (chat) {
    const message = composeCanvaStatusMessage({ taskId, title: task.title, status, code, canvaUrl, notes, notPossible, question: asked });
    const what = hasDraft ? 'draft' : asked ? 'question' : undefined;
    messages.push(messageOf(`${run.requestId}:${run.rev}:outcome`, chat, message, {
      tenantId: run.tenantId, taskId, ...(what ? { onSent: { requestId: run.requestId, what, taskId } } : {}),
    }));
    // The draft itself, which the requester looks at and replies to: its caption carries the task id,
    // so a reply to it reaches this round. By reference: TelegramSender reads the bytes and checks them.
    if (hasDraft) {
      const png = (await sql<{ id: string; sha256: string }>`SELECT id::text, sha256 FROM hawa.canva_export_bytes
        WHERE tenant_id = ${run.tenantId}::uuid AND task_id = ${taskId}::uuid AND format = 'png'
        ORDER BY created_at DESC LIMIT 1`.execute(run.trx)).rows[0];
      if (png) {
        messages.push({
          v: 1, key: `${run.requestId}:${run.rev}:outcome:photo`, chatId: chat, kind: 'photo', class: 'critical', tenantId: run.tenantId, taskId,
          exportRef: { tenantId: run.tenantId, taskId, artifactId: png.id, sha256: png.sha256 },
          caption: `🎨 Canva draft · Task ID: ${taskId}\nReply to this image with any change you want.`,
        });
      }
    }
    const runKey = op.runId || designId || 'no-run';
    if (notPossible.length > 0) {
      const alert = officeAlert(run, `change-needs-designer:${taskId}:${runKey}`, taskId, composeChangeNeedsDesignerAlert({ taskId, title: task.title, asks: notPossible, draftSent: hasDraft }));
      if (alert) messages.push(alert);
    }
    if (frustrated) {
      const history = await askHistoryIn(run, taskId);
      const alert = officeAlert(run, `frustrated:${taskId}`, taskId, composeDesignerHandoff({ taskId, title: task.title, canvaUrl, asks: history.asks, rounds: history.rounds, why: 'frustrated' }));
      if (alert) messages.push(alert);
    }
  }

  const derivedStage = stageAfterOutcome({ hasDraft, question: asked });
  return {
    op: 'recordOutcome', hasDraft, toState: outcomeState, stage: derivedStage, messages, derivedStage,
    ...(revisionId ? { revisionId } : {}),
    ...(designId ? { designId } : {}),
    ...(asked ? { question: { id: questionIdOf(taskId), question: asked.question, options: asked.options } } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// recordRequesterAction

/** The requester's button, recorded as the legacy path records it (askHistory, the Desk's history read it). */
async function markRequesterAction(run: ComposeRun, action: string, record: Record<string, unknown>): Promise<void> {
  const id = `lc:${run.requestId}:${run.rev}:requester`;
  const text = JSON.stringify(record);
  await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
    SELECT ${run.tenantId}::uuid, 'telegram', ${id}, ${`telegram_requester_${action}`}, ${text}::jsonb, md5(${text}), true
    WHERE NOT EXISTS (SELECT 1 FROM hawa.inbox_events WHERE tenant_id = ${run.tenantId}::uuid AND source_account_id = 'telegram' AND source_event_id = ${id})`.execute(run.trx);
}

/** The draft of the same design in another size, from the design's own task.created payload (makeOtherSize). */
function sizeDraftOf(task: ComposeTask, payload: Record<string, any>, action: SizeAction): DraftIntake {
  const size = OTHER_SIZES[action];
  // The design's own options, less what made it a change, and never picture bytes: this is a format of it.
  const { parentTaskId: _p, revisionDirective: _d, clarified: _c, reformat: _r, answers: _a, revisionRound: n, referenceImageBase64: _i, reference: _ref, ...kept } =
    (payload.studioOptions || {}) as Record<string, unknown>;
  void _p; void _d; void _c; void _r; void _a; void _i; void _ref;
  return {
    title: `${String(task.title || 'Design').replace(/ \((Revision|story|square post|landscape banner)[^)]*\)/g, '')} (${size.label})`,
    rawText: String(payload.rawRequestText || task.title || 'Design'),
    clientId: typeof payload.clientId === 'string' ? payload.clientId : task.client_id,
    ...(payload.headlineEn ? { headlineEn: String(payload.headlineEn) } : {}),
    ...(payload.headlineCkb ? { headlineCkb: String(payload.headlineCkb) } : {}),
    ...(payload.copyEn ? { copyEn: String(payload.copyEn) } : {}),
    ...(payload.copyCkb ? { copyCkb: String(payload.copyCkb) } : {}),
    designInstructions: String(payload.designInstructions || ''),
    exactCopy: Array.isArray(payload.exactCopy) ? payload.exactCopy : [],
    autoGenerate: true,
    variant: { width: size.width, height: size.height },
    ...(typeof payload.designStudio === 'boolean' ? { designStudio: payload.designStudio } : {}),
    studioOptions: {
      ...kept,
      parentTaskId: task.id,
      revisionDirective: `The same design as a ${size.label} (${size.width}x${size.height}).`,
      reformat: size.label,
      ...(typeof n === 'number' ? { revisionRound: n } : {}),
    },
  };
}

export async function recordRequesterActionIn(run: ComposeRun, task: ComposeTask, op: Extract<ProjectionOp, { op: 'recordRequesterAction' }>): Promise<Extract<ProjectionOpResult, { op: 'recordRequesterAction' }>> {
  const chat = run.chatId;
  const messages: LifecycleMessage[] = [];
  const key = `${run.requestId}:${run.rev}:requester`;
  const toRequester = (reply: Reply, courtesy = false) => {
    if (chat) messages.push(messageOf(key, chat, reply, { tenantId: run.tenantId, taskId: task.id, ...(courtesy ? { class: 'courtesy' as const } : {}) }));
  };
  const action = op.action === 'size' ? (op.sizeAction || 'size') : op.action;
  await markRequesterAction(run, action, { taskId: task.id, actorId: op.actorId, requestId: run.requestId, ...(op.current ? {} : { current: false }) });

  if (!op.current) {
    // A button or reply on a draft that is not the request's current one acts on nothing: the requester
    // is told whether a newer draft exists or the change is still being made (review of 2026-09-24).
    const newer = run.currentTaskId && run.currentTaskId !== task.id ? run.currentTaskId : null;
    if (!newer) {
      toRequester({ text: 'ℹ️ <b>This design is with the office now.</b>\n\n<i>They will follow up with you here.</i>', parse_mode: 'HTML' }, true);
    } else if (run.stage === 'designing' || run.stage === 'awaiting_answer') {
      toRequester(composeChangeInProgress(newer), true);
    } else {
      toRequester(composeReplacedDraft(newer), true);
    }
    return { op: 'recordRequesterAction', messages };
  }

  const payload = await taskCreatedPayload(run, task.id);
  switch (op.action) {
    case 'ok': {
      const variant = (payload.variant || {}) as { width?: number; height?: number };
      toRequester(composeRequesterApproved(task.id, { width: variant.width ?? 1080, height: variant.height ?? 1350 }, Boolean(chat && runsPipelineV3(chat))));
      const alert = officeAlert(run, `requester-approved:${task.id}`, task.id, composeRequesterApprovedAlert({ taskId: task.id, title: task.title, canvaUrl: await canvaUrlOf(run, task.id) }));
      if (alert) messages.push(alert);
      return { op: 'recordRequesterAction', messages };
    }
    case 'chg':
      toRequester(composeChangePrompt(task.id));
      return { op: 'recordRequesterAction', messages };
    case 'dsg': {
      toRequester(composeDesignerTakesOver(task.id));
      const history = await askHistoryIn(run, task.id);
      const alert = officeAlert(run, `designer-asked:${task.id}`, task.id, composeDesignerHandoff({
        taskId: task.id, title: task.title, canvaUrl: await canvaUrlOf(run, task.id), asks: history.asks, rounds: history.rounds, why: 'asked',
      }));
      if (alert) messages.push(alert);
      return { op: 'recordRequesterAction', messages };
    }
    case 'size': {
      const sizeAction = op.sizeAction as SizeAction | undefined;
      if (!sizeAction || !(sizeAction in OTHER_SIZES)) return { op: 'recordRequesterAction', messages };
      // Only a chat on the v3 pipeline makes sizes; a button from an earlier message is refused out loud.
      if (!chat || !runsPipelineV3(chat)) {
        toRequester({ text: 'ℹ️ Other sizes are not available in this chat. Ask the office for one.' }, true);
        return { op: 'recordRequesterAction', messages };
      }
      return { op: 'recordRequesterAction', messages, childDraft: sizeDraftOf(task, payload, sizeAction) };
    }
    default:
      return { op: 'recordRequesterAction', messages };
  }
}

// ---------------------------------------------------------------------------------------------
// composeReminder

export async function composeReminderIn(run: ComposeRun, task: ComposeTask, op: Extract<ProjectionOp, { op: 'composeReminder' }>): Promise<Extract<ProjectionOpResult, { op: 'composeReminder' }>> {
  const chat = run.chatId;
  if (!chat || !Number.isFinite(op.since)) return { op: 'composeReminder', skip: true, messages: [] };
  // The requester wrote in the chat since the draft or question was sent (a reply, a button, anything):
  // they are not reminded, as the reminder pass never reminded them. The rows the lifecycle's own
  // rounds write (`<chat>:lc-…`) are not the requester writing.
  const wrote = (await sql<{ one: number }>`SELECT 1 AS one FROM hawa.inbox_events WHERE tenant_id = ${run.tenantId}::uuid
    AND source_account_id = 'telegram' AND source_event_id LIKE ${`${chat}:%`} AND source_event_id NOT LIKE ${`${chat}:lc-%`}
    AND received_at > ${new Date(op.since)} LIMIT 1`.execute(run.trx)).rows.length > 0;
  if (wrote) return { op: 'composeReminder', skip: true, messages: [] };
  let reply: Reply;
  if (op.kind === 'question') {
    const q = await studioQuestionOf(run, task.id);
    if (!q || q.options.length < 2) return { op: 'composeReminder', skip: true, messages: [] };
    reply = composeQuestionReminder(task.id, q.question, q.options, op.day);
  } else {
    reply = composeDraftReminder(task.id, task.title, op.day);
  }
  return { op: 'composeReminder', skip: false, messages: [messageOf(`${run.requestId}:reminder:${op.kind}:${op.day}:${task.id}`, chat, reply, { tenantId: run.tenantId, taskId: task.id })] };
}
