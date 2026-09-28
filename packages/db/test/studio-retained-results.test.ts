import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, unlink, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { createDb, withRlsContext } from '../src/client.js';
import { DesignStudioRepository } from '../src/repositories/design-studio.repository.js';
import { BlobStore, initBlobStoreDir } from '../src/blobs/store.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
describe.skipIf(!url)('immutable retained Studio results', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const repo = new DesignStudioRepository(db);
  const dirs: string[] = [];
  let tenantId: string, clientId: string, actorId: string, runId: string, callId: string;
  beforeEach(async () => {
    tenantId = randomUUID(); clientId = randomUUID(); actorId = randomUUID(); runId = randomUUID(); callId = randomUUID();
    const taskId = randomUUID();
    await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES(${tenantId}::uuid,'Retained fixture',${tenantId})`.execute(db);
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${actorId}::uuid,${actorId+'@example.test'},'Retained operator')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${actorId}::uuid,'operator')`.execute(db);
    await withRlsContext(db, { tenantId, userId: actorId }, async tx => {
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,'retained','Retained fixture')`.execute(tx);
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES(${taskId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Retained fixture')`.execute(tx);
    });
    await repo.createRun({ id: runId, taskId, tenantId, clientId, actorId, requestKey: runId,
      requestHash: 'a'.repeat(64), request: {}, tier: 'premium', budget: { maxUsd: 2, maxCalls: 2, spentUsd: 0, calls: 0 } });
    await repo.recordCallStart({ id: callId, runId, tenantId, actorId, stage: 'briefing', provider: 'openai', model: 'synthetic',
      requestedModel: 'synthetic', callOrdinal: 1, logicalCallSha256: sha(callId),
      reservation: { version: 1, policy: 'synthetic-test', requestSha256: 'a'.repeat(64), usd: .5, inputTokens: 100, outputTokens: 100 } });
  });
  afterAll(async () => { await db.destroy(); await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true }))); });
  const finish = () => ({ id: callId, tenantId, status: 'ok' as const, inputTokens: 1, outputTokens: 1, usdEstimate: .01 });
  const payload = { data: { exactCopy: 'سڵاو — Hello' }, receipt: { costUsd: .01 }, rawText: 'validated synthetic response' };

  it('survives a new database connection without putting content in the operational ledger', async () => {
    await repo.finalizeCall({ ...finish(), retainedResult: { kind: 'structured', payload } });
    const peer = createDb(url!);
    try {
      expect(await new DesignStudioRepository(peer).getRetainedCallResult(callId, tenantId)).toMatchObject({ kind: 'structured', payload });
      const calls = await new DesignStudioRepository(peer).getCallsForRun(runId, tenantId);
      expect(calls).toMatchObject([{ has_retained_result: true, status: 'ok' }]);
      expect(JSON.stringify(calls)).not.toContain('exactCopy');
      expect(await repo.getRetainedCallResult(callId, randomUUID())).toBeNull();
    } finally { await peer.destroy(); }
  });

  it('enforces runtime-role tenant isolation and immutable results', async () => {
    await withRlsContext(db, { tenantId, userId: actorId }, async tx => {
      await sql`SET LOCAL ROLE hawa_app`.execute(tx);
      await repo.finalizeCall({ ...finish(), retainedResult: { kind: 'structured', payload } }, tx);
      expect((await sql`SELECT call_id FROM hawa.design_studio_call_results WHERE call_id=${callId}::uuid`.execute(tx)).rows).toHaveLength(1);
      expect((await new DesignStudioRepository(tx).getRetainedCallResult(callId, tenantId, actorId))?.payload).toEqual(payload);
      expect(await new DesignStudioRepository(tx).getCallsForRun(runId, tenantId, undefined, actorId))
        .toMatchObject([{ has_retained_result: true }]);
    });
    await withRlsContext(db, { tenantId: randomUUID(), userId: actorId }, async tx => {
      await sql`SET LOCAL ROLE hawa_app`.execute(tx);
      expect((await sql`SELECT call_id FROM hawa.design_studio_call_results WHERE call_id=${callId}::uuid`.execute(tx)).rows).toHaveLength(0);
    });
    await expect(sql`UPDATE hawa.design_studio_call_results SET payload_text='{}' WHERE call_id=${callId}::uuid`.execute(db)).rejects.toThrow(/immutable/);
    await expect(sql`DELETE FROM hawa.design_studio_call_results WHERE call_id=${callId}::uuid`.execute(db)).rejects.toThrow(/immutable/);
  });

  it('refuses another tenant member without access to this client', async () => {
    await repo.finalizeCall({ ...finish(), retainedResult: { kind: 'structured', payload } });
    const outsider = randomUUID();
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES(${outsider}::uuid,${outsider+'@example.test'},'Scoped reviewer')`.execute(db);
    await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role) VALUES(${tenantId}::uuid,${outsider}::uuid,'designer')`.execute(db);
    await withRlsContext(db, { tenantId, userId: outsider }, async tx => {
      await sql`SET LOCAL ROLE hawa_app`.execute(tx);
      expect(await new DesignStudioRepository(tx).getRetainedCallResult(callId, tenantId, outsider)).toBeNull();
    });
  });

  it('rolls back successful receipt finalization if retaining the result fails', async () => {
    await expect(repo.finalizeCall({ ...finish(), retainedResult: { kind: 'invalid' as 'structured', payload } })).rejects.toThrow();
    expect(await repo.getCallsForRun(runId, tenantId)).toMatchObject([{ status: 'uncertain', finished_at: null, has_retained_result: false }]);
    await repo.finalizeCall({ ...finish(), retainedResult: { kind: 'structured', payload } });
    await expect(repo.finalizeCall({ ...finish(), retainedResult: { kind: 'structured', payload: { replaced: true } } }))
      .rejects.toMatchObject({ code: 'MODEL_CALL_FINALIZATION_CONFLICT' });
    expect((await repo.getRetainedCallResult(callId, tenantId))?.payload).toEqual(payload);
  });

  it('retains and verifies exact image bytes when no file store is configured', async () => {
    await repo.finalizeCall({ ...finish(), retainedResult: { kind: 'image', payload: { mimeType: 'image/png' }, image: png } });
    expect((await repo.getRetainedCallResult(callId, tenantId))?.image).toEqual(png);
    const row = (await sql<{ image_sha256: string; image_blob_sha256: string | null }>`SELECT image_sha256,image_blob_sha256
      FROM hawa.design_studio_call_results WHERE call_id=${callId}::uuid`.execute(db)).rows[0];
    expect(row).toEqual({ image_sha256: sha(png), image_blob_sha256: null });
  });

  it('roots image blobs for GC and refuses missing storage or missing bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hawa-retained-')); dirs.push(root); await initBlobStoreDir(root);
    const store = new BlobStore({ root, db });
    const storedRepo = new DesignStudioRepository(db, store);
    await storedRepo.finalizeCall({ ...finish(), retainedResult: { kind: 'image', payload: { mimeType: 'image/png' }, image: png } });
    expect((await new DesignStudioRepository(db, store).getRetainedCallResult(callId, tenantId))?.image).toEqual(png);
    expect((await sql`SELECT * FROM hawa.blob_reference_hashes() AS rooted(sha256) WHERE sha256=${sha(png)}`.execute(db)).rows).toHaveLength(1);
    await expect(repo.getRetainedCallResult(callId, tenantId)).rejects.toThrow('STUDIO_RETAINED_BLOB_STORE_UNAVAILABLE');
    const imagePath = store.pathOf({ sha256: sha(png), mediaType: 'image/png' });
    await chmod(imagePath, 0o644);
    await writeFile(imagePath, Buffer.from('corrupt retained image'));
    await expect(storedRepo.getRetainedCallResult(callId, tenantId)).rejects.toThrow();
    await unlink(imagePath);
    await expect(storedRepo.getRetainedCallResult(callId, tenantId)).rejects.toThrow();
  });

  it('refuses retaining unknown outcomes, malformed content, or hashless images', async () => {
    await expect(repo.finalizeCall({ ...finish(), status: 'uncertain', retainedResult: { kind: 'structured', payload } })).rejects.toThrow(/successful/);
    await expect(repo.finalizeCall({ ...finish(), retainedResult: { kind: 'structured', payload: [] } })).rejects.toThrow(/bounded JSON/);
    await expect(repo.finalizeCall({ ...finish(), retainedResult: { kind: 'image', payload } })).rejects.toThrow(/missing/);
    expect(await repo.getCallsForRun(runId, tenantId)).toMatchObject([{ status: 'uncertain', has_retained_result: false }]);
  });
});
