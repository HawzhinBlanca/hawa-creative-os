import { CANARY_CHAT_ID_MAX, CANARY_CHAT_ID_MIN, CANARY_TEST_CLIENT_ID } from '@hawa/contracts';
import { sql, withRlsContext, type Kysely, type Database } from '@hawa/db';
import { log } from '../logging.js';

type Stage = 'briefToDraft' | 'draftToApproval' | 'approvalToDelivery';
interface StageTiming { samples: number; p50Hours: number | null; p95Hours: number | null }

/** Requests that ended before any draft existed, by who ended them (ADR-288). */
export interface CancelledBeforeDraft {
  total: number;
  /** The requester withdrew the request (Telegram cancel). */
  requesterWithdrew: number;
  /** The office cancelled it in the Desk. */
  officeCancelled: number;
  /** The system could not draft it: the design ended without a draft and waits for, or was closed by, a person. */
  systemFailed: number;
  /** Closed without a draft for another recorded reason (a rejected or expired request, an old-path cancel). */
  other: number;
}

/**
 * The owner's north-star numbers (ADR-288), over the last `days` days, canary requests excluded:
 * how many designs reached their requester, how many approvals needed no revision round, and how long
 * a request took from brief to delivery.
 */
export interface NorthStarMetrics {
  days: number;
  deliveredDesigns: number;
  approvals: number;
  approvedFirstDraft: number;
  /** approvedFirstDraft / approvals, or null with no approvals. */
  firstDraftApprovalRate: number | null;
  medianBriefToDeliveryHours: number | null;
  briefToDeliverySamples: number;
}

export interface FunnelHealthMetrics {
  windowHours: number;
  /** Requests opened in the window (one per request, every revision round included; canary excluded). */
  briefsCount: number | null;
  /** Requests whose first draft was made in the window. */
  draftsCount: number | null;
  /** Requests first approved in the window. */
  approvalsCount: number | null;
  /** Requests first delivered in the window. */
  deliveriesCount: number | null;
  /** Of the requests opened in the window: how many have a draft by now. */
  briefsDrafted?: number | null;
  /** Of the requests opened in the window: how many ended before a draft, and why. */
  cancelledBeforeDraft?: CancelledBeforeDraft | null;
  /** What was left out of every count: the nightly canary's requests. */
  excluded?: { canaryRequests: number } | null;
  northStar?: NorthStarMetrics | null;
  status: 'healthy' | 'idle' | 'in_progress' | 'stalled' | 'unknown';
  alert: string | null;
  oldestUnapprovedHours?: number | null;
  stalledTaskCount?: number | null;
  oldestStalledTaskId?: string | null;
  oldestStalledTaskHours?: number | null;
  stageDurations?: Record<Stage, StageTiming> | null;
  nextAction?: string | null;
  measuredAt: string;
}

/**
 * One request as the funnel sees it (ADR-288). A Telegram request is one `hawa.requests` row whose
 * revision rounds, office retries and answered questions are separate tasks; a task from before the
 * request lifecycle (no request id) is its own request. Every stage is counted once per request, at
 * its first occurrence: a request with three Canva directions, two revision rounds and a publication
 * retry is one brief, one draft, one approval and one delivery.
 */
export interface FunnelUnit {
  unitId: string;
  canary: boolean;
  briefAt: Date;
  /** The first Canva design bound to any of the request's tasks. */
  draftAt: Date | null;
  /** Tasks of the request that got a Canva design: a second one is a further round. */
  draftedTasks: number;
  /** The first recorded approval: an approved decision row or a task event moving to `approved`. */
  approvalEvidenceAt: Date | null;
  /** For tasks approved before either was recorded: when the task was seen approved or finished. */
  approvalStateAt: Date | null;
  /** Office decisions that sent a draft back for changes. */
  revisionDecisions: number;
  /** The first delivery: a task completed (its `completed_at`), or a publication completed. */
  deliveredAt: Date | null;
  /** The request's stage (lifecycle requests) and its newest task's state. */
  requestStage: string | null;
  latestTaskState: string;
  /** Who withdrew the request, from the withdraw event (`requester` | `office`), if anyone did. */
  withdrawnBy: string | null;
}

const HOUR = 3_600_000;
/** How far back a request is read: one first briefed earlier and approved now still counts now. */
const HORIZON_DAYS = 90;

