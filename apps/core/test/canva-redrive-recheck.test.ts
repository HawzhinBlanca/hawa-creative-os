import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { canvaDeliverableStore } from '../src/services/pinned-deliverables.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { checkedCanvaExportFixture } from '../../../packages/testkit/src/canva-export-fixture.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * 2026-09-24: a re-drive of a task whose design is already in Canva runs that draft's exports and
 * checks again, and records the new check as the draft's QC run. It answered ALREADY_BOUND and did
 * nothing before, so a draft whose automatic check had timed out could never be approved. Canva is
 * a fake here: its "exports" store the rows Canva Connect would, and no provider is called.
 */
describe.skipIf(!url)('re-driving a task whose Canva design already exists', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const operator = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const worker = '00000000-0000-4000-b000-0000000000aa';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` };
  afterAll(() => db.destroy());

  it('re-runs the preview and the copy-and-font check, records the check as QC, and the draft can be approved', async () => {
    const taskId = randomUUID();
    const chat = String(60000000 + Math.floor(Math.random() * 9000000));
    const designId = `canva_recheck_${randomUUID().slice(0, 8)}`;
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'Recheck bound draft', 'x', 'received', 3, 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, 1, 'task.created', 'user', ${operator.userId}, ${randomUUID()}::uuid,
          ${JSON.stringify({ payload: { sourcePlatform: 'telegram', sourceChannelId: chat, copyEn: 'x' } })}::jsonb, now())`.execute(trx);
      await sql`INSERT INTO hawa.outbox_commands (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload, state)
        VALUES (${tenantId}::uuid, 'task', ${taskId}::uuid, 'task.created', ${'recheck_' + randomUUID()},
          ${JSON.stringify({ sourcePlatform: 'telegram', sourceChannelId: chat, designStudio: true })}::jsonb, 'delivered')`.execute(trx);
      // The worker's import made the design: its actor is the Canva account that exports it.
      await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, metadata, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${worker}, ${'studio-' + randomUUID()}, 'h', 'create', 'retrieved', ${designId},
          '{"method":"pptx_import"}'::jsonb, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())`.execute(trx);
    });

    const exportIds: Record<string, string> = {};
    const checked = await checkedCanvaExportFixture('x');
    const canva = {
      startExport: vi.fn(async (s: { tenantId: string; actorId: string }, task: string, _key: string, format: 'png' | 'pptx', version: number) => {
        const op = randomUUID();
        const id = randomUUID();
        const bytes = format === 'png'
          ? Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())])
          : checked.bytes;
        const check = format === 'pptx' ? checked.contentCheck : null;
        await withRlsContext(db, operator, async (trx) => {
          await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
            VALUES (${op}::uuid, ${tenantId}::uuid, ${task}::uuid, ${kaae}::uuid, ${s.actorId}, ${'req_' + randomUUID().slice(0, 8)}, 'h', 'export', 'retrieved', ${designId}, ${version}, ${JSON.stringify({ format, designUpdatedAt: 200 })}::jsonb, now(), now())`.execute(trx);
          await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
            VALUES (${id}::uuid, ${tenantId}::uuid, ${task}::uuid, ${kaae}::uuid, ${op}::uuid, ${format}, ${createHash('sha256').update(bytes).digest('hex')}, ${bytes},
              ${check === null ? null : JSON.stringify(check)}::jsonb, now())`.execute(trx);
        });
        exportIds[format] = id;
        return { operationId: op, status: 'retrieved' };
      }),
      exportStatus: vi.fn(),
    };
    const app = createApp({
      testAuth: { roleHeader: true },
      db,
      canvaConnectService: canva,
      deliverableStore: canvaDeliverableStore(new CanvaConnectService(db)),
      telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }), dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }) },
    } as any);

    // The worker ran out of polls on the check export: the draft is recorded with a failed QC run.
    expect((await app.request(`/tasks/${taskId}/notifications/canva-status`, {
      method: 'POST', headers, body: JSON.stringify({ status: 'CANVA_CHECK_REQUIRED', designId, notifyRequester: false }),
    })).status).toBe(200);

    const redrive = await (await app.request(`/tasks/${taskId}/redrive`, {
      method: 'POST', headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' }, body: '{}',
    })).json();
    expect({ status: redrive.status, exports: redrive.recheck?.exports, passed: redrive.recheck?.qc?.criticalPass })
      .toEqual({ status: 'ALREADY_BOUND', exports: { png: 'retrieved', pptx: 'retrieved' }, passed: true });
    // Made with the design's own Canva account, at the bound version.
    expect(canva.startExport.mock.calls.map((c) => [c[0].actorId, c[3], c[4]]).sort())
      .toEqual([[worker, 'png', 1], [worker, 'pptx', 1]]);

    // Two QC runs for the revision: the one that timed out, then the re-run check.
    const qcRuns = async () => withRlsContext(db, operator, async (trx) =>
      Number((await sql<{ n: string }>`SELECT count(*) AS n FROM hawa.qc_runs WHERE task_id = ${taskId}::uuid`.execute(trx)).rows[0].n));
    expect(await qcRuns()).toBe(2);

    const detail = await (await app.request(`/tasks/${taskId}`, { headers })).json();
    const approve = await app.request(`/tasks/${taskId}/revisions/${detail.latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' },
      body: JSON.stringify({ decision: 'approved', pinnedExportIds: [exportIds.png, exportIds.pptx] }),
    });
    expect(approve.status).toBe(201);
  });
});
