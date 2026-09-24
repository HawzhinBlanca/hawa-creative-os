/**
 * Reading a Telegram message against the chat's designs: replies, answers to questions, the
 * clarification the bot asked for, standing rules, and the classifier. Moved unchanged from the
 * webhook in app.ts (architecture programme 1.3, SPLIT_PLAN.md G9).
 */
import crypto from 'node:crypto';
import type { Context } from 'hono';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext, toApiTaskStatus } from '@hawa/db';
import { escapeTelegramHtml } from '@hawa/integrations';
import { cutText, isValidUuid } from '../../core-helpers.js';
import { DEFAULT_TENANT_ID, type CoreContext } from '../../core-context.js';
import { log } from '../../logging.js';
import { persistChatIntake } from '../chat-intake.js';
import { classifyInboundTelegramMessage } from '../telegram-classifier.js';
import { saveChatRule, ruleClientById } from '../telegram-rules-intake.js';
import { isStandingRule } from '../standing-rules-chat.js';
import { createTelegramUpdateState } from './update-state.js';
import { createTelegramQuestions, type PendingQuestion } from './questions.js';
import type { TelegramMediaReading } from './media.js';

/**
 * A message the bot asked about ("revise the last design, or a new one?"), per chat, kept until
 * answered. In memory, as it was in app.ts; Phase 2.3 (RequestLifecycle) replaces it.
 */
export type PendingClarifications = Map<string, { rawText: string; referenceImageBase64?: string; task?: any; at: number }>;

/** A message once it has been read against the chat's designs. */
export type TelegramReplyReading = Exclude<Awaited<ReturnType<TelegramReplies['readReply']>>, Response>;

export type TelegramReplies = ReturnType<typeof createTelegramReplies>;

