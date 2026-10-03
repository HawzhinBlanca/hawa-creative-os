/**
 * What Core's Telegram intake answers when an update opens no request and changes none (ADR-135
 * stage 2c): a greeting, a question, thanks, a standing rule said in chat, /status, /rules and
 * /forget, /start and /help, a chat command that tries to approve in chat, an edited message, a
 * group conversation that is not a brief.
 *
 * These answers used to come from the old intake (`/webhooks/telegram`, services/telegram-intake/),
 * which the lifecycle path handed such updates to in its finish-only scope. That intake is deleted;
 * the answers it gave that the lifecycle path still needs live here, and are sent by ChatInbox
 * (`lifecycleAction: 'chat-answer'`) under the update's own key, not by Core's bridge.
 *
 * An answer and the side effect behind it (a rule saved or removed, a question recorded) are recorded
 * once per update (`hawa.inbox_events`, `<chat>:<update>`, the key persistChatIntake and the
 * lifecycle's "already handled" check use), and a repeated update gets the recorded answer back: the
 * worker asks again when Core's first answer did not reach it, and must then send the same words.
 */
import crypto from 'node:crypto';
import { SYSTEM_AUTOMATION_USER_ID, isTaskDbState, type TaskDbState } from '@hawa/contracts';
import { sql, withRlsContext } from '@hawa/db';
import { CONVERSATION_MESSAGES, LIFECYCLE_MESSAGES, MEDIA_MESSAGES, ROUTING_MESSAGES, bold, escapeTelegramHtml, requesterLang, say, type Phrase, type RequesterLang } from '@hawa/integrations';
import { cutText } from '../core-helpers.js';
import { DEFAULT_TENANT_ID, type CoreContext } from '../core-context.js';
import { log } from '../logging.js';
import { NEGATIVE_REACTION_REASON, asksToUndoCancel, classifyWithHeuristics, readsAsUndo } from './telegram-classifier.js';
import { activeChatRequests } from './requester-turn-store.js';
import { deskSearchLine, requesterName, shortTitle, statusText, type ChatRequestView } from './requester-turn.js';
import { officeChatFor } from './office-chats.js';
import { parseRulesCommand } from './standing-rules-chat.js';
import { handleRulesCommand, saveChatRule, type RulesIntakeDeps } from './telegram-rules-intake.js';
import { waitingLifecycleRequests } from './lifecycle-chat-target.js';
import { replyLanguage } from './lifecycle-album.js';

/** The answer the intake route returns: an HTTP-like status and the fields ChatInbox reads. */
export interface ChatAnswer { status: number; extra: Record<string, unknown> }

/** The words ChatInbox sends to the chat. */
export interface ChatAnswerMessage { text: string; parseMode?: 'HTML' }

type Json = Record<string, any>;

/** The event kind an answered update is recorded under; the answer rides in its payload. */
const ANSWER_KIND = 'telegram_chat_answer';

/**
 * Said to /approve, /publish, /revise and /reject: nothing is approved in chat (ADR-022), and no office
 * alert is sent for the command, so the answer claims none (ADR-145, #67).
 */
export function deskApprovalAnswer(lang: RequesterLang = 'en'): string {
  return say(CONVERSATION_MESSAGES.officeGivesFinalCheck, lang);
}
/** The English answer to a typed approval (kept as a constant for callers that name it). */
export const DESK_APPROVAL_ANSWER = deskApprovalAnswer('en');

/**
 * Said to an edited message the intake route could not place (ADR-145: the route reads edits first, so
 * this is only a fallback). No reply trick is asked for.
 */
export const EDITED_MESSAGE_ANSWER = MEDIA_MESSAGES.editSeen.en;

/**
 * /start and /help (F15, #70): how to ask for a design, in plain words, in the requester's language.
 * It promises only what the lifecycle path does: words, photos, a voice note or a PDF, changes in the
 * requester's own words, and the office's check before anything is sent.
 */
