/**
 * File → retained candidate → the requester confirms the words, within the existing request owner.
 *
 * ADR-145: no format is asked for. A voice note or a PDF is kept (its organisation found, or asked
 * for in words; a design waiting for changes asked about), turned into text, and shown back: "Here is
 * what I heard: «…». Is this exactly the text for the design? Just say “yes”, or send me the corrected
 * text." The requester's next message confirms or corrects it; "/use_source" in reply to the original
 * still works and is never mentioned. Recordings in M4A, MP3, WAV, AAC or WebM become Ogg Opus first.
 * No design starts before the words are confirmed.
 */
import { createHash } from 'node:crypto';
import { sql, withRlsContext, BlobCorruptError, BlobMissingError, type Kysely, type Database } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID, type LifecycleSourceRef } from '@hawa/contracts';
import { telegramSource, sourceCopyConfirmation, sourceClientSelection, sourceMessageScope, inspectVoiceAudio, VoiceAudioError } from '@hawa/domain';
import { DoclingParser, localPdfExtractor, PDF_EXTRACTOR_VERSION, DocumentExtractionError } from '@hawa/retrieval';
import { SOURCE_MESSAGES, requesterLang, say, type RequesterLang } from '@hawa/integrations';
import { chaosPoint } from '@hawa/observability';
import type { CoreContext } from '../core-context.js';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { log } from '../logging.js';
import { blobStoreFor } from './blob-store-context.js';
import { findDocumentByHash, retainDocument } from './client-documents.js';
import { recordNewBriefDecision, readNewBriefDecision, readRoutingRefusal, revisionIntakeReceipts } from './lifecycle-chat-target.js';
import { projectLifecycleRequesterRevisionWithIntake, LifecycleProjectionConflict } from './lifecycle-projection.js';
import { createTelegramUpdateState } from './telegram-intake/update-state.js';
import { readSourceUpload, readSourceExtraction, readSourceConfirmation, saveSourceUpload, saveSourceExtraction,
  saveSourceConfirmation, readSourceAdmission, readSourceAnswer, saveSourceAdmission, saveSourceAnswer, verifyReviewedSource,
  voiceInspectionHash, sourceHash, SourceConflict,
  type PendingSource, type SourceUpload, type SourceExtraction, type SourceIntakeAnswer } from './lifecycle-source-store.js';
import { admitResolved, admitSource, sourceLanguage, sourceNotice as notice, sourceQuestionText } from './lifecycle-source-admission.js';
import { askAboutSource, openSourceQuestion, readCandidate, readResolution, readSourceReply, recordCandidate, resolveSource,
  resolveSourceClient, unconfirmedSource, type SourceNeed } from './lifecycle-source-natural.js';
import { parseChoice } from './requester-turn.js';
import { readIntentReceipt } from './requester-turn-store.js';
import { pendingEditWords } from './lifecycle-media-intake.js';
import type { ChatIntake } from './chat-intake.js';
import { transcribeRetainedVoice, holdVoiceForManualReview } from './lifecycle-voice.js';
import { audioAsOggOpus, MediaConversionError } from './media-conversion.js';

