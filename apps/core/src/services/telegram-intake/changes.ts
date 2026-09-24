/**
 * A change the requester asked for in Telegram, made as a new revision of the design. Moved
 * unchanged from the webhook in app.ts (architecture programme 1.3, SPLIT_PLAN.md G9).
 */
import crypto from 'node:crypto';
import type { Context } from 'hono';
import { SYSTEM_AUTOMATION_USER_ID, isTaskApiStatus } from '@hawa/contracts';
import { sql, withRlsContext } from '@hawa/db';
import { globalFeedbackMiner } from '@hawa/creative';
import { escapeTelegramHtml, KAAE_CLIENT_ID } from '@hawa/integrations';
import { cutText, isValidUuid } from '../../core-helpers.js';
import { DEFAULT_TENANT_ID, type CoreContext } from '../../core-context.js';
import { log } from '../../logging.js';
import { persistChatIntake } from '../chat-intake.js';
import { detectFontRequests, scriptLabel, unavailableFontNotice } from '../feedback-font-request.js';
import { composeDesignerHandoff, type AskRecord } from '../requester-actions.js';
import { saveChatRule, ruleClientById } from '../telegram-rules-intake.js';
import { isStandingRule } from '../standing-rules-chat.js';
import { createOfficeAlerts } from '../office-alerts.js';
import { createAskHistory } from '../ask-history.js';
import { createTelegramUpdateState } from './update-state.js';
import type { TelegramReplyReading } from './replies.js';

export type TelegramChanges = ReturnType<typeof createTelegramChanges>;

