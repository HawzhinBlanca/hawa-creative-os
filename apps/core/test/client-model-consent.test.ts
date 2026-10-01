import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { resolveModel } from '@hawa/domain';
import { createApp } from '../src/app.js';
import { computeDnaHash } from '../src/core-helpers.js';
import { assertCurrentClientDesignReference } from '../src/services/client-design-reference.js';
import { createRequesterIntentModel, egressAllowed } from '../src/services/requester-intent-model.js';

/**
 * ADR-234: the owner said "yes turn on model reading for KAAE" (2026-10-01). In production KAAE's
 * active DNA (version 1) has no `privacy` block, and whether it is approved is unknown. The only DNA
 * writers (POST /dna, snapshots, rollback) save versions with approved_by NULL, so nothing short of
 * SQL could make egressAllowed() true. These run the real route, the real trusted-office identity
 * (as nginx presents the office in production) and the real egressAllowed() against the per-file test
 * database as hawa_app, under row-level security.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const OFFICE_ADMIN = '00000000-0000-4000-b000-000000000002';
const origin = 'http://127.0.0.1:8080';
const proof = 'c'.repeat(64);
const office = { 'Content-Type': 'application/json', 'X-Hawa-Office-Request': '1', 'X-Hawa-Office-Proof': proof, Origin: origin };
const url = `${origin}/v1/clients/${KAAE}/dna/model-consent`;

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const admin = { tenantId, userId: OFFICE_ADMIN, role: 'administrator' };

/** Production's KAAE DNA as GET /v1/clients/:id/dna shows it: the repository's file without its privacy block. */
const production = (() => {
  const file = JSON.parse(readFileSync(new URL('../../../config/clients/kaae.dna.json', import.meta.url), 'utf8'));
  delete file.privacy; delete file.contentHash;
  return { ...file, tenantId, clientId: KAAE, version: 1, status: 'active' } as Record<string, unknown>;
})();
const hashable = (dna: Record<string, unknown>) => { const h = { ...dna }; delete h.__commitMessage; delete h.__createdBy; return h; };
/** What a design read uses: everything but privacy, the version number and the commit metadata. */
const design = (dna: Record<string, unknown>) => { const d = hashable(dna); delete d.privacy; delete d.version; return d; };

const tokens = {
  'tok-operator': 'operator', 'tok-art': 'art_director', 'tok-test-admin': 'administrator',
  'tok-service-admin': { role: 'administrator', sub: SYSTEM_AUTOMATION_USER_ID },
  'tok-stranger-admin': { role: 'administrator', sub: randomUUID(), email: 'stranger@example.test' },
  'tok-named-admin': { role: 'administrator', sub: OFFICE_ADMIN, email: 'owner@example.test' },
};
const app = () => createApp({ db, extraBearerTokens: tokens } as any);
const post = (body: unknown, headers: Record<string, string> = office) =>
  app().request(url, { method: 'POST', headers, body: JSON.stringify(body) });
const bearer = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
const grant = { expectedVersion: 1, mode: 'approved_providers', providers: ['openai'], reason: 'Owner approved model reading for KAAE in chat on 2026-10-01' };

const versions = async () => (await sql<{ version: number; status: string; approved_by: string | null; created_by: string | null;
  content_hash: string; dna: Record<string, unknown> }>`SELECT version, status, approved_by, created_by, content_hash, dna
  FROM hawa.client_dna_versions WHERE client_id = ${KAAE}::uuid ORDER BY version`.execute(owner)).rows;
const audits = async () => (await sql<{ actor_id: string; action: string; reason: string; resource_id: string; before_hash: string;
  after_hash: string; data: any }>`SELECT actor_id, action, reason, resource_id, before_hash, after_hash, data FROM hawa.audit_events
  WHERE client_id = ${KAAE}::uuid AND action LIKE 'client.model_consent.%' ORDER BY occurred_at, id`.execute(owner)).rows;
const allowed = () => withRlsContext(db, admin, (trx) => egressAllowed(trx, tenantId, KAAE));

/** One intake-router reading through the real ledger, allowance and egress gate; true when it reached the provider. */
async function reachesProvider(): Promise<boolean> {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'chatcmpl-consent', model: resolveModel('text'),
    usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ kind: 'new_design', design: 0, confidence: 0.9 }) } }] }),
  { headers: { 'x-request-id': 'req_consent_1' } }));
  const model = createRequesterIntentModel(db, { fetcher: fetcher as any, apiKey: () => ['sk', 'consent', 'fixture'].join('-') });
  await model.read({ tenantId, updateId: 1_500_000_000 + Math.floor(Math.random() * 400_000_000), chatId: '64123456', text: 'A new poster please', lang: 'en',
    requests: [{ requestId: randomUUID(), stage: 'manual', rev: 1, currentTaskId: randomUUID(), clientId: KAAE, title: 'KAAE members evening',
      activeAt: new Date().toISOString(), createdAt: new Date().toISOString(), question: null, requesterId: null }] });
  return fetcher.mock.calls.length === 1;
}

