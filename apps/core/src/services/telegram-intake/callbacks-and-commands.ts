/**
 * The office's buttons under a review message and the chat's commands: /status, /rules and /forget,
 * /approve, /revise and /redo. Moved unchanged from the Telegram webhook in app.ts (architecture
 * programme 1.3, SPLIT_PLAN.md G9). Each answers the update, or leaves it to the rest of intake.
 */
import crypto from 'node:crypto';
import type { Context } from 'hono';
import { SYSTEM_AUTOMATION_USER_ID, isTaskApiStatus, isTaskDbState, type TaskDbState } from '@hawa/contracts';
import { sql, withRlsContext } from '@hawa/db';
import { escapeTelegramHtml, parseCallbackData, verifyActionSignature } from '@hawa/integrations';
import { cutText } from '../../core-helpers.js';
import { DEFAULT_TENANT_ID, type CoreContext } from '../../core-context.js';
import { log } from '../../logging.js';
import { createRedrive, type RedriveDeps } from '../redrive.js';
import { handleRulesCommand, type RulesIntakeDeps } from '../telegram-rules-intake.js';
import { parseRulesCommand } from '../standing-rules-chat.js';
import { createTelegramQuestions } from './questions.js';
import { createTelegramUpdateState, type TelegramUpdateJson } from './update-state.js';

/** What the webhook has read of a message by the time its commands are looked at. */
export interface TelegramCommandInput {
  json: TelegramUpdateJson;
  /** The message, channel post or test body the update carries. */
  msg: TelegramUpdateJson;
  rawText: string;
  sourceChannelId: string;
  sourceEventId: string;
  rulesDeps: RulesIntakeDeps | null;
  verifiedSender: string;
}

export type TelegramCallbacksAndCommands = ReturnType<typeof createTelegramCallbacksAndCommands>;

