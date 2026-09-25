/**
 * The requester's buttons under a draft: approve, change, a designer, another size, an answer to a
 * question (services/requester-actions.ts composes their messages). Moved unchanged from app.ts
 * (architecture programme 1.3, SPLIT_PLAN.md G9).
 */
import type { Context } from 'hono';
import { SYSTEM_AUTOMATION_USER_ID, questionIdOf } from '@hawa/contracts';
import { sql, withRlsContext } from '@hawa/db';
import { escapeTelegramHtml } from '@hawa/integrations';
import { DEFAULT_TENANT_ID, type CoreContext } from '../../core-context.js';
import { log } from '../../logging.js';
import { persistChatIntake, runsPipelineV3 } from '../chat-intake.js';
import { createAskHistory } from '../ask-history.js';
import { createOfficeAlerts } from '../office-alerts.js';
import {
  composeRequesterApproved,
  composeChangePrompt,
  composeDesignerTakesOver,
  composeReplacedDraft,
  composeChangeInProgress,
  composeRequesterApprovedAlert,
  composeDesignerHandoff,
  composeSizeStarted,
  answerIndex,
  sizeOf,
  type RequesterAction,
} from '../requester-actions.js';
import { createTelegramQuestions, type TaskCreatedPayload } from './questions.js';
import { createTelegramUpdateState } from './update-state.js';
import { answerDecision, lifecycleOwnerOf } from './decide-mode.js';

export type TelegramRequesterActions = ReturnType<typeof createTelegramRequesterActions>;

