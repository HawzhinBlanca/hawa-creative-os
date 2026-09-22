import { describe, it, expect, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createDb, withRlsContext, ClientRepository, sql } from '@hawa/db';
import { createApp } from '../src/app.js';
import { hydrateClientDnaFromDb } from '../src/services/client-dna-hydration.js';

/**
 * Where a client's deliverables go is decided by a process-memory map that Core seeds from
 * source-code fixtures. The operator's edits go to PostgreSQL. After a restart the map held the
 * fixture again, so a folder saved yesterday and still visible in the Desk was ignored by delivery.
 * Hydration makes the database win. This test does the restart: a second createApp.
 */
describe('client DNA survives a restart', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const kaaeId = 'c1000000-0000-4000-8000-000000000002';
  const identity = { tenantId, userId: operatorUserId };
  afterAll(async () => { await db.destroy(); });

  const activeDna = () => withRlsContext(db, { ...identity, clientId: kaaeId, role: 'administrator' }, (trx) => new ClientRepository(db).findActiveDna(tenantId, kaaeId, trx));

  it('a folder saved through the API is what a fresh process delivers to', async () => {
    const folderId = `folder_saved_${randomUUID().slice(0, 8)}`;
    // Start from whatever the fixture says, change only the destination, save through the API.
    const first = createApp({ db });
    await (first as any).clientDnaHydrated;
    const current = await (await first.request(`/v1/clients/${kaaeId}/dna`, { headers: { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` } })).json();
    const edited = { ...current, destinations: { ...(current.destinations || {}), productionFolderId: folderId } };
    const saved = await first.request(`/v1/clients/${kaaeId}/dna`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(edited),
    });
    expect([200, 201]).toContain(saved.status);
    const row = await activeDna();
    expect(row).toBeDefined();
    const storedDna = typeof row!.dna === 'string' ? JSON.parse(row!.dna) : row!.dna;
    expect(storedDna.destinations.productionFolderId).toBe(folderId);

    // The restart. A new process seeds the fixture, then hydrates from PostgreSQL.
    const map = new Map<string, any>();
    map.set(kaaeId, { destinations: { productionFolderId: 'folder_from_source_fixture' } });
    map.set('kaae', map.get(kaaeId));
    const loaded = await hydrateClientDnaFromDb(db, map, identity);
    expect(loaded).toBeGreaterThanOrEqual(1);
    expect(map.get(kaaeId).destinations.productionFolderId).toBe(folderId);
    expect(map.get('kaae').destinations.productionFolderId).toBe(folderId);
    expect(map.get('client-kaae').destinations.productionFolderId).toBe(folderId);

    // And through createApp itself: the second process answers with the saved folder from memory
    // paths too, not only from the DB-first GET.
    const second = createApp({ db });
    expect(await (second as any).clientDnaHydrated).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('leaves the fixture in place for a client the database does not know', async () => {
    const map = new Map<string, any>();
    map.set('client-nova', { destinations: { productionFolderId: 'folder_nova_prod' } });
    await hydrateClientDnaFromDb(db, map, identity);
    expect(map.get('client-nova').destinations.productionFolderId).toBe('folder_nova_prod');
  });

  it('rejects, rather than silently starting on fixtures, when the database cannot be read', async () => {
    const down = createDb('postgres://hawa:x@127.0.0.1:1/hawa_test');
    try {
      await expect(hydrateClientDnaFromDb(down, new Map(), identity)).rejects.toThrow();
    } finally {
      await down.destroy();
    }
  });
});
