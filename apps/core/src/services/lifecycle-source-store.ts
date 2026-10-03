/** Immutable source evidence in the existing inbox ledger. Never trusts worker-supplied extraction. */
import { createHash } from 'node:crypto';
import { sql, type Database, type Kysely, type BlobStore } from '@hawa/db';
import { parseBlobRef, type BlobRef, type LifecycleSourceRef, type TelegramReviewedSourceEvidence } from '@hawa/contracts';
import { inspectVoiceAudio, type TelegramSourceEnvelope, type VoiceAudioInspection } from '@hawa/domain';
import type { DocumentRow } from './client-documents.js';

export const sourceHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export interface SourceUpload extends TelegramSourceEnvelope {
  clientId: string; instructions: string; sourceUpdate: unknown; payloadHash: string; blob: BlobRef;
  variant?: { width: number; height: number };
  target?: { requestId: string; taskId: string; rev: number; questionId?: string };
}
export interface SourceExtraction {
  sourceUpdateId: number; sourceSha256: string; extractionSha256: string;
  extractorVersion: string; documentId?: string; preview: string; limitations: string[];
  voice?: VoiceAudioInspection;
}
export interface SourceConfirmation {
  sourceUpdateId: number; confirmationUpdateId: number; requestId: string;
  copy: string; copySha256: string; payloadHash: string; sourceUpdate: unknown; sourceJson: string;
}
export interface SourceIntakeAnswer { status: number; extra: Record<string, unknown> }
/** A source whose organisation, or whose design (a change or a new one), the requester is asked about (ADR-145). */
export type PendingSource = Omit<SourceUpload, 'blob' | 'clientId'> & { clientId: string | null };
export type SourceAdmission = { payloadHash: string; result:
  | { kind: 'upload'; source: Omit<SourceUpload, 'blob'> }
  /** ADR-145: the source is kept while one question about it is asked (`answer` is the question). */
  | { kind: 'pending'; source: PendingSource; answer: SourceIntakeAnswer }
  /** ADR-145: this update answered a question about the source `sourceUpdateId`. */
  | { kind: 'resolved'; sourceUpdateId: number }
  /** `copy`: ADR-145's natural confirmation ("yes", or the corrected text) carries the words itself. */
  | { kind: 'confirmation'; sourceUpdateId: number; copy?: string }
  | { kind: 'answer'; answer: SourceIntakeAnswer }
};
interface SourceAnswer { payloadHash: string; answer: SourceIntakeAnswer }
export class SourceConflict extends Error {}

/** Source identities survive media-kind edits, malformed replacements and flag rollback. */
export async function assertSourceIdentity(trx: Kysely<Database>, tenantId: string, update: { update_id: number }) {
  const rows = (await sql<{ payload: { payloadHash: string } }>`SELECT payload FROM hawa.inbox_events
    WHERE tenant_id=${tenantId}::uuid AND (
      (source_account_id IN ('lifecycle_source_upload','lifecycle_source_admission','lifecycle_source_answer')
        AND source_event_id=${String(update.update_id)}) OR
      (source_account_id='lifecycle_source_confirmation' AND payload->>'confirmationUpdateId'=${String(update.update_id)}))`.execute(trx)).rows;
  const hash = sourceHash(JSON.stringify(update));
  if (rows.some(row => row.payload.payloadHash !== hash)) throw new SourceConflict('This source event already has different content');
}

