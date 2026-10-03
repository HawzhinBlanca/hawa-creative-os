/**
 * What production's own work says about the model provider and the pipeline (ADR-288).
 *
 * With the paid probe switched off (HAWA_BILLING_PROBE_ENABLED, ADR-158) /v1/health said
 * `modelProvider: "disabled"` and `lastVerifiedProgressAt: null` while the office's requests were
 * drafted by the production models every day: "disabled" described the probe, not the provider, and
 * "verified progress" was only ever a probe. Every production model call is already recorded, with
 * whether the provider answered, in one of three ledgers; this reads them. No call is made.
 */
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';

export interface ModelCallEvidence {
  source: 'production_calls';
  /** The calls this window holds decide the status. */
  windowHours: number;
  recentCalls: number;
  recentAnswered: number;
  /** The newest call the provider answered (2xx with a response), within the last 7 days. */
  lastAnsweredAt: string | null;
  /** The newest call the provider refused or left unanswered, within the last 7 days, and its code. */
  lastFailedAt: string | null;
  lastFailure: string | null;
}

/**
 * `connected`: of the window's calls, at least one of the newest three was answered. `failing`: the
 * newest three (or all, when fewer) were refused or unanswered. `idle`: no call in the window, which
 * says nothing either way and is not degraded.
 */
export type PassiveModelStatus = 'connected' | 'failing' | 'idle';

/** How many newest calls must all fail before the provider reads as failing. */
const FAILING_RUN = 3;

interface CallRow { at: Date; answered: boolean; code: string | null }

export function passiveModelStatus(recent: Pick<CallRow, 'answered'>[]): PassiveModelStatus {
  if (!recent.length) return 'idle';
  return recent.slice(0, FAILING_RUN).some((c) => c.answered) ? 'connected' : 'failing';
}

export async function readProgressEvidence(db: Kysely<Database>, scope: { tenantId: string; userId: string },
  windowHours = 24): Promise<{ modelCalls: ModelCallEvidence; modelStatus: PassiveModelStatus; lastDraftAt: string | null }> {
  return withRlsContext(db, { tenantId: scope.tenantId, userId: scope.userId, role: 'operator' }, async (trx) => {
    // Finished calls only: one still running has no outcome yet. The ledgers' own words for an answer:
    // a studio call `ok`; a planner or intent call whose provider sent a 2xx (`response_received`).
    const calls = (await sql<{ at: Date; answered: boolean; code: string | null }>`
      SELECT at, answered, code FROM (
        SELECT COALESCE(finished_at, started_at) AS at, status = 'ok' AS answered, error_code AS code
          FROM hawa.design_studio_calls
         WHERE tenant_id = ${scope.tenantId}::uuid AND status IN ('ok', 'error', 'uncertain')
           AND started_at >= now() - interval '7 days'
        UNION ALL
        SELECT finished_at, acceptance = 'response_received', diagnostic
          FROM hawa.canva_planner_calls
         WHERE tenant_id = ${scope.tenantId}::uuid AND status = 'completed' AND finished_at IS NOT NULL
           AND started_at >= now() - interval '7 days'
        UNION ALL
        SELECT finished_at, acceptance = 'response_received', diagnostic
          FROM hawa.requester_intent_calls
         WHERE tenant_id = ${scope.tenantId}::uuid AND status = 'completed' AND finished_at IS NOT NULL
           AND started_at >= now() - interval '7 days'
      ) c ORDER BY at DESC LIMIT 200`.execute(trx)).rows.map((r) => ({ ...r, at: new Date(r.at) }));
    const nowMs = new Date((await sql<{ now: Date }>`SELECT now() AS now`.execute(trx)).rows[0].now).getTime();
    const recent = calls.filter((c) => c.at.getTime() >= nowMs - windowHours * 3_600_000);
    const answered = calls.find((c) => c.answered);
    const failed = calls.find((c) => !c.answered);
    const lastDraft = (await sql<{ at: Date | null }>`SELECT max(created_at) AS at FROM hawa.canva_bindings
      WHERE tenant_id = ${scope.tenantId}::uuid`.execute(trx)).rows[0]?.at ?? null;
    return {
      modelCalls: {
        source: 'production_calls', windowHours, recentCalls: recent.length,
        recentAnswered: recent.filter((c) => c.answered).length,
        lastAnsweredAt: answered ? answered.at.toISOString() : null,
        lastFailedAt: failed ? failed.at.toISOString() : null,
        lastFailure: failed?.code ?? null,
      },
      modelStatus: passiveModelStatus(recent),
      lastDraftAt: lastDraft ? new Date(lastDraft).toISOString() : null,
    };
  });
}

/** The newest of several ISO times, or null when none is known. */
export function latestOf(...times: Array<string | null | undefined>): string | null {
  const known = times.filter((t): t is string => typeof t === 'string' && Number.isFinite(Date.parse(t)));
  return known.length ? known.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}
