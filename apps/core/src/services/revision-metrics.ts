import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';

/**
 * How the revision loop is doing (ADR-032 §2.3–2.4, plan phase 5), from the pipeline's own records:
 * what requesters asked for and what became of it, how many rounds designs take, how many drafts the
 * requester approved as first sent, what went to a designer, and how often a photo could be cut out.
 * Read only. The asks most often not possible are the roadmap: each is a means the pipeline lacks.
 */
export interface RevisionMetrics {
  days: number;
  asks: { done: number; notDone: number; notPossible: number };
  /** The asks most often not possible, in the words the analysis gave them. */
  notPossibleTop: Array<{ ask: string; count: number }>;
  /** Revisions by round: how many first changes, second changes, third and later. */
  revisionsByRound: { first: number; second: number; thirdOrLater: number };
  requesterApprovals: { total: number; firstDraft: number };
  designerHandoffs: { requesterAsked: number; notPossible: number; afterThreeRounds: number };
  reminders: number;
  cutouts: { made: number; passed: number; passRate: number | null };
}

export async function revisionMetrics(db: Kysely<Database>, scope: { tenantId: string; userId: string }, days = 30): Promise<RevisionMetrics> {
  const window = Math.max(1, Math.min(365, Math.round(days)));
  return withRlsContext(db, { tenantId: scope.tenantId, userId: scope.userId, role: 'administrator' }, async (trx) => {
    const since = sql`now() - make_interval(days => ${window})`;
    const asks = (
      await sql<{ status: string; n: number }>`SELECT a->>'status' AS status, count(*)::int AS n
        FROM hawa.design_studio_runs r, jsonb_array_elements(COALESCE(r.stages->'directed'->'asks', '[]'::jsonb)) a
        WHERE r.tenant_id = ${scope.tenantId}::uuid AND r.created_at > ${since}
        GROUP BY 1`.execute(trx)
    ).rows;
    const count = (status: string) => asks.find((a) => a.status === status)?.n ?? 0;
    const notPossibleTop = (
      await sql<{ ask: string; count: number }>`SELECT lower(a->>'ask') AS ask, count(*)::int AS count
        FROM hawa.design_studio_runs r, jsonb_array_elements(COALESCE(r.stages->'directed'->'asks', '[]'::jsonb)) a
        WHERE r.tenant_id = ${scope.tenantId}::uuid AND r.created_at > ${since} AND a->>'status' = 'not_possible'
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`.execute(trx)
    ).rows;
    const rounds = (
      await sql<{ first: number; second: number; later: number }>`SELECT
          count(*) FILTER (WHERE (o.payload->'studioOptions'->>'revisionRound')::int = 1)::int AS first,
          count(*) FILTER (WHERE (o.payload->'studioOptions'->>'revisionRound')::int = 2)::int AS second,
          count(*) FILTER (WHERE (o.payload->'studioOptions'->>'revisionRound')::int >= 3)::int AS later
        FROM hawa.outbox_commands o
        WHERE o.tenant_id = ${scope.tenantId}::uuid AND o.command_type = 'task.created' AND o.created_at > ${since}
          AND o.payload->'studioOptions'->>'revisionRound' ~ '^[0-9]+$'`.execute(trx)
    ).rows[0];
    const approvals = (
      await sql<{ total: number; first: number }>`SELECT count(*)::int AS total,
          count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM hawa.outbox_commands o WHERE o.tenant_id = e.tenant_id
            AND o.command_type = 'task.created' AND o.aggregate_id::text = e.payload->>'taskId'
            AND o.payload->'studioOptions' ? 'parentTaskId'))::int AS first
        FROM hawa.inbox_events e
        WHERE e.tenant_id = ${scope.tenantId}::uuid AND e.event_kind = 'telegram_requester_ok' AND e.received_at > ${since}`.execute(trx)
    ).rows[0];
    const alerts = (
      await sql<{ asked: number; impossible: number; rounds: number; reminders: number }>`SELECT
          count(*) FILTER (WHERE idempotency_key LIKE 'notify.office:designer-asked:%')::int AS asked,
          count(*) FILTER (WHERE idempotency_key LIKE 'notify.office:change-needs-designer:%')::int AS impossible,
          count(*) FILTER (WHERE idempotency_key LIKE 'notify.office:rounds:%')::int AS rounds,
          count(*) FILTER (WHERE idempotency_key LIKE 'notify.telegram:reminder%')::int AS reminders
        FROM hawa.outbox_commands
        WHERE tenant_id = ${scope.tenantId}::uuid AND created_at > ${since}`.execute(trx)
    ).rows[0];
    const cut = (
      await sql<{ made: number; passed: number }>`SELECT count(*)::int AS made, count(*) FILTER (WHERE passed)::int AS passed
        FROM hawa.photo_cutouts WHERE tenant_id = ${scope.tenantId}::uuid AND created_at > ${since}`.execute(trx)
    ).rows[0];
    return {
      days: window,
      asks: { done: count('done'), notDone: count('not_done'), notPossible: count('not_possible') },
      notPossibleTop,
      revisionsByRound: { first: rounds?.first ?? 0, second: rounds?.second ?? 0, thirdOrLater: rounds?.later ?? 0 },
      requesterApprovals: { total: approvals?.total ?? 0, firstDraft: approvals?.first ?? 0 },
      designerHandoffs: { requesterAsked: alerts?.asked ?? 0, notPossible: alerts?.impossible ?? 0, afterThreeRounds: alerts?.rounds ?? 0 },
      reminders: alerts?.reminders ?? 0,
      cutouts: { made: cut?.made ?? 0, passed: cut?.passed ?? 0, passRate: cut?.made ? Math.round((1000 * cut.passed) / cut.made) / 1000 : null },
    };
  });
}
