import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { canvaDeliverableStore } from '../src/services/pinned-deliverables.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * Bug hunt 2026-09-24: Core restarts (every deploy restarts it) between approval and delivery, and
 * while a delivery is running. Two Core instances over one database stand in for before and after.
 */
describe.skipIf(!url)('review of 2026-09-24: approval and delivery across a Core restart', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const operator = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` };
  afterAll(() => db.destroy());

  const core = () => createApp({
    testAuth: { roleHeader: true },
    db,
    deliverableStore: canvaDeliverableStore(new CanvaConnectService(db)),
    publisher: { publish: vi.fn(async () => ({ ok: false, error: { code: 'CREDENTIALS_MISSING', message: 'Google Workspace credentials not configured' } })) },
    telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }), dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }) },
  } as any);

  async function approvedTask() {
    const before = core();
    const taskId = randomUUID();
    const designId = `canva_hunt_${randomUUID().slice(0, 8)}`;
    const pngId = randomUUID();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);
    const deck = Buffer.from(`PPTX_${randomUUID()}`);
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'HUNT restart', 'x', 'received', 3, 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, 1, 'task.created', 'user', ${operator.userId}, ${randomUUID()}::uuid,
          ${JSON.stringify({ payload: { sourcePlatform: 'telegram', sourceChannelId: String(60000000 + Math.floor(Math.random() * 9000000)), copyEn: 'x' } })}::jsonb, now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())`.execute(trx);
      for (const [format, bytes, id] of [['png', png, pngId], ['pptx', deck, randomUUID()]] as const) {
        const op = randomUUID();
        await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
          VALUES (${op}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${operator.userId}, ${'req_' + randomUUID().slice(0, 8)}, 'h', 'export', 'retrieved', ${designId}, 1, ${JSON.stringify({ format })}::jsonb, now(), now())`.execute(trx);
        await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
          VALUES (${id}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${op}::uuid, ${format}, ${createHash('sha256').update(bytes).digest('hex')}, ${bytes},
            ${JSON.stringify({ copyPass: true, fontPass: true, rtlPass: true, status: 'passed' })}::jsonb, now())`.execute(trx);
      }
    });
    expect((await before.request(`/tasks/${taskId}/notifications/canva-status`, {
      method: 'POST', headers, body: JSON.stringify({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId, notifyRequester: false }),
    })).status).toBe(200);
    const detail = await (await before.request(`/tasks/${taskId}`, { headers })).json();
    const approve = await before.request(`/tasks/${taskId}/revisions/${detail.latestRevisionId}/decisions`, {
      method: 'POST', headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' }, body: JSON.stringify({ decision: 'approved', pinnedExportIds: [pngId] }),
    });
    expect(approve.status).toBe(201);
    return taskId;
  }

  it('(control, passes) an approval made before a restart is delivered after it', async () => {
    const taskId = await approvedTask();
    const after = core();
    // The Desk enables Deliver only when the task it reads carries latestApproval.
    const seen = await (await after.request(`/tasks/${taskId}`, { headers })).json();
    expect(seen.latestApproval).toBeTruthy();
    const listed = (await (await after.request(`/tasks?status=APPROVED`, { headers })).json()).items?.find((i: any) => i.id === taskId);
    expect(listed?.latestApproval).toBeTruthy();
    const res = await after.request(`/tasks/${taskId}/publish`, { method: 'POST', headers, body: JSON.stringify({ destination: 'google_drive' }) });
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe('DELIVERED_TO_CHAT_ONLY');
  });

  it('a delivery interrupted by a restart can be delivered again from the Desk', async () => {
    const taskId = await approvedTask();
    // Deliver was pressed; Core moved the task to 'publishing' and was restarted (a deploy) while
    // the publisher ran, before it could put the task back to 'approved'.
    await withRlsContext(db, operator, (trx) => sql`UPDATE hawa.tasks SET state = 'publishing', version = version + 1 WHERE id = ${taskId}::uuid`.execute(trx));
    const after = core();
    const again = await after.request(`/tasks/${taskId}/publish`, { method: 'POST', headers, body: JSON.stringify({ destination: 'google_drive' }) });
    const body = await again.json();
    expect({ status: again.status, delivery: typeof body.status === 'string' ? body.status : body.title + ': ' + body.detail }).toEqual({ status: 202, delivery: 'DELIVERED_TO_CHAT_ONLY' });
  });
});
