import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDb, sql, withRlsContext, type Kysely, type Database } from '@hawa/db';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';

/**
 * Bug hunt 2026-09-24. The studio's transfer stage (design-studio-service.ts, case 'transferring')
 * imports under the key 'studio-' + a planId that is a fresh randomUUID() on every attempt, and gives
 * up after 30 polls x 1.5 s ("Canva PPTX import did not settle"), failing the run. The import's
 * canva_remote_operations row stays 'submitted' (or 'creating' if Core died mid-call), and
 * CanvaConnectService refuses any other key for the task while a non-failed row exists. The only code
 * that settles such a row, sweepStrandedOperations, has no caller. So a slow Canva import, or a Core
 * restart during the transfer, leaves the task unable to be designed again: every re-drive fails with
 * 409 CANVA_CREATE_CONFLICT, and the requester was told the design failed.
 */
describe('HUNT: an unsettled Canva import strands the task for good', () => {
  let db: Kysely<Database>;
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const actorId = '00000000-0000-4000-b000-000000000001';
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId, actorId, role: 'admin' };
  const fetcher = vi.fn(async (input: any, init: any = {}) => {
    const u = String(input);
    if (u.endsWith('/oauth/token')) return Response.json({ access_token: 'token-' + randomUUID(), refresh_token: 'refresh-' + randomUUID(), expires_in: 3600 });
    if (u.endsWith('/imports') && init?.method === 'POST') return Response.json({ job: { id: 'import_job_' + randomUUID(), status: 'in_progress' } });
    // Canva is still working on it when the studio stops polling.
    if (u.includes('/imports/')) return Response.json({ job: { id: u.split('/').pop(), status: 'in_progress' } });
    throw new Error(`Unhandled URL: ${u}`);
  }) as typeof fetch;
  const options = {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    redirectUri: 'http://localhost:8772/v1/integrations/canva/callback',
    encryptionKey: 'b2'.repeat(32),
    fetcher,
  };

  beforeAll(async () => {
    db = createDb(process.env.TEST_DATABASE_URL!);
    const service = new CanvaConnectService(db, options);
    const auth = await service.startAuthorization(scope);
    await service.finishAuthorization(auth.state, auth.state, 'test-code');
  });
  const taskIds: string[] = [];
  afterAll(async () => {
    // Only this suite's own operations are closed, so no sweeper in another suite settles them.
    // Earlier runs of this suite included: its tasks carry their own title.
    await withRlsContext(db, { tenantId, userId: actorId, role: 'administrator' }, (trx) =>
      sql`UPDATE hawa.canva_remote_operations o SET status = 'failed' FROM hawa.tasks t
        WHERE t.id = o.task_id AND t.tenant_id = o.tenant_id AND t.title = '[TEST] hunt unsettled import' AND o.status <> 'failed'`.execute(trx));
    if (db) await db.destroy();
  });

  it('a second studio transfer (new planId key) after an unsettled import is refused', async () => {
    const taskId = randomUUID();
    taskIds.push(taskId);
    await withRlsContext(db, { tenantId, userId: actorId, role: 'administrator' }, (trx) =>
      sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid, '[TEST] hunt unsettled import', 'Brief', 'received', 3, 1, now(), now())`.execute(trx)
    );
    const bytes = Buffer.from('Editable PPTX bytes for the hunt test, longer than thirty-two bytes.');
    const source = { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), manifest: { copy: ['Title'] } };
    const service = new CanvaConnectService(db, options);

    // First transfer: the import is submitted and does not settle (the studio then fails the run).
    const first = await service.importEditableDesign(scope, taskId, 'studio-' + randomUUID(), source);
    expect(first.status).toBe('submitted');

    // The re-drive's transfer, or the same run's transfer after a Core restart: a new planId, a new key.
    const second = await service
      .importEditableDesign(scope, taskId, 'studio-' + randomUUID(), source)
      .then((r) => ({ ok: true, status: r.status }), (e) => ({ ok: false, code: e?.code, status: e?.status }));
    expect(second).toEqual({ ok: true, status: 'submitted' });
  });

  it('something in production calls sweepStrandedOperations', () => {
    const roots = [resolve(__dirname, '../src'), resolve(__dirname, '../../worker/src')];
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /\.sweepStrandedOperations\(/.test(readFileSync(p, 'utf8'))) callers.push(p);
      }
    };
    roots.forEach(walk);
    expect(callers).not.toEqual([]);
  });
});