type Answer = SourceIntakeAnswer;
const requestIdFor = (chat: string, id: number) => {
  const hex = createHash('sha256').update(`telegram-source:${chat}:${id}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
};
/** Words short enough to be confirmed as they are with "yes"; longer ones are sent by the requester. */
const CONFIRMABLE_CHARS = 1500;
const PREVIEW_CHARS = 600;

export function createLifecycleSourceIntake(ctx: CoreContext) {
  const { db } = ctx; let busy = false;
  const scope = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };
  const tx = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => withRlsContext(db!, scope, fn);
  const store = () => blobStoreFor(db, ctx.options?.blobStore);

  /** The language for a source's messages: its caption, else the words read from it, else the chat's. */
  const langOf = (upload: Pick<SourceUpload, 'chatId' | 'instructions' | 'sourceUpdate'>, words = '') =>
    tx((trx) => sourceLanguage(trx, scope.tenantId, upload.chatId, upload.instructions || words, upload.sourceUpdate));

  /**
   * The words read from the source, shown back to be confirmed (recorded once, so a replay shows the
   * same): the whole text when it is short enough to confirm with "yes", else its start.
   */
  const review = async (upload: SourceUpload, text: string | null, noticeUpdateId: number): Promise<Answer> => {
    const words = (text ?? '').trim();
    const candidate = await tx((trx) => recordCandidate(trx, scope.tenantId,
      { sourceUpdateId: upload.updateId, text: words, confirmable: Boolean(words) && words.length <= CONFIRMABLE_CHARS }));
    const lang = await langOf(upload, candidate.text);
    const start = candidate.text.slice(0, PREVIEW_CHARS).trimEnd();
    const message = !candidate.text
      ? say(upload.kind === 'voice' ? SOURCE_MESSAGES.voiceNoText : SOURCE_MESSAGES.pdfNoText, lang)
      : candidate.confirmable
        ? say(upload.kind === 'voice' ? SOURCE_MESSAGES.heard : SOURCE_MESSAGES.readPdf, lang, { text: candidate.text })
        : say(upload.kind === 'voice' ? SOURCE_MESSAGES.heardLong : SOURCE_MESSAGES.readPdfLong, lang, { text: start });
    return notice(upload.chatId, noticeUpdateId, message);
  };

  /** Has this update already been decided by another part of intake (a replay must not be read again)? */
  const decidedElsewhere = (updateId: number, chatId: string) => tx(async (trx) =>
    Boolean(await readIntentReceipt(trx, scope.tenantId, updateId) || await readNewBriefDecision(trx, scope.tenantId, updateId) ||
      await readRoutingRefusal(trx, scope.tenantId, updateId)) ||
    (await revisionIntakeReceipts(trx, scope.tenantId, chatId, updateId)).length > 0);

  /** A kept source as it now stands: its admission, plus the answers given to the questions about it. */
  const sourceAsAnswered = async (sourceUpdateId: number): Promise<{ source: PendingSource; need: SourceNeed | null } | null> =>
    tx(async (trx) => {
      const admission = await readSourceAdmission(trx, scope.tenantId, sourceUpdateId);
      if (!admission || (admission.result.kind !== 'pending' && admission.result.kind !== 'upload')) return null;
      const source: PendingSource = { ...admission.result.source };
      // An edit to the caption since it arrived gives the design instructions (and may name the organisation).
      const edited = await pendingEditWords(trx, scope.tenantId, sourceUpdateId);
      if (edited !== null) source.instructions = sourceClientSelection(edited).instructions;
      const target = await readResolution(trx, scope.tenantId, sourceUpdateId, 'target');
      const askedTarget = (await sql<{ one: number }>`SELECT 1 AS one FROM hawa.inbox_events WHERE tenant_id = ${scope.tenantId}::uuid
        AND source_account_id = 'lifecycle_source_pending' AND source_event_id = ${`${sourceUpdateId}:target`}`.execute(trx)).rows.length > 0;
      if (askedTarget && !source.target && !target) return { source, need: 'target' as const };
      if (target?.targetRequestId) {
        const row = (await sql<{ rev: string | number; task_id: string; client_id: string | null; question: { id?: string } | null }>`
          SELECT r.rev, r.current_task_id::text AS task_id, t.client_id::text AS client_id, p.result->'question' AS question
          FROM hawa.requests r JOIN hawa.tasks t ON t.tenant_id = r.tenant_id AND t.id = r.current_task_id
          LEFT JOIN hawa.lifecycle_projections p ON p.tenant_id = r.tenant_id AND p.request_id = r.request_id AND p.rev = r.rev
          WHERE r.tenant_id = ${scope.tenantId}::uuid AND r.request_id = ${target.targetRequestId}::uuid`.execute(trx)).rows[0];
        if (row) {
          source.target = { requestId: target.targetRequestId, taskId: row.task_id, rev: Number(row.rev),
            ...(row.question?.id ? { questionId: row.question.id } : {}) };
          source.clientId = row.client_id ?? source.clientId;
        }
      }
      if (!source.clientId) {
        const client = await readResolution(trx, scope.tenantId, sourceUpdateId, 'client');
        if (client?.clientId) source.clientId = client.clientId;
        else if (edited !== null) source.clientId = await resolveSourceClient(trx, scope.tenantId, { chatId: source.chatId, words: edited });
      }
      return { source, need: source.clientId ? null : 'client' as const };
    });

  /** The retained file: downloaded once, its bytes checked (a recording turned into Ogg Opus first). */
  async function upload(source: Omit<SourceUpload, 'blob'>): Promise<SourceUpload | Answer> {
    const prior = await tx((trx) => readSourceUpload(trx, scope.tenantId, source.updateId));
    if (prior) return prior;
    if (!store() || !ctx.telegramBridge) return { status: 503, extra: { code: 'NOT_CONFIGURED' } };
    let bytes = await ctx.telegramBridge.downloadFile(source.fileId);
    if (!bytes?.length) return { status: 503, extra: { code: 'SOURCE_DOWNLOAD_UNAVAILABLE' } };
    if (source.kind === 'pdf' && (bytes.length > 20 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-'))
      return finalAnswer(source, say(SOURCE_MESSAGES.fileUnreadable, await langOf(source)), 422);
    if (source.kind === 'voice') {
      try {
        bytes = (await audioAsOggOpus(bytes)).bytes;
      } catch (error) {
        if (!(error instanceof MediaConversionError)) throw error;
        if (error.code === 'CONVERTER_UNAVAILABLE') log.error('[core:source] a recording arrived but ffmpeg is not installed; it was refused as unplayable');
        return finalAnswer(source, say(SOURCE_MESSAGES.voiceUnplayable, await langOf(source)), 422);
      }
      inspectVoiceAudio(bytes);
    }
    const blob = await store()!.put(bytes, source.kind === 'voice' ? 'audio/ogg' : 'application/pdf'); await store()!.read(blob, { verify: true });
    const saved = await tx(async (trx) => {
      const active = await trx.selectFrom('clients').select('id').where('id', '=', source.clientId)
        .where('tenant_id', '=', scope.tenantId).where('status', '=', 'active').forShare().executeTakeFirst();
      if (!active) throw new SourceConflict('Client became unavailable');
      return saveSourceUpload(trx, scope.tenantId, { ...source, blob });
    });
    await chaosPoint('core.source.after-upload', { updateId: saved.updateId, chatId: saved.chatId });
    return saved;
  }

  /** A final answer about a source, recorded under the source's own update. */
  const finalAnswer = (source: Pick<SourceUpload, 'chatId' | 'updateId' | 'payloadHash'>, text: string, status: number) =>
    tx((trx) => saveSourceAnswer(trx, scope.tenantId, source.updateId,
      { payloadHash: source.payloadHash, answer: notice(source.chatId, source.updateId, text, status) }));

  /** Keeps, reads and shows back a source whose organisation (and design) is known. */
  async function keepAndRead(source: Omit<SourceUpload, 'blob'>, noticeUpdateId: number): Promise<Answer> {
    const answered = await tx((trx) => readSourceAnswer(trx, scope.tenantId, source.updateId));
    if (answered) return answered.answer;
    const priorUpload = await tx((trx) => readSourceUpload(trx, scope.tenantId, source.updateId));
    if (priorUpload?.kind === 'pdf') {
      const candidate = await tx((trx) => readCandidate(trx, scope.tenantId, priorUpload.updateId));
      if (candidate) return review(priorUpload, candidate.text, noticeUpdateId);
    }
    if (busy) return { status: 503, extra: { code: 'SOURCE_BUSY' } };
    busy = true;
    try {
      const kept = priorUpload ?? await upload(source);
      if (!('blob' in kept)) return kept;
      if (kept.kind === 'voice') {
        const bytes = await store()!.read(kept.blob, { verify: true });
        const audio = inspectVoiceAudio(bytes);
        await tx(trx => saveSourceExtraction(trx, scope.tenantId, {
          sourceUpdateId: kept.updateId, sourceSha256: kept.blob.sha256,
          extractionSha256: voiceInspectionHash(kept.blob.sha256, audio), extractorVersion: audio.version,
          preview: '', limitations: ['Transcription is unreviewed; no confidence or detected-language claim. Listen to the complete original.'], voice: audio,
        }));
        await chaosPoint('core.source.after-extraction', { updateId: kept.updateId, chatId: kept.chatId });
        const voice = await transcribeRetainedVoice(tx, scope.tenantId, kept, audio, bytes, ctx.voiceTranscriber);
        return review(kept, voice.state === 'received' ? voice.transcript : null, noticeUpdateId);
      }
      let document = await tx(trx => findDocumentByHash(trx, scope.tenantId, kept.clientId, kept.blob.sha256, PDF_EXTRACTOR_VERSION));
      if (!document) {
        if (!process.env.HAWA_DOCLING_URL) return { status: 503, extra: { code: 'NOT_CONFIGURED' } };
        const bytes = await store()!.read(kept.blob, { verify: true });
        const parsed = await new DoclingParser(localPdfExtractor(process.env.HAWA_DOCLING_URL))
          .parse(`${kept.clientId}:${kept.blob.sha256}`, bytes, 'application/pdf', 'telegram-source.pdf');
        document = await tx(trx => retainDocument(trx, { ...scope, clientId: kept.clientId, document: parsed }));
      }
      const parsed = JSON.parse(document.extraction_json) as { chunks: Array<{ text: string }>; extraction: { limitations: string[] } };
      const text = parsed.chunks.map(c => c.text).join('\n\n');
      await tx(trx => saveSourceExtraction(trx, scope.tenantId, { sourceUpdateId: kept.updateId,
        sourceSha256: kept.blob.sha256, extractionSha256: document!.extraction_sha256, documentId: document!.id,
        extractorVersion: document!.extractor_version, preview: text.slice(0, 1600) + (text.length > 1600 ? '\n[Preview shortened; review the original.]' : ''),
        limitations: parsed.extraction.limitations }));
      await chaosPoint('core.source.after-extraction', { updateId: kept.updateId, chatId: kept.chatId });
      return review(kept, text, noticeUpdateId);
    } finally { busy = false; }
  }

  /** The words confirmed (the requester's "yes", their corrected text, or "/use_source"): the design starts. */
  async function confirm(update: unknown, confirmationUpdateId: number, sourceUpdateId: number, copy: string): Promise<Answer> {
    const upload = await tx(trx => readSourceUpload(trx, scope.tenantId, sourceUpdateId));
    if (!upload) throw new SourceConflict('The saved original source is unavailable');
    const extraction = await tx(trx => readSourceExtraction(trx, scope.tenantId, upload.updateId));
    if (!extraction) return { status: 503, extra: { code: 'SOURCE_EXTRACTION_PENDING' } };
    if (upload.kind === 'voice') await tx(trx => holdVoiceForManualReview(trx, scope.tenantId, upload));
    const requestId = upload.target?.requestId ?? requestIdFor(upload.chatId, upload.updateId);
    const proposed = { sourceUpdateId: upload.updateId, confirmationUpdateId, requestId,
      copy, copySha256: sourceHash(copy), sourceUpdate: update,
      sourceJson: JSON.stringify(update),
      payloadHash: sourceHash(JSON.stringify(update)) };
    const saved = await tx(async trx => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`source-confirm:${upload.updateId}`},0))`.execute(trx);
      const prior = await readSourceConfirmation(trx, scope.tenantId, upload.updateId);
      if (prior && (prior.confirmationUpdateId !== confirmationUpdateId || prior.payloadHash !== proposed.payloadHash))
        throw new SourceConflict('This source already has a copy confirmation. Continue its existing request instead.');
      return saveSourceConfirmation(trx, scope.tenantId, proposed);
    });
    const ref: LifecycleSourceRef = { sourceUpdateId: upload.updateId, confirmationUpdateId: saved.confirmationUpdateId };
    if (upload.target) {
      const target = upload.target, round = Math.max(1, Math.floor((target.rev - 1) / 2));
      const result = await projectLifecycleRequesterRevisionWithIntake(db!, {
        requestId, tenantId: scope.tenantId, priorTaskId: target.taskId, expectedRev: target.rev, rev: target.rev + 1,
        round, directive: saved.copy.trim(), rawText: saved.copy, sourceChannelId: upload.chatId,
        sourceEventId: `lc-${requestId}-r${round}-u${saved.confirmationUpdateId}`,
        key: `${requestId}:${target.rev + 1}:requesterRevisionIntake:u${saved.confirmationUpdateId}`,
        sourceUpdate: JSON.parse(saved.sourceJson), sourceUpdateHash: saved.payloadHash, clientId: upload.clientId,
        lifecycleSource: ref, ...(target.questionId ? { questionId: target.questionId } : {}),
      }, store());
      await chaosPoint('core.source.after-confirmation', { updateId: confirmationUpdateId, requestId });
      return { status: 200, extra: { lifecycleAction: target.questionId ? 'requester-answer' : 'requester-revision',
        requestId, newTaskId: result.newTaskId, round: result.round, directive: result.directive,
        rawText: saved.copy, priorTaskId: target.taskId, chatId: upload.chatId,
        ...(target.questionId ? { questionId: target.questionId } : {}) } };
    }
    const existing = await tx(trx => readNewBriefDecision(trx, scope.tenantId, confirmationUpdateId));
    if (existing) {
      if (existing.payloadHash !== saved.payloadHash || existing.requestId !== requestId) throw new SourceConflict('Confirmation decision changed');
      return { status: 200, extra: { duplicate: true, lifecycleAction: 'open-request', requestId, chatId: upload.chatId, draft: existing.draft } };
    }
    await tx(trx => verifyReviewedSource(trx, store(), { ...scope, clientId: upload.clientId,
      chatId: upload.chatId, requestId, ref, copy: saved.copy }));
    const rtl = /[؀-ۿ]/.test(saved.copy);
    const instructions = (await tx((trx) => pendingEditWords(trx, scope.tenantId, upload.updateId)));
    const draft: ChatIntake = { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: upload.chatId,
      rawText: saved.copy, title: saved.copy.trim().split('\n')[0].slice(0, 200), clientId: upload.clientId,
      designInstructions: instructions !== null ? sourceClientSelection(instructions).instructions : upload.instructions,
      exactCopy: [{ id: 'reviewed_source_copy', text: saved.copy,
        role: 'body', language: rtl ? 'ckb' : 'en', direction: rtl ? 'rtl' : 'ltr', approved: true }],
      autoGenerate: true, lifecycleSource: ref, variant: upload.variant ?? { width: 1080, height: 1350 } };
    const decision = await tx(trx => recordNewBriefDecision(trx, scope.tenantId, confirmationUpdateId,
      { requestId, chatId: upload.chatId, payloadHash: saved.payloadHash, draft,
        sourceUpdate: { original: upload.sourceUpdate, confirmation: saved.sourceUpdate } }));
    if (decision.payloadHash !== saved.payloadHash || decision.requestId !== requestId) throw new SourceConflict('Confirmation decision changed');
    await chaosPoint('core.source.after-confirmation', { updateId: confirmationUpdateId, requestId });
    return { status: 200, extra: { lifecycleAction: 'open-request', requestId, chatId: upload.chatId, draft: decision.draft } };
  }

  /**
   * A source's questions answered by this update's words, or its words confirmed: `null` when the
   * update is neither (it is then read as any message is).
   */
  async function naturalReply(update: unknown, envelope: NonNullable<ReturnType<typeof sourceMessageScope>>, text: string,
    payloadHash: string): Promise<Answer | null> {
    const who = { chatId: envelope.chatId, senderId: envelope.senderId, topicId: envelope.topicId };
    if (await decidedElsewhere(envelope.updateId, envelope.chatId)) return null;
    const lang = requesterLang(text);
    const question = await tx((trx) => openSourceQuestion(trx, scope.tenantId, who));
    if (question) {
      const said = question.need === 'target'
        ? parseChoice(text, { options: question.options, allowNew: true }) : null;
      const clientId = question.need === 'client'
        ? await tx(async (trx) => {
          const line = sourceClientSelection(text).client;
          if (line) {
            const rows = (await sql<{ id: string }>`SELECT id::text FROM hawa.clients WHERE tenant_id=${scope.tenantId}::uuid AND status='active'
              AND (lower(code)=lower(${line}) OR lower(name)=lower(${line})) LIMIT 2`.execute(trx)).rows;
            if (rows.length === 1) return rows[0].id;
          }
          return resolveSourceClient(trx, scope.tenantId, { chatId: '', words: text });
        }) : null;
      if (said || clientId) {
        await tx(async (trx) => {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope.tenantId}:source-admit:${question.sourceUpdateId}`},0))`.execute(trx);
          await resolveSource(trx, scope.tenantId, question.sourceUpdateId, question.need, {
            byUpdateId: envelope.updateId,
            ...(clientId ? { clientId } : {}),
            ...(said && 'option' in said ? { targetRequestId: question.options[said.option].requestId } : {}),
            ...(said && 'new' in said ? { isNew: true } : {}),
          });
          await saveSourceAdmission(trx, scope.tenantId, envelope.updateId,
            { payloadHash, result: { kind: 'resolved', sourceUpdateId: question.sourceUpdateId } });
        });
        return continueAnswered(question.sourceUpdateId, envelope.updateId);
      }
      // A short answer that names no organisation this office works with: asked again, kindly.
      const reading = readSourceReply(text);
      if (question.need === 'client' && reading.kind === 'copy' && text.trim().split(/\s+/).length <= 6) {
        const answer = notice(envelope.chatId, envelope.updateId, say(SOURCE_MESSAGES.clientNotFound, lang));
        await tx((trx) => saveSourceAdmission(trx, scope.tenantId, envelope.updateId, { payloadHash, result: { kind: 'answer', answer } }));
        return answer;
      }
      return null;
    }
    const sourceUpdateId = await tx((trx) => unconfirmedSource(trx, scope.tenantId, who));
    if (!sourceUpdateId) return null;
    const reply = readSourceReply(text);
    if (reply.kind === 'other') return null;
    const candidate = await tx((trx) => readCandidate(trx, scope.tenantId, sourceUpdateId));
    if (reply.kind === 'no' || (reply.kind === 'yes' && !candidate?.confirmable)) {
      const answer = notice(envelope.chatId, envelope.updateId,
        say(reply.kind === 'no' ? SOURCE_MESSAGES.sendCorrected : SOURCE_MESSAGES.sendExactWords, lang));
      await tx((trx) => saveSourceAdmission(trx, scope.tenantId, envelope.updateId, { payloadHash, result: { kind: 'answer', answer } }));
      return answer;
    }
    const copy = reply.kind === 'yes' ? candidate!.text : reply.copy;
    if (!copy.trim() || copy.length > 100_000) return null;
    await tx((trx) => saveSourceAdmission(trx, scope.tenantId, envelope.updateId,
      { payloadHash, result: { kind: 'confirmation', sourceUpdateId, copy } }));
    return confirm(update, envelope.updateId, sourceUpdateId, copy);
  }

  /** After an answer: the next question, or the source kept and read. The notice is keyed by the answer. */
  async function continueAnswered(sourceUpdateId: number, noticeUpdateId: number): Promise<Answer> {
    const state = await sourceAsAnswered(sourceUpdateId);
    if (!state) throw new SourceConflict('The kept source is unavailable');
    const { source } = state;
    const lang = await langOf(source);
    if (state.need) {
      await tx((trx) => askAboutSource(trx, scope.tenantId, { sourceUpdateId, need: state.need!, chatId: source.chatId,
        senderId: source.senderId, topicId: source.topicId, messageId: String(source.messageId), options: [] }));
      return notice(source.chatId, noticeUpdateId, sourceQuestionText(state.need, source.kind, [], lang));
    }
    type Kept = { refused: Answer } | { resolved: Omit<SourceUpload, 'blob'> };
    const kept = await tx((trx) => admitResolved<Kept>(trx, scope.tenantId, { ...source, clientId: source.clientId! }, lang,
      async (text, status) => ({ refused: notice(source.chatId, noticeUpdateId, text, status) }),
      async (resolved) => ({ resolved })));
    if ('refused' in kept) return kept.refused;
    return keepAndRead(kept.resolved, noticeUpdateId);
  }

  return async (update: unknown): Promise<Answer | null> => {
    const envelope = sourceMessageScope(update), pdf = telegramSource(update), confirmation = sourceCopyConfirmation(update);
    if (!envelope) return null;
    const message = (update as { message?: Record<string, unknown> }).message;
    const text = !pdf && !confirmation && typeof message?.text === 'string' ? message.text : null;
    if (!db) return pdf || confirmation ? { status: 503, extra: { code: 'DATABASE_UNAVAILABLE' } } : null;
    const allowed = !ctx.isProduction || ctx.telegramIntakeUsers.includes('*') ||
      process.env.TELEGRAM_INTAKE_ALLOWED_USERS === '*' || ctx.telegramIntakeUsers.includes(envelope.senderId);
    const payloadHash = sourceHash(JSON.stringify(update));
    try {
      const [priorUpload, priorAdmission, priorAnswer] = await tx(async trx => [
        await readSourceUpload(trx, scope.tenantId, envelope.updateId),
        await readSourceAdmission(trx, scope.tenantId, envelope.updateId),
        await readSourceAnswer(trx, scope.tenantId, envelope.updateId),
      ] as const);
      if ([priorUpload, priorAdmission, priorAnswer].some(prior => prior && prior.payloadHash !== payloadHash))
        throw new SourceConflict('Source event changed');
      if (!confirmation && !priorUpload && !priorAdmission && !priorAnswer && !pdf) {
        // ADR-145: plain words may answer a question about a kept source, or confirm its words.
        return text !== null && allowed ? await naturalReply(update, envelope, text, payloadHash) : null;
      }
      if (!allowed) return { status: 403, extra: { code: 'SENDER_NOT_ALLOWED' } };
      if (priorAnswer) return priorAnswer.answer;
      if (pdf && !priorUpload && !priorAdmission) {
        const old = await createTelegramUpdateState(ctx).telegramUpdateHandled(pdf.chatId, String(pdf.updateId));
        if (old) return { status: 200, extra: { duplicate: true, ...(old.taskId ? { taskIds: [old.taskId] } : {}) } };
      }
      const admission = priorAdmission ?? await tx(trx => admitSource(trx, scope.tenantId, update));
      const result = admission.result;
      if (result.kind === 'answer') return result.answer;
      // The question asked about it; a later message that answered it carried on from there.
      if (result.kind === 'pending') return result.answer;
      await chaosPoint('core.source.after-admission', { updateId: envelope.updateId, chatId: envelope.chatId });
      if (result.kind === 'resolved') return await continueAnswered(result.sourceUpdateId, envelope.updateId);
      if (result.kind === 'confirmation') {
        const copy = result.copy ?? confirmation?.copy;
        if (copy === undefined) throw new SourceConflict('Source confirmation event changed');
        return await confirm(update, envelope.updateId, result.sourceUpdateId, copy);
      }
      return await keepAndRead(result.source, envelope.updateId);
    } catch (error) {
      const words = typeof message?.caption === 'string' ? message.caption : typeof message?.text === 'string' ? message.text : '';
      const lang: RequesterLang = requesterLang(words);
      if (error instanceof SourceConflict || error instanceof LifecycleProjectionConflict) {
        log.warn(`[core:source] update ${envelope.updateId} refused: ${error.message}`);
        const answer = notice(envelope.chatId, envelope.updateId, say(SOURCE_MESSAGES.fileProblem, lang), 409);
        // A changed payload must never write a refusal over the legitimate source identity.
        const admission = await tx(trx => readSourceAdmission(trx, scope.tenantId, envelope.updateId));
        return admission?.payloadHash === payloadHash
          ? tx(trx => saveSourceAnswer(trx, scope.tenantId, envelope.updateId, { payloadHash, answer })) : answer;
      }
      if (error instanceof VoiceAudioError)
        return tx(trx => saveSourceAnswer(trx, scope.tenantId, envelope.updateId, { payloadHash, answer: notice(envelope.chatId, envelope.updateId,
          say(/ten minutes/.test(error.message) ? SOURCE_MESSAGES.voiceTooLong : SOURCE_MESSAGES.voiceUnplayable, lang), 422) }));
      if (error instanceof DocumentExtractionError && !/CONFIG|BUSY|TIMEOUT|UNAVAILABLE/.test(error.code))
        return tx(trx => saveSourceAnswer(trx, scope.tenantId, envelope.updateId, { payloadHash, answer: notice(envelope.chatId, envelope.updateId,
          say(SOURCE_MESSAGES.pdfNoText, lang), 422) }));
      if (error instanceof BlobCorruptError || error instanceof BlobMissingError ||
          (error instanceof Error && /SOURCE_(BYTES|STORE)_UNAVAILABLE/.test(error.message)))
        return { status: 503, extra: { code: 'SOURCE_BYTES_UNAVAILABLE' } };
      throw error;
    }
  };
}