export async function readSourceRecord<T>(trx: Kysely<Database>, tenantId: string, kind: string, id: number | string): Promise<T | null> {
  const row = (await sql<{ payload: T }>`SELECT payload FROM hawa.inbox_events
    WHERE tenant_id=${tenantId}::uuid AND source_account_id=${kind} AND source_event_id=${String(id)}
      AND event_kind=${kind} LIMIT 1`.execute(trx)).rows[0];
  return row?.payload ?? null;
}
export async function appendSourceRecord<T>(trx: Kysely<Database>, tenantId: string, kind: string, id: number | string, payload: T): Promise<T> {
  const json = JSON.stringify(payload);
  await sql`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
    VALUES (${tenantId}::uuid,${kind},${String(id)},${kind},${json}::jsonb,${sourceHash(json)},true)
    ON CONFLICT DO NOTHING`.execute(trx);
  const saved = await readSourceRecord<T>(trx, tenantId, kind, id);
  if (!saved) throw new Error('Source ledger did not commit');
  return saved;
}
const read = readSourceRecord, append = appendSourceRecord;
export async function readSourceUpload(trx: Kysely<Database>, tenantId: string, updateId: number) {
  const upload = await read<SourceUpload>(trx, tenantId, 'lifecycle_source_upload', updateId);
  if (upload && (!parseBlobRef(upload.blob) || upload.updateId !== updateId || !upload.clientId || !upload.payloadHash))
    throw new SourceConflict('Invalid saved source');
  return upload;
}
export const readSourceExtraction = (trx: Kysely<Database>, tenantId: string, id: number) =>
  read<SourceExtraction>(trx, tenantId, 'lifecycle_source_extraction', id);
export const readSourceConfirmation = (trx: Kysely<Database>, tenantId: string, id: number) =>
  read<SourceConfirmation>(trx, tenantId, 'lifecycle_source_confirmation', id);
export const readSourceAdmission = (trx: Kysely<Database>, tenantId: string, id: number) =>
  read<SourceAdmission>(trx, tenantId, 'lifecycle_source_admission', id);
export async function saveSourceAdmission(trx: Kysely<Database>, tenantId: string, id: number, admission: SourceAdmission) {
  const saved = await append(trx, tenantId, 'lifecycle_source_admission', id, admission);
  if (saved.payloadHash !== admission.payloadHash) throw new SourceConflict('Source admission event changed');
  return saved;
}
export const readSourceAnswer = (trx: Kysely<Database>, tenantId: string, id: number) =>
  read<SourceAnswer>(trx, tenantId, 'lifecycle_source_answer', id);
export async function saveSourceAnswer(trx: Kysely<Database>, tenantId: string, id: number, answer: SourceAnswer) {
  const saved = await append(trx, tenantId, 'lifecycle_source_answer', id, answer);
  if (saved.payloadHash !== answer.payloadHash) throw new SourceConflict('Source answer event changed');
  return saved.answer;
}
export async function saveSourceUpload(trx: Kysely<Database>, tenantId: string, upload: SourceUpload) {
  const saved = await append(trx, tenantId, 'lifecycle_source_upload', upload.updateId, upload);
  if (saved.payloadHash !== upload.payloadHash || saved.chatId !== upload.chatId || saved.clientId !== upload.clientId ||
      saved.blob.sha256 !== upload.blob.sha256) throw new SourceConflict('Source identity changed');
  return saved;
}
export const saveSourceExtraction = (trx: Kysely<Database>, tenantId: string, extraction: SourceExtraction) =>
  append(trx, tenantId, 'lifecycle_source_extraction', extraction.sourceUpdateId, extraction);
export async function saveSourceConfirmation(trx: Kysely<Database>, tenantId: string, confirmation: SourceConfirmation) {
  const saved = await append(trx, tenantId, 'lifecycle_source_confirmation', confirmation.sourceUpdateId, confirmation);
  if (saved.confirmationUpdateId !== confirmation.confirmationUpdateId || saved.payloadHash !== confirmation.payloadHash ||
      saved.copy !== confirmation.copy || saved.requestId !== confirmation.requestId)
    throw new SourceConflict('This source already has a different copy confirmation');
  return saved;
}
export async function sourceByReply(trx: Kysely<Database>, tenantId: string,
  scope: { chatId: string; senderId: string; topicId: string; replyMessageId: number | null }) {
  const rows = (await sql<{ payload: SourceUpload }>`SELECT payload FROM hawa.inbox_events
    WHERE tenant_id=${tenantId}::uuid AND source_account_id='lifecycle_source_upload'
      AND event_kind='lifecycle_source_upload' AND payload->>'chatId'=${scope.chatId}
      AND payload->>'senderId'=${scope.senderId} AND payload->>'topicId'=${scope.topicId}
      AND payload->>'messageId'=${String(scope.replyMessageId)} LIMIT 2`.execute(trx)).rows;
  return rows.length === 1 ? rows[0].payload : null;
}

