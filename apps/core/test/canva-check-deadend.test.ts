import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { canvaDeliverableStore } from '../src/services/pinned-deliverables.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * Bug hunt 2026-09-24: the worker polls the copy-and-font PPTX export 30 x 2 s. When Canva takes
 * longer (or one Core call is refused), the draft is reported CANVA_CHECK_REQUIRED and bridged with
 * a failed QC run. The office is told to "resolve it in Canva and capture again before approval",
 * but nothing ever writes a second QC run for a Canva revision: the bridge runs once
 * (REVISION_EXISTS), the Desk capture is PNG-only and runs no QC, and a re-drive of a bound task
 * answers ALREADY_BOUND. The design is unapprovable for good, even though its check passes.
 */
describe.skipIf(!url)('HUNT: a draft whose automatic check ran out of time', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const operator = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` };
  afterAll(() => db.destroy());

  const storeExport = (taskId: string, designId: string, format: 'png' | 'pptx', bytes: Buffer, check: unknown) =>
    withRlsContext(db, operator, async (trx) => {
      const op = randomUUID();
      const id = randomUUID();
      await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
        VALUES (${op}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${operator.userId}, ${'req_' + randomUUID().slice(0, 8)}, 'h', 'export', 'retrieved', ${designId}, 1, ${JSON.stringify({ format, designUpdatedAt: 200 })}::jsonb, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
        VALUES (${id}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${op}::uuid, ${format}, ${createHash('sha256').update(bytes).digest('hex')}, ${bytes},
          ${check === null ? null : JSON.stringify(check)}::jsonb, now())`.execute(trx);
      return id;
    });

  it('can be approved once the check export is stored and passes', async () => {
    const app = createApp({
      testAuth: { roleHeader: true },
      db,
      deliverableStore: canvaDeliverableStore(new CanvaConnectService(db)),
      telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }), dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }) },
    } as any);
    const taskId = randomUUID();
    const chat = String(60000000 + Math.floor(Math.random() * 9000000));
    const designId = `canva_hunt_${randomUUID().slice(0, 8)}`;
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'HUNT slow check', 'x', 'received', 3, 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, 1, 'task.created', 'user', ${operator.userId}, ${randomUUID()}::uuid,
          ${JSON.stringify({ payload: { sourcePlatform: 'telegram', sourceChannelId: chat, copyEn: 'x' } })}::jsonb, now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())`.execute(trx);
    });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);
    const pngId = await storeExport(taskId, designId, 'png', png, null);

    // The worker's 30 polls of the PPTX export ran out while Canva was still exporting.
    const report = await app.request(`/tasks/${taskId}/notifications/canva-status`, {
      method: 'POST', headers, body: JSON.stringify({ status: 'CANVA_CHECK_REQUIRED', designId, notifyRequester: false }),
    });
    expect(report.status).toBe(200);

    // A moment later the export is retrieved (resume, or the office's capture) and its check passes.
    const checkedId = await storeExport(taskId, designId, 'pptx', Buffer.from(`PPTX_${randomUUID()}`), { copyPass: true, fontPass: true, rtlPass: true, status: 'passed' });

    // Every route the office has: re-drive (answers ALREADY_BOUND), a repeated "ready" report
    // (REVISION_EXISTS), then approval with both the PNG and its checked editable source pinned.
    await app.request(`/tasks/${taskId}/redrive`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' }, body: '{}' });
    await app.request(`/tasks/${taskId}/notifications/canva-status`, {
      method: 'POST', headers, body: JSON.stringify({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId, notifyRequester: false }),
    });
    const detail = await (await app.request(`/tasks/${taskId}`, { headers })).json();
    const approve = await app.request(`/tasks/${taskId}/revisions/${detail.latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' },
      body: JSON.stringify({ decision: 'approved', pinnedExportIds: [pngId, checkedId] }),
    });
    const body = await approve.json();
    expect({ status: approve.status, title: body.title }).toEqual({ status: 201, title: undefined });
  });

  it('a bound design whose preview export was refused once (CANVA_PREVIEW_UNCERTAIN) still reaches the Desk', async () => {
    const telegram = { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }), dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }) };
    const app = createApp({ testAuth: { roleHeader: true }, db, deliverableStore: canvaDeliverableStore(new CanvaConnectService(db)), telegramBridge: telegram } as any);
    const taskId = randomUUID();
    const chat = String(60000000 + Math.floor(Math.random() * 9000000));
    const designId = `canva_hunt_${randomUUID().slice(0, 8)}`;
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'HUNT preview 429', 'x', 'received', 3, 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, 1, 'task.created', 'user', ${operator.userId}, ${randomUUID()}::uuid,
          ${JSON.stringify({ payload: { sourcePlatform: 'telegram', sourceChannelId: chat, copyEn: 'x' } })}::jsonb, now())`.execute(trx);
      await sql`INSERT INTO hawa.outbox_commands (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload, state)
        VALUES (${tenantId}::uuid, 'task', ${taskId}::uuid, 'task.created', ${'hunt_' + randomUUID()},
          ${JSON.stringify({ sourcePlatform: 'telegram', sourceChannelId: chat, designStudio: true })}::jsonb, 'delivered')`.execute(trx);
      await sql`INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())`.execute(trx);
    });
    // The worker's preview export got a 429 from Canva: Core recorded it 'uncertain', and the worker
    // reported CANVA_PREVIEW_UNCERTAIN with the design id.
    expect((await app.request(`/tasks/${taskId}/notifications/canva-status`, {
      method: 'POST', headers, body: JSON.stringify({ status: 'CANVA_PREVIEW_UNCERTAIN', designId, notifyRequester: false }),
    })).status).toBe(200);
    // The office's re-drive is the only button left for a failed task.
    const redrive = await (await app.request(`/tasks/${taskId}/redrive`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' }, body: '{}' })).json();
    const detail = await (await app.request(`/tasks/${taskId}`, { headers })).json();
    expect({
      redrive: redrive.status,
      deskStatus: detail.status,
      revisionToApprove: Boolean(detail.latestRevisionId),
    }).toEqual({ redrive: expect.any(String), deskStatus: 'AWAITING_APPROVAL', revisionToApprove: true });
  });
});
