import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { MEDIA_MESSAGES, ACCESS_MESSAGES } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { readRevisionPhotoDecision } from '../src/services/lifecycle-chat-target.js';

/**
 * ADR-145: photos, videos, edits and senders outside the intake list, as a requester sends them. A
 * photo with no words joins the words sent just before or after it (five minutes, durably, used once);
 * an iPhone HEIC photo becomes a JPEG; a video is explained, never parked; an edit updates what is still
 * held, or reaches the office as a note; a stranger hears one polite line a day. And a message sent
 * while its sender's brief waits for photos (ADR-143) is read after that brief opens.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const OFFICE = 91000017;
const WORKER = ['worker', 'media', 'fixture', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { process.env = saved; await Promise.all([db.destroy(), owner.destroy()]); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const chatId = () => 64_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_000_000_000 + Math.floor(Math.random() * 900_000_000);
const BRIEF = 'KAAE members evening\n---\nDecember 4, 2026\nErbil';
const has = (command: string, args: string[]) => { try { execFileSync(command, args, { stdio: 'ignore' }); return true; } catch { return false; } };

type Msg = Record<string, unknown>;
const message = (chat: number, fields: Msg, from = OFFICE) => {
  const id = updateId();
  return { update_id: id, message: { message_id: id % 1_000_000, date: 1790000000, chat: { id: chat, type: 'private' },
    from: { id: from, is_bot: false, first_name: 'Requester' }, ...fields } } as { update_id: number; message: Msg };
};
const photo = (chat: number, fields: Msg = {}) => message(chat, { photo: [{ file_id: `photo-${randomUUID()}`, width: 900, height: 900 }], ...fields });
const edited = (original: { update_id: number; message: Msg }, fields: Msg) => {
  const id = updateId();
  return { update_id: id, edited_message: { ...original.message, edit_date: 1790000100, ...fields } } as Record<string, any>;
};

function app(extra: Record<string, unknown> = {}) {
  vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
  const bridge = { downloadFile: vi.fn(async () => PNG), dispatchOutboundMessage: vi.fn(async () => ({ success: true })),
    answerCallbackQuery: vi.fn(async () => true) };
  return { app: createApp({ db, telegramBridge: bridge, ...extra } as any), bridge };
}
const intake = async (a: any, update: unknown, body: Record<string, unknown> = {}) => {
  const res = await a.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker,
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true, ...body }) });
  return (await res.json()) as Record<string, any>;
};
const settle = (a: any, update: unknown) => intake(a, update, { settle: true, briefHold: true });
const project = async (a: any, open: Record<string, any>) => a.request(`/v1/internal/lifecycle/${open.requestId}/project`, {
  method: 'POST', headers: worker,
  body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${open.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: open.draft }] }) });
const tasksInChat = async (chat: number) => (await withRlsContext(db, scope, (trx) =>
  trx.selectFrom('outbox_commands').select(['aggregate_id', 'payload']).where('command_type', '=', 'task.created').execute()))
  .filter((r: any) => String(r.payload?.sourceChannelId) === String(chat));
const age = (kind: string, id: number | string, minutes: number) => sql`UPDATE hawa.inbox_events
  SET received_at = now() - make_interval(mins => ${minutes})
  WHERE tenant_id = ${tenantId}::uuid AND source_account_id = ${kind} AND source_event_id = ${String(id)}`.execute(owner);

/** A lifecycle request of this chat at a stage, from a brief the sender sent. */
async function seedRequest(chat: number, stage: string, rev: number) {
  const requestId = randomUUID();
  const created = await persistChatIntake(db, { platform: 'telegram', sourceEventId: `lc-seed-${requestId}`, sourceChannelId: String(chat),
    rawText: 'KAAE members evening', title: 'KAAE members evening', clientId, designInstructions: 'Make the event design',
    exactCopy: [{ text: 'December 4, 2026' }], autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 } },
  { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id)
      VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, null, 'restate', ${stage}, ${rev}, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  return { requestId, taskId };
}
const taskFiles = async (taskId: string) => (await sql<{ sha256: string; role: string }>`SELECT sha256, role FROM hawa.task_files
  WHERE task_id = ${taskId}::uuid`.execute(owner)).rows;