/** Metadata and byte verification use this transaction's reference; no second pool checkout. */
export async function verifyReviewedSource(trx: Kysely<Database>, store: BlobStore | null, input: {
  tenantId: string; clientId: string; chatId: string; requestId: string; ref: LifecycleSourceRef; copy: string;
}): Promise<{ evidence: TelegramReviewedSourceEvidence; upload: SourceUpload; confirmation: SourceConfirmation }> {
  const upload = await readSourceUpload(trx, input.tenantId, input.ref.sourceUpdateId);
  const extraction = await readSourceExtraction(trx, input.tenantId, input.ref.sourceUpdateId);
  const confirmation = await readSourceConfirmation(trx, input.tenantId, input.ref.sourceUpdateId);
  if (!upload || !extraction || !confirmation || upload.chatId !== input.chatId || upload.clientId !== input.clientId ||
      extraction.sourceSha256 !== upload.blob.sha256 || confirmation.confirmationUpdateId !== input.ref.confirmationUpdateId ||
      confirmation.requestId !== input.requestId || confirmation.copy !== input.copy || confirmation.copySha256 !== sourceHash(input.copy))
    throw new SourceConflict('Reviewed copy differs from its saved source or confirmation');
  if (sourceHash(confirmation.sourceJson) !== confirmation.payloadHash)
    throw new SourceConflict('The exact confirmation source differs from its recorded hash');
  const client = await trx.selectFrom('clients').select('id').where('tenant_id', '=', input.tenantId)
    .where('id', '=', input.clientId).where('status', '=', 'active').forShare().executeTakeFirst();
  if (!client) throw new SourceConflict('The source client is no longer active');
  if (upload.kind === 'pdf') {
    const document = (await sql<DocumentRow>`SELECT * FROM hawa.client_documents WHERE tenant_id=${input.tenantId}::uuid
      AND client_id=${input.clientId}::uuid AND id=${extraction.documentId}::uuid`.execute(trx)).rows[0];
    if (!document || document.source_sha256 !== upload.blob.sha256 || document.extraction_sha256 !== extraction.extractionSha256)
      throw new SourceConflict('The original extraction receipt is unavailable');
  }
  if (!store) throw new Error('SOURCE_STORE_UNAVAILABLE');
  let bytes: Buffer;
  try { bytes = await store.read(upload.blob, { verify: true }); } catch { throw new Error('SOURCE_BYTES_UNAVAILABLE'); }
  if (upload.kind === 'voice') {
    const inspected = inspectVoiceAudio(bytes);
    if (!extraction.voice || voiceInspectionHash(upload.blob.sha256, inspected) !== extraction.extractionSha256 ||
        voiceInspectionHash(upload.blob.sha256, extraction.voice) !== extraction.extractionSha256)
      throw new SourceConflict('The original audio inspection receipt is unavailable');
  }
  return { upload, confirmation, evidence: {
    kind: upload.kind, sourceSha256: upload.blob.sha256, extractionSha256: extraction.extractionSha256,
    sourceUpdateId: upload.updateId, confirmationUpdateId: confirmation.confirmationUpdateId,
    confirmedBy: `telegram:${upload.senderId}`, confirmation: 'request_copy_reviewed',
    copySha256: confirmation.copySha256, clientId: upload.clientId,
    documentId: extraction.documentId, extractorVersion: extraction.extractorVersion,
  } };
}

export const voiceInspectionHash = (sha256: string, audio: VoiceAudioInspection) =>
  sourceHash(JSON.stringify([sha256, audio.version, audio.mediaType, audio.channels,
    audio.durationSeconds, audio.encodedSamples, audio.sampleRate]));
