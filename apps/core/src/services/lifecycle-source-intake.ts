/** File → retained candidate → explicit exact-copy confirmation, within the existing request owner. */
import { createHash } from 'node:crypto';
import { sql, withRlsContext, BlobCorruptError, BlobMissingError, type Kysely, type Database } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID, type LifecycleSourceRef } from '@hawa/contracts';
import { telegramSource, sourceCopyConfirmation, sourceMessageScope, inspectVoiceAudio, VoiceAudioError } from '@hawa/domain';
import { DoclingParser, localPdfExtractor, PDF_EXTRACTOR_VERSION, DocumentExtractionError } from '@hawa/retrieval';
import { chaosPoint } from '@hawa/observability';
import type { CoreContext } from '../core-context.js';
import { DEFAULT_TENANT_ID } from '../core-context.js';
import { blobStoreFor } from './blob-store-context.js';
import { findDocumentByHash, retainDocument } from './client-documents.js';
import { recordNewBriefDecision, readNewBriefDecision } from './lifecycle-chat-target.js';
import { projectLifecycleRequesterRevisionWithIntake, LifecycleProjectionConflict } from './lifecycle-projection.js';
import { createTelegramUpdateState } from './telegram-intake/update-state.js';
import { readSourceUpload, readSourceExtraction, readSourceConfirmation, saveSourceUpload, saveSourceExtraction,
  saveSourceConfirmation, readSourceAdmission, readSourceAnswer, saveSourceAnswer, verifyReviewedSource, voiceInspectionHash, sourceHash, SourceConflict,
  type SourceUpload, type SourceExtraction, type SourceIntakeAnswer } from './lifecycle-source-store.js';
import { admitSource, sourceNotice as notice } from './lifecycle-source-admission.js';
import type { ChatIntake } from './chat-intake.js';
import { transcribeRetainedVoice, holdVoiceForManualReview, type SourceVoiceReview } from './lifecycle-voice.js';

