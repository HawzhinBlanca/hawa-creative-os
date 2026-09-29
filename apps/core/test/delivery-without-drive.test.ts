import { syntheticUnchangedCanvaVersion } from './fixtures/synthetic-canva-version.js';
import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createAppWithClientFixtures } from './fixtures/app-with-client-fixtures.js';
import { canvaDeliverableStore } from '../src/services/pinned-deliverables.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { checkedCanvaExportFixture } from '../../../packages/testkit/src/canva-export-fixture.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * Production ran on 2026-09-23 with a placeholder Google credential ({type, project_id}, no key), so
 * delivery stopped at Drive. Core's own delivery then queued the approved export for the requester's
 * Telegram chat; since ADR-135 stage 2d it sends nothing to a requester (the request-owned Delivery
 * workflow does, and a Telegram task outside RequestLifecycle is refused: delivery-workflow.test.ts).
 * A Desk task's Deliver answers the Drive failure, and the task goes back to approved.
 */
describe.skipIf(!url)('an approved design when Drive cannot be written', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` };
  afterAll(() => db.destroy());

  it('answers the Drive failure, queues nothing for a requester, and leaves the task approved', async () => {
    const publisher = {
      publish: vi.fn(async () => ({ ok: false, error: { code: 'CREDENTIALS_MISSING', message: 'Google Workspace credentials not configured' } })),
    };
    const app = createAppWithClientFixtures({
      testAuth: { roleHeader: true },
      db,
      deliverableStore: syntheticUnchangedCanvaVersion(canvaDeliverableStore(new CanvaConnectService(db))),
      publisher,
      telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }), dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }) } as any,
    } as any);

    const taskId = randomUUID();
    const designId = `canva_nodrive_${randomUUID().slice(0, 8)}`;
    const opId = randomUUID();
    const exportId = randomUUID();
    const checkedId = randomUUID();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);
    await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'KAAE no-drive delivery', 'x', 'received', 3, 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, 1, 'task.created', 'user', ${operatorUserId}, ${randomUUID()}::uuid,
          ${JSON.stringify({ payload: { sourcePlatform: 'hawa_desk', sourceChannelId: 'hawa_desk', copyEn: 'x' } })}::jsonb, now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
        VALUES (${opId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${operatorUserId}, ${'req_' + randomUUID().slice(0, 8)}, 'h', 'export', 'retrieved', ${designId}, 1, ${JSON.stringify({ format: 'png', designUpdatedAt: 200 })}::jsonb, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
        VALUES (${exportId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${opId}::uuid, 'png', ${createHash('sha256').update(png).digest('hex')}, ${png},
          ${JSON.stringify({ copyPass: true, fontPass: true, rtlPass: true, status: 'passed' })}::jsonb, now())`.execute(trx);
    });

    // The deck export the QC reads, and the worker's "draft ready" report, which records the
    // revision and its QC run as production does.
    await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      const deckOp = randomUUID();
      const { bytes: deck, contentCheck } = await checkedCanvaExportFixture('x');
      await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
        VALUES (${deckOp}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${operatorUserId}, ${'req_' + randomUUID().slice(0, 8)}, 'h', 'export', 'retrieved', ${designId}, 1, ${JSON.stringify({ format: 'pptx', designUpdatedAt: 200 })}::jsonb, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
        VALUES (${checkedId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${deckOp}::uuid, 'pptx', ${createHash('sha256').update(deck).digest('hex')}, ${deck},
          ${JSON.stringify(contentCheck)}::jsonb, now())`.execute(trx);
    });
    const ready = await app.request(`/tasks/${taskId}/notifications/canva-status`, {
      method: 'POST', headers, body: JSON.stringify({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId, notifyRequester: false }),
    });
    expect(ready.status).toBe(200);
    const detail = await (await app.request(`/tasks/${taskId}`, { headers })).json();
    const approve = await app.request(`/tasks/${taskId}/revisions/${detail.latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' },
      body: JSON.stringify({ decision: 'approved', role: 'art_director', pinnedExportIds: [exportId, checkedId] }),
    });
    expect(approve.status).toBe(201);

    const deliver = await app.request(`/tasks/${taskId}/publish`, { method: 'POST', headers, body: JSON.stringify({ policy: 'current_task' }) });
    const body = await deliver.json();
    // The failure is the answer: no 202 DELIVERED_TO_CHAT_ONLY, no requester send.
    expect(deliver.status).toBe(422);
    expect(body).toMatchObject({ title: 'Publication Failed', detail: 'Google Workspace credentials not configured' });
    expect(body).not.toHaveProperty('requesterNotified');
    expect(publisher.publish).toHaveBeenCalledTimes(1);

    const notifyCount = async () => withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) =>
      (await sql<any>`SELECT count(*)::int AS n FROM hawa.outbox_commands WHERE aggregate_id = ${taskId}::uuid AND command_type = 'notify.published'`.execute(trx)).rows[0].n);
    expect(await notifyCount()).toBe(0);

    // Nothing reached Drive, so the task is approved again and Deliver can be retried.
    const state = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) =>
      (await sql<any>`SELECT state FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows[0].state);
    expect(state).toBe('approved');

    // A previous publication intent is not proof that no upload happened. A repeated press may
    // recheck credentials, but stays pending for reconciliation and still queues nothing.
    const repeated = await app.request(`/tasks/${taskId}/publish`, { method: 'POST', headers, body: JSON.stringify({ policy: 'current_task' }) });
    expect(repeated.status).toBe(503);
    expect((await repeated.json()).detail).toMatch(/archive may already exist/i);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(await notifyCount()).toBe(0);
  });
});
