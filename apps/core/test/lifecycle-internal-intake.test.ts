import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, readTelegramKillSwitch, sql, withRlsContext } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { blobStoreFor } from '../src/services/blob-store-context.js';
import { recordRevisionPhotoDecision } from '../src/services/lifecycle-chat-target.js';
import { PARKED_UPDATE_NOTICE } from '../src/services/polled-update-dispatch.js';
import { productionAppOptions } from '../src/entrypoint-options.js';
import { telegramPollerOf } from '../src/services/telegram-poller-owner.js';

/**
 * Core's side of Phase 2.1 (PHASE2_DESIGN.md slice 2.1), against the per-file test database as
 * hawa_app (row-level security as in production): the worker's ChatInbox hands each update to
 * POST /v1/internal/telegram/intake, which runs today's intake unchanged, and dead-letters one intake
 * keeps failing through POST /v1/internal/telegram/park. HAWA_TELEGRAM_POLLER decides which process
 * polls; unset, Core does, exactly as before.
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
  await createApp({ db } as any).request('/v1/operations/kill-switch', { method: 'POST', headers: operator, body: JSON.stringify({ channel: 'telegram', active: false }) });
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

describe('POST /v1/internal/telegram/intake', () => {
  it('prepares a flagged first brief without a Core task and replays its open after the flag changes', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const update = brief(updateId(), chat);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', String(chat));
    const app = createApp({ db } as any);
    const first = await intake(app, update);
    expect(first.body).toMatchObject({ kind: 'handled', intakeStatus: 200,
      lifecycleAction: 'open-request', duplicate: false, chatId: String(chat),
      draft: { platform: 'telegram', rawText: update.message.text,
        sourceChannelId: String(chat), autoGenerate: true, clientId } });
    expect(first.body.draft.sourceEventId).toBe(`lc-${first.body.requestId}-r0`);
    expect(await tasksInChat(chat)).toHaveLength(0);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '');
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

  it('opens an explicit second brief while another lifecycle request awaits a revision', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const waiting = await seedWaitingRequest(app, chat);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', String(chat));
    const update = brief(updateId(), chat);
    update.message.text = '/new KAAE second event\n---\nDecember 9, 2026\nErbil';
    const result = await intake(app, update, 'lifecycle', waiting.requestId);
    expect(result.body).toMatchObject({ lifecycleAction: 'open-request', intakeStatus: 200,
      draft: { rawText: 'KAAE second event\n---\nDecember 9, 2026\nErbil' } });
    expect(result.body.requestId).not.toBe(waiting.requestId);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('refuses an unlinked reply in a flagged chat instead of saving it as a new task', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', String(chat));
    const update = brief(updateId(), chat);
    (update.message as any).reply_to_message = { message_id: 123456 };
    const result = await intake(createApp({ db } as any), update);
    expect(result.body).toMatchObject({ intakeStatus: 409, code: 'STALE_REQUEST_REPLY' });
    expect(await tasksInChat(chat)).toHaveLength(0);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '');
    const replay = await intake(createApp({ db } as any), update);
    expect(replay.body).toMatchObject({ intakeStatus: 409, code: 'STALE_REQUEST_REPLY',
      lifecycleAction: 'request-choice-required' });
    const altered = structuredClone(update);
    altered.message.text = 'An unrelated brief';
    expect((await intake(createApp({ db } as any), altered)).body).toMatchObject({
      intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  it('admits a styling-only message as manual and does not promote a greeting to a lifecycle request', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', String(chat));
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

  it('admits a captioned photo through its owned task without image bytes in Restate', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', String(chat));
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    (update.message as any).caption = 'KAAE members evening\n---\nDecember 4, 2026\nErbil';
    (update.message as any).photo = [{ file_id: 'photo-fixture', file_size: 128 }];
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
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '');
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

  it('holds voice, PDF and album parts when the stored chat mode is lifecycle', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '');
    const app = createApp({ db } as any);
    for (const media of [
      { voice: { file_id: 'voice-fixture', duration: 5 }, caption: 'The exact spoken brief' },
      { document: { file_id: 'pdf-fixture', mime_type: 'application/pdf', file_name: 'brand.pdf' }, caption: 'Use these guidelines' },
      { photo: [{ file_id: 'album-fixture' }], media_group_id: 'album-1' },
      { photo: [{ file_id: 'captionless-fixture' }] },
    ]) {
      const chat = chatId();
      const update = brief(updateId(), chat);
      delete (update.message as any).text;
      Object.assign(update.message, media);
      const result = await intake(app, update, 'lifecycle');
      expect(result.body).toMatchObject({ intakeStatus: 422,
        lifecycleAction: 'park-update', code: 'LIFECYCLE_MEDIA_NOT_ADMITTED' });
      expect(await tasksInChat(chat)).toHaveLength(0);
    }
  });

  it('waits without downloading when durable photo storage is unavailable', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('HAWA_BLOB_DIR', '');
    const chat = chatId();
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', String(chat));
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

  it('parks an unreadable photo rather than designing from its caption alone', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', String(chat));
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    (update.message as any).caption = 'KAAE new design\n---\nDecember 4, 2026';
    (update.message as any).photo = [{ file_id: 'photo-invalid' }];
    const bridge = { downloadFile: vi.fn(async () => Buffer.from('not an image')) };
    const result = await intake(createApp({ db, telegramBridge: bridge } as any), update);
    expect(result.body).toMatchObject({ intakeStatus: 422, lifecycleAction: 'park-update',
      code: 'LIFECYCLE_MEDIA_NOT_ADMITTED' });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  it('holds media in channel posts and edited messages before legacy intake can see it', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    for (const kind of ['channel_post', 'edited_message'] as const) {
      const chat = chatId();
      vi.stubEnv('HAWA_LIFECYCLE_CHATS', String(chat));
      const update = brief(updateId(), chat) as any;
      update[kind] = { ...update.message, photo: [{ file_id: `${kind}-fixture` }],
        caption: 'New design with this image' };
      delete update[kind].text;
      delete update.message;
      const result = await intake(createApp({ db } as any), update);
      expect(result.body).toMatchObject({ intakeStatus: 422,
        lifecycleAction: 'park-update', code: 'LIFECYCLE_MEDIA_NOT_ADMITTED' });
      expect(await tasksInChat(chat)).toHaveLength(0);
    }
  });

  it('keeps an existing Core chat on legacy intake until the sender explicitly starts a separate brief', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const oldUpdate = brief(updateId(), chat);
    const old = await intake(app, oldUpdate);
    expect(old.body.taskIds).toHaveLength(1);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', String(chat));
    const replay = await intake(createApp({ db } as any), oldUpdate);
    expect(replay.body).toMatchObject({ duplicate: true, taskIds: old.body.taskIds });
    expect(replay.body.lifecycleAction).toBeUndefined();
    expect(await tasksInChat(chat)).toHaveLength(1);
    const ordinary = brief(updateId(), chat);
    ordinary.message.text = 'KAAE follow-up event\n---\nDecember 9, 2026';
    const legacy = await intake(app, ordinary);
    expect(legacy.body.lifecycleAction).toBeUndefined();
    expect(legacy.body.taskIds).toHaveLength(1);
    const pins = await withRlsContext(db, scope, async (trx) =>
      (await sql<{ delivery_executor_pin: string }>`SELECT t.delivery_executor_pin
        FROM hawa.tasks t WHERE t.id = ${legacy.body.taskIds[0]}::uuid`.execute(trx)).rows);
    expect(pins).toEqual([{ delivery_executor_pin: 'core' }]);
    const explicit = brief(updateId(), chat);
    explicit.message.text = '/new KAAE new request\n---\nDecember 10, 2026';
    expect((await intake(app, explicit)).body).toMatchObject({ lifecycleAction: 'open-request' });
  });

  it('runs today\'s intake: a brief becomes one task, and the same update again is a duplicate, not a second task', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const update = brief(updateId(), chat);
    const app = createApp({ db } as any);

    const first = await intake(app, update);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ v: 1, kind: 'handled', intakeStatus: 201, duplicate: false });
    expect(first.body.taskIds).toHaveLength(1);

    // Delivered again: by Restate after a worker restart, or by the other poller after a rollback.
    const again = await intake(createApp({ db } as any), update);
    expect(again.body).toMatchObject({ kind: 'handled', intakeStatus: 200, duplicate: true, taskIds: first.body.taskIds });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('answers INTAKE_PAUSED while the office has switched Telegram off, and starts nothing', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    expect((await app.request('/v1/operations/kill-switch', { method: 'POST', headers: operator, body: JSON.stringify({ channel: 'telegram', active: true }) })).status).toBe(200);
    const paused = await intake(app, brief(updateId(), chat));
    expect(paused.body).toMatchObject({ kind: 'handled', intakeStatus: 503, code: 'INTAKE_PAUSED' });
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  it('accepts lifecycle mode and falls through to legacy intake when no manual request matches', async () => {
    // lifecycle is now a supported mode (Phase 2.3 Q/A loop).
    // When no lifecycle request is in manual stage for the chat, it falls through to legacy intake.
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const update = brief(updateId(), chat);
    const app = createApp({ db } as any);
    const result = await intake(app, update, 'lifecycle');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ kind: 'handled', intakeStatus: 201 });
    // A mode we have never heard of is still refused.
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

  it('binds a captioned reply photo to only its selected revision task and replays after flag rollback', async () => {
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
    (update.message as any).caption = 'Please use this photo and a blue background';
    (update.message as any).photo = [{ file_id: 'revision-photo', file_size: 128 }];
    (update.message as any).reply_to_message = { message_id: 843 };
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const bridge = { downloadFile: vi.fn(async () => photo),
      dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
    const photoApp = createApp({ db, telegramBridge: bridge } as any);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', String(chat));
    const result = await intake(photoApp, update, 'lifecycle');
    expect(result.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision',
      requestId: second.requestId, priorTaskId: second.taskId, duplicate: false });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
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
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '');
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

  it('requires a unique request before downloading a revision photo', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const app = createApp({ db } as any);
    await seedWaitingRequest(app, chat);
    await seedWaitingRequest(app, chat);
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    (update.message as any).caption = 'Use this image for the revision';
    (update.message as any).photo = [{ file_id: 'ambiguous-photo' }];
    const bridge = { downloadFile: vi.fn(),
      dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
    const result = await intake(createApp({ db, telegramBridge: bridge } as any), update, 'lifecycle');
    expect(result.body).toMatchObject({ intakeStatus: 409, code: 'AMBIGUOUS_REQUEST',
      lifecycleAction: 'request-choice-required' });
    expect(bridge.downloadFile).not.toHaveBeenCalled();
    expect(await tasksInChat(chat)).toHaveLength(2);
    expect((await intake(createApp({ db } as any), update)).body).toMatchObject({
      intakeStatus: 409, code: 'AMBIGUOUS_REQUEST' });
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

  it('projects a saved photo decision after Core restarts without asking Telegram for the file again', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const chat = chatId();
    const { requestId } = await seedWaitingRequest(createApp({ db } as any), chat);
    const update = brief(updateId(), chat);
    delete (update.message as any).text;
    (update.message as any).caption = 'Use this reference for the revision';
    (update.message as any).photo = [{ file_id: 'already-saved-photo' }];
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const image = await blobStoreFor(db)!.put(photo, 'image/png');
    const payloadHash = createHash('sha256').update(JSON.stringify(update)).digest('hex');
    await withRlsContext(db, scope, (trx) => recordRevisionPhotoDecision(trx,
      tenantId, update.update_id, { requestId, chatId: String(chat), payloadHash, image }));
    // The cutover flag and Telegram bridge can both disappear before the first Core answer.
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '');
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

  it('requires a linked reply for two waiting requests and refuses a stale linked reply', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const app = createApp({ db } as any);
    const first = await seedWaitingRequest(app, chat);
    const second = await seedWaitingRequest(app, chat);
    const unlinkedUpdate = brief(updateId(), chat);
    unlinkedUpdate.message.text = 'Use the blue background';
    const ambiguous = await intake(app, unlinkedUpdate, 'lifecycle', first.requestId);
    expect(ambiguous.body).toMatchObject({ intakeStatus: 409, code: 'AMBIGUOUS_REQUEST',
      lifecycleAction: 'request-choice-required', chatId: String(chat) });
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
    // reinterpreted as a directive for the other waiting request.
    const ambiguousReplay = await intake(createApp({ db } as any), unlinkedUpdate, 'lifecycle', first.requestId);
    expect(ambiguousReplay.body).toMatchObject({ intakeStatus: 409, code: 'AMBIGUOUS_REQUEST',
      lifecycleAction: 'request-choice-required' });
    const changedAmbiguity = await intake(app,
      { ...unlinkedUpdate, message: { ...unlinkedUpdate.message, text: 'Changed under the same ID' } },
      'lifecycle', first.requestId);
    expect(changedAmbiguity.body).toMatchObject({ intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    const staleUpdate = brief(updateId(), chat);
    staleUpdate.message.text = 'Another change';
    (staleUpdate.message as Record<string, unknown>).reply_to_message = { message_id: 734 };
    const stale = await intake(app, staleUpdate, 'lifecycle', first.requestId);
    expect(stale.body).toMatchObject({ intakeStatus: 409, code: 'STALE_REQUEST_REPLY',
      lifecycleAction: 'request-choice-required' });
    expect(await tasksInChat(chat)).toHaveLength(3);
  });

  it('asks a verified Studio question, resumes from a photo answer, and rejects a late second answer', async () => {
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
    expect((await intake(app, unlinked, 'lifecycle', other.requestId)).body).toMatchObject({
      intakeStatus: 409, code: 'AMBIGUOUS_REQUEST', lifecycleAction: 'request-choice-required' });
    const answer = brief(updateId(), chat);
    delete (answer.message as any).text;
    (answer.message as any).caption = 'Larger headline';
    (answer.message as any).photo = [{ file_id: 'clarification-photo' }];
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
    expect((child?.payload as any).studioOptions.revisionDirective).toContain('Larger headline');
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
        round: 2, directive: (answer.message as any).caption, questionId }),
    });
    expect(adopted.status).toBe(200);
    const replay = await intake(createApp({ db } as any), answer, 'lifecycle', requestId);
    expect(replay.body).toMatchObject({ intakeStatus: 200, duplicate: true,
      lifecycleAction: 'requester-answer', newTaskId: answeredTaskId, questionId });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    const late = brief(updateId(), chat);
    late.message.text = 'Keep it as is';
    (late.message as Record<string, unknown>).reply_to_message = { message_id: 735 };
    expect((await intake(app, late, 'lifecycle', requestId)).body).toMatchObject({
      intakeStatus: 409, code: 'STALE_REQUEST_REPLY', lifecycleAction: 'request-choice-required' });
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
    const set = (active: boolean) => app.request('/v1/operations/kill-switch', { method: 'POST', headers: operator, body: JSON.stringify({ channel: 'telegram', active }) });
    // The route answers at once and saves the switch in the background (channel-kill-switches.ts).
    expect((await set(true)).status).toBe(200);
    await vi.waitFor(async () => expect(await readTelegramKillSwitch(db, automation)).toBe(true), { timeout: 5000, interval: 50 });
    expect((await set(false)).status).toBe(200);
    await vi.waitFor(async () => expect(await readTelegramKillSwitch(db, automation)).toBe(false), { timeout: 5000, interval: 50 });
  });
});

describe('HAWA_TELEGRAM_POLLER', () => {
  it('leaves polling in Core unless it says worker', () => {
    expect(telegramPollerOf({})).toBe('core');
    expect(telegramPollerOf({ HAWA_TELEGRAM_POLLER: 'core' })).toBe('core');
    expect(telegramPollerOf({ HAWA_TELEGRAM_POLLER: 'nonsense' })).toBe('core');
    expect(telegramPollerOf({ HAWA_TELEGRAM_POLLER: ' Worker ' })).toBe('worker');
    expect(productionAppOptions({}).enableTelegramPolling).toBe(true);
    expect(productionAppOptions({ HAWA_TELEGRAM_POLLER: 'worker' }).enableTelegramPolling).toBe(false);
  });

  it('"poll now" is refused with 409 while the worker polls, and works as before otherwise', async () => {
    fakeTelegram();
    vi.stubEnv('HAWA_TELEGRAM_POLLER', 'worker');
    const app = createApp({ db } as any);
    const refused = await app.request('/v1/adapters/telegram/poll-now', { method: 'POST', headers: admin });
    expect(refused.status).toBe(409);
    expect((await app.request('/v1/adapters/telegram/status')).status).toBe(200);
    expect(await (await app.request('/v1/adapters/telegram/status')).json()).toMatchObject({ poller: 'worker' });
    vi.stubEnv('HAWA_TELEGRAM_POLLER', 'core');
    expect(await (await app.request('/v1/adapters/telegram/status')).json()).toMatchObject({ poller: 'core' });
    expect((await app.request('/v1/adapters/telegram/poll-now', { method: 'POST', headers: admin })).status).not.toBe(409);
  });
});
