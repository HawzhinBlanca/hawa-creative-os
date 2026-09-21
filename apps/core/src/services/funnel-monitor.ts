import { sql, withRlsContext, type Kysely, type Database } from '@hawa/db';

export interface FunnelHealthMetrics {
  windowHours: number;
  briefsCount: number;
  draftsCount: number;
  approvalsCount: number;
  deliveriesCount: number;
  status: 'healthy' | 'idle' | 'stalled';
  alert: string | null;
  oldestUnapprovedHours?: number | null;
  measuredAt: string;
}

/**
 * Step 5 Production Funnel Health Monitor (CV-16 / Engineering Rank Audit):
 * Detects pipeline stalls where briefs arrive but approvals or deliveries remain at zero
 * for 48 hours. Prevents silent breakage where intake continues but deliverables never ship.
 */
export async function checkProductionFunnelHealth(
  db: Kysely<Database> | null,
  options?: {
    tenantId?: string;
    windowHours?: number;
    telegramBridge?: { dispatchOutboundMessage: (chatId: string, msg: any) => Promise<any> };
    opsChannelId?: string;
  }
): Promise<FunnelHealthMetrics> {
  const windowHours = options?.windowHours ?? 48;
  const tenantId = options?.tenantId ?? '00000000-0000-4000-a000-000000000001';
  const measuredAt = new Date().toISOString();

  if (!db) {
    return {
      windowHours,
      briefsCount: 0,
      draftsCount: 0,
      approvalsCount: 0,
      deliveriesCount: 0,
      status: 'idle',
      alert: null,
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

        return {
          briefs: Number(row?.briefs || 0),
          drafts: Number(row?.drafts || 0),
          approvals: Number(row?.approvals || 0),
          deliveries: Number(row?.deliveries || 0),
          oldestUnapprovedHours: oldestPending ? Math.round(Number(oldestPending.pending_hours) * 10) / 10 : null,
        };
      }
    );

    const briefsCount = counts.briefs;
    const draftsCount = counts.drafts;
    const approvalsCount = counts.approvals;
    const deliveriesCount = counts.deliveries;

    let status: 'healthy' | 'idle' | 'stalled' = 'healthy';
    let alert: string | null = null;

    if (briefsCount === 0) {
      status = 'idle';
    } else if (approvalsCount === 0 || deliveriesCount === 0) {
      status = 'stalled';
      alert = `Production Funnel Stalled: ${briefsCount} briefs arrived in the last ${windowHours}h, but approvals (${approvalsCount}) or deliveries (${deliveriesCount}) are zero.`;

      if (options?.telegramBridge && options?.opsChannelId) {
        options.telegramBridge.dispatchOutboundMessage(options.opsChannelId, {
          text: `🚨 [FUNNEL ALERT] ${alert}`,
        }).catch((err) => console.error('[funnel-monitor] Failed to dispatch funnel alert:', err));
      }
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
      measuredAt,
    };
  } catch (err: any) {
    console.error('[funnel-monitor] Funnel check failed:', err);
    return {
      windowHours,
      briefsCount: 0,
      draftsCount: 0,
      approvalsCount: 0,
      deliveriesCount: 0,
      status: 'idle',
      alert: `Error evaluating funnel health: ${err.message || String(err)}`,
      measuredAt,
    };
  }
}
