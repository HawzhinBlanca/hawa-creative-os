import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { resolveModel } from '@hawa/domain';
import { createApp } from '../src/app.js';
import { computeDnaHash } from '../src/core-helpers.js';
import { assertCurrentClientDesignReference } from '../src/services/client-design-reference.js';
import { createRequesterIntentModel, egressAllowed } from '../src/services/requester-intent-model.js';

/**
 * ADR-239 (follow-up to ADR-234): a DNA save no longer switches model reading off unseen. POST /dna,
 * /snapshots and /dna/rollback saved every new version with approved_by NULL, so once KAAE's consent
 * was recorded, the next Desk save of its DNA closed egressAllowed() (and voice admission) with no
 * warning. Now a human administrator's save with the privacy block unchanged keeps the consent (approved
 * by them, audited); every other save stays unapproved and its answer says model reading is off, and why.
 * These run the real routes, the real trusted-office identity and the real egressAllowed() against the
 * per-file test database as hawa_app, under row-level security.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const OFFICE_ADMIN = '00000000-0000-4000-b000-000000000002';
const origin = 'http://127.0.0.1:8080';
const proof = 'e'.repeat(64);
const office = { 'Content-Type': 'application/json', 'X-Hawa-Office-Request': '1', 'X-Hawa-Office-Proof': proof, Origin: origin };
const CONSENT = { modelEgressMode: 'approved_providers', allowedProviders: ['openai'] };

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const admin = { tenantId, userId: OFFICE_ADMIN, role: 'administrator' };

/**
 * A client DNA the Desk's editor can save (validateClientDna needs its identity, destinations and a primary logo). It
 * is written here rather than read from config/clients, so these tests do not move with brand data.
 */
const base: Record<string, unknown> = { tenantId, clientId: KAAE, name: 'KAAE', code: 'kaae', status: 'active', version: 1,
  defaultLocale: 'en', defaultDirection: 'ltr',
  colors: [{ name: 'Navy', hex: '#14284B', role: 'background' }, { name: 'White', hex: '#FFFFFF', role: 'text' }, { name: 'Gold', hex: '#C9A227', role: 'accent' }],
  guidelines: { layoutRules: ['Logo top right'] },
  destinations: { googleSharedDriveId: 'drive-kaae', productionFolderId: 'folder-kaae' },
  assets: [{ assetId: 'a1000000-0000-4000-8000-000000000001', role: 'logo_primary', sha256: 'a'.repeat(64), mimeType: 'image/png' }] };
const hashable = (dna: Record<string, unknown>) => { const h = { ...dna }; delete h.__commitMessage; delete h.__createdBy; return h; };

const tokens = {
  'tok-operator': 'operator', 'tok-art': 'art_director', 'tok-test-admin': 'administrator',
  'tok-service-admin': { role: 'administrator', sub: SYSTEM_AUTOMATION_USER_ID },
};
const app = () => createApp({ db, extraBearerTokens: tokens } as any);
const bearer = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
const at = (path: string) => `${origin}/v1/clients/${KAAE}${path}`;

const versions = async () => (await sql<{ version: number; status: string; approved_by: string | null; content_hash: string;
  dna: Record<string, any> }>`SELECT version, status, approved_by, content_hash, dna FROM hawa.client_dna_versions
  WHERE client_id = ${KAAE}::uuid ORDER BY version`.execute(owner)).rows;
const kept = async () => (await sql<{ actor_id: string; reason: string; resource_id: string; before_hash: string; after_hash: string;
  data: any }>`SELECT actor_id, reason, resource_id, before_hash, after_hash, data FROM hawa.audit_events
  WHERE client_id = ${KAAE}::uuid AND action = 'client.model_consent.kept'
    AND resource_id IN (SELECT id::text FROM hawa.client_dna_versions WHERE client_id = ${KAAE}::uuid)
  ORDER BY occurred_at, id`.execute(owner)).rows;
const allowed = () => withRlsContext(db, admin, (trx) => egressAllowed(trx, tenantId, KAAE));

/** Version 1 active: with the given privacy block, approved or not. */
async function seed(privacy: Record<string, unknown> | null, approvedBy: string | null) {
  const dna = { ...base, ...(privacy ? { privacy } : {}) };
  await sql`DELETE FROM hawa.client_dna_versions WHERE client_id = ${KAAE}::uuid`.execute(owner);
  await sql`INSERT INTO hawa.client_dna_versions (tenant_id, client_id, version, status, dna, content_hash, created_by, approved_by)
    VALUES (${tenantId}::uuid, ${KAAE}::uuid, 1, 'active', ${JSON.stringify({ ...dna, __commitMessage: 'Model reading consent (ADR-234)', __createdBy: 'trusted_office_team' })}::jsonb,
      ${computeDnaHash(dna)}, ${OFFICE_ADMIN}::uuid, ${approvedBy}::uuid)`.execute(owner);
}

