import { syntheticUnchangedCanvaVersion } from './fixtures/synthetic-canva-version.js';
import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { canvaDeliverableStore } from '../src/services/pinned-deliverables.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { checkedCanvaExportFixture } from '../../../packages/testkit/src/canva-export-fixture.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * Bug hunt 2026-09-24: the approval gate refuses the parent only while a change's run is live or its
 * draft exists. A change that is queued (no studio run yet), or waiting for the requester's answer
 * (paused), leaves the old design approvable; and Deliver never looks at changes at all.
 */
describe.skipIf(!url)('review of 2026-09-24: the old design while the requester\'s change is pending', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const operator = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` };
  afterAll(() => db.destroy());

  async function parentWithDraft() {
    const publisher = { publish: vi.fn(async () => ({ ok: false, error: { code: 'CREDENTIALS_MISSING', message: 'Google Workspace credentials not configured' } })) };
    const app = createApp({
      testAuth: { roleHeader: true },
      db,
      deliverableStore: syntheticUnchangedCanvaVersion(canvaDeliverableStore(new CanvaConnectService(db))),
      publisher,
      telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }), dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }) },
    } as any);
    // A Desk task: Core's own delivery refuses a Telegram task outside RequestLifecycle before it
    // looks at changes (ADR-135 stage 2d). The change is still the requester's, from their chat.
    const parent = randomUUID();
    const chat = String(60000000 + Math.floor(Math.random() * 9000000));
    const designId = `canva_hunt_${randomUUID().slice(0, 8)}`;
    const exportId = randomUUID();
    const checkedId = randomUUID();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);
    const { bytes: deck, contentCheck } = await checkedCanvaExportFixture('x');
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${parent}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'HUNT parent', 'x', 'received', 3, 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${parent}::uuid, 1, 'task.created', 'user', ${operator.userId}, ${randomUUID()}::uuid,
          ${JSON.stringify({ payload: { sourcePlatform: 'hawa_desk', sourceChannelId: 'hawa_desk', copyEn: 'x' } })}::jsonb, now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${parent}::uuid, ${kaae}::uuid, ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())`.execute(trx);
      for (const [format, bytes, id] of [['png', png, exportId], ['pptx', deck, checkedId]] as const) {
        const op = randomUUID();
        await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
          VALUES (${op}::uuid, ${tenantId}::uuid, ${parent}::uuid, ${kaae}::uuid, ${operator.userId}, ${'req_' + randomUUID().slice(0, 8)}, 'h', 'export', 'retrieved', ${designId}, 1, ${JSON.stringify({ format, designUpdatedAt: 200 })}::jsonb, now(), now())`.execute(trx);
        await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
          VALUES (${id}::uuid, ${tenantId}::uuid, ${parent}::uuid, ${kaae}::uuid, ${op}::uuid, ${format}, ${createHash('sha256').update(bytes).digest('hex')}, ${bytes},
            ${format === 'pptx' ? JSON.stringify(contentCheck) : null}::jsonb, now())`.execute(trx);
      }
    });
    const ready = await app.request(`/tasks/${parent}/notifications/canva-status`, {
      method: 'POST', headers, body: JSON.stringify({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId, notifyRequester: false }),
    });
    expect(ready.status).toBe(200);
    const detail = await (await app.request(`/tasks/${parent}`, { headers })).json();
    const approve = () => app.request(`/tasks/${parent}/revisions/${detail.latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' },
      body: JSON.stringify({ decision: 'approved', pinnedExportIds: [exportId, checkedId] }),
    });
    const deliver = () => app.request(`/tasks/${parent}/publish`, { method: 'POST', headers, body: JSON.stringify({ destination: 'google_drive' }) });
    return { app, parent, chat, approve, deliver };
  }

  /** The requester replied to the draft with a change: the change is its own task, as intake writes it. */
  async function requesterAskedForChange(parent: string, chat: string, state: string) {
    const child = randomUUID();
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${child}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'HUNT parent (Revision)', 'x', ${state}, 3, 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.outbox_commands (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload, state)
        VALUES (${tenantId}::uuid, 'task', ${child}::uuid, 'task.created', ${'hunt_' + randomUUID()},
          ${JSON.stringify({ sourceChannelId: chat, studioOptions: { parentTaskId: parent, revisionDirective: 'make the date gold' } })}::jsonb, 'delivered')`.execute(trx);
    });
    return child;
  }

  it('(control, passes) an operator cannot approve, a second approval is refused, and Deliver without Drive fails twice and queues nothing', async () => {
    const { app, parent, approve, deliver } = await parentWithDraft();
    const detail = await (await app.request(`/tasks/${parent}`, { headers })).json();
    const asOperator = await app.request(`/tasks/${parent}/revisions/${detail.latestRevisionId}/decisions`, {
      method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }),
    });
    expect(asOperator.status).toBe(403);
    expect((await approve()).status).toBe(201);
    expect((await approve()).status).toBe(409);
    // This app's client has no Drive folder: the failure is answered and the task goes back to
    // approved, so Deliver can be pressed again (ADR-135 stage 2d: no chat-only send to a requester).
    const first = await deliver();
    expect(first.status).toBe(400);
    expect((await first.json()).detail).toMatch(/no authorized Google Drive/);
    expect((await deliver()).status).toBe(400);
    expect((await (await app.request(`/tasks/${parent}`, { headers })).json()).status).toBe('APPROVED');
    const queued = await withRlsContext(db, operator, async (trx) =>
      (await sql<any>`SELECT count(*)::int AS n FROM hawa.outbox_commands WHERE aggregate_id = ${parent}::uuid AND command_type = 'notify.published'`.execute(trx)).rows[0].n);
    expect(queued).toBe(0);
  });

  it('refuses to approve the old design while the change is queued and its run has not started', async () => {
    const { parent, chat, approve } = await parentWithDraft();
    // Worker is waiting its turn (STUDIO_BUSY, up to 15 minutes) or the outbox has not dispatched yet.
    await requesterAskedForChange(parent, chat, 'received');
    const res = await approve();
    expect(res.status).toBe(409);
  });

  it('refuses to approve the old design while the change waits for the requester\'s answer', async () => {
    const { parent, chat, approve } = await parentWithDraft();
    // The change stopped to ask the requester a question (edit stage NEEDS_CLARIFICATION): paused.
    await requesterAskedForChange(parent, chat, 'paused');
    const res = await approve();
    expect(res.status).toBe(409);
  });

  it('does not deliver the old design once the requester has asked for a change after approval', async () => {
    const { parent, chat, approve, deliver } = await parentWithDraft();
    expect((await approve()).status).toBe(201);
    // Before the office pressed Deliver, the requester replied to the draft: "make the date gold".
    await requesterAskedForChange(parent, chat, 'received');
    const res = await deliver();
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toMatch(/not delivered/);
    const published = await withRlsContext(db, operator, async (trx) =>
      (await sql<any>`SELECT count(*)::int AS n FROM hawa.publications WHERE task_id = ${parent}::uuid`.execute(trx)).rows[0].n);
    expect(published).toBe(0);
  });

  it('does not deliver it through publish-omnichannel either, which never checked (audit 2026-09-27 #3)', async () => {
    const { app, parent, chat, approve } = await parentWithDraft();
    expect((await approve()).status).toBe(201);
    await requesterAskedForChange(parent, chat, 'received');
    const res = await app.request(`/tasks/${parent}/publish-omnichannel`, { method: 'POST', headers, body: '{}' });
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toMatch(/not delivered/);
    const published = await withRlsContext(db, operator, async (trx) =>
      (await sql<any>`SELECT count(*)::int AS n FROM hawa.publications WHERE task_id = ${parent}::uuid`.execute(trx)).rows[0].n);
    expect(published).toBe(0);
  });
});