type Answer = SourceIntakeAnswer;
const requestIdFor = (chat: string, id: number) => {
  const hex = createHash('sha256').update(`telegram-source:${chat}:${id}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
};
export function createLifecycleSourceIntake(ctx: CoreContext) {
  const { db } = ctx; let busy = false;
  const scope = { tenantId: DEFAULT_TENANT_ID, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' as const };
  const tx = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => withRlsContext(db!, scope, fn);
  const store = () => blobStoreFor(db, ctx.options?.blobStore);
  const review = (upload: SourceUpload, extraction: SourceExtraction, voice?: SourceVoiceReview) => notice(upload.chatId, upload.updateId,
    `${upload.kind === 'voice' ? 'Voice original' : 'PDF'} saved for review. No design has started.\n` +
    `Canvas: ${upload.variant ? `${upload.variant.width} × ${upload.variant.height} px` : upload.target ? 'keep the existing request format' : '1080 × 1350 px (default)'}.\n\n` +
    (voice ? `${voice.message}\nReserved estimate: ${voice.estimatedUsd === null ? 'no paid call' : `$${voice.estimatedUsd.toFixed(3)}`}; actual billed cost unknown.\n\n${voice.transcript ? `Unreviewed transcript preview:\n${voice.transcript.slice(0, 1400)}${voice.transcript.length > 1400 ? '\n[Preview shortened; open the full transcript in Desk.]' : ''}\n\n` : ''}` : `Extracted preview (check every page of the original):\n${extraction.preview}\n\n`) +
    `Limits: ${extraction.limitations.join('; ').slice(0, 350)}\n\n` +
    'Reply to your original source with /use_source on its own line, then the exact corrected text to print. ' +
    'Everything after that line is copy, including whitespace. Use the original caption for design instructions. ' +
    'The saved original is also available in Hawa Desk under this client.');

  return async (update: unknown): Promise<Answer | null> => {
    const envelope = sourceMessageScope(update), pdf = telegramSource(update), confirmation = sourceCopyConfirmation(update);
    if (!envelope) return null;
    if (!db) return pdf || confirmation ? { status: 503, extra: { code: 'DATABASE_UNAVAILABLE' } } : null;
    const allowed = !ctx.isProduction || ctx.telegramIntakeUsers.includes('*') ||
      process.env.TELEGRAM_INTAKE_ALLOWED_USERS === '*' || ctx.telegramIntakeUsers.includes(envelope.senderId);
    const payloadHash = sourceHash(JSON.stringify(update));
    const finalAnswer = (answer: Answer) => tx(trx => saveSourceAnswer(trx, scope.tenantId, envelope.updateId, { payloadHash, answer }));
    try {
      const [priorUpload, priorAdmission, priorAnswer] = await tx(async trx => [
        await readSourceUpload(trx, scope.tenantId, envelope.updateId),
        await readSourceAdmission(trx, scope.tenantId, envelope.updateId),
        await readSourceAnswer(trx, scope.tenantId, envelope.updateId),
      ] as const);
      if ([priorUpload, priorAdmission, priorAnswer].some(prior => prior && prior.payloadHash !== payloadHash))
        throw new SourceConflict('Source event changed');
      if (!confirmation && !priorUpload && !priorAdmission && !priorAnswer &&
          !pdf) return null;
      if (!allowed) return { status: 403, extra: { code: 'SENDER_NOT_ALLOWED' } };
      if (priorAnswer) return priorAnswer.answer;
      if (pdf && !priorUpload && !priorAdmission) {
        const old = await createTelegramUpdateState(ctx).telegramUpdateHandled(pdf.chatId, String(pdf.updateId));
        if (old) return { status: 200, extra: { duplicate: true, ...(old.taskId ? { taskIds: [old.taskId] } : {}) } };
      }
      const admission = priorAdmission ?? await tx(trx => admitSource(trx, scope.tenantId, update));
      if (admission.result.kind === 'answer') return admission.result.answer;
      await chaosPoint('core.source.after-admission', { updateId: envelope.updateId, chatId: envelope.chatId });
      if (admission.result.kind === 'confirmation') {
        if (!confirmation) throw new SourceConflict('Source confirmation event changed');
        const sourceUpdateId = admission.result.sourceUpdateId;
        const upload = await tx(trx => readSourceUpload(trx, scope.tenantId, sourceUpdateId));
        if (!upload) throw new SourceConflict('The saved original source is unavailable');
        const extraction = await tx(trx => readSourceExtraction(trx, scope.tenantId, upload.updateId));
        if (!extraction) return { status: 503, extra: { code: 'SOURCE_EXTRACTION_PENDING' } };
        if (upload.kind === 'voice') await tx(trx => holdVoiceForManualReview(trx, scope.tenantId, upload));
        const requestId = upload.target?.requestId ?? requestIdFor(upload.chatId, upload.updateId);
        const proposed = { sourceUpdateId: upload.updateId, confirmationUpdateId: envelope.updateId, requestId,
          copy: confirmation.copy, copySha256: sourceHash(confirmation.copy), sourceUpdate: update,
          sourceJson: JSON.stringify(update),
          payloadHash: sourceHash(JSON.stringify(update)) };
        const saved = await tx(async trx => {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`source-confirm:${upload.updateId}`},0))`.execute(trx);
          const prior = await readSourceConfirmation(trx, scope.tenantId, upload.updateId);
          if (prior && (prior.confirmationUpdateId !== envelope.updateId || prior.payloadHash !== proposed.payloadHash))
            throw new SourceConflict('This source already has a copy confirmation. Continue its existing request instead.');
          return saveSourceConfirmation(trx, scope.tenantId, proposed);
        });
        const ref: LifecycleSourceRef = { sourceUpdateId: upload.updateId, confirmationUpdateId: saved.confirmationUpdateId };
        if (upload.target) {
          const target = upload.target, round = Math.max(1, Math.floor((target.rev - 1) / 2));
          const result = await projectLifecycleRequesterRevisionWithIntake(db, {
            requestId, tenantId: scope.tenantId, priorTaskId: target.taskId, expectedRev: target.rev, rev: target.rev + 1,
            round, directive: saved.copy.trim(), rawText: saved.copy, sourceChannelId: upload.chatId,
            sourceEventId: `lc-${requestId}-r${round}-u${saved.confirmationUpdateId}`,
            key: `${requestId}:${target.rev + 1}:requesterRevisionIntake:u${saved.confirmationUpdateId}`,
            sourceUpdate: JSON.parse(saved.sourceJson), sourceUpdateHash: saved.payloadHash, clientId: upload.clientId,
            lifecycleSource: ref, ...(target.questionId ? { questionId: target.questionId } : {}),
          }, store());
          await chaosPoint('core.source.after-confirmation', { updateId: envelope.updateId, requestId });
          return { status: 200, extra: { lifecycleAction: target.questionId ? 'requester-answer' : 'requester-revision',
            requestId, newTaskId: result.newTaskId, round: result.round, directive: result.directive,
            rawText: saved.copy, priorTaskId: target.taskId, chatId: upload.chatId,
            ...(target.questionId ? { questionId: target.questionId } : {}) } };
        }
        const existing = await tx(trx => readNewBriefDecision(trx, scope.tenantId, envelope.updateId));
        if (existing) {
          if (existing.payloadHash !== saved.payloadHash || existing.requestId !== requestId) throw new SourceConflict('Confirmation decision changed');
          return { status: 200, extra: { duplicate: true, lifecycleAction: 'open-request', requestId, chatId: upload.chatId, draft: existing.draft } };
        }
        await tx(trx => verifyReviewedSource(trx, store(), { ...scope, clientId: upload.clientId,
          chatId: upload.chatId, requestId, ref, copy: saved.copy }));
        const rtl = /[\u0600-\u06ff]/.test(saved.copy);
        const draft: ChatIntake = { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: upload.chatId,
          rawText: saved.copy, title: saved.copy.trim().split('\n')[0].slice(0, 200), clientId: upload.clientId,
          designInstructions: upload.instructions, exactCopy: [{ id: 'reviewed_source_copy', text: saved.copy,
            role: 'body', language: rtl ? 'ckb' : 'en', direction: rtl ? 'rtl' : 'ltr', approved: true }],
          autoGenerate: true, lifecycleSource: ref, variant: upload.variant ?? { width: 1080, height: 1350 } };
        const decision = await tx(trx => recordNewBriefDecision(trx, scope.tenantId, envelope.updateId,
          { requestId, chatId: upload.chatId, payloadHash: saved.payloadHash, draft,
            sourceUpdate: { original: upload.sourceUpdate, confirmation: saved.sourceUpdate } }));
        if (decision.payloadHash !== saved.payloadHash || decision.requestId !== requestId) throw new SourceConflict('Confirmation decision changed');
        await chaosPoint('core.source.after-confirmation', { updateId: envelope.updateId, requestId });
        return { status: 200, extra: { lifecycleAction: 'open-request', requestId, chatId: upload.chatId, draft: decision.draft } };
      }
      const source = admission.result.source;
      let upload = priorUpload;
      if (upload) {
        const extraction = await tx(trx => readSourceExtraction(trx, scope.tenantId, upload!.updateId));
        if (extraction && upload.kind === 'pdf') return review(upload, extraction);
      }
      if (busy) return { status: 503, extra: { code: 'SOURCE_BUSY' } };
      busy = true;
      try {
        if (!upload) {
          if (!store() || !ctx.telegramBridge) return { status: 503, extra: { code: 'NOT_CONFIGURED' } };
          const bytes = await ctx.telegramBridge.downloadFile(source.fileId);
          if (!bytes?.length) return { status: 503, extra: { code: 'SOURCE_DOWNLOAD_UNAVAILABLE' } };
          if (source.kind === 'pdf' && (bytes.length > 20 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-'))
            return finalAnswer(notice(source.chatId, source.updateId, 'This file is not an admitted PDF. Send a valid PDF of at most 20 MiB; its caption cannot replace the source.', 422));
          if (source.kind === 'voice') inspectVoiceAudio(bytes);
          const blob = await store()!.put(bytes, source.kind === 'voice' ? 'audio/ogg' : 'application/pdf'); await store()!.read(blob, { verify: true });
          upload = await tx(async trx => {
            const active = await trx.selectFrom('clients').select('id').where('id', '=', source.clientId)
              .where('tenant_id', '=', scope.tenantId).where('status', '=', 'active').forShare().executeTakeFirst();
            if (!active) throw new SourceConflict('Client became unavailable');
            return saveSourceUpload(trx, scope.tenantId, { ...source, blob });
          });
          await chaosPoint('core.source.after-upload', { updateId: upload.updateId, chatId: upload.chatId });
        }
        if (upload.kind === 'voice') {
          const bytes = await store()!.read(upload.blob, { verify: true });
          const audio = inspectVoiceAudio(bytes);
          const extraction = await tx(trx => saveSourceExtraction(trx, scope.tenantId, {
            sourceUpdateId: upload!.updateId, sourceSha256: upload!.blob.sha256,
            extractionSha256: voiceInspectionHash(upload!.blob.sha256, audio), extractorVersion: audio.version,
            preview: '', limitations: ['Transcription is unreviewed; no confidence or detected-language claim. Listen to the complete original.'], voice: audio,
          }));
          await chaosPoint('core.source.after-extraction', { updateId: upload.updateId, chatId: upload.chatId });
          const voice = await transcribeRetainedVoice(tx, scope.tenantId, upload, audio, bytes, ctx.voiceTranscriber);
          return review(upload, extraction, voice);
        }
        let document = await tx(trx => findDocumentByHash(trx, scope.tenantId, upload!.clientId, upload!.blob.sha256, PDF_EXTRACTOR_VERSION));
        if (!document) {
          if (!process.env.HAWA_DOCLING_URL) return { status: 503, extra: { code: 'NOT_CONFIGURED' } };
          const bytes = await store()!.read(upload.blob, { verify: true });
          const parsed = await new DoclingParser(localPdfExtractor(process.env.HAWA_DOCLING_URL))
            .parse(`${upload.clientId}:${upload.blob.sha256}`, bytes, 'application/pdf', 'telegram-source.pdf');
          document = await tx(trx => retainDocument(trx, { ...scope, clientId: upload!.clientId, document: parsed }));
        }
        const parsed = JSON.parse(document.extraction_json) as { chunks: Array<{ text: string }>; extraction: { limitations: string[] } };
        const text = parsed.chunks.map(c => c.text).join('\n\n');
        const extraction = await tx(trx => saveSourceExtraction(trx, scope.tenantId, { sourceUpdateId: upload!.updateId,
          sourceSha256: upload!.blob.sha256, extractionSha256: document!.extraction_sha256, documentId: document!.id,
          extractorVersion: document!.extractor_version, preview: text.slice(0, 1600) + (text.length > 1600 ? '\n[Preview shortened; review the original.]' : ''),
          limitations: parsed.extraction.limitations }));
        await chaosPoint('core.source.after-extraction', { updateId: upload.updateId, chatId: upload.chatId });
        return review(upload, extraction);
      } finally { busy = false; }
    } catch (error) {
      if (error instanceof SourceConflict || error instanceof LifecycleProjectionConflict) {
        const answer = notice(envelope.chatId, envelope.updateId, `Source review refused: ${error.message}`, 409);
        // A changed payload must never write a refusal over the legitimate source identity.
        const admission = await tx(trx => readSourceAdmission(trx, scope.tenantId, envelope.updateId));
        return admission?.payloadHash === payloadHash ? finalAnswer(answer) : answer;
      }
      if (error instanceof VoiceAudioError)
        return finalAnswer(notice(envelope.chatId, envelope.updateId, `${error.message}. Send a valid single-stream Ogg Opus recording of at most 20 MiB and ten minutes, or send the complete brief as text. No design or transcription started.`, 422));
      if (error instanceof DocumentExtractionError && !/CONFIG|BUSY|TIMEOUT|UNAVAILABLE/.test(error.code))
        return finalAnswer(notice(envelope.chatId, envelope.updateId, `The PDF is retained but extraction stopped (${error.code}). No design started. Ask the office to review the original or send a text PDF.`, 422));
      if (error instanceof BlobCorruptError || error instanceof BlobMissingError ||
          (error instanceof Error && /SOURCE_(BYTES|STORE)_UNAVAILABLE/.test(error.message)))
        return { status: 503, extra: { code: 'SOURCE_BYTES_UNAVAILABLE' } };
      throw error;
    }
  };
}
