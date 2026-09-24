import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ClientRepository, createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';

/**
 * N5 (architecture programme 1.3, SPLIT_PLAN.md sections 5 and 6): GET /clients/:clientId/snapshots
 * was registered twice. The copy that answered was clients.routes.ts's, which read only Core's
 * memory; app.ts's copy, which reads hawa.client_dna_versions, was shadowed and never ran. So the
 * Desk's DNA history listed nothing Postgres held, and lost everything on a restart.
 *
 * SPLIT_PLAN G0 deleted the memory-only copy and kept the Postgres reader. Setup is in beforeAll so
 * that a broken fixture fails the file rather than the assertion.
 */
describe('N5: a client\'s DNA snapshots come from Postgres', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId, clientId, userId: '00000000-0000-4000-b000-000000000002', role: 'administrator' };
  const contentHash = `n5-${randomUUID()}`;
  let version = 0;
  afterAll(() => db.destroy());

  beforeAll(async () => {
    await withRlsContext(db, scope, async (trx) => {
      const { rows } = await sql<{ top: number | null }>`SELECT max(version) AS top FROM hawa.client_dna_versions WHERE client_id = ${clientId}::uuid`.execute(trx);
      version = Number(rows[0]?.top ?? 0) + 1;
      await new ClientRepository(db).saveDnaVersion({ tenantId, clientId, version, dna: { name: 'KAAE N5', code: 'KAAE' }, contentHash }, trx);
    });
    const stored = await withRlsContext(db, scope, (trx) => new ClientRepository(db).listDnaSnapshots(tenantId, clientId, trx));
    expect(stored.map((r) => r.content_hash)).toContain(contentHash);
  });

  it('lists the version Postgres holds, with its hash', async () => {
    const res = await createApp({ db }).request(`/v1/clients/${clientId}/snapshots`, {
      headers: { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const snapshots = (await res.json()) as Array<{ version: number; sha256: string }>;
    expect(snapshots).toContainEqual(expect.objectContaining({ version, sha256: contentHash }));
  });

  // The Desk also addresses a client by its code. The reader looked the code up outside any RLS
  // context, where hawa.clients shows nothing, and answered with Core's memory instead: the
  // fixture snapshots, never what Postgres holds.
  it.each(['kaae', 'client-kaae'])('lists the same version when the client is addressed as %s', async (spelling) => {
    const res = await createApp({ db }).request(`/v1/clients/${spelling}/snapshots`, {
      headers: { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const snapshots = (await res.json()) as Array<{ version: number; sha256: string }>;
    expect(snapshots).toContainEqual(expect.objectContaining({ version, sha256: contentHash }));
  });
});
