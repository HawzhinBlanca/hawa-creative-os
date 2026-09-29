import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { createChatCampaignIntake } from '../src/services/chat-campaign-intake.js';
import { canvaDeliverableStore } from '../src/services/pinned-deliverables.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { withoutEmoji, savedDesignCopy } from '../src/services/canva-design-planner.js';
import { checkedCanvaExportFixture } from '../../../packages/testkit/src/canva-export-fixture.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * Each case is a way a message could spend money for nothing, found by the pre-test review of
 * 2026-09-23: an update delivered twice, a change sent while its design was still being made, a
 * second change before the first one's draft, a "from now on" rule read as a change to the latest
 * draft, and the old version of a changed design approved in the Desk.
 */
describe.skipIf(!url)('messages that must not start a paid design', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const operator = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const saved = { ...process.env };
  beforeAll(() => {
    delete process.env.OPENAI_API_KEY;
  });
  afterAll(async () => {
    process.env = saved;
    await db.destroy();
  });

  // ADR-135 stage 2: a new Telegram request is the draft prepareChatCampaignDraft builds for the
  // lifecycle. The cases for a duplicate update, a change while a design is made, a second change, a
  // "from now on" rule, /status and a photo refetch drove the deleted legacy webhook and went with it.
  it('a request that opens "Please make …" keeps that line out of the copy', async () => {
    const text = 'Please make a KAAE poster with the details below\nKAAE Annual Audit Conference\nJune 14, 2027, Erbil';
    const draft = await createChatCampaignIntake({ telegramBridge: {} } as any).prepareChatCampaignDraft({
      platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: String(60000000 + Math.floor(Math.random() * 9000000)),
      senderName: 'Owner', rawText: text, rawJson: { message: { text } }, autoGenerate: true, isInstructionOnly: false,
    });
    const copy = JSON.stringify(draft.exactCopy || []);
    expect(copy).not.toMatch(/Please make/);
    expect(copy).toMatch(/Annual Audit Conference/);
    expect(draft.designInstructions).toMatch(/Please make a KAAE poster/);
  });

  it('the older version of a changed design cannot be approved while the change is waiting', async () => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` };
    const app = createApp({ testAuth: { roleHeader: true }, db, deliverableStore: canvaDeliverableStore(new CanvaConnectService(db)) } as any);
    const parent = randomUUID();
    const child = randomUUID();
    const designId = `canva_guard_${randomUUID().slice(0, 8)}`;
    const exportId = randomUUID();
    const checkedId = randomUUID();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);
    const { bytes: deck, contentCheck } = await checkedCanvaExportFixture('x');
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${parent}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'KAAE guard parent', 'x', 'received', 3, 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${parent}::uuid, 1, 'task.created', 'user', ${operator.userId}, ${randomUUID()}::uuid,
          ${JSON.stringify({ payload: { sourcePlatform: 'telegram', sourceChannelId: '60000001', copyEn: 'x' } })}::jsonb, now())`.execute(trx);
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

    // The client asked for a change: the revision is its own task, and its draft is ready.
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${child}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'KAAE guard parent (Revision)', 'x', 'human_review', 3, 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.outbox_commands (tenant_id, aggregate_type, aggregate_id, command_type, idempotency_key, payload, state)
        VALUES (${tenantId}::uuid, 'task', ${child}::uuid, 'task.created', ${'guard_' + randomUUID()},
          ${JSON.stringify({ sourceChannelId: '60000001', studioOptions: { parentTaskId: parent } })}::jsonb, 'delivered')`.execute(trx);
    });
    const approve = () => app.request(`/tasks/${parent}/revisions/${detail.latestRevisionId}/decisions`, {
      method: 'POST',
      headers: { ...headers, Authorization: 'Bearer test_art_director_bearer' },
      body: JSON.stringify({ decision: 'approved', role: 'art_director', pinnedExportIds: [exportId, checkedId] }),
    });
    const refused = await approve();
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toMatch(/Approve the newer version instead/);

    // A revision that failed leaves the design the client saw approvable.
    await withRlsContext(db, operator, (trx) => sql`UPDATE hawa.tasks SET state = 'cancelled' WHERE id = ${child}::uuid`.execute(trx));
    expect((await approve()).status).toBe(201);
  });
});

describe('emoji in a brief', () => {
  it('are left out of the copy; the words around them are kept exactly', () => {
    expect(withoutEmoji('📍 Erbil International Hotel')).toBe('Erbil International Hotel');
    expect(withoutEmoji('📅 25 September 2026 🕘 9:00')).toBe('25 September 2026 9:00');
    expect(withoutEmoji('کۆنفرانسی 👍🏻 ساڵانە')).toBe('کۆنفرانسی ساڵانە');
    expect(withoutEmoji('© KAAE ™ 2026')).toBe('© KAAE ™ 2026');
    const saved = savedDesignCopy({ payload: { rawRequestText: 'KAAE poster\n---\n🎓 Graduation Day\n\n📍 Erbil' } }, '');
    expect(saved.copy).toEqual(['Graduation Day', 'Erbil']);
  });
});