export function createTelegramChanges(deps: Pick<CoreContext, 'db' | 'events' | 'feedbacks' | 'problem' | 'broadcastEvent' | 'broadcastTransition' | 'outboxRepo' | 'telegramBridge'>) {
  const { db, events, feedbacks, problem, broadcastEvent: broadcast, broadcastTransition } = deps;
  // createApp always builds the bridge; the shared context types it as optional.
  const telegramBridge = deps.telegramBridge ?? (() => { throw new Error('Telegram intake needs the Telegram bridge'); })();
  const { markTelegramUpdateHandled, taskDesignState, revisionInFlight } = createTelegramUpdateState(deps);
  const { enqueueOfficeAlert } = createOfficeAlerts(deps);
  const { askHistory } = createAskHistory(deps);

  /**
   * A change to one of the chat's designs: refused while that design is still being made, else
   * recorded as feedback and made as a new revision of it. The answer when the message was a change;
   * undefined when it was not, and intake reads it as a request.
   */
  async function makeChange(c: Context, reply: TelegramReplyReading): Promise<Response | undefined> {
    let { standingRuleSaved } = reply;
    const { json, rawText, referenceImageBase64, sourceEventId, sourceChannelId, rulesDeps, albumId, senderName, feedbackTargetTask, classification, changedNewestVersion } = reply;
    // A change addressed to a task by its id ("revise task <id>: …") skips the classifier; a lasting
    // preference said in it is saved the same way.
    if (feedbackTargetTask && !classification && rulesDeps && isStandingRule(rawText)) {
      const saved = await saveChatRule(rulesDeps, {
        sourceChannelId,
        sourceEventId,
        ruleText: rawText.replace(/^\s*(please\s+)?\w+\s+task\s+[0-9a-f-]{36}\s*:?\s*/i, '').trim() || rawText.trim(),
        originalText: rawText,
        client: feedbackTargetTask.clientId && isValidUuid(feedbackTargetTask.clientId)
          ? await ruleClientById(rulesDeps, feedbackTargetTask.clientId)
          : undefined,
      });
      standingRuleSaved = saved.saved;
    }

    // A change to a design that is still being made (a reply to "Request saved", a second change
    // before the first one's draft) was revised from nothing: a second full paid design, and a
    // different one. The sender is asked to reply to the draft once it arrives.
    if (feedbackTargetTask && db && sourceChannelId !== 'tg_default' && isValidUuid(feedbackTargetTask.id)) {
      const [designState, pendingChange] = await Promise.all([
        taskDesignState(feedbackTargetTask.id).catch((err: unknown) => {
          log.warn('[TelegramIngress] Could not read the design state of the change target:', err);
          return 'none' as const;
        }),
        revisionInFlight(feedbackTargetTask.id).catch(() => null),
      ]);
      if (designState === 'running' || pendingChange) {
        const title = cutText(String(pendingChange?.title || feedbackTargetTask.title || 'your design').replace(/^[^:]*:\s*/, ''), 80);
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: pendingChange
            ? `⏳ <b>Your previous change to "${escapeTelegramHtml(title)}" is still being made.</b>\n\n` +
              `<i>When its draft arrives, reply to that draft with this change. Nothing new was started.</i>`
            : `⏳ <b>Your draft "${escapeTelegramHtml(title)}" is still being made.</b>\n\n` +
              `<i>When it arrives, reply to its image with this change. Nothing new was started.</i>`,
          parse_mode: 'HTML',
        }).catch(() => undefined);
        await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_change_while_designing', json);
        return c.json({ ok: true, status: 'DESIGN_STILL_RUNNING', taskId: pendingChange?.taskId || feedbackTargetTask.id }, 200);
      }
    }

    if (feedbackTargetTask) {
      const targetId = feedbackTargetTask.id;
      const prevStatus = feedbackTargetTask.status;
      const clientId = feedbackTargetTask.clientId && isValidUuid(feedbackTargetTask.clientId) && feedbackTargetTask.clientId !== 'client-office-1'
        ? feedbackTargetTask.clientId
        : KAAE_CLIENT_ID;
      const actor = { id: senderName, role: 'operator', name: senderName };

      // REVISION_REQUESTED, as the database names a design sent back for changes (this said
      // IN_PROGRESS, a word only Core's memory had). This path writes no move to the database.
      feedbackTargetTask.status = 'REVISION_REQUESTED';
      feedbackTargetTask.updatedAt = new Date().toISOString();

      if (!feedbacks.has(targetId)) {
        feedbacks.set(targetId, []);
      }
      feedbacks.get(targetId)?.push({
        feedbackId: crypto.randomUUID(),
        taskId: targetId,
        clientId,
        designRevisionId: feedbackTargetTask.latestRevisionId || crypto.randomUUID(),
        polarity: 'negative',
        category: 'layout',
        rawFeedbackText: rawText,
        attributedActor: {
          userId: crypto.randomUUID(),
          displayName: senderName,
        },
        governance: {
          status: 'received',
        },
        occurredAt: new Date().toISOString(),
      });

      // A lasting preference said with this change was saved above as a client rule (the
      // classifier reads it; the old phrase list only proposed it to a Desk queue kept in memory).
      const isExplicitPersistentRule = standingRuleSaved;
      const feedbackScope = isExplicitPersistentRule ? 'client' : 'one_time';

      if (db && isValidUuid(targetId) && isValidUuid(clientId)) {
        try {
          const tenantId = feedbackTargetTask.tenantId && isValidUuid(feedbackTargetTask.tenantId)
            ? feedbackTargetTask.tenantId
            : DEFAULT_TENANT_ID;
          await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
            await trx
              .insertInto('feedback_events')
              .values({
                tenant_id: tenantId,
                client_id: clientId,
                task_id: targetId,
                before_revision_id: isValidUuid(feedbackTargetTask.latestRevisionId) ? feedbackTargetTask.latestRevisionId : null,
                category: 'layout',
                severity: 'medium',
                scope: feedbackScope,
                explicitness: 'direct_instruction',
                target: JSON.stringify({ taskTitle: feedbackTargetTask.title }),
                comment: rawText,
                confidence: 1.0,
              })
              .execute();
          });
        } catch (dbErr) {
          log.warn('[Core] Could not persist feedback_event to PostgreSQL:', dbErr);
        }
      }

      if (!events.has(targetId)) {
        events.set(targetId, []);
      }
      events.get(targetId)?.push({
        eventId: crypto.randomUUID(),
        taskId: targetId,
        fromStatus: prevStatus,
        toStatus: 'REVISION_REQUESTED',
        actor: { type: 'adapter', id: sourceChannelId },
        reason: `Feedback received via Telegram: "${rawText.slice(0, 100)}"`,
        occurredAt: new Date().toISOString(),
      });

      broadcast('task:revision_requested', {
        taskId: targetId,
        notes: rawText,
        requestedBy: senderName,
        source: 'telegram',
      });
      broadcastTransition(targetId, isTaskApiStatus(prevStatus) ? prevStatus : null, 'REVISION_REQUESTED', null);

      // --- Governed Learning & Adaptive Memory (CV-18, ADR-0022, ADR-0044) ---
      // 1. Record negative feedback on previous draft so it is never treated as a positive benchmark
      globalFeedbackMiner.recordNegativeFeedback(targetId, clientId, rawText, actor);

      // 2. Semantic Multi-Rule Extraction from Operator Directive
      const lowerFb = rawText.toLowerCase();
      const extractedRules: Array<{
        category: 'typography' | 'palette' | 'copy_token' | 'layout';
        title: string;
        ruleText: string;
        rationale: string;
      }> = [];

      // B. Typography: the face the sender named, applied when the studio has it and refused
      // out loud when it does not. A font remark that names no face is passed on as written; the
      // handler never substitutes a face of its own for the one asked for.
      const fontRequests = detectFontRequests(rawText);
      const unavailableFonts = fontRequests.filter((request) => !request.available);
      for (const request of fontRequests) {
        if (!request.available) continue;
        const target = request.script === 'unspecified' ? (request.admittedFor ?? 'unspecified') : request.script;
        extractedRules.push({
          category: 'typography',
          title: `${request.family} for ${scriptLabel(target)} text`,
          // An alias is said out loud: "Lora" is drawn as Playfair Display, and the sender is told so.
          ruleText: `Set ${scriptLabel(target)} text in ${request.family}${request.askedAs ? ` (asked for as ${request.askedAs})` : ''}.`,
          rationale: `Requested by name in review feedback: "${rawText.trim().slice(0, 120)}"`,
        });
      }

      // The sender's words, as written, are the rule. Three keyword branches used to stand here
      // (logo, "canva|review|edit", colour) and each replaced the message with a canned sentence:
      // "move the logo up" was recorded as "Always use verified authentic master brand seal",
      // "edit the date" as "Direct all design reviews and final edits to Canva". Three of those
      // canned sentences are still in kaae.dna.json. A message whose only ask was a face the studio
      // lacks gets no rule: passing "use Calibri" on would be sanitised to the default face and
      // then reported as applied.
      if (unavailableFonts.length === 0 || extractedRules.length > 0) {
        extractedRules.push({
          category: 'layout',
          title: 'Feedback, as written',
          ruleText: rawText.trim(),
          rationale: 'Review feedback recorded verbatim',
        });
      }

      // A face the studio cannot draw is refused to the sender now, before any draft is promised.
      // Applying it would end in the default face, reported as their preference.
      if (unavailableFonts.length > 0) {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: `⚠️ <b>Font not available</b>\n\n` +
            unavailableFonts.map((request) => escapeTelegramHtml(unavailableFontNotice(request))).join('\n\n') +
            `\n\n<i>To add a new typeface, the owner has to install it in the studio first.</i>`,
          parse_mode: 'HTML',
        }).catch((err: unknown) => {
          log.error('[TelegramBridge] Could not send unavailable-font notice:', err);
        });
      }
      // What this message did, said in the message production senders receive (the revision
      // branch returns before the fallback acknowledgement below, so a line only there is never
      // sent to a real user). A standing rule is a proposal until it is approved in the Desk, and
      // until proposals are stored in PostgreSQL a restart forgets it; the line says so.
      const scopeLine = isExplicitPersistentRule
        ? `📌 <b>Also saved as a standing rule</b> for every later design of this client (/rules lists them).\n`
        : `ℹ️ <i>Applied to this design only. Say "from now on …" to make it a standing rule for every later design.</i>\n`;
      const feedbackOutcome = {
        scope: feedbackScope,
        proposedRules: isExplicitPersistentRule ? extractedRules.map((r) => r.ruleText) : [],
        unavailableFonts: unavailableFonts.map((r) => ({ family: r.family, script: r.script, alternatives: r.alternatives })),
      };

      // The revision is the studio's: a new Canva draft of the same copy with the change applied.
      // A local preview from the legacy templates used to go out first, drawn by a different engine,
      // with Approve and Revision buttons that every press refused.
      const revisedPhotoSent = false;
      const effectiveTaskRules = extractedRules.map((r) => r.ruleText);

      // Trigger genuine automated Canva revision draft
      if (db && isValidUuid(feedbackTargetTask.id) && clientId && isValidUuid(clientId) && clientId !== 'client-office-1') {
        try {
          const tenantId = feedbackTargetTask.tenantId && isValidUuid(feedbackTargetTask.tenantId)
            ? feedbackTargetTask.tenantId
            : DEFAULT_TENANT_ID;

          const priorTaskDetails = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
            return await sql<any>`
              SELECT t.id, t.title, t.description, t.client_id, o.payload
              FROM hawa.tasks t
              LEFT JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
              WHERE t.id = ${feedbackTargetTask.id}::uuid
              ORDER BY o.created_at DESC LIMIT 1`.execute(trx);
          });

          const priorRow = priorTaskDetails.rows[0];
          let priorPayload = priorRow?.payload || {};

          // If the prior task was itself a revision or had its headline contaminated with an instruction,
          // follow parentTaskId to restore the authentic event copy
          if (priorPayload?.studioOptions?.parentTaskId && db) {
            try {
              const rootDetails = await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
                return await sql<any>`
                  SELECT o.payload FROM hawa.tasks t
                  JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
                  WHERE t.id = ${priorPayload.studioOptions.parentTaskId}::uuid
                  ORDER BY o.created_at DESC LIMIT 1`.execute(trx);
              });
              const rootPayload = rootDetails.rows[0]?.payload;
              if (rootPayload?.exactCopy && Array.isArray(rootPayload.exactCopy) && rootPayload.exactCopy.length > 0) {
                const priorHeadline = priorPayload.headlineEn || priorPayload.exactCopy?.[0]?.text || '';
                if (/^(?:the\s+)?background\s+is\b|^(?:i\s+)?want\s+|make\s+it\b/i.test(priorHeadline)) {
                  priorPayload = {
                    ...priorPayload,
                    headlineEn: rootPayload.headlineEn,
                    headlineCkb: rootPayload.headlineCkb,
                    copyEn: rootPayload.copyEn,
                    copyCkb: rootPayload.copyCkb,
                    exactCopy: rootPayload.exactCopy,
                    rawRequestText: rootPayload.rawRequestText,
                  };
                }
              }
            } catch (e) {
              log.warn('[Core] Failed to resolve parent task payload:', e);
            }
          }

          const baseInstructions = priorPayload.designInstructions || '';
          const revisionInstructions = `${baseInstructions}\nOperator Revision Directive: ${rawText.trim()}`.trim();
          const cleanTitle = (priorRow?.title || feedbackTargetTask.title || 'Design').replace(/ \(Revision.*\)/, '');
          const revisionTitle = `${cleanTitle} (Revision)`;

          const persisted = await persistChatIntake(db, {
            platform: 'telegram',
            sourceEventId: `${sourceEventId}_rev_${targetId}`,
            sourceChannelId,
            rawText: priorPayload.rawRequestText || priorRow?.description || feedbackTargetTask.rawText || rawText,
            rawJson: json,
            clientId,
            title: revisionTitle,
            headlineEn: priorPayload.headlineEn,
            headlineCkb: priorPayload.headlineCkb,
            copyEn: priorPayload.copyEn,
            copyCkb: priorPayload.copyCkb,
            designInstructions: revisionInstructions,
            exactCopy: priorPayload.exactCopy,
            autoGenerate: true,
            variant: priorPayload.variant || { width: 1080, height: 1350 },
            studioOptions: {
              parentTaskId: targetId,
              revisionRound: (priorPayload?.studioOptions?.revisionRound || 0) + 1,
              // The change itself: the studio makes it to the design the sender replied to.
              revisionDirective: (classification?.directive || rawText).trim(),
              // The album this change came in, so its other photos join this revision.
              ...(albumId ? { mediaGroupId: albumId } : {}),
              referenceImageBase64,
            },
          });

          // The flag is on the intake result. This read it off the task row, where it never is, so
          // a sender over the daily cap was told a draft was being prepared and then heard nothing:
          // the worker refuses a task without autoGenerate and no message follows.
          if (persisted.autoGenerateDeclined) {
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
              text: `✏️ <b>Revision instruction received:</b> "${escapeTelegramHtml(cutText(rawText, 500))}"\n\n` +
                `⏳ <i>The daily limit for automatic drafts has been reached for this chat. Your revision is saved and queued for manual review in Hawa Desk.</i>`,
              parse_mode: 'HTML',
            });
          } else {
            // The change is made to the design the sender saw, so the message no longer promises "a
            // new layout architecture"; it carries the revision's Task ID so a reply to it finds the
            // revision, not the design before it.
            await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
              text: `✏️ <b>Change received:</b> "${escapeTelegramHtml(cutText(rawText, 500))}"\n\n` +
                (changedNewestVersion
                  ? `🎨 <b>Making this change to the newest version of this design</b> (the draft you replied to was changed since).\n`
                  : `🎨 <b>Making this change to the same design.</b>\n`) +
                `<i>The new draft and its editable Canva link come to this chat when ready. To change it again, reply to the new draft.</i>\n\n` +
                scopeLine +
                `\n🆔 Task ID: <code>${escapeTelegramHtml(persisted.task.id)}</code>`,
              parse_mode: 'HTML',
            });
            // Three rounds of changes on one design: the office is told, so a designer can step in
            // before the requester gives up (ADR-032 §2.4). Once per round.
            const round = (priorPayload?.studioOptions?.revisionRound || 0) + 1;
            if (round >= 3) {
              const history = await askHistory(targetId).catch(() => ({ asks: [] as AskRecord[], rounds: round - 1 }));
              await enqueueOfficeAlert(
                persisted.task.id,
                `rounds:${persisted.task.id}`,
                composeDesignerHandoff({ taskId: persisted.task.id, title: revisionTitle, asks: [...history.asks, { ask: rawText.trim().slice(0, 200), status: 'open' }], rounds: round, why: 'rounds' }),
                sourceChannelId
              );
            }
          }

          broadcast('task:created', persisted.task);
          broadcast('task:revision_requested', {
            taskId: targetId,
            revisionTaskId: persisted.task.id,
            notes: rawText,
            requestedBy: senderName,
            source: 'telegram',
          });

          return c.json({
            ok: true,
            feedback: true,
            taskId: targetId,
            revisionTaskId: persisted.task.id,
            status: 'REVISION_QUEUED',
            learnedRule: effectiveTaskRules[0] || 'Operator feedback',
            learnedRules: effectiveTaskRules,
            ...feedbackOutcome,
            comment: rawText,
          }, 200);
        } catch (revErr) {
          // Saying "feedback is recorded" here reported a revision that was never saved. The update
          // is retried instead (the revision's event id makes the retry idempotent).
          log.error('[TelegramBridge] Failed to enqueue revision draft:', revErr);
          return problem(c, 503, 'Revision not saved', 'The revision could not be saved; the message will be retried');
        }
      }

      if (!revisedPhotoSent) {
        // The sender is told what this message did: what applies to this design, and whether a
        // standing rule was proposed. "Applied preferences" used to be printed for both, and for
        // requests that were never applied.
        const appliedNow = extractedRules.map((r) => r.ruleText).join('; ');
        const ackNotice = {
          text: `✏️ <b>Revision Feedback Recorded for Task</b> <code>${escapeTelegramHtml(targetId)}</code>\n\n` +
            `📝 <b>Feedback Notes:</b> "${escapeTelegramHtml(cutText(rawText, 300))}"\n` +
            (appliedNow ? `🧠 <b>Applied to this design:</b> "${escapeTelegramHtml(appliedNow)}"\n` : '') +
            scopeLine +
            `\n⚡ Feedback is recorded. Native Canva changes still require a verified edit and capture.`,
          parse_mode: 'HTML',
        };
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, ackNotice);
      }

      return c.json({
        ok: true,
        feedback: true,
        taskId: targetId,
        status: feedbackTargetTask.status,
        learnedRule: effectiveTaskRules[0] || 'Operator feedback',
        learnedRules: effectiveTaskRules,
        ...feedbackOutcome,
        comment: rawText,
      }, 200);
    }
    return undefined;
  }

  return { makeChange };
}
