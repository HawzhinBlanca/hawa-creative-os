/** Freeze routing before external IO. A retry cannot reinterpret a client code or a refused update. */
import { sql, type Kysely, type Database } from '@hawa/db';
import { sourceClientSelection, sourceCopyConfirmation, sourceDesignSize, telegramPdfSource } from '@hawa/domain';
import { linkedLifecycleReplies, waitingLifecycleRequests } from './lifecycle-chat-target.js';
import { readSourceAdmission, readSourceUpload, saveSourceAdmission, sourceByReply, sourceHash, SourceConflict,
  type SourceAdmission, type SourceIntakeAnswer } from './lifecycle-source-store.js';

export const sourceNotice = (chatId: string, updateId: number, text: string, status = 200): SourceIntakeAnswer => ({
  status, extra: { lifecycleAction: 'source-message', chatId, sourceMessage: text.slice(0, 3000),
    sourceNoticeKey: `source-review:${updateId}` },
});

/** The lock is held only for local reads and the admission write, never downloading or parsing. */
export async function admitSource(trx: Kysely<Database>, tenantId: string, update: unknown): Promise<SourceAdmission> {
  const pdf = telegramPdfSource(update), confirmation = sourceCopyConfirmation(update), envelope = pdf ?? confirmation?.scope;
  if (!envelope) throw new SourceConflict('Source event is not supported');
  const { updateId, chatId } = envelope, payloadHash = sourceHash(JSON.stringify(update));
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:source-admit:${updateId}`},0))`.execute(trx);
  const prior = await readSourceAdmission(trx, tenantId, updateId);
  if (prior) {
    if (prior.payloadHash !== payloadHash) throw new SourceConflict('Source admission event changed');
    return prior;
  }
  const save = (result: SourceAdmission['result']) => saveSourceAdmission(trx, tenantId, updateId, { payloadHash, result });
  const refuse = (text: string, status: number) => save({ kind: 'answer', answer: sourceNotice(chatId, updateId, text, status) });
  if (confirmation) {
    if (!envelope.replyMessageId || !confirmation.copy.trim() || confirmation.copy.length > 100_000)
      return refuse('Reply to your original source with /use_source on its own line, followed by the exact corrected copy.', 422);
    const upload = await sourceByReply(trx, tenantId, envelope);
    if (!upload) return refuse('No source belongs to that reply, sender and topic. Reply to the original PDF you sent.', 404);
    return save({ kind: 'confirmation', sourceUpdateId: upload.updateId });
  }
  const priorUpload = await readSourceUpload(trx, tenantId, updateId);
  if (priorUpload) {
    if (priorUpload.payloadHash !== payloadHash) throw new SourceConflict('Source event changed');
    const { blob: _blob, ...source } = priorUpload;
    return save({ kind: 'upload', source });
  }
  const input = pdf!, selection = sourceClientSelection(input.caption);
  if (selection.invalidClient) return refuse('Use exactly one non-empty Client: <client code or full name> line in a new source caption.', 422);
  const variant = sourceDesignSize(input.caption);
  if (variant === null) return refuse('Use one Size: <width>x<height> line with each dimension between 640 and 2400 pixels.', 422);
  const waiting = await waitingLifecycleRequests(trx, tenantId, chatId);
  const links = input.replyMessageId ? await linkedLifecycleReplies(trx, tenantId, chatId, String(input.replyMessageId)) : [];
  const linked = links.length === 1 ? links[0] : undefined;
  const target = linked ? waiting.find(r => r.request_id === linked.requestId && Number(r.rev) === linked.rev) : undefined;
  if (input.replyMessageId && (!target || selection.explicitNew))
    return refuse('That reply does not identify a current request waiting for changes. Reply to its latest notice or send a new source with /new.', 409);
  if (!target && ((!selection.explicitNew && waiting.length) ||
      (['group','supergroup'].includes(input.chatType) && !selection.explicitNew)))
    return refuse('For a new design, start the PDF caption with /new and Client: <client code>. For a revision, reply to its current notice.', 409);
  const clients = (await sql<{ id: string }>`SELECT id::text FROM hawa.clients
    WHERE tenant_id=${tenantId}::uuid AND status='active' AND (
      lower(code)=lower(${selection.client ?? ''}) OR lower(name)=lower(${selection.client ?? ''}) OR id::text=${selection.client ?? ''}) LIMIT 2`.execute(trx)).rows;
  const clientId = target?.client_id ?? (clients.length === 1 ? clients[0].id : null);
  if (!clientId || (selection.client && (clients.length !== 1 || clients[0].id !== clientId)))
    return refuse('Name one active client in the PDF caption: Client: <client code or full name>. A request reply must keep its existing client.', 422);
  const active = await trx.selectFrom('clients').select('id').where('id', '=', clientId)
    .where('tenant_id', '=', tenantId).where('status', '=', 'active').forShare().executeTakeFirst();
  if (!active) return refuse('The selected client is no longer active. Ask the office to check the client before sending a new source.', 409);
  return save({ kind: 'upload', source: { ...input, clientId, instructions: selection.instructions,
    sourceUpdate: update, payloadHash, ...(variant ? { variant } : {}), ...(target ? { target: { requestId: target.request_id,
      taskId: target.current_task_id, rev: Number(target.rev), ...(target.question ? { questionId: target.question.id } : {}) } } : {}) } });
}
