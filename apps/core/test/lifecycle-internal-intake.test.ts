import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, readTelegramKillSwitch, sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { blobStoreFor } from '../src/services/blob-store-context.js';
import { recordRevisionPhotoDecision } from '../src/services/lifecycle-chat-target.js';
import { lifecyclePhotoInput } from '../src/services/lifecycle-photo.js';
import { projectLifecycleRequesterRevisionWithIntake } from '../src/services/lifecycle-projection.js';
import { PARKED_UPDATE_NOTICE } from '../src/services/polled-update-dispatch.js';
import { productionAppOptions } from '../src/entrypoint-options.js';
import { telegramPollerOf } from '../src/services/telegram-poller-owner.js';

/**
 * Core's side of Phase 2.1 (PHASE2_DESIGN.md slice 2.1), against the per-file test database as
 * hawa_app (row-level security as in production): the worker's ChatInbox hands each update to
 * POST /v1/internal/telegram/intake, and dead-letters one intake keeps failing through
 * POST /v1/internal/telegram/park. Since ADR-135 every chat is lifecycle-owned (no chat setting
 * exists) and only the worker polls; since its stage 2 there is no old intake, and the answers it gave
 * to greetings, questions, thanks, rules and chat commands come from lifecycle-chat-answers.ts, sent
 * by ChatInbox (lifecycleAction 'chat-answer').
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const operatorUserId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
const OFFICE = 91000007;
const WORKER = ['worker', 'intake', 'fixture', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };
const operator = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
const admin = { 'Content-Type': 'application/json', Authorization: 'Bearer test_admin_key' };

const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await createApp({ db } as any).request('/v1/operations/kill-switch', { method: 'POST', headers: { ...operator, Authorization: 'Bearer test_admin_key' }, body: JSON.stringify({ channel: 'telegram', active: false }) });
});
afterAll(async () => {
  process.env = saved;
  await db.destroy();
});

const chatId = () => 62_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_100_000_000 + Math.floor(Math.random() * 800_000_000);
const brief = (id: number, chat: number) => ({
  update_id: id,
  message: { message_id: id % 100000, from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' }, date: 1790000000, text: 'KAAE members evening\n---\nDecember 4, 2026\nErbil' },
});

/** Preserve the source file, including a thumbnail that must never replace it. */
function asImageDocument(update: { message: unknown }): void {
  const message = update.message as Record<string, unknown>;
  const photos = message.photo as Array<{ file_id: string; file_size?: number }>;
  message.document = { ...photos[photos.length - 1], file_name: 'original.png', mime_type: 'image/png',
    thumbnail: { file_id: 'thumbnail-must-not-download' } };
  delete message.photo;
}

/** Telegram's sendMessage, recorded; anything else goes to the real fetch. */
function fakeTelegram() {
  const realFetch = globalThis.fetch;
  const sent: Array<{ chat_id: string | number; text: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
    if (url.includes('/sendMessage')) {
      const body = JSON.parse(String(init?.body || '{}'));
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: 1 + sent.length, chat: { id: body.chat_id } } });
    }
    return Response.json({ ok: true, result: true });
  });
  return { sent };
}

const tasksInChat = async (chat: number) =>
  (await withRlsContext(db, scope, (trx) =>
    trx.selectFrom('outbox_commands').select(['aggregate_id', 'payload']).where('command_type', '=', 'task.created').execute()
  )).filter((r: any) => String(r.payload?.sourceChannelId) === String(chat));

const intake = async (app: any, update: unknown, mode?: string, requestId?: string) => {
  const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker, body: JSON.stringify({ v: 1, update, ...(mode ? { mode } : { mode: 'legacy' }), ...(requestId ? { requestId } : {}) }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function seedWaitingRequest(app: any, chat: number) {
  const requestId = randomUUID();
  const created = await persistChatIntake(db, {
    platform: 'telegram', sourceEventId: `lc-seed-${requestId}`, sourceChannelId: String(chat),
    rawText: 'KAAE members evening', title: 'KAAE members evening', clientId,
    designInstructions: 'Make the approved event design', exactCopy: [{ text: 'December 4, 2026' }],
    autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 },
    studioOptions: { tier: 'quality' },
  }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id,
      parent_request_id, owner, stage, rev, chat_id)
    VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid,
      null, 'restate', 'manual', 3, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid
      WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  return { requestId, taskId };
}

/** A request-owned request at a later stage, with one sent lifecycle message the requester can reply to. */
async function seedRequestAt(app: any, chat: number, stage: string, rev: number, sent: { key: string; messageId: string }) {
  const { requestId, taskId } = await seedWaitingRequest(app, chat);
  await withRlsContext(db, scope, async (trx) => {
    await sql`UPDATE hawa.requests SET stage = ${stage}, rev = ${rev}
      WHERE tenant_id = ${tenantId}::uuid AND request_id = ${requestId}::uuid`.execute(trx);
    await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id,
        event_kind, payload, payload_hash, verified)
      VALUES (${tenantId}::uuid, 'telegram_delivery', ${`lc:${requestId}:${sent.key}:send`},
        'telegram_message_sent', ${JSON.stringify({ messageId: sent.messageId })}::jsonb,
        ${`test-sent-${requestId}`}, true)`.execute(trx);
  });
  return { requestId, taskId };
}

const lateReceipt = async (id: number) => (await withRlsContext(db, scope, (trx) => sql<{ event_kind: string; payload: Record<string, unknown> }>`
  SELECT event_kind, payload FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid
    AND source_account_id = 'lifecycle_chat_routing' AND source_event_id = ${String(id)}`.execute(trx))).rows;

describe('a requester change after the design reached the office (finding 13 of the Phase 4 review)', () => {
  const words = 'The phone number is wrong: it must be 0750 123 4567';

  it('keeps the words of a reply to the approved draft, alerts the office and starts nothing', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId, taskId } = await seedRequestAt(app, chat, 'approved', 3, { key: '2:design-outcome', messageId: '811' });
    const reply = brief(updateId(), chat);
    reply.message.text = words;
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 811 };
    const answer = await intake(app, reply, 'lifecycle', requestId);
    expect(answer.body).toMatchObject({ intakeStatus: 409, code: 'LATE_REQUESTER_CHANGE',
      lifecycleAction: 'late-change', chatId: String(chat), requestId, requestStage: 'approved',
      officeAlert: { chatId: String(OFFICE), text: expect.stringContaining(words) } });
    expect(answer.body.officeAlert.text).toContain(taskId);
    expect(answer.body.officeAlert.text).toMatch(/acknowledge/i);
    expect(await tasksInChat(chat)).toHaveLength(1);
    expect(await lateReceipt(reply.update_id)).toEqual([{ event_kind: 'lifecycle_late_requester_change',
      payload: expect.objectContaining({ code: 'LATE_REQUESTER_CHANGE', chatId: String(chat), requestId,
        taskId, requestRev: 3, requestStage: 'approved', text: words }) }]);

    // A lost answer replays the stored decision, even after the request moved on.
    await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.requests SET stage = 'delivered', rev = 5
      WHERE tenant_id = ${tenantId}::uuid AND request_id = ${requestId}::uuid`.execute(trx));
    const replay = await intake(createApp({ db } as any), reply, 'lifecycle', requestId);
    expect(replay.body).toEqual(answer.body);
    const changed = await intake(app, { ...reply, message: { ...reply.message, text: 'Something else' } }, 'lifecycle', requestId);
    expect(changed.body).toMatchObject({ intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it.each([
    ['in_review', 2, '2:design-outcome'],
    ['approved', 5, '3:office-revision-notify'],
    ['delivering', 4, '2:design-outcome'],
    ['delivered', 5, '2:design-outcome'],
  ] as const)('a reply while the request is %s (rev %s, to %s) is a late change, not a stale reply', async (stage, rev, key) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId } = await seedRequestAt(app, chat, stage, rev, { key, messageId: '812' });
    const reply = brief(updateId(), chat);
    reply.message.text = words;
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 812 };
    const answer = await intake(app, reply, 'lifecycle', requestId);
    expect(answer.body).toMatchObject({ intakeStatus: 409, code: 'LATE_REQUESTER_CHANGE',
      lifecycleAction: 'late-change', requestId, requestStage: stage });
    expect(answer.body.officeAlert.text).toContain(words);
  });

  it('a captioned photo reply after approval keeps the caption, says a photo came, and downloads nothing', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const bridge = { downloadFile: vi.fn(async () => Buffer.from('not used')),
      dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
    const app = createApp({ db, telegramBridge: bridge } as any);
    const { requestId } = await seedRequestAt(app, chat, 'approved', 3, { key: '2:design-outcome', messageId: '815' });
    const reply = brief(updateId(), chat);
    const message = reply.message as Record<string, unknown>;
    delete message.text;
    message.caption = words;
    message.photo = [{ file_id: 'late-photo-small', file_size: 100, width: 90, height: 90 },
      { file_id: 'late-photo', file_size: 1000, width: 900, height: 900 }];
    message.reply_to_message = { message_id: 815 };
    const answer = await intake(app, reply, 'lifecycle', requestId);
    expect(answer.body).toMatchObject({ intakeStatus: 409, code: 'LATE_REQUESTER_CHANGE', requestId });
    expect(bridge.downloadFile).not.toHaveBeenCalled();
    const [stored] = await lateReceipt(reply.update_id);
    expect(stored.payload.text).toContain(words);
    expect(stored.payload.text).toContain('also sent a photo');
    expect(answer.body.officeAlert.text).toContain('also sent a photo');
  });

  // Until ADR-144 this reply was refused as a stale reply and its words were dropped ("Please reply to
  // the current revision notice"). A reply to any message about a request now binds to that request;
  // while it is designing, the words are kept on it for the office, and nothing new starts.
  it('a reply to a request that is designing again is kept on it as a pending change (ADR-144)', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId } = await seedRequestAt(app, chat, 'designing', 4, { key: '3:office-revision-notify', messageId: '813' });
    const reply = brief(updateId(), chat);
    reply.message.text = words;
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 813 };
    const answer = await intake(app, reply, 'lifecycle', requestId);
    expect(answer.body).toMatchObject({ intakeStatus: 409, code: 'LATE_REQUESTER_CHANGE', lifecycleAction: 'late-change',
      requestId, requestStage: 'designing', chatAnswer: { text: expect.stringContaining("I've added that to") } });
    expect(answer.body.officeAlert.text).toContain(words);
    expect(await tasksInChat(chat)).toHaveLength(1);
    expect(await lateReceipt(reply.update_id)).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ requestStage: 'designing', text: words, kind: 'change' }) })]);
  });

  it('without an office chat the words are still kept, and no alert is claimed', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', '');
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId } = await seedRequestAt(app, chat, 'approved', 3, { key: '2:design-outcome', messageId: '814' });
    const reply = brief(updateId(), chat);
    reply.message.text = words;
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 814 };
    const answer = await intake(app, reply, 'lifecycle', requestId);
    expect(answer.body).toMatchObject({ intakeStatus: 409, code: 'LATE_REQUESTER_CHANGE', requestId });
    expect(answer.body.officeAlert).toBeUndefined();
    expect(await lateReceipt(reply.update_id)).toHaveLength(1);
  });
});

