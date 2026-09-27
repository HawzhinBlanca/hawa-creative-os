import { createHash, randomUUID } from 'node:crypto';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { summarizeAvailability } from '@hawa/domain';
import { availabilityTargetOrigin, parseAvailabilityObservation, SYSTEM_AUTOMATION_USER_ID,
  type AvailabilityObservation, type AvailabilityObservationReceipt, type ObservedOperationsReliabilityReport } from '@hawa/contracts';
import { restateAdminUrl } from './restate-probe.js';
import { canonicalJson } from '../core-helpers.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OTHER_KEYS = ['HAWA_API_KEY', 'HAWA_BEARER_TOKEN', 'HAWA_DESK_SECRET', 'HAWA_ADMIN_KEY', 'HAWA_REVIEWER_KEY',
  'HAWA_ART_DIRECTOR_KEY', 'HAWA_WORKER_TOKEN', 'HAWA_DEV_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'HAWA_ACTION_HMAC_SECRET'];
const REQUIRED_SERVICES = ['TaskWorkflow', 'TaskService', 'ChatInbox', 'Delivery', 'TelegramSender', 'RequestLifecycle', 'DesignRun', 'OfficeDecisionGateway'];
export interface AvailabilityConfig { monitorId: string; targetOrigin: string; scopeSha256: string; token: string; workerHealthUrls: string[] }
export function availabilityConfig(env: NodeJS.ProcessEnv = process.env): AvailabilityConfig | null {
  const monitorId = env.HAWA_AVAILABILITY_MONITOR_ID?.toLowerCase(), targetOrigin = availabilityTargetOrigin(env.HAWA_AVAILABILITY_TARGET_ORIGIN);
  const token = env.HAWA_AVAILABILITY_MONITOR_SECRET?.trim();
  if (!monitorId || !UUID.test(monitorId) || !targetOrigin || !token || token.length < 32 || OTHER_KEYS.some(k => env[k]?.trim() === token)) return null;
  const workerHealthUrls = (env.HAWA_AVAILABILITY_WORKER_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (workerHealthUrls.length > 4 || workerHealthUrls.some(value => {
    try { const u = new URL(value); return !['http:', 'https:'].includes(u.protocol) || !!(u.username || u.password || u.search || u.hash) || u.pathname !== '/health'; }
    catch { return true; }
  })) return null;
  const scopeSha256 = createHash('sha256').update(JSON.stringify(['office-readiness-v1', monitorId, targetOrigin])).digest('hex');
  return { monitorId, targetOrigin, scopeSha256, token, workerHealthUrls };
}
export class AvailabilityError extends Error {
  constructor(public status: 400 | 403 | 409 | 503, message: string) { super(message); }
}
type Actor = { tenantId: string; userId: string; role: string };
type ObservationRow = { id: string; monitor_id: string; slot_start: Date; observed_at: Date; payload: AvailabilityObservation; payload_sha256: string; received_at: Date };
const receipt = (row: ObservationRow, replayed: boolean): AvailabilityObservationReceipt => ({ observationId: row.id, monitorId: row.monitor_id,
  slotStart: row.slot_start.toISOString(), payloadSha256: row.payload_sha256,
  observationSha256: createHash('sha256').update(canonicalJson(row.payload)).digest('hex'), recordedAt: row.received_at.toISOString(), replayed });

export async function recordAvailabilityObservation(db: Kysely<Database>, tenantId: string, config: AvailabilityConfig, value: unknown): Promise<AvailabilityObservationReceipt> {
  const observation = parseAvailabilityObservation(value);
  if (!observation) throw new AvailabilityError(400, 'The observation is incomplete or malformed.');
  if (observation.monitorId !== config.monitorId || observation.targetOrigin !== config.targetOrigin)
    throw new AvailabilityError(409, 'The observation belongs to another configured monitor or target.');
  return withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async tx => {
    const time = (await sql<{ valid: boolean }>`SELECT ${observation.observedAt}::timestamptz<=now()+interval '10 seconds'
      AND ${observation.observedAt}::timestamptz>=now()-interval '400 days'
      AND (${observation.completedAt}::timestamptz IS NULL OR ${observation.completedAt}::timestamptz<=now()+interval '10 seconds') AS valid`.execute(tx)).rows[0];
    if (!time.valid) throw new AvailabilityError(400, 'The observation clock is outside the accepted retention window.');
    const body = JSON.stringify(observation);
    const saved = (await sql<ObservationRow>`INSERT INTO hawa.availability_observations
      (tenant_id,id,monitor_id,scope_sha256,slot_start,observed_at,payload,payload_sha256)
      VALUES(${tenantId}::uuid,${observation.observationId}::uuid,${config.monitorId}::uuid,${config.scopeSha256},
        ${observation.slotStart}::timestamptz,${observation.observedAt}::timestamptz,${body}::jsonb,${'0'.repeat(64)})
      ON CONFLICT DO NOTHING RETURNING *`.execute(tx)).rows[0];
    if (saved) return receipt(saved, false);
    const existing = (await sql<ObservationRow & { same: boolean }>`SELECT *,payload=${body}::jsonb AS same FROM hawa.availability_observations
      WHERE tenant_id=${tenantId}::uuid AND id=${observation.observationId}::uuid AND monitor_id=${config.monitorId}::uuid AND scope_sha256=${config.scopeSha256}`.execute(tx)).rows[0];
    if (!existing?.same) throw new AvailabilityError(409, 'This observation identity or minute slot already has different immutable evidence.');
    return receipt(existing, true);
  });
}