/** The Desk's DNA save: what GET /dna showed it, with one edit, sent back to POST /dna. */
async function deskSave(headers: Record<string, string>, edit: (dna: Record<string, any>) => void = (d) => { d.name = `${d.name} Academy`; }) {
  const shown = await (await app().request(at('/dna'), { headers: office })).json() as Record<string, any>;
  edit(shown);
  const res = await app().request(at('/dna'), { method: 'POST', headers, body: JSON.stringify({ ...shown, expectedVersion: shown.version }) });
  expect(res.status, await res.clone().text()).toBe(201);
  return await res.json() as Record<string, any>;
}

/** One intake-router reading through the real ledger, allowance and egress gate; true when it reached the provider. */
async function reachesProvider(): Promise<boolean> {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'chatcmpl-kept', model: resolveModel('text'),
    usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ kind: 'new_design', design: 0, confidence: 0.9 }) } }] }),
  { headers: { 'x-request-id': 'req_kept_1' } }));
  const model = createRequesterIntentModel(db, { fetcher: fetcher as any, apiKey: () => ['sk', 'kept', 'fixture'].join('-') });
  await model.read({ tenantId, updateId: 1_500_000_000 + Math.floor(Math.random() * 400_000_000), chatId: '64123457', text: 'A new poster please', lang: 'en',
    requests: [{ requestId: randomUUID(), stage: 'manual', rev: 1, currentTaskId: randomUUID(), clientId: KAAE, title: 'KAAE members evening',
      activeAt: new Date().toISOString(), createdAt: new Date().toISOString(), question: null, requesterId: null }] });
  return fetcher.mock.calls.length === 1;
}

beforeAll(() => {
  vi.stubEnv('HAWA_DESK_AUTH_MODE', 'trusted_office');
  vi.stubEnv('HAWA_TRUSTED_OFFICE_ORIGIN', origin);
  vi.stubEnv('HAWA_OFFICE_PROXY_PROOF', proof);
});
beforeEach(() => seed(CONSENT, OFFICE_ADMIN));
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all([db.destroy(), owner.destroy()]);
});

