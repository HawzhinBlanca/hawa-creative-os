/**
 * An edited message or caption (audit F11, ADR-145). Telegram sends the whole message again as
 * `edited_message`, under a new update, with the message's own id. What the bot does depends on what
 * it did with that message:
 *
 *  - words it has not read yet (a brief held for photos, a message set behind it, a voice note or PDF
 *    whose words are not confirmed, a photo kept for its words): the new words replace the old ones
 *    when the message is read ("I saw your edit, and I'll use the new words.");
 *  - words that opened a design, or changed one: the new words go to the office as a note on that
 *    design (the late-change store: Deliver waits until an office member has read it). Nothing is
 *    redesigned by itself and nothing opens twice;
 *  - words that opened nothing (thanks, a question, a greeting, words passed on): read again as a new
 *    message, under the edit's own update, so its reading is decided once;
 *  - a message the bot has no record of: passed to the office.
 *
 * The decision is recorded once per update, and replays as it was made.
 */
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { MEDIA_MESSAGES, bold, requesterLang, say, escapeTelegramHtml } from '@hawa/integrations';
import { createHash } from 'node:crypto';
import { DEFAULT_TENANT_ID, type CoreContext } from '../core-context.js';
import { replyLanguage } from './lifecycle-album.js';
import { shortTitle } from './requester-turn.js';
import { claimPhoto, originalMessage, readEditDecision, readMediaAnswer, recordEditDecision, recordMediaAnswer,
  recordPendingEdit } from './lifecycle-media-intake.js';
import { readNewBriefDecision, recordRoutingRefusal, type LateRequesterChange } from './lifecycle-chat-target.js';

type Tx = Kysely<Database>;
type Json = Record<string, any>;
type Answer = { status: number; extra: Record<string, unknown> };
export type EditOutcome = { kind: 'answer'; answer: Answer } | { kind: 'reread'; update: { update_id: number } & Json } | { kind: 'none' };

const LATE_STAGES = new Set(['designing', 'awaiting_answer', 'manual', 'in_review', 'approved', 'delivering', 'delivered']);