describe('a photo with no words (audit F5)', () => {
  it('photo first, words second: the brief opens with the photo, and the photo\'s settle says nothing more', async () => {
    const { app: a, bridge } = app();
    const chat = chatId();
    const shot = photo(chat);
    expect(await intake(a, shot)).toMatchObject({ intakeStatus: 202, lifecycleAction: 'settle-later', settle: { kind: 'photo', delayMs: 8000 } });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    const words = message(chat, { text: BRIEF });
    const opened = await intake(a, words);
    expect(opened).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request',
      draft: { lifecycleImage: { sha256: sha(PNG), mediaType: 'image/png', updateId: words.update_id } },
      notice: { text: MEDIA_MESSAGES.photoUsedWithWords.en } });
    expect(await settle(a, shot)).toMatchObject({ intakeStatus: 200, settle: 'skipped', photo: 'brief' });
    // Replays decide the same: the open is given again; the photo is used once.
    expect(await intake(a, words)).toMatchObject({ duplicate: true, lifecycleAction: 'open-request', requestId: opened.requestId });
    expect((await project(a, opened)).status).toBe(200);
    const [task] = await tasksInChat(chat);
    expect(await taskFiles(String(task.aggregate_id))).toEqual([{ sha256: sha(PNG), role: 'reference_image' }]);
    // A second brief from the same sender does not take the photo again.
    const second = await intake(a, message(chat, { text: 'KAAE graduation evening\n---\nDecember 9, 2026\nErbil' }));
    expect(second.draft.lifecycleImage).toBeUndefined();
  });

  it('a photo sent longer ago than the window is not joined to words that arrive later', async () => {
    const { app: a } = app();
    const chat = chatId();
    const shot = photo(chat);
    await intake(a, shot);
    await age('lifecycle_photo_held', shot.update_id, 6);
    const opened = await intake(a, message(chat, { text: BRIEF }));
    expect(opened).toMatchObject({ lifecycleAction: 'open-request' });
    expect(opened.draft.lifecycleImage).toBeUndefined();
    expect(opened.notice).toBeUndefined();
  });

  it('asked about once, a photo waits as long as an album with no words, and then joins the words', async () => {
    const { app: a } = app();
    const chat = chatId();
    const shot = photo(chat);
    await intake(a, shot);
    const asked = await settle(a, shot);
    expect(asked).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', chatAnswer: { text: MEDIA_MESSAGES.photoHeld.en } });
    expect(await settle(a, shot)).toMatchObject({ chatAnswer: { text: MEDIA_MESSAGES.photoHeld.en }, duplicate: true });
    await age('lifecycle_photo_held', shot.update_id, 30);
    const opened = await intake(a, message(chat, { text: BRIEF }));
    expect(opened.draft.lifecycleImage).toMatchObject({ sha256: sha(PNG) });
  });

  it('words first, photo second: the photo joins the request while its design has not started using pictures', async () => {
    const { app: a } = app();
    const chat = chatId();
    const opened = await intake(a, message(chat, { text: BRIEF }));
    expect((await project(a, opened)).status).toBe(200);
    const shot = photo(chat);
    expect(await intake(a, shot)).toMatchObject({ lifecycleAction: 'settle-later' });
    const joined = await settle(a, shot);
    expect(joined).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', requestId: opened.requestId,
      chatAnswer: { text: expect.stringContaining('Got the photo. I\'ve added it to') } });
    const [task] = await tasksInChat(chat);
    expect(await taskFiles(String(task.aggregate_id))).toEqual([{ sha256: sha(PNG), role: 'reference_image' }]);
    expect(await settle(a, shot)).toMatchObject({ duplicate: true, requestId: opened.requestId });
    expect(await taskFiles(String(task.aggregate_id))).toHaveLength(1);
  });

  it('words first, photo second, after the design moved on: the photo goes to the office as a note', async () => {
    const { app: a } = app();
    const chat = chatId();
    const opened = await intake(a, message(chat, { text: BRIEF }));
    expect((await project(a, opened)).status).toBe(200);
    await sql`UPDATE hawa.requests SET stage = 'in_review', rev = 2 WHERE request_id = ${opened.requestId}::uuid`.execute(owner);
    const shot = photo(chat);
    await intake(a, shot);
    const passed = await settle(a, shot);
    expect(passed).toMatchObject({ intakeStatus: 409, code: 'LATE_REQUESTER_CHANGE', lifecycleAction: 'late-change',
      requestId: opened.requestId, chatAnswer: { text: expect.stringContaining('so I\'ve passed the photo to the office') } });
    const [task] = await tasksInChat(chat);
    expect(await taskFiles(String(task.aggregate_id))).toHaveLength(0);
  });

  it('words first, photo more than five minutes later: the photo is asked about, not joined', async () => {
    const { app: a } = app();
    const chat = chatId();
    const words = message(chat, { text: BRIEF });
    const opened = await intake(a, words);
    expect((await project(a, opened)).status).toBe(200);
    await age('lifecycle_chat_open', words.update_id, 6);
    const shot = photo(chat);
    await intake(a, shot);
    expect(await settle(a, shot)).toMatchObject({ lifecycleAction: 'chat-answer', chatAnswer: { text: MEDIA_MESSAGES.photoHeld.en } });
    const [task] = await tasksInChat(chat);
    expect(await taskFiles(String(task.aggregate_id))).toHaveLength(0);
  });

  it('a captioned burst photo records its revision receipt before projection and replays after Core replacement', async () => {
    const { app: a, bridge } = app();
    const chat = chatId();
    const waiting = await seedRequest(chat, 'manual', 3);
    const shot = photo(chat, { caption: 'make the background blue like this photo' });
    expect(await intake(a, shot, { briefHold: true })).toMatchObject({ lifecycleAction: 'settle-later' });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
    bridge.downloadFile.mockRejectedValue(new Error('unexpected second download'));
    const cold = app({ telegramBridge: bridge }).app;
    const revised = await settle(cold, shot);
    expect(revised).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision', requestId: waiting.requestId });
    expect(await withRlsContext(db, scope, trx => readRevisionPhotoDecision(trx, tenantId, shot.update_id)))
      .toMatchObject({ requestId: waiting.requestId, chatId: String(chat), payloadHash: sha(Buffer.from(JSON.stringify(shot))),
        image: { sha256: sha(PNG) } });
    expect(await taskFiles(revised.newTaskId)).toEqual(expect.arrayContaining([{ sha256: sha(PNG), role: 'reference_image' }]));
    const replay = app({ telegramBridge: bridge }).app;
    expect(await settle(replay, shot)).toMatchObject({ duplicate: true, newTaskId: revised.newTaskId });
    expect(await settle(replay, { ...shot, message: { ...shot.message, caption: 'changed words' } }))
      .toMatchObject({ intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
  });

  it('a photo sent just before a change to a design that waits for it goes with the change', async () => {
    const { app: a } = app();
    const chat = chatId();
    const waiting = await seedRequest(chat, 'manual', 3);
    const shot = photo(chat);
    await intake(a, shot);
    const change = message(chat, { text: 'make the background blue like this photo' });
    const revised = await intake(a, change);
    expect(revised).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision', requestId: waiting.requestId,
      notice: { text: MEDIA_MESSAGES.photoUsedWithWords.en } });
    expect(await taskFiles(revised.newTaskId)).toEqual(expect.arrayContaining([{ sha256: sha(PNG), role: 'reference_image' }]));
    expect(await intake(a, change)).toMatchObject({ duplicate: true, newTaskId: revised.newTaskId });
    expect(await settle(a, shot)).toMatchObject({ settle: 'skipped', photo: 'revision' });
  });

  it.runIf(has('heif-convert', ['--version']) || process.platform === 'darwin')(
    'an iPhone HEIC photo sent as a file becomes a JPEG and opens its brief', async () => {
    const heic = await readFile(new URL('../../../packages/testkit/fixtures/media/photo-96x64.heic', import.meta.url));
    const { app: a, bridge } = app();
    bridge.downloadFile.mockResolvedValue(heic);
    const chat = chatId();
    const opened = await intake(a, message(chat, { caption: BRIEF,
      document: { file_id: 'iphone-heic', file_name: 'IMG_0001.HEIC', mime_type: 'image/heic', file_size: heic.length } }));
    expect(opened).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', draft: { lifecycleImage: { mediaType: 'image/jpeg' } } });
  });
});

