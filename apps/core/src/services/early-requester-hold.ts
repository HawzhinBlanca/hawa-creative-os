import { sql, type Database, type Kysely } from '@hawa/db';
import { activeChatRequests } from './requester-turn-store.js';
import { pauseRequesterDesign } from './requester-hold.js';
import { briefAnchorFor, lockBriefAnchor, parseBriefAnchor, type BriefAnchor } from './lifecycle-brief-anchor.js';
import { escapeTelegramHtml } from '@hawa/integrations';
import { officeChatsFor } from './office-chats.js';
import { officeReviewUrl } from './desk-review-link.js';

export class EarlyHoldConflict extends Error {}
export interface EarlyHold {
  updateId: number; anchor: BriefAnchor; text: string; answer: string; payloadHash: string;
  officeAlerts?:Array<{chatId:string;text:string}>;
}
const ACCOUNT = 'lifecycle_brief_hold';

function parsed(row: { source_event_id: string; payload: Record<string, unknown>; payload_hash: string }): EarlyHold {
  const anchor = parseBriefAnchor(row.payload.anchor);
  if (!anchor || typeof row.payload.text !== 'string' || !row.payload.text.trim() ||
      typeof row.payload.answer !== 'string' || !row.payload.answer) throw new Error('Invalid stored early hold');
  const alerts=row.payload.officeAlerts;
  if (alerts!==undefined && (!Array.isArray(alerts) || alerts.some(a=>!a || typeof a.chatId!=='string' || typeof a.text!=='string')))
    throw new Error('Invalid stored early hold alerts');
  return { updateId: Number(row.source_event_id), anchor, text: row.payload.text, answer: row.payload.answer, payloadHash: row.payload_hash,
    ...(alerts ? {officeAlerts:alerts as EarlyHold['officeAlerts']} : {}) };
}

export async function earlyHoldsFor(trx: Kysely<Database>, tenantId: string, anchor: BriefAnchor): Promise<EarlyHold[]> {
  const rows = (await sql<{ source_event_id: string; payload: Record<string, unknown>; payload_hash: string }>`SELECT source_event_id,payload,payload_hash
    FROM hawa.inbox_events WHERE tenant_id=${tenantId}::uuid AND source_account_id=${ACCOUNT}
      AND payload->'anchor'->>'updateId'=${String(anchor.updateId)}
    ORDER BY received_at,id`.execute(trx)).rows;
  return rows.map(parsed);
}

