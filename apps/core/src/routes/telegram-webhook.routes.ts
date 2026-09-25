import type { Context } from 'hono';
import { escapeTelegramHtml } from '@hawa/integrations';
import { cutText, secretsEqual } from '../core-helpers.js';
import { log, bindLogContext } from '../logging.js';
import { splitBilingualRequest } from '../services/chat-intake.js';
import { parseRequesterAction } from '../services/requester-actions.js';
import { classifyInboundTelegramMessage } from '../services/telegram-classifier.js';
import { createChatCampaignIntake } from '../services/chat-campaign-intake.js';
import { intakeRefused } from '../services/channel-kill-switches.js';
import { createTelegramUpdateState } from '../services/telegram-intake/update-state.js';
import { createTelegramRequesterActions } from '../services/telegram-intake/requester-actions.js';
import { createTelegramCallbacksAndCommands } from '../services/telegram-intake/callbacks-and-commands.js';
import { createTelegramMedia } from '../services/telegram-intake/media.js';
import { createTelegramReplies, type PendingClarifications } from '../services/telegram-intake/replies.js';
import { createTelegramChanges } from '../services/telegram-intake/changes.js';
import {
  answerDecision, courtesyText, decideSession, lifecycleMode, lifecycleTargetUnrouted, runWithDecideSession, type IntakeDecideSession,
} from '../services/telegram-intake/decide-mode.js';
import { routeForCaller } from '../services/telegram-intake/lifecycle-forward.js';
import { parkedUpdateChat, type PolledUpdate } from '../services/polled-update-dispatch.js';
import type { RoutableUpdate } from '@hawa/domain';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import type { RouteContext } from './types.js';

/**
 * POST /webhooks/telegram, moved from createApp (architecture programme 1.3, SPLIT_PLAN.md G9): the
 * secret, parsing, the kill switch, the sender allowlist and the office's refusals, then each stage
 * of intake in services/telegram-intake/ in turn, and a new request at the end. The getUpdates
 * poller in app.ts hands every polled update to this route (Phase 2.1 moves it to the worker).
 */
