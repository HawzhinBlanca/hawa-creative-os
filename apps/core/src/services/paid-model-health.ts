import { createHash } from 'node:crypto';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';

export type PaidModelProbeResult = 'connected' | 'unauthorized' | 'billing_exhausted' |
  'rate_limited' | 'unreachable' | 'http_error';

export interface PaidModelObservation {
  schema_version: number;
  config_sha256: string;
  status: PaidModelProbeResult;
  observed_at: Date;
}

export interface PaidModelHealth {
  status: PaidModelProbeResult | 'unconfigured' | 'unverified' | 'stale' | 'unknown' | 'budget_held' | 'reconciliation_required';
  observedStatus: PaidModelProbeResult | null;
  at: string | null;
  schemaVersion: number | null;
  spendingStatus?: import('./paid-model-probe.js').ProbeSpendingState;
  callId?: string | null;
}

/** A fingerprint binds a paid probe to the configured credential and model without retaining either. */
export function paidModelConfigFingerprint(key: string, model: string): string {
  return createHash('sha256').update('hawa-paid-model-probe-v1\0').update(key).update('\0').update(model).digest('hex');
}

/** A 2xx response without a completion and positive token usage is not paid verification. */
export function isBillableChatCompletion(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const value = body as Record<string, unknown>;
  const usage = value.usage as Record<string, unknown> | null | undefined;
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.model === 'string' && value.model.length > 0
    && Array.isArray(value.choices) && value.choices.length > 0
    && usage !== null && typeof usage === 'object'
    && typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)
    && usage.total_tokens > 0;
}

export function evaluatePaidModelHealth(
  observation: PaidModelObservation | null,
  configSha256: string | null,
  enabled: boolean,
  maxAgeMs: number,
  now: number = Date.now(),
): PaidModelHealth {
  const empty = (status: PaidModelHealth['status']): PaidModelHealth =>
    ({ status, observedStatus: null, at: null, schemaVersion: null });
  if (!configSha256) return empty('unconfigured');
  if (!enabled) return empty('unverified');
  if (!observation) return empty('unverified');
  if (observation.schema_version !== 1 || observation.config_sha256 !== configSha256) return empty('unverified');
  const at = observation.observed_at.getTime();
  if (!Number.isFinite(at) || at > now + 60_000) return empty('unknown');
  return {
    status: now - at > maxAgeMs ? 'stale' : observation.status,
    observedStatus: observation.status,
    at: observation.observed_at.toISOString(),
    schemaVersion: observation.schema_version,
  };
}

export async function recordPaidModelObservation(
  db: Kysely<Database>,
  tenantId: string,
  userId: string,
  configSha256: string,
  status: PaidModelProbeResult,
): Promise<void> {
  await withRlsContext(db, { tenantId, userId, role: 'operator' }, (trx) =>
    sql`INSERT INTO hawa.paid_model_health_observations
      (tenant_id, provider, schema_version, config_sha256, status)
      VALUES (${tenantId}::uuid, 'openai', 1, ${configSha256}, ${status})`.execute(trx).then(() => undefined));
}

export async function readLatestPaidModelObservation(
  db: Kysely<Database>, tenantId: string, userId: string,
): Promise<PaidModelObservation | null> {
  return withRlsContext(db, { tenantId, userId, role: 'operator' }, async (trx) =>
    (await sql<PaidModelObservation>`SELECT schema_version, config_sha256, status, observed_at
      FROM hawa.paid_model_health_observations
      WHERE tenant_id = ${tenantId}::uuid AND provider = 'openai'
      ORDER BY observed_at DESC, id DESC LIMIT 1`.execute(trx)).rows[0] ?? null);
}
