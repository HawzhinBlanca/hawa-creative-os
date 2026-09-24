import { sql, withRlsContext, type Kysely, type Database } from '@hawa/db';
import { log } from '../logging.js';

export interface FunnelHealthMetrics {
  windowHours: number;
  briefsCount: number | null;
  draftsCount: number | null;
  approvalsCount: number | null;
  deliveriesCount: number | null;
  status: 'healthy' | 'idle' | 'in_progress' | 'stalled' | 'unknown';
  alert: string | null;
  oldestUnapprovedHours?: number | null;
  stalledTaskCount?: number | null;
  oldestStalledTaskId?: string | null;
  oldestStalledTaskHours?: number | null;
  stageDurations?: Record<'briefToDraft' | 'draftToApproval' | 'approvalToDelivery', {
    samples: number;
    p50Hours: number | null;
    p95Hours: number | null;
  }> | null;
  nextAction?: string | null;
  measuredAt: string;
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
      measuredAt,
    };
  }

  try {
    const counts = await withRlsContext(
      db,
      { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' },
      async (trx) => {
        const row = (await sql<any>`
          SELECT
            (SELECT COUNT(*) FROM hawa.tasks
             WHERE tenant_id = ${tenantId}::uuid
               AND created_at >= now() - (${windowHours} || ' hours')::interval) as briefs,
            (SELECT COUNT(*) FROM hawa.canva_bindings
             WHERE tenant_id = ${tenantId}::uuid
               AND created_at >= now() - (${windowHours} || ' hours')::interval) as drafts,
            ((SELECT COUNT(*) FROM hawa.approvals
              WHERE tenant_id = ${tenantId}::uuid
                AND decision = 'approved'
                AND created_at >= now() - (${windowHours} || ' hours')::interval) +
             (SELECT COUNT(*) FROM hawa.tasks
              WHERE tenant_id = ${tenantId}::uuid
                AND state IN ('approved', 'complete')
                AND updated_at >= now() - (${windowHours} || ' hours')::interval)) as approvals,
            ((SELECT COUNT(*) FROM hawa.publications
              WHERE tenant_id = ${tenantId}::uuid
                AND created_at >= now() - (${windowHours} || ' hours')::interval) +
             (SELECT COUNT(*) FROM hawa.tasks
              WHERE tenant_id = ${tenantId}::uuid
                AND state = 'complete'
                AND updated_at >= now() - (${windowHours} || ' hours')::interval)) as deliveries
        `.execute(trx)).rows[0];

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

        // One row per task and per completed transition. A task with several Canva directions,
        // approvals, or publication retries must not get extra weight in these percentiles.
        const durations = (await sql<{
          stage: 'briefToDraft' | 'draftToApproval' | 'approvalToDelivery';
          samples: string;
          p50_hours: number | null;
          p95_hours: number | null;
        }>`
          WITH cohort AS (
            SELECT id, created_at FROM hawa.tasks
            WHERE tenant_id = ${tenantId}::uuid
              AND created_at >= now() - (${windowHours} || ' hours')::interval
          ), draft AS (
            SELECT c.id, c.created_at AS brief_at, min(b.created_at) AS draft_at
            FROM cohort c LEFT JOIN hawa.canva_bindings b
              ON b.tenant_id = ${tenantId}::uuid AND b.task_id = c.id
              AND b.created_at >= c.created_at
            GROUP BY c.id, c.created_at
          ), approved AS (
            SELECT d.id, d.brief_at, d.draft_at, min(a.created_at) AS approved_at
            FROM draft d LEFT JOIN hawa.approvals a
              ON a.tenant_id = ${tenantId}::uuid AND a.task_id = d.id
              AND a.decision = 'approved' AND a.created_at >= d.draft_at
            GROUP BY d.id, d.brief_at, d.draft_at
          ), delivered AS (
            SELECT a.*, min(p.completed_at) AS delivered_at
            FROM approved a LEFT JOIN hawa.publications p
              ON p.tenant_id = ${tenantId}::uuid AND p.task_id = a.id
              AND p.state = 'complete' AND p.completed_at >= a.approved_at
            GROUP BY a.id, a.brief_at, a.draft_at, a.approved_at
          ), transitions AS (
            SELECT 'briefToDraft' AS stage, (extract(epoch FROM (draft_at - brief_at)) / 3600.0)::double precision AS hours FROM delivered
            UNION ALL SELECT 'draftToApproval', (extract(epoch FROM (approved_at - draft_at)) / 3600.0)::double precision FROM delivered
            UNION ALL SELECT 'approvalToDelivery', (extract(epoch FROM (delivered_at - approved_at)) / 3600.0)::double precision FROM delivered
          )
          SELECT stage, count(hours) AS samples,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY hours) AS p50_hours,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY hours) AS p95_hours
          FROM transitions GROUP BY stage
        `.execute(trx)).rows;

        const emptyStage = () => ({ samples: 0, p50Hours: null, p95Hours: null });
        const stageDurations: NonNullable<FunnelHealthMetrics['stageDurations']> = {
          briefToDraft: emptyStage(),
          draftToApproval: emptyStage(),
          approvalToDelivery: emptyStage(),
          ...Object.fromEntries(durations.map((d) => [d.stage, {
          samples: Number(d.samples),
          p50Hours: d.p50_hours === null ? null : Math.round(Number(d.p50_hours) * 10) / 10,
          p95Hours: d.p95_hours === null ? null : Math.round(Number(d.p95_hours) * 10) / 10,
          }])),
        };

        return {
          briefs: Number(row?.briefs || 0),
          drafts: Number(row?.drafts || 0),
          approvals: Number(row?.approvals || 0),
          deliveries: Number(row?.deliveries || 0),
          oldestUnapprovedHours: oldestPending ? Math.round(Number(oldestPending.pending_hours) * 10) / 10 : null,
          stalledTaskCount: Number(stuck?.n || 0),
          oldestStalledTaskId: stuck?.id ?? null,
          oldestStalledTaskHours: stuck ? Math.round(Number(stuck.age_hours) * 10) / 10 : null,
          stageDurations,
        };
      }
    );

    const briefsCount = counts.briefs;
    const draftsCount = counts.drafts;
    const approvalsCount = counts.approvals;
    const deliveriesCount = counts.deliveries;

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
    if (briefsCount === 0) {
      status = 'idle';
    } else if (counts.stalledTaskCount > 0) {
      status = 'stalled';
      alert = `${counts.stalledTaskCount} automatic design request(s) have no Canva draft after ${stuckDraftHours}h; oldest task ${counts.oldestStalledTaskId} (${counts.oldestStalledTaskHours}h).`;
    } else if (draftsCount === 0) {
      status = 'in_progress';
    }

    return {
      windowHours,
      briefsCount,
      draftsCount,
      approvalsCount,
      deliveriesCount,
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
      measuredAt,
    };
  }
}
