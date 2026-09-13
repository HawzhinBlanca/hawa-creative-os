import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, withRlsContext } from '../src/client.js';
import { CanvaBindingRepository } from '../src/repositories/canva-binding.repository.js';
import { sql } from 'kysely';

const url = process.env.HAWA_ISOLATED_TEST_DB;
// This suite refuses the office database. Provision the disposable schema first.
if (url && new URL(url).pathname !== '/hawa_repair') throw new Error('Isolated hawa_repair database required');
describe.skipIf(!url)('real PostgreSQL binding/capture isolation', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const repo = new CanvaBindingRepository(db);
  const tenantA = randomUUID(), tenantB = randomUUID(), clientA = randomUUID(), clientB = randomUUID();
  const taskA = randomUUID(), taskB = randomUUID(), taskA2 = randomUUID();
  const design = `DA${randomUUID().replaceAll('-', '')}`;
  let bindingId: string;
  beforeAll(async () => {
    for (const [tenant, client, task] of [[tenantA, clientA, taskA], [tenantB, clientB, taskB]]) {
      await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES (${tenant}::uuid, 'Isolated test', ${tenant})`.execute(db);
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${client}::uuid,${tenant}::uuid,'test','Isolated client')`.execute(db);
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES (${task}::uuid,${tenant}::uuid,${client}::uuid,'Isolated binding')`.execute(db);
    }
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES (${taskA2}::uuid,${tenantA}::uuid,${clientA}::uuid,'Second task')`.execute(db);
  });
  afterAll(async () => { await db.destroy(); });
  const params = () => ({ tenantId: tenantA, clientId: clientA, taskId: taskA, canvaDesignId: design, editUrl: `https://www.canva.com/design/${design}/edit` });
  const capture = () => ({ ...params(), bindingId, expectedVersion: 1, capturedArtifactSetHash: 'a'.repeat(64),
    artifacts: [{ format: 'png' as const, storageKey: 'isolated/file.png', sha256: 'b'.repeat(64), byteSize: 100 }],
    semanticCoverage: { textNodesCount: 2, imageFillsCount: 1, hasLogo: true, isComplete: true }, authActor: { actorType: 'user' as const, actorId: 'test' } });
  it('persists a binding and survives a fresh connection; identical retry returns the same row', async () => {
    const binding = await repo.createBinding(params()); bindingId = binding.id;
    expect((await repo.createBinding(params())).id).toBe(bindingId);
    const otherDb = createDb(url!);
    try { expect((await new CanvaBindingRepository(otherDb).findByTaskId(tenantA, taskA))?.id).toBe(bindingId); }
    finally { await otherDb.destroy(); }
  });
  it('rejects shared design across both tenants and tasks', async () => {
    await expect(repo.createBinding({ ...params(), tenantId: tenantB, clientId: clientB, taskId: taskB })).rejects.toThrow();
    await expect(repo.createBinding({ ...params(), taskId: taskA2 })).rejects.toThrow();
    expect((await repo.findByTaskId(tenantA, taskA))?.id).toBe(bindingId);
  });
  it.each(['tenantId','clientId','taskId'] as const)('rejects a capture with foreign %s', async field => {
    await expect(repo.captureArtifactSet({ ...capture(), [field]: randomUUID() })).rejects.toThrow('scope mismatch');
  });
  it('concurrent captures at the same version allow exactly one commit', async () => {
    const results = await Promise.allSettled([repo.captureArtifactSet(capture()), repo.captureArtifactSet(capture())]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await repo.findByTaskId(tenantA, taskA))?.version).toBe(2);
    expect(await repo.listCaptureSetsForTask(tenantA, taskA)).toHaveLength(1);
  });
  it('failed insert rolls back without bumping the binding version', async () => {
    await sql`CREATE FUNCTION hawa.reject_test_binding_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected update failure'; END $$`.execute(db);
    await sql`CREATE TRIGGER reject_test_binding_update BEFORE UPDATE ON hawa.canva_bindings FOR EACH ROW EXECUTE FUNCTION hawa.reject_test_binding_update()`.execute(db);
    try { await expect(repo.captureArtifactSet({ ...capture(), expectedVersion: 2 })).rejects.toThrow('injected update failure'); }
    finally {
      await sql`DROP TRIGGER reject_test_binding_update ON hawa.canva_bindings`.execute(db);
      await sql`DROP FUNCTION hawa.reject_test_binding_update()`.execute(db);
    }
    expect((await repo.findByTaskId(tenantA, taskA))?.version).toBe(2);
    expect(await repo.listCaptureSetsForTask(tenantA, taskA)).toHaveLength(1);
  });
  it('retains a caller transaction and its scope', async () => {
    const row = await withRlsContext(db, { tenantId: tenantA, clientId: clientA }, trx => new CanvaBindingRepository(trx).captureArtifactSet({ ...capture(), expectedVersion: 2 }));
    expect(row.version).toBe(3);
  });
  it('RLS hides other tenants and refuses missing scope for a non-owner role', async () => {
    await sql`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hawa_ship_test') THEN CREATE ROLE hawa_ship_test NOLOGIN; END IF; END $$`.execute(db);
    await sql`GRANT USAGE ON SCHEMA hawa TO hawa_ship_test`.execute(db);
    await sql`GRANT SELECT ON hawa.canva_bindings, hawa.canva_capture_sets TO hawa_ship_test`.execute(db);
    await db.transaction().execute(async trx => {
      await sql`SET LOCAL ROLE hawa_ship_test`.execute(trx);
      expect(await trx.selectFrom('canva_bindings').selectAll().execute()).toEqual([]);
      await sql`SELECT set_config('app.tenant_id', ${tenantB}, true)`.execute(trx);
      expect(await trx.selectFrom('canva_bindings').selectAll().where('id','=',bindingId).execute()).toEqual([]);
      await sql`SELECT set_config('app.tenant_id', ${tenantA}, true)`.execute(trx);
      expect((await trx.selectFrom('canva_bindings').selectAll().where('id','=',bindingId).execute())).toHaveLength(1);
    });
  });
  it('capture history is immutable even for a database owner', async () => {
    await expect(db.updateTable('canva_capture_sets').set({ captured_artifact_set_hash: 'c'.repeat(64) }).where('binding_id', '=', bindingId).execute()).rejects.toThrow('append-only');
  });

});