export async function readAvailabilityReport(db: Kysely<Database>, actor: Actor, config: AvailabilityConfig, month?: string): Promise<ObservedOperationsReliabilityReport> {
  if (month !== undefined && !/^(20\d{2})-(0[1-9]|1[0-2])$/.test(month)) throw new AvailabilityError(400, 'Use a calendar month in YYYY-MM form.');
  return db.transaction().setIsolationLevel('repeatable read').execute(tx => withRlsContext(tx, actor, async tx => {
    const window = (await sql<{ allowed: boolean; month: string; start_at: Date; end_at: Date; checked_at: Date; current_month: string }>`
      WITH selected AS (SELECT coalesce(${month ?? null},to_char(now() AT TIME ZONE 'Asia/Baghdad','YYYY-MM')) AS month)
      SELECT hawa.is_tenant_member(${actor.tenantId}::uuid) AS allowed,month,
        (month||'-01')::timestamp AT TIME ZONE 'Asia/Baghdad' AS start_at,
        ((month||'-01')::timestamp+interval '1 month') AT TIME ZONE 'Asia/Baghdad' AS end_at,
        now() AS checked_at,to_char(now() AT TIME ZONE 'Asia/Baghdad','YYYY-MM') AS current_month FROM selected`.execute(tx)).rows[0];
    if (!window.allowed) throw new AvailabilityError(403, 'Active office membership is required to read availability evidence.');
    if (window.month > window.current_month) throw new AvailabilityError(400, 'A future month has no availability observations.');
    const rows = (await sql<ObservationRow>`SELECT * FROM hawa.availability_observations WHERE tenant_id=${actor.tenantId}::uuid
      AND monitor_id=${config.monitorId}::uuid AND scope_sha256=${config.scopeSha256}
      AND slot_start>=${window.start_at} AND slot_start<${window.end_at} ORDER BY slot_start LIMIT 46080`.execute(tx)).rows;
    const latest = (await sql<{ observed_at: Date; received_at: Date }>`SELECT observed_at,received_at FROM hawa.availability_observations
      WHERE tenant_id=${actor.tenantId}::uuid AND monitor_id=${config.monitorId}::uuid AND scope_sha256=${config.scopeSha256}
      ORDER BY slot_start DESC LIMIT 1`.execute(tx)).rows[0];
    const parsed = rows.map(row => parseAvailabilityObservation(row.payload));
    if (parsed.some(r => !r)) throw new AvailabilityError(503, 'Stored availability evidence is not readable.');
    return summarizeAvailability(parsed as AvailabilityObservation[], { month: window.month, startAt: window.start_at.toISOString(),
      endAt: window.end_at.toISOString(), now: window.checked_at.toISOString() }, { id: config.monitorId, targetOrigin: config.targetOrigin,
      scopeSha256: config.scopeSha256, latest: latest ? { observedAt: latest.observed_at.toISOString(), receivedAt: latest.received_at.toISOString() } : null });
  }));
}

