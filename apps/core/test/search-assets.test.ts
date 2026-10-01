import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { createApp } from '../src/app.js';

const db = createDb(process.env.TEST_DATABASE_URL!), owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const tenant = '00000000-0000-4000-a000-000000000001';
const client = randomUUID(), peer = randomUUID(), foreignTenant = randomUUID(), foreignClient = randomUUID(), designer = randomUUID();
const old = randomUUID(), peerAsset = randomUUID(), foreignAsset = randomUUID(), unsized = randomUUID();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const oldHash = hash(old), alias = 'assets-' + client;
const app = () => createApp({ db, testAuth: { principal: { role: 'operator' } } });
type Answer = { results: Array<{ id: string; title: string; subtitle: string; url: string | null }>; total: number; truncated: boolean };
async function search(q: string, clientId: string = client, category = 'assets', instance = app()) {
  const response = await instance.request(`/v1/search?${new URLSearchParams({ q, category, clientId })}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<Answer>;
}
async function asset(id: string, clientId: string, name: string, tenantId = tenant, status = 'active') {
  await sql`INSERT INTO hawa.brand_assets(id,tenant_id,client_id,kind,name,mime_type,sha256,status,metadata,storage_key,created_at)
    VALUES(${id}::uuid,${tenantId}::uuid,${clientId}::uuid,'Uniqueassetkind',${name},'image/unique-asset',${hash(id)},
      ${status}::hawa.record_status,${JSON.stringify({ privateTransport: 'NeverIndexAssetMetadata' })}::jsonb,
      'NeverIndexAssetStorage','2020-01-01T00:00:00Z')`.execute(owner);
}
afterAll(async () => { await db.destroy(); await owner.destroy(); });
afterEach(() => vi.unstubAllEnvs());
beforeAll(async () => {
  await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${foreignTenant}::uuid,'Foreign asset fixture',${foreignTenant})`.execute(owner);
  for (const [id, tenantId, code] of [[client, tenant, alias], [peer, tenant, peer], [foreignClient, foreignTenant, foreignClient]]) {
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${id}::uuid,${tenantId}::uuid,${code},'Asset fixture')`.execute(owner);
  }
  await asset(old, client, 'Oldassetneedle كردي ١٢٣');
  await asset(peerAsset, peer, 'Peerassetneedle');
  await asset(foreignAsset, foreignClient, 'Foreignassetneedle', foreignTenant);
  await asset(randomUUID(), client, 'Inactiveassetneedle', tenant, 'inactive');
  for (const clientId of [client, peer]) {
    await sql`INSERT INTO hawa.brand_assets(tenant_id,client_id,kind,name,mime_type,sha256,created_at)
      SELECT ${tenant}::uuid,${clientId}::uuid,'photo','Unrelated filler asset '||g,'image/png',
        repeat(md5(${clientId}||g::text),2),clock_timestamp()+g*interval '1 millisecond'
      FROM generate_series(1,505) g`.execute(owner);
  }
  await asset(unsized, client, 'Recentunknownsizeneedle');
  await sql`UPDATE hawa.brand_assets SET created_at=clock_timestamp()+interval '1 hour' WHERE id=${unsized}::uuid`.execute(owner);
  await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${designer}::uuid,${designer+'@example.test'},'Asset designer')`.execute(owner);
  await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${designer}::uuid,'designer')`.execute(owner);
  await sql`INSERT INTO hawa.client_memberships(tenant_id,client_id,user_id,role) VALUES(${tenant}::uuid,${client}::uuid,${designer}::uuid,'designer')`.execute(owner);
});

it('finds an old asset behind 500 unrelated uploads on a cold scoped and broad search', async () => {
  for (const scope of [client, alias, 'all']) {
    for (const category of ['assets', 'all']) {
      const result = await search('Oldassetneedle', scope, category);
      expect(result.results.map(hit => hit.id)).toContain(old);
      expect(result.truncated).toBe(false);
      expect(result.results.find(hit => hit.id === old)?.url).toBeNull();
    }
  }
  const inventory = await app().request(`/v1/assets?clientId=${client}`);
  expect(inventory.status).toBe(200);
  const listed = await inventory.json() as Array<{assetId:string}>;
  expect(listed).toHaveLength(500);
  expect(listed.map(item => item.assetId)).not.toContain(old);
});
it('matches original Sorani spellings before bounding without rewriting the returned name', async () => {
  const result = await search('کردی 123');
  expect(result.results.map(hit => hit.id)).toContain(old);
  expect(result.results.find(hit => hit.id === old)?.title).toBe('Oldassetneedle كردي ١٢٣');
});
it('finds an old exact hash, media type and kind without searching arbitrary storage or metadata', async () => {
  for (const q of [old, oldHash, 'Uniqueassetkind', 'image/unique-asset']) {
    expect((await search(q)).results.map(hit => hit.id)).toContain(old);
  }
  for (const q of ['NeverIndexAssetMetadata', 'NeverIndexAssetStorage']) expect((await search(q)).results).toEqual([]);
});
it('does not invent the byte size of an asset whose size was not recorded', async () => {
  const result = await search('Recentunknownsizeneedle');
  const found = result.results.find(hit => hit.id === unsized);
  expect(found).toBeDefined();
  expect(found!.subtitle).toContain('Size unavailable');
  expect(found!.subtitle).not.toContain('1024 B');
});
it('bounds matching assets, reports truncation and orders equal timestamps deterministically', async () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids) await asset(id, client, 'Boundedassetneedle');
  vi.stubEnv('HAWA_SEARCH_ASSET_CEILING', '2');
  const first = await search('Boundedassetneedle');
  expect(first.total).toBe(2);
  expect(first.truncated).toBe(true);
  expect(new Set(first.results.map(hit => hit.id))).toEqual(new Set(ids.sort().reverse().slice(0, 2)));
  expect((await search('Boundedassetneedle')).results).toEqual(first.results);
  expect((await search('Oldassetneedle')).truncated).toBe(false);
  for (const configured of ['Infinity', 'NaN', '-1', '0']) {
    vi.stubEnv('HAWA_SEARCH_ASSET_CEILING', configured);
    const fallback = await search('Boundedassetneedle');
    expect(fallback.total).toBe(3);
    expect(fallback.truncated).toBe(false);
  }
  vi.stubEnv('HAWA_SEARCH_ASSET_CEILING', '1.7');
  expect((await search('Boundedassetneedle')).total).toBe(1);
  expect((await search('Boundedassetneedle')).truncated).toBe(true);
});
it('applies client authority before the bound, including aliases and broad assigned-designer reads', async () => {
  const scoped = createApp({ db, testAuth: { principal: { role: 'designer', userId: designer } } });
  vi.stubEnv('HAWA_SEARCH_ASSET_CEILING', '1');
  expect((await search('Oldassetneedle', alias, 'assets', scoped)).results.map(hit => hit.id)).toContain(old);
  expect((await search('Oldassetneedle', 'all', 'assets', scoped)).results.map(hit => hit.id)).toContain(old);
  expect((await search('Peerassetneedle', 'all')).results.map(hit => hit.id)).toContain(peerAsset);
  for (const scope of ['all', peer]) expect((await search('Peerassetneedle', scope, 'assets', scoped)).results).toEqual([]);
  for (const scope of [peer, 'unknown-client']) expect((await search('Oldassetneedle', scope)).results).toEqual([]);
});
it('excludes inactive and foreign-tenant assets even in an operator broad search', async () => {
  expect((await search('Inactiveassetneedle')).results).toEqual([]);
  for (const scope of ['all', foreignClient]) expect((await search('Foreignassetneedle', scope)).results).toEqual([]);
});
it('refuses unavailable stored asset reads after a warmed query without reusing prior results', async () => {
  const instance = app();
  expect((await search('Oldassetneedle', client, 'assets', instance)).results.map(hit => hit.id)).toContain(old);
  await sql.raw('REVOKE SELECT ON hawa.brand_assets FROM hawa_app').execute(owner);
  try {
    const response = await instance.request(`/v1/search?${new URLSearchParams({ q: 'Oldassetneedle', category: 'assets', clientId: client })}`);
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty('results');
    // A category that does not consume assets should not read their inventory.
    expect((await search('NoMatchingFeedback', client, 'feedback', instance)).results).toEqual([]);
  } finally {
    await sql.raw('GRANT SELECT ON hawa.brand_assets TO hawa_app').execute(owner);
  }
});
it('keeps the hard 20,000 match bound even when the configured ceiling is enormous', async () => {
  await sql`INSERT INTO hawa.brand_assets(tenant_id,client_id,kind,name,mime_type,sha256,created_at)
    SELECT ${tenant}::uuid,${client}::uuid,'photo','Hardboundassetneedle '||g,'image/png',
      repeat(md5('hardbound-'||${client}||g::text),2),clock_timestamp()+g*interval '1 millisecond'
    FROM generate_series(1,20005) g`.execute(owner);
  vi.stubEnv('HAWA_SEARCH_ASSET_CEILING', '1000000000');
  const result = await search('Hardboundassetneedle');
  expect(result.total).toBe(20000);
  expect(result.truncated).toBe(true);
  expect(result.results).toHaveLength(25);
}, 30000);
