import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { createApp } from '../src/app.js';
import { evaluatePaidModelHealth, isBillableChatCompletion, paidModelConfigFingerprint, readLatestPaidModelObservation, recordPaidModelObservation } from '../src/services/paid-model-health.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const db = createDb(process.env.TEST_DATABASE_URL!);
const oldKey = process.env.OPENAI_API_KEY;
const oldModel = process.env.OPENAI_MODEL;
afterAll(async () => {
  if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = oldKey;
  if (oldModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = oldModel;
  await db.destroy();
});

// Create a reader with the schedule enabled, but without leaving a test probe timer running.
function healthReader() {
  vi.useFakeTimers();
  try { return createApp({ db, enableBillingProbeSchedule: true, skipPaidModelProbe: false, testAuth: { principal: { role: 'operator' } } }); }
  finally { vi.useRealTimers(); }
}

describe('paid provider observations', () => {
  it('retains the latest actual result across Core instances, without exposing credentials or provider errors', async () => {
    process.env.OPENAI_API_KEY = ['test', 'credential', 'one'].join('-');
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';
    const fingerprint = paidModelConfigFingerprint(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(String(input)).toBe('https://api.openai.com/v1/chat/completions');
      return new Response(JSON.stringify({ id: 'completion-test', model: 'gpt-4.1-mini', choices: [{}], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      createApp({ db, enableBillingProbeSchedule: true, skipPaidModelProbe: false });
      let recorded = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const latest = await readLatestPaidModelObservation(db, tenantId, SYSTEM_AUTOMATION_USER_ID);
        if (latest?.config_sha256 === fingerprint && latest.status === 'connected') { recorded = true; break; }
      }
      expect(recorded).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
    const first = await (await healthReader().request('/v1/health')).json();
    const restarted = await (await healthReader().request('/v1/health')).json();
    expect(first.dependencies.modelProvider).toBe('connected');
    expect(restarted.dependencies.modelProvider).toBe('connected');
    expect(restarted.lastPaidProbe).toMatchObject({ status: 'connected', observedStatus: 'connected', schemaVersion: 1 });
    expect(restarted.lastPaidProbe.at).toEqual(expect.any(String));
    const integrations = await (await healthReader().request('/v1/integrations/health')).json();
    expect(integrations.items.find((item: any) => item.integrationId === 'int_openai_model')).toMatchObject({
      state: 'paid_verified', reachability: 'reachable', paidVerification: 'paid_verified', lastVerifiedAt: restarted.lastPaidProbe.at,
    });
    expect(JSON.stringify(restarted)).not.toContain(process.env.OPENAI_API_KEY);
    expect(JSON.stringify(restarted)).not.toContain(fingerprint);

    await recordPaidModelObservation(db, tenantId, SYSTEM_AUTOMATION_USER_ID, fingerprint, 'billing_exhausted');
    const failed = await (await healthReader().request('/v1/health')).json();
    expect(failed.dependencies.modelProvider).toBe('billing_exhausted');
    expect(failed.status).toBe('degraded');
    const failedIntegrations = await (await healthReader().request('/v1/integrations/health')).json();
    expect(failedIntegrations.items.find((item: any) => item.integrationId === 'int_openai_model')).toMatchObject({
      state: 'billing_exhausted', paidVerification: 'failed', lastVerifiedAt: null,
    });
  });

  it('refuses a prior success after the key or model changes, or when scheduled probing is disabled', async () => {
    process.env.OPENAI_API_KEY = ['test', 'credential', 'two'].join('-');
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';
    const changedKey = await (await healthReader().request('/v1/health')).json();
    expect(changedKey.dependencies.modelProvider).toBe('unverified');
    expect(changedKey.lastPaidProbe.at).toBeNull();

    const fingerprint = paidModelConfigFingerprint(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL);
    await recordPaidModelObservation(db, tenantId, SYSTEM_AUTOMATION_USER_ID, fingerprint, 'connected');
    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    const changedModel = await (await healthReader().request('/v1/health')).json();
    expect(changedModel.dependencies.modelProvider).toBe('unverified');
    const disabled = await (await createApp({ db, enableBillingProbeSchedule: false }).request('/v1/health')).json();
    // A recorded success still proves nothing without a schedule; health says the probe is off (ADR-158).
    expect(disabled.dependencies.modelProvider).toBe('disabled');
  });

  it('ages evidence under a controlled clock and never treats a future or unknown version as connected', async () => {
    const key = paidModelConfigFingerprint('key', 'model');
    const observation = { schema_version: 1, config_sha256: key, status: 'connected' as const, observed_at: new Date('2026-09-25T00:00:00Z') };
    const at = observation.observed_at.getTime();
    expect(evaluatePaidModelHealth(observation, key, true, 60_000, at + 60_000).status).toBe('connected');
    expect(evaluatePaidModelHealth(observation, key, true, 60_000, at + 60_001)).toMatchObject({ status: 'stale', observedStatus: 'connected' });
    expect(evaluatePaidModelHealth(observation, key, true, 60_000, at - 60_001).status).toBe('unknown');
    expect(evaluatePaidModelHealth({ ...observation, schema_version: 2 }, key, true, 60_000, at).status).toBe('unverified');
    expect(evaluatePaidModelHealth(observation, key, false, 60_000, at).status).toBe('unverified');
  });

  it('refuses a successful HTTP status without a billable completion receipt', () => {
    expect(isBillableChatCompletion({ id: 'a', model: 'b', choices: [{}], usage: { total_tokens: 2 } })).toBe(true);
    expect(isBillableChatCompletion({ id: 'a', model: 'b', choices: [{}] })).toBe(false);
    expect(isBillableChatCompletion({ error: { message: 'limit' } })).toBe(false);
    expect(isBillableChatCompletion({ id: 'a', model: 'b', choices: [{}], usage: { total_tokens: 0 } })).toBe(false);
  });

  it('allows only append, and never hides a newer result behind an older success', async () => {
    const latest = await readLatestPaidModelObservation(db, tenantId, SYSTEM_AUTOMATION_USER_ID);
    expect(latest).not.toBeNull();
    await expect(withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, (trx) =>
      sql`UPDATE hawa.paid_model_health_observations SET status = 'connected' WHERE tenant_id = ${tenantId}::uuid`.execute(trx))).rejects.toThrow();
  });
});