/** Caller has rule-verified a clear hold and sender admission; never ask a model to authorize it. */
export async function acceptEarlyHold(trx: Kysely<Database>, tenantId: string, input: {
  update: { update_id: number; [key: string]: unknown }; text: string; answer: string; payloadHash: string; isHold: boolean;
}): Promise<EarlyHold | null> {
  const prior = (await sql<{ source_event_id: string; payload: Record<string, unknown>; payload_hash: string }>`SELECT source_event_id,payload,payload_hash
    FROM hawa.inbox_events WHERE tenant_id=${tenantId}::uuid AND source_account_id=${ACCOUNT}
      AND source_event_id=${String(input.update.update_id)}`.execute(trx)).rows[0];
  if (prior) {
    if (prior.payload_hash !== input.payloadHash) throw new EarlyHoldConflict('Changed early-hold replay');
    return parsed(prior); // An accepted old hold never pauses the resumed task again.
  }
  if (!input.isHold) return null;
  const sender = await briefAnchorFor(trx, tenantId, input.update);
  if (!sender) return null;
  const msg = input.update.message as { reply_to_message?: { message_id?: unknown; from?: { id?: unknown; is_bot?: boolean } } };
  const reply = msg.reply_to_message;
  // A bot or foreign reply retains the normal request binding/ambiguity rules.
  if (reply && (reply.from?.is_bot || String(reply.from?.id ?? '') !== sender.senderId)) return null;
  const rows = (await sql<{ payload: Record<string, unknown>; source_event_id: string; kind: string }>`
    SELECT h.payload,h.source_event_id,'held' AS kind FROM hawa.inbox_events h
    WHERE h.tenant_id=${tenantId}::uuid AND h.source_account_id='lifecycle_brief_held'
      AND h.payload->>'chatId'=${sender.chatId} AND h.payload->>'senderId'=${sender.senderId}
      AND coalesce(h.payload->>'topic','')=${sender.topic} AND h.received_at>now()-interval '10 minutes'
      AND NOT EXISTS (SELECT 1 FROM hawa.inbox_events d JOIN hawa.requests r ON r.tenant_id=d.tenant_id
        AND r.request_id::text=d.payload->>'requestId' WHERE d.tenant_id=h.tenant_id AND d.source_account_id='lifecycle_chat_open'
        AND d.payload->'briefAnchor'->>'updateId'=h.source_event_id)
    UNION ALL SELECT d.payload,d.source_event_id,'decided' AS kind FROM hawa.inbox_events d
    WHERE d.tenant_id=${tenantId}::uuid AND d.source_account_id='lifecycle_chat_open'
      AND d.payload->'briefAnchor'->>'chatId'=${sender.chatId} AND d.payload->'briefAnchor'->>'senderId'=${sender.senderId}
      AND d.payload->'briefAnchor'->>'topic'=${sender.topic} AND d.received_at>now()-interval '10 minutes'
      AND NOT EXISTS (SELECT 1 FROM hawa.requests r WHERE r.tenant_id=d.tenant_id AND r.request_id::text=d.payload->>'requestId')
    LIMIT 21`.execute(trx)).rows;
  if (rows.length > 20) return null;
  const candidates = new Map<number, BriefAnchor>();
  for (const row of rows) {
    const anchor = row.kind === 'held' ? await briefAnchorFor(trx, tenantId,
      row.payload.update as Parameters<typeof briefAnchorFor>[2]) : parseBriefAnchor(row.payload.briefAnchor);
    if (anchor && (!reply || String(reply.message_id) === anchor.messageId)) candidates.set(anchor.updateId, anchor);
  }
  if (candidates.size !== 1) return null;
  const anchor = [...candidates.values()][0];
  // Without an explicit own-brief reply, an existing own/unknown-owner design is another possible target.
  if (!reply && (await activeChatRequests(trx, tenantId, sender.chatId))
    .some(r=>!r.requesterId || r.requesterId===sender.senderId)) return null;
  await lockBriefAnchor(trx, tenantId, anchor);
  // If projection won the lock, pause its current task before acknowledging the early hold.
  const requests = (await sql<{ request_id: string; task_id: string; rev: number; stage: string }>`
    SELECT r.request_id::text,r.current_task_id::text AS task_id,r.rev::integer,r.stage
    FROM hawa.requests r JOIN hawa.inbox_events d ON d.tenant_id=r.tenant_id AND d.source_account_id='lifecycle_chat_open'
      AND (d.payload->>'requestId'=r.request_id::text OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(d.payload->'siblings','[]'::jsonb)) s
        WHERE s->>'requestId'=r.request_id::text))
    WHERE r.tenant_id=${tenantId}::uuid AND d.payload->'briefAnchor'->>'updateId'=${String(anchor.updateId)}`.execute(trx)).rows;
  if (requests.some(r=>r.stage!=='designing' && !(r.stage==='manual' && r.rev===1))) return null;
  for (const r of requests) {
    if (!await pauseRequesterDesign(trx, tenantId, { requestId:r.request_id,taskId:r.task_id,requestRev:r.rev,
      requestStage:r.stage as 'designing'|'manual',text:input.text }, input.update.update_id,true)) throw new EarlyHoldConflict('Early hold target advanced');
  }
  const officeAlerts=requests.flatMap(r=>officeChatsFor(sender.chatId).map(chatId=>({chatId,
    text:`The requester asked to hold the design. New design work is paused; an already admitted call may finish. Read their words before resuming in the Desk.\n\n${escapeTelegramHtml(input.text.slice(0,1500))}${input.text.length>1500 ? '\n[Message shortened here; the full words are retained in the chat and hold receipt.]' : ''}${officeReviewUrl({taskId:r.task_id}) ? `\n\n${officeReviewUrl({taskId:r.task_id})}` : ''}`})));
  await sql`INSERT INTO hawa.inbox_events(tenant_id,source_account_id,source_event_id,event_kind,payload,payload_hash,verified)
    VALUES (${tenantId}::uuid,${ACCOUNT},${String(input.update.update_id)},${ACCOUNT},
      ${JSON.stringify({anchor,text:input.text,answer:input.answer,...(officeAlerts.length ? {officeAlerts} : {})})}::jsonb,${input.payloadHash},true) ON CONFLICT DO NOTHING`.execute(trx);
  const stored = (await earlyHoldsFor(trx, tenantId, anchor)).find(h=>h.updateId===input.update.update_id);
  if (!stored || stored.payloadHash!==input.payloadHash) throw new EarlyHoldConflict('Early hold receipt conflict');
  return stored;
}
