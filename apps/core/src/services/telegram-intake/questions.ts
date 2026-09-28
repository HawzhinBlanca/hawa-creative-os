/**
 * The questions a design run asks before it makes a change (edit stage, NEEDS_CLARIFICATION), and
 * the requester's answers, tapped or typed. Moved unchanged from app.ts (architecture programme 1.3,
 * SPLIT_PLAN.md G9).
 */
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext } from '@hawa/db';
import { escapeTelegramHtml } from '@hawa/integrations';
import { cutText, isValidUuid } from '../../core-helpers.js';
import { DEFAULT_TENANT_ID, type CoreContext } from '../../core-context.js';
import { log } from '../../logging.js';
import { persistChatIntake, PICTURE_ONLY_DIRECTIVE } from '../chat-intake.js';
import { LegacyTelegramRequestRefused } from '../legacy-telegram-scope.js';
import { composeAnswerTaken } from '../requester-actions.js';
import { createTelegramUpdateState } from './update-state.js';

/** The parts of a task's task.created payload a revision or another size of it is made from (chat-intake.ts). */
export interface TaskCreatedPayload {
  sourceChannelId?: string;
  rawRequestText?: string;
  clientId?: string | null;
  headlineEn?: string | null;
  headlineCkb?: string | null;
  copyEn?: string | null;
  copyCkb?: string | null;
  designInstructions?: string;
  exactCopy?: unknown[];
  variant?: { width: number; height: number };
  designStudio?: boolean;
  studioOptions?: Record<string, unknown>;
}

export interface PendingQuestion {
  taskId: string;
  title: string | null;
  /** The waiting revision's own task.created payload: everything a revision of the same design needs. */
  payload: TaskCreatedPayload;
  question: string;
  options: string[];
}

export type TelegramQuestions = ReturnType<typeof createTelegramQuestions>;

