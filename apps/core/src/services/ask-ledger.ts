import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';

/**
 * What the requester asked of a design, round by round, and what became of each ask (ADR-032 §2.3,
 * plan 2.1): the ledger the art director reads in Hawa Desk before approving or taking a design
 * over. It is read from the runs' own records along the revision chain (the design, the change to
 * it, the change to that…), oldest first, so it shows exactly what the requester was told.
 */
export interface LedgerAsk {
  ask: string;
  status: string;
  op?: string;
  /** Made by a rule (exact, no model) or by the edit model. */
  by?: 'rule' | 'model';
  reason?: string;
  /** How an open ask was read, as the requester was told it. */
  assumption?: string;
  /** The visual check's advice (edit stage visualCheck): whether it saw the ask made. */
  seen?: { made: boolean; why: string };
}

export interface LedgerRound {
  taskId: string;
  title: string | null;
  /** 0 is the design first made; each change to it is one more. */
  round: number;
  /** The change asked for, in the requester's words; absent for the first design. */
  directive?: string;
  /** Another size of an approved design, not a change. */
  reformat?: string;
  /** The question asked before this change was made, and whether it has been answered. */
  question?: { question: string; options: string[]; answered: boolean };
  asks: LedgerAsk[];
  /** What moved without being asked, to make room. */
  sideEffects: string[];
  frustrated: boolean;
  /** The run's state: transferred, failed, … ; absent when no design was started. */
  runStatus?: string;
  taskState: string;
}

/** A run's record of a change, as the edit stage writes it; every field is read with care. */
interface RecordedDirected {
  asks?: Array<{ ask?: unknown; status?: unknown; op?: unknown; by?: unknown; reason?: unknown; assumption?: unknown; seen?: { made?: unknown; why?: unknown } } | null>;
  refused?: unknown;
  clarify?: { question?: unknown; options?: unknown[] };
  sideEffects?: unknown[];
  frustrated?: unknown;
}

const text = (value: unknown, max = 300) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export async function askLedger(db: Kysely<Database>, scope: { tenantId: string; userId: string; role: string }, taskId: string): Promise<LedgerRound[]> {
  const rows = await withRlsContext(db, scope, async (trx) =>
    (
      await sql<{ id: string; depth: number; title: string | null; state: string; options: Record<string, unknown> | null; stages: unknown; status: string | null }>`WITH RECURSIVE chain(id, depth) AS (
          SELECT ${taskId}::uuid, 0
          UNION ALL
          SELECT (o.payload->'studioOptions'->>'parentTaskId')::uuid, chain.depth + 1
          FROM chain JOIN hawa.outbox_commands o ON o.aggregate_id = chain.id AND o.command_type = 'task.created'
          WHERE o.tenant_id = ${scope.tenantId}::uuid
            AND o.payload->'studioOptions'->>'parentTaskId' ~ '^[0-9a-f-]{36}$' AND chain.depth < 12
        )
        SELECT t.id::text AS id, chain.depth, t.title, t.state::text AS state,
          (SELECT o.payload->'studioOptions' FROM hawa.outbox_commands o WHERE o.aggregate_id = t.id AND o.command_type = 'task.created' ORDER BY o.created_at DESC LIMIT 1) AS options,
          r.stages, r.status
        FROM chain JOIN hawa.tasks t ON t.id = chain.id AND t.tenant_id = ${scope.tenantId}::uuid
        LEFT JOIN LATERAL (SELECT stages, status FROM hawa.design_studio_runs x WHERE x.tenant_id = t.tenant_id AND x.task_id = t.id ORDER BY x.created_at DESC LIMIT 1) r ON true
        ORDER BY chain.depth DESC`.execute(trx)
    ).rows
  );
  const deepest = rows.reduce((m, r) => Math.max(m, Number(r.depth) || 0), 0);
  return rows.map((row) => {
    const options = ((typeof row.options === 'string' ? JSON.parse(row.options) : row.options) || {}) as Record<string, unknown>;
    const stages = ((typeof row.stages === 'string' ? JSON.parse(row.stages) : row.stages) || {}) as { directed?: RecordedDirected };
    const directed: RecordedDirected = stages.directed || {};
    const clarify = directed.refused === 'NEEDS_CLARIFICATION' ? directed.clarify : undefined;
    const asks: LedgerAsk[] = [];
    for (const a of Array.isArray(directed.asks) ? directed.asks : []) {
      if (!a || !text(a.ask)) continue;
      const made = a.seen?.made;
      asks.push({
        ask: text(a.ask, 160),
        status: text(a.status, 20),
        ...(text(a.op, 40) ? { op: text(a.op, 40) } : {}),
        ...(a.by === 'rule' || a.by === 'model' ? { by: a.by } : {}),
        ...(text(a.reason) ? { reason: text(a.reason) } : {}),
        ...(text(a.assumption) ? { assumption: text(a.assumption) } : {}),
        ...(typeof made === 'boolean' ? { seen: { made, why: text(a.seen?.why, 160) } } : {}),
      });
    }
    return {
      taskId: row.id,
      title: row.title,
      round: deepest - (Number(row.depth) || 0),
      ...(text(options.revisionDirective, 2000) ? { directive: text(options.revisionDirective, 2000) } : {}),
      ...(text(options.reformat, 40) ? { reformat: text(options.reformat, 40) } : {}),
      ...(clarify && typeof clarify.question === 'string'
        ? {
            question: {
              question: text(clarify.question, 200),
              options: (Array.isArray(clarify.options) ? clarify.options : []).map((o) => text(o, 60)).filter(Boolean),
              answered: row.state === 'cancelled',
            },
          }
        : {}),
      asks,
      sideEffects: (Array.isArray(directed.sideEffects) ? directed.sideEffects : []).map((s) => text(s, 60)).filter(Boolean),
      frustrated: directed.frustrated === true,
      ...(row.status ? { runStatus: row.status } : {}),
      taskState: row.state,
    };
  });
}