export function registerTelegramWebhookRoutes(ctx: RouteContext): void {
  const { registerRoute } = ctx;
  const { db, telegramIntakeUsers, problem, readCurrentTask, isProduction, channelKillSwitches } = ctx;
  // createApp always builds the bridge; the shared context types it as optional.
  const telegramBridge = ctx.telegramBridge ?? (() => { throw new Error('Telegram intake needs the Telegram bridge'); })();
  // Albums already answered in a chat (one reply per album, not one per photo).
  const acknowledgedAlbums = new Set<string>();
  // A message the bot asked about ("revise the last design, or a new one?"), kept until answered.
  const pendingClarifications: PendingClarifications = new Map();
  const { telegramUpdateHandled } = createTelegramUpdateState(ctx);
  const { handleRequesterAction } = createTelegramRequesterActions(ctx);
  const { handleCallbackQuery, handleCommand } = createTelegramCallbacksAndCommands(ctx);
  const { readMedia } = createTelegramMedia(ctx, acknowledgedAlbums);
  const { readReply } = createTelegramReplies(ctx, pendingClarifications);
  const { makeChange } = createTelegramChanges(ctx);
  const { ingestChatCampaignTask, draftChatRequest } = createChatCampaignIntake(ctx);

  // Webhooks
  registerRoute('post', '/webhooks/telegram', async (c: Context) => {
    // Inside ChatInbox's intake call (routes/lifecycle-internal.routes.ts): its session decides.
    if (decideSession()) return readTelegramUpdate(c);
    // Core's own poller or a real webhook: intake runs in a legacy session too, so an update aimed at
    // a request the lifecycle owns is decided, never acted on here, and Core routes that decision
    // itself through Restate's ingress with the keys ChatInbox would use (review of 2.3C: it was
    // refused 409, final for the poller, and the requester heard nothing).
    const session: IntakeDecideSession = { mode: 'legacy', chat: {} };
    const res = await runWithDecideSession(session, () => readTelegramUpdate(c));
    if (!session.decision || !session.update) return res;
    const decision = session.decision;
    const routed = await routeForCaller(telegramBridge, parkedUpdateChat(session.update as PolledUpdate) ?? '', session.update, decision);
    if (routed.outcome === 'routed') return c.json({ ok: true, routed: decision.kind, updateId: session.update.update_id }, 200);
    if (routed.outcome === 'retry') return problem(c, 503, 'Lifecycle Unreachable', 'Restate did not take the update for the request lifecycle; it is asked again');
    return lifecycleTargetUnrouted(c, decision);
  });

  async function readTelegramUpdate(c: Context): Promise<Response> {
    const secret = c.req.header('x-telegram-bot-api-secret-token');
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secretsEqual(secret, expectedSecret)) {
      return problem(c, 401, 'Unauthorized', 'Invalid or missing Telegram webhook secret token');
    }
    // The same answer the WhatsApp kill switch gives. Telegram keeps a refused webhook update and
    // sends it again, so nothing is lost while intake is off; nothing is read or started either.
    // Refused too while this process has not yet read the switch from Postgres: until then its copy
    // says "on" whatever the office set, and a Core started with Postgres down took Telegram intake.
    if (await intakeRefused(channelKillSwitches, 'telegram')) {
      return problem(c, 503, 'Service Unavailable', 'Telegram intake is disabled by the office kill switch. Fall back to Hawa Desk intake at /desk.');
    }

    const rawBody = await c.req.arrayBuffer();
    const bodyText = new TextDecoder().decode(rawBody);
    let json: any = {};
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = { text: bodyText };
    }

    const sourceEventId = String(json.update_id ?? json.eventId ?? '');
    if (json.update_id == null && !json.eventId) return problem(c, 400, 'Missing event ID', 'Telegram must supply a stable update ID');
    // What a decision made below is routed with, when Core routes it itself.
    const decideIn = decideSession();
    if (decideIn && Number.isSafeInteger(json.update_id)) decideIn.update = json as RoutableUpdate;
    // Every line written while this update is handled names its chat (logging.ts).
    bindLogContext({ chatId: String(json.message?.chat?.id ?? json.callback_query?.message?.chat?.id ?? json.channel_post?.chat?.id ?? json.edited_message?.chat?.id ?? json.sourceChannelId ?? '') });
    const verifiedSender = String(json.callback_query?.from?.id || json.message?.from?.id || json.edited_message?.from?.id || '');
    const isIntakeOpen = telegramIntakeUsers.includes('*') || process.env.TELEGRAM_INTAKE_ALLOWED_USERS === '*';
    if (isProduction && !isIntakeOpen && (!telegramIntakeUsers.length || !telegramIntakeUsers.includes(verifiedSender))) {
      return problem(c, 403, 'Forbidden', 'Sender is not in the configured office allowlist');
    }
    // The requester's own buttons under a draft come first; every other button is refused below.
    const requesterAction = json.callback_query ? parseRequesterAction(json.callback_query.data) : null;
    if (requesterAction) return handleRequesterAction(c, json.callback_query, requesterAction, sourceEventId);

    // Chat actions never approve or modify a design (ADR-022). The command text is read from every
    // place the command dispatcher below reads it: checking only message.text let a channel post or a
    // bare-text body through to /approve, which then created the named task out of nothing.
    const commandSource = json.message || json.channel_post || json;
    const commandText = String(commandSource?.text || commandSource?.caption || json.text || '');
    // Prefix match, as the bridge's handleCommand uses: "/approve_now <id>" is dispatched as /approve.
    if (json.callback_query || /^\s*\/(approve|publish|revise|reject)/i.test(commandText)) {
      if (json.callback_query?.id) {
        await telegramBridge?.answerCallbackQuery(
          json.callback_query.id,
          'Desk review required: Approve in Hawa Desk',
          true
        ).catch(() => {});
      } else if (commandSource?.chat?.id) {
        // A typed /approve got no reply at all: the 422 below is final for the poller, so the sender
        // was left waiting on a command that had been refused.
        await telegramBridge?.dispatchOutboundMessage(String(commandSource.chat.id), {
          text:
            `ℹ️ <b>Designs are approved in Hawa Desk, not in chat.</b>\n\n` +
            `<i>To change a draft, reply to its image with what to change. To approve it, open the task in Hawa Desk.</i>`,
          parse_mode: 'HTML',
        }).catch(() => undefined);
      }
      return problem(c, 422, 'Desk review required', 'Use authenticated Hawa Desk review bound to a captured revision; chat actions cannot approve or modify a design');
    }

    // An edited message is not a new request, and its text was read as empty: the edit vanished
    // and the design went ahead with the old words. The sender is told what to do instead.
    if (json.edited_message && !json.message) {
      const editedChat = json.edited_message.chat?.id;
      if (editedChat !== undefined && editedChat !== null) {
        await telegramBridge?.dispatchOutboundMessage(String(editedChat), {
          text:
            `✏️ <b>Edits to a message already sent are not picked up.</b>\n\n` +
            `<i>Send the corrected text as a new message. To change a draft you already received, reply to its image with the change.</i>`,
          parse_mode: 'HTML',
        }).catch(() => undefined);
      }
      return c.json({ ok: true, ignored: true, reason: 'EDITED_MESSAGE', updateId: sourceEventId }, 200);
    }

    const callbackAnswer = await handleCallbackQuery(c, json);
    if (callbackAnswer) return callbackAnswer;

    const msg = json.message || json.channel_post || json;
    // An update Telegram delivers again (Core restarted after handling it and before the poller
    // stored its position) was read again from the top: transcribed, classified, and able to start
    // a second paid design or remove a second rule. Anything this update already saved ends it here,
    // before any paid call.
    const updateChat = String(msg.chat?.id || json.sourceChannelId || '');
    if (db && updateChat && updateChat !== 'tg_default' && json.update_id != null) {
      // With the database unreachable nothing could be saved anyway: the update waits for it here,
      // not after a paid transcription and classification that the poller repeats every 30 s.
      const handledBefore = await telegramUpdateHandled(updateChat, sourceEventId).catch((err: unknown) => {
        log.warn('[TelegramIngress] Could not check whether the update was handled before:', err);
        return null;
      });
      if (handledBefore === null) return problem(c, 503, 'Database Unavailable', 'The update is retried when the database answers');
      if (handledBefore) {
        // The request this update saved, as the first delivery answered it.
        const saved = handledBefore.taskId ? await readCurrentTask(handledBefore.taskId) : undefined;
        return c.json({ ok: true, duplicate: true, updateId: sourceEventId, ...(handledBefore.taskId ? { task: saved || { id: handledBefore.taskId } } : {}) }, 200);
      }
    }
    const media = await readMedia(c, { json, msg, sourceEventId, verifiedSender });
    if (media instanceof Response) return media;
    // A message with a picture is read on Core's own path even in a lifecycle chat: the lifecycle's
    // rounds do not take pictures yet (Core would fetch them by file id), and a picture joins the
    // requests and albums Core keeps. Buttons, replies and changes aimed at a lifecycle request are
    // still routed to it below.
    const session = decideSession();
    if (session?.mode === 'lifecycle' && media.referenceImageBase64) {
      session.mode = 'legacy';
      session.legacyBecause = 'PICTURE';
    }

    const commandAnswer = await handleCommand(c, media);
    if (commandAnswer) return commandAnswer;

    const reply = await readReply(c, media);
    if (reply instanceof Response) return reply;
    const changeAnswer = await makeChange(c, reply);
    if (changeAnswer) return changeAnswer;

    // A new request.
    const { rawText, voiceTranscript, referenceImageBase64, sourceChannelId, senderName, feedbackTargetTask } = reply;
    let { classification } = reply;
    if (!classification) {
      classification = await classifyInboundTelegramMessage({
        messageText: rawText,
        recentTask: null,
        hasReplyTo: Boolean(msg.reply_to_message),
        hasReferenceImage: Boolean(referenceImageBase64),
      });
    }

    // Refuse auto-generation when the message contains ONLY instructions or styling feedback without any copy/brief
    if (!feedbackTargetTask && classification?.isInstructionOnly) {
      const instructionNotice =
        `📝 <b>Design instruction received:</b> "${escapeTelegramHtml(cutText(rawText, 500))}"\n\n` +
        `⚠️ <i>No copy or event details were found in your message. Automatic drafting requires the exact text or announcement details to place on the design.</i>\n\n` +
        `<i>Please send the event title, date, venue, or body copy, and the art director will combine it with your styling preferences.</i>`;
      // In a lifecycle chat it is a new request like any other, opened by RequestLifecycle for the art
      // director (never designed automatically); the notice goes out through TelegramSender, before
      // the request's own acknowledgement, as it did here.
      if (lifecycleMode()) {
        const draft = await draftChatRequest({
          platform: 'telegram', sourceEventId, sourceChannelId, senderName, rawText, explicitClientId: json.clientId, autoGenerate: false, isInstructionOnly: true,
        });
        return answerDecision(c, {
          kind: 'new_request', tenantId: DEFAULT_TENANT_ID, requests: [{ index: 0, draft }],
          messages: [courtesyText(sourceChannelId, `instruction:${sourceChannelId}:${sourceEventId}`, instructionNotice, 'HTML')],
        });
      }
      if (sourceChannelId && sourceChannelId !== 'tg_default') {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, { text: instructionNotice, parse_mode: 'HTML' });
      }
      const hostHeader = c.req.header('x-forwarded-host') || c.req.header('host');
      const incomingDeskBase = hostHeader ? `https://${hostHeader}` : undefined;
      const result = await ingestChatCampaignTask({
        platform: 'telegram',
        sourceEventId,
        sourceChannelId,
        senderName,
        rawText,
        voiceTranscript,
        referenceImageBase64,
        explicitClientId: json.clientId,
        autoGenerate: false,
        deskBaseUrl: incomingDeskBase,
        rawJson: json,
        isInstructionOnly: true,
      });
      return c.json({ ok: true, task: result.task, instructionOnly: true, notification: result.notification }, 201);
    }

    const shouldGenerate = c.req.query('generate') === 'true' || json.autoGenerate === true || process.env.AUTO_GENERATE_CHAT_DESIGNS === 'true';

    // In a lifecycle chat a new request is opened by RequestLifecycle, not saved here (PHASE2_DESIGN.md
    // 2.3): intake answers what it read, one draft per graphic, and ChatInbox opens a request for each.
    if (lifecycleMode()) {
      const bilingual = splitBilingualRequest(rawText);
      const parts = bilingual ? [bilingual.en, bilingual.ckb] : [rawText];
      const requests = [];
      for (const [index, text] of parts.entries()) {
        const draft = await draftChatRequest({
          platform: 'telegram', sourceEventId, sourceChannelId, senderName, rawText: text, explicitClientId: json.clientId, autoGenerate: shouldGenerate,
        });
        requests.push({ index, draft });
      }
      return answerDecision(c, { kind: 'new_request', tenantId: DEFAULT_TENANT_ID, requests });
    }

    const hostHeader = c.req.header('x-forwarded-host') || c.req.header('host');
    const incomingDeskBase = hostHeader ? `https://${hostHeader}` : undefined;

    try {
    // English and Kurdish copy for one graphic per language becomes two requests, each read and
    // designed on its own (see splitBilingualRequest).
    const bilingual = splitBilingualRequest(rawText);
    if (bilingual) {
      const results = [];
      for (const [lang, text] of [['en', bilingual.en], ['ckb', bilingual.ckb]] as const) {
        results.push(
          await ingestChatCampaignTask({
            platform: 'telegram',
            sourceEventId: `${sourceEventId}:${lang}`,
            sourceChannelId,
            senderName,
            rawText: text,
            voiceTranscript,
            referenceImageBase64,
            explicitClientId: json.clientId,
            autoGenerate: shouldGenerate,
            deskBaseUrl: incomingDeskBase,
            rawJson: { ...json, hawaLanguageGraphic: lang },
          })
        );
      }
      const duplicate = results.every((r) => r.duplicate === true);
      return c.json({ ok: true, tasks: results.map((r) => r.task), task: results[0].task, bilingual: true, duplicate }, duplicate ? 200 : 201);
    }

    const result = await ingestChatCampaignTask({
      platform: 'telegram',
      sourceEventId,
      sourceChannelId,
      senderName,
      rawText,
      voiceTranscript,
      referenceImageBase64,
      explicitClientId: json.clientId,
      autoGenerate: shouldGenerate,
      deskBaseUrl: incomingDeskBase,
      rawJson: json,
    });

    return c.json({ ok: true, task: result.task, duplicate: result.duplicate === true, voiceTranscript, notification: result.notification }, result.duplicate ? 200 : 201);
    } catch (error) {
      log.error('[chat-intake] Durable Telegram intake failed:', error);
      return problem(c, 503, 'Intake not committed', 'The request was not acknowledged. Retry with the same source event ID.');
    }
  }
}
