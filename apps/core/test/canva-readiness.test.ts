import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PRIMARY_OPERATOR_USER_ID, SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { CanvaConnectClient } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { CanvaFlowError } from '../src/services/canva-flow-error.js';
import { CanvaReadinessProbe, type CanvaReadiness } from '../src/services/canva-readiness.js';

/**
 * ADR-288: Canva is asked whether it honours the office's connection (free GET /users/me after the
 * guarded token refresh), the answer is kept for ten minutes, and the office hears once when it stops.
 */
const TENANT = '00000000-0000-4000-a000-000000000001';
const db = createDb(process.env.TEST_DATABASE_URL!);
const asOperator = <T>(f: (trx: any) => Promise<T>) => withRlsContext(db, { tenantId: TENANT, userId: PRIMARY_OPERATOR_USER_ID, role: 'operator' }, f);
const OFFICE = ['7100001', '7100002'];

async function connection(status: string, generation = randomUUID()) {
  await asOperator((trx) => sql`INSERT INTO hawa.canva_connections(tenant_id, actor_id, encrypted_tokens, expires_at, status, generation)
    VALUES (${TENANT}::uuid, ${PRIMARY_OPERATOR_USER_ID}, 'readiness-placeholder', now() + interval '1 hour', ${status}, ${generation}::uuid)
    ON CONFLICT (tenant_id, actor_id) DO UPDATE SET status = excluded.status, generation = excluded.generation`.execute(trx));
  return generation;
}
const alerts = () => withRlsContext(db, { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) =>
  (await sql<{ idempotency_key: string; payload: any }>`SELECT idempotency_key, payload FROM hawa.outbox_commands
    WHERE tenant_id = ${TENANT}::uuid AND idempotency_key LIKE 'notify.office:canva-readiness:%' ORDER BY idempotency_key`.execute(trx)).rows);

function harness(answers: Array<number | Error>, authorize?: () => never) {
  let clock = Date.parse('2026-10-03T08:00:00Z');
  const calls = { users: 0 };
  const service = {
    configuration: () => ({ configured: true }),
    authorizedClient: async () => {
      if (authorize) authorize();
      return { probeCurrentUser: async () => {
        calls.users += 1;
        const next = answers.length > 1 ? answers.shift()! : answers[0];
        if (next instanceof Error) throw next;
        return { status: next };
      } };
    },
  };
  const probe = new CanvaReadinessProbe({ db, service, tenantId: TENANT, actorId: PRIMARY_OPERATOR_USER_ID,
    officeChatIds: () => OFFICE, now: () => clock });
  return { probe, calls, advance: (minutes: number) => { clock += minutes * 60_000; } };
}

