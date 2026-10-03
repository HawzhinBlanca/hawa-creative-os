/** Only identities cross the durable-worker boundary; original files and extraction stay in Core. */
export interface LifecycleSourceRef { sourceUpdateId: number; confirmationUpdateId: number }
export function parseLifecycleSourceRef(value: unknown): LifecycleSourceRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ref = value as Record<string, unknown>;
  return Number.isSafeInteger(ref.sourceUpdateId) && Number(ref.sourceUpdateId) > 0 &&
    Number.isSafeInteger(ref.confirmationUpdateId) && Number(ref.confirmationUpdateId) > 0
    ? { sourceUpdateId: Number(ref.sourceUpdateId), confirmationUpdateId: Number(ref.confirmationUpdateId) } : null;
}
/**
 * A request's reviewed source (ADR-145): the original's stored bytes (`sourceSha256`), the immutable
 * extraction it was read from (`extractionSha256`, `documentId` for a PDF in hawa.client_documents), who
 * confirmed which exact words (`copySha256` is the sha256 of the request's raw text) and for which client.
 */
interface ReviewedSourceEvidenceCommon {
  kind: 'pdf' | 'voice'; sourceSha256: string; extractionSha256: string; confirmedBy: string;
  confirmation: 'request_copy_reviewed'; copySha256: string; clientId: string;
  documentId?: string; extractorVersion: string;
}
/** A Telegram PDF or voice note, confirmed in the chat (`confirmedBy` is `telegram:<sender id>`). */
export interface TelegramReviewedSourceEvidence extends ReviewedSourceEvidenceCommon {
  sourceUpdateId: number; confirmationUpdateId: number;
}
/**
 * ADR-287 addendum: a PDF the office retained in the Desk and reviewed there, confirmed by the signed-in
 * office member who saved the request (`confirmedBy` is `desk:<user id>`). Its page references are the
 * extraction's own: `pageCount` pages, each chunk of `documentId`'s extraction carrying its page number.
 */
export interface DeskReviewedSourceEvidence extends ReviewedSourceEvidenceCommon {
  kind: 'pdf'; origin: 'hawa_desk'; documentId: string; pageCount: number | null;
}
export type ReviewedSourceEvidence = TelegramReviewedSourceEvidence | DeskReviewedSourceEvidence;
