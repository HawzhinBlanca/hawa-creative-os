import {persistClientDnaFixture} from '../../../apps/core/test/fixtures/persisted-client-dna.js';
import { syntheticUnchangedCanvaVersion } from '../../../apps/core/test/fixtures/synthetic-canva-version.js';
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../../../apps/core/src/app.js';
import { createAppWithClientFixtures } from '../../../apps/core/test/fixtures/app-with-client-fixtures.js';
import { canvaDeliverableStore } from '../../../apps/core/src/services/pinned-deliverables.js';
import { CanvaConnectService } from '../../../apps/core/src/services/canva-connect-service.js';
import { checkedCanvaExportFixture } from '../src/canva-export-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');

const tenantId = '00000000-0000-4000-a000-000000000001';
const kaaeClientId = 'c1000000-0000-4000-8000-000000000002';
const operatorUserId = '00000000-0000-4000-b000-000000000001';

/** A task with a bound Canva design, one checked export, a Desk revision and an art director's approval. */
async function approvedTask(db: ReturnType<typeof createDb>, app: ReturnType<typeof createApp>, headers: Record<string, string>) {
  await persistClientDnaFixture(app,'c1000000-0000-4000-8000-000000000002',headers);
  const taskId = randomUUID();
  const designId = `dup_design_${randomUUID().slice(0, 8)}`;
  const exportId = randomUUID();
  const { bytes: content, contentCheck } = await checkedCanvaExportFixture('One delivery path');
  await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
    await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
      VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaaeClientId}::uuid, 'One delivery path', 'publish goes through the delivery service', 'received', 3, 1, now(), now())`.execute(trx);
    await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, 1, 'task.created', 'user', ${operatorUserId}, ${randomUUID()}::uuid,
        ${JSON.stringify({ payload: { headlineEn: 'One path', copyEn: 'One delivery path' } })}::jsonb, now())`.execute(trx);
    await sql`INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())`.execute(trx);
    const opId = randomUUID();
    await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
      VALUES (${opId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${operatorUserId}, ${'req_' + randomUUID().slice(0, 8)}, 'hash', 'export', 'retrieved', ${designId}, 1, ${JSON.stringify({ format: 'pptx', designUpdatedAt: 200 })}::jsonb, now(), now())`.execute(trx);
    await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
      VALUES (${exportId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaaeClientId}::uuid, ${opId}::uuid, 'pptx', ${createHash('sha256').update(content).digest('hex')}, ${content},
        ${JSON.stringify(contentCheck)}::jsonb, now())`.execute(trx);
  });
  const ready = await app.request(`/tasks/${taskId}/notifications/canva-status`, {
    method: 'POST', headers, body: JSON.stringify({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId }),
  });
  expect(ready.status).toBe(200);
  const revisionId = (await (await app.request(`/tasks/${taskId}`, { headers })).json()).latestRevisionId;
  const approve = await app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
    method: 'POST', headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' },
    body: JSON.stringify({ decision: 'approved', reason: 'one delivery path', pinnedExportIds: [exportId] }),
  });
  expect(approve.status).toBe(201);
  return taskId;
}

describe('Task 3: Elimination of Duplicate Paths', () => {
  // This used to read a 4,000-character slice of app.ts after the route's registration and look for
  // `executeOmnichannelPublish(`. It now counts what reaches the publisher: one delivery, however
  // often Deliver is pressed and whichever Core instance answers.
  it('POST /tasks/:taskId/publish reaches the publisher once, and answers a second press from the stored publication', async () => {
    const db = createDb(process.env.TEST_DATABASE_URL!);
    try {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` };
      const publish = vi.fn(async (_ctx: unknown, req: any) => ({
        ok: true,
        value: {
          publicationId: randomUUID(), publicationKey: req.publicationKey,
          driveFolderId: req.destination.productionRootFolderId, state: 'complete',
          driveFiles: req.files.map((f: any) => ({
            fileId: `file_${f.artifactId}`, folderId: req.destination.productionRootFolderId,
            artifactId: f.artifactId, name: f.filename, mimeType: f.mimeType,
            expectedSha256: f.sha256, observedSize: f.byteSize, verified: true, webViewLink: 'https://drive.example/f',
          })),
          sheet: { spreadsheetId: req.destination.spreadsheetId, sheetId: 0, rowKey: req.taskId, rowNumber: 2, expectedHash: req.packageHash, observedHash: req.packageHash, synced: true, rowUrl: 'https://sheets.example/r' },
          detail: { verified: true, filesUploaded: req.files.length },
        },
      }));
      const core = () => createAppWithClientFixtures({
        db, testAuth: { roleHeader: true }, publisher: { publish } as any,
        deliverableStore: syntheticUnchangedCanvaVersion(canvaDeliverableStore(new CanvaConnectService(db))),
        telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }), dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }) } as any,
      });
      const app = core();
      const taskId = await approvedTask(db, app, headers);
      const deliver = (target: ReturnType<typeof createApp>) =>
        target.request(`/tasks/${taskId}/publish`, { method: 'POST', headers, body: JSON.stringify({ policy: 'current_task' }) });

      const first = await deliver(app);
      expect(first.status).toBe(202);
      expect((await first.json()).status).toBe('COMPLETE');
      expect(publish).toHaveBeenCalledTimes(1);

      // Pressed again on the same instance, and on a restarted one that holds nothing in memory: the
      // answer comes from the recorded publication, and nothing is published a second time.
      for (const target of [app, core()]) {
        const again = await deliver(target);
        expect(again.status).toBe(200);
        expect((await again.json()).status).toBe('COMPLETE');
      }
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      await db.destroy();
    }
  }, 30_000);

  it('proves POST /tasks/:taskId/:control does not allow unpinned approve bypass', async () => {
    const app = createAppWithClientFixtures();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test_bearer',
      'x-user-role': 'art_director',
    };

    // Create a task
    const createRes = await app.request('/tasks', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Duplicate path test task', clientId: 'kaae' }),
    });
    expect(createRes.status).toBe(201);
    const task = await createRes.json();
    const taskId = task.id || task.taskId;

    // Attempting to approve via POST /tasks/:taskId/approve should NOT succeed as an unpinned state mutation
    const approveRes = await app.request(`/tasks/${taskId}/approve`, {
      method: 'POST',
      headers,
    });
    // Should be rejected or not found (must not transition task to APPROVED without decisions & pins)
    expect(approveRes.status).not.toBe(200);
    expect(approveRes.status).not.toBe(202);
  });

  it('designs only through DesignRun: TaskWorkflow and TaskService are bound refusing shims (ADR-287)', () => {
    const workerIndexContent = fs.readFileSync(path.resolve(rootDir, 'apps/worker/src/index.ts'), 'utf8');
    const designRunContent = fs.readFileSync(path.resolve(rootDir, 'apps/worker/src/lifecycle/design-run.ts'), 'utf8');
    expect(workerIndexContent).not.toContain('runCanvaDraft');
    expect(workerIndexContent).toContain('LEGACY_WORKFLOW_RETIRED');
    expect(designRunContent).toContain('runCanvaDraft(');
    expect(fs.existsSync(path.resolve(rootDir, 'apps/worker/src/workflow.ts'))).toBe(false);
  });
});
