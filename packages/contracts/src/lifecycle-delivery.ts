/**
 * What Core and the worker exchange for a delivery run by Restate (architecture programme Phase 2,
 * slice 2.2; PHASE2_DESIGN.md sections 2.5 and 2.6, ADR-034): the Delivery workflow's input and
 * outcome, what Core's prepare step answers, and the messages the TelegramSender object sends.
 *
 * Every payload a Restate handler takes carries `v: 1`. Fields are only ever added, and only as
 * optional ones: a delayed or retried invocation may reach a build newer or older than the one that
 * wrote it (PHASE2_DESIGN.md section 4, rule 1).
 */

// Every Telegram chat is owned by RequestLifecycle (ADR-135). HAWA_LIFECYCLE_CHATS, which enrolled
// chats one by one, and lifecycleOwnsChat, which read it, are gone: no setting can send a new request
// down the old path. A task with no chat (made in the Desk) was never enrolled and still is not.
// Existing tasks keep their stored pin (ADR-052) when an operator presses Deliver.

/** A stored export the sender reads itself: bytes never travel through Restate's journal. */
export interface ExportRef {
  tenantId: string;
  taskId: string;
  artifactId: string;
  sha256: string;
}

/**
 * A draft picture for the office's "design ready" alert (ADR-155 addendum), read by the sender itself
 * and checked against its hash like an ExportRef: a retrieved Canva PNG export (hawa.canva_export_bytes
 * row `id`), or the Studio winner's preview (hawa.design_studio_candidates row `id`) when no export is
 * there yet.
 */
export interface DraftImageRef {
  source: 'canva_export' | 'studio_preview';
  tenantId: string;
  taskId: string;
  id: string;
  sha256: string;
}

/** One message for TelegramSender (a Virtual Object keyed by chat id). */
export interface OutboundMessage {
  v: 1;
  /** Deterministic: the same logical message always has the same key (PHASE2_DESIGN.md 2.9). */
  key: string;
  chatId: string;
  /**
   * photo (ADR-155 addendum): `imageRef` with `caption`, and `text` as the plain message sent instead
   * when the picture cannot be read or Telegram refuses it. A sender from before 'photo' existed sends
   * `text` alone, so the office still hears of it.
   */
  kind: 'text' | 'document' | 'photo';
  text?: string;
  parseMode?: 'HTML';
  exportRef?: ExportRef;
  imageRef?: DraftImageRef;
  filename?: string;
  caption?: string;
  mimeType?: string;
  /**
   * critical: fenced by send marks, never sent twice, and a send Telegram did not confirm is
   * reported to the office. courtesy: sent at most once per invocation, with no marks.
   */
  class: 'critical' | 'courtesy';
  /** The tenant the send marks are written under; the export's tenant, else the default one. */
  tenantId?: string;
  /** The task the message is about, named in the office's alert when it may not have arrived. */
  taskId?: string;
  /** Optional durable callback after a verified critical send mark, for request waitpoints. */
  onSent?: { kind: 'question'; requestId: string; requestRev: number;
    taskId: string; questionId: string };
  /**
   * ADR-240: an office alert about a canary request, moved to the canary chat; the office member it
   * would have reached. Only the canary chat's sender ever receives a message carrying it.
   */
  canaryFor?: string;
}

/**
 * canary_sink (ADR-240): the message was for the canary chat, or about a canary request, and was
 * recorded instead of sent. It never reached Telegram, so it never counts as a requester's receipt.
 */
export type SendResult =
  | { outcome: 'sent'; messageId?: string }
  | { outcome: 'uncertain'; error: string }
  | { outcome: 'refused'; error: string }
  | { outcome: 'canary_sink'; messageId: string }
  | { outcome: 'web_recorded'; receiptId: string };

/** The Delivery workflow's input. Its key is `deliveryId`. */
export interface DeliveryInput {
  v: 1;
  /** The request owner; legacy runs use the task id. */
  requestId: string;
  deliveryId: string;
  tenantId: string;
  taskId: string;
  approvalId: string;
  revisionId: string;
  chatId: string | null;
  officeChatId: string | null;
  /**
   * Reports through the private request owner. 'core' (a report to Core for a task RequestLifecycle
   * did not own) was removed by stage 2 of ADR-135; a journaled input carrying it is refused.
   */
  reportTo: 'lifecycle' | 'core';
  /** Request revision that claimed a lifecycle-owned publication; absent for legacy runs. */
  requestRev?: number;
  /** Core's domain-separated signature over the complete lifecycle-owned workflow claim. */
  claimSignature?: string;
  /** Which run of this publication's delivery this is (1 for the first; later ones retry the archive). */
  run?: number;
  /** The Desk's delivery policy ('deliver_approved_stored' delivers an approval a later edit invalidated). */
  policy?: string;
}

/**
 * How a delivery ended:
 * - delivered: the files and the notice reached the requester (Telegram confirmed each);
 * - chat_only: the requester got the files, the Drive archive was not written;
 * - uncertain: at least one file or the notice may not have arrived (the office was alerted);
 * - failed: nothing could be prepared, or Telegram refused the files.
 */
export interface DeliveryOutcome {
  outcome: 'delivered' | 'chat_only' | 'uncertain' | 'failed';
  /** What may not have arrived, by name (file names, 'delivery notice'). */
  uncertain: string[];
  sheetsConfirmed: boolean;
  /** Whether the approved files are verified in Drive. */
  archived: boolean;
  filesSent: number;
  reason?: string;
}

/** One delivered file, as Core names it (the same shape as the `notify.published` payload's). */
export interface PreparedDeliveryFile {
  artifactId: string;
  format?: string;
  filename: string;
  mimeType?: string;
  sha256: string;
  byteSize?: number;
  driveFileId?: string | null;
  webViewLink?: string | null;
}

/**
 * Core's answer to the prepare step: the Drive and Sheets work is done (or refused), and this is
 * what the requester is sent. `notice` is the data composeDeliveredMessage reads.
 */
export interface PreparedDelivery {
  ok: true;
  taskId: string;
  publicationKey: string;
  chatId: string | null;
  title: string | null;
  files: PreparedDeliveryFile[];
  /** The Drive archive could not be written; the files go to the chat all the same. */
  chatOnly: boolean;
  archived: boolean;
  sheetsConfirmed: boolean;
  notice: {
    title: string | null;
    files: PreparedDeliveryFile[];
    driveFolderId: string;
    spreadsheetId: string;
    sheetsConfirmed: boolean;
    sheetRowNumber: number | null;
    sheetProblem: string | null;
    archiveProblem?: string | null;
  };
}

/** The deterministic id of a publication's n-th Delivery run (n = 1 has no suffix). */
export function deliveryWorkflowId(taskId: string, approvalId: string, run = 1): string {
  return `dl-${taskId}-${approvalId}${run > 1 ? `:archive:${run}` : ''}`;
}

/** The part of a delivery id every run of one publication shares: files and the notice are keyed by it. */
export function deliveryBaseId(taskId: string, approvalId: string): string {
  return deliveryWorkflowId(taskId, approvalId, 1);
}
