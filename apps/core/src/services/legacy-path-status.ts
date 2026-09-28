/**
 * What is still on the old Telegram path, read without SQL on production (ADR-135): the Desk or an
 * administrator's session reads GET /v1/operations/legacy-path. Stage 2 of the retirement, which
 * deletes the code that finishes legacy requests, may merge only when `stage2Ready` is true
 * (plans/lean-design-implementation-2026-09-28/LEGACY_PATH_RETIREMENT.md).
 *
 * A legacy Telegram task is one created from a Telegram chat (its task.created event names
 * sourcePlatform 'telegram') that RequestLifecycle does not own (tasks.request_id is null), whichever
 * executor it is pinned to. Desk, webhook and WhatsApp tasks are never counted: they stay.
 */
import { sql, type Database, type Kysely } from '@hawa/db';

/** Task states that end a task (packages/contracts/src/task-status.ts, TERMINAL_TASK_STATUSES). */
const TERMINAL = ['complete', 'rejected', 'cancelled'] as const;

export interface LegacyPathStatus {
  openTasks: {
    total: number;
    byState: Record<string, number>;
    byPin: Record<string, number>;
    /** Telegram chats with at least one open legacy task. */
    chats: number;
    oldestUpdatedAt: string | null;
    /** The 50 least recently updated, to finish, reject or cancel in the Desk. */
    items: Array<{ id: string; state: string; pin: string; createdAt: string; updatedAt: string }>;
  };
  /** notify.published commands (Core's requester-file sends) still pending or leased. */
  pendingRequesterSends: number;
  /** notify.published commands that ended failed: after stage 2 nothing can redrive them. */
  failedRequesterSends: number;
  /** Non-lifecycle publications whose Delivery workflow (reportTo 'core') has a run in flight. */
  legacyWorkflowDeliveriesRunning: number;
  /** The newest legacy Telegram task: after stage 1 is deployed no newer one should appear. */
  newestLegacyTaskCreatedAt: string | null;
  stage2Ready: boolean;
}

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

export async function readLegacyPathStatus(trx: Kysely<Database>, tenantId: string): Promise<LegacyPathStatus> {
  const legacy = sql`SELECT t.id, t.state::text AS state, t.delivery_executor_pin AS pin,
      o.payload->>'sourceChannelId' AS chat, t.created_at, t.updated_at
    FROM hawa.tasks t
    JOIN hawa.outbox_commands o ON o.tenant_id = t.tenant_id AND o.aggregate_id = t.id
      AND o.command_type = 'task.created'
    WHERE t.tenant_id = ${tenantId}::uuid AND t.request_id IS NULL AND t.deleted_at IS NULL
      AND o.payload->>'sourcePlatform' = 'telegram'`;
  const open = sql`SELECT * FROM (${legacy}) l WHERE l.state NOT IN (${sql.join(TERMINAL.map((s) => sql`${s}`))})`;
  const byState = (await sql<{ state: string; n: string }>`SELECT state, count(*) AS n FROM (${open}) x GROUP BY state`.execute(trx)).rows;
  const byPin = (await sql<{ pin: string; n: string }>`SELECT pin, count(*) AS n FROM (${open}) x GROUP BY pin`.execute(trx)).rows;
  const summary = (await sql<{ total: string; chats: string; oldest: Date | null }>`SELECT count(*) AS total,
      count(DISTINCT chat) AS chats, min(updated_at) AS oldest FROM (${open}) x`.execute(trx)).rows[0];
  const items = (await sql<{ id: string; state: string; pin: string; created_at: Date; updated_at: Date }>`SELECT id, state, pin,
      created_at, updated_at FROM (${open}) x ORDER BY updated_at, id LIMIT 50`.execute(trx)).rows;
  const newest = (await sql<{ at: Date | null }>`SELECT max(created_at) AS at FROM (${legacy}) x`.execute(trx)).rows[0];
  const sends = (await sql<{ pending: string; failed: string }>`SELECT
      count(*) FILTER (WHERE state IN ('pending', 'leased')) AS pending,
      count(*) FILTER (WHERE state = 'failed') AS failed
    FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid AND command_type = 'notify.published'`.execute(trx)).rows[0];
  const running = (await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.publications p
    JOIN hawa.tasks t ON t.tenant_id = p.tenant_id AND t.id = p.task_id
    WHERE p.tenant_id = ${tenantId}::uuid AND t.request_id IS NULL AND p.executor = 'restate'
      AND p.executor_run > p.executor_finished_run`.execute(trx)).rows[0];

  const total = Number(summary?.total ?? 0);
  const pendingRequesterSends = Number(sends?.pending ?? 0);
  const legacyWorkflowDeliveriesRunning = Number(running?.n ?? 0);
  return {
    openTasks: {
      total,
      byState: Object.fromEntries(byState.map((r) => [r.state, Number(r.n)])),
      byPin: Object.fromEntries(byPin.map((r) => [r.pin, Number(r.n)])),
      chats: Number(summary?.chats ?? 0),
      oldestUpdatedAt: summary?.oldest ? iso(summary.oldest) : null,
      items: items.map((r) => ({ id: r.id, state: r.state, pin: r.pin, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) })),
    },
    pendingRequesterSends,
    failedRequesterSends: Number(sends?.failed ?? 0),
    legacyWorkflowDeliveriesRunning,
    newestLegacyTaskCreatedAt: newest?.at ? iso(newest.at) : null,
    stage2Ready: total === 0 && pendingRequesterSends === 0 && legacyWorkflowDeliveriesRunning === 0,
  };
}