beforeAll(async () => {
  vi.stubEnv('HAWA_DESK_AUTH_MODE', 'trusted_office');
  vi.stubEnv('HAWA_TRUSTED_OFFICE_ORIGIN', origin);
  vi.stubEnv('HAWA_OFFICE_PROXY_PROOF', proof);
  // Production's state: version 1 active, no privacy block, not approved (the worst case of "unknown").
  await sql`DELETE FROM hawa.client_dna_versions WHERE client_id = ${KAAE}::uuid`.execute(owner);
  await sql`INSERT INTO hawa.client_dna_versions (tenant_id, client_id, version, status, dna, content_hash, created_by)
    VALUES (${tenantId}::uuid, ${KAAE}::uuid, 1, 'active', ${JSON.stringify({ ...production, __commitMessage: 'KAAE onboarding', __createdBy: 'admin_1' })}::jsonb,
      ${computeDnaHash(production)}, ${OFFICE_ADMIN}::uuid)`.execute(owner);
  const [client] = (await sql<{ model_egress_policy: unknown }>`SELECT model_egress_policy FROM hawa.clients WHERE id = ${KAAE}::uuid`.execute(owner)).rows;
  expect(client.model_egress_policy).toEqual({ mode: 'evaluated_external_allowed' });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all([db.destroy(), owner.destroy()]);
});

