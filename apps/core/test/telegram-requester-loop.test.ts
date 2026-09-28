import { describe, it, expect, afterAll, beforeAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext, OutboxRepository } from '@hawa/db';
import { createApp } from '../src/app.js';
import { remindUnansweredDrafts } from '../src/services/draft-reminders.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * HUNT (2026-09-24): what a real request meets on the way in and through the requester loop. Every
 * case drives the real webhook in-process with a fake bridge; no Telegram, Canva or model call.
 */
describe.skipIf(!url)('review of 2026-09-24: the requester loop', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const operator = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const secret = ['hunt', 'loop', 'fixture'].join('_');
  const OFFICE = 91000077;
  const saved = { ...process.env };
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  beforeAll(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
    process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
    delete process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
    delete process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER;
  });
  afterAll(async () => {
    process.env = saved;
    await db.destroy();
  });

  const setup = () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const bridge = {
      dispatchOutboundMessage: dispatch,
      dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }),
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      downloadFile: vi.fn().mockResolvedValue(PNG),
      handleCommand: vi.fn().mockReturnValue(null),
      formatTaskPreviewCard: vi.fn().mockReturnValue({}),
    };
    const app = createApp({ db, telegramBridge: bridge as any } as any);
    const chat = 64000000 + Math.floor(Math.random() * 9000000);
    const update = (message: Record<string, unknown>, updateId: string = randomUUID()) => ({
      update_id: updateId,
      message: { message_id: Math.floor(Math.random() * 1e6), from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' }, ...message },
    });
    const post = async (body: unknown, query = '') => {
      const res = await app.request(`/api/webhooks/telegram${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    };
    const send = (message: Record<string, unknown>) => post(update(message));
    const press = (data: string) =>
      post({ update_id: randomUUID(), callback_query: { id: randomUUID(), from: { id: OFFICE, is_bot: false }, message: { message_id: 5, chat: { id: chat, type: 'private' } }, data } });
    const texts = () => dispatch.mock.calls.map((c) => String(c[1]?.text ?? ''));
    const draftOf = (taskId: string) => ({ message_id: 99, from: { id: 1, is_bot: true, first_name: 'Hawa' }, chat: { id: chat, type: 'private' }, caption: `🎨 Canva draft · Task ID: ${taskId}\nReply to this image with any change you want.` });
    return { chat, post, update, send, press, texts, bridge, draftOf };
  };

  const tasksInChat = async (chat: number) =>
    (await withRlsContext(db, operator, async (trx) =>
      (await sql<{ id: string; payload: any }>`SELECT aggregate_id AS id, payload FROM hawa.outbox_commands
        WHERE command_type = 'task.created' AND payload->>'sourceChannelId' = ${String(chat)} ORDER BY created_at`.execute(trx)).rows));

  const startRun = (taskId: string, status: string) =>
    withRlsContext(db, operator, (trx) =>
      sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${kaae}::uuid, ${operator.userId}, ${'hunt_' + randomUUID()}, 'h', '{}'::jsonb, 'standard', ${status})`.execute(trx));

  it('a reply to a draft that a newer version replaced changes the newest version, not the old one', async () => {
    const { chat, send, draftOf } = setup();
    const brief = await send({ text: 'KAAE members evening\n---\nDecember 4, 2026\nErbil' });
    const a = String(brief.body.task.id);
    await startRun(a, 'transferred');
    const first = await send({ text: 'make the title gold', reply_to_message: draftOf(a) });
    expect(first.body.status).toBe('REVISION_QUEUED');
    const b = String(first.body.revisionTaskId);
    await startRun(b, 'transferred'); // B's draft was delivered
    // The requester scrolls up and replies to the first draft again.
    const second = await send({ text: 'move the date to the bottom', reply_to_message: draftOf(a) });
    expect(second.body.status).toBe('REVISION_QUEUED');
    const rows = await tasksInChat(chat);
    const made = rows.find((r) => r.id === second.body.revisionTaskId)!;
    // The buttons on A say "A newer version of this design exists"; a typed reply forks from A and loses "gold".
    expect(made.payload.studioOptions.parentTaskId).toBe(b);
  });

  it('over the daily cap, a second change is not dropped with "still being made"', async () => {
    const { chat, send, draftOf, texts } = setup();
    const brief = await send({ text: 'KAAE study day\n---\nApril 8, 2027\nErbil' });
    const a = String(brief.body.task.id);
    await startRun(a, 'transferred');
    process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '0';
    const first = await send({ text: 'make the title gold', reply_to_message: draftOf(a) });
    expect(first.body.status).toBe('REVISION_QUEUED');
    expect(texts().at(-1)).toMatch(/daily limit/);
    const second = await send({ text: 'and move the date to the bottom', reply_to_message: draftOf(a) });
    const said = texts().at(-1)!;
    // Nothing is being made: the first change was queued for a person, and no draft will arrive.
    expect.soft(second.body.status).not.toBe('DESIGN_STILL_RUNNING');
    expect.soft(said).not.toMatch(/still being made/);
    expect.soft(JSON.stringify(await tasksInChat(chat))).toContain('move the date to the bottom');
  });

  it('an album sent as a reply, captioned on its second photo: the caption reaches the change', async () => {
    const { chat, send, draftOf, texts } = setup();
    const brief = await send({ text: 'KAAE ethics seminar\n---\nFebruary 2, 2027\nErbil' });
    const a = String(brief.body.task.id);
    await startRun(a, 'transferred');
    const album = `hunt-album-${randomUUID().slice(0, 8)}`;
    const photo = (n: number) => [{ file_id: `f${n}`, file_unique_id: `u${n}`, width: 1200, height: 800 }];
    await send({ photo: photo(1), media_group_id: album, reply_to_message: draftOf(a) });
    const captioned = await send({ photo: photo(2), media_group_id: album, caption: 'put these two speakers at the top', reply_to_message: draftOf(a) });
    const all = JSON.stringify(await tasksInChat(chat));
    if (process.env.HUNT_DEBUG) console.log('DEBUG', JSON.stringify((await tasksInChat(chat)).map((r) => ({ id: r.id.slice(0, 8), auto: r.payload.autoGenerate, declined: r.payload.autoGenerateDeclined, parent: r.payload.studioOptions?.parentTaskId?.slice(0, 8), text: String(r.payload.rawRequestText).slice(0, 60) }))), captioned.body.status);
    expect.soft(captioned.body.status).not.toBe('DESIGN_STILL_RUNNING');
    expect.soft(texts().join('\n')).not.toMatch(/still being made/);
    expect.soft(all).toContain('put these two speakers at the top');
    // The second photo is not attached to any task either.
    expect.soft((await tasksInChat(chat)).filter((r) => r.payload?.studioOptions?.referenceImageBase64).length).toBe(2);
  });

  it('an album whose caption is on its second photo is not answered "send the request text now"', async () => {
    const { send, texts } = setup();
    const album = `hunt-album-${randomUUID().slice(0, 8)}`;
    const photo = (n: number) => [{ file_id: `f${n}`, file_unique_id: `u${n}`, width: 1200, height: 800 }];
    await send({ photo: photo(1), media_group_id: album });
    const request = await send({ photo: photo(2), media_group_id: album, caption: 'KAAE panel\n---\nSeptember 25, 2026\nErbil' });
    expect(request.status).toBe(201);
    // The text came in the same album: telling the sender to send it invites a second, paid request.
    expect(texts().join('\n')).not.toMatch(/Send the request text now/);
  });

  it('"thanks" in reply to a draft counts as an answer: no reminder, and a redelivery is not answered twice', async () => {
    const { chat, post, update, texts, draftOf } = setup();
    const taskId = randomUUID();
    const outbox = new OutboxRepository(db);
    await withRlsContext(db, operator, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, state) VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'KAAE hunt draft', 'human_review')`.execute(trx);
      await outbox.enqueue({ tenantId, aggregateType: 'task', aggregateId: taskId, commandType: 'task.created', idempotencyKey: `hunt-thanks:${taskId}`, payload: { sourcePlatform: 'telegram', sourceChannelId: String(chat) } }, trx);
      await outbox.enqueue({ tenantId, aggregateType: 'task', aggregateId: taskId, commandType: 'notify.telegram', idempotencyKey: `hunt-thanks-draft:${taskId}`, payload: { chatId: String(chat), status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' } }, trx);
      await sql`UPDATE hawa.outbox_commands SET state = 'delivered', created_at = now() - interval '30 hours' WHERE aggregate_id = ${taskId}::uuid AND command_type = 'notify.telegram'`.execute(trx);
    });
    const body = update({ text: 'thanks, perfect!', reply_to_message: draftOf(taskId) });
    const res = await post(body);
    expect(res.body).toMatchObject({ status: 'PROCESSED', kind: 'other' });
    const again = await post(body);
    expect.soft(again.body.duplicate).toBe(true);
    expect.soft(texts().filter((t) => /Thank you/.test(t))).toHaveLength(1);
    const officeHours = new Date(new Date().toISOString().slice(0, 10) + 'T07:00:00Z');
    await remindUnansweredDrafts({ db, outbox, tenantId, userId: operator.userId, now: officeHours, from: '2026-01-01T00:00:00Z' });
    const reminders = await withRlsContext(db, operator, async (trx) =>
      (await sql<{ key: string }>`SELECT idempotency_key AS key FROM hawa.outbox_commands WHERE aggregate_id = ${taskId}::uuid AND idempotency_key LIKE 'notify.telegram:reminder%'`.execute(trx)).rows);
    expect(reminders).toEqual([]);
  });

  it('a size button on a draft a newer version replaced is refused like the other buttons', async () => {
    const { send, press, draftOf } = setup();
    const brief = await send({ text: 'KAAE graduation\n---\nMarch 3, 2027\nErbil' });
    const a = String(brief.body.task.id);
    await startRun(a, 'transferred');
    await press(`rq:ok:${a}`);
    const change = await send({ text: 'make the title gold', reply_to_message: draftOf(a) });
    expect(change.body.status).toBe('REVISION_QUEUED');
    const story = await press(`rq:sst:${a}`);
    // A paid story version of the design the requester has since changed.
    expect(story.body.sizeTaskId).toBeUndefined();
  });

  it('Approve on a draft whose change is still being made does not point at a newest draft that does not exist', async () => {
    const { send, press, draftOf, texts } = setup();
    const brief = await send({ text: 'KAAE open day\n---\nMay 9, 2027\nErbil' });
    const a = String(brief.body.task.id);
    await startRun(a, 'transferred');
    const change = await send({ text: 'make the title gold', reply_to_message: draftOf(a) });
    expect(change.body.status).toBe('REVISION_QUEUED');
    await press(`rq:ok:${a}`);
    expect(texts().at(-1)).not.toMatch(/Use the buttons on the newest draft/);
  });

  it('the acknowledgement of a long change never splits an emoji', async () => {
    const { send, draftOf, texts } = setup();
    const brief = await send({ text: 'KAAE forum\n---\nJune 1, 2027\nErbil' });
    const a = String(brief.body.task.id);
    await startRun(a, 'transferred');
    const change = 'make the title gold and ' + 'x'.repeat(499 - 'make the title gold and '.length) + '🎓 and move the logo up';
    expect(change.charCodeAt(499)).toBeGreaterThanOrEqual(0xd800);
    const res = await send({ text: change, reply_to_message: draftOf(a) });
    expect(res.body.status).toBe('REVISION_QUEUED');
    const ack = texts().find((t) => t.startsWith('✏️ <b>Change received'))!;
    // A lone surrogate is not valid UTF-8; Telegram refuses the whole message.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(ack)).toBe(false);
  });

  it('a reply in one chat to a draft made for another chat does not revise that design', async () => {
    const owner = setup();
    const brief = await owner.send({ text: 'KAAE board meeting\n---\nJuly 7, 2027\nErbil' });
    const theirs = String(brief.body.task.id);
    await startRun(theirs, 'transferred');
    // Someone forwards the draft into another chat with the bot and replies to it there.
    const other = setup();
    const res = await other.send({ text: 'make the title bigger', reply_to_message: other.draftOf(theirs) });
    const made = (await tasksInChat(other.chat)).find((r) => r.id === res.body.revisionTaskId);
    // The buttons refuse this ("This button belongs to a design made for another chat"); a typed reply does not.
    expect.soft(res.body.status).not.toBe('REVISION_QUEUED');
    expect.soft(made?.payload?.studioOptions?.parentTaskId).not.toBe(theirs);
  });

  it('a Kurdish request that mentions health is not scoped, auto-drafted and acknowledged as Drustee\'s', async () => {
    const { chat, post, update, texts } = setup();
    const res = await post(update({ text: 'بانگهێشت بۆ سیمیناری وەزارەتی تەندروستی\n\n١٢ی تشرینی یەکەم، هۆڵی ئاسیا، هەولێر' }), '?generate=true');
    expect(res.status).toBe(201);
    const [row] = await tasksInChat(chat);
    // Scoped to the seeded Drustee client row and queued for an automatic draft.
    expect.soft(row.payload.clientId).not.toBe('c1000000-0000-4000-8000-000000000003');
    expect.soft(row.payload.autoGenerate).not.toBe(true);
    // The requester is told the client is Drustee and that an automatic Canva draft is on its way.
    expect.soft(texts().join('\n')).not.toMatch(/Drustee/);
  });
});
