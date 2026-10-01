/**
 * ADR-155 addendum (owner report, 2026-09-30): the office's "design ready" alert carries the draft.
 *
 * It was one line of text with the task's UUID and, only when the Desk had a public https address, a
 * review link. Production runs the Desk at http://127.0.0.1:8080 (trusted_office), so the link was
 * always dropped and an office member on a phone could not see the design at all. The alert now names
 * the design, who it is for and where to edit it in Canva (an https address that works on any device
 * signed in to the Canva account), and it goes as a photo of the draft: the retrieved Canva PNG export,
 * or the Studio winner's preview when no export is there. The worker reads the bytes by reference and
 * checks their hash, as Delivery does, so no picture travels through Restate's journal.
 *
 * The requester is not sent the draft: they see it once the office approves it (ADR-022).
 */
import type { DraftImageRef } from '@hawa/contracts';
import { sql, type Database, type Kysely } from '@hawa/db';
import { OFFICE_MESSAGES, say } from '@hawa/integrations';
import { cleanDraftTitle } from './draft-title.js';

const SHA256 = /^[0-9a-f]{64}$/;

export const canvaEditUrl = (designId: string) => `https://www.canva.com/design/${designId}/edit`;

/**
 * The picture of a task's draft: the newest retrieved PNG export of the design bound to the task (at
 * the binding's current version, as bridgeCanvaDraftRevision reads the deck), else the newest Studio
 * winner preview of the task. Undefined when there is neither: the alert is then sent as text.
 */
export async function findDraftImage(trx: Kysely<Database>, input: { tenantId: string; taskId: string; designId: string }): Promise<DraftImageRef | undefined> {
  const { tenantId, taskId, designId } = input;
  const exported = (await sql<{ id: string; sha256: string }>`SELECT b.id, b.sha256 FROM hawa.canva_export_bytes b
    JOIN hawa.canva_remote_operations o ON o.id = b.operation_id AND o.tenant_id = b.tenant_id AND o.status = 'retrieved'
    JOIN hawa.canva_bindings g ON g.tenant_id = b.tenant_id AND g.task_id = b.task_id AND g.status = 'bound'
      AND g.canva_design_id = o.design_id AND g.version = o.binding_version
    WHERE b.tenant_id = ${tenantId}::uuid AND b.task_id = ${taskId}::uuid AND b.format = 'png'
      AND o.design_id = ${designId}
    ORDER BY b.created_at DESC LIMIT 1`.execute(trx)).rows[0];
  if (exported && SHA256.test(exported.sha256)) {
    return { source: 'canva_export', tenantId, taskId, id: exported.id, sha256: exported.sha256 };
  }
  const preview = (await sql<{ id: string; sha256: string }>`SELECT c.id, c.preview_sha256 AS sha256
    FROM hawa.design_studio_candidates c
    JOIN hawa.design_studio_runs r ON r.id = c.run_id AND r.tenant_id = c.tenant_id
    WHERE r.tenant_id = ${tenantId}::uuid AND r.task_id = ${taskId}::uuid AND c.status = 'winner'
      AND c.preview_sha256 IS NOT NULL
    ORDER BY c.created_at DESC LIMIT 1`.execute(trx)).rows[0];
  if (preview && SHA256.test(preview.sha256)) {
    return { source: 'studio_preview', tenantId, taskId, id: preview.id, sha256: preview.sha256 };
  }
  return undefined;
}

export interface OfficeDraftAlertInput {
  /** The design by the name the requester knows it (the request's first task). */
  title: string;
  /** The request's stored copy: names a draft titled from the line that introduced it (ADR-142). */
  copy?: unknown;
  clientName?: string;
  requestedBy?: string;
  /** A later round: the design changed at the requester's or the office's request. */
  revised?: boolean;
  canvaUrl?: string;
  /** The Desk's review link, only when it is a public https address (officeReviewUrl). */
  reviewUrl?: string;
  /** The outcome, when the draft came with a failed automatic check (a copy or font mismatch). */
  check?: string;
  /**
   * ADR-180: the words go with the draft's picture, and office members may decide on it in Telegram
   * (ADR-040 addendum): the caption says to reply to the picture. The text alert, sent without the
   * picture (or by a worker from before), keeps pointing to Hawa Desk: approving in Telegram needs the
   * picture that member was sent.
   */
  telegramDecision?: boolean;
}

/**
 * The alert's words, plain text (a photo caption, and the message sent instead when the picture
 * cannot be): no internal IDs. With no public Desk address it says where the approval happens rather
 * than giving a link that only works on the office computer.
 */
export function composeOfficeDraftAlert(input: OfficeDraftAlertInput): string {
  // "KAAE: KAAE K-12 Pilot Study…" was titled before ADR-180: the client is not named twice, and a
  // title made from "Here is the text and the photos:" is named by its copy (ADR-040 addendum, 2026-10-01).
  const title = cleanDraftTitle(input.title, input.copy) || 'Untitled design';
  const who = [input.clientName?.trim() ? `For ${input.clientName.trim()}` : '',
    input.requestedBy?.trim() && !title.startsWith(`${input.requestedBy.trim()}:`) ? `requested by ${input.requestedBy.trim()}` : '']
    .filter(Boolean).join(', ');
  return [
    `${input.revised ? 'A revised draft' : 'A new draft'} is ready for office review: "${title}"`,
    who ? `${who.charAt(0).toUpperCase()}${who.slice(1)}.` : '',
    input.check ? `The automatic check reported ${input.check}: look closely before approving.` : '',
    input.canvaUrl ? `Edit in Canva: ${input.canvaUrl}` : '',
    input.telegramDecision
      ? say(OFFICE_MESSAGES.draftAlertDecide, 'en', { requester: input.requestedBy?.trim() || say(OFFICE_MESSAGES.theRequester, 'en') }) +
        `\n${say(OFFICE_MESSAGES.draftAlertDecide, 'ckb', { requester: input.requestedBy?.trim() || say(OFFICE_MESSAGES.theRequester, 'ckb') })}` +
        (input.reviewUrl ? `\nHawa Desk (office sign-in required): ${input.reviewUrl}` : '')
      : input.reviewUrl
        ? `Approve or send it back in Hawa Desk (office sign-in required): ${input.reviewUrl}`
        : 'Approve or send it back in Hawa Desk on the office computer.',
  ].filter(Boolean).join('\n');
}