describe('videos are explained, never parked', () => {
  it('a video with no words is answered in words, once', async () => {
    const { app: a } = app();
    const chat = chatId();
    const clip = message(chat, { video: { file_id: 'clip', duration: 4 } });
    const said = await intake(a, clip);
    expect(said).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', chatAnswer: { text: MEDIA_MESSAGES.videoNotUsed.en } });
    expect(await intake(a, clip)).toMatchObject({ duplicate: true, chatAnswer: { text: MEDIA_MESSAGES.videoNotUsed.en } });
    expect(await tasksInChat(chat)).toHaveLength(0);
  });

  it('a video with a brief: the words open the request and the video is explained beside it', async () => {
    const { app: a } = app();
    const chat = chatId();
    const opened = await intake(a, message(chat, { video_note: { file_id: 'round', length: 240, duration: 3 }, caption: BRIEF }));
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', notice: { text: MEDIA_MESSAGES.videoWordsUsed.en } });
  });

  it('answers a Sorani sender in Sorani', async () => {
    const { app: a } = app();
    const chat = chatId();
    // A GIF with a Sorani note that is not a brief ("thanks"): no design, and the answer is Sorani.
    const said = await intake(a, message(chat, { animation: { file_id: 'gif' } }));
    expect(said.chatAnswer.text).toBe(MEDIA_MESSAGES.videoNotUsed.en);
    const opened = await intake(a, message(chat, { video: { file_id: 'clip2' }, caption: 'پۆستەرێک بۆ ئاهەنگی نەورۆز\n---\nنەورۆز پیرۆز\nهەولێر' }));
    expect(opened.notice.text).toBe(MEDIA_MESSAGES.videoWordsUsed.ckb);
  });
});

