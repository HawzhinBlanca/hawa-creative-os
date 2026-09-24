/**
 * What Core and the worker exchange for a delivery run by Restate (architecture programme Phase 2,
 * slice 2.2; PHASE2_DESIGN.md sections 2.5 and 2.6, ADR-034): the Delivery workflow's input and
 * outcome, what Core's prepare step answers, and the messages the TelegramSender object sends.
 *
 * Every payload a Restate handler takes carries `v: 1`. Fields are only ever added, and only as
 * optional ones: a delayed or retried invocation may reach a build newer or older than the one that
 * wrote it (PHASE2_DESIGN.md section 4, rule 1).
 */

/**
 * Whether a chat's requests are delivered by the Delivery workflow, from HAWA_LIFECYCLE_CHATS: a
 * comma-separated list of Telegram chat ids, or `*` for every chat. Unset or empty enrols nobody, so
 * nothing changes until the owner sets it. Parsed like DESIGN_PIPELINE_V3_CHATS (isV3PilotChat in
 * apps/core/src/services/chat-intake.ts). A task with no chat (made in the Desk) is never enrolled.
 */
export function lifecycleOwnsChat(chatId: string | number | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HAWA_LIFECYCLE_CHATS;
  if (!raw || chatId === null || chatId === undefined) return false;
  const chat = String(chatId).trim();
  if (!chat) return false;
  const listed = raw.split(',').map((c) => c.trim()).filter(Boolean);
  return listed.includes('*') || listed.includes(chat);
}

/** A stored export the sender reads itself: bytes never travel through Restate's journal. */
export interface ExportRef {
  tenantId: string;
  taskId: string;
  artifactId: string;
  sha256: string;
}

/** One message for TelegramSender (a Virtual Object keyed by chat id). */
export interface OutboundMessage {
  v: 1;
  /** Deterministic: the same logical message always has the same key (PHASE2_DESIGN.md 2.9). */
  key: string;
  chatId: string;
  kind: 'text' | 'document';
  text?: string;
  parseMode?: 'HTML';
  exportRef?: ExportRef;
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
}

export type SendResult =
  | { outcome: 'sent'; messageId?: string }
  | { outcome: 'uncertain'; error: string }
  | { outcome: 'refused'; error: string };

/** The Delivery workflow's input. Its key is `deliveryId`. */
export interface DeliveryInput {
  v: 1;
  /** The request the delivery belongs to. Until RequestLifecycle exists (slice 2.3) it is the task id. */
  requestId: string;
  deliveryId: string;
  tenantId: string;
  taskId: string;
  approvalId: string;
  revisionId: string;
  chatId: string | null;
  officeChatId: string | null;
  /** 'core' in slice 2.2: the outcome is posted to Core's delivery-finished endpoint. */
  reportTo: 'lifecycle' | 'core';
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
