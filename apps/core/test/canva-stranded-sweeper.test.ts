import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext, CanvaBindingRepository, type Kysely, type Database } from '@hawa/db';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';

describe('CanvaConnectService: Stranded Operations Sweeper & Conflict Bypass (Item 3, Score 40)', () => {
  let db: Kysely<Database>;
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const actorId = '00000000-0000-4000-b000-000000000001';
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId, actorId, role: 'admin' };
  const key = 'a1'.repeat(32);

  let jobStatus = 'success';
  let designId = 'DA_test_design';

  const mockRemote = vi.fn(async (input: any, init: any = {}) => {
    const u = String(input);
    if (u.endsWith('/oauth/token')) {
      return Response.json({ access_token: 'token-' + randomUUID(), refresh_token: 'refresh-' + randomUUID(), expires_in: 3600 });
    }
    if (u.endsWith('/imports') && init?.method === 'POST') {
      return Response.json({
        job: {
          id: 'import_job_' + randomUUID(),
          status: 'in_progress',
        },
      });
    }
    if (u.includes('/imports/')) {
      if (jobStatus === 'error') {
        return new Response('Not Found', { status: 404 });
      }
      return Response.json({
        job: {
          id: u.split('/').pop(),
          status: jobStatus,
          ...(jobStatus === 'success' ? { result: { designs: [{ id: designId, urls: { edit_url: 'https://canva.com/edit', view_url: 'https://canva.com/view' } }] } } : {}),
        },
      });
    }
    throw new Error(`Unhandled URL: ${u}`);
  }) as typeof fetch;

  const options = {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    redirectUri: 'http://localhost:8772/v1/integrations/canva/callback',
    encryptionKey: key,
    fetcher: mockRemote,
  };

  beforeAll(async () => {
    db = createDb(process.env.TEST_DATABASE_URL!);
    const service = new CanvaConnectService(db, options);
    const auth = await service.startAuthorization(scope);
    await service.finishAuthorization(auth.state, auth.state, 'test-code');
  });

  afterAll(async () => {
    if (db) await db.destroy();
  });

  it('sweeps stranded submitted operations older than threshold into retrieved status and creates binding', async () => {
    const taskId = randomUUID();
    const opId = randomUUID();
    jobStatus = 'success';
    designId = `DA_${taskId.slice(0, 8)}`;

    await withRlsContext(db, { tenantId, userId: actorId, role: 'administrator' }, async (trx) => {
      // Create task
      await sql`
        INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid, 'Stranded Test Task', 'Brief', 'received', 3, 1, now(), now())
      `.execute(trx);

      // Insert stranded operation older than 15 minutes
      await sql`
        INSERT INTO hawa.canva_remote_operations (
          id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, remote_job_id, metadata, created_at, updated_at
        ) VALUES (
          ${opId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${actorId},
          'stranded-req-key', 'hash123', 'create', 'submitted', ${`job_${taskId}`},
          '{"method":"pptx_import"}'::jsonb,
          now() - interval '20 minutes',
          now() - interval '20 minutes'
        )
      `.execute(trx);
    });

    const service = new CanvaConnectService(db, options);
    const sweepRes = await service.sweepStrandedOperations(scope, { maxAgeMinutes: 10 });

    expect(sweepRes.sweptCount).toBeGreaterThanOrEqual(1);
    const item = sweepRes.settled.find((s) => s.id === opId);
    expect(item).toBeDefined();
    expect(item?.status).toBe('retrieved');
    expect(item?.designId).toBe(designId);

    // Verify binding created in database
    await withRlsContext(db, { tenantId, userId: actorId, role: 'administrator' }, async (trx) => {
      const binding = await new CanvaBindingRepository(trx).findByTaskId(tenantId, taskId);
      expect(binding).toBeDefined();
      expect(binding?.canva_design_id).toBe(designId);

      const op = (await sql<any>`SELECT status, design_id FROM hawa.canva_remote_operations WHERE id=${opId}::uuid`.execute(trx)).rows[0];
      expect(op.status).toBe('retrieved');
      expect(op.design_id).toBe(designId);
    });
  });

  it('marks stranded operation as failed when Canva job fails or cannot be retrieved', async () => {
    const taskId = randomUUID();
    const opId = randomUUID();
    jobStatus = 'failed';

    await withRlsContext(db, { tenantId, userId: actorId, role: 'administrator' }, async (trx) => {
      await sql`
        INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid, 'Failed Stranded Task', 'Brief', 'received', 3, 1, now(), now())
      `.execute(trx);

      await sql`
        INSERT INTO hawa.canva_remote_operations (
          id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, remote_job_id, metadata, created_at, updated_at
        ) VALUES (
          ${opId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${actorId},
          'failed-stranded-key', 'hash123', 'create', 'submitted', ${`job_${taskId}`},
          '{"method":"pptx_import"}'::jsonb,
          now() - interval '25 minutes',
          now() - interval '25 minutes'
        )
      `.execute(trx);
    });

    const service = new CanvaConnectService(db, options);
    const sweepRes = await service.sweepStrandedOperations(scope, { maxAgeMinutes: 10 });

    const item = sweepRes.settled.find((s) => s.id === opId);
    expect(item).toBeDefined();
    expect(item?.status).toBe('failed');

    await withRlsContext(db, { tenantId, userId: actorId, role: 'administrator' }, async (trx) => {
      const op = (await sql<any>`SELECT status FROM hawa.canva_remote_operations WHERE id=${opId}::uuid`.execute(trx)).rows[0];
      expect(op.status).toBe('failed');
    });
  });

  it('bypasses CANVA_CREATE_CONFLICT when prior operation has failed status', async () => {
    const taskId = randomUUID();
    const priorOpId = randomUUID();

    await withRlsContext(db, { tenantId, userId: actorId, role: 'administrator' }, async (trx) => {
      await sql`
        INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid, 'Retryable Task', 'Brief', 'received', 3, 1, now(), now())
      `.execute(trx);

      // Prior creation failed
      await sql`
        INSERT INTO hawa.canva_remote_operations (
          id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, remote_job_id, metadata, created_at, updated_at
        ) VALUES (
          ${priorOpId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${clientId}::uuid, ${actorId},
          'old-different-key', 'hash123', 'create', 'failed', ${`job_${taskId}`},
          '{"method":"pptx_import"}'::jsonb,
          now() - interval '1 hour',
          now() - interval '1 hour'
        )
      `.execute(trx);
    });

    const service = new CanvaConnectService(db, options);
    // Mock import call to Canva
    const sourceBytes = Buffer.from('Valid test pptx source bytes that exceed 32 bytes minimum length.');
    const { createHash } = await import('node:crypto');
    const source = {
      bytes: sourceBytes,
      sha256: createHash('sha256').update(sourceBytes).digest('hex'),
      manifest: { copy: ['Retried title'] },
    };

    jobStatus = 'success';
    designId = `DA_${taskId.slice(0, 8)}`;

    // This must NOT fail with 409 CANVA_CREATE_CONFLICT
    const res = await service.importEditableDesign(scope, taskId, 'new-request-key-99', source);
    expect(res).toBeDefined();
    expect(res.operationId).not.toBe(priorOpId);
    expect(res.status).toBe('retrieved');
  });
});