beforeEach(async () => {
  await withRlsContext(db, { tenantId: TENANT, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
    sql`DELETE FROM hawa.outbox_commands WHERE tenant_id = ${TENANT}::uuid AND idempotency_key LIKE 'notify.office:canva-readiness:%'`.execute(trx));
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await db.destroy(); });

describe('Canva readiness probe', () => {
  it('connected: one request, kept for ten minutes, asked again after', async () => {
    await connection('active');
    const h = harness([200]);
    expect(await h.probe.current()).toMatchObject({ status: 'connected', detail: null });
    h.advance(9);
    expect((await h.probe.current()).status).toBe('connected');
    expect(h.calls.users).toBe(1);
    h.advance(2);
    await h.probe.current();
    await h.probe.check();
    expect(h.calls.users).toBe(2);
    expect(await alerts()).toEqual([]);
  });

  it('a 403 is an honoured token without that scope: connected', async () => {
    await connection('active');
    expect((await harness([403]).probe.check()).status).toBe('connected');
  });

  it('revoked: every office member hears once per connection, and again after a reconnect is revoked', async () => {
    const first = await connection('active');
    const h = harness([401]);
    expect((await h.probe.check()).status).toBe('revoked');
    h.advance(11);
    await h.probe.check();
    let sent = await alerts();
    expect(sent.map((a) => a.idempotency_key)).toEqual([
      `notify.office:canva-readiness:revoked:${first}`, `notify.office:canva-readiness:revoked:${first}:${OFFICE[1]}`]);
    expect(sent.map((a) => a.payload.chatId).sort()).toEqual(OFFICE);
    expect(sent[0].payload.message.text).toMatch(/^Canva refused Hawa's connection/);
    expect(sent[0].payload.message.text).toMatch(/connect Canva again in Hawa Desk/);

    const second = await connection('active');
    h.advance(11);
    await h.probe.check();
    sent = await alerts();
    expect(sent).toHaveLength(4);
    expect(sent.some((a) => a.idempotency_key === `notify.office:canva-readiness:revoked:${second}`)).toBe(true);
  });

  it('expired: a connection that needs reconnecting, or a refresh Canva would not do, without asking Canva', async () => {
    const generation = await connection('reconnect_required');
    const h = harness([200]);
    expect(await h.probe.check()).toMatchObject({ status: 'expired', detail: 'The connection is reconnect required' });
    expect(h.calls.users).toBe(0);
    expect((await alerts()).map((a) => a.idempotency_key)[0]).toBe(`notify.office:canva-readiness:expired:${generation}`);

    await connection('active');
    const refused = harness([200], () => { throw new CanvaFlowError(409, 'CANVA_RECONNECT_REQUIRED', 'reconnect'); });
    expect((await refused.probe.check()).status).toBe('expired');
  });

  it('unreachable: one unanswered check keeps the last answer; a second reports it; 30 minutes alerts once a day', async () => {
    await connection('active');
    const h = harness([200, new TypeError('fetch failed'), new TypeError('fetch failed')]);
    expect((await h.probe.check()).status).toBe('connected');
    h.advance(11);
    const blip = await h.probe.check();
    expect(blip.status).toBe('connected');
    expect(blip.detail).toMatch(/did not answer the last check/);
    h.advance(3);
    expect((await h.probe.check()).status).toBe('unreachable');
    expect(await alerts()).toEqual([]);
    h.advance(30);
    await h.probe.check();
    h.advance(3);
    await h.probe.check();
    const sent = await alerts();
    expect(sent).toHaveLength(2);
    expect(sent[0].payload.message.text).toMatch(/not been able to reach Canva for more than 30 minutes/);
  });

  it('without office members nothing is written', async () => {
    await connection('reconnect_required');
    const probe = new CanvaReadinessProbe({ db, service: { configuration: () => ({ configured: true }),
      authorizedClient: async () => ({ probeCurrentUser: async () => ({ status: 200 }) }) },
      tenantId: TENANT, actorId: PRIMARY_OPERATOR_USER_ID, officeChatIds: () => [] });
    expect((await probe.check()).status).toBe('expired');
    expect(await alerts()).toEqual([]);
  });
});

describe('/v1/health shows what Canva said', () => {
  const answer = (status: CanvaReadiness['status']): { current(): Promise<CanvaReadiness> } => ({
    current: async () => ({ status, checkedAt: '2026-10-03T08:00:00.000Z', attemptedAt: '2026-10-03T08:00:00.000Z', detail: null }),
  });
  const read = async (status: CanvaReadiness['status']) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    vi.stubEnv('OPENAI_API_KEY', ['readiness', 'fixture', 'key'].join('-'));
    return (await createApp({ db, enableBillingProbeSchedule: false, canvaReadinessProbe: answer(status) }).request('/v1/health')).json();
  };

  it('connected is not degraded; revoked, expired and unreachable are', async () => {
    await connection('active');
    const connected = await read('connected');
    expect(connected.dependencies.canva).toBe('connected');
    expect(connected.canvaReadiness).toMatchObject({ status: 'connected', checkedAt: '2026-10-03T08:00:00.000Z' });
    expect(connected.status, JSON.stringify(connected.dependencies)).toBe('healthy');
    for (const bad of ['revoked', 'expired', 'unreachable'] as const) {
      const body = await read(bad);
      expect(body.dependencies.canva).toBe(bad);
      expect(body.status).toBe('degraded');
    }
  });
});

describe('CanvaConnectClient.probeCurrentUser', () => {
  it('is one GET /users/me with the bearer token, and reports the status', async () => {
    const seen: Array<{ url: string; method?: string; auth?: string }> = [];
    // Synthetic values for a mocked transport, built so no literal reads as a credential.
    const fixture = ['probe', 'fixture', 'value'].join('-');
    const client = new CanvaConnectClient({ accessToken: fixture, clientId: 'id', clientSecret: fixture,
      customFetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, method: init.method, auth: (init.headers as Record<string, string>).Authorization });
        return new Response('{"team_user":{"user_id":"u","team_id":"t"}}', { status: 401 });
      }) as typeof fetch });
    expect(await client.probeCurrentUser()).toEqual({ status: 401 });
    expect(seen).toEqual([{ url: 'https://api.canva.com/rest/v1/users/me', method: 'GET', auth: `Bearer ${fixture}` }]);
  });
});