describe('ADR-239: a DNA save keeps the client\'s model consent only when it is safe to', () => {
  it('the office administrator\'s Desk save with the privacy block unchanged keeps model reading on, approved by them and audited', async () => {
    expect(await allowed()).toBe(true);
    const saved = await deskSave(office);
    expect(saved).toMatchObject({ version: 2, privacy: CONSENT, modelReading: { openai: true } });
    expect(saved.modelReading.reason).toBeUndefined();

    const [v1, v2] = await versions();
    expect(v1).toMatchObject({ status: 'superseded', approved_by: OFFICE_ADMIN });
    expect(v2).toMatchObject({ version: 2, status: 'active', approved_by: OFFICE_ADMIN });
    expect(v2.dna.privacy).toEqual(CONSENT);
    expect(v2.dna.name).toMatch(/Academy$/);
    // The Desk sends back what it was shown: the earlier commit metadata and the answer's modelReading are not DNA.
    expect(v2.dna.modelReading).toBeUndefined();
    expect(v2.dna.__commitMessage).toBe('Client DNA updated to v2');
    // The real gate, a reading through the real ledger and allowance, and a design planned on version 2.
    expect(await allowed()).toBe(true);
    expect(await reachesProvider()).toBe(true);
    // The content hash is the stored DNA's (design reads verify it), not one over the earlier commit message.
    expect(v2.content_hash).toBe(computeDnaHash(hashable(v2.dna)));
    await expect(assertCurrentClientDesignReference(db, { tenantId, actorId: OFFICE_ADMIN },
      { clientId: KAAE, dnaVersion: 2, dnaContentHash: v2.content_hash })).resolves.toBeUndefined();

    const [audit] = await kept();
    expect(audit).toMatchObject({ actor_id: OFFICE_ADMIN, before_hash: v1.content_hash, after_hash: v2.content_hash,
      data: { adr: 'ADR-239', via: 'dna', fromVersion: 1, toVersion: 2, privacy: CONSENT, previousApprovedBy: OFFICE_ADMIN,
        actor: { userId: OFFICE_ADMIN, actorId: 'trusted_office_team', authMethod: 'trusted_office', role: 'administrator' } } });

    // The Desk's next save sends this answer back: it is kept again, and nothing of the answer is stored.
    const again = await deskSave(office, (d) => { d.name = 'KAAE'; });
    expect(again).toMatchObject({ version: 3, modelReading: { openai: true } });
    expect((await versions())[2].dna.modelReading).toBeUndefined();
    expect(await kept()).toHaveLength(2);
  });

  it.each([
    ['an operator', 'tok-operator'],
    ['an art director', 'tok-art'],
    ['a test administrator', 'tok-test-admin'],
    ['a service identity holding the administrator role', 'tok-service-admin'],
  ])('a save by %s stays unapproved, and its answer says model reading is off, and why', async (_who, token) => {
    const saved = await deskSave(bearer(token));
    expect(saved.modelReading).toEqual({ openai: false, reason: expect.stringMatching(/^Only an office administrator, signed in as a person, keeps/) });
    const [, v2] = await versions();
    expect(v2).toMatchObject({ version: 2, status: 'active', approved_by: null });
    expect(v2.dna.privacy).toEqual(CONSENT);
    expect(await allowed()).toBe(false);
    expect(await reachesProvider()).toBe(false);
    expect(await kept()).toHaveLength(0);
  });

  it('an administrator\'s save that changes the privacy block stays unapproved, with the reason', async () => {
    for (const edit of [(d: Record<string, any>) => { d.privacy = { ...d.privacy, allowedProviders: ['openai', 'google'] }; },
      (d: Record<string, any>) => { delete d.privacy; }]) {
      await seed(CONSENT, OFFICE_ADMIN);
      const saved = await deskSave(office, edit);
      expect(saved.modelReading).toEqual({ openai: false, reason: expect.stringMatching(/^The privacy block changed in this save/) });
      expect((await versions())[1]).toMatchObject({ version: 2, approved_by: null });
      expect(await allowed()).toBe(false);
    }
    expect(await kept()).toHaveLength(0);
  });

  it('a client with no recorded consent: the save is unapproved as before, and the answer says why model reading is off', async () => {
    await seed(null, null);
    const saved = await deskSave(office);
    expect(saved.modelReading).toEqual({ openai: false, reason: expect.stringMatching(/^This client has no administrator-approved consent/) });
    expect((await versions())[1]).toMatchObject({ approved_by: null });
    // A privacy block that admits OpenAI on an unapproved version is no consent either.
    await seed(CONSENT, null);
    expect((await deskSave(office)).modelReading).toMatchObject({ openai: false, reason: expect.stringMatching(/^This client has no/) });
    expect(await allowed()).toBe(false);
    expect(await kept()).toHaveLength(0);
  });

  it('a governance snapshot follows the same rule', async () => {
    const snap = await app().request(at('/snapshots'), { method: 'POST', headers: office, body: JSON.stringify({ commitMessage: 'Quarterly snapshot', expectedVersion: 1 }) });
    expect(snap.status, await snap.clone().text()).toBe(201);
    expect(await snap.json()).toMatchObject({ version: 2, modelReading: { openai: true } });
    expect((await versions())[1]).toMatchObject({ version: 2, approved_by: OFFICE_ADMIN });
    expect((await kept())[0].data).toMatchObject({ via: 'snapshot', fromVersion: 1, toVersion: 2 });

    const byOperator = await app().request(at('/snapshots'), { method: 'POST', headers: bearer('tok-operator'), body: JSON.stringify({ expectedVersion: 2 }) });
    expect(byOperator.status).toBe(201);
    expect((await byOperator.json()).modelReading).toMatchObject({ openai: false, reason: expect.stringMatching(/^Only an office administrator/) });
    expect(await allowed()).toBe(false);
  });

  it('a rollback keeps the consent only when an administrator restores the same privacy block', async () => {
    // Version 2: a design change saved by the office administrator (kept).
    await deskSave(office);
    // An administrator rolls back to version 1: the same privacy block, so the consent is kept.
    const back = await app().request(at('/dna/rollback'), { method: 'POST', headers: office, body: JSON.stringify({ targetVersion: 1, reason: 'Wrong name' }) });
    expect(back.status, await back.clone().text()).toBe(200);
    expect(await back.json()).toMatchObject({ rolledBack: true, activeVersion: 3, modelReading: { openai: true } });
    expect((await versions())[2]).toMatchObject({ version: 3, approved_by: OFFICE_ADMIN });
    expect((await kept()).map((a) => a.data.via)).toEqual(['dna', 'rollback']);

    // An art director's rollback: allowed, but the consent is not carried, and the answer says so.
    const byArt = await app().request(at('/dna/rollback'), { method: 'POST', headers: bearer('tok-art'), body: JSON.stringify({ targetVersion: 2, reason: 'Keep the new name' }) });
    expect(byArt.status, await byArt.clone().text()).toBe(200);
    expect((await byArt.json()).modelReading).toMatchObject({ openai: false, reason: expect.stringMatching(/^Only an office administrator/) });
    expect(await allowed()).toBe(false);
  });

  it('a rollback to a version from before the consent changes the privacy block: unapproved, with the reason', async () => {
    // Production's KAAE: version 1 with no privacy block; the consent action made version 2.
    await seed(null, null);
    const consent = await app().request(at('/dna/model-consent'), { method: 'POST', headers: office,
      body: JSON.stringify({ expectedVersion: 1, mode: 'approved_providers', providers: ['openai'], reason: 'Owner approved model reading for KAAE' }) });
    expect(consent.status).toBe(201);
    expect(await allowed()).toBe(true);
    const back = await app().request(at('/dna/rollback'), { method: 'POST', headers: office, body: JSON.stringify({ targetVersion: 1, reason: 'Undo' }) });
    expect(back.status).toBe(200);
    expect((await back.json()).modelReading).toMatchObject({ openai: false, reason: expect.stringMatching(/^The privacy block changed/) });
    expect((await versions())[2]).toMatchObject({ version: 3, approved_by: null });
    expect(await allowed()).toBe(false);
  });
});
