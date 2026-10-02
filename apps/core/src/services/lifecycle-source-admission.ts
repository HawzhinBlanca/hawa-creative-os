/**
 * Freeze routing before external IO. A retry cannot reinterpret a client, a design or a refused update.
 *
 * Since ADR-145 a voice note or a PDF needs no format: its organisation is the chat's or the one its
 * words name (a "Client: …" caption line still chooses one, silently), a size is read from the words
 * ("A4", "Instagram story", "1080x1350"), and what cannot be told is asked, in words, once.
 */
import { sql, type Kysely, type Database } from '@hawa/db';
import { SOURCE_MESSAGES, bold, requesterLang, say, type RequesterLang } from '@hawa/integrations';
import { naturalDesignSize, sourceClientSelection, sourceCopyConfirmation, sourceDesignSize, telegramSource } from '@hawa/domain';
import { linkedLifecycleReplies, waitingLifecycleRequests } from './lifecycle-chat-target.js';
import { replyLanguage } from './lifecycle-album.js';
import { askAboutSource, resolveSourceClient, type SourceNeed, type SourceOption } from './lifecycle-source-natural.js';
import { designName, shortTitle } from './requester-turn.js';
import { readSourceAdmission, readSourceUpload, saveSourceAdmission, sourceByReply, sourceHash, SourceConflict,
  type PendingSource, type SourceAdmission, type SourceIntakeAnswer } from './lifecycle-source-store.js';

export const sourceNotice = (chatId: string, updateId: number, text: string, status = 200): SourceIntakeAnswer => ({
  status, extra: { lifecycleAction: 'source-message', chatId, sourceMessage: text.slice(0, 3000),
    sourceNoticeKey: `source-review:${updateId}` },
});

/** The language to ask in: the source's own words, else the chat's newest brief, else the sender's Telegram language. */
export async function sourceLanguage(trx: Kysely<Database>, tenantId: string, chatId: string, words: string,
  update: unknown): Promise<RequesterLang> {
  if (words.trim()) return requesterLang(words);
  const from = ((update as { message?: { from?: { language_code?: unknown } } })?.message?.from);
  return replyLanguage(trx, tenantId, chatId, [], from?.language_code);
}

/** Whether a group message is addressed to the bot: a reply to it, or a mention of it in the caption. */
function addressedToBot(update: unknown): boolean {
  const msg = (update as { message?: Record<string, any> })?.message;
  if (!msg) return false;
  if (msg.reply_to_message?.from?.is_bot === true) return true;
  const caption = typeof msg.caption === 'string' ? msg.caption : '';
  const botName = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').toLowerCase();
  return (Array.isArray(msg.caption_entities) ? msg.caption_entities : []).some((e: any) =>
    (e?.type === 'mention' && Number.isInteger(e.offset) && Number.isInteger(e.length) &&
      ((mention: string) => mention.endsWith('bot') || (botName && mention === `@${botName}`))(
        caption.slice(e.offset, e.offset + e.length).toLowerCase())) ||
    (e?.type === 'text_mention' && e.user?.is_bot === true));
}

/** The question asked about a kept source: which organisation, or which design. */
export function sourceQuestionText(need: SourceNeed, kind: 'pdf' | 'voice', options: SourceOption[], lang: RequesterLang): string {
  if (need === 'client') return say(kind === 'voice' ? SOURCE_MESSAGES.askClientVoice : SOURCE_MESSAGES.askClientPdf, lang);
  if (options.length === 1) return say(SOURCE_MESSAGES.askChangeOrNew, lang, { title: designName(options[0].title, lang) });
  const list = [...options.map((o, i) => `${i + 1}. ${designName(o.title, lang)}`),
    `${options.length + 1}. ${say(SOURCE_MESSAGES.newDesignOption, lang)}`].join('\n');
  return say(SOURCE_MESSAGES.askWhichDesign, lang, { list });
}