describe('edited messages and captions (audit F11)', () => {
  it('an edit to a brief still held for photos changes the words it opens with', async () => {
    const { app: a } = app();
    const chat = chatId();
    const words = message(chat, { text: BRIEF });
    expect(await intake(a, words, { briefHold: true })).toMatchObject({ intakeStatus: 202, settle: { kind: 'brief' } });
    const edit = edited(words, { text: 'KAAE members evening\n---\nDecember 5, 2026\nErbil' });
    expect(await intake(a, edit, { briefHold: true })).toMatchObject({ lifecycleAction: 'chat-answer', chatAnswer: { text: MEDIA_MESSAGES.editApplied.en } });
    const opened = await settle(a, words);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request' });
    expect(opened.draft.rawText).toContain('December 5, 2026');
    expect(opened.draft.rawText).not.toContain('December 4, 2026');
  });

  it('an edit to a brief whose design started goes to the office as a note on that design', async () => {
    const { app: a } = app();
    const chat = chatId();
    const words = message(chat, { text: BRIEF });
    const opened = await intake(a, words);
    expect((await project(a, opened)).status).toBe(200);
    const edit = edited(words, { text: 'KAAE members evening\n---\nDecember 5, 2026\nErbil' });
    const noted = await intake(a, edit);
    expect(noted).toMatchObject({ intakeStatus: 409, code: 'LATE_REQUESTER_CHANGE', lifecycleAction: 'late-change',
      requestId: opened.requestId, requestStage: 'designing', chatAnswer: { text: expect.stringContaining('I saw your edit to') } });
    expect(noted.officeAlert.text).toContain('December 5, 2026');
    expect(await intake(a, edit)).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestId: opened.requestId });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('an edit to a message that opened nothing is read again as a new message', async () => {
    const { app: a } = app();
    const chat = chatId();
    const hello = message(chat, { text: 'hello' });
    expect(await intake(a, hello)).toMatchObject({ lifecycleAction: 'chat-answer' });
    const edit = edited(hello, { text: BRIEF });
    expect(await intake(a, edit)).toMatchObject({ lifecycleAction: 'open-request' });
    expect(await intake(a, edit)).toMatchObject({ lifecycleAction: 'open-request', duplicate: true });
  });

  it('a caption added to a kept photo makes it a photo brief, and the kept photo is not asked about', async () => {
    const { app: a } = app();
    const chat = chatId();
    const shot = photo(chat);
    await intake(a, shot);
    const edit = edited(shot, { caption: BRIEF });
    const opened = await intake(a, edit);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { lifecycleImage: { sha256: sha(PNG) } } });
    expect(await settle(a, shot)).toMatchObject({ settle: 'skipped' });
  });
});