export function createTelegramQuestions(deps: Pick<CoreContext, 'db' | 'telegramBridge' | 'broadcastEvent'>) {
  const { db, telegramBridge, broadcastEvent: broadcast } = deps;
  const { markTelegramUpdateHandled } = createTelegramUpdateState(deps);

  /**
   * Where a reply to a question message goes once the question is no longer waiting (answered, out of
   * date, or its task was closed): the newest live version of the design the question was about (the
   * answer's revision, or a newer change), else that design itself. A question's task has no design
   * of its own, so a reply read as a change to it started a whole new paid design (2026-09-24 review).
   * Null for a task that never asked a question.
   */
  async function questionFollowUp(taskId: string): Promise<string | null> {
    if (!db || !isValidUuid(taskId)) return null;
    const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ parent: string | null; newest: string | null }>`SELECT o.payload->'studioOptions'->>'parentTaskId' AS parent,
          (SELECT n.id::text FROM hawa.tasks n JOIN hawa.outbox_commands no ON no.aggregate_id = n.id AND no.command_type = 'task.created'
            WHERE n.tenant_id = t.tenant_id AND n.id <> t.id
              AND no.payload->'studioOptions'->>'parentTaskId' = o.payload->'studioOptions'->>'parentTaskId'
              AND COALESCE(no.payload->'studioOptions'->>'reformat', '') = ''
              AND n.state NOT IN ('cancelled', 'rejected', 'failed_operator', 'paused')
            ORDER BY n.created_at DESC LIMIT 1) AS newest
        FROM hawa.tasks t
        JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.tenant_id = t.tenant_id AND o.command_type = 'task.created'
        JOIN LATERAL (SELECT stages FROM hawa.design_studio_runs x WHERE x.tenant_id = t.tenant_id AND x.task_id = t.id ORDER BY x.created_at DESC LIMIT 1) r ON true
        WHERE t.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND t.id = ${taskId}::uuid
          AND r.stages->'directed'->>'refused' = 'NEEDS_CLARIFICATION'
        ORDER BY o.created_at DESC LIMIT 1`.execute(trx)).rows[0]);
    if (!row) return null;
    const next = row.newest || row.parent;
    return next && isValidUuid(next) ? next : null;
  }

  /**
   * The question a task is waiting on (edit stage, NEEDS_CLARIFICATION): its latest studio run
   * stopped to ask it, the task is paused for the answer, and the task came from this chat. Null
   * otherwise, including once it has been answered (the task is then closed).
   */
  async function pendingQuestion(taskId: string, chat: string): Promise<PendingQuestion | null> {
    if (!db || !isValidUuid(taskId) || !chat) return null;
    const row = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
      (await sql<{ title: string | null; state: string; payload: unknown; stages: unknown; answered: boolean; superseded: boolean }>`SELECT t.title, t.state::text AS state, o.payload, r.stages,
          -- Already answered, even if closing this task did not go through.
          EXISTS (SELECT 1 FROM hawa.outbox_commands a WHERE a.tenant_id = t.tenant_id AND a.command_type = 'task.created'
            AND a.payload->'studioOptions'->>'answers' = t.id::text) AS answered,
          -- A newer change to the same design exists: this question is out of date.
          EXISTS (SELECT 1 FROM hawa.tasks n JOIN hawa.outbox_commands no ON no.aggregate_id = n.id AND no.command_type = 'task.created'
            WHERE n.tenant_id = t.tenant_id AND n.id <> t.id AND n.created_at > t.created_at
              AND no.payload->'studioOptions'->>'parentTaskId' = o.payload->'studioOptions'->>'parentTaskId'
              AND COALESCE(no.payload->'studioOptions'->>'reformat', '') = ''
              AND n.state NOT IN ('cancelled', 'rejected', 'failed_operator')) AS superseded
        FROM hawa.tasks t
        JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.tenant_id = t.tenant_id AND o.command_type = 'task.created'
        JOIN LATERAL (SELECT stages FROM hawa.design_studio_runs x WHERE x.tenant_id = t.tenant_id AND x.task_id = t.id ORDER BY x.created_at DESC LIMIT 1) r ON true
        WHERE t.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND t.id = ${taskId}::uuid
        ORDER BY o.created_at DESC LIMIT 1`.execute(trx)).rows[0]);
    if (!row || row.state !== 'paused' || row.answered || row.superseded) return null;
    const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {}) as TaskCreatedPayload;
    const stages = (typeof row.stages === 'string' ? JSON.parse(row.stages) : row.stages || {}) as { directed?: { refused?: unknown; clarify?: { question?: unknown; options?: unknown } } };
    const clarify = stages?.directed?.refused === 'NEEDS_CLARIFICATION' ? stages.directed.clarify : undefined;
    if (!clarify || typeof clarify.question !== 'string' || !Array.isArray(clarify.options)) return null;
    if (String(payload.sourceChannelId || '') !== chat) return null;
    const options = payload.studioOptions || {};
    if (typeof options.parentTaskId !== 'string' || typeof options.revisionDirective !== 'string') return null;
    return {
      taskId,
      title: row.title,
      payload,
      question: clarify.question,
      options: clarify.options.filter((o: unknown): o is string => typeof o === 'string' && o.trim() !== ''),
    };
  }

  /**
   * The requester's answer to a question asked before their change was made: the change starts again
   * with the answer in it, as a new revision of the same design (the waiting task's own payload, so
   * it carries the same copy, photos, reference and round), and is never asked about again. The
   * waiting task is closed. The answer is a tapped option or their own words in reply.
   */
  async function answerQuestion(input: { chat: string; pending: PendingQuestion; answer: string; updateId: string; rawJson: unknown; referenceImageBase64?: string }): Promise<{ ok: boolean; revisionTaskId?: string }> {
    const { pending, chat } = input;
    type Outbound = Parameters<NonNullable<typeof telegramBridge>['dispatchOutboundMessage']>[1];
    const send = (message: { text: string; parse_mode: 'HTML' }) => telegramBridge?.dispatchOutboundMessage(chat, message as Outbound).catch(() => undefined);
    // A picture sent as the answer, with no words, is the answer: "the attached picture".
    const pictureOnly = Boolean(input.referenceImageBase64) && input.answer.trim() === PICTURE_ONLY_DIRECTIVE;
    const answer = pictureOnly ? 'the attached picture' : cutText(input.answer.replace(/\s+/g, ' ').trim(), 500);
    const payload = pending.payload;
    const options = payload.studioOptions as Record<string, unknown>;
    const directive = `${String(options.revisionDirective).trim()}\n\nAsked "${pending.question}", the client answered: ${answer}`;
    try {
      const persisted = await persistChatIntake(db!, {
        platform: 'telegram',
        sourceEventId: `${input.updateId}_answer_${pending.taskId}`,
        sourceChannelId: chat,
        rawText: String(payload.rawRequestText || pending.title || 'Design'),
        rawJson: input.rawJson,
        clientId: typeof payload.clientId === 'string' ? payload.clientId : null,
        title: pending.title || 'Design (Revision)',
        headlineEn: payload.headlineEn || undefined,
        headlineCkb: payload.headlineCkb || undefined,
        copyEn: payload.copyEn || undefined,
        copyCkb: payload.copyCkb || undefined,
        designInstructions: `${String(payload.designInstructions || '')}\nAnswer to "${pending.question}": ${answer}`.trim(),
        exactCopy: Array.isArray(payload.exactCopy) ? payload.exactCopy : [],
        autoGenerate: true,
        ...(payload.variant ? { variant: payload.variant } : {}),
        ...(typeof payload.designStudio === 'boolean' ? { designStudio: payload.designStudio } : {}),
        studioOptions: {
          ...options,
          revisionDirective: directive,
          clarified: true,
          answers: pending.taskId,
          ...(input.referenceImageBase64 ? { referenceImageBase64: input.referenceImageBase64 } : {}),
        },
      });
      if (persisted.autoGenerateDeclined) {
        await send({
          text: `👍 <b>Got it:</b> ${escapeTelegramHtml(cutText(answer, 300))}\n\n⏳ <i>The daily limit for automatic drafts has been reached for this chat. Your change is saved and queued for the art director in Hawa Desk.</i>\n\n🆔 Task ID: <code>${escapeTelegramHtml(persisted.task.id)}</code>`,
          parse_mode: 'HTML',
        });
      } else {
        await send(composeAnswerTaken(answer, persisted.task.id));
      }
      const { closeAnsweredQuestion } = await import('../canva-task-outcome.js');
      await withRlsContext(db!, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
        closeAnsweredQuestion(trx, { tenantId: DEFAULT_TENANT_ID, taskId: pending.taskId, revisionTaskId: persisted.task.id })
      ).catch((err) => log.warn(`[Core] Task ${pending.taskId}: answered, but could not be closed:`, err));
      await markTelegramUpdateHandled(chat, input.updateId, 'telegram_requester_answer', { taskId: pending.taskId, revisionTaskId: persisted.task.id });
      broadcast('task:created', persisted.task);
      return { ok: true, revisionTaskId: persisted.task.id };
    } catch (err) {
      if (err instanceof LegacyTelegramRequestRefused) throw err;
      // Nothing is sent from here: a tapped answer is told in its pop-up, and a typed one is retried
      // with the update (a message here would repeat on every retry).
      log.error(`[Core] Task ${pending.taskId}: the answer to its question could not be saved:`, err);
      return { ok: false };
    }
  }

  return { questionFollowUp, pendingQuestion, answerQuestion };
}