/** Every successful storage probe rolls back, including the isolated write/read/update witness. */
async function storageReady(db: Kysely<Database> | null, tenantId: string): Promise<boolean> {
  if (!db) return false;
  const success = new Error('rollback readiness witness');
  try {
    await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async tx => {
      await sql`SET LOCAL statement_timeout='2000ms'`.execute(tx);
      await sql`SELECT id FROM hawa.tasks WHERE tenant_id=${tenantId}::uuid LIMIT 1`.execute(tx);
      await sql`SELECT request_id FROM hawa.requests WHERE tenant_id=${tenantId}::uuid LIMIT 1`.execute(tx);
      await sql`SELECT id FROM hawa.approvals WHERE tenant_id=${tenantId}::uuid LIMIT 1`.execute(tx);
      const id = randomUUID();
      await sql`INSERT INTO hawa.availability_probe_values(tenant_id,id,phase) VALUES(${tenantId}::uuid,${id}::uuid,1)`.execute(tx);
      const read = (await sql<{ phase: number }>`SELECT phase FROM hawa.availability_probe_values WHERE tenant_id=${tenantId}::uuid AND id=${id}::uuid`.execute(tx)).rows[0];
      if (read?.phase !== 1) throw new Error('Readiness witness could not be read');
      const updated = (await sql<{ phase: number }>`UPDATE hawa.availability_probe_values SET phase=2 WHERE tenant_id=${tenantId}::uuid AND id=${id}::uuid RETURNING phase`.execute(tx)).rows[0];
      if (updated?.phase !== 2) throw new Error('Readiness witness could not be updated');
      throw success;
    });
  } catch (error) { return error === success; }
  return false;
}
async function boundedJson(url: string, fetcher: typeof fetch): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(2500), headers: { 'Cache-Control': 'no-store' } });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 131072) return null; chunks.push(value); } }
    finally { await reader.cancel().catch(() => undefined); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
export async function probeOfficeReadiness(db: Kysely<Database> | null, tenantId: string, config: AvailabilityConfig,
  env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
  const admin = restateAdminUrl(env);
  const [storage, services, workers] = await Promise.all([storageReady(db, tenantId),
    admin && env.RESTATE_INGRESS_URL ? boundedJson(admin + '/services', fetcher) : null,
    Promise.all(config.workerHealthUrls.map(url => boundedJson(url, fetcher)))]);
  const names = new Set(Array.isArray(services?.services) ? services.services.flatMap(s => s && typeof s === 'object' && 'name' in s ? [s.name] : []) : []);
  const registered = REQUIRED_SERVICES.every(name => names.has(name));
  const worker = workers.some(w => {
    const dependencies = w?.dependencies as Record<string, unknown> | undefined, outbox = w?.outbox as Record<string, unknown> | undefined;
    return w && ['healthy', 'degraded'].includes(String(w.status)) && dependencies?.postgres === 'connected' && w.outboxActive === true &&
      ['live', 'always'].includes(String(w.background)) && Array.isArray(w.tenantsWithoutAutomationMembership) && w.tenantsWithoutAutomationMembership.length === 0 && outbox?.staleOver5m === 0;
  });
  return { ready: storage && registered && worker, intakeStorage: storage, reviewStorage: storage, workflowRegistration: registered, activeWorker: worker };
}
