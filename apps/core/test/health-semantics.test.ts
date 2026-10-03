import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { PRIMARY_OPERATOR_USER_ID } from '@hawa/contracts';
import { createApp } from '../src/app.js';

/**
 * What production's /v1/health says (ADR-158, audit 2026-09-30 C1 and P2 "Health always degraded").
 *
 * - The paid probe switched off (HAWA_BILLING_PROBE_ENABLED unset) read "unverified", with a probe
 *   "every 30 minutes" that never ran, and made production "degraded" for good. It is "disabled" now,
 *   with no interval, and not degraded.
 * - Canva's "unverified" made production degraded too, though no Canva probe exists to verify it.
 * - lastVerifiedProgressAt was Core's boot time; it is null until a paid probe was actually sent.
 * - Flags said DESIGN_PIPELINE_V3 "off" while two chats ran v3 through DESIGN_PIPELINE_V3_CHATS; the
 *   count of enrolled chats is shown, never their ids.
 */
const TENANT = '00000000-0000-4000-a000-000000000001';
const db = createDb(process.env.TEST_DATABASE_URL!);
const asOperator = <T>(f: (trx: any) => Promise<T>) => withRlsContext(db, { tenantId: TENANT, userId: PRIMARY_OPERATOR_USER_ID, role: 'operator' }, f);
let prior: { status: string } | undefined;

beforeAll(async () => {
  // Designs transfer as the Primary Operator: an active connection is what an office in order has.
  prior = await asOperator(async (trx) => (await sql<any>`SELECT status FROM hawa.canva_connections
    WHERE tenant_id = ${TENANT}::uuid AND actor_id = ${PRIMARY_OPERATOR_USER_ID}`.execute(trx)).rows[0]);
  await asOperator((trx) => sql`INSERT INTO hawa.canva_connections(tenant_id, actor_id, encrypted_tokens, expires_at, status, generation)
    VALUES (${TENANT}::uuid, ${PRIMARY_OPERATOR_USER_ID}, 'health-semantics-placeholder', now() + interval '1 hour', 'active', gen_random_uuid())
    ON CONFLICT (tenant_id, actor_id) DO UPDATE SET status = 'active'`.execute(trx));
});
afterAll(async () => {
  await asOperator((trx) => prior
    ? sql`UPDATE hawa.canva_connections SET status = ${prior.status} WHERE tenant_id = ${TENANT}::uuid AND actor_id = ${PRIMARY_OPERATOR_USER_ID}`.execute(trx)
    : sql`DELETE FROM hawa.canva_connections WHERE tenant_id = ${TENANT}::uuid AND actor_id = ${PRIMARY_OPERATOR_USER_ID}`.execute(trx));
  await db.destroy();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

function production(env: Record<string, string> = {}) {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('OPENAI_API_KEY', ['health', 'semantics', 'key', String(Math.random())].join('-'));
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  vi.stubEnv('DESIGN_PIPELINE_V3', '');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

describe('/v1/health in production', () => {
  it('with the paid probe off and no production call: the probe "disabled", the provider "idle", no invented progress, not degraded', async () => {
    production({ DESIGN_PIPELINE_V3_CHATS: ' -1001234, 5550001,-1001234,, ' });
    const res = await createApp({ db, enableBillingProbeSchedule: false }).request('/v1/health');
    const body = await res.json();
    // ADR-288: "disabled" is the probe's state; the provider is read from production's own calls.
    expect(body.dependencies.modelProvider).toBe('idle');
    expect(body.modelCalls).toMatchObject({ source: 'production_calls', recentCalls: 0, lastAnsweredAt: null });
    expect(body.lastPaidProbe).toMatchObject({ status: 'disabled', everyMinutes: null, at: null });
    expect(body.lastVerifiedProgressAt).toBeNull();
    expect(body.dependencies.canva).toBe('unverified');
    expect(body.status, JSON.stringify(body.dependencies)).toBe('healthy');
    expect(body.flags).toMatchObject({ DESIGN_PIPELINE_V3: 'off', DESIGN_PIPELINE_V3_CHATS: 2 });
    expect(JSON.stringify(body)).not.toMatch(/1001234|5550001/);
  });

  it('with the paid probe scheduled but not yet answered: "unverified", its interval, and degraded', async () => {
    production();
    vi.useFakeTimers(); // the schedule's timers are created, never fired
    const app = createApp({ db, enableBillingProbeSchedule: true, skipPaidModelProbe: false });
    vi.useRealTimers();
    const body = await (await app.request('/v1/health')).json();
    expect(body.dependencies.modelProvider).toBe('unverified');
    expect(body.lastPaidProbe).toMatchObject({ status: 'unverified', everyMinutes: 30 });
    expect(body.status).toBe('degraded');
    expect(body.flags.DESIGN_PIPELINE_V3_CHATS).toBe(0);
  });
});

/**
 * ADR-288: with the probe off, the provider's status and the last verified progress come from the calls
 * production made (here a requester-intent call; the studio and planner ledgers are read the same way).
 */
describe('/v1/health reads the model provider from production calls when the probe is off', () => {
  const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
  const intentCall = (minutesAgo: number, answered: boolean) => owner.transaction().execute(async (trx) => {
    await sql`SET LOCAL session_replication_role = replica`.execute(trx);
    await sql`INSERT INTO hawa.requester_intent_calls (tenant_id, update_id, chat_id, client_id, model, request_sha256, reservation,
        started_at, status, finished_at, acceptance, diagnostic)
      VALUES (${TENANT}::uuid, ${Math.floor(Math.random() * 1e12) + 1}, '7000001', ${'c1000000-0000-4000-8000-000000000002'}::uuid,
        'gpt-test', ${'b'.repeat(64)}, '{}'::jsonb, now() - make_interval(mins => ${minutesAgo + 1}), 'completed',
        now() - make_interval(mins => ${minutesAgo}), ${answered ? 'response_received' : 'not_accepted'}, ${answered ? 'MODEL_HTTP_200' : 'MODEL_HTTP_429'})`.execute(trx);
  });
  afterAll(async () => { await owner.destroy(); });

  it('an answered call: connected, and it is the last verified progress', async () => {
    await intentCall(30, true);
    production();
    const body = await (await createApp({ db, enableBillingProbeSchedule: false }).request('/v1/health')).json();
    expect(body.dependencies.modelProvider).toBe('connected');
    expect(body.lastPaidProbe.status).toBe('disabled');
    expect(body.modelCalls).toMatchObject({ recentCalls: 1, recentAnswered: 1, lastFailure: null });
    expect(body.lastVerifiedProgressAt).toBe(body.modelCalls.lastAnsweredAt);
    expect(Date.now() - Date.parse(body.lastVerifiedProgressAt)).toBeGreaterThan(29 * 60_000);
    expect(body.status, JSON.stringify(body.dependencies)).toBe('healthy');
  });

  it('the newest three refused: failing, degraded, with the refusal named', async () => {
    for (const m of [3, 2, 1]) await intentCall(m, false);
    production();
    const body = await (await createApp({ db, enableBillingProbeSchedule: false }).request('/v1/health')).json();
    expect(body.dependencies.modelProvider).toBe('failing');
    expect(body.modelCalls).toMatchObject({ recentCalls: 4, recentAnswered: 1, lastFailure: 'MODEL_HTTP_429' });
    expect(body.status).toBe('degraded');
  });
});
