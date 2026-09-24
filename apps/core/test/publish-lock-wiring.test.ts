import { afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { canvaDeliverableStore } from '../src/services/pinned-deliverables.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';

/**
 * Two deliveries of the same task at the same instant must reach the publisher once.
 *
 * The lock existed (27760b5) and was lost in the merge of the Gemini branch. Nothing noticed,
 * because concurrent-publication.test.ts wraps the publisher in the lock itself and never calls
 * Core. This test calls Core's own delivery route twice at once against the test database, with a
 * publisher slow enough for the two to overlap, and counts.
 */

const tenantId = '00000000-0000-4000-a000-000000000001';
const kaaeClientId = 'c1000000-0000-4000-8000-000000000002';
const operatorUserId = '00000000-0000-4000-b000-000000000001';

async function approvedTask(db: any, app: any, headers: Record<string, string>) {
  const taskId = randomUUID();
  const designId = `lock_design_${randomUUID().slice(0, 8)}`;
  const exportId = randomUUID();
  const content = Buffer.from(`export bytes ${taskId}`);
  const sha = createHash('sha256').update(content).digest('hex');
  await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
    await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
      VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaaeClientId}::uuid, 'Lock wiring', 'two deliveries at once', 'received', 3, 1, now(), now())`.execute(trx);
    await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, 1, 'task.created', 'user', ${operatorUserId}, ${randomUUID()}::uuid,
        ${JSON.stringify({ payload: { headlineEn: 'Lock', copyEn: 'Lock wiring' } })}::jsonb, now())`.execute(trx);
    await sql`INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())`.execute(trx);
    const opId = randomUUID();
    await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
      VALUES (${opId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${operatorUserId}, ${'req_' + randomUUID().slice(0, 8)}, 'hash', 'export', 'retrieved', ${designId}, 1, ${JSON.stringify({ format: 'pptx' })}::jsonb, now(), now())`.execute(trx);
    await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
      VALUES (${exportId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${opId}::uuid, 'pptx', ${sha}, ${content},
        ${JSON.stringify({ copyPass: true, fontPass: true, rtlPass: true, status: 'passed' })}::jsonb, now())`.execute(trx);
  });
  const status = await app.request(`/tasks/${taskId}/notifications/canva-status`, {
    method: 'POST', headers, body: JSON.stringify({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId }),
  });
  expect(status.status).toBe(200);
  const revId = (await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) =>
    (await sql<any>`SELECT current_design_revision_id FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows[0])).current_design_revision_id;
  const approve = await app.request(`/tasks/${taskId}/revisions/${revId}/decisions`, {
    method: 'POST', headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' },
    body: JSON.stringify({ decision: 'approved', role: 'art_director', reason: 'lock wiring' }),
  });
  expect(approve.status).toBe(201);
  return taskId;
}

describe('delivery through Core holds the per-task publish lock', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` };
  // No outbox cleanup here: test files run in parallel against one database, and deleting the
  // tenant's commands removed the delivery notification the e2e chain test was waiting for.
  afterAll(async () => { await db.destroy(); });

  it('two simultaneous deliveries of one task reach the publisher once; the other is refused with 409', async () => {
    let inFlight = 0;
    let overlap = 0;
    const publish = vi.fn(async (_ctx: any, req: any) => {
      inFlight++;
      overlap = Math.max(overlap, inFlight);
      await new Promise((r) => setTimeout(r, 400));
      inFlight--;
      return {
        ok: true,
        value: {
          publicationId: `pub_${req.publicationKey}`, state: 'complete',
          driveFiles: req.files.map((f: any) => ({
            fileId: `file_${f.artifactId}`, artifactId: f.artifactId, name: f.filename, mimeType: f.mimeType,
            expectedSha256: f.sha256, observedSize: f.byteSize, verified: true, webViewLink: 'https://drive.example/f',
          })),
          sheet: { spreadsheetId: 'sheet', sheetId: 0, rowKey: req.taskId, rowNumber: 2, expectedHash: req.packageHash, observedHash: req.packageHash, synced: true, rowUrl: 'https://sheets.example/r' },
          detail: { verified: true, filesUploaded: req.files.length },
        },
      };
    });
    const process_ = () => createAppWithClientFixtures({
      db, testAuth: { roleHeader: true }, publisher: { publish },
      deliverableStore: canvaDeliverableStore(new CanvaConnectService(db)),
      telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }), dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }) } as any,
    });
    // Two Core processes over one database. Within one process an in-flight map already coalesces
    // a second call onto the first; the advisory lock is what stands between processes.
    const appA = process_();
    const appB = process_();
    const taskId = await approvedTask(db, appA, headers);

    const deliver = (app: any) => app.request(`/tasks/${taskId}/publish`, { method: 'POST', headers, body: JSON.stringify({ policy: 'current_task' }) });
    const [a, b] = await Promise.all([deliver(appA), deliver(appB)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(overlap).toBe(1);

    const refused = a.status === 409 ? await a.json() : await b.json();
    expect(JSON.stringify(refused)).toMatch(/PUBLICATION_IN_PROGRESS|delivering this task right now/);

    // The refused process retries after the other finished, and adopts the record instead of publishing again.
    const again = await deliver(a.status === 409 ? appA : appB);
    expect([200, 202]).toContain(again.status);
    expect((await again.json()).status).toBe('COMPLETE');
    expect(publish).toHaveBeenCalledTimes(1);
  }, 30_000);
});