export function createEditIntake(ctx: Pick<CoreContext, 'db'>) {
  const { db } = ctx;
  const system = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };
  const tx = <T>(fn: (trx: Tx) => Promise<T>) => withRlsContext(db!, system, fn);
  const chatAnswer = (chatId: string, text: string, extra: Json = {}): Answer =>
    ({ status: 200, extra: { lifecycleAction: 'chat-answer', chatId, chatAnswer: { text, parseMode: 'HTML' }, ...extra } });

  async function handle(update: { update_id: number } & Json, deps: {
    senderAllowed: boolean;
    recordLate: (late: LateRequesterChange) => Promise<Answer>;
    officeChatId: string | undefined;
  }): Promise<EditOutcome> {
    const edited = update.edited_message as Json | undefined;
    if (!db || !edited || typeof edited !== 'object') return { kind: 'none' };
    const chatId = String(edited.chat?.id ?? '');
    const messageId = Number.isSafeInteger(edited.message_id) ? String(edited.message_id) : '';
    if (!chatId || !messageId) return { kind: 'none' };
    if (!deps.senderAllowed) return { kind: 'answer', answer: { status: 403, extra: { code: 'SENDER_NOT_ALLOWED' } } };
    const payloadHash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
    const words = String(typeof edited.text === 'string' ? edited.text : typeof edited.caption === 'string' ? edited.caption : '').trim();
    const asMessage = () => ({ update_id: update.update_id, message: { ...edited } }) as { update_id: number } & Json;
    const lang = words ? requesterLang(words) : await tx((trx) => replyLanguage(trx, DEFAULT_TENANT_ID, chatId, [], edited.from?.language_code));

    const prior = await tx((trx) => readEditDecision(trx, DEFAULT_TENANT_ID, update.update_id));
    if (prior && prior.payloadHash !== payloadHash) return { kind: 'answer', answer: { status: 409, extra: { code: 'IDEMPOTENCY_CONFLICT' } } };
    if (prior?.kind === 'reread') return { kind: 'reread', update: asMessage() };
    const said = await tx((trx) => readMediaAnswer(trx, DEFAULT_TENANT_ID, update.update_id));
    if (said) return { kind: 'answer', answer: { status: said.status, extra: { ...said.extra, duplicate: true } } };

    /** Says `text` once, recording the decision with it. */
    const answerOnce = (text: string, extra: Json = {}, before?: (trx: Tx) => Promise<void>): Promise<EditOutcome> =>
      tx(async (trx) => {
        if (before) await before(trx);
        await recordEditDecision(trx, DEFAULT_TENANT_ID, update.update_id, { kind: 'answered' }, payloadHash);
        const stored = await recordMediaAnswer(trx, DEFAULT_TENANT_ID, update.update_id, payloadHash, chatAnswer(chatId, text, extra));
        return { kind: 'answer' as const, answer: { status: stored.status, extra: stored.extra } };
      });
    const reread = async (before?: (trx: Tx) => Promise<void>): Promise<EditOutcome> => {
      await tx(async (trx) => {
        if (before) await before(trx);
        await recordEditDecision(trx, DEFAULT_TENANT_ID, update.update_id, { kind: 'reread' }, payloadHash);
      });
      return { kind: 'reread', update: asMessage() };
    };
    const forward = () => {
      const office = deps.officeChatId && deps.officeChatId !== chatId ? deps.officeChatId : null;
      const quoted = words.length > 1500 ? `${words.slice(0, 1500)}…` : words;
      return answerOnce(say(MEDIA_MESSAGES.editForwarded, lang), office ? { officeAlert: { chatId: office, text: [
        `The requester in chat ${chatId} edited an earlier message (${messageId}) that the bot has no current record of. Nothing was changed.`,
        '', 'Their new words:', escapeTelegramHtml(quoted) || '(no words)'].join('\n') } } : {});
    };

    const original = await tx((trx) => originalMessage(trx, DEFAULT_TENANT_ID, chatId, messageId));
    if (!original) return forward();
    switch (original.kind) {
      case 'held-brief':
      case 'deferred':
        // Not read yet: it will be read with these words.
        if (!words) return forward();
        return answerOnce(say(MEDIA_MESSAGES.editApplied, lang), { edit: 'pending' },
          (trx) => recordPendingEdit(trx, DEFAULT_TENANT_ID, update.update_id, original.updateId, edited.text ?? edited.caption, payloadHash));
      case 'source':
        if (original.confirmed) return forward();
        // A voice note's or PDF's caption carries the design instructions (and may name the organisation).
        return answerOnce(say(MEDIA_MESSAGES.editApplied, lang), { edit: 'pending' },
          (trx) => recordPendingEdit(trx, DEFAULT_TENANT_ID, update.update_id, original.updateId, String(edited.caption ?? ''), payloadHash));
      case 'held-photo':
        // A kept photo that now has words is a photo brief, read under this update; the kept copy is used.
        if (original.used || !words) return forward();
        return reread((trx) => claimPhoto(trx, DEFAULT_TENANT_ID, original.updateId,
          { byUpdateId: update.update_id, how: 'brief' }).then(() => undefined));
      case 'open':
        return original.ambiguous ? noteBundle(original.updateId) : note(original.requestId);
      case 'intent': {
        const plan = original.plan;
        if (plan.kind === 'open') {
          const opened = await tx(async (trx) => (await sql<{ request_id: string;ambiguous:boolean }>`SELECT payload->>'requestId' AS request_id,
              jsonb_array_length(coalesce(payload->'siblings','[]'::jsonb))>0 AS ambiguous
            FROM hawa.inbox_events WHERE tenant_id = ${DEFAULT_TENANT_ID}::uuid AND source_account_id = 'lifecycle_chat_open'
              AND source_event_id = ${String(original.updateId)}`.execute(trx)).rows[0]);
          return opened?.ambiguous ? noteBundle(original.updateId) : opened ? note(opened.request_id) : forward();
        }
        if (typeof plan.requestId === 'string' && ['revise', 'redo', 'note', 'tell'].includes(plan.kind)) return note(plan.requestId);
        // It opened nothing and changed nothing: read it again as it now reads.
        return words ? reread() : forward();
      }
    }

    /** A shared source edit affects every child until a person has reviewed that child's note.
     * Record all notes with the answer in one transaction; never release another child's hold
     * merely because someone acknowledged the first child's note. */
    async function noteBundle(openUpdateId:number):Promise<EditOutcome> {
      if (!words) return forward();
      return tx(async trx=>{
        const decision=await readNewBriefDecision(trx,DEFAULT_TENANT_ID,openUpdateId);
        if (!decision || decision.chatId!==chatId || !decision.siblings?.length) throw new Error('Missing shared source decision');
        const ids=[decision.requestId,...decision.siblings.map(s=>s.requestId)];
        const targets=(await sql<{request_id:string;stage:LateRequesterChange['requestStage'];rev:number;task_id:string;title:string}>`
          SELECT r.request_id::text,r.stage,r.rev::integer AS rev,r.current_task_id::text AS task_id,coalesce(root.title,t.title) AS title
          FROM hawa.requests r JOIN hawa.tasks t ON t.tenant_id=r.tenant_id AND t.id=r.current_task_id
          LEFT JOIN hawa.tasks root ON root.tenant_id=r.tenant_id AND root.id=r.root_task_id
          WHERE r.tenant_id=${DEFAULT_TENANT_ID}::uuid AND r.chat_id=${chatId} AND r.request_id::text=ANY(${ids}::text[])`.execute(trx)).rows;
        if (targets.length!==ids.length) return {kind:'answer',answer:{status:503,extra:{code:'REQUEST_OPENING',chatId}}};
        for (const target of targets) {
          if (!LATE_STAGES.has(target.stage)) continue;
          const late:LateRequesterChange={requestId:target.request_id,taskId:target.task_id,requestRev:target.rev,
            requestStage:target.stage,kind:'change',title:shortTitle(target.title),
            text:`[The requester edited the shared source of several designs. No individual design was selected and no copy was changed.]\n${words}`};
          const saved=await recordRoutingRefusal(trx,DEFAULT_TENANT_ID,`${update.update_id}:${target.request_id}`,
            {code:'LATE_REQUESTER_CHANGE',chatId,payloadHash,late});
          if (saved.payloadHash!==payloadHash || saved.late?.requestId!==target.request_id) throw new Error('Changed shared edit replay');
        }
        await recordEditDecision(trx,DEFAULT_TENANT_ID,update.update_id,{kind:'answered'},payloadHash);
        const office=deps.officeChatId && deps.officeChatId!==chatId ? deps.officeChatId : null;
        const answer=chatAnswer(chatId,say(MEDIA_MESSAGES.editForwarded,lang),{code:'AMBIGUOUS_REQUEST',
          ...(office ? {officeAlert:{chatId:office,text:`The requester edited the shared source of ${ids.length} designs. No individual design was selected. Each active child has its own saved note; new delivery waits for that child's office acknowledgement. No design copy was changed.\n\n${escapeTelegramHtml(words.slice(0,1500))}`}} : {})});
        const stored=await recordMediaAnswer(trx,DEFAULT_TENANT_ID,update.update_id,payloadHash,answer);
        return {kind:'answer',answer:{status:stored.status,extra:stored.extra}};
      });
    }

    /** The new words go to the office as a note on the design the message opened or changed. */
    async function note(requestId: string): Promise<EditOutcome> {
      const target = await tx(async (trx) => (await sql<{ stage: string; rev: string | number; task_id: string; title: string | null }>`
        SELECT r.stage, r.rev, r.current_task_id::text AS task_id, coalesce(root.title, t.title) AS title
        FROM hawa.requests r JOIN hawa.tasks t ON t.tenant_id = r.tenant_id AND t.id = r.current_task_id
        LEFT JOIN hawa.tasks root ON root.tenant_id = r.tenant_id AND root.id = r.root_task_id
        WHERE r.tenant_id = ${DEFAULT_TENANT_ID}::uuid AND r.request_id = ${requestId}::uuid`.execute(trx)).rows[0]);
      // The open is decided but not yet projected: ChatInbox asks again in a moment (ADR-144's rule).
      if (!target) return { kind: 'answer', answer: { status: 503, extra: { code: 'REQUEST_OPENING', chatId } } };
      if (!LATE_STAGES.has(target.stage) || !words) return forward();
      const title = shortTitle(target.title || 'your design');
      const late: LateRequesterChange = { requestId, taskId: target.task_id, requestRev: Number(target.rev),
        requestStage: target.stage as LateRequesterChange['requestStage'], text: `[The requester edited their message to:]\n${words}`,
        title, answer: say(MEDIA_MESSAGES.editPassed, lang, { title: bold(title) }) };
      const answer = await deps.recordLate(late);
      await tx((trx) => recordEditDecision(trx, DEFAULT_TENANT_ID, update.update_id, { kind: 'answered' }, payloadHash));
      return { kind: 'answer', answer };
    }
    return { kind: 'none' };
  }

  return { handle };
}