export function welcomeAnswer(lang: RequesterLang = 'en'): string {
  return say(CONVERSATION_MESSAGES.welcome, lang);
}
export const WELCOME_ANSWER = welcomeAnswer('en');

/** /redo: every request is RequestLifecycle's, and the office restarts a design; nothing was started. */
export function redoAnswer(lang: RequesterLang = 'en'): string {
  return say(CONVERSATION_MESSAGES.officeRestarts, lang);
}
export const REDO_ANSWER = redoAnswer('en');

/**
 * The words for a greeting, a question or thanks (ADR-140 for thanks; ADR-145: no product name, no
 * reply-to instruction, and the requester's language by the script they wrote in).
 */
export function inquiryAnswer(kind: 'question' | 'other', reason: string, rawText: string, fallback: RequesterLang = 'en'): string {
  const lang = requesterLang(rawText, fallback);
  if (reason === 'Acknowledgement') return say(ROUTING_MESSAGES.thanks, lang);
  return say(kind === 'question' ? CONVERSATION_MESSAGES.question : CONVERSATION_MESSAGES.greeting, lang);
}

/**
 * The language to answer a command in. A command carries few words of its own ("/start", "/status"),
 * so what follows it decides when it has letters, then the sender's Telegram app language (Sorani or
 * Kurdish), then `fallback`.
 */
export function commandLang(text: string, languageCode: unknown, fallback: RequesterLang = 'en'): RequesterLang {
  const rest = String(text || '').replace(/^\/[a-z_]+(?:@\w+)?/i, '');
  const app = String(languageCode || '').toLowerCase();
  return requesterLang(rest, /^(ckb|ku)\b/.test(app) ? 'ckb' : fallback);
}

/** ADR-252 (friction 7): how long after a withdrawal "undo that" or "bring it back" is about it. */
export const UNDO_WINDOW_MS = 30 * 60_000;

/** A request of this chat withdrawn within `UNDO_WINDOW_MS`, the latest first. */
export interface RecentWithdrawal { requestId: string; taskId: string; title: string; at: string }

/**
 * ADR-252 (friction 7): whether the words take back the withdrawal. Words that name the cancel ("I
 * cancelled by mistake") always do; short ones ("undo that", "bring it back", "actually continue") only
 * when nothing in the chat moved after the withdrawal, so they are not about a design shown since.
 */
export function undoesWithdrawal(text: string, withdrawn: RecentWithdrawal | null, requests: ChatRequestView[],
  now = Date.now()): boolean {
  if (!withdrawn || now - Date.parse(withdrawn.at) > UNDO_WINDOW_MS) return false;
  if (asksToUndoCancel(text)) return true;
  if (!readsAsUndo(text)) return false;
  return requests.every((r) => Date.parse(r.activeAt) <= Date.parse(withdrawn.at));
}

/** The office's alert for words that take back a withdrawal (plain text, the words as sent). */
export function undoOfficeAlert(who: string, withdrawn: RecentWithdrawal, words: string, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((now - Date.parse(withdrawn.at)) / 60_000));
  return [`${who} asked to go ahead with "${shortTitle(withdrawn.title)}" after all; it was cancelled ${minutes} minute${minutes === 1 ? '' : 's'} ago.`,
    'A cancelled request cannot be restarted, so nothing was restarted and no other design was changed. They were told so, and that they can send the request again; please answer them in the chat.',
    '', 'Their words:', words.length > 1500 ? `${words.slice(0, 1500)}…` : words, '', deskSearchLine([withdrawn.taskId])].join('\n');
}

/**
 * The office's alert for an unhappy emoji on its own (ADR-252, friction 8), or words that only say the requester is
 * not happy ("I don't like it", conversation fuzz 2026-10-03).
 */
export function unhappyOfficeAlert(who: string, latest: ChatRequestView | null, words: string): string {
  const said = /\p{L}/u.test(words) ? 'wrote that they are not happy' : 'sent an emoji that says they are not happy';
  return [latest ? `${who} ${said}, after "${shortTitle(latest.title)}". Nothing was changed; please ask them in the chat what is wrong.`
    : `${who} ${said}, with no design open in the chat. Nothing was changed; please ask them in the chat what is wrong.`,
  '', 'Their message:', words, ...(latest ? ['', deskSearchLine([latest.currentTaskId])] : [])].join('\n');
}