export function createTelegramCallbacksAndCommands(
  deps: RedriveDeps & Pick<CoreContext, 'telegramActionTokenService' | 'problem' | 'resolveTaskWithFallback' | 'events' | 'delivery'>
) {
  const { db, telegramAllowedUsers, problem, resolveTaskWithFallback, events, broadcastTransition, broadcastEvent: broadcast } = deps;
  const telegramBridge = deps.telegramBridge ?? (() => { throw new Error('Telegram intake needs the Telegram bridge'); })();
  const telegramActionTokenService = deps.telegramActionTokenService ?? (() => { throw new Error('Telegram intake needs the action token service'); })();
  const { executeOmnichannelPublish } = deps.delivery;
  const { markTelegramUpdateHandled } = createTelegramUpdateState(deps);
  const { pendingQuestion } = createTelegramQuestions(deps);
  const { redriveTask } = createRedrive(deps);

  /**
   * A tap on the office's own buttons under a review message (signed `act:` tokens and the older
   * signed callbacks). Undefined when the update is not a button press.
   */
  async function handleCallbackQuery(c: Context, json: TelegramUpdateJson): Promise<Response | undefined> {
    // Handle inline interactive callback queries (e.g. [✅ Approve & Publish] or [✏️ Request Revision] clicks)
    if (json.callback_query) {
      const cb = json.callback_query;
      const cbData = cb.data || '';
      const actorId = String(cb.from?.id || '');

      // Check allowed user authorization ("Unknown users cannot approve")
      if (telegramAllowedUsers.length > 0 && !telegramAllowedUsers.includes(actorId)) {
        await telegramBridge.answerCallbackQuery(cb.id, '❌ Unauthorized user', true);
        return problem(c, 403, 'Forbidden', `User ${actorId} is not authorized to execute actions on this office task`);
      }

      let targetTaskId: string;
      let targetAction: 'approve' | 'revision' | 'pick_layout';

      if (cbData.startsWith('act:')) {
        const verifyRes = telegramActionTokenService.verifyAndConsumeToken(cbData, {
          actorId,
          allowedActors: telegramAllowedUsers,
        });
        if (!verifyRes.ok) {
          await telegramBridge.answerCallbackQuery(cb.id, `❌ ${verifyRes.error}`, true);
          const status = verifyRes.code === 'STALE_REVISION' ? 409 : 403;
          return problem(c, status, verifyRes.code, verifyRes.error);
        }
        targetTaskId = verifyRes.payload.taskId;
        targetAction = verifyRes.payload.action;
      } else {
        const parsed = parseCallbackData(cbData);
        if (!parsed) {
          return c.json({ ok: false, error: 'Invalid callback data format' }, 400);
        }

        if (!verifyActionSignature(parsed.taskId, parsed.action, parsed.signature)) {
          return problem(c, 403, 'Forbidden', 'Invalid action callback signature');
        }
        targetTaskId = parsed.taskId;
        targetAction = parsed.action;
      }

      // A button acts only on a task Core holds; an unknown id is refused, never made up.
      const task = await resolveTaskWithFallback(targetTaskId);
      if (!task) {
        await telegramBridge.answerCallbackQuery(cb.id, `❌ Task ${targetTaskId} was not found. Nothing was changed.`, true);
        return problem(c, 404, 'Task Not Found', `Task ${targetTaskId} does not exist; nothing was approved or changed`);
      }

      const chatId = cb.message?.chat?.id || cb.from?.id;

      if (targetAction === 'approve') {
        const publishRes = await executeOmnichannelPublish(
          targetTaskId,
          { type: 'adapter', id: String(cb.from?.id || 'telegram') },
          'Approved via Telegram inline callback button',
          true
        );

        // The answer reports the outcome; it used to announce "Approved & Publishing" before either happened.
        if (!publishRes.ok) {
          await telegramBridge.answerCallbackQuery(cb.id, `❌ ${(publishRes as any).message || 'Publishing failed'}`, true);
          return problem(c, (publishRes as any).status || 500, (publishRes as any).message || 'Omnichannel publishing failed');
        }
        await telegramBridge.answerCallbackQuery(cb.id, '✅ Approved and published');

        broadcast('task:approved', { taskId: targetTaskId, approvedBy: cb.from?.id, via: 'telegram' });

        const notice = telegramBridge.formatPublicationNotice({
          id: targetTaskId,
          title: task.title || `Task ${targetTaskId}`,
          driveUrl: publishRes.driveFolderUrl!,
          sheetUrl: publishRes.sheetRowUrl!,
          workflowId: (publishRes as any).publicationReceipt?.publicationId || (publishRes as any).publicationReceipt?.workflowId || 'kaae-pub-flow-2026',
        });
        if (chatId) {
          await telegramBridge.dispatchOutboundMessage(chatId, notice);
        }

        return c.json({ ok: true, action: 'approve', taskId: targetTaskId, status: 'COMPLETE', publishRes });
      } else if (targetAction === 'pick_layout') {
        await telegramBridge.answerCallbackQuery(cb.id, '🎯 Layout Pick Processed');
        return c.json({ ok: true, action: 'pick_layout', taskId: targetTaskId, status: task.status });
      } else {
        await telegramBridge.answerCallbackQuery(cb.id, '✏️ Revision Requested');
        // REVISION_REQUESTED, the status the database uses for a design sent back for changes. This
        // said IN_PROGRESS, a word only Core's memory had. The move is not written here (version null).
        const fromStatus = task.status;
        task.status = 'REVISION_REQUESTED';
        events.get(targetTaskId)?.push({
          eventId: crypto.randomUUID(),
          taskId: targetTaskId,
          fromStatus,
          toStatus: 'REVISION_REQUESTED',
          actor: { type: 'adapter', id: String(cb.from?.id || 'telegram') },
          reason: 'Revision requested via Telegram inline button',
          occurredAt: new Date().toISOString(),
        });
        broadcast('task:revision_requested', { taskId: targetTaskId, notes: 'Revision requested via Telegram button', requestedBy: cb.from?.id });
        broadcastTransition(targetTaskId, isTaskApiStatus(fromStatus) ? fromStatus : null, 'REVISION_REQUESTED', null);

        if (chatId) {
          await telegramBridge.dispatchOutboundMessage(chatId, {
            text: `✏️ <b>Revision request logged for task</b> <code>${escapeTelegramHtml(targetTaskId)}</code>\nDesign team alerted in Hawa Desk.`,
            parse_mode: 'HTML',
          });
        }

        return c.json({ ok: true, action: 'revision', taskId: targetTaskId, status: 'REVISION_REQUESTED' });
      }
    }
    return undefined;
  }

  /** The chat's commands. Undefined when the message is not one, so intake goes on reading it. */
  async function handleCommand(c: Context, input: TelegramCommandInput): Promise<Response | undefined> {
    const { json, msg, rawText, sourceChannelId, sourceEventId, rulesDeps, verifiedSender } = input;
    // /status: this chat's latest requests and where each one is. It used to report the bridge's own
    // counters (mode, ingress URL, uptime), which told the sender nothing about their design.
    if (typeof rawText === 'string' && /^\/status(@\w+)?(\s.*)?$/is.test(rawText.trim()) && db && sourceChannelId !== 'tg_default') {
      const rows = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
        (await sql<{ id: string; title: string | null; state: string; created_at: Date; design_id: string | null }>`
          SELECT t.id, t.title, t.state, t.created_at,
            (SELECT b.canva_design_id FROM hawa.canva_bindings b WHERE b.task_id = t.id AND b.tenant_id = t.tenant_id AND b.status = 'bound' ORDER BY b.created_at DESC LIMIT 1) AS design_id
          FROM hawa.outbox_commands o JOIN hawa.tasks t ON t.id = o.aggregate_id AND t.tenant_id = o.tenant_id
          WHERE o.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND o.command_type = 'task.created'
            AND o.payload->>'sourceChannelId' = ${sourceChannelId}
            AND COALESCE(o.payload->>'isInstructionOnly', 'false') <> 'true'
          ORDER BY t.created_at DESC LIMIT 5`.execute(trx)).rows
      ).catch((err: unknown) => {
        // A read that failed answered "No requests from this chat yet", which is untrue.
        log.warn('[TelegramIngress] /status could not read the chat\'s requests:', err);
        return null;
      });
      if (!rows) {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: '📊 Your requests could not be read just now. Please send /status again in a minute.',
        });
        return c.json({ ok: false, command: true, status: 'UNAVAILABLE' }, 200);
      }
      // Keyed by every database state, so a state added to the vocabulary does not compile until it has words.
      const stateLabel: Record<TaskDbState, string> = {
        received: 'being designed', promotion_pending: 'being designed', routing: 'being designed', routing_review: 'being designed',
        brief_draft: 'being designed', brief_review: 'being designed', context_ready: 'being designed', design_planning: 'being designed',
        asset_production: 'being designed', studio_composition: 'being designed', qa: 'being checked', auto_repair: 'being checked',
        human_review: 'draft ready, awaiting approval in Hawa Desk', revision_requested: 'replaced by a newer version',
        approved: 'approved, awaiting delivery', publishing: 'being delivered', complete: 'delivered', paused: 'waiting for your answer to a question',
        failed_retryable: 'delayed, being retried', failed_operator: 'needs the office (the automatic draft failed)',
        rejected: 'rejected', cancelled: 'cancelled',
      };
      // A paused task waits for an answer only while its question does: one answered or overtaken by a
      // newer change said "waiting for your answer" while its buttons said it was answered (review of 2026-09-24).
      const stillAsking = new Set<string>();
      for (const r of rows) {
        if (r.state === 'paused' && (await pendingQuestion(r.id, sourceChannelId).catch(() => null))) stillAsking.add(r.id);
      }
      const labelOf = (r: { id: string; state: string }) =>
        r.state === 'paused' && !stillAsking.has(r.id) ? 'no longer waiting: answered, or replaced by a newer change' : (isTaskDbState(r.state) ? stateLabel[r.state] : r.state);
      const lines = rows.map((r, i) =>
        `${i + 1}. <b>${escapeTelegramHtml(cutText(String(r.title || 'Request').replace(/^[^:]*:\s*/, ''), 60))}</b>\n` +
        `   ${escapeTelegramHtml(labelOf(r))}` +
        (r.design_id ? ` · <a href="https://www.canva.com/design/${escapeTelegramHtml(r.design_id)}/edit">Canva</a>` : '') +
        `\n   <code>${r.id.slice(0, 8)}</code>`
      );
      await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
        text: lines.length ? `📊 <b>Your latest requests</b>\n\n${lines.join('\n')}` : '📊 No requests from this chat yet.',
        parse_mode: 'HTML',
      });
      return c.json({ ok: true, command: true, status: rows.length }, 200);
    }

    // The client's standing rules: /rules lists them, /forget 2 removes one.
    const rulesCommand = typeof rawText === 'string' ? parseRulesCommand(rawText) : null;
    if (rulesCommand && sourceChannelId !== 'tg_default') {
      if (!rulesDeps) return problem(c, 503, 'Rules unavailable', 'Standing rules need the database');
      await handleRulesCommand(rulesDeps, { sourceChannelId, command: rulesCommand, text: rawText });
      // "/forget 1" delivered twice would remove the rule after it as well.
      if (rulesCommand.kind === 'forget') await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_rules_forget', json);
      return c.json({ ok: true, command: true, rules: rulesCommand.kind }, 200);
    }

    // Handle bot slash commands (/start, /status, /help, /review, /approve, /publish, /revise, /reject)
    if (typeof rawText === 'string' && rawText.startsWith('/')) {
      const cmdReply = telegramBridge.handleCommand(rawText, sourceChannelId, verifiedSender || undefined);
      if (cmdReply) {
        if (cmdReply.action === 'approve' && cmdReply.taskId) {
          const senderId = String(msg?.from?.id || '');
          if (telegramAllowedUsers.length > 0 && !telegramAllowedUsers.includes(senderId)) {
            return problem(c, 403, 'Forbidden', `User ${senderId} is not authorized to approve tasks`);
          }
          // /approve acts only on a task Core holds; an unknown id is refused, never made up.
          const task = await resolveTaskWithFallback(cmdReply.taskId);
          if (!task) {
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
              text: `⚠️ Task <code>${escapeTelegramHtml(cmdReply.taskId)}</code> was not found. Nothing was approved.`,
              parse_mode: 'HTML',
            });
            return problem(c, 404, 'Task Not Found', `Task ${cmdReply.taskId} does not exist; nothing was approved`);
          }
          const publishRes = await executeOmnichannelPublish(
            cmdReply.taskId,
            { type: 'adapter', id: sourceChannelId },
            'Approved via Telegram slash command',
            true
          );
          if (!publishRes.ok) {
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
              text: `⚠️ Not approved or published: ${escapeTelegramHtml((publishRes as any).message || 'publishing failed')}`,
              parse_mode: 'HTML',
            });
            return problem(c, (publishRes as any).status || 500, (publishRes as any).message || 'Omnichannel publishing failed');
          }
          broadcast('task:approved', { taskId: cmdReply.taskId, approvedBy: sourceChannelId, via: 'telegram' });
          const notice = telegramBridge.formatPublicationNotice({
            id: cmdReply.taskId,
            title: task.title || `Task ${cmdReply.taskId}`,
            driveUrl: publishRes.driveFolderUrl!,
            sheetUrl: publishRes.sheetRowUrl!,
            workflowId: (publishRes as any).publicationReceipt?.publicationId || (publishRes as any).publicationReceipt?.workflowId || 'kaae-pub-flow-2026',
          });
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, notice);
          return c.json({ ok: true, command: true, action: 'approve', taskId: cmdReply.taskId, status: 'COMPLETE', publishRes });
        } else if (cmdReply.action === 'revision' && cmdReply.taskId) {
          // /revise acts only on a task Core holds; an unknown id is refused, never made up.
          const task = await resolveTaskWithFallback(cmdReply.taskId);
          if (!task) {
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
              text: `⚠️ Task <code>${escapeTelegramHtml(cmdReply.taskId)}</code> was not found. No revision was logged.`,
              parse_mode: 'HTML',
            });
            return problem(c, 404, 'Task Not Found', `Task ${cmdReply.taskId} does not exist; no revision was logged`);
          }
          // REVISION_REQUESTED, as the database names it (this said IN_PROGRESS); not written here.
          const fromStatus = task.status;
          task.status = 'REVISION_REQUESTED';
          events.get(cmdReply.taskId)?.push({
            eventId: crypto.randomUUID(),
            taskId: cmdReply.taskId,
            fromStatus,
            toStatus: 'REVISION_REQUESTED',
            actor: { type: 'adapter', id: sourceChannelId },
            reason: cmdReply.notes || 'Revision requested via Telegram slash command',
            occurredAt: new Date().toISOString(),
          });
          broadcast('task:revision_requested', { taskId: cmdReply.taskId, notes: cmdReply.notes, requestedBy: sourceChannelId });
          broadcastTransition(cmdReply.taskId, isTaskApiStatus(fromStatus) ? fromStatus : null, 'REVISION_REQUESTED', null);
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, cmdReply);
          return c.json({ ok: true, command: true, action: 'revision', taskId: cmdReply.taskId, status: 'REVISION_REQUESTED' });
        } else if (cmdReply.action === 'redrive') {
          let targetTaskId = cmdReply.taskId;
          if (!targetTaskId && db) {
            try {
              const recentFailed = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
                return await sql<any>`
                  SELECT p.task_id
                  FROM hawa.canva_design_plans p
                  JOIN hawa.outbox_commands o ON o.aggregate_id = p.task_id
                  WHERE o.payload->>'sourceChannelId' = ${sourceChannelId}
                    AND p.status IN ('failed', 'uncertain')
                  ORDER BY p.created_at DESC LIMIT 1`.execute(trx);
              });
              if (recentFailed.rows[0]?.task_id) {
                targetTaskId = recentFailed.rows[0].task_id;
              }
            } catch (err) {
              log.warn('[TelegramBridge] Failed to find recent failed task for redrive:', err);
            }
          }
          if (!targetTaskId) {
            const noTaskMsg = {
              text: '⚠️ No failed design task found in this chat to re-drive. Specify the task ID: <code>/redo &lt;taskId&gt;</code>',
              parse_mode: 'HTML',
            };
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, noTaskMsg);
            return c.json({ ok: false, error: 'NO_TASK_TO_REDRIVE' }, 404);
          }
          // redriveTask says what it did (a new draft queued, or the design that already exists).
          const redriveRes = await redriveTask(targetTaskId, sourceChannelId);
          if (!redriveRes.ok && redriveRes.code === 'LIFECYCLE_OWNED') {
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
              text: 'This request is managed by the office. No new design was started by /redo.',
              parse_mode: 'HTML',
            });
            return c.json({ ok: false, command: true, action: 'redrive',
              taskId: targetTaskId, code: 'LIFECYCLE_OWNED' });
          }
          return c.json({ ok: true, command: true, action: 'redrive', taskId: targetTaskId, result: redriveRes });
        }

        await telegramBridge.dispatchOutboundMessage(sourceChannelId, cmdReply);
        return c.json({ ok: true, command: true, reply: cmdReply }, 200);
      }
    }
    return undefined;
  }

  return { handleCallbackQuery, handleCommand };
}
