import { sql, type Database, type Kysely } from '@hawa/db';
import type { ChatIntake } from './chat-intake.js';
import { parseDeliverableEvidence } from './request-deliverable-evidence.js';

/** Core-owned identity of the original brief, never supplied as workflow policy by a model. */
export interface BriefAnchor {
  updateId: number; chatId: string; senderId: string; topic: string; messageId: string;
}

export function parseBriefAnchor(value: unknown): BriefAnchor | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as BriefAnchor;
  return Number.isSafeInteger(a.updateId) && a.updateId > 0 && typeof a.chatId==='string' && /^-?\d{1,20}$/.test(a.chatId) &&
    typeof a.senderId==='string' && /^\d{1,20}$/.test(a.senderId) && typeof a.topic === 'string' && /^(?:\d{1,20})?$/.test(a.topic) &&
    typeof a.messageId==='string' && /^\d{1,20}$/.test(a.messageId) ? a : null;
}

export async function briefAnchorFor(trx: Kysely<Database>, tenantId: string,
  update: { update_id: number; [key: string]: unknown }): Promise<BriefAnchor | null> {
  // The album may have consumed words from an earlier held text update.
  const consumed = (await sql<{ source_event_id: string; payload: Record<string, unknown> }>`SELECT h.source_event_id,h.payload
    FROM hawa.inbox_events c JOIN hawa.inbox_events h ON h.tenant_id=c.tenant_id
      AND h.source_account_id='lifecycle_brief_held' AND h.source_event_id=c.source_event_id
    WHERE c.tenant_id=${tenantId}::uuid AND c.source_account_id='lifecycle_brief_consumed'
      AND c.payload->>'updateId'=${String(update.update_id)} LIMIT 1`.execute(trx)).rows[0];
  const source = consumed ? consumed.payload.update : update;
  const msg = (source as { message?: { message_id?: unknown; chat?: { id?: unknown }; from?: { id?: unknown; is_bot?: boolean }; message_thread_id?: unknown } })?.message;
  if (!msg || msg.from?.is_bot || !Number.isSafeInteger(msg.from?.id)) return null;
  return parseBriefAnchor({ updateId: consumed ? Number(consumed.source_event_id) : update.update_id,
    chatId: String(msg.chat?.id ?? ''), senderId: String(msg.from?.id ?? ''),
    topic: msg.message_thread_id === undefined ? '' : String(msg.message_thread_id), messageId: String(msg.message_id ?? '') });
}

export async function lockBriefAnchor(trx: Kysely<Database>, tenantId: string, anchor: BriefAnchor): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`brief-hold:${tenantId}:${anchor.updateId}`},0))`.execute(trx);
}

/** Primary and language siblings are bound to the same reviewed Core decision. */
export async function anchoredDecisionFor(trx: Kysely<Database>, tenantId: string, requestId: string):
  Promise<{ anchor?: BriefAnchor; draft: ChatIntake;sourceUpdate?:unknown;detailsRequired:boolean } | null> {
  const row = (await sql<{ payload: { requestId: string; draft: ChatIntake; briefAnchor?: unknown;
    sourceUpdate?:unknown;deliverableCount?:unknown;deliverableDetailsRequired?:unknown;
    siblings?: Array<{ requestId: string; draft: ChatIntake }> } }>`SELECT payload FROM hawa.inbox_events
    WHERE tenant_id=${tenantId}::uuid AND source_account_id='lifecycle_chat_open'
      AND (payload->>'requestId'=${requestId} OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(payload->'siblings','[]'::jsonb)) s
        WHERE s->>'requestId'=${requestId})) LIMIT 1`.execute(trx)).rows[0];
  if (!row || (!row.payload.briefAnchor && !row.payload.deliverableCount)) return null; // Older decisions retain their replay contract.
  const anchor = row.payload.briefAnchor===undefined ? undefined : parseBriefAnchor(row.payload.briefAnchor);
  const draft = row.payload.requestId === requestId ? row.payload.draft : row.payload.siblings?.find(s=>s.requestId===requestId)?.draft;
  if (anchor===null || !draft) throw new Error('Invalid Core brief anchor');
  const evidence=parseDeliverableEvidence(row.payload);
  return { ...(anchor ? {anchor} : {}), draft,sourceUpdate:row.payload.sourceUpdate,
    detailsRequired:evidence.deliverableDetailsRequired?.includes(requestId) ?? false };
}