/** The lock is held only for local reads and the admission write, never downloading or parsing. */
export async function admitSource(trx: Kysely<Database>, tenantId: string, update: unknown): Promise<SourceAdmission> {
  const pdf = telegramSource(update), confirmation = sourceCopyConfirmation(update), envelope = pdf ?? confirmation?.scope;
  if (!envelope) throw new SourceConflict('Source event is not supported');
  const { updateId, chatId } = envelope, payloadHash = sourceHash(JSON.stringify(update));
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:source-admit:${updateId}`},0))`.execute(trx);
  const prior = await readSourceAdmission(trx, tenantId, updateId);
  if (prior) {
    if (prior.payloadHash !== payloadHash) throw new SourceConflict('Source admission event changed');
    return prior;
  }
  const save = (result: SourceAdmission['result']) => saveSourceAdmission(trx, tenantId, updateId, { payloadHash, result });
  const answer = (text: string, status = 200) => save({ kind: 'answer', answer: sourceNotice(chatId, updateId, text, status) });
  if (confirmation) {
    // "/use_source" still works for those who know it; it is never asked for (ADR-145).
    const lang = await sourceLanguage(trx, tenantId, chatId, confirmation.copy, update);
    if (!envelope.replyMessageId || !confirmation.copy.trim() || confirmation.copy.length > 100_000)
      return answer(say(SOURCE_MESSAGES.sendExactWords, lang), 422);
    const upload = await sourceByReply(trx, tenantId, envelope);
    if (!upload) return answer(say(SOURCE_MESSAGES.sourceNotFound, lang), 404);
    return save({ kind: 'confirmation', sourceUpdateId: upload.updateId });
  }
  const priorUpload = await readSourceUpload(trx, tenantId, updateId);
  if (priorUpload) {
    if (priorUpload.payloadHash !== payloadHash) throw new SourceConflict('Source event changed');
    const { blob: _blob, ...source } = priorUpload;
    return save({ kind: 'upload', source });
  }
  const input = pdf!, selection = sourceClientSelection(input.caption);
  const lang = await sourceLanguage(trx, tenantId, chatId, selection.instructions, update);
  // A size said in the words; a "Size:" line a person mistyped is read the same way, never refused.
  const variant = sourceDesignSize(input.caption) ?? naturalDesignSize(selection.instructions);
  const waiting = await waitingLifecycleRequests(trx, tenantId, chatId);
  const links = input.replyMessageId ? await linkedLifecycleReplies(trx, tenantId, chatId, String(input.replyMessageId)) : [];
  const linked = links.length === 1 ? links[0] : undefined;
  const target = linked && !selection.explicitNew ? waiting.find(r => r.request_id === linked.requestId && Number(r.rev) === linked.rev) : undefined;
  // A group's conversation is not a request unless it is addressed to the bot (ADR-144's group rule).
  if (['group', 'supergroup'].includes(input.chatType) && !target && !selection.explicitNew && !addressedToBot(update))
    return save({ kind: 'answer', answer: { status: 200, extra: { status: 'MESSAGE_ONLY' } } });
  let clientId: string | null = target?.client_id ?? null;
  if (!clientId && selection.client) {
    const named = (await sql<{ id: string }>`SELECT id::text FROM hawa.clients
      WHERE tenant_id=${tenantId}::uuid AND status='active' AND (
        lower(code)=lower(${selection.client}) OR lower(name)=lower(${selection.client}) OR id::text=${selection.client}) LIMIT 2`.execute(trx)).rows;
    if (named.length === 1) clientId = named[0].id;
  }
  if (!clientId && !target) clientId = await resolveSourceClient(trx, tenantId, { chatId, words: selection.instructions });
  const base: PendingSource = { ...input, clientId, instructions: selection.instructions, sourceUpdate: update, payloadHash,
    ...(variant ? { variant } : {}),
    ...(target ? { target: { requestId: target.request_id, taskId: target.current_task_id, rev: Number(target.rev),
      ...(target.question ? { questionId: target.question.id } : {}) } } : {}) };
  const ask = async (need: SourceNeed, options: SourceOption[]) => {
    await askAboutSource(trx, tenantId, { sourceUpdateId: updateId, need, chatId, senderId: input.senderId, topicId: input.topicId,
      messageId: String(input.messageId), options });
    return save({ kind: 'pending', source: base, answer: sourceNotice(chatId, updateId, sourceQuestionText(need, input.kind, options, lang)) });
  };
  // A design waits for this requester's changes: this may be about it, or a new design. Asked, never assumed.
  if (!target && !selection.explicitNew && waiting.length) {
    const titles = (await sql<{ request_id: string; title: string | null }>`SELECT r.request_id::text, coalesce(root.title, t.title) AS title
      FROM hawa.requests r JOIN hawa.tasks t ON t.tenant_id = r.tenant_id AND t.id = r.current_task_id
      LEFT JOIN hawa.tasks root ON root.tenant_id = r.tenant_id AND root.id = r.root_task_id
      WHERE r.tenant_id = ${tenantId}::uuid AND r.request_id = ANY(${waiting.map((w) => w.request_id)}::uuid[])`.execute(trx)).rows;
    return ask('target', waiting.map((w) => ({ requestId: w.request_id,
      title: titles.find((t) => t.request_id === w.request_id)?.title || 'your design' })));
  }
  if (!clientId) return ask('client', []);
  return admitResolved(trx, tenantId, { ...base, clientId }, lang, (text, status) => answer(text, status), (source) => save({ kind: 'upload', source }));
}

/** The last check before a source is kept for its organisation: that organisation is still active. */
export async function admitResolved<T>(trx: Kysely<Database>, tenantId: string, source: PendingSource & { clientId: string },
  lang: RequesterLang, refuse: (text: string, status: number) => Promise<T>,
  keep: (source: Omit<import('./lifecycle-source-store.js').SourceUpload, 'blob'>) => Promise<T>): Promise<T> {
  const active = await trx.selectFrom('clients').select('id').where('id', '=', source.clientId)
    .where('tenant_id', '=', tenantId).where('status', '=', 'active').forShare().executeTakeFirst();
  if (!active) return refuse(say(SOURCE_MESSAGES.clientInactive, lang), 409);
  return keep(source);
}