export function createTelegramReplies(deps: Pick<CoreContext, 'db' | 'taskRepo' | 'tasks' | 'problem' | 'broadcastEvent' | 'telegramBridge'>, pendingClarifications: PendingClarifications) {
  const { db, taskRepo, tasks, problem, broadcastEvent: broadcast } = deps;
  // createApp always builds the bridge; the shared context types it as optional.
  const telegramBridge = deps.telegramBridge ?? (() => { throw new Error('Telegram intake needs the Telegram bridge'); })();
  const { markTelegramUpdateHandled, replyDesign } = createTelegramUpdateState(deps);
  const { pendingQuestion, questionFollowUp, answerQuestion } = createTelegramQuestions(deps);

  /**
   * What a message is about: the design a reply answers (followed to its newest version, and only in
   * the chat it was made for), the answer to a question, and the classifier's reading of the rest.
   * A standing rule, a picture with a remark, thanks and questions are answered here. The answer when
   * the message ends here; otherwise the reading, with the design a change is for.
   */
  async function readReply(c: Context, media: TelegramMediaReading) {
    let { rawText, referenceImageBase64 } = media;
    const { json, msg, sourceEventId, sourceChannelId, rulesDeps, albumId, firstOfAlbum } = media;
    const senderName =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') ||
      msg.from?.username ||
      json.senderName ||
      'Telegram Client';

    // Check if this is an interactive revision / feedback message on an active task in this Telegram chat
    let feedbackTargetTask: any = null;
    let classification: any = null;
    // The design a reply answers. It is the context the message is read in, not a verdict: a reply
    // used to be a change request whatever it said, so "thanks" under a draft started a paid redesign.
    let replyTarget: any = null;
    // Set when this message stated a lasting preference and it was saved for the client.
    let standingRuleSaved = false;
    const repliedTo = msg.reply_to_message
      ? {
          text: String(msg.reply_to_message.caption || msg.reply_to_message.text || ''),
          fromBot: Boolean(msg.reply_to_message.from?.is_bot),
        }
      : null;

    if (msg.reply_to_message) {
      const replyContext =
        (msg.reply_to_message.caption || msg.reply_to_message.text || '') +
        ' ' +
        (msg.reply_to_message.reply_markup ? JSON.stringify(msg.reply_to_message.reply_markup) : '');
      const uuidMatch = replyContext.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (uuidMatch) {
        replyTarget = tasks.get(uuidMatch[1]) || null;
        if (!replyTarget && taskRepo && db) {
          try {
            const dbTask = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
              return await taskRepo.findById(uuidMatch[1], DEFAULT_TENANT_ID, trx);
            });
            if (dbTask) {
              replyTarget = {
                id: dbTask.id,
                tenantId: dbTask.tenant_id,
                clientId: dbTask.client_id,
                status: dbTask.state,
                title: dbTask.title,
                sourcePlatform: 'telegram',
                sourceChannelId,
                rawText: dbTask.description,
                createdAt: dbTask.created_at,
                updatedAt: dbTask.updated_at,
              };
            }
          } catch (dbErr) {
            // A database that cannot answer now may answer on the next attempt; a 404 here was final
            // for the poller, and the sender's reply was dropped without a word.
            log.warn('[Core] Failed to find reply task in DB:', dbErr);
            return problem(c, 503, 'Database unavailable', 'The replied-to design could not be looked up; retry');
          }
        }
        if (!replyTarget) {
          // The reply names a task this office does not hold (a message from another deployment,
          // or a test). The message is read as if it were not a reply, rather than dropped.
          log.warn(`[Core] Telegram reply referenced unknown task UUID ${uuidMatch[1]}; reading the message on its own.`);
        }
      }
    }
    let replyDesignOf: { chat: string | null; newest: string; of: string } | null = null;
    if (replyTarget && db && sourceChannelId && sourceChannelId !== 'tg_default' && isValidUuid(String(replyTarget.id))) {
      try {
        replyDesignOf = { ...(await replyDesign(String(replyTarget.id))), of: String(replyTarget.id) };
      } catch (err) {
        log.warn('[Core] Could not look up the design a reply is about:', err);
        return problem(c, 503, 'Database unavailable', 'The replied-to design could not be looked up; retry');
      }
      if (replyDesignOf.chat && replyDesignOf.chat !== sourceChannelId) {
        // A draft forwarded from another chat: its design is not this chat's to change.
        log.warn('[Core] A reply named a design made for another chat; reading the message on its own.');
        replyTarget = null;
        replyDesignOf = null;
      }
    }

    // A reply to a question asked before a change was made is its answer, in the requester's own
    // words, whatever it says: read as a new change request, it would revise a task that has no design.
    if (replyTarget && db && sourceChannelId && sourceChannelId !== 'tg_default' && rawText.trim()) {
      let pending: PendingQuestion | null;
      let followUp: string | null = null;
      try {
        pending = await pendingQuestion(String(replyTarget.id), sourceChannelId);
        if (!pending) followUp = await questionFollowUp(String(replyTarget.id));
      } catch (err) {
        // Read as a change instead, the reply would start a new design; retried, it reaches the answer.
        log.warn('[Core] Could not tell whether a reply answers a question:', err);
        return problem(c, 503, 'Database unavailable', 'Whether this reply answers a question could not be checked; retry');
      }
      if (pending) {
        const taken = await answerQuestion({ chat: sourceChannelId, pending, answer: rawText, updateId: sourceEventId, rawJson: json, referenceImageBase64 });
        if (!taken.ok) return problem(c, 503, 'Answer not saved', 'The answer could not be saved; the message will be retried');
        return c.json({ ok: true, status: 'QUESTION_ANSWERED', taskId: pending.taskId, revisionTaskId: taken.revisionTaskId }, 200);
      }
      if (followUp && followUp !== String(replyTarget.id) && taskRepo) {
        // A reply to a question that no longer waits is about the design it asked about, as it now is.
        const next = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) => taskRepo.findById(followUp!, DEFAULT_TENANT_ID, trx)).catch(() => null);
        // Unread, the reply fell back to the question's own task and started a change from it.
        if (!next) return problem(c, 503, 'Database unavailable', 'The revision that answered the question could not be read; retry');
        {
          replyTarget = {
            id: next.id,
            tenantId: next.tenant_id,
            clientId: next.client_id,
            status: next.state,
            title: next.title,
            sourcePlatform: 'telegram',
            sourceChannelId,
            rawText: next.description,
            createdAt: next.created_at,
            updatedAt: next.updated_at,
          };
        }
      }
    }

    // A reply to an older draft of a design changed since is about the design as it now is.
    let changedNewestVersion = false;
    // (Not when the reply was already moved on, to the revision that answered a question.)
    if (replyTarget && replyDesignOf && replyDesignOf.of === String(replyTarget.id) && replyDesignOf.newest !== replyDesignOf.of && taskRepo && db) {
      const newestId = replyDesignOf.newest;
      const next = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) => taskRepo.findById(newestId, DEFAULT_TENANT_ID, trx)).catch(() => null);
      if (!next) return problem(c, 503, 'Database unavailable', 'The newest version of the replied-to design could not be read; retry');
      replyTarget = {
        id: next.id,
        tenantId: next.tenant_id,
        clientId: next.client_id,
        status: next.state,
        title: next.title,
        sourcePlatform: 'telegram',
        sourceChannelId,
        rawText: next.description,
        createdAt: next.created_at,
        updatedAt: next.updated_at,
      };
      changedNewestVersion = true;
    }

    if (!feedbackTargetTask && /^(please\s+)?(revise|change|fix|update|remove|add|replace|make|adjust|correct)\b/i.test(rawText.trim())) {
      const textUuidMatch = rawText.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (textUuidMatch) {
        feedbackTargetTask = tasks.get(textUuidMatch[1]);
        if (!feedbackTargetTask && taskRepo && db) {
          try {
            const dbTask = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
              return await taskRepo.findById(textUuidMatch[1], DEFAULT_TENANT_ID, trx);
            });
            if (dbTask) {
              feedbackTargetTask = {
                id: dbTask.id,
                tenantId: dbTask.tenant_id,
                clientId: dbTask.client_id,
                status: dbTask.state,
                title: dbTask.title,
                sourcePlatform: 'telegram',
                sourceChannelId,
                createdAt: dbTask.created_at,
                updatedAt: dbTask.updated_at,
              };
            }
          } catch (dbErr) {
            log.warn('[Core] Failed to find text UUID task in DB:', dbErr);
          }
        }
        // Like a reply, "revise <id>" changes only a design made for this chat, as it now is.
        if (feedbackTargetTask && db && sourceChannelId && sourceChannelId !== 'tg_default' && isValidUuid(String(feedbackTargetTask.id))) {
          const named = await replyDesign(String(feedbackTargetTask.id)).catch(() => null);
          if (!named) return problem(c, 503, 'Database unavailable', 'The named design could not be looked up; retry');
          if (named.chat && named.chat !== sourceChannelId) {
            log.warn('[Core] A message named a design made for another chat; reading it on its own.');
            feedbackTargetTask = null;
          } else if (named.newest !== String(feedbackTargetTask.id) && taskRepo) {
            const next = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) => taskRepo.findById(named.newest, DEFAULT_TENANT_ID, trx)).catch(() => null);
            if (!next) return problem(c, 503, 'Database unavailable', 'The newest version of the named design could not be read; retry');
            feedbackTargetTask = { id: next.id, tenantId: next.tenant_id, clientId: next.client_id, status: next.state, title: next.title, sourcePlatform: 'telegram', sourceChannelId, createdAt: next.created_at, updatedAt: next.updated_at };
            changedNewestVersion = true;
          }
        }
      }
    }

    if (!feedbackTargetTask && sourceChannelId && sourceChannelId !== 'tg_default') {
      const isReply = Boolean(msg.reply_to_message);
      // The design the message is read against: the one a reply answers; else this chat's most
      // recent request in PostgreSQL, revisions included (the in-memory map never held revisions, so
      // a second change bound to the original design and lost the first); without a database, the
      // no-database store's (services/no-database-store.ts).
      let pendingTasks: any[] = replyTarget ? [replyTarget] : [];
      if (!replyTarget && db) {
        try {
          // Only a request that names an earlier design ("option 2", "the second design") reads
          // against it: "make the two dates gold" bound to the chat's second-newest request.
          const isSecond = /\b(?:plan|option|design|draft)\s*(?:2|two)\b|\b(?:second|2nd)\s+(?:plan|option|design|draft)\b/i.test(rawText);
          const isThird = /\b(?:plan|option|design|draft)\s*(?:3|three)\b|\b(?:third|3rd)\s+(?:plan|option|design|draft)\b/i.test(rawText);
          const ordinalIndex = isThird ? 2 : isSecond ? 1 : 0;

          const recentDbTask = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
            return await sql<any>`
              SELECT t.id, t.tenant_id, t.client_id, t.state, t.title, t.description, t.created_at, t.updated_at, o.payload,
                (SELECT encode(e.content, 'base64')
                 FROM hawa.canva_export_bytes e
                 WHERE e.task_id = t.id AND e.format = 'png'
                 ORDER BY e.created_at DESC LIMIT 1) AS preview_image
              FROM hawa.tasks t
              JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
              WHERE o.payload->>'sourceChannelId' = ${sourceChannelId}
                AND t.created_at > now() - interval '48 hours'
                AND t.client_id IS NOT NULL
                AND COALESCE(o.payload->>'isInstructionOnly', 'false') != 'true'
              ORDER BY t.created_at DESC LIMIT 5`.execute(trx);
          });
          const row = recentDbTask.rows[ordinalIndex] || recentDbTask.rows[0];
          if (row) {
            const rehydrated = {
              id: row.id,
              tenantId: row.tenant_id,
              clientId: row.client_id,
              status: toApiTaskStatus(row.state),
              title: row.title,
              sourcePlatform: 'telegram',
              sourceChannelId,
              rawText: row.payload?.rawRequestText || row.description,
              isInstructionOnly: row.payload?.isInstructionOnly === true || row.payload?.isInstructionOnly === 'true',
              previewImageBase64: row.preview_image && row.preview_image.length > 200 ? row.preview_image : undefined,
              previewImageUrl: row.preview_image && row.preview_image.startsWith('http') ? row.preview_image : undefined,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            };
            pendingTasks = [rehydrated];
          }
        } catch (dbErr) {
          log.warn('[Core] Failed to query recent task by sourceChannelId:', dbErr);
        }
      }

      if (!replyTarget && pendingTasks.length === 0) {
        const maxAgeMs = 2 * 3600 * 1000;
        const nowMs = Date.now();
        pendingTasks = Array.from(tasks.values())
          .filter((t: any) =>
            t.sourceChannelId === sourceChannelId &&
            t.clientId &&
            t.clientId !== 'client-office-1' &&
            isValidUuid(t.clientId) &&
            !t.isInstructionOnly &&
            (nowMs - new Date(t.createdAt).getTime() <= maxAgeMs) &&
            // IN_PROGRESS (a change asked for in chat) is REVISION_REQUESTED now; COMPLETED and
            // CLARIFICATION_REQUIRED were words no task carried in the database.
            (t.status === 'RECEIVED' || t.status === 'AWAITING_APPROVAL' || t.status === 'REVISION_REQUESTED' || t.status === 'OPERATOR_REQUIRED')
          )
          .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      }

      if (pendingTasks.length > 0 && !pendingTasks[0].previewImageBase64 && db) {
        try {
          const imgRow = await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
            return await sql<any>`
              SELECT encode(content, 'base64') AS b64
              FROM hawa.canva_export_bytes
              WHERE task_id = ${pendingTasks[0].id}::uuid AND format = 'png'
              ORDER BY created_at DESC LIMIT 1`.execute(trx);
          });
          if (imgRow.rows[0]?.b64) {
            pendingTasks[0].previewImageBase64 = imgRow.rows[0].b64;
          }
        } catch (imgErr) {
          log.warn('[Core] Failed to fetch previewImageBase64 for pending task:', imgErr);
        }
      }

      // The answer to a clarification question completes the message it was asked about. The
      // question used to be sent and the message forgotten, so "revise" became a change request
      // reading "revise" and the brief itself was lost.
      const pendingClarification = pendingClarifications.get(sourceChannelId);
      let answeredKind: 'feedback' | 'new_brief' | undefined;
      if (pendingClarification && Date.now() - pendingClarification.at < 3600_000 && rawText.trim().length <= 60) {
        const answer = rawText.trim();
        // Only an answer to the question counts: a whole short reply, or any reply to the question
        // itself. "Another poster: Eid Mubarak" is a new message, not the answer "new".
        const toQuestion = /Clarification needed/i.test(String(msg.reply_to_message?.text || ''));
        const NEW_ANSWER = /^(new|new one|a new one|new design|a new design|separate|fresh|نوێ|دیزاینی نوێ|دیزاینێکی نوێ)[\s.!]*$/iu;
        const REVISE_ANSWER = /^(revise|revise it|revision|edit|edit it|change it|update it|the same|same design|previous|the previous one|دەستکاری|دەستکاری بکە|پێشوو|هەمان دیزاین)[\s.!]*$/iu;
        if (NEW_ANSWER.test(answer) || (toQuestion && /\bnew\b|نوێ/iu.test(answer))) answeredKind = 'new_brief';
        else if (REVISE_ANSWER.test(answer) || (toQuestion && /\b(revis\w*|change|edit|same|previous)\b|دەستکاری|پێشوو/iu.test(answer))) answeredKind = 'feedback';
        if (answeredKind) {
          pendingClarifications.delete(sourceChannelId);
          rawText = pendingClarification.rawText;
          if (!referenceImageBase64 && pendingClarification.referenceImageBase64) referenceImageBase64 = pendingClarification.referenceImageBase64;
          if (pendingClarification.task) pendingTasks = [pendingClarification.task];
        }
      }
      // Any other message means the sender moved on; the question is dropped, not left to capture
      // a later "new" as its answer.
      if (pendingClarification && !answeredKind) pendingClarifications.delete(sourceChannelId);

      const recentForClassifier = pendingTasks[0]
        ? {
            id: pendingTasks[0].id,
            title: pendingTasks[0].title,
            rawText: pendingTasks[0].rawText || pendingTasks[0].payloadText,
            copy: pendingTasks[0].copyEn ? [pendingTasks[0].copyEn] : undefined,
            previewImageBase64: pendingTasks[0].previewImageBase64,
            previewImageUrl: pendingTasks[0].previewImageUrl,
          }
        : null;
      classification = answeredKind
        ? {
            kind: answeredKind,
            intent: answeredKind === 'feedback' ? 'revision_feedback' : 'new_brief',
            confidence: 1,
            isInstructionOnly: false,
            directive: rawText,
            reason: 'The sender answered the clarification question',
          }
        : await classifyInboundTelegramMessage({
            messageText: rawText,
            recentTask: recentForClassifier,
            // A reply counts as one to a design only when it names one: a full brief sent in reply to
            // the bot's greeting was asked "is this a change to the design?" (review of 2026-09-24).
            hasReplyTo: isReply && Boolean(replyTarget),
            repliedTo,
            hasReferenceImage: Boolean(referenceImageBase64),
          });

      // Handle clarification when confidence is below threshold (< 0.75)
      if (classification.needsClarification && classification.clarifyingQuestion) {
        pendingClarifications.set(sourceChannelId, { rawText, referenceImageBase64, task: pendingTasks[0], at: Date.now() });
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: `❓ <b>Clarification needed:</b>\n\n${escapeTelegramHtml(classification.clarifyingQuestion)}`,
          parse_mode: 'HTML',
        });
        return c.json({ ok: true, status: 'CLARIFICATION_REQUIRED', question: classification.clarifyingQuestion });
      }

      // "From now on, always put the logo bottom-right", sent on its own, is a rule for later
      // designs. Read as a change to the chat's latest draft, it also paid for a revision nobody
      // asked for; read as a brief, the sentence became a design. Only a reply to a draft applies
      // a rule to that draft as well.
      const ruleSentence = !isReply && isStandingRule(rawText) && (
        classification.kind === 'feedback' ||
        (classification.kind === 'new_brief' && rawText.trim().length <= 200 && !/\n/.test(rawText.trim()))
      );
      if (ruleSentence) {
        classification = { ...classification, kind: 'standing_rule', standingRule: classification.standingRule || rawText.trim() };
      }

      // A lasting preference is saved for the client and applies to every later design. On its own
      // it changes nothing now; said with a change to a draft, the draft is revised as well.
      // A new brief that also says "and from now on …" is designed, and its rule is saved too.
      if (classification.standingRule && (classification.kind === 'standing_rule' || classification.kind === 'feedback' || classification.kind === 'new_brief')) {
        if (!rulesDeps) return problem(c, 503, 'Rules unavailable', 'Standing rules need the database');
        // Said about a design (a reply, or a change to the latest one), the rule is that design's
        // client's, not whichever client the chat asked for last.
        const aboutDesign = classification.kind === 'feedback' || Boolean(replyTarget);
        const designClient = aboutDesign && pendingTasks[0]?.clientId && isValidUuid(pendingTasks[0].clientId)
          ? await ruleClientById(rulesDeps, pendingTasks[0].clientId)
          : undefined;
        const saved = await saveChatRule(rulesDeps, {
          sourceChannelId,
          sourceEventId,
          ruleText: classification.standingRule,
          originalText: rawText,
          client: designClient,
        });
        standingRuleSaved = saved.saved;
        if (classification.kind === 'standing_rule') {
          if (saved.saved) await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_standing_rule', json);
          return c.json({ ok: true, status: saved.saved ? 'RULE_SAVED' : 'RULE_CLIENT_UNKNOWN', rule: classification.standingRule, ruleId: saved.ruleId }, 200);
        }
      } else if (classification.kind === 'standing_rule') {
        // Read as a lasting preference with nothing to restate: saved in the sender's own words.
        if (!rulesDeps) return problem(c, 503, 'Rules unavailable', 'Standing rules need the database');
        const designClient = replyTarget?.clientId && isValidUuid(replyTarget.clientId) ? await ruleClientById(rulesDeps, replyTarget.clientId) : undefined;
        const saved = await saveChatRule(rulesDeps, { sourceChannelId, sourceEventId, ruleText: rawText.trim(), originalText: rawText, client: designClient });
        if (saved.saved) await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_standing_rule', json);
        return c.json({ ok: true, status: saved.saved ? 'RULE_SAVED' : 'RULE_CLIENT_UNKNOWN', ruleId: saved.ruleId }, 200);
      }

      // A picture sent with a remark and no request ("use this for the poster") is kept for the
      // request that follows. It used to be answered with a greeting and the picture lost.
      if ((classification.kind === 'question' || classification.kind === 'other') && referenceImageBase64 && db) {
        const persisted = await persistChatIntake(db, {
          platform: 'telegram',
          sourceEventId,
          sourceChannelId,
          rawText,
          rawJson: json,
          clientId: null,
          title: `${senderName}: reference image (awaiting request)`,
          designInstructions: rawText,
          exactCopy: [],
          isInstructionOnly: true,
          autoGenerate: false,
          studioOptions: { referenceImageBase64, ...(albumId ? { mediaGroupId: albumId } : {}) },
        });
        if (firstOfAlbum) {
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
            text:
              `🖼️ <b>Picture saved with your note.</b>\n\n` +
              `<i>Send the request text now and the design will use it. Nothing is designed from pictures alone.</i>`,
            parse_mode: 'HTML',
          });
        }
        broadcast('task:created', persisted.task);
        return c.json({ ok: true, referenceAwaitingRequest: true, task: persisted.task }, 201);
      }

      // Thanks or an OK in reply to a draft is acknowledged, and nothing is redesigned.
      if (classification.kind === 'other' && replyTarget) {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: /[\u0600-\u06FF]/.test(rawText)
            ? '🙏 سوپاس. بۆ هەر گۆڕانکارییەک، وەڵامی وێنەی دیزاینەکە بدەرەوە و بنووسە چی بگۆڕدرێت.'
            : '🙏 Thank you. If the design is right, tap ✅ Approve design under it; to change anything, reply to the design with the change.',
        });
        // Recorded, so a redelivered update is not thanked twice and the draft counts as answered
        // (no reminder the next morning); it returned without a record (review of 2026-09-24).
        await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_reply_ack', { taskId: String(replyTarget.id) });
        return c.json({ ok: true, status: 'PROCESSED', kind: 'other', taskId: replyTarget.id });
      }

      // Handle questions and general chatter without polluting task pipeline
      if (classification.kind === 'question' || classification.kind === 'other') {
        if (db) {
          try {
            const inquiryHash = crypto.createHash('sha256').update(JSON.stringify(json ?? { text: rawText })).digest('hex');
            const sourceId = `${sourceChannelId}:${sourceEventId}`;
            await withRlsContext(db, { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
              const existing = await trx.selectFrom('inbox_events').select(['id'])
                .where('tenant_id', '=', DEFAULT_TENANT_ID)
                .where('source_account_id', '=', 'telegram')
                .where('source_event_id', '=', sourceId).executeTakeFirst();
              if (!existing) {
                await trx.insertInto('inbox_events').values({
                  tenant_id: DEFAULT_TENANT_ID,
                  source_account_id: 'telegram',
                  source_event_id: sourceId,
                  event_kind: `telegram_inquiry_${classification.kind}`,
                  payload: json ?? { text: rawText },
                  payload_hash: inquiryHash,
                  verified: true,
                } as any).execute();
              }
            });
          } catch (inqErr) {
            log.warn('[TelegramIngress] Failed to persist inquiry event to inbox_events:', inqErr);
          }
        }
        if (!sourceChannelId || sourceChannelId === 'tg_default') {
          // Returning PROCESSED here without sending anything is how a person ends up messaging
          // the system and getting silence — the reported symptom that started this work. The
          // reply still cannot be sent without a channel, but the drop is no longer invisible.
          log.error(
            `[telegram] Cannot reply to a '${classification.kind}' message: no usable source ` +
              `channel (got ${JSON.stringify(sourceChannelId)}). Sender=${JSON.stringify(senderName)} ` +
              `event=${JSON.stringify(sourceEventId)}. The sender received no answer.`
          );
          return c.json({
            ok: true,
            status: 'UNANSWERABLE_NO_CHANNEL',
            kind: classification.kind,
          });
        }
        {
          const isSorani = /[\u0600-\u06FF]/.test(rawText);
          const replyText = classification.kind === 'question'
            ? (isSorani
                ? `ℹ️ <b>پەیامەکەت گەیشت:</b> "${escapeTelegramHtml(cutText(rawText, 500))}"\n\nئەگەر دەتەوێت داواکاری دیزاین بنێریت، تکایە دەقی ڕاگەیاندن، بەروار، و شوێن بنێرە.`
                : `ℹ️ <b>Question received:</b> "${escapeTelegramHtml(cutText(rawText, 500))}"\n\nTo generate a design, please send your announcement text, date, and venue. For revisions on an existing design, reply directly to the preview message.`)
            : (isSorani
                ? `👋 سڵاو! چۆن دەتوانم یارمەتیت بدەم لە دیزاینەکانتدا؟ تکایە دەقی دیزاینەکەت بنێرە.`
                : `👋 Hello! How can Hawa Creative OS assist you today? Please send your event brief or announcement copy to start.`);
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
            text: replyText,
            parse_mode: 'HTML',
          });
        }
        return c.json({ ok: true, status: 'PROCESSED', kind: classification.kind });
      }

      // Explicit routing: only 'feedback' intent binds to an existing task
      if (classification.kind === 'feedback' && pendingTasks.length > 0) {
        feedbackTargetTask = pendingTasks[0];
      } else {
        feedbackTargetTask = null;
      }
    }
    return { ...media, rawText, referenceImageBase64, senderName, feedbackTargetTask, classification, standingRuleSaved, changedNewestVersion };
  }

  return { readReply };
}
