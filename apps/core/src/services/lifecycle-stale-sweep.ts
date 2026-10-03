/**
 * Requests that have waited too long for a person (ADR-155). A request-owned request stops at stages
 * only a person moves on: the office reviews a draft (in_review), sends an approved design
 * (approved), takes over a design that ended without a draft (manual, its task failed_operator), or the
 * requester answers a question (awaiting_answer, after both reminders). Each stage alerted the office
 * once, at most, when it began, and a second office member never heard at all; a request could then
 * sit for days with nothing said (2026-09-30 audit). This sweep, run every quarter hour beside the
 * Canva sweeper, alerts every office member once per request per stage entry: the outbox key names the
 * request and its revision, which changes on every transition, so the same wait is never alerted twice
 * and a later wait at another stage is.
 *
 * ADR-288: a draft waiting in office review has one reminder, the approval target alert in working hours
 * (approval-sla.ts). The in_review stage here runs only when that alert is switched off.
 */
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { officeReviewUrl } from './desk-review-link.js';
import { approvalSlaConfig } from './approval-sla.js';

const HOUR_MS = 60 * 60_000;

/** How long each stage may wait before the office hears of it. */
export const STALE_AFTER_MS = {
  /**
   * A draft waiting for its office review. The office is alerted when the draft is ready; this is the one
   * reminder. It was a working day (24 h) until 2026-10-02: the only delivered design waited 15 h overnight
   * for approval while its draft took 2 minutes.
   */
  in_review: 2 * HOUR_MS,
  /** Approved and not sent: the requester waits for a design the office has already accepted. */
  approved: 4 * HOUR_MS,
  /** A delivery that has not reported: the Delivery workflow takes minutes. */
  delivering: 2 * HOUR_MS,
  /**
   * A request for a designer (or a design that ended without a draft). Since 2026-10-02 the office is
   * alerted when it opens; this reminder follows after a working morning, not a day.
   */
  manual: 8 * HOUR_MS,
  /** The requester's question: reminded on days 1 and 5, then the office hears of it on day 6. */
  awaiting_answer: 6 * 24 * HOUR_MS,
} as const;

export type StaleStage = keyof typeof STALE_AFTER_MS;

/** A request waiting longer than this is old news to the office: never alerted on the first sweep. */
export const STALE_HORIZON_MS = 14 * 24 * HOUR_MS;
/** At most this many requests are alerted per sweep; the rest wait for the next one. */
export const STALE_ALERTS_PER_SWEEP = 5;

export interface StaleRequest {
  requestId: string; taskId: string; stage: StaleStage; rev: number; waitingSinceMs: number;
}

const WHAT: Record<StaleStage, string> = {
  in_review: 'has waited for its office review',
  approved: 'is approved but has not been sent to the requester',
  delivering: 'has been sending to the requester without finishing',
  manual: 'ended without a draft and has waited for an operator',
  awaiting_answer: "has waited for the requester's answer to its question",
};