/** percentile_cont: linear interpolation between the closest ranks, as Postgres computes it. */
export function percentileCont(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const low = Math.floor(rank), high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

const timing = (hours: number[]): StageTiming =>
  ({ samples: hours.length, p50Hours: percentileCont(hours, 0.5), p95Hours: percentileCont(hours, 0.95) });

const approvedAt = (u: FunnelUnit) => u.approvalEvidenceAt ?? u.approvalStateAt;
const inWindow = (at: Date | null, fromMs: number, nowMs: number): at is Date =>
  at !== null && at.getTime() >= fromMs && at.getTime() <= nowMs;
const hoursBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / HOUR;

/** Why a request with no draft ended, or null while it is still open (or has a draft). */
export function cancelledReason(u: FunnelUnit): keyof Omit<CancelledBeforeDraft, 'total'> | null {
  if (u.draftAt) return null;
  if (u.withdrawnBy === 'requester') return 'requesterWithdrew';
  if (u.withdrawnBy === 'office') return 'officeCancelled';
  if (['failed_operator', 'failed_retryable'].includes(u.latestTaskState)) return 'systemFailed';
  const closed = u.requestStage ? ['cancelled', 'expired', 'rejected'].includes(u.requestStage)
    : ['cancelled', 'rejected'].includes(u.latestTaskState);
  return closed ? 'other' : null;
}

/**
 * The funnel's counts, stage timings and north-star numbers from per-request rows (ADR-288).
 *
 * Each stage timing is read when its stage ENDS in the window: draft→approval for the requests approved
 * in the window, from their first draft, wherever that draft fell. Until 2026-10-03 the timings were
 * read only for requests whose brief was in the window, and a delivery only from a completed
 * publication, while the counts above them read events in the window: production showed one approval
 * and one delivery beside 0 samples for both stages.
 */
export function summarizeFunnel(units: FunnelUnit[], options: { nowMs: number; windowHours: number; northStarDays?: number }) {
  const { nowMs, windowHours } = options;
  const northStarDays = options.northStarDays ?? 7;
  const from = nowMs - windowHours * HOUR;
  const live = units.filter((u) => !u.canary);
  const briefed = live.filter((u) => inWindow(u.briefAt, from, nowMs));
  const drafted = live.filter((u) => inWindow(u.draftAt, from, nowMs));
  const approved = live.filter((u) => inWindow(approvedAt(u), from, nowMs));
  const delivered = live.filter((u) => inWindow(u.deliveredAt, from, nowMs));

  const cancelled: CancelledBeforeDraft = { total: 0, requesterWithdrew: 0, officeCancelled: 0, systemFailed: 0, other: 0 };
  for (const u of briefed) {
    const reason = cancelledReason(u);
    if (reason) { cancelled[reason] += 1; cancelled.total += 1; }
  }

  // Timings use recorded evidence only: an approval known only from a task's state has no time of its
  // own (its task's last update), and would add an invented zero to approval→delivery.
  const stageDurations: Record<Stage, StageTiming> = {
    briefToDraft: timing(drafted.map((u) => hoursBetween(u.briefAt, u.draftAt!))),
    draftToApproval: timing(approved.filter((u) => u.approvalEvidenceAt && u.draftAt && u.approvalEvidenceAt >= u.draftAt)
      .map((u) => hoursBetween(u.draftAt!, u.approvalEvidenceAt!))),
    approvalToDelivery: timing(delivered.filter((u) => u.approvalEvidenceAt && u.deliveredAt! >= u.approvalEvidenceAt)
      .map((u) => hoursBetween(u.approvalEvidenceAt!, u.deliveredAt!))),
  };

  const nsFrom = nowMs - northStarDays * 24 * HOUR;
  const nsDelivered = live.filter((u) => inWindow(u.deliveredAt, nsFrom, nowMs));
  const nsApproved = live.filter((u) => inWindow(approvedAt(u), nsFrom, nowMs));
  const firstDraft = nsApproved.filter((u) => u.revisionDecisions === 0 && u.draftedTasks <= 1).length;
  const briefToDelivery = nsDelivered.map((u) => hoursBetween(u.briefAt, u.deliveredAt!));
  const northStar: NorthStarMetrics = {
    days: northStarDays,
    deliveredDesigns: nsDelivered.length,
    approvals: nsApproved.length,
    approvedFirstDraft: firstDraft,
    firstDraftApprovalRate: nsApproved.length ? firstDraft / nsApproved.length : null,
    medianBriefToDeliveryHours: percentileCont(briefToDelivery, 0.5),
    briefToDeliverySamples: briefToDelivery.length,
  };

  return {
    briefsCount: briefed.length,
    draftsCount: drafted.length,
    approvalsCount: approved.length,
    deliveriesCount: delivered.length,
    briefsDrafted: briefed.filter((u) => u.draftAt !== null).length,
    cancelledBeforeDraft: cancelled,
    excluded: { canaryRequests: units.filter((u) => u.canary && (inWindow(u.briefAt, from, nowMs) ||
      inWindow(u.draftAt, from, nowMs) || inWindow(approvedAt(u), from, nowMs) || inWindow(u.deliveredAt, from, nowMs))).length },
    stageDurations,
    northStar,
  };
}

/**
 * Whether a chat id (text) is in the range no Telegram chat can have (ADR-240). The cast only ever sees
 * sixteen digits: Postgres does not promise to test the pattern first in a plain AND.
 */
const canaryChat = (chat: ReturnType<typeof sql>) => sql`COALESCE(CASE WHEN (${chat}) ~ '^[1-9][0-9]{15}$'
  THEN (${chat})::numeric BETWEEN ${String(CANARY_CHAT_ID_MIN)}::numeric AND ${String(CANARY_CHAT_ID_MAX)}::numeric END, false)`;

/**
 * Every request touched in the last HORIZON_DAYS, one row each. Canary requests are marked, not dropped:
 * a request is the canary's when its chat or intake chat is in the range no Telegram chat can have
 * (ADR-240), or when it is for the canary's own client (ADR-254).
 */
export async function readFunnelUnits(trx: Kysely<Database>, tenantId: string, horizonDays = HORIZON_DAYS): Promise<FunnelUnit[]> {
  const rows = (await sql<{
    unit_id: string; canary: boolean; brief_at: Date; draft_at: Date | null; drafted_tasks: string;
    approval_evidence_at: Date | null; approval_state_at: Date | null; revision_decisions: string;
    delivered_at: Date | null; request_stage: string | null; latest_task_state: string; withdrawn_by: string | null;
  }>`
    WITH recent AS (
      SELECT DISTINCT COALESCE(t.request_id, t.id) AS unit_id FROM hawa.tasks t
      WHERE t.tenant_id = ${tenantId}::uuid AND t.deleted_at IS NULL
        AND (t.created_at >= now() - make_interval(days => ${horizonDays}::int) OR t.updated_at >= now() - make_interval(days => ${horizonDays}::int))
    ), per_task AS (
      SELECT t.id, COALESCE(t.request_id, t.id) AS unit_id, t.request_id, t.created_at, t.updated_at, t.completed_at, t.state::text AS state,
        t.client_id = ${CANARY_TEST_CLIENT_ID}::uuid AS canary_client,
        (SELECT min(b.created_at) FROM hawa.canva_bindings b WHERE b.tenant_id = t.tenant_id AND b.task_id = t.id) AS draft_at,
        (SELECT min(a.created_at) FROM hawa.approvals a WHERE a.tenant_id = t.tenant_id AND a.task_id = t.id AND a.decision = 'approved') AS approval_row_at,
        (SELECT count(*) FROM hawa.approvals a WHERE a.tenant_id = t.tenant_id AND a.task_id = t.id AND a.decision = 'revision_requested') AS revision_decisions,
        (SELECT min(e.occurred_at) FROM hawa.task_events e WHERE e.tenant_id = t.tenant_id AND e.task_id = t.id
          AND e.event_type = 'task.state_changed' AND e.data->>'toState' = 'approved') AS approved_event_at,
        (SELECT min(e.occurred_at) FROM hawa.task_events e WHERE e.tenant_id = t.tenant_id AND e.task_id = t.id
          AND e.event_type = 'task.state_changed' AND e.data->>'toState' = 'complete') AS complete_event_at,
        (SELECT min(p.completed_at) FROM hawa.publications p WHERE p.tenant_id = t.tenant_id AND p.task_id = t.id AND p.state = 'complete') AS publication_at,
        (SELECT e.data->'withdrawn'->>'actor' FROM hawa.task_events e WHERE e.tenant_id = t.tenant_id AND e.task_id = t.id
          AND e.event_type = 'task.state_changed' AND e.data ? 'withdrawn' ORDER BY e.occurred_at DESC LIMIT 1) AS withdrawn_by,
        EXISTS (SELECT 1 FROM hawa.outbox_commands o WHERE o.tenant_id = t.tenant_id AND o.aggregate_id = t.id
          AND o.command_type = 'task.created' AND ${canaryChat(sql`o.payload->>'sourceChannelId'`)}) AS canary_intake
      FROM hawa.tasks t JOIN recent u ON u.unit_id = COALESCE(t.request_id, t.id)
      WHERE t.tenant_id = ${tenantId}::uuid AND t.deleted_at IS NULL
    )
    SELECT p.unit_id,
      bool_or(p.canary_client OR p.canary_intake) OR COALESCE(bool_or(${canaryChat(sql`r.chat_id`)}), false) AS canary,
      LEAST(min(p.created_at), min(r.created_at)) AS brief_at,
      min(p.draft_at) AS draft_at,
      count(p.draft_at) AS drafted_tasks,
      LEAST(min(p.approval_row_at), min(p.approved_event_at)) AS approval_evidence_at,
      min(CASE WHEN p.state IN ('approved', 'publishing', 'complete') THEN COALESCE(p.completed_at, p.updated_at) END) AS approval_state_at,
      sum(p.revision_decisions) AS revision_decisions,
      LEAST(min(p.publication_at), min(CASE WHEN p.state = 'complete' THEN COALESCE(p.completed_at, p.complete_event_at, p.updated_at) END)) AS delivered_at,
      max(r.stage) AS request_stage,
      (array_agg(p.state ORDER BY p.created_at DESC))[1] AS latest_task_state,
      (array_agg(p.withdrawn_by ORDER BY p.created_at DESC) FILTER (WHERE p.withdrawn_by IS NOT NULL))[1] AS withdrawn_by
    FROM per_task p LEFT JOIN hawa.requests r ON r.tenant_id = ${tenantId}::uuid AND r.request_id = p.request_id
    GROUP BY p.unit_id
  `.execute(trx)).rows;
  const date = (v: Date | string | null) => (v === null ? null : new Date(v));
  return rows.map((r) => ({
    unitId: r.unit_id, canary: Boolean(r.canary), briefAt: new Date(r.brief_at), draftAt: date(r.draft_at),
    draftedTasks: Number(r.drafted_tasks), approvalEvidenceAt: date(r.approval_evidence_at),
    approvalStateAt: date(r.approval_state_at), revisionDecisions: Number(r.revision_decisions || 0),
    deliveredAt: date(r.delivered_at), requestStage: r.request_stage, latestTaskState: r.latest_task_state,
    withdrawnBy: r.withdrawn_by,
  }));
}

/**
 * Step 5 Production Funnel Health Monitor (CV-16 / Engineering Rank Audit):
 * Detects automatic requests stuck before a Canva draft, even when other requests succeed.
 * Approval and delivery counts remain observations, not proof that the currently active
 * Canva-link workflow failed: those later steps may happen outside this system.
 */
export async function checkProductionFunnelHealth(
  db: Kysely<Database> | null,
  options?: {
    tenantId?: string;
    windowHours?: number;
    stuckDraftHours?: number;
    northStarDays?: number;
  }
): Promise<FunnelHealthMetrics> {
  const windowHours = options?.windowHours ?? 48;
  const stuckDraftHours = options?.stuckDraftHours ?? 2;
  const tenantId = options?.tenantId ?? '00000000-0000-4000-a000-000000000001';
  const measuredAt = new Date().toISOString();

  if (!db) {
    return {
      windowHours,
      briefsCount: null,
      draftsCount: null,
      approvalsCount: null,
      deliveriesCount: null,
      status: 'unknown',
      alert: 'Funnel state is unknown because PostgreSQL is unavailable.',
      stalledTaskCount: null,
      stageDurations: null,
      northStar: null,
      measuredAt,
    };
  }

  try {
    const counts = await withRlsContext(
      db,
      { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' },
      async (trx) => {
        const oldestPending = (await sql<any>`
          SELECT EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0 as pending_hours
          FROM hawa.tasks
          WHERE tenant_id = ${tenantId}::uuid
            AND state NOT IN ('approved', 'complete', 'rejected', 'cancelled')
            AND created_at >= now() - (${windowHours} || ' hours')::interval
          ORDER BY created_at ASC LIMIT 1
        `.execute(trx)).rows[0];

        // A successful draft elsewhere must not hide an older automatic request with no Canva
        // design. Manual-only requests and tasks already awaiting a person are excluded.
        const stuck = (await sql<{ id: string; age_hours: number; n: string }>`
          SELECT t.id, EXTRACT(EPOCH FROM (now() - t.created_at)) / 3600.0 AS age_hours,
            COUNT(*) OVER() AS n
          FROM hawa.tasks t
          WHERE t.tenant_id = ${tenantId}::uuid
            AND t.created_at >= now() - (${windowHours} || ' hours')::interval
            AND t.created_at <= now() - (${stuckDraftHours} || ' hours')::interval
            AND t.state IN ('received', 'promotion_pending', 'routing', 'routing_review',
              'brief_draft', 'brief_review', 'context_ready', 'design_planning',
              'asset_production', 'studio_composition', 'qa', 'auto_repair')
            AND EXISTS (SELECT 1 FROM hawa.outbox_commands o WHERE o.tenant_id = t.tenant_id
              AND o.aggregate_id = t.id AND o.command_type = 'task.created'
              AND o.payload->>'autoGenerate' = 'true')
            AND NOT EXISTS (SELECT 1 FROM hawa.canva_bindings b WHERE b.tenant_id = t.tenant_id
              AND b.task_id = t.id)
          ORDER BY t.created_at ASC LIMIT 1
        `.execute(trx)).rows[0];

        const units = await readFunnelUnits(trx, tenantId, Math.max(HORIZON_DAYS, Math.ceil(windowHours / 24) + 1));
        // The database's clock, as the window queries above read it.
        const nowMs = new Date((await sql<{ now: Date }>`SELECT now() AS now`.execute(trx)).rows[0].now).getTime();
        return {
          ...summarizeFunnel(units, { nowMs, windowHours, northStarDays: options?.northStarDays }),
          oldestUnapprovedHours: oldestPending ? Math.round(Number(oldestPending.pending_hours) * 10) / 10 : null,
          stalledTaskCount: Number(stuck?.n || 0),
          oldestStalledTaskId: stuck?.id ?? null,
          oldestStalledTaskHours: stuck ? Math.round(Number(stuck.age_hours) * 10) / 10 : null,
        };
      }
    );

    const briefsCount = counts.briefsCount;
    const draftsCount = counts.draftsCount;

    let status: 'healthy' | 'idle' | 'in_progress' | 'stalled' = 'healthy';
    let alert: string | null = null;

    // A stall is an eligible automatic task older than its draft deadline without a design.
    // A recent brief or a manual-only request is not an outage just because drafts are zero.
    // The absence of approvals/publications also does not decide this status.
    //
    // Those two stages belong to a flow this product does not currently run: the deliverable is an
    // editable Canva link, and the owner reviews and edits it there, outside this system. So
    // `approvals` and `deliveries` sat at zero permanently, health reported `degraded` permanently,
    // and a real outage would have looked exactly like every other day — 14 briefs, 13 drafts, a
    // working pipeline, and a red light. A monitor that is always alarming is worse than none,
    // because it teaches the one person watching to ignore it.
    //
    // Both counts are still reported, because they are the truth about a flow that may yet be used.
    // They no longer decide whether the pipeline is stalled.
    // A stalled task is checked first: the canary's own request is no brief, but its stall is real.
    if (counts.stalledTaskCount > 0) {
      status = 'stalled';
      alert = `${counts.stalledTaskCount} automatic design request(s) have no Canva draft after ${stuckDraftHours}h; oldest task ${counts.oldestStalledTaskId} (${counts.oldestStalledTaskHours}h).`;
    } else if (briefsCount === 0) {
      status = 'idle';
    } else if (draftsCount === 0) {
      status = 'in_progress';
    }

    return {
      windowHours,
      briefsCount,
      draftsCount,
      approvalsCount: counts.approvalsCount,
      deliveriesCount: counts.deliveriesCount,
      briefsDrafted: counts.briefsDrafted,
      cancelledBeforeDraft: counts.cancelledBeforeDraft,
      excluded: counts.excluded,
      northStar: counts.northStar,
      status,
      alert,
      oldestUnapprovedHours: counts.oldestUnapprovedHours,
      stalledTaskCount: counts.stalledTaskCount,
      oldestStalledTaskId: counts.oldestStalledTaskId,
      oldestStalledTaskHours: counts.oldestStalledTaskHours,
      stageDurations: counts.stageDurations,
      nextAction: status === 'stalled' ? 'Inspect the oldest task and its last recorded operation in Hawa Desk.' : null,
      measuredAt,
    };
  } catch (err: any) {
    log.error('[funnel-monitor] Funnel check failed:', err);
    return {
      windowHours,
      briefsCount: null,
      draftsCount: null,
      approvalsCount: null,
      deliveriesCount: null,
      status: 'unknown',
      alert: `Error evaluating funnel health: ${err.message || String(err)}`,
      stalledTaskCount: null,
      stageDurations: null,
      northStar: null,
      measuredAt,
    };
  }
}