describe('POST /v1/internal/telegram/intake', () => {
  it('prepares a first brief without a Core task and replays its open', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const update = brief(updateId(), chat);
    const app = createApp({ db } as any);
    const first = await intake(app, update);
    expect(first.body).toMatchObject({ kind: 'handled', intakeStatus: 200,
      lifecycleAction: 'open-request', duplicate: false, chatId: String(chat),
      draft: { platform: 'telegram', rawText: update.message.text,
        sourceChannelId: String(chat), autoGenerate: true, clientId } });
    expect(first.body.draft.sourceEventId).toBe(`lc-${first.body.requestId}-r0`);
    expect(await tasksInChat(chat)).toHaveLength(0);
    const again = await intake(createApp({ db } as any), update);
    expect(again.body).toMatchObject({ duplicate: true, lifecycleAction: 'open-request',
      requestId: first.body.requestId, draft: first.body.draft });
    const altered = structuredClone(update);
    altered.message.text = 'KAAE members evening\n---\nDecember 5, 2026\nErbil';
    expect((await intake(app, altered)).body).toMatchObject({
      intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    const projected = await app.request(`/v1/internal/lifecycle/${first.body.requestId}/project`, {
      method: 'POST', headers: worker,
      body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1,
        key: `${first.body.requestId}:1:open`,
        ops: [{ kind: 'createRequest', draft: first.body.draft }] }),
    });
    expect(projected.status).toBe(200);
    const task = (await tasksInChat(chat))[0];
    expect(task).toBeDefined();
    const ownership = await withRlsContext(db, scope, async (trx) =>
      (await sql<{ owner: string; delivery_executor_pin: string }>`SELECT r.owner, t.delivery_executor_pin
        FROM hawa.requests r JOIN hawa.tasks t ON t.id = r.current_task_id
        WHERE r.request_id = ${first.body.requestId}::uuid`.execute(trx)).rows[0]);
    expect(ownership).toEqual({ owner: 'restate', delivery_executor_pin: 'restate' });
  });

  it('drafts nothing automatically when AUTO_GENERATE_CHAT_DESIGNS is not true: the brief is saved for the art director (ADR-159)', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    for (const setting of ['false', '']) {
      vi.stubEnv('AUTO_GENERATE_CHAT_DESIGNS', setting);
      const chat = chatId();
      const opened = await intake(createApp({ db } as any), brief(updateId(), chat));
      expect(opened.body, `AUTO_GENERATE_CHAT_DESIGNS=${setting}`).toMatchObject({ intakeStatus: 200,
        lifecycleAction: 'open-request', draft: { autoGenerate: false } });
      const projected = await createApp({ db } as any).request(`/v1/internal/lifecycle/${opened.body.requestId}/project`, {
        method: 'POST', headers: worker,
        body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${opened.body.requestId}:1:open`,
          ops: [{ kind: 'createRequest', draft: opened.body.draft }] }),
      });
      expect(await projected.json()).toMatchObject({ stage: 'manual', autoGenerate: false });
    }
  });

  it('opens an explicit second brief while another lifecycle request awaits a revision', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const waiting = await seedWaitingRequest(app, chat);
    const update = brief(updateId(), chat);
    update.message.text = '/new KAAE second event\n---\nDecember 9, 2026\nErbil';
    const result = await intake(app, update, 'lifecycle', waiting.requestId);
    expect(result.body).toMatchObject({ lifecycleAction: 'open-request', intakeStatus: 200,
      draft: { rawText: 'KAAE second event\n---\nDecember 9, 2026\nErbil' } });
    expect(result.body.requestId).not.toBe(waiting.requestId);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  // Until ADR-144 a brief sent as a reply to a message no request knows (a colleague's, an old
  // draft's) was refused as a stale reply and dropped. It is now read like any message: a brief opens
  // one request, once, and a change with nothing to change is answered, never opened.
  it('reads a reply to a message no request knows like a plain message, and replays its decision', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const update = brief(updateId(), chat);
    (update.message as any).reply_to_message = { message_id: 123456 };
    const result = await intake(createApp({ db } as any), update);
    expect(result.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', duplicate: false });
    expect(await tasksInChat(chat)).toHaveLength(0);
    const replay = await intake(createApp({ db } as any), update);
    expect(replay.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', duplicate: true,
      requestId: result.body.requestId });
    const altered = structuredClone(update);
    altered.message.text = 'An unrelated brief';
    expect((await intake(createApp({ db } as any), altered)).body).toMatchObject({
      intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    const other = chatId();
    const change = brief(updateId(), other);
    change.message.text = 'Make the logo bigger';
    (change.message as any).reply_to_message = { message_id: 123457, from: { id: 7000001, is_bot: true, first_name: 'Hawa' } };
    const answered = await intake(createApp({ db } as any), change);
    // A change in reply to a bot message no request knows, in a chat with nothing open: the words go
    // to the office, and nothing opens.
    expect(answered.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer',
      chatAnswer: { text: expect.stringContaining("I've passed your message to the office") } });
    expect(await tasksInChat(other)).toHaveLength(0);
  });

  it('admits a styling-only message as manual and does not promote a greeting to a lifecycle request', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const manual = brief(updateId(), chat);
    manual.message.text = 'Please change the background to navy';
    const planned = await intake(app, manual);
    expect(planned.body).toMatchObject({ lifecycleAction: 'open-request',
      draft: { autoGenerate: false, isInstructionOnly: true, exactCopy: [] } });
    expect(await tasksInChat(chat)).toHaveLength(0);
    const greeting = brief(updateId(), chat);
    greeting.message.text = 'hello';
    const answered = await intake(app, greeting);
    expect(answered.body.lifecycleAction).not.toBe('open-request');
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  // Chaos R10.H1 (2026-09-29): the requester's thanks after a delivery opened a manual request in
  // the Desk and was answered "Request received. An art director will review it." (ADR-140).
  it.each([
    ['in a new chat', 'Thank you, we received the files.', null],
    ['after a delivery', 'Thank you, we received the files.', 'delivered'],
    ['in Kurdish, after a delivery', 'زۆر سوپاس، فایلەکان گەیشتن', 'delivered'],
  ] as const)('a thanks %s with no waiting request opens no lifecycle request', async (_when, text, stage) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const bridge = { downloadFile: vi.fn(), dispatchOutboundMessage: vi.fn(async (..._args: unknown[]) => ({ success: true })) };
    const chat = chatId();
    const app = createApp({ db, telegramBridge: bridge } as any);
    if (stage) await seedRequestAt(app, chat, stage, 7, { key: '6:delivered', messageId: '820' });
    const requestsInChat = async () => (await withRlsContext(db, scope, (trx) => sql<{ n: number }>`
      SELECT count(*)::int AS n FROM hawa.requests WHERE tenant_id = ${tenantId}::uuid
        AND chat_id = ${String(chat)}`.execute(trx))).rows[0].n;
    const before = { tasks: (await tasksInChat(chat)).length, requests: await requestsInChat() };
    const thanks = brief(updateId(), chat);
    thanks.message.text = text;
    const answered = await intake(app, thanks);
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ kind: 'handled', intakeStatus: 200, lifecycleAction: 'chat-answer', chatId: String(chat) });
    expect(answered.body.requestId).toBeUndefined();
    expect({ tasks: (await tasksInChat(chat)).length, requests: await requestsInChat() }).toEqual(before);
    // The answer is ChatInbox's to send (stage 2 of ADR-135); Core sends nothing itself.
    expect(bridge.dispatchOutboundMessage).not.toHaveBeenCalled();
    const reply = String(answered.body.chatAnswer?.text);
    expect(reply).not.toMatch(/Request received|Brief received|art director|send your event brief/i);
    expect(reply).toMatch(/Thank you|سوپاس/);
  });

  it.each(['photo', 'document'] as const)('admits a captioned %s through its owned task without image bytes in Restate', async (carrier) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    (update.message as any).caption = 'KAAE members evening\n---\nDecember 4, 2026\nErbil';
    (update.message as any).photo = [{ file_id: 'photo-fixture', file_size: 128 }];
    if (carrier === 'document') asImageDocument(update);
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const bridge = { downloadFile: vi.fn(async () => photo),
      dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
    const app = createApp({ db, telegramBridge: bridge } as any);
    const result = await intake(app, update);
    expect(result.body).toMatchObject({ intakeStatus: 200,
      lifecycleAction: 'open-request', draft: { lifecycleImage: {
        updateId: update.update_id, mediaType: 'image/png', size: photo.length } } });
    expect(result.body.draft.autoGenerate).toBe(true);
    expect(result.body.draft.lifecycleImage.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result.body.draft)).not.toContain(photo.toString('base64'));
    const pendingRefs = await sql<{ sha256: string }>`SELECT h AS sha256
      FROM hawa.blob_reference_hashes() AS h WHERE h = ${result.body.draft.lifecycleImage.sha256}`.execute(db);
    expect(pendingRefs.rows).toHaveLength(1);
    expect(await tasksInChat(chat)).toHaveLength(0);
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    expect(bridge.downloadFile).toHaveBeenCalledWith('photo-fixture');
    expect(result.body.draft.rawJson).toBeUndefined();
    const storedSource = await withRlsContext(db, scope, (trx) => trx.selectFrom('inbox_events')
      .select('payload').where('source_account_id', '=', 'lifecycle_chat_open')
      .where('source_event_id', '=', String(update.update_id)).executeTakeFirstOrThrow());
    expect(storedSource.payload).toMatchObject({ sourceUpdate: update });
    expect((await intake(createApp({ db } as any), update)).body).toMatchObject({
      intakeStatus: 200, duplicate: true, lifecycleAction: 'open-request',
      requestId: result.body.requestId, draft: result.body.draft });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    const altered = structuredClone(update);
    (altered.message as any).caption = 'KAAE members evening\n---\nDecember 5, 2026\nErbil';
    expect((await intake(createApp({ db } as any), altered)).body).toMatchObject({
      intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(await tasksInChat(chat)).toHaveLength(0);
    const forged = structuredClone(result.body.draft);
    forged.lifecycleImage.sha256 = '0'.repeat(64);
    const forgedProjection = await app.request(`/v1/internal/lifecycle/${result.body.requestId}/project`, {
      method: 'POST', headers: worker, body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1,
        key: `${result.body.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: forged }] }),
    });
    expect(forgedProjection.status).toBe(409);
    expect(await tasksInChat(chat)).toHaveLength(0);
    const projected = await app.request(`/v1/internal/lifecycle/${result.body.requestId}/project`, {
      method: 'POST', headers: worker, body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1,
        key: `${result.body.requestId}:1:open`,
        ops: [{ kind: 'createRequest', draft: result.body.draft }] }),
    });
    expect(projected.status).toBe(200);
    const projectedBody = await projected.json();
    expect(projectedBody.stage).toBe('designing');
    const taskId = projectedBody.taskId;
    const taskSource = await withRlsContext(db, scope, (trx) => trx.selectFrom('inbox_events')
      .select('payload').where('source_account_id', '=', 'telegram')
      .where('source_event_id', '=', `${chat}:${result.body.draft.sourceEventId}`).executeTakeFirstOrThrow());
    expect(taskSource.payload).toEqual(update);
    const rows = await withRlsContext(db, scope, (trx) => sql<{ sha256: string }>`SELECT sha256
      FROM hawa.task_files WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid
        AND role = 'reference_image'`.execute(trx));
    expect(rows.rows).toEqual([{ sha256: result.body.draft.lifecycleImage.sha256 }]);
    const studio = new DesignStudioService(db, undefined, { apiKey: 'test-key',
      fetcher: (async () => { throw new Error('no model calls'); }) as any });
    expect(await (studio as any).requestImages({ tenantId, actorId: operatorUserId }, taskId))
      .toEqual([`data:image/png;base64,${photo.toString('base64')}`]);
    const unreadable = vi.spyOn((studio as any).blobs, 'read').mockRejectedValue(new Error('disk missing'));
    await expect((studio as any).imagesForRun({ tenantId, actorId: operatorUserId },
      { task_id: taskId, request: {} })).rejects.toThrow('request-owned image is missing or corrupt');
    unreadable.mockRestore();
    const replayProjection = await app.request(`/v1/internal/lifecycle/${result.body.requestId}/project`, {
      method: 'POST', headers: worker, body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1,
        key: `${result.body.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: result.body.draft }] }),
    });
    expect(await replayProjection.json()).toMatchObject({ taskId, stage: 'designing' });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  // ADR-145 changed this deliberately (it was "requests an explicit client … and holds unlinked photos"):
  // a voice note or PDF whose organisation nothing names is asked about in words, never with a "Client:"
  // format, and a photo with no words is kept for its sender's words instead of being parked.
  it('asks which organisation a voice note or PDF is for, and keeps an unlinked photo for its words', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const bridge = { downloadFile: vi.fn(async () => png), dispatchOutboundMessage: vi.fn() };
    const app = createApp({ db, telegramBridge: bridge } as any);
    for (const media of [
      { voice: { file_id: 'voice-fixture', duration: 5 }, caption: 'The exact spoken brief' },
      { document: { file_id: 'pdf-fixture', mime_type: 'application/pdf', file_name: 'brand.pdf' }, caption: 'Use these guidelines' },
      { photo: [{ file_id: 'captionless-fixture' }] },
    ]) {
      const chat = chatId();
      const update = brief(updateId(), chat);
      delete (update.message as any).text;
      Object.assign(update.message, media);
      const result = await intake(app, update, 'lifecycle');
      if ('photo' in media) {
        expect(result.body).toMatchObject({ intakeStatus: 202, lifecycleAction: 'settle-later', settle: { kind: 'photo' } });
      } else {
        expect(result.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'source-message',
          sourceMessage: `Thanks for the ${'voice' in media ? 'voice note' : 'PDF'}! Which organisation is it for?` });
        expect(result.body.sourceMessage).not.toMatch(/Client:|\/new|reply to/i);
      }
      expect(await tasksInChat(chat)).toHaveLength(0);
    }
    // Only the photo was downloaded: a question comes before any download.
    expect(bridge.downloadFile.mock.calls).toEqual([['captionless-fixture']]);
  });

  it.each([undefined, 'application/octet-stream', 'image/jpeg'])(
    'verifies original image-file bytes with MIME hint %s and ignores the filename', async (mime) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const update = brief(updateId(), chat);
    const message = update.message as Record<string, unknown>;
    message.caption = message.text;
    delete message.text;
    message.document = { file_id: 'original-image', file_name: '../../wrong.pdf',
      ...(mime ? { mime_type: mime } : {}), thumbnail: { file_id: 'wrong-thumbnail' } };
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const bridge = { downloadFile: vi.fn(async () => bytes), dispatchOutboundMessage: vi.fn() };
    const result = await intake(createApp({ db, telegramBridge: bridge } as any), update);
    expect(result.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request',
      draft: { lifecycleImage: { mediaType: 'image/png', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') } } });
    expect(bridge.downloadFile.mock.calls).toEqual([['original-image']]);
  });

  it.each(['pdf', 'oversized-metadata', 'invalid-size', 'animation', 'live-photo', 'mixed', 'spoofed-bytes', 'oversized-bytes'] as const)(
    'holds an image-file submission with %s intact and never designs from its caption', async (fault) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const update = brief(updateId(), chat);
    const message = update.message as Record<string, unknown>;
    message.caption = message.text;
    delete message.text;
    const document: Record<string, unknown> = { file_id: 'image-looking-file', file_name: 'photo.png', mime_type: 'image/png' };
    message.document = document;
    if (fault === 'pdf') document.mime_type = 'application/pdf';
    if (fault === 'oversized-metadata') document.file_size = 20 * 1024 * 1024 + 1;
    if (fault === 'invalid-size') document.file_size = '20';
    if (fault === 'animation') message.animation = { file_id: 'animated' };
    if (fault === 'live-photo') message.live_photo = { file_id: 'movie' };
    if (fault === 'mixed') message.photo = [{ file_id: 'other-image' }];
    const bytes = fault === 'oversized-bytes' ? Buffer.alloc(20 * 1024 * 1024 + 1) : Buffer.from('%PDF-1.7\nnot an image');
    const bridge = { downloadFile: vi.fn(async () => bytes), dispatchOutboundMessage: vi.fn() };
    // ADR-145: nothing is parked for an operator any more. A PDF is kept as a source (its words are shown
    // back before anything is designed); a picture that cannot be used is asked for again, in words.
    // Either way the caption never designs on its own (ADR-069).
    // (The PDF's words wait here for the PDF reader, which this test does not configure.)
    const expected = fault === 'pdf' ? { intakeStatus: 503, code: 'NOT_CONFIGURED' }
      : { intakeStatus: 200, lifecycleAction: 'chat-answer',
        chatAnswer: { text: "I couldn't open that picture. Could you send it again as a photo?" } };
    expect((await intake(createApp({ db, telegramBridge: bridge } as any), update)).body).toMatchObject(expected);
    expect(bridge.downloadFile).toHaveBeenCalledTimes(fault.endsWith('bytes') || fault === 'pdf' ? 1 : 0);
    expect(await tasksInChat(chat)).toHaveLength(0);
    expect((await intake(createApp({ db } as any), update)).body).toMatchObject(expected);
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  it('replays a pre-admission image-file hold after upgrading instead of starting a task', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const update = brief(updateId(), chat);
    const message = update.message as Record<string, unknown>;
    message.caption = message.text;
    delete message.text;
    message.document = { file_id: 'previously-held', mime_type: 'image/png' };
    const digest = createHash('sha256').update(JSON.stringify(update)).digest('hex');
    await withRlsContext(db, scope, (trx) => sql`INSERT INTO hawa.inbox_events
      (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
      VALUES (${tenantId}::uuid, 'lifecycle_chat_routing', ${String(update.update_id)}, 'lifecycle_media_not_admitted',
        ${JSON.stringify({ code: 'LIFECYCLE_MEDIA_NOT_ADMITTED', chatId: String(chat) })}::jsonb, ${digest}, true)`.execute(trx));
    const bridge = { downloadFile: vi.fn(), dispatchOutboundMessage: vi.fn() };
    const app = createApp({ db, telegramBridge: bridge } as any);
    expect((await intake(app, update)).body).toMatchObject({ intakeStatus: 422, lifecycleAction: 'park-update' });
    expect((await intake(app, update)).body).toMatchObject({ intakeStatus: 422, lifecycleAction: 'park-update' });
    expect(bridge.downloadFile).not.toHaveBeenCalled();
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  it('waits without downloading when durable photo storage is unavailable', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('HAWA_BLOB_DIR', '');
    const chat = chatId();
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    (update.message as any).caption = 'KAAE new design\n---\nDecember 4, 2026';
    (update.message as any).photo = [{ file_id: 'photo-unavailable' }];
    const bridge = { downloadFile: vi.fn(async () => Buffer.from('no bytes')) };
    const result = await intake(createApp({ db, telegramBridge: bridge } as any), update);
    expect(result.body).toMatchObject({ intakeStatus: 503, code: 'NOT_CONFIGURED' });
    expect(bridge.downloadFile).not.toHaveBeenCalled();
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  // ADR-145: asked for again in words rather than parked for an operator; still never designed from the caption alone.
  it('asks again for an unreadable photo rather than designing from its caption alone', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    (update.message as any).caption = 'KAAE new design\n---\nDecember 4, 2026';
    (update.message as any).photo = [{ file_id: 'photo-invalid' }];
    const bridge = { downloadFile: vi.fn(async () => Buffer.from('not an image')) };
    const result = await intake(createApp({ db, telegramBridge: bridge } as any), update);
    expect(result.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer',
      chatAnswer: { text: "I couldn't open that picture. Could you send it again as a photo?" } });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  // ADR-145: a channel's own photo is ignored (nothing is said in a channel); an edited caption of a
  // message the bot has no record of goes to the office. Neither designs, and neither is parked.
  it('ignores media in channel posts and passes an edit it cannot place to the office, without designing', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    for (const kind of ['channel_post', 'edited_message'] as const) {
      const chat = chatId();
      const update = brief(updateId(), chat) as any;
      update[kind] = { ...update.message, photo: [{ file_id: `${kind}-fixture` }],
        caption: 'New design with this image' };
      delete update[kind].text;
      delete update.message;
      const result = await intake(createApp({ db } as any), update);
      expect(result.body).toMatchObject(kind === 'channel_post' ? { intakeStatus: 200, ignored: true }
        : { intakeStatus: 200, lifecycleAction: 'chat-answer',
          chatAnswer: { text: "I saw your edit and passed it to the office; they'll follow up here." } });
      expect(await tasksInChat(chat)).toHaveLength(0);
    }
  });

  // Before ADR-135 an ordinary brief in a chat with earlier Core tasks became another Core task; until
  // its stage 2 such a brief beside an open old-intake request went to that intake.
  it('an update the old intake saved replays its receipt; beside that open request a brief opens a lifecycle request', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    // A request the old intake made before the switch, keyed as it keyed one (<chat>:<update>).
    const oldUpdate = brief(updateId(), chat);
    const old = await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: String(oldUpdate.update_id), sourceChannelId: String(chat),
      rawText: oldUpdate.message.text, rawJson: oldUpdate, title: 'KAAE members evening', clientId,
      designInstructions: 'Event announcement', exactCopy: [{ text: 'December 4, 2026' }], autoGenerate: false,
    });
    const oldTask = String(old.task.id);
    const replay = await intake(createApp({ db } as any), oldUpdate);
    expect(replay.body).toMatchObject({ duplicate: true, taskIds: [oldTask] });
    expect(replay.body.lifecycleAction).toBeUndefined();
    expect(await tasksInChat(chat)).toHaveLength(1);
    const ordinary = brief(updateId(), chat);
    ordinary.message.text = 'KAAE follow-up event\n---\nDecember 9, 2026';
    expect((await intake(app, ordinary)).body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', chatId: String(chat) });
    expect(await tasksInChat(chat)).toHaveLength(1);
    const pins = await withRlsContext(db, scope, async (trx) =>
      (await sql<{ delivery_executor_pin: string }>`SELECT t.delivery_executor_pin
        FROM hawa.tasks t WHERE t.id = ${oldTask}::uuid`.execute(trx)).rows);
    expect(pins).toEqual([{ delivery_executor_pin: 'core' }]);
  });

  // Before ADR-135 this was "today's intake": the brief became a Core task at once.
  it('a brief in a new chat opens one lifecycle request, and the same update again replays it, never a second', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const update = brief(updateId(), chat);
    const app = createApp({ db } as any);

    const first = await intake(app, update);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ v: 1, kind: 'handled', intakeStatus: 200, duplicate: false, lifecycleAction: 'open-request' });

    // Delivered again: by Restate after a worker restart.
    const again = await intake(createApp({ db } as any), update);
    expect(again.body).toMatchObject({ kind: 'handled', intakeStatus: 200, duplicate: true,
      lifecycleAction: 'open-request', requestId: first.body.requestId });
    // The request object creates the task; intake made none.
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  it('answers INTAKE_PAUSED while the office has switched Telegram off, and starts nothing', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    expect((await app.request('/v1/operations/kill-switch', { method: 'POST', headers: { ...operator, Authorization: 'Bearer test_admin_key' }, body: JSON.stringify({ channel: 'telegram', active: true }) })).status).toBe(200);
    const paused = await intake(app, brief(updateId(), chat));
    expect(paused.body).toMatchObject({ kind: 'handled', intakeStatus: 503, code: 'INTAKE_PAUSED' });
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  it('answers both modes alike: a brief opens a request, a greeting starts nothing', async () => {
    // ChatInbox sends `legacy` for a chat's first update and `lifecycle` after that (ADR-135).
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const app = createApp({ db } as any);
    for (const mode of ['legacy', 'lifecycle']) {
      const chat = chatId();
      const result = await intake(app, brief(updateId(), chat), mode);
      expect(result.status).toBe(200);
      expect(result.body, mode).toMatchObject({ kind: 'handled', intakeStatus: 200, lifecycleAction: 'open-request' });
      const greeting = brief(updateId(), chat);
      greeting.message.text = 'hello';
      const greeted = (await intake(app, greeting, mode)).body;
      expect(greeted, mode).toMatchObject({ lifecycleAction: 'chat-answer', chatAnswer: { text: expect.stringMatching(/^👋 Hi!/) } }); // ADR-145 (#62)
      expect(greeted.requestId, mode).toBeUndefined();
      expect(await tasksInChat(chat)).toHaveLength(0);
    }
    // A mode we have never heard of is still refused.
    expect((await app.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker,
      body: JSON.stringify({ v: 1, update: brief(updateId(), chatId()), mode: 'decide' }) })).status).toBe(400);
    expect((await intake(app, { message: {} })).status).toBe(400);
  });

  it('routes a requester revision directive to the open lifecycle request (Q/A loop)', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId, taskId: priorTaskId } = await seedWaitingRequest(app, chat);

    // 2) Send the requester's directive update in lifecycle mode.
    const directiveUpdate = {
      update_id: updateId(),
      message: { message_id: 9999, from: { id: OFFICE, is_bot: false, first_name: 'Owner' },
        chat: { id: chat, type: 'private' }, date: 1790000001, text: 'Please make the background blue' },
    };
    const result = await intake(app, directiveUpdate, 'lifecycle', requestId);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      kind: 'handled', intakeStatus: 200,
      lifecycleAction: 'requester-revision',
      requestId, round: 1, priorTaskId,
    });
    expect(result.body.newTaskId).toBeDefined();
    expect(result.body.directive).toBe('Please make the background blue');
    const child = (await tasksInChat(chat)).find((task: any) =>
      task.aggregate_id === result.body.newTaskId);
    expect(child?.payload).toMatchObject({
      autoGenerate: true, designStudio: true, exactCopy: [{ text: 'December 4, 2026' }],
      variant: { width: 1200, height: 1697 },
      studioOptions: { tier: 'quality', parentTaskId: priorTaskId, revisionRound: 1,
        revisionDirective: 'Please make the background blue' },
    });
    expect((child?.payload as any).designInstructions).toContain('Make the approved event design');
  });

  it.each([['captioned', 'photo'], ['captionless', 'photo'], ['captioned', 'document'], ['captionless', 'document']] as const)(
    'binds a %s reply %s to only its selected revision task and replays after flag rollback', async (kind, carrier) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const app = createApp({ db } as any);
    const first = await seedWaitingRequest(app, chat);
    const second = await seedWaitingRequest(app, chat);
    await withRlsContext(db, scope, (trx) => sql`
      INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id,
        event_kind, payload, payload_hash, verified)
      VALUES (${tenantId}::uuid, 'telegram_delivery',
        ${`lc:${second.requestId}:3:office-revision-notify:send`},
        'telegram_message_sent', ${JSON.stringify({ messageId: '843' })}::jsonb,
        'test-sent-mark', true)`.execute(trx));
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    if (kind === 'captioned') (update.message as any).caption = 'Please use this photo and a blue background';
    (update.message as any).photo = [{ file_id: 'revision-photo', file_size: 128 }];
    if (carrier === 'document') asImageDocument(update);
    (update.message as any).reply_to_message = { message_id: 843 };
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const bridge = { downloadFile: vi.fn(async () => photo),
      dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
    const photoApp = createApp({ db, telegramBridge: bridge } as any);
    const result = await intake(photoApp, update, 'lifecycle');
    expect(result.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision',
      requestId: second.requestId, priorTaskId: second.taskId, duplicate: false });
    if (kind === 'captionless') {
      expect(result.body.directive).toContain('no written instructions');
      const child = (await tasksInChat(chat)).find((task) => task.aggregate_id === result.body.newTaskId);
      expect(child?.payload).toMatchObject({ exactCopy: [{ text: 'December 4, 2026' }] });
    }
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    expect(bridge.downloadFile).toHaveBeenCalledWith('revision-photo');
    expect((await tasksInChat(chat))).toHaveLength(3);
    const decision = await withRlsContext(db, scope, (trx) => sql<{ payload: any }>`SELECT payload
      FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid
        AND source_account_id = 'lifecycle_chat_revision_photo'
        AND source_event_id = ${String(update.update_id)}`.execute(trx));
    expect(decision.rows[0].payload).toMatchObject({ requestId: second.requestId,
      chatId: String(chat), image: { mediaType: 'image/png', size: photo.length } });
    const hash = decision.rows[0].payload.image.sha256;
    const bound = await withRlsContext(db, scope, (trx) => sql<{ task_id: string; sha256: string }>`SELECT task_id::text, sha256
      FROM hawa.task_files WHERE tenant_id = ${tenantId}::uuid AND sha256 = ${hash}
        AND task_id IN (${first.taskId}::uuid, ${second.taskId}::uuid,
          ${result.body.newTaskId}::uuid)`.execute(trx));
    expect(bound.rows).toEqual([{ task_id: result.body.newTaskId, sha256: hash }]);
    const studio = new DesignStudioService(db, undefined, { apiKey: 'test-key',
      fetcher: (async () => { throw new Error('no model calls'); }) as any });
    expect(await (studio as any).requestImages({ tenantId, actorId: operatorUserId }, result.body.newTaskId))
      .toContain(`data:image/png;base64,${photo.toString('base64')}`);
    const replay = await intake(createApp({ db } as any), update);
    expect(replay.body).toMatchObject({ intakeStatus: 200, duplicate: true,
      lifecycleAction: 'requester-revision', requestId: second.requestId,
      newTaskId: result.body.newTaskId });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    const changed = structuredClone(update);
    (changed.message as any).caption = 'Different image instruction';
    expect((await intake(photoApp, changed)).body).toMatchObject({
      intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect((await tasksInChat(chat))).toHaveLength(3);
    expect(first.taskId).not.toBe(result.body.newTaskId);
  });

  // ADR-145: an unlinked captionless photo is kept for its sender's words (downloaded once, settled
  // later), never parked. ADR-156 (audit #12) changed the replies deliberately: a captionless photo
  // replying to a message no current design knows, or to an older notice of the design, is still not
  // applied to any design, but it is kept for the words that will say what to do with it, instead of
  // an untrue "that design is now with the office".
  it.each(['unlinked', 'unknown-reply', 'stale-reply'] as const)(
    'never designs from a captionless %s photo, and keeps an unlinked one for its words', async (kind) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId } = await seedWaitingRequest(app, chat);
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    (update.message as any).photo = [{ file_id: 'unowned-captionless-photo' }];
    if (kind !== 'unlinked') (update.message as any).reply_to_message = { message_id: 928 };
    if (kind === 'stale-reply') {
      await withRlsContext(db, scope, async (trx) => {
        await sql`INSERT INTO hawa.inbox_events
          (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
          VALUES (${tenantId}::uuid, 'telegram_delivery', ${`lc:${requestId}:3:office-revision-notify:send`},
            'telegram_message_sent', '{"messageId":"928"}'::jsonb, 'test-sent-mark', true)`.execute(trx);
        await trx.updateTable('requests').set({ rev: 5 }).where('request_id', '=', requestId).execute();
      });
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const bridge = { downloadFile: vi.fn(async () => png), dispatchOutboundMessage: vi.fn() };
    const result = await intake(createApp({ db, telegramBridge: bridge } as any), update);
    const expected = kind === 'unlinked'
      ? { intakeStatus: 202, lifecycleAction: 'settle-later', settle: { kind: 'photo' } }
      : { intakeStatus: 200, lifecycleAction: 'chat-answer', media: 'photo-held' };
    expect(result.body).toMatchObject(expected);
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    expect(await tasksInChat(chat)).toHaveLength(1);
    expect((await intake(createApp({ db } as any), update)).body).toMatchObject(expected);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it.each(['photo', 'document'] as const)('checks the exact captionless %s reply again at the task projection boundary', async (carrier) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const app = createApp({ db } as any);
    const first = await seedWaitingRequest(app, chat);
    const second = await seedWaitingRequest(app, chat);
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    (update.message as any).photo = [{ file_id: 'wrong-request-photo' }];
    if (carrier === 'document') asImageDocument(update);
    (update.message as any).reply_to_message = { message_id: 936 };
    await withRlsContext(db, scope, (trx) => sql`INSERT INTO hawa.inbox_events
      (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
      VALUES (${tenantId}::uuid, 'telegram_delivery', ${`lc:${second.requestId}:3:office-revision-notify:send`},
        'telegram_message_sent', '{"messageId":"936"}'::jsonb, 'test-sent-mark', true)`.execute(trx));
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const image = await blobStoreFor(db)!.put(photo, 'image/png');
    const payloadHash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
    await withRlsContext(db, scope, (trx) => recordRevisionPhotoDecision(trx,
      tenantId, update.update_id, { requestId: first.requestId, chatId: String(chat), payloadHash, image }));
    const directive = lifecyclePhotoInput(update)!.directive;
    const projection = {
      requestId: first.requestId, tenantId, priorTaskId: first.taskId, round: 1, directive,
      sourceEventId: `lc-${first.requestId}-r1-u${update.update_id}`, sourceChannelId: String(chat),
      rawText: directive, sourceUpdateHash: payloadHash, sourceUpdate: update,
      lifecycleImage: image, clientId, expectedRev: 3, rev: 4,
      key: `${first.requestId}:4:requesterRevisionIntake:u${update.update_id}`,
    };
    await expect(projectLifecycleRequesterRevisionWithIntake(db, { ...projection, lifecycleImage: undefined }))
      .rejects.toMatchObject({ code: 'UNVERIFIED_DESIGN' });
    await expect(projectLifecycleRequesterRevisionWithIntake(db, projection))
      .rejects.toMatchObject({ code: 'NOT_CURRENT_DRAFT' });
    expect(await tasksInChat(chat)).toHaveLength(2);
    const request = await withRlsContext(db, scope, (trx) => trx.selectFrom('requests')
      .select(['rev', 'current_task_id']).where('request_id', '=', first.requestId).executeTakeFirstOrThrow());
    expect(request).toMatchObject({ rev: '3', current_task_id: first.taskId });
  });

  // ADR-156 (audit #11) changed this deliberately: a captioned photo is read as text is, so with two
  // designs waiting it asks which one, in words (as a text message does), and keeps the photo (one
  // download) for the answer. It still starts nothing and never guesses.
  it('requires a unique request before a revision photo starts anything', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const app = createApp({ db } as any);
    await seedWaitingRequest(app, chat);
    await seedWaitingRequest(app, chat);
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    (update.message as any).caption = 'Use this image for the revision';
    (update.message as any).photo = [{ file_id: 'ambiguous-photo' }];
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const bridge = { downloadFile: vi.fn(async () => png),
      dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
    const result = await intake(createApp({ db, telegramBridge: bridge } as any), update, 'lifecycle');
    expect(result.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', choiceRequired: true,
      chatAnswer: { text: expect.stringContaining('Which design is this for?') } });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    expect(await tasksInChat(chat)).toHaveLength(2);
    expect((await intake(createApp({ db } as any), update)).body).toMatchObject({
      intakeStatus: 200, duplicate: true, choiceRequired: true });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
  });

  it('retains a revision photo decision when the task cannot yet be projected', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId, taskId } = await seedWaitingRequest(app, chat);
    await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.outbox_commands
      SET payload = payload - 'exactCopy'
      WHERE tenant_id = ${tenantId}::uuid AND aggregate_id = ${taskId}::uuid
        AND command_type = 'task.created'`.execute(trx));
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    (update.message as any).caption = 'Use this photo in the revision';
    (update.message as any).photo = [{ file_id: 'pending-revision-photo' }];
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const bridge = { downloadFile: vi.fn(async () => photo),
      dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
    const photoApp = createApp({ db, telegramBridge: bridge } as any);
    const first = await intake(photoApp, update, 'lifecycle');
    expect(first.body).toMatchObject({ intakeStatus: 409, code: 'PARENT_BRIEF_MISSING' });
    const decision = await withRlsContext(db, scope, (trx) => sql<{ sha256: string }>`SELECT payload->'image'->>'sha256' AS sha256
      FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid
        AND source_account_id = 'lifecycle_chat_revision_photo'
        AND source_event_id = ${String(update.update_id)}`.execute(trx));
    const hash = decision.rows[0]?.sha256;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const refs = await sql<{ h: string }>`SELECT h FROM hawa.blob_reference_hashes() AS h
      WHERE h = ${hash}`.execute(db);
    expect(refs.rows).toHaveLength(1);
    expect((await intake(createApp({ db } as any), update)).body).toMatchObject({
      intakeStatus: 409, code: 'PARENT_BRIEF_MISSING' });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    expect(await tasksInChat(chat)).toHaveLength(1);
    expect(requestId).toBeTruthy();
  });

  it.each(['captioned', 'captionless'] as const)('projects a saved %s photo decision after Core restarts without asking Telegram for the file again', async (kind) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const { requestId } = await seedWaitingRequest(createApp({ db } as any), chat);
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    if (kind === 'captioned') (update.message as any).caption = 'Use this reference for the revision';
    (update.message as any).photo = [{ file_id: 'already-saved-photo' }];
    if (kind === 'captionless') {
      (update.message as any).reply_to_message = { message_id: 917 };
      await withRlsContext(db, scope, (trx) => sql`INSERT INTO hawa.inbox_events
        (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
        VALUES (${tenantId}::uuid, 'telegram_delivery', ${`lc:${requestId}:3:office-revision-notify:send`},
          'telegram_message_sent', '{"messageId":"917"}'::jsonb, 'test-sent-mark', true)`.execute(trx));
    }
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const image = await blobStoreFor(db)!.put(photo, 'image/png');
    const payloadHash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
    await withRlsContext(db, scope, (trx) => recordRevisionPhotoDecision(trx,
      tenantId, update.update_id, { requestId, chatId: String(chat), payloadHash, image }));
    // The cutover flag and Telegram bridge can both disappear before the first Core answer.
    const replayed = await intake(createApp({ db } as any), update);
    expect(replayed.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision',
      requestId, duplicate: false });
    const taskId = replayed.body.newTaskId;
    const files = await withRlsContext(db, scope, (trx) => sql<{ sha256: string }>`SELECT sha256
      FROM hawa.task_files WHERE tenant_id = ${tenantId}::uuid AND task_id = ${taskId}::uuid
        AND role = 'reference_image'`.execute(trx));
    expect(files.rows).toEqual([{ sha256: image.sha256 }]);
    expect((await intake(createApp({ db } as any), update)).body).toMatchObject({
      intakeStatus: 200, duplicate: true, newTaskId: taskId });
    expect(await tasksInChat(chat)).toHaveLength(2);
  });

  it('refuses a capped revision durably and leaves the request waiting', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId } = await seedWaitingRequest(app, chat);
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '0');
    const update = brief(updateId(), chat);
    update.message.text = 'Make the background blue';
    const first = await intake(app, update, 'lifecycle', requestId);
    expect(first.body).toMatchObject({ intakeStatus: 409, code: 'DAILY_CAP_REACHED',
      lifecycleAction: 'revision-blocked', chatId: String(chat) });
    expect(await tasksInChat(chat)).toHaveLength(1);
    vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '10000');
    const replay = await intake(createApp({ db } as any), update, 'lifecycle', requestId);
    expect(replay.body).toMatchObject({ intakeStatus: 409, code: 'DAILY_CAP_REACHED',
      lifecycleAction: 'revision-blocked' });
    const afterRollback = await intake(createApp({ db } as any), update);
    expect(afterRollback.body).toMatchObject({ intakeStatus: 409, code: 'DAILY_CAP_REACHED',
      lifecycleAction: 'revision-blocked' });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('refuses a revision when the prior source brief is missing', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId, taskId } = await seedWaitingRequest(app, chat);
    await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.outbox_commands
      SET payload = payload - 'exactCopy'
      WHERE tenant_id = ${tenantId}::uuid AND aggregate_id = ${taskId}::uuid
        AND command_type = 'task.created'`.execute(trx));
    const update = brief(updateId(), chat);
    update.message.text = 'Change the background';
    const result = await intake(app, update, 'lifecycle', requestId);
    expect(result.body).toMatchObject({ intakeStatus: 409, code: 'PARENT_BRIEF_MISSING',
      lifecycleAction: 'revision-blocked', chatId: String(chat) });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('replays the same Telegram revision update after Core advanced the request, without a legacy task', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const { requestId, taskId } = await seedWaitingRequest(app, chat);
    const update = brief(updateId(), chat);
    update.message.text = 'Move the venue to Erbil';
    const first = await intake(app, update, 'lifecycle', requestId);
    expect(first.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision',
      requestId, priorTaskId: taskId, duplicate: false });
    const adopted = await app.request(`/v1/internal/lifecycle/${requestId}/requester-revision-intake`, {
      method: 'POST', headers: worker, body: JSON.stringify({ v: 1, updateId: update.update_id,
        expectedRev: 3, priorTaskId: taskId, newTaskId: first.body.newTaskId,
        round: 1, directive: update.message.text }),
    });
    expect(adopted.status).toBe(200);
    expect(await adopted.json()).toMatchObject({ requestId, newTaskId: first.body.newTaskId,
      stage: 'designing', rev: 4, directive: update.message.text });
    const forgedAdoption = await app.request(`/v1/internal/lifecycle/${requestId}/requester-revision-intake`, {
      method: 'POST', headers: worker, body: JSON.stringify({ v: 1, updateId: update.update_id,
        expectedRev: 3, priorTaskId: taskId, newTaskId: randomUUID(),
        round: 1, directive: update.message.text }),
    });
    expect(forgedAdoption.status).toBe(409);
    const replay = await intake(createApp({ db } as any), update, 'lifecycle', requestId);
    expect(replay.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision',
      requestId, newTaskId: first.body.newTaskId, duplicate: true });
    const changed = await intake(app, { ...update, message: { ...update.message, text: 'Different direction' } },
      'lifecycle', requestId);
    expect(changed.body).toMatchObject({ intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    const changedReply = await intake(app, { ...update,
      message: { ...update.message, reply_to_message: { message_id: 734 } } },
    'lifecycle', requestId);
    expect(changedReply.body).toMatchObject({ intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(await tasksInChat(chat)).toHaveLength(2);
  });

  it('asks which design when two wait, binds a linked reply, and keeps a later reply as a pending change', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const first = await seedWaitingRequest(app, chat);
    const second = await seedWaitingRequest(app, chat);
    const unlinkedUpdate = brief(updateId(), chat);
    unlinkedUpdate.message.text = 'Use the blue background';
    // ADR-144: the words are kept and the requester is asked which design, in words; nothing starts.
    const ambiguous = await intake(app, unlinkedUpdate, 'lifecycle', first.requestId);
    expect(ambiguous.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', choiceRequired: true,
      chatId: String(chat), chatAnswer: { text: expect.stringMatching(/Which design is this for\?\n1\. .*\n2\. /) } });
    expect(await tasksInChat(chat)).toHaveLength(2);

    await withRlsContext(db, scope, (trx) => sql`
      INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id,
        event_kind, payload, payload_hash, verified)
      VALUES (${tenantId}::uuid, 'telegram_delivery',
        ${`lc:${second.requestId}:3:office-revision-notify:send`},
        'telegram_message_sent', ${JSON.stringify({ messageId: '734' })}::jsonb,
        'test-sent-mark', true)`.execute(trx));
    const linkedUpdate = brief(updateId(), chat);
    linkedUpdate.message.text = 'Make this one blue';
    (linkedUpdate.message as Record<string, unknown>).reply_to_message = { message_id: 734 };
    const linked = await intake(app, linkedUpdate, 'lifecycle', first.requestId);
    expect(linked.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision',
      requestId: second.requestId, priorTaskId: second.taskId });
    // The first answer was lost; even after one request advanced, the same update cannot be
    // reinterpreted as a directive for the other waiting request: it asks the same question again.
    const ambiguousReplay = await intake(createApp({ db } as any), unlinkedUpdate, 'lifecycle', first.requestId);
    expect(ambiguousReplay.body).toMatchObject({ intakeStatus: 200, duplicate: true, lifecycleAction: 'chat-answer',
      choiceRequired: true, chatAnswer: ambiguous.body.chatAnswer });
    const changedAmbiguity = await intake(app,
      { ...unlinkedUpdate, message: { ...unlinkedUpdate.message, text: 'Changed under the same ID' } },
      'lifecycle', first.requestId);
    expect(changedAmbiguity.body).toMatchObject({ intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    // A second reply to the same notice while that design is being made again is kept on it for the
    // office (ADR-144), not refused as stale, and starts nothing.
    const staleUpdate = brief(updateId(), chat);
    staleUpdate.message.text = 'Another change';
    (staleUpdate.message as Record<string, unknown>).reply_to_message = { message_id: 734 };
    const stale = await intake(app, staleUpdate, 'lifecycle', first.requestId);
    expect(stale.body).toMatchObject({ intakeStatus: 409, code: 'LATE_REQUESTER_CHANGE',
      lifecycleAction: 'late-change', requestId: second.requestId, requestStage: 'designing' });
    expect(await tasksInChat(chat)).toHaveLength(3);
  });

  it.each([['captioned', 'photo'], ['captionless', 'photo'], ['captioned', 'document'], ['captionless', 'document']] as const)(
    'asks a verified Studio question, resumes from a %s %s answer, and rejects a late second answer', async (kind, carrier) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const answerPhoto = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const bridge = { downloadFile: vi.fn(async () => answerPhoto),
      dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
    const app = createApp({ db, telegramBridge: bridge } as any);
    const { requestId, taskId: originalTaskId } = await seedWaitingRequest(app, chat);
    const change = brief(updateId(), chat);
    change.message.text = 'Make the background blue';
    const revised = await intake(app, change, 'lifecycle', requestId);
    expect(revised.body).toMatchObject({ lifecycleAction: 'requester-revision', round: 1 });
    const waitingTaskId = revised.body.newTaskId as string;
    const questionId = randomUUID();
    await withRlsContext(db, scope, (trx) => sql`INSERT INTO hawa.design_studio_runs
      (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash,
       request, tier, status, stages)
      VALUES (${questionId}::uuid, ${tenantId}::uuid, ${waitingTaskId}::uuid,
        ${clientId}::uuid, 'test', ${`question-${questionId}`}, 'fixture-hash',
        '{}'::jsonb, 'premium', 'failed',
        ${JSON.stringify({ directed: { refused: 'NEEDS_CLARIFICATION',
          clarify: { question: 'Should the headline be <larger>?',
            options: ['Larger headline', 'Keep it as is'] } } })}::jsonb)`.execute(trx));
    const runId = `dr-${waitingTaskId}`;
    const outcome = await app.request(`/v1/internal/lifecycle/${requestId}/design-outcome`, {
      method: 'POST', headers: worker, body: JSON.stringify({ v: 1, expectedRev: 4, rev: 5,
        key: `${requestId}:5:designFinished:${runId}`,
        ops: [{ kind: 'recordOutcome', taskId: waitingTaskId, runId,
          report: { status: 'DESIGN_FAILED', code: 'NEEDS_CLARIFICATION', runId: questionId } }] }),
    });
    expect(outcome.status).toBe(200);
    const asked = await outcome.json();
    expect(asked).toMatchObject({ stage: 'awaiting_answer', rev: 5,
      question: { id: questionId, options: ['Larger headline', 'Keep it as is'] } });
    expect(asked.message.text).toContain('&lt;larger&gt;');
    const confirmBody = { v: 1, requestId, expectedRev: 5, taskId: waitingTaskId,
      questionId, messageKey: `${requestId}:5:design-outcome`, messageId: '735' };
    const confirm = (body: Record<string, unknown>) => app.request(
      `/v1/internal/lifecycle/${requestId}/question-sent`, {
        method: 'POST', headers: worker, body: JSON.stringify(body),
      });
    expect((await withRlsContext(db, scope, (trx) => trx.selectFrom('requests')
      .select('question_asked_at').where('request_id', '=', requestId)
      .executeTakeFirstOrThrow())).question_asked_at).toBeNull();
    expect((await confirm(confirmBody)).status).toBe(503);
    await withRlsContext(db, scope, (trx) => sql`INSERT INTO hawa.inbox_events
      (tenant_id, source_account_id, source_event_id, event_kind, payload,
       payload_hash, verified)
      VALUES (${tenantId}::uuid, 'telegram_delivery',
        ${`lc:${requestId}:5:design-outcome:send`}, 'telegram_message_sent',
        '{"messageId":"735"}'::jsonb, 'question-sent', true)`.execute(trx));
    expect((await confirm({ ...confirmBody, messageId: '736' })).status).toBe(409);
    const confirmed = await confirm(confirmBody);
    expect(confirmed.status).toBe(200);
    const sentAtMs = (await confirmed.json()).sentAtMs as number;
    expect(sentAtMs).toBeGreaterThan(0);
    const freshCore = createApp({ db } as any);
    const replayConfirm = await freshCore.request(`/v1/internal/lifecycle/${requestId}/question-sent`, {
      method: 'POST', headers: worker, body: JSON.stringify(confirmBody),
    });
    expect(await replayConfirm.json()).toMatchObject({ sentAtMs });
    const askedAt = await withRlsContext(db, scope, (trx) => trx.selectFrom('requests')
      .select('question_asked_at').where('request_id', '=', requestId).executeTakeFirstOrThrow());
    expect(askedAt.question_asked_at?.getTime()).toBe(sentAtMs);
    const other = await seedWaitingRequest(app, chat);
    const unlinked = brief(updateId(), chat);
    unlinked.message.text = 'Larger headline';
    // ADR-144: with two requests waiting, an unlinked change is asked about in words, not refused.
    expect((await intake(app, unlinked, 'lifecycle', other.requestId)).body).toMatchObject({
      intakeStatus: 200, lifecycleAction: 'chat-answer', choiceRequired: true });
    const answer = brief(updateId(), chat);
    delete (answer.message as any).text;
    if (kind === 'captioned') (answer.message as any).caption = 'Larger headline';
    (answer.message as any).photo = [{ file_id: 'clarification-photo' }];
    if (carrier === 'document') asImageDocument(answer);
    (answer.message as Record<string, unknown>).reply_to_message = { message_id: 735 };
    const resumed = await intake(app, answer, 'lifecycle', requestId);
    expect(resumed.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-answer',
      requestId, priorTaskId: waitingTaskId, questionId, round: 2 });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    const answeredTaskId = resumed.body.newTaskId as string;
    const answerFiles = await withRlsContext(db, scope, (trx) => sql<{ sha256: string }>`SELECT sha256
      FROM hawa.task_files WHERE tenant_id = ${tenantId}::uuid
        AND task_id = ${answeredTaskId}::uuid AND role = 'reference_image'`.execute(trx));
    expect(answerFiles.rows).toHaveLength(1);
    const child = (await tasksInChat(chat)).find((task: any) => task.aggregate_id === answeredTaskId);
    expect(child?.payload).toMatchObject({ exactCopy: [{ text: 'December 4, 2026' }],
      studioOptions: { parentTaskId: originalTaskId, answers: waitingTaskId,
        clarified: true, revisionRound: 2 } });
    expect((child?.payload as any).studioOptions.revisionDirective)
      .toContain(kind === 'captioned' ? 'Larger headline' : 'no written instructions');
    const rows = await withRlsContext(db, scope, async (trx) => ({
      request: await trx.selectFrom('requests').select(['rev', 'stage', 'current_task_id'])
        .where('request_id', '=', requestId).executeTakeFirst(),
      questionTask: await trx.selectFrom('tasks').select('state').where('id', '=', waitingTaskId).executeTakeFirst(),
      source: await trx.selectFrom('inbox_events').select('payload')
        .where('source_account_id', '=', 'telegram')
        .where('source_event_id', '=', `${chat}:lc-${requestId}-r2-u${answer.update_id}`)
        .executeTakeFirst(),
    }));
    expect(rows.request).toMatchObject({ rev: '6', stage: 'designing', current_task_id: answeredTaskId });
    expect(rows.questionTask).toMatchObject({ state: 'cancelled' });
    expect(rows.source?.payload).toMatchObject({ update_id: answer.update_id,
      message: { reply_to_message: { message_id: 735 } } });
    const adopted = await app.request(`/v1/internal/lifecycle/${requestId}/requester-revision-intake`, {
      method: 'POST', headers: worker, body: JSON.stringify({ v: 1, updateId: answer.update_id,
        expectedRev: 5, priorTaskId: waitingTaskId, newTaskId: answeredTaskId,
        round: 2, directive: resumed.body.directive, questionId }),
    });
    expect(adopted.status).toBe(200);
    const replay = await intake(createApp({ db } as any), answer, 'lifecycle', requestId);
    expect(replay.body).toMatchObject({ intakeStatus: 200, duplicate: true,
      lifecycleAction: 'requester-answer', newTaskId: answeredTaskId, questionId });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    const late = brief(updateId(), chat);
    late.message.text = 'Keep it as is';
    (late.message as Record<string, unknown>).reply_to_message = { message_id: 735 };
    // ADR-144: "keep it as is" to the answered question is the requester being happy: the office is
    // told, nothing is approved and nothing starts (it was refused as a stale reply before).
    expect((await intake(app, late, 'lifecycle', requestId)).body).toMatchObject({
      intakeStatus: 200, lifecycleAction: 'chat-answer', note: 'approval', requestId });
    expect(await (await confirm(confirmBody)).json()).toMatchObject({ skipped: true });
    expect(await tasksInChat(chat)).toHaveLength(4);
  });

  it('answers NOT_CONFIGURED without the webhook secret', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const app = createApp({ db } as any);
    vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', '');
    expect((await intake(app, brief(updateId(), chatId()))).body).toMatchObject({ intakeStatus: 503, code: 'NOT_CONFIGURED' });
    // lifecycle mode also gets NOT_CONFIGURED when webhook secret is absent.
    expect((await intake(app, brief(updateId(), chatId()), 'lifecycle')).body).toMatchObject({ intakeStatus: 503, code: 'NOT_CONFIGURED' });
  });

  it('passes intake\'s deliberate refusal on as final (a sender outside the allowlist in production)', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TELEGRAM_INTAKE_ALLOWED_USERS', String(OFFICE));
    const app = createApp({ db } as any);
    const stranger = brief(updateId(), chatId());
    stranger.message.from.id = 12345;
    expect((await intake(app, stranger)).body).toMatchObject({ kind: 'handled', intakeStatus: 403 });
  });
});

describe('what intake answers when an update opens no request (ADR-135 stage 2c)', () => {
  const text = (chat: number, words: string, extra: Record<string, unknown> = {}) => {
    const update = brief(updateId(), chat) as any;
    update.message.text = words;
    Object.assign(update.message, extra);
    return update;
  };
  const bridgeStub = () => ({ downloadFile: vi.fn(), dispatchOutboundMessage: vi.fn(async () => ({ success: true })),
    answerCallbackQuery: vi.fn(async () => true) });
  const chatAnswerEvents = async (chat: number) => (await withRlsContext(db, scope, (trx) => sql<{ payload: Record<string, any> }>`
    SELECT payload FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'telegram'
      AND event_kind = 'telegram_chat_answer' AND source_event_id LIKE ${`${chat}:%`}`.execute(trx))).rows;

  // ADR-145 (#62, #63, #70): plain words in the sender's language, with no product name, no reply
  // instruction and no command.
  it.each([
    ['a greeting', 'hello', /^👋 Hi! What would you like designed\? Tell me in your own words/],
    ['a Kurdish greeting', 'سڵاو', /^👋 سڵاو! چیت دەوێت دیزاین بکرێت؟/],
    // "when will it be ready?" is a status question since ADR-144 (requester-intent-routing.test.ts).
    ['a question', 'what fonts can you use?', /^Happy to help\. Tell me what you'd like designed/],
    ['/start', '/start', /^👋 Hi! Tell me what you'd like designed, in English or Kurdish/],
    ['/help@hawa_bot', '/help@hawa_bot', /^👋 Hi! Tell me what you'd like designed/],
    ['a Kurdish /start', '/start سڵاو', /^👋 سڵاو! پێم بڵێ چیت دەوێت دیزاین بکرێت/],
    ['an unknown command', '/weather', /^Happy to help\./],
  ] as const)('answers %s through ChatInbox, starts nothing, and gives the recorded answer again', async (_what, words, expected) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const bridge = bridgeStub();
    const chat = chatId();
    const update = text(chat, words);
    const first = await intake(createApp({ db, telegramBridge: bridge } as any), update);
    expect(first.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', chatId: String(chat),
      chatAnswer: { text: expect.stringMatching(expected), parseMode: 'HTML' } });
    expect(first.body.requestId).toBeUndefined();
    expect(bridge.dispatchOutboundMessage).not.toHaveBeenCalled();
    expect(await tasksInChat(chat)).toHaveLength(0);
    if (!words.startsWith('/')) {
      // Recorded once: the worker asking again after a lost answer gets the same words.
      expect(await chatAnswerEvents(chat)).toHaveLength(1);
      const again = await intake(createApp({ db, telegramBridge: bridge } as any), update);
      expect(again.body).toMatchObject({ duplicate: true, lifecycleAction: 'chat-answer', chatAnswer: first.body.chatAnswer });
    }
  });

  it('answers /approve, /publish, /revise and /reject with the office\'s final check, and changes nothing', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    for (const words of ['/approve', `/approve ${randomUUID()}`, '/publish x', '/revise x change it', '/reject x']) {
      const answered = await intake(createApp({ db } as any), text(chat, words));
      expect(answered.body, words).toMatchObject({ intakeStatus: 422, lifecycleAction: 'chat-answer',
        // ADR-145 (#67): no office alert is sent for the command, so the answer claims none.
        chatAnswer: { text: "Thanks! The office gives every design a final check before it's sent to you. If anything should change, just tell me here." } });
    }
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  it('/status lists the chat\'s requests and where each is', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const empty = await intake(createApp({ db } as any), text(chat, '/status'));
    expect(empty.body).toMatchObject({ lifecycleAction: 'chat-answer',
      chatAnswer: { text: "📊 I haven't made any designs for this chat yet. Tell me what you'd like designed." } });
    const { taskId } = await seedWaitingRequest(createApp({ db } as any), chat);
    // (With a request waiting for the requester, a message is its revision: the request is delivered here.)
    await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.requests SET stage = 'delivered', rev = 9
      WHERE tenant_id = ${tenantId}::uuid AND chat_id = ${String(chat)}`.execute(trx));
    const listed = await intake(createApp({ db } as any), text(chat, '/status'));
    // ADR-145 (#71): the designs by name and where each is, in words; no ids and no Canva links.
    expect(listed.body.chatAnswer.text).toMatch(/^<b>📊 Your designs<\/b>\n\n1\. <b>/);
    expect(listed.body.chatAnswer.text).not.toContain(taskId.slice(0, 8));
    expect(listed.body.chatAnswer.text).not.toMatch(/Canva|<code>|Hawa Desk/);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('saves a standing rule said in chat for the chat\'s client, lists it with /rules and removes it once with /forget', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    await seedWaitingRequest(createApp({ db } as any), chat);
    // With a request waiting, a message is its revision; the rule is said once that request is done.
    await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.requests SET stage = 'delivered', rev = 9
      WHERE tenant_id = ${tenantId}::uuid AND chat_id = ${String(chat)}`.execute(trx));
    const rule = `From now on, always put the logo bottom-right ${randomUUID().slice(0, 8)}`;
    const said = text(chat, rule);
    const saved = await intake(createApp({ db } as any), said);
    expect(saved.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', chatAnswer: { parseMode: 'HTML' } });
    expect(saved.body.chatAnswer.text).toContain('logo bottom-right');
    // ADR-145 (#74): plain words; the commands keep working but are never named.
    expect(saved.body.chatAnswer.text).toContain('Noted. From now on every');
    expect(saved.body.chatAnswer.text).not.toMatch(/\/rules|\/forget/);
    const rules = async () => (await withRlsContext(db, scope, (trx) => sql<{ id: string; active: boolean }>`
      SELECT id::text, status = 'active' AS active FROM hawa.client_rules WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
        AND human_rule LIKE ${`%${rule.slice(-8)}%`}`.execute(trx))).rows;
    expect(await rules()).toEqual([expect.objectContaining({ active: true })]);
    // The same update again: the recorded answer, no second rule.
    expect((await intake(createApp({ db } as any), said)).body).toMatchObject({ duplicate: true, chatAnswer: saved.body.chatAnswer });
    expect(await rules()).toHaveLength(1);
    const listed = await intake(createApp({ db } as any), text(chat, '/rules'));
    expect(listed.body.chatAnswer.text).toContain(rule.slice(-8));
    const number = (/(\d+)\.\s[^\n]*/.exec(listed.body.chatAnswer.text.split('\n').find((l: string) => l.includes(rule.slice(-8))) ?? '') ?? [])[1];
    expect(number).toBeTruthy();
    const forget = text(chat, `/forget ${number}`);
    const forgotten = await intake(createApp({ db } as any), forget);
    expect(forgotten.body.chatAnswer.text).toContain('No longer applied');
    expect(forgotten.body.chatAnswer.text).not.toMatch(/\/rules|\/forget/);
    expect((await rules())[0]?.active).toBe(false);
    // "/forget 1" repeated must not remove the rule after it: the recorded answer is given again.
    const before = (await withRlsContext(db, scope, (trx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.client_rules
      WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid AND status = 'active'`.execute(trx))).rows[0].n;
    expect((await intake(createApp({ db } as any), forget)).body).toMatchObject({ duplicate: true, chatAnswer: forgotten.body.chatAnswer });
    const after = (await withRlsContext(db, scope, (trx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM hawa.client_rules
      WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid AND status = 'active'`.execute(trx))).rows[0].n;
    expect(after).toBe(before);
  });

  it('asks which client a rule is for when the chat has none, and saves nothing', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const answered = await intake(createApp({ db } as any), text(chat, 'From now on, always use navy for titles'));
    expect(answered.body).toMatchObject({ intakeStatus: 200, status: 'RULE_CLIENT_UNKNOWN', lifecycleAction: 'chat-answer',
      chatAnswer: { text: expect.stringContaining('Which organisation is this for?') } });
    expect(await chatAnswerEvents(chat)).toHaveLength(0);
  });

  it('tells the sender an edited message is not picked up, and a group chat message is kept without an answer', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const edit = brief(updateId(), chat) as any;
    edit.edited_message = { ...edit.message, text: 'KAAE members evening\n---\nDecember 5, 2026', edit_date: 1790000100 };
    delete edit.message;
    const edited = await intake(createApp({ db } as any), edit);
    // ADR-145: an edit is never "not picked up". This one edits a message the bot has no record of,
    // so it goes to the office (see natural-media-intake.test.ts for edits it can place).
    expect(edited.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer',
      chatAnswer: { text: "I saw your edit and passed it to the office; they'll follow up here." } });
    const group = -Math.abs(chatId());
    const chatter = text(group, 'hi everyone', { chat: { id: group, type: 'supergroup' } });
    const kept = await intake(createApp({ db } as any), chatter);
    expect(kept.body).toMatchObject({ intakeStatus: 200, status: 'MESSAGE_ONLY' });
    expect(kept.body.lifecycleAction).toBeUndefined();
    expect(await chatAnswerEvents(group)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ what: 'message_only' }) })]);
    // A "/task …" in a group opens a request as /new does (ADR-144; it asked for /new before).
    const promoted = await intake(createApp({ db } as any), text(group, '/task Eid poster', { chat: { id: group, type: 'supergroup' } }));
    expect(promoted.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', chatId: String(group),
      draft: { rawText: 'Eid poster', autoGenerate: false } });
    expect(await tasksInChat(group)).toHaveLength(0);
  });

  it('answers a button press as a stale reply, whatever its data, with a receipt', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const bridge = bridgeStub();
    const chat = chatId();
    for (const data of [`rq:ok:${randomUUID()}`, `act:${'x'.repeat(40)}`, 'pick_layout:1']) {
      const press = { update_id: updateId(), callback_query: { id: `cb-${randomUUID()}`, from: { id: OFFICE, is_bot: false, first_name: 'Owner' },
        data, message: { message_id: 4244, chat: { id: chat, type: 'private' }, date: 1790000000, text: 'Draft ready' } } };
      const answered = await intake(createApp({ db, telegramBridge: bridge } as any), press);
      expect(answered.body, data).toMatchObject({ intakeStatus: 409, code: 'STALE_REQUEST_REPLY',
        lifecycleAction: 'request-choice-required', chatId: String(chat) });
    }
    expect(bridge.answerCallbackQuery).toHaveBeenCalledTimes(3);
    expect(bridge.dispatchOutboundMessage).not.toHaveBeenCalled();
    expect(await tasksInChat(chat)).toHaveLength(0);
  });
});

describe('POST /v1/internal/telegram/park', () => {
  it('dead-letters the update by id, alerts the office and tells the sender, once however often it is asked', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('TELEGRAM_BOT_TOKEN', ['700000123', ['fixture', 'bot', 'secret'].join('_')].join(':'));
    const telegram = fakeTelegram();
    const chat = chatId();
    const update = brief(updateId(), chat);
    const park = (app: any) => app.request('/v1/internal/telegram/park', { method: 'POST', headers: worker, body: JSON.stringify({ v: 1, update, reason: 'intake answered HTTP 500 after 5 attempts', notifySender: true }) });

    const first = await park(createApp({ db } as any));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ parked: true, alreadyParked: false });
    const second = await park(createApp({ db } as any));
    expect(await second.json()).toMatchObject({ parked: true, alreadyParked: true });

    const rows = await withRlsContext(db, scope, async (trx) =>
      (await sql<any>`SELECT payload, processing_error FROM hawa.inbox_events WHERE source_account_id = 'telegram' AND source_event_id = ${`parked-update-${update.update_id}`}`.execute(trx)).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ update_id: update.update_id, kind: 'message' });
    expect(rows[0].processing_error).toMatch(/HTTP 500 after 5 attempts/);
    const alerts = await withRlsContext(db, scope, async (trx) =>
      (await sql<any>`SELECT payload FROM hawa.outbox_commands WHERE idempotency_key = ${`notify.office:telegram-update-parked:${update.update_id}`}`.execute(trx)).rows);
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0].payload)).not.toContain('KAAE members evening');
    expect(telegram.sent.filter((m) => String(m.chat_id) === String(chat)).map((m) => m.text)).toEqual([PARKED_UPDATE_NOTICE]);
  });

  it('refuses every credential but the worker\'s', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const res = await createApp({ db } as any).request('/v1/internal/telegram/park', { method: 'POST', headers: admin, body: JSON.stringify({ v: 1, update: brief(updateId(), chatId()), reason: 'x' }) });
    expect(res.status).toBe(401);
  });
});

describe('the kill switch the worker\'s poller reads', () => {
  it('is the switch the office throws in Core (its own row in Postgres, not the bot\'s)', async () => {
    const app = createApp({ db } as any);
    // The worker reads it as System Automation, its own database identity.
    const automation = { tenantId, userId: SYSTEM_AUTOMATION_USER_ID };
    const set = (active: boolean) => app.request('/v1/operations/kill-switch', { method: 'POST', headers: { ...operator, Authorization: 'Bearer test_admin_key' }, body: JSON.stringify({ channel: 'telegram', active }) });
    // The route answers at once and saves the switch in the background (channel-kill-switches.ts).
    expect((await set(true)).status).toBe(200);
    await vi.waitFor(async () => expect(await readTelegramKillSwitch(db, automation)).toBe(true), { timeout: 5000, interval: 50 });
    expect((await set(false)).status).toBe(200);
    await vi.waitFor(async () => expect(await readTelegramKillSwitch(db, automation)).toBe(false), { timeout: 5000, interval: 50 });
  });
});

describe('HAWA_TELEGRAM_POLLER', () => {
  // ADR-135: the worker is the only poller; stage 2 removed Core's poller and "poll now".
  it('names the worker whatever it says, and Core has no poller to start', async () => {
    fakeTelegram();
    for (const value of [undefined, 'core', 'nonsense', ' Worker ']) {
      expect(telegramPollerOf({ HAWA_TELEGRAM_POLLER: value })).toBe('worker');
      expect(productionAppOptions({ HAWA_TELEGRAM_POLLER: value })).not.toHaveProperty('enableTelegramPolling');
    }
    vi.stubEnv('HAWA_TELEGRAM_POLLER', 'core');
    const app = createApp({ db } as any);
    expect((await app.request('/v1/adapters/telegram/poll-now', { method: 'POST', headers: admin })).status).toBe(404);
    expect(await (await app.request('/v1/adapters/telegram/status')).json()).toMatchObject({ poller: 'worker' });
  });
});