const waited = (ms: number) => {
  const hours = Math.floor(ms / HOUR_MS);
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`;
};

/** The office's words for one waiting request (English, like every office alert). */
export function staleAlertText(request: StaleRequest, nowMs: number): string {
  const reviewUrl = officeReviewUrl({ taskId: request.taskId });
  return `A request ${WHAT[request.stage]} for ${waited(nowMs - request.waitingSinceMs)}. Task ${request.taskId}.` +
    (reviewUrl ? `\nOpen it in Hawa Desk (office sign-in required): ${reviewUrl}` : '');
}

const baseKey = (request: Pick<StaleRequest, 'requestId' | 'rev'>) => `notify.office:lifecycle-stale:${request.requestId}:${request.rev}`;

/**
 * One pass: the requests waiting past their stage's threshold (within the horizon) that no earlier
 * pass alerted, oldest first, each alerted to every office member through the outbox. Returns what it
 * alerted. Without office members nothing is written: there is nobody to tell.
 */
export async function sweepStaleLifecycleRequests(db: Kysely<Database>, options: {
  tenantId: string; officeChatIds: readonly string[]; nowMs: number; limit?: number;
  /**
   * Whether this sweep reminds about drafts waiting in office review. ADR-288: the approval target alert
   * (approval-sla.ts) is the one reminder for that wait, so this stage runs only while that alert is
   * switched off (HAWA_APPROVAL_SLA_ENABLED=off): one reminder per waiting draft, and never none.
   */
  inReview?: boolean;
}): Promise<StaleRequest[]> {
  const members = [...new Set(options.officeChatIds.map((c) => c.trim()).filter(Boolean))];
  if (!members.length) return [];
  const inReview = options.inReview ?? !approvalSlaConfig().enabled;
  const now = new Date(options.nowMs);
  const horizon = new Date(options.nowMs - STALE_HORIZON_MS);
  const due = (stage: StaleStage) => new Date(options.nowMs - STALE_AFTER_MS[stage]);
  return withRlsContext(db, { tenantId: options.tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
    const rows = (await sql<{ request_id: string; current_task_id: string; stage: StaleStage; rev: string; since: Date }>`
      SELECT r.request_id, r.current_task_id, r.stage, r.rev,
             CASE WHEN r.stage = 'awaiting_answer' THEN coalesce(r.question_asked_at, r.updated_at) ELSE r.updated_at END AS since
        FROM hawa.requests r
        JOIN hawa.tasks t ON t.tenant_id = r.tenant_id AND t.id = r.current_task_id
       WHERE r.tenant_id = ${options.tenantId}::uuid AND r.owner = 'restate'
         AND (
           (${inReview}::boolean AND r.stage = 'in_review' AND r.updated_at <= ${due('in_review')})
        OR (r.stage = 'approved' AND r.updated_at <= ${due('approved')})
        OR (r.stage = 'delivering' AND r.updated_at <= ${due('delivering')})
        OR (r.stage = 'manual' AND t.state = 'failed_operator' AND r.updated_at <= ${due('manual')})
        OR (r.stage = 'awaiting_answer' AND coalesce(r.question_asked_at, r.updated_at) <= ${due('awaiting_answer')})
         )
         AND (CASE WHEN r.stage = 'awaiting_answer' THEN coalesce(r.question_asked_at, r.updated_at) ELSE r.updated_at END) >= ${horizon}
         AND NOT EXISTS (
           SELECT 1 FROM hawa.outbox_commands o
            WHERE o.tenant_id = r.tenant_id
              AND o.idempotency_key = 'notify.office:lifecycle-stale:' || r.request_id::text || ':' || r.rev::text)
       ORDER BY since ASC
       LIMIT ${Math.max(1, options.limit ?? STALE_ALERTS_PER_SWEEP)}`.execute(trx)).rows;
    const alerted: StaleRequest[] = [];
    for (const row of rows) {
      const request: StaleRequest = { requestId: row.request_id, taskId: row.current_task_id, stage: row.stage,
        rev: Number(row.rev), waitingSinceMs: new Date(row.since).getTime() };
      const text = staleAlertText(request, now.getTime());
      for (const [index, chatId] of members.entries()) {
        // The first member's key is the one the query looks for; the others name their chat.
        const key = index === 0 ? baseKey(request) : `${baseKey(request)}:${chatId}`;
        await sql`INSERT INTO hawa.outbox_commands
            (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload, state, attempts, available_at)
          VALUES (${options.tenantId}::uuid, 'task', ${request.taskId}::uuid, 'notify.telegram', ${key},
            ${JSON.stringify({ chatId, taskId: request.taskId, message: { text } })}::jsonb, 'pending', 0, now())
          ON CONFLICT DO NOTHING`.execute(trx);
      }
      alerted.push(request);
    }
    return alerted;
  });
}
