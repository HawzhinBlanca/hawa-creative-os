/**
 * ADR-289: one report of every paid model call the office makes.
 *
 * The ledgers already exist, one per kind of call, and the office day (`hawa.studio_scope_budget_internal`)
 * already admits every one of them against the shared allowance. What the office could not see was the
 * intake router's readings (ADR-144 requester, ADR-200 office, ADR-232 copy): they were charged to the
 * `intake_router` role but missing from the call list, and no view showed spend by day.
 *
 * This module reads, never writes. An intake reading's counted cost is the office day's own rule
 * (migration 068): its usage when the provider reported one (or 0 when it refused the request), else its
 * whole reservation. Every other kind's figure is `hawa.office_call_cost_evidence(...).accountedCostUsd`,
 * the number the call list already shows, so the summary is the call list added up.
 */
import { createHash } from 'node:crypto';
import { sql, type Database, type Kysely } from '@hawa/db';
import type { CallCostEvidence, SpendingRole, SpendingRoleTotal, SpendingSummary } from '@hawa/contracts';

interface IntakeRow {
  id: string; client_id: string; chat_id: string; update_id: string; model: string; served_model: string | null;
  status: string; acceptance: string | null; cost_basis: string | null; cost_usd: string | null;
  reservation: { usd?: unknown; reader?: unknown } & Record<string, unknown>; started: string;
  provider_request_id: string | null; response_id: string | null; diagnostic: string | null;
}

const money = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Number(n.toFixed(6)) : null;
};

/** The office day's charge for one intake reading (migration 068, `studio_scope_budget_internal`). */
export function intakeAccountedUsd(row: { cost_basis: string | null; cost_usd: unknown; reservation: { usd?: unknown } }): number {
  const used = money(row.cost_usd);
  if ((row.cost_basis === 'usage' || row.cost_basis === 'not_accepted') && used !== null) return used;
  return money(row.reservation?.usd) ?? 0;
}

function intakeEvidence(row: IntakeRow): CallCostEvidence {
  const reader = row.reservation?.reader === 'office' || row.reservation?.reader === 'copy' ? row.reservation.reader : 'requester';
  const original = money(row.cost_usd);
  return {
    kind: 'intake_router', id: row.id, clientId: row.client_id, taskId: null, runId: null,
    provider: 'openai', model: row.served_model || row.model,
    // 'started' is a reading whose outcome was never written (Core stopped mid-call): charged in full.
    status: row.status === 'completed' ? row.acceptance ?? 'unknown' : 'started',
    startedAt: row.started, providerRequestId: row.provider_request_id, responseId: row.response_id,
    costBasis: row.cost_basis, originalCostUsd: original, reservedUsd: money(row.reservation?.usd),
    settledCostUsd: null, attestedCostUsd: null, accountedCostUsd: intakeAccountedUsd(row),
    originalAccepted: row.acceptance === 'response_received', requiresCostEvidence: false,
    evidenceConflict: false, revision: 0, attestations: [], reader, chatId: row.chat_id,
    snapshotHash: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
  };
}

/** Intake readings by id, as call evidence. Only rows the caller's tenant role may read are returned. */
export async function intakeCallEvidence(tx: Kysely<Database>, ids: string[]): Promise<Map<string, CallCostEvidence>> {
  if (!ids.length) return new Map();
  const rows = (await sql<IntakeRow>`SELECT id, client_id, chat_id, update_id::text, model, served_model, status, acceptance,
      cost_basis, cost_usd::text, reservation, to_jsonb(started_at) #>> '{}' AS started, provider_request_id, response_id, diagnostic
    FROM hawa.requester_intent_calls WHERE tenant_id = hawa.current_tenant_id() AND id = ANY(${ids}::uuid[])`.execute(tx)).rows;
  return new Map(rows.map((row) => [row.id, intakeEvidence(row)]));
}

/**
 * One page of call keys, newest first: the SQL page of the attestable kinds merged with the intake
 * router's rows under the same (startedAt, kind, id) order, so a cursor from either source is exact.
 */
export async function officeCallPage(tx: Kysely<Database>, before: { startedAt: string; kind: string; id: string } | null):
  Promise<Array<{ kind: string; id: string; startedAt: string }>> {
  const time = before?.startedAt ?? null, kind = before?.kind ?? null, id = before?.id ?? null;
  return (await sql<{ page: Array<{ kind: string; id: string; startedAt: string }> }>`
    WITH merged AS (
      SELECT p.kind, p.id, p."startedAt" AS started_at
        FROM jsonb_to_recordset(hawa.office_call_cost_page(${time}::timestamptz, ${kind}, ${id}::uuid)) AS p(kind text, id uuid, "startedAt" timestamptz)
      UNION ALL
      SELECT 'intake_router', c.id, c.started_at FROM hawa.requester_intent_calls c
        WHERE c.tenant_id = hawa.current_tenant_id()
          AND (${time}::timestamptz IS NULL OR (c.started_at, 'intake_router'::text, c.id) < (${time}::timestamptz, ${kind}::text, ${id}::uuid))
    ), page AS (SELECT * FROM merged ORDER BY started_at DESC, kind DESC, id DESC LIMIT 51)
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'startedAt', started_at)
      ORDER BY started_at DESC, kind DESC, id DESC), '[]'::jsonb) AS page FROM page`.execute(tx)).rows[0].page;
}

export const SUMMARY_MAX_DAYS = 92;

/**
 * Spend by office day and budget role over the last `days` office days, today included. The caller's
 * transaction carries its tenant scope; the evaluation ledger is readable by administrators and
 * operators only, so the route refuses other roles rather than show a total missing a ledger.
 */