describe('ADR-234: an administrator records KAAE\'s consent to model readings', () => {
  it('before: production\'s KAAE DNA (no privacy block, not approved) admits no model reading', async () => {
    expect(await allowed()).toBe(false);
    expect(await reachesProvider()).toBe(false);
    const status = await app().request(url, { headers: office });
    expect(status.status, await status.clone().text()).toBe(200);
    expect(await status.json()).toMatchObject({ version: 1, approved: false, privacy: null, modelReading: { openai: false } });
  });

  it('refuses every role but administrator, and every administrator that is not a person in the office', async () => {
    const cases: Array<[Record<string, string>, number, string]> = [
      [{ 'Content-Type': 'application/json' }, 401, 'Authentication Required'],
      [bearer('tok-operator'), 403, 'MODEL_CONSENT_ADMINISTRATOR_REQUIRED'],
      [bearer('tok-art'), 403, 'MODEL_CONSENT_ADMINISTRATOR_REQUIRED'],
      [bearer('tok-test-admin'), 403, 'HUMAN_ADMINISTRATOR_REQUIRED'],
      [bearer('tok-service-admin'), 403, 'HUMAN_ADMINISTRATOR_REQUIRED'],
      [bearer('tok-stranger-admin'), 403, 'HUMAN_ADMINISTRATOR_REQUIRED'],
      [{ ...office, 'X-Hawa-Office-Proof': 'd'.repeat(64) }, 401, 'Authentication Required'],
    ];
    for (const [headers, status, code] of cases) {
      const res = await post(grant, headers);
      expect(res.status, JSON.stringify(headers)).toBe(status);
      expect((await res.json()).title).toBe(code);
    }
    expect(await versions()).toHaveLength(1);
    expect(await audits()).toHaveLength(0);
  });

  it('accepts only the four fields, so nothing but privacy can be named', async () => {
    for (const body of [{ ...grant, colors: [] }, { ...grant, providers: ['openai', 'openai'] }, { ...grant, providers: ['mistral'] },
      { ...grant, mode: 'local_only' }, { ...grant, reason: '' }, { ...grant, expectedVersion: 0 }, { ...grant, mode: 'everything' }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await versions()).toHaveLength(1);
  });

  it('after: makes version 2 approved by the office administrator, with only privacy changed, and the gate opens', async () => {
    const res = await post(grant);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toMatchObject({ clientId: KAAE, version: 2, previousVersion: 1, changed: true, replayed: false,
      approvedBy: OFFICE_ADMIN, privacy: { modelEgressMode: 'approved_providers', allowedProviders: ['openai'] }, modelReading: { openai: true } });

    const [v1, v2] = await versions();
    expect(v1).toMatchObject({ version: 1, status: 'superseded', approved_by: null });
    expect(v2).toMatchObject({ version: 2, status: 'active', approved_by: OFFICE_ADMIN, created_by: OFFICE_ADMIN });
    expect(v2.dna.privacy).toEqual({ modelEgressMode: 'approved_providers', allowedProviders: ['openai'] });
    expect(design(v2.dna)).toEqual(design(v1.dna));
    expect(v2.dna.version).toBe(2);
    expect(v2.content_hash).toBe(computeDnaHash(hashable(v2.dna)));
    expect(v2.dna.__commitMessage).toContain('Owner approved model reading for KAAE');

    const [audit] = await audits();
    expect(audit).toMatchObject({ actor_id: OFFICE_ADMIN, action: 'client.model_consent.granted', reason: grant.reason,
      before_hash: v1.content_hash, after_hash: v2.content_hash });
    expect(audit.data).toMatchObject({ adr: 'ADR-234', fromVersion: 1, toVersion: 2, before: null, previousApprovedBy: null,
      after: { modelEgressMode: 'approved_providers', allowedProviders: ['openai'] },
      actor: { userId: OFFICE_ADMIN, actorId: 'trusted_office_team', authMethod: 'trusted_office', role: 'administrator' } });

    // The real gate, and a reading through the real ledger and allowance, now reach the provider.
    expect(await allowed()).toBe(true);
    expect(await reachesProvider()).toBe(true);

    // Design reads: the same DNA through GET /dna, and a reference planned against version 2 is current.
    const read = await app().request(`${origin}/v1/clients/${KAAE}/dna`, { headers: office });
    const served = await read.json() as Record<string, unknown>;
    expect(design(served)).toEqual(design(v1.dna));
    expect(served).toMatchObject({ version: 2, privacy: { modelEgressMode: 'approved_providers', allowedProviders: ['openai'] } });
    await expect(assertCurrentClientDesignReference(db, { tenantId, actorId: OFFICE_ADMIN },
      { clientId: KAAE, dnaVersion: 2, dnaContentHash: v2.content_hash })).resolves.toBeUndefined();

    const status = await app().request(url, { headers: bearer('tok-operator') });
    expect(await status.json()).toMatchObject({ version: 2, approved: true, approvedBy: OFFICE_ADMIN, modelReading: { openai: true } });
  });

  it('a replay of the same request answers with the version it made; any other request on a stale version is a conflict', async () => {
    const replay = await post(grant);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ version: 2, previousVersion: 1, replayed: true, modelReading: { openai: true } });
    for (const body of [{ ...grant, providers: ['openai', 'google'] }, { ...grant, reason: 'A different reason' }, { ...grant, expectedVersion: 5 }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect((await res.json()).title).toBe('DNA_VERSION_CONFLICT');
    }
    // The same words through another credential (another author) are not this replay.
    expect((await post(grant, bearer('tok-named-admin'))).status).toBe(409);
    expect(await versions()).toHaveLength(2);
    expect(await audits()).toHaveLength(1);
  });

  it('withdrawing is the same action with no providers; the gate closes and the audit names it', async () => {
    const res = await post({ expectedVersion: 2, mode: 'none', providers: [], reason: 'Owner withdrew consent' }, bearer('tok-named-admin'));
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toMatchObject({ version: 3, privacy: { modelEgressMode: 'local_only', allowedProviders: [] }, modelReading: { openai: false } });
    expect(await allowed()).toBe(false);
    expect(await reachesProvider()).toBe(false);
    const [v1, v2, v3] = await versions();
    expect([v1.status, v2.status, v3.status]).toEqual(['superseded', 'superseded', 'active']);
    expect(design(v3.dna)).toEqual(design(v1.dna));
    expect((await audits())[1]).toMatchObject({ action: 'client.model_consent.withdrawn', reason: 'Owner withdrew consent',
      data: { before: { modelEgressMode: 'approved_providers', allowedProviders: ['openai'] }, after: { modelEgressMode: 'local_only', allowedProviders: [] },
        previousApprovedBy: OFFICE_ADMIN, actor: { actorId: OFFICE_ADMIN } } });

    // Granting again, by its code, opens it again; asking for what is already recorded changes nothing.
    const again = await app().request(`${origin}/v1/clients/kaae/dna/model-consent`, { method: 'POST', headers: office,
      body: JSON.stringify({ ...grant, expectedVersion: 3, reason: 'Owner approved again' }) });
    expect(again.status).toBe(201);
    expect(await allowed()).toBe(true);
    const same = await post({ ...grant, expectedVersion: 4, reason: 'Owner approved again' });
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({ version: 4, changed: false, modelReading: { openai: true } });
    expect(await versions()).toHaveLength(4);
  });
});