describe('a message sent while its sender\'s brief waits for photos (ADR-143 with ADR-144)', () => {
  it('a correction is set behind the brief, then kept on it as a change, never a second request', async () => {
    const { app: a } = app();
    const chat = chatId();
    const words = message(chat, { text: BRIEF });
    expect(await intake(a, words, { briefHold: true })).toMatchObject({ intakeStatus: 202, settle: { kind: 'brief' } });
    const correction = message(chat, { text: 'the date should be 5 December not 4' });
    expect(await intake(a, correction, { briefHold: true })).toMatchObject({ intakeStatus: 202, lifecycleAction: 'settle-later',
      settle: { kind: 'brief' } });
    // Its settle while the brief still waits: again later.
    expect(await settle(a, correction)).toMatchObject({ intakeStatus: 202, lifecycleAction: 'settle-later' });
    const opened = await settle(a, words);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request' });
    // Before RequestLifecycle projects the open, the correction waits for it (ADR-144's rule)...
    expect(await settle(a, correction)).toMatchObject({ intakeStatus: 503, code: 'REQUEST_OPENING' });
    expect((await project(a, opened)).status).toBe(200);
    // ...then it is kept on that request for the office, and no second request opens.
    expect(await settle(a, correction)).toMatchObject({ intakeStatus: 409, lifecycleAction: 'late-change',
      requestId: opened.requestId, requestStage: 'designing' });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });
});

describe('a sender outside the intake list (audit N5)', () => {
  it('hears one polite line per chat per day, and nothing of theirs is kept or designed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TELEGRAM_INTAKE_ALLOWED_USERS', String(OFFICE));
    const { app: a } = app();
    const chat = chatId();
    const stranger = 55_000_001 + Math.floor(Math.random() * 1000);
    const first = await intake(a, message(chat, { text: BRIEF }, stranger));
    expect(first).toMatchObject({ intakeStatus: 403, code: 'SENDER_NOT_ALLOWED', lifecycleAction: 'chat-answer',
      chatAnswer: { text: ACCESS_MESSAGES.notAllowed.en } });
    const again = await intake(a, message(chat, { text: 'hello?' }, stranger));
    expect(again).toMatchObject({ intakeStatus: 403, code: 'SENDER_NOT_ALLOWED', quiet: true });
    expect(again.chatAnswer).toBeUndefined();
    const photoToo = await intake(a, photo(chat, { from: { id: stranger, is_bot: false, first_name: 'S' } }));
    expect(photoToo).toMatchObject({ intakeStatus: 403, quiet: true });
    expect(await tasksInChat(chat)).toHaveLength(0);
    // Only the rate limit's own row is kept: the chat, the day and the update, no words.
    const rows = (await sql<{ source_account_id: string; payload: Record<string, unknown> }>`SELECT source_account_id, payload
      FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND (payload->>'chatId' = ${String(chat)}
        OR source_event_id LIKE ${`${chat}:%`} OR payload::text LIKE ${`%${chat}%`})`.execute(owner)).rows;
    expect(rows.map((r) => r.source_account_id)).toEqual(['lifecycle_unlisted_reply']);
    expect(Object.keys(rows[0].payload).sort()).toEqual(['lang', 'updateId']);
    // A Sorani stranger in another chat is answered in Sorani.
    const other = await intake(a, message(chatId(), { text: 'سڵاو، پۆستەرێکم دەوێت' }, stranger));
    expect(other.chatAnswer.text).toBe(ACCESS_MESSAGES.notAllowed.ckb);
  });
});