export async function officeSpendingSummary(tx: Kysely<Database>, days: number): Promise<SpendingSummary> {
  if (!Number.isSafeInteger(days) || days < 1 || days > SUMMARY_MAX_DAYS) throw new RangeError('SUMMARY_DAYS_INVALID');
  const window = (await sql<{ from: string; to: string; since: Date }>`SELECT
      ((clock_timestamp() AT TIME ZONE 'Asia/Baghdad')::date - ${days - 1}::int)::text AS "from",
      (clock_timestamp() AT TIME ZONE 'Asia/Baghdad')::date::text AS "to",
      (((clock_timestamp() AT TIME ZONE 'Asia/Baghdad')::date - ${days - 1}::int)::timestamp AT TIME ZONE 'Asia/Baghdad') AS since`.execute(tx)).rows[0];
  const rows = (await sql<{ day: string; role: string; calls: number; usd: string | null; awaiting: number; held: string | null }>`
    WITH keys AS (
      SELECT 'studio'::text AS kind, c.id, c.started_at AS at, coalesce(c.budget_role, hawa.studio_budget_role(c.stage)) AS role
        FROM hawa.design_studio_calls c WHERE c.tenant_id = hawa.current_tenant_id() AND c.started_at >= ${window.since}
      UNION ALL SELECT 'evaluation', c.id, c.started_at, c.role::text
        FROM hawa.eval_model_calls c WHERE c.tenant_id = hawa.current_tenant_id() AND c.started_at >= ${window.since}
      UNION ALL SELECT 'health_probe', c.id, c.started_at, 'health_probe'
        FROM hawa.paid_model_probe_calls c WHERE c.tenant_id = hawa.current_tenant_id() AND c.started_at >= ${window.since}
      UNION ALL SELECT 'canva_planner', p.id, coalesce(c.started_at, p.created_at), 'creative_director'
        FROM hawa.canva_design_plans p LEFT JOIN hawa.canva_planner_calls c ON c.id = p.id AND c.tenant_id = p.tenant_id
        WHERE p.tenant_id = hawa.current_tenant_id() AND (c.id IS NOT NULL OR p.paid_protocol IS NULL)
          AND coalesce(c.started_at, p.created_at) >= ${window.since}
      UNION ALL SELECT 'voice', v.id, v.received_at, 'voice_transcriber'
        FROM hawa.inbox_events v WHERE v.tenant_id = hawa.current_tenant_id() AND v.integration_id IS NULL
          AND v.source_account_id = 'lifecycle_voice_attempt' AND v.event_kind = 'lifecycle_voice_attempt' AND v.received_at >= ${window.since}
    ), costed AS (
      SELECT k.role, (k.at AT TIME ZONE 'Asia/Baghdad')::date AS day, hawa.office_call_cost_evidence(k.kind, k.id) AS e FROM keys k
    )
    SELECT day::text, role, count(*)::int AS calls, sum((e ->> 'accountedCostUsd')::numeric)::text AS usd,
      (count(*) FILTER (WHERE (e ->> 'requiresCostEvidence')::boolean))::int AS awaiting,
      coalesce(sum(greatest(0, coalesce((e ->> 'reservedUsd')::numeric, 0) - (e ->> 'accountedCostUsd')::numeric))
        FILTER (WHERE (e ->> 'requiresCostEvidence')::boolean), 0)::text AS held
      FROM costed WHERE e IS NOT NULL GROUP BY day, role
    UNION ALL
    SELECT (c.started_at AT TIME ZONE 'Asia/Baghdad')::date::text, 'intake_router', count(*)::int,
      sum(CASE WHEN c.cost_basis IN ('usage', 'not_accepted') AND c.cost_usd IS NOT NULL THEN c.cost_usd
        ELSE (c.reservation ->> 'usd')::numeric END)::text, 0, '0'
      FROM hawa.requester_intent_calls c WHERE c.tenant_id = hawa.current_tenant_id() AND c.started_at >= ${window.since}
      GROUP BY 1`.execute(tx)).rows;

  const add = (into: Map<string, SpendingRoleTotal>, role: string, calls: number, usd: number, awaiting: number, held: number) => {
    const t = into.get(role) ?? { role: role as SpendingRole, calls: 0, accountedUsd: 0, awaitingEvidence: 0, heldUsd: 0 };
    t.calls += calls; t.accountedUsd = Number((t.accountedUsd + usd).toFixed(6)); t.awaitingEvidence += awaiting;
    t.heldUsd = Number((t.heldUsd + held).toFixed(6));
    into.set(role, t);
  };
  const byDay = new Map<string, Map<string, SpendingRoleTotal>>(), byRole = new Map<string, SpendingRoleTotal>();
  for (const row of rows) {
    const usd = money(row.usd) ?? 0, held = money(row.held) ?? 0;
    if (!byDay.has(row.day)) byDay.set(row.day, new Map());
    add(byDay.get(row.day)!, row.role, row.calls, usd, row.awaiting, held);
    add(byRole, row.role, row.calls, usd, row.awaiting, held);
  }
  const sorted = (m: Map<string, SpendingRoleTotal>) => [...m.values()].sort((a, b) => b.accountedUsd - a.accountedUsd || a.role.localeCompare(b.role));
  const sum = (list: SpendingRoleTotal[]) => ({ calls: list.reduce((n, r) => n + r.calls, 0),
    accountedUsd: Number(list.reduce((n, r) => n + r.accountedUsd, 0).toFixed(6)) });
  const roleTotals = sorted(byRole);
  return {
    timezone: 'Asia/Baghdad', from: window.from, to: window.to,
    days: [...byDay.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([day, roles]) => {
      const list = sorted(roles);
      return { day, ...sum(list), roles: list };
    }),
    roles: roleTotals, ...sum(roleTotals),
  };
}
