import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@hawa/db';
import { kaaeClientDNA } from '@hawa/domain';
import { createApp } from '../src/app.js';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';

/**
 * Group G2 of the app.ts split, second step (architecture programme 1.3, SPLIT_PLAN.md sections 6
 * and 7): with a database, a client's DNA history is hawa.client_dna_versions and nothing else.
 * Each case writes through one Core and reads through a second, as a restart would: the snapshot
 * list, its commit messages and the rollback target used to live in the writing process's memory.
 */
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const artDirector = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}` };
type Snapshot = { snapshotId: string; version: number; sha256: string; commitMessage: string };

describe('G2: client DNA snapshots are read from Postgres only', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  afterAll(() => db.destroy());

  async function saveDna(commitMessage: string): Promise<number> {
    const res = await createApp({ db }).request(`/v1/clients/${KAAE}/dna`, {
      method: 'POST',
      headers: artDirector,
      body: JSON.stringify({ ...kaaeClientDNA, clientId: KAAE, commitMessage }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { version: number }).version;
  }

  async function snapshots(app: ReturnType<typeof createApp>, client = KAAE): Promise<Snapshot[]> {
    const res = await app.request(`/v1/clients/${client}/snapshots`, { headers: artDirector });
    expect(res.status).toBe(200);
    return (await res.json()) as Snapshot[];
  }

  it('keeps the commit message of a DNA save for the next Core', async () => {
    const version = await saveDna('G2: brand colours from the office');
    const listed = await snapshots(createApp({ db }));
    expect(listed[0]).toMatchObject({ version, commitMessage: 'G2: brand colours from the office' });
  });

  it('stores a snapshot made through the client code, and the next Core lists it', async () => {
    await saveDna('G2: before the manual snapshot');
    const res = await createApp({ db }).request('/v1/clients/kaae/snapshots', {
      method: 'POST',
      headers: artDirector,
      body: JSON.stringify({ commitMessage: 'G2: manual snapshot by code' }),
    });
    expect(res.status).toBe(201);
    const made = (await res.json()) as Snapshot;
    // The code was looked up outside a row-level-security context, found nothing, and the snapshot
    // was kept in memory only while the answer said 201.
    const listed = await snapshots(createApp({ db }), 'kaae');
    expect(listed[0]).toMatchObject({ version: made.version, commitMessage: 'G2: manual snapshot by code', sha256: made.sha256 });
  });

  it('rolls back to a version another Core saved', async () => {
    const target = await saveDna('G2: the version to return to');
    await saveDna('G2: the version to undo');
    const res = await createApp({ db }).request(`/v1/clients/${KAAE}/dna/rollback`, {
      method: 'POST',
      headers: artDirector,
      body: JSON.stringify({ targetVersion: target, reason: 'G2 rollback across a restart' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revertedToVersion: number; activeVersion: number };
    expect(body.revertedToVersion).toBe(target);
    const listed = await snapshots(createApp({ db }));
    expect(listed[0]).toMatchObject({ version: body.activeVersion });
    expect(listed[0].commitMessage).toContain(`Rollback to baseline v${target}`);
  });

  it('answers 404 for a client Postgres does not know, not the fixture snapshots', async () => {
    const res = await createAppWithClientFixtures({ db }).request('/v1/clients/client-aster/snapshots', { headers: artDirector });
    expect(res.status).toBe(404);
  });
});

describe('G2: the DNA fixtures are for tests only', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));

  it('a plain createApp() knows no invented office', async () => {
    const app = createApp({ testAuth: { principal: { role: 'operator' } } });
    expect(await (await app.request('/v1/clients')).json()).toEqual([]);
    expect((await app.request('/v1/clients/client-office-1/dna')).status).toBe(404);
  });

  it('the shared test helper seeds them', async () => {
    const app = createAppWithClientFixtures({ testAuth: { principal: { role: 'operator' } } });
    const ids = ((await (await app.request('/v1/clients')).json()) as Array<{ clientId: string }>).map((c) => c.clientId);
    expect(ids).toEqual(expect.arrayContaining(['client-office-1', 'client-drustee', 'client-aster']));
  });

  it('the fixture file lives with the tests, not in Core', () => {
    expect(fs.existsSync(path.join(here, '../src/fixtures/client-dna-fixtures.ts'))).toBe(false);
    expect(fs.existsSync(path.join(here, 'fixtures/client-dna-fixtures.ts'))).toBe(true);
  });
});
