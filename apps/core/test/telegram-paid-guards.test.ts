import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext, ClientRulesRepository } from '@hawa/db';
import { createApp } from '../src/app.js';
import { canvaDeliverableStore } from '../src/services/pinned-deliverables.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { withoutEmoji, savedDesignCopy } from '../src/services/canva-design-planner.js';

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
  const secret = ['paid', 'guards', 'fixture'].join('_');
  const OFFICE = 91000002;
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
    delete process.env.OPENAI_API_KEY;
  });
  afterAll(async () => {
    process.env = saved;
    await db.destroy();
  });

  const setup = (extra: Record<string, unknown> = {}) => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const bridge = {
      dispatchOutboundMessage: dispatch,
      dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      downloadFile: vi.fn(),
      handleCommand: vi.fn().mockReturnValue(null),
      formatTaskPreviewCard: vi.fn().mockReturnValue({}),
    };
    const app = createApp({ db, telegramBridge: bridge as any, ...extra } as any);
    const chat = 60000000 + Math.floor(Math.random() * 9000000);
    const update = (message: Record<string, unknown>, updateId: string = randomUUID()) => ({
      update_id: updateId,
      message: { message_id: Math.floor(Math.random() * 1e6), from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' }, ...message },
    });
    const post = async (body: unknown) => {
      const res = await app.request('/api/webhooks/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const send = (message: Record<string, unknown>) => post(update(message));
    const replies = () => dispatch.mock.calls.map((c) => String(c[1]?.text ?? '')).join('\n---\n');
    const draftOf = (taskId: string) => ({ message_id: 99, from: { id: 1, is_bot: true, first_name: 'Hawa' }, chat: { id: chat, type: 'private' }, text: `🎨 Canva draft · Task ID: ${taskId}` });
    return { app, chat, post, update, send, replies, bridge, draftOf };
  };

  const tasksInChat = async (chat: number) =>
    (await withRlsContext(db, operator, (trx) =>
      trx.selectFrom('outbox_commands').select(['aggregate_id', 'payload']).where('command_type', '=', 'task.created').execute()
    )).filter((r: any) => String(r.payload?.sourceChannelId) === String(chat));

  const startRun = (taskId: string, status: string) =>
    withRlsContext(db, operator, (trx) =>
      sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${operator.userId}, ${'guard_' + randomUUID()}, 'h', '{}'::jsonb, 'standard', ${status})`.execute(trx));

  it('an update Telegram delivers twice is handled once', async () => {
    const { chat, post, update } = setup();
    const body = update({ text: 'KAAE members evening\n---\nDecember 4, 2026\nErbil' });
    const first = await post(body);
    expect(first.status).toBe(201);
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('a change to a design still being made starts nothing and says so', async () => {
    const { chat, send, replies, draftOf } = setup();
    const brief = await send({ text: 'KAAE audit forum\n---\nJanuary 9, 2027\nErbil' });
    const taskId = brief.body.task.id;
    await startRun(taskId, 'laying_out');
    const change = await send({ text: 'move the logo to the top-left', reply_to_message: draftOf(taskId) });
    expect(change.status).toBe(200);
    expect(change.body.status).toBe('DESIGN_STILL_RUNNING');
    expect(replies()).toMatch(/still being made/);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('a second change before the first one\'s draft starts nothing', async () => {
    const { chat, send, replies, draftOf } = setup();
    const brief = await send({ text: 'KAAE ethics seminar\n---\nFebruary 2, 2027\nErbil' });
    const taskId = brief.body.task.id;
    await startRun(taskId, 'transferred');
    const first = await send({ text: 'make the title gold', reply_to_message: draftOf(taskId) });
    expect(first.body.status).toBe('REVISION_QUEUED');
    // The revision's own reply carries its Task ID, so a reply to it reaches the revision.
    expect(replies()).toContain(first.body.revisionTaskId);
    const second = await send({ text: 'and move the date up', reply_to_message: draftOf(taskId) });
    expect(second.body.status).toBe('DESIGN_STILL_RUNNING');
    expect(replies()).toMatch(/previous change .* is still being made/s);
    expect(await tasksInChat(chat)).toHaveLength(2);
  });

  it('"from now on …" sent on its own is a rule, not a change to the latest draft', async () => {
    const { chat, send } = setup();
    const brief = await send({ text: 'KAAE graduation\n---\nMarch 3, 2027\nErbil' });
    await startRun(brief.body.task.id, 'transferred');
    const words = `From now on, always put the KAAE logo bottom-right ${randomUUID().slice(0, 6)}`;
    const res = await send({ text: words });
    expect(res.body.status).toBe('RULE_SAVED');
    expect(await tasksInChat(chat)).toHaveLength(1);
    const rule = (await withRlsContext(db, operator, (trx) => new ClientRulesRepository(trx).listActive(tenantId, kaae))).find((r) => r.humanRule === words);
    expect(rule).toBeDefined();
    await withRlsContext(db, operator, (trx) => new ClientRulesRepository(trx).deactivate(tenantId, kaae, rule!.id));
  });

  it('/status with words after it still lists the requests', async () => {
    const { send, replies } = setup();
    await send({ text: 'KAAE study day\n---\nApril 8, 2027\nErbil' });
    const res = await send({ text: '/status now' });
    expect(res.body.command).toBe(true);
    expect(replies()).toMatch(/Your latest requests/);
  });

  it('a picture Telegram could not hand over is fetched again, not dropped', async () => {
    const { send, bridge } = setup();
    bridge.downloadFile.mockRejectedValue(new Error('ETIMEDOUT'));
    const res = await send({ caption: 'KAAE poster\n---\nMay 5, 2027', photo: [{ file_id: 'p1', file_unique_id: 'u1', width: 800, height: 800 }] });
    expect(res.status).toBe(503);
  });

  it('a request that opens "Please make …" keeps that line out of the copy', async () => {
    const { chat, send } = setup();
    const res = await send({ text: 'Please make a KAAE poster with the details below\nKAAE Annual Audit Conference\nJune 14, 2027, Erbil' });
    expect(res.status).toBe(201);
    const [row] = await tasksInChat(chat);
    const copy = JSON.stringify((row as any).payload.exactCopy || []);
    expect(copy).not.toMatch(/Please make/);
    expect(copy).toMatch(/Annual Audit Conference/);
  });

  it('the older version of a changed design cannot be approved while the change is waiting', async () => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN || 'test_bearer'}` };
    const app = createApp({ testAuth: { roleHeader: true }, db, deliverableStore: canvaDeliverableStore(new CanvaConnectService(db)) } as any);
    const parent = randomUUID();
    const child = randomUUID();
    const designId = `canva_guard_${randomUUID().slice(0, 8)}`;
    const exportId = randomUUID();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);
    const deck = Buffer.from(`PPTX_${randomUUID()}`);
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${parent}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'KAAE guard parent', 'x', 'received', 3, 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${parent}::uuid, 1, 'task.created', 'user', ${operator.userId}, ${randomUUID()}::uuid,
          ${JSON.stringify({ payload: { sourcePlatform: 'telegram', sourceChannelId: '60000001', copyEn: 'x' } })}::jsonb, now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_bindings (id, tenant_id, task_id, client_id, canva_design_id, edit_url, status, version, created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${parent}::uuid, ${kaae}::uuid, ${designId}, ${`https://www.canva.com/design/${designId}/edit`}, 'bound', 1, now(), now())`.execute(trx);
      for (const [format, bytes, id] of [['png', png, exportId], ['pptx', deck, randomUUID()]] as const) {
        const op = randomUUID();
        await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
          VALUES (${op}::uuid, ${tenantId}::uuid, ${parent}::uuid, ${kaae}::uuid, ${operator.userId}, ${'req_' + randomUUID().slice(0, 8)}, 'h', 'export', 'retrieved', ${designId}, 1, ${JSON.stringify({ format })}::jsonb, now(), now())`.execute(trx);
        await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, content_check, created_at)
          VALUES (${id}::uuid, ${tenantId}::uuid, ${parent}::uuid, ${kaae}::uuid, ${op}::uuid, ${format}, ${createHash('sha256').update(bytes).digest('hex')}, ${bytes},
            ${JSON.stringify({ copyPass: true, fontPass: true, rtlPass: true, status: 'passed' })}::jsonb, now())`.execute(trx);
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
      body: JSON.stringify({ decision: 'approved', role: 'art_director', pinnedExportIds: [exportId] }),
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