// Keyed by every database state, so a state added to the vocabulary does not compile until it has words.
// The requester's words for where a design is (ADR-145): no Desk, no internal state names.
const C = CONVERSATION_MESSAGES;
const STATE_LABEL: Record<TaskDbState, Phrase> = {
  received: C.stateDesigning, promotion_pending: C.stateDesigning, routing: C.stateDesigning, routing_review: C.stateDesigning,
  brief_draft: C.stateDesigning, brief_review: C.stateDesigning, context_ready: C.stateDesigning, design_planning: C.stateDesigning,
  asset_production: C.stateDesigning, studio_composition: C.stateDesigning, qa: C.stateChecking, auto_repair: C.stateChecking,
  human_review: C.stateInReview, revision_requested: C.stateReplaced,
  approved: C.stateApproved, publishing: C.stateDelivering, complete: C.stateDelivered, paused: C.stateWaitingForAnswer,
  failed_retryable: C.stateDelayed, failed_operator: C.stateWithOffice,
  rejected: C.stateStopped, cancelled: C.stateCancelled,
};

export type LifecycleChatAnswers = ReturnType<typeof createLifecycleChatAnswers>;

export function createLifecycleChatAnswers(ctx: Pick<CoreContext, 'db' | 'isProduction' | 'telegramIntakeUsers' | 'telegramAllowedUsers'>) {
  const { db } = ctx;
  const scope = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };

  const answered = (status: number, chatId: string, message: ChatAnswerMessage, extra: Json = {}): ChatAnswer =>
    ({ status, extra: { ...extra, lifecycleAction: 'chat-answer', chatId, chatAnswer: message } });

  /** The answer recorded for this update, if one was. */
  async function replay(chatId: string, updateId: number): Promise<ChatAnswer | null> {
    if (!db || !chatId) return null;
    const row = await withRlsContext(db, scope, async (trx) =>
      (await sql<{ payload: Json }>`SELECT payload FROM hawa.inbox_events
        WHERE tenant_id = ${DEFAULT_TENANT_ID}::uuid AND source_account_id = 'telegram'
          AND source_event_id = ${`${chatId}:${updateId}`} AND event_kind = ${ANSWER_KIND}
        LIMIT 1`.execute(trx)).rows[0]);
    const stored = row?.payload;
    if (!stored || typeof stored.status !== 'number') return null;
    const message = stored.answer && typeof stored.answer.text === 'string' ? stored.answer as ChatAnswerMessage : null;
    // ADR-252: an office alert decided with the answer is given again with it (a lost first answer lost it).
    const alert = stored.officeAlert && typeof stored.officeAlert.chatId === 'string' && typeof stored.officeAlert.text === 'string'
      ? { officeAlert: { chatId: stored.officeAlert.chatId, text: stored.officeAlert.text } } : {};
    const extra: Json = { duplicate: true, ...(stored.code ? { code: stored.code } : {}), ...alert };
    return message ? answered(stored.status, chatId, message, extra) : { status: stored.status, extra };
  }

  /** Records the answer (and so the update) once; the first record wins, as a replay must say the same. */
  async function record(chatId: string, updateId: number, what: string, status: number, answer: ChatAnswerMessage | null,
    code?: string, officeAlert?: { chatId: string; text: string }): Promise<void> {
    if (!db) return;
    const payload = { what, status, ...(answer ? { answer } : {}), ...(code ? { code } : {}), ...(officeAlert ? { officeAlert } : {}) };
    await withRlsContext(db, scope, async (trx) => {
      await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
        SELECT ${DEFAULT_TENANT_ID}::uuid, 'telegram', ${`${chatId}:${updateId}`}, ${ANSWER_KIND}, ${JSON.stringify(payload)}::jsonb,
          ${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}, true
        WHERE NOT EXISTS (SELECT 1 FROM hawa.inbox_events WHERE tenant_id = ${DEFAULT_TENANT_ID}::uuid
          AND source_account_id = 'telegram' AND source_event_id = ${`${chatId}:${updateId}`})`.execute(trx);
    });
  }

  /** Answers, recording the answer first so that a repeated update is answered the same. */
  async function answerOnce(chatId: string, updateId: number, what: string, status: number, message: ChatAnswerMessage | null,
    extra: Json = {}): Promise<ChatAnswer> {
    await record(chatId, updateId, what, status, message, typeof extra.code === 'string' ? extra.code : undefined,
      extra.officeAlert as { chatId: string; text: string } | undefined);
    const again = await replay(chatId, updateId);
    if (again) return { status: again.status, extra: { ...extra, ...again.extra, duplicate: false } };
    return message ? answered(status, chatId, message, extra) : { status, extra };
  }

  /** The chat's latest requests and where each is (/status). Null when they could not be read. */
  async function chatStatus(chatId: string, text: string, languageCode: unknown): Promise<string | null> {
    if (!db) return null;
    try {
      const { rows, asking } = await withRlsContext(db, scope, async (trx) => ({
        rows: (await sql<{ id: string; title: string | null; state: string }>`
          SELECT t.id, t.title, t.state
          FROM hawa.outbox_commands o JOIN hawa.tasks t ON t.id = o.aggregate_id AND t.tenant_id = o.tenant_id
          WHERE o.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND o.command_type = 'task.created'
            AND o.payload->>'sourceChannelId' = ${chatId}
            AND COALESCE(o.payload->>'isInstructionOnly', 'false') <> 'true'
          ORDER BY t.created_at DESC LIMIT 5`.execute(trx)).rows,
        // A paused task waits for an answer only while its request asks the question.
        asking: new Set((await waitingLifecycleRequests(trx, DEFAULT_TENANT_ID, chatId))
          .filter((r) => r.stage === 'awaiting_answer').map((r) => r.current_task_id)),
      }));
      // The chat's own design names say which language it writes in, when the command does not.
      const lang = commandLang(text, languageCode, requesterLang(rows.map((r) => r.title || '').join(' '), 'en'));
      const labelOf = (r: { id: string; state: string }) =>
        say(r.state === 'paused' && !asking.has(r.id) ? C.stateNoLongerWaiting
          : (isTaskDbState(r.state) ? STATE_LABEL[r.state] : C.stateInProgress), lang);
      // No ids and no Canva links (ADR-145): the name and where it is, in words.
      const lines = rows.map((r, i) =>
        `${i + 1}. <b>${escapeTelegramHtml(cutText(String(r.title || say(LIFECYCLE_MESSAGES.yourDesign, lang)).replace(/^[^:]*:\s*/, ''), 60))}</b>\n` +
        `   ${escapeTelegramHtml(labelOf(r))}`);
      return lines.length ? `<b>${escapeTelegramHtml(say(C.statusHeader, lang))}</b>\n\n${lines.join('\n')}` : escapeTelegramHtml(say(C.statusNone, lang));
    } catch (err) {
      // A read that failed answered that the chat had no requests, which is untrue.
      log.warn('[core:chat-answer] /status could not read the chat\'s requests:', err);
      return null;
    }
  }

  /**
   * ADR-252: what the chat has going on: its open and recently delivered requests (as the routing reads
   * them), and the latest request withdrawn within `UNDO_WINDOW_MS`. Null when they could not be read.
   */
  async function chatContext(chatId: string): Promise<{ requests: ChatRequestView[]; withdrawn: RecentWithdrawal | null } | null> {
    if (!db) return null;
    try {
      return await withRlsContext(db, scope, async (trx) => {
        const requests = await activeChatRequests(trx, DEFAULT_TENANT_ID, chatId);
        const row = (await sql<{ request_id: string; task_id: string; title: string | null; at: Date | string }>`
          SELECT r.request_id::text, r.current_task_id::text AS task_id, coalesce(root.title, t.title) AS title, r.updated_at AS at
          FROM hawa.requests r JOIN hawa.tasks t ON t.tenant_id = r.tenant_id AND t.id = r.current_task_id
          LEFT JOIN hawa.tasks root ON root.tenant_id = r.tenant_id AND root.id = r.root_task_id
          WHERE r.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND r.chat_id = ${chatId} AND r.owner = 'restate'
            AND r.stage = 'cancelled' AND r.updated_at > now() - make_interval(secs => ${UNDO_WINDOW_MS / 1000})
          ORDER BY r.updated_at DESC LIMIT 1`.execute(trx)).rows[0];
        return { requests, withdrawn: row ? { requestId: row.request_id, taskId: row.task_id, title: row.title || '',
          at: new Date(row.at).toISOString() } : null };
      });
    } catch (err) {
      log.warn('[core:chat-answer] the chat\'s requests could not be read:', err);
      return null;
    }
  }

  /**
   * ADR-252 (friction 7, 8, 9): the answer to words that are not a greeting in a chat with designs. Words
   * that take back a withdrawal are told the truth (it cannot be restarted) and the office hears them;
   * an unhappy emoji goes to the office; anything else short after a draft hears where the latest design
   * stands. Null: the chat has nothing going on, and the words are answered as a greeting.
   */
  async function contextAnswer(chatId: string, updateId: number, msg: Json, rawText: string,
    reason: string, chatLang: RequesterLang): Promise<ChatAnswer | null> {
    const context = await chatContext(chatId);
    if (!context) return null;
    const { requests, withdrawn } = context;
    const latest = [...requests].sort((a, b) => Date.parse(b.activeAt) - Date.parse(a.activeAt))[0] ?? null;
    const lang = requesterLang(rawText, chatLang);
    const office = officeChatFor(chatId);
    const who = requesterName(msg.from) || 'A requester';
    const nameOf = (title: string) => {
      const short = shortTitle(title);
      return bold(short === 'your design' ? say(LIFECYCLE_MESSAGES.yourDesign, lang) : short);
    };
    if (undoesWithdrawal(rawText, withdrawn, requests)) {
      const alert = office && office !== chatId ? { chatId: office, text: undoOfficeAlert(who, withdrawn!, rawText.trim()) } : undefined;
      return answerOnce(chatId, updateId, 'undo_after_withdraw', 200,
        { text: say(alert ? ROUTING_MESSAGES.undoPassed : ROUTING_MESSAGES.undoKept, lang, { title: nameOf(withdrawn!.title) }), parseMode: 'HTML' },
        { status: 'UNDO_AFTER_WITHDRAW', requestId: withdrawn!.requestId, ...(alert ? { officeAlert: alert } : {}) });
    }
    if (reason === NEGATIVE_REACTION_REASON) {
      const alert = office && office !== chatId ? { chatId: office, text: unhappyOfficeAlert(who, latest, rawText.trim()) } : undefined;
      return answerOnce(chatId, updateId, 'unhappy_reaction', 200,
        { text: say(alert ? ROUTING_MESSAGES.unhappyPassed : ROUTING_MESSAGES.unhappyAsk, lang), parseMode: 'HTML' },
        { status: 'UNHAPPY_REACTION', ...(alert ? { officeAlert: alert } : {}) });
    }
    if (!latest) return null;
    return answerOnce(chatId, updateId, 'after_draft', 200,
      { text: `${statusText([latest], lang)}\n\n${say(ROUTING_MESSAGES.tellWhatToChange, lang)}`, parseMode: 'HTML' },
      { status: 'PROCESSED', inquiry: 'other', requestId: latest.requestId });
  }

  /** A rules call whose messages are collected for ChatInbox instead of being sent from Core. */
  function rulesDeps(senderId: string): { deps: RulesIntakeDeps; said: () => ChatAnswerMessage | null } | null {
    if (!db) return null;
    const messages: string[] = [];
    return {
      deps: {
        db, tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID,
        trustNamedClient: Boolean(senderId) && ctx.telegramAllowedUsers.includes(senderId),
        bridge: {
          dispatchOutboundMessage: async (_chat, message) => { messages.push(message.text); },
        },
      },
      said: () => (messages.length ? { text: messages.join('\n\n'), parseMode: 'HTML' } : null),
    };
  }

  /**
   * The answer to an update the lifecycle path neither opens a request for nor applies to one. Called
   * after the lifecycle routing, never for a callback query (routes/lifecycle-internal.routes.ts).
   */
  async function answer(update: Json, chatId: string): Promise<ChatAnswer> {
    const updateId = Number(update.update_id);
    if (!chatId) return { status: 200, extra: { ignored: true, reason: 'NO_CHAT' } };
    const edited = !update.message && !update.channel_post && update.edited_message;
    const msg: Json = update.message || update.channel_post || update.edited_message || {};
    const senderId = String(msg.from?.id ?? '');
    const open = ctx.telegramIntakeUsers.includes('*') || process.env.TELEGRAM_INTAKE_ALLOWED_USERS === '*';
    if (ctx.isProduction && !open && (!ctx.telegramIntakeUsers.length || !ctx.telegramIntakeUsers.includes(senderId))) {
      return { status: 403, extra: { code: 'SENDER_NOT_ALLOWED' } };
    }
    if (!db) return { status: 503, extra: { code: 'DATABASE_UNAVAILABLE' } };
    const prior = await replay(chatId, updateId);
    if (prior) return prior;

    // An edited message is not a new request, and its text is not read: the design went ahead with
    // the old words while the sender thought it had the new ones.
    if (edited) return answerOnce(chatId, updateId, 'edited_message', 200,
      { text: say(MEDIA_MESSAGES.editSeen, requesterLang(String(msg.text ?? msg.caption ?? ''))), parseMode: 'HTML' },
      { ignored: true, reason: 'EDITED_MESSAGE' });

    const rawText = String(msg.text ?? msg.caption ?? '');
    const text = rawText.trim();
    const command = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase();
    const groupChat = ['group', 'supergroup'].includes(String(msg.chat?.type || ''));

    // Chat actions never approve or change a design (ADR-022); a bare /approve used to get no reply.
    if (command && /^(approve|publish|revise|reject)/.test(command)) {
      return answerOnce(chatId, updateId, 'desk_approval', 422,
        { text: escapeTelegramHtml(deskApprovalAnswer(commandLang(text, msg.from?.language_code))), parseMode: 'HTML' },
        { code: 'DESK_REVIEW_REQUIRED' });
    }
    if (command === 'status') {
      const status = await chatStatus(chatId, text, msg.from?.language_code);
      // Not recorded: a failed read is asked again, and a later /status should read the chat anew.
      return answered(200, chatId, { text: status ?? escapeTelegramHtml(say(C.statusUnavailable, commandLang(text, msg.from?.language_code))),
        parseMode: 'HTML' }, status ? {} : { code: 'STATUS_UNAVAILABLE' });
    }
    const rulesCommand = parseRulesCommand(text);
    if (rulesCommand) {
      const rules = rulesDeps(senderId);
      if (!rules) return { status: 503, extra: { code: 'DATABASE_UNAVAILABLE' } };
      await handleRulesCommand(rules.deps, { sourceChannelId: chatId, command: rulesCommand, text: rawText });
      const said = rules.said();
      // "/forget 1" repeated would remove the rule after it as well: the answer is recorded once.
      if (rulesCommand.kind === 'forget') return answerOnce(chatId, updateId, 'rules_forget', 200, said, { rules: 'forget' });
      return said ? answered(200, chatId, said, { rules: rulesCommand.kind }) : { status: 200, extra: { rules: rulesCommand.kind } };
    }
    if (command === 'start' || command === 'help') {
      return answered(200, chatId, { text: escapeTelegramHtml(welcomeAnswer(commandLang(text, msg.from?.language_code))), parseMode: 'HTML' });
    }
    if (command === 'redo' || command === 'redrive') {
      return answered(200, chatId, { text: redoAnswer(commandLang(text, msg.from?.language_code)) }, { code: 'LIFECYCLE_OWNED' });
    }
    // A brief promoted in a group ("/task …") opens a request only as /new does.
    if (command && /^(task|brief|design|campaign)$/.test(command)) {
      return { status: 422, extra: { code: 'NEW_BRIEF_REQUIRED', lifecycleAction: 'new-brief-required', chatId } };
    }
    // ADR-156 (audit P3): a sticker, or a message with no words at all, is not a greeting. Nothing is
    // said; the update is recorded so that a repeat says nothing again.
    if (!text) {
      await record(chatId, updateId, 'no_words', 200, null);
      return { status: 200, extra: { status: 'NO_WORDS', ...(msg.sticker ? { sticker: true } : {}) } };
    }
    // Group conversation is kept as a passive message, not answered (FR-005).
    if (groupChat && !command) {
      await record(chatId, updateId, 'message_only', 200, null);
      return { status: 200, extra: { status: 'MESSAGE_ONLY' } };
    }

    // Hunt 3: words with no letter ("🤔", "👎") tell no language: they are answered in the chat's (its latest brief's,
    // else the sender's Telegram language), never in English in a Sorani chat (ADR-251, friction 11).
    const chatLang: RequesterLang = /\p{L}/u.test(rawText) ? requesterLang(rawText)
      : await withRlsContext(db, scope, (trx) => replyLanguage(trx, DEFAULT_TENANT_ID, chatId, [], msg.from?.language_code)).catch(() => 'en' as const);
    // ADR-252 (friction 7): words that name the cancel ("I cancelled by mistake, please continue") read as
    // feedback to the heuristics; they are answered about the withdrawal, never as a brief or a change.
    if (asksToUndoCancel(rawText) || readsAsUndo(rawText)) {
      const said = await contextAnswer(chatId, updateId, msg, rawText, 'Takes back a cancel', chatLang);
      if (said) return said;
    }
    const classification = classifyWithHeuristics(rawText, false, false);
    if (classification.kind === 'standing_rule') {
      // "From now on, always put the logo bottom-right", on its own, is a rule for later designs.
      const rules = rulesDeps(senderId);
      if (!rules) return { status: 503, extra: { code: 'DATABASE_UNAVAILABLE' } };
      const saved = await saveChatRule(rules.deps, { sourceChannelId: chatId, sourceEventId: String(updateId),
        ruleText: classification.standingRule || text, originalText: rawText });
      const said = rules.said();
      if (!saved.saved) return said ? answered(200, chatId, said, { status: 'RULE_CLIENT_UNKNOWN' }) : { status: 200, extra: { status: 'RULE_CLIENT_UNKNOWN' } };
      return answerOnce(chatId, updateId, 'standing_rule', 200, said, { status: 'RULE_SAVED', ruleId: saved.ruleId });
    }
    // ADR-252: words that are neither thanks nor a question, in a chat with a design going on, are never
    // answered with the new-design greeting.
    if (classification.kind === 'other' && classification.reason !== 'Acknowledgement') {
      const said = await contextAnswer(chatId, updateId, msg, rawText, classification.reason, chatLang);
      if (said) return said;
    }
    if (classification.kind === 'question' || classification.kind === 'other') {
      return answerOnce(chatId, updateId, `inquiry_${classification.kind}`, 200,
        { text: escapeTelegramHtml(inquiryAnswer(classification.kind, classification.reason, rawText, chatLang)), parseMode: 'HTML' },
        { status: 'PROCESSED', inquiry: classification.kind });
    }
    // A brief or a change the lifecycle path could not take here (a channel post, a change with no
    // design waiting for it): a request starts with /new.
    return { status: 422, extra: { code: 'NEW_BRIEF_REQUIRED', lifecycleAction: 'new-brief-required', chatId } };
  }

  return { answer, replay };
}