export function createTelegramRequesterActions(
  deps: Pick<CoreContext, 'db' | 'outboxRepo' | 'telegramBridge' | 'problem' | 'broadcastEvent'>
) {
  const { db, telegramBridge, problem, broadcastEvent: broadcast } = deps;
  const { telegramUpdateHandled, markTelegramUpdateHandled } = createTelegramUpdateState(deps);
  const { pendingQuestion, answerQuestion } = createTelegramQuestions(deps);
  const { enqueueOfficeAlert } = createOfficeAlerts(deps);
  const { askHistory } = createAskHistory(deps);

  /**
   * The requester's buttons under a draft (services/requester-actions.ts). None of them approves a
   * design: Approve records the requester's sign-off and tells the office, whose approval in Hawa Desk
   * still delivers (ADR-022). A button works only in the chat the design was made for.
   */
  async function handleRequesterAction(
    c: Context,
    cb: { id: string; from?: { id?: number | string }; message?: { chat?: { id?: number | string } } },
    rq: { action: RequesterAction; taskId: string },
    updateId: string
  ) {
    const chat = String(cb?.message?.chat?.id ?? cb?.from?.id ?? '');
    const answer = (text: string, alert = false) => telegramBridge?.answerCallbackQuery(cb.id, text, alert).catch(() => false);
    type Outbound = Parameters<NonNullable<typeof telegramBridge>['dispatchOutboundMessage']>[1];
    const send = (message: { text: string; parse_mode: 'HTML'; reply_markup?: unknown }) =>
      telegramBridge?.dispatchOutboundMessage(chat, message as Outbound).catch(() => undefined);
    if (!db) {
      await answer('This is not available right now. Please try again in a minute.', true);
      return problem(c, 503, 'Database Unavailable', 'The requester action could not be recorded');
    }
    if (await telegramUpdateHandled(chat, updateId).catch(() => false)) {
      await answer('Done');
      return c.json({ ok: true, duplicate: true, updateId }, 200);
    }
    const scope = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };
    const facts = await withRlsContext(db, scope, async (trx) =>
      (await sql<{ title: string | null; chat: string | null; newer: string | null; canva: string | null; done: boolean; payload: TaskCreatedPayload }>`SELECT t.title,
          o.payload->>'sourceChannelId' AS chat, o.payload,
          (SELECT ct.id::text FROM hawa.tasks ct JOIN hawa.outbox_commands co ON co.aggregate_id = ct.id AND co.command_type = 'task.created'
             WHERE ct.tenant_id = t.tenant_id AND co.payload->'studioOptions'->>'parentTaskId' = ${rq.taskId}
               AND ct.state NOT IN ('cancelled', 'rejected', 'failed_operator', 'paused')
               AND COALESCE(co.payload->'studioOptions'->>'reformat', '') = ''
             ORDER BY ct.created_at DESC LIMIT 1) AS newer,
          (SELECT n.payload->>'canvaUrl' FROM hawa.outbox_commands n WHERE n.tenant_id = t.tenant_id AND n.aggregate_id = t.id
             AND n.command_type = 'notify.telegram' AND n.payload ? 'canvaUrl' ORDER BY n.created_at DESC LIMIT 1) AS canva,
          EXISTS (SELECT 1 FROM hawa.inbox_events e WHERE e.tenant_id = t.tenant_id AND e.event_kind = ${`telegram_requester_${rq.action}`}
             AND e.payload->>'taskId' = ${rq.taskId}) AS done
        FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
        WHERE t.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND t.id = ${rq.taskId}::uuid LIMIT 1`.execute(trx)).rows[0]);
    if (!facts || String(facts.chat || '') !== chat) {
      await answer('This button belongs to a design made for another chat.', true);
      return c.json({ ok: false, reason: 'NOT_THIS_CHAT', taskId: rq.taskId }, 200);
    }
    const chosen = answerIndex(rq.action);
    // A button of a request the lifecycle owns is its to act on (PHASE2_DESIGN.md 2.3), whatever
    // the chat's flag says now: routed, never acted on here as well.
    // A read that fails is a 503 the poller retries (as replies.ts and changes.ts answer it), not a
    // thrown 500 on every button while the database is away.
    let owner: Awaited<ReturnType<typeof lifecycleOwnerOf>>;
    try {
      owner = await lifecycleOwnerOf(db, rq.taskId);
    } catch (err) {
      log.warn('[TelegramIngress] Could not tell whether the button\'s design is the request lifecycle\'s:', err);
      await answer('This is not available right now. Please try again in a minute.', true);
      return problem(c, 503, 'Database Unavailable', 'The owner of the design could not be read; retry');
    }
    if (owner) {
      if (chosen !== undefined) {
        return answerDecision(c, { kind: 'answer', requestId: owner.requestId, questionId: questionIdOf(rq.taskId), answer: { option: chosen + 1 }, callbackQueryId: cb.id });
      }
      return answerDecision(c, {
        kind: 'requester', requestId: owner.requestId, taskId: rq.taskId, action: rq.action as 'ok' | 'chg' | 'dsg' | 'sst' | 'ssq' | 'sls',
        callbackQueryId: cb.id, actorId: String(cb?.from?.id || ''),
      });
    }
    if (chosen !== undefined) {
      const pending = await pendingQuestion(rq.taskId, chat);
      const option = pending?.options[chosen];
      if (!pending || !option) {
        await answer('This question was already answered.');
        return c.json({ ok: true, requesterAction: rq.action, taskId: rq.taskId, already: true }, 200);
      }
      const taken = await answerQuestion({ chat, pending, answer: option, updateId, rawJson: { callback: cb.id, action: rq.action, taskId: rq.taskId } });
      await answer(taken.ok ? '👍 Got it' : 'Your answer was not saved. Please tap it again in a minute.', !taken.ok);
      return c.json({ ok: taken.ok, requesterAction: rq.action, taskId: rq.taskId, revisionTaskId: taken.revisionTaskId }, 200);
    }
    const record = { taskId: rq.taskId, actorId: String(cb?.from?.id || '') };
    // A button on a draft a newer version replaced acts on nothing, sizes included: a size of the old
    // version was made, paid, without its change (review of 2026-09-24). While that newer version is
    // still being made there is no newer draft yet to point to, so that is what the requester is told.
    if (facts.newer && rq.action !== 'dsg') {
      const newer = facts.newer;
      const ready = await withRlsContext(db, scope, async (trx) =>
        (await sql<{ ready: boolean }>`SELECT EXISTS (SELECT 1 FROM hawa.outbox_commands n
            WHERE n.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND n.aggregate_id = ${newer}::uuid AND n.command_type = 'notify.telegram'
              AND n.payload->>'status' = 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW') AS ready`.execute(trx)).rows[0]?.ready === true);
      await answer(ready ? 'A newer version of this design exists.' : 'Your change is still being made.');
      await send(ready ? composeReplacedDraft(newer) : composeChangeInProgress(newer));
      await markTelegramUpdateHandled(chat, updateId, 'telegram_requester_replaced', { ...record, newer, ready });
      return c.json({ ok: true, requesterAction: rq.action, taskId: rq.taskId, replacedBy: newer, newerReady: ready }, 200);
    }
    const size = sizeOf(rq.action);
    if (size && !runsPipelineV3(chat)) {
      // Only offered in a chat on the v3 pipeline, which makes sizes; a button from an earlier message
      // still made one elsewhere (review of 2026-09-24).
      await answer('Other sizes are not available in this chat. Ask the office for one.', true);
      return c.json({ ok: false, requesterAction: rq.action, taskId: rq.taskId, reason: 'SIZES_NOT_AVAILABLE' }, 200);
    }
    if (size) {
      // Another size of this design (plan 4.3): once per size, as its own task and draft.
      if (facts.done) {
        await answer(`The ${size.label} version is already being made.`);
        return c.json({ ok: true, requesterAction: rq.action, taskId: rq.taskId, already: true }, 200);
      }
      const made = await makeOtherSize({ chat, taskId: rq.taskId, title: facts.title, payload: facts.payload || {}, size, updateId, action: rq.action });
      if (!made.ok) {
        await answer('This could not be started just now. Please try again in a minute.', true);
        return c.json({ ok: false, requesterAction: rq.action, taskId: rq.taskId }, 200);
      }
      await markTelegramUpdateHandled(chat, updateId, `telegram_requester_${rq.action}`, { ...record, sizeTaskId: made.sizeTaskId });
      await answer(`📐 Making the ${size.label} version`);
      return c.json({ ok: true, requesterAction: rq.action, taskId: rq.taskId, sizeTaskId: made.sizeTaskId }, 200);
    }
    if (rq.action === 'ok') {
      if (facts.done) {
        await answer('You already approved this design. The art director is on it.');
        return c.json({ ok: true, requesterAction: 'ok', taskId: rq.taskId, already: true }, 200);
      }
      const variant = (facts.payload?.variant || {}) as { width?: number; height?: number };
      // Other sizes are made by the v3 edit; a chat on the older pipeline is not offered them.
      await send(composeRequesterApproved(rq.taskId, { width: variant.width ?? 1080, height: variant.height ?? 1350 }, runsPipelineV3(chat)));
      await enqueueOfficeAlert(rq.taskId, `requester-approved:${rq.taskId}`, composeRequesterApprovedAlert({ taskId: rq.taskId, title: facts.title, canvaUrl: facts.canva || undefined }), chat);
      await markTelegramUpdateHandled(chat, updateId, 'telegram_requester_ok', record);
      broadcast('task:requester_approved', { taskId: rq.taskId, source: 'telegram' });
      await answer('✅ Thank you!');
    } else if (rq.action === 'chg') {
      await send(composeChangePrompt(rq.taskId));
      await markTelegramUpdateHandled(chat, updateId, 'telegram_requester_chg', record);
      await answer('Reply with what to change');
    } else {
      const history = await askHistory(rq.taskId);
      await send(composeDesignerTakesOver(rq.taskId));
      if (!facts.done) {
        await enqueueOfficeAlert(rq.taskId, `designer-asked:${rq.taskId}`, composeDesignerHandoff({ taskId: rq.taskId, title: facts.title, canvaUrl: facts.canva || undefined, asks: history.asks, rounds: history.rounds, why: 'asked' }), chat);
      }
      await markTelegramUpdateHandled(chat, updateId, 'telegram_requester_dsg', record);
      broadcast('task:designer_requested', { taskId: rq.taskId, source: 'telegram' });
      await answer('A designer will take over');
    }
    return c.json({ ok: true, requesterAction: rq.action, taskId: rq.taskId }, 200);
  }

  /**
   * The same design in another size: a new task from the design's own task.created payload (its copy,
   * photos, reference and client), sized to the format, whose run lays the approved design out again
   * (edit stage, reformat). Its draft comes to the chat on its own, with its own buttons.
   */
  async function makeOtherSize(input: {
    chat: string;
    taskId: string;
    title: string | null;
    payload: TaskCreatedPayload;
    size: { label: string; width: number; height: number };
    updateId: string;
    action: string;
  }): Promise<{ ok: boolean; sizeTaskId?: string }> {
    const { payload, size } = input;
    type Outbound = Parameters<NonNullable<typeof telegramBridge>['dispatchOutboundMessage']>[1];
    const send = (message: { text: string; parse_mode: 'HTML' }) => telegramBridge?.dispatchOutboundMessage(input.chat, message as Outbound).catch(() => undefined);
    // The design's own options, less what made it a change: this is a format of it, not a round.
    const { parentTaskId: _p, revisionDirective: _d, clarified: _c, reformat: _r, answers: _a, revisionRound: _n, ...kept } = (payload.studioOptions || {}) as Record<string, unknown>;
    try {
      const persisted = await persistChatIntake(db!, {
        platform: 'telegram',
        sourceEventId: `${input.updateId}_size_${input.action}_${input.taskId}`,
        sourceChannelId: input.chat,
        rawText: String(payload.rawRequestText || input.title || 'Design'),
        rawJson: { callback: input.action, taskId: input.taskId },
        clientId: typeof payload.clientId === 'string' ? payload.clientId : null,
        title: `${String(input.title || 'Design').replace(/ \((Revision|story|square post|landscape banner)[^)]*\)/g, '')} (${size.label})`,
        headlineEn: payload.headlineEn || undefined,
        headlineCkb: payload.headlineCkb || undefined,
        copyEn: payload.copyEn || undefined,
        copyCkb: payload.copyCkb || undefined,
        designInstructions: String(payload.designInstructions || ''),
        exactCopy: Array.isArray(payload.exactCopy) ? payload.exactCopy : [],
        autoGenerate: true,
        variant: { width: size.width, height: size.height },
        ...(typeof payload.designStudio === 'boolean' ? { designStudio: payload.designStudio } : {}),
        studioOptions: {
          ...kept,
          parentTaskId: input.taskId,
          revisionDirective: `The same design as a ${size.label} (${size.width}x${size.height}).`,
          reformat: size.label,
          // The round is the design's, carried on: a change to a size of a third-round design was
          // round 1, and the office alert at three rounds never came (review of 2026-09-24). Metrics
          // leave reformats out of the rounds.
          ...(typeof _n === 'number' ? { revisionRound: _n } : {}),
        },
      });
      if (persisted.autoGenerateDeclined) {
        await send({
          text: `📐 <b>The ${escapeTelegramHtml(size.label)} version is saved.</b>\n\n⏳ <i>The daily limit for automatic drafts has been reached for this chat, so the art director will make it in Hawa Desk.</i>\n\n🆔 Task ID: <code>${escapeTelegramHtml(persisted.task.id)}</code>`,
          parse_mode: 'HTML',
        });
      } else {
        await send(composeSizeStarted(size.label, size.width, size.height, persisted.task.id));
      }
      broadcast('task:created', persisted.task);
      return { ok: true, sizeTaskId: persisted.task.id };
    } catch (err) {
      log.error(`[Core] Task ${input.taskId}: the ${size.label} version could not be started:`, err);
      return { ok: false };
    }
  }

  return { handleRequesterAction, makeOtherSize };
}
