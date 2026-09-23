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
  /** The same, by kind of change (the operation catalogue's roadmap): asks and how many were not possible. */
  byOp: Array<{ op: string; asks: number; notPossible: number }>;
  /** Revisions by round: how many first changes, second changes, third and later. */
  revisionsByRound: { first: number; second: number; thirdOrLater: number };
  requesterApprovals: { total: number; firstDraft: number };
  designerHandoffs: { requesterAsked: number; notPossible: number; afterThreeRounds: number };
  reminders: number;
  cutouts: { made: number; passed: number; passRate: number | null };
  /** Questions asked before a change was made, and how many the requester answered. */
  questions: { asked: number; answered: number };
  /** Edits that moved something the request did not name, because it had to make room. */
  editsWithSideEffects: number;
  /**
   * The visual check against the recorded outcome: asks it looked at, where it agreed, and asks
   * recorded done that it did not see made (the claimed-but-not-done rate, target 0, once trusted).
   */
  visualCheck: { checked: number; agreed: number; doneButNotSeen: number };
  /** Requesters who sounded frustrated (the office was told each time). */
  frustrated: number;
  /** Asks made, by rule (exact, no model call) and by the edit model. */
  madeBy: { rule: number; model: number };
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
    const byOp = (
      await sql<{ op: string; asks: number; notPossible: number }>`SELECT COALESCE(a->>'op', 'unclassified') AS op, count(*)::int AS asks,
          count(*) FILTER (WHERE a->>'status' = 'not_possible')::int AS "notPossible"
        FROM hawa.design_studio_runs r, jsonb_array_elements(COALESCE(r.stages->'directed'->'asks', '[]'::jsonb)) a
        WHERE r.tenant_id = ${scope.tenantId}::uuid AND r.created_at > ${since}
        GROUP BY 1 ORDER BY 3 DESC, 2 DESC, 1 LIMIT 30`.execute(trx)
    ).rows;
    const rounds = (
      await sql<{ first: number; second: number; later: number }>`SELECT
          count(*) FILTER (WHERE (o.payload->'studioOptions'->>'revisionRound')::int = 1)::int AS first,
          count(*) FILTER (WHERE (o.payload->'studioOptions'->>'revisionRound')::int = 2)::int AS second,
          count(*) FILTER (WHERE (o.payload->'studioOptions'->>'revisionRound')::int >= 3)::int AS later
        FROM hawa.outbox_commands o
        WHERE o.tenant_id = ${scope.tenantId}::uuid AND o.command_type = 'task.created' AND o.created_at > ${since}
          AND o.payload->'studioOptions'->>'revisionRound' ~ '^[0-9]+$'
          -- Another size is not a round, and an answered question is the same round as the question.
          AND COALESCE(o.payload->'studioOptions'->>'reformat', '') = ''
          AND COALESCE(o.payload->'studioOptions'->>'clarified', 'false') <> 'true'`.execute(trx)
    ).rows[0];
    const approvals = (
      await sql<{ total: number; first: number }>`SELECT count(*)::int AS total,
          count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM hawa.outbox_commands o WHERE o.tenant_id = e.tenant_id
            AND o.command_type = 'task.created' AND o.aggregate_id::text = e.payload->>'taskId'
            AND o.payload->'studioOptions' ? 'parentTaskId' AND COALESCE(o.payload->'studioOptions'->>'reformat', '') = ''))::int AS first
        FROM hawa.inbox_events e
        WHERE e.tenant_id = ${scope.tenantId}::uuid AND e.event_kind = 'telegram_requester_ok' AND e.received_at > ${since}`.execute(trx)
    ).rows[0];
    const alerts = (
      await sql<{ asked: number; impossible: number; rounds: number; reminders: number }>`SELECT
          count(*) FILTER (WHERE idempotency_key LIKE 'notify.office:designer-asked:%')::int AS asked,
          count(*) FILTER (WHERE idempotency_key LIKE 'notify.office:change-needs-designer:%')::int AS impossible,
          count(*) FILTER (WHERE idempotency_key LIKE 'notify.office:rounds:%')::int AS rounds,
          count(*) FILTER (WHERE idempotency_key ~ '^notify\.telegram:(question-)?reminder')::int AS reminders
        FROM hawa.outbox_commands
        WHERE tenant_id = ${scope.tenantId}::uuid AND created_at > ${since}`.execute(trx)
    ).rows[0];
    const loop = (
      await sql<{ asked: number; answered: number; side: number; checked: number; agreed: number; unseen: number; frustrated: number; rule: number; model: number }>`SELECT
          count(*) FILTER (WHERE r.stages->'directed'->>'refused' = 'NEEDS_CLARIFICATION')::int AS asked,
          (SELECT count(*)::int FROM hawa.outbox_commands o WHERE o.tenant_id = ${scope.tenantId}::uuid AND o.command_type = 'task.created'
             AND o.created_at > ${since} AND o.payload->'studioOptions'->>'clarified' = 'true') AS answered,
          count(*) FILTER (WHERE jsonb_array_length(COALESCE(r.stages->'directed'->'sideEffects', '[]'::jsonb)) > 0)::int AS side,
          COALESCE(sum((SELECT count(*) FROM jsonb_array_elements(COALESCE(r.stages->'directed'->'asks', '[]'::jsonb)) a WHERE a ? 'seen')), 0)::int AS checked,
          COALESCE(sum((SELECT count(*) FROM jsonb_array_elements(COALESCE(r.stages->'directed'->'asks', '[]'::jsonb)) a
            WHERE a ? 'seen' AND (a->'seen'->>'made')::boolean = (a->>'status' = 'done'))), 0)::int AS agreed,
          COALESCE(sum((SELECT count(*) FROM jsonb_array_elements(COALESCE(r.stages->'directed'->'asks', '[]'::jsonb)) a
            WHERE a->>'status' = 'done' AND (a->'seen'->>'made')::boolean IS FALSE)), 0)::int AS unseen,
          count(*) FILTER (WHERE r.stages->'directed'->>'frustrated' = 'true')::int AS frustrated,
          COALESCE(sum((SELECT count(*) FROM jsonb_array_elements(COALESCE(r.stages->'directed'->'asks', '[]'::jsonb)) a WHERE a->>'status' = 'done' AND a->>'by' = 'rule')), 0)::int AS rule,
          COALESCE(sum((SELECT count(*) FROM jsonb_array_elements(COALESCE(r.stages->'directed'->'asks', '[]'::jsonb)) a WHERE a->>'status' = 'done' AND a->>'by' = 'model')), 0)::int AS model
        FROM hawa.design_studio_runs r
        WHERE r.tenant_id = ${scope.tenantId}::uuid AND r.created_at > ${since}`.execute(trx)
    ).rows[0];
    const cut = (
      await sql<{ made: number; passed: number }>`SELECT count(*)::int AS made, count(*) FILTER (WHERE passed)::int AS passed
        FROM hawa.photo_cutouts WHERE tenant_id = ${scope.tenantId}::uuid AND created_at > ${since}`.execute(trx)
    ).rows[0];
    return {
      days: window,
      asks: { done: count('done'), notDone: count('not_done'), notPossible: count('not_possible') },
      notPossibleTop,
      byOp,
      revisionsByRound: { first: rounds?.first ?? 0, second: rounds?.second ?? 0, thirdOrLater: rounds?.later ?? 0 },
      requesterApprovals: { total: approvals?.total ?? 0, firstDraft: approvals?.first ?? 0 },
      designerHandoffs: { requesterAsked: alerts?.asked ?? 0, notPossible: alerts?.impossible ?? 0, afterThreeRounds: alerts?.rounds ?? 0 },
      reminders: alerts?.reminders ?? 0,
      cutouts: { made: cut?.made ?? 0, passed: cut?.passed ?? 0, passRate: cut?.made ? Math.round((1000 * cut.passed) / cut.made) / 1000 : null },
      questions: { asked: loop?.asked ?? 0, answered: loop?.answered ?? 0 },
      editsWithSideEffects: loop?.side ?? 0,
      visualCheck: { checked: loop?.checked ?? 0, agreed: loop?.agreed ?? 0, doneButNotSeen: loop?.unseen ?? 0 },
      frustrated: loop?.frustrated ?? 0,
      madeBy: { rule: loop?.rule ?? 0, model: loop?.model ?? 0 },
    };
  });
}
