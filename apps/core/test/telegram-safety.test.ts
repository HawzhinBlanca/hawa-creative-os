import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql, withRlsContext, RevisionRepository } from '@hawa/db';
import { computeActionSignature, TelegramBridgeDaemon } from '@hawa/integrations';
import { createApp, evaluateCanvaExportQc } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { resolveQcProfileId } from '../src/services/canva-task-outcome.js';
import { PostgresTelegramPollState, telegramBotKey } from '../src/services/telegram-poll-state.js';
import { PARKED_UPDATE_NOTICE, POLLED_UPDATE_MAX_ATTEMPTS } from '../src/services/polled-update-dispatch.js';
import { memoryExportStore } from './pinned-exports-fixture.js';
import { checkedCanvaExportFixture } from '../../../packages/testkit/src/canva-export-fixture.js';

/**
 * Telegram safety (architecture programme 0.4, 2026-09-24), against hawa-test-postgres as hawa_app
 * (row-level security as in production): the getUpdates offset lives in Postgres and never moves
 * past an update intake did not accept; a poll takes the poller's turn; the kill switch stops
 * intake at the poller and at the webhook; the handlers that deliver, publish and decide read the
 * task's status from Postgres; delivery ignores an approval only Core's memory holds.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const operatorUserId = '00000000-0000-4000-b000-000000000001';
const kaae = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
const OFFICE = 91000004;
const admin = { 'Content-Type': 'application/json', Authorization: 'Bearer test_admin_key' };
const operator = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
const artDirector = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_ART_DIRECTOR_KEY}` };

const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  // The test database keeps every run's tasks of the day, so the daily cap on automatic drafts is
  // reached by the tests themselves; it is not what these tests are about.
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(async () => {
  vi.restoreAllMocks();
  // The kill switch is one switch per Core process, shared by every app built in this file.
  await createApp({ db } as any).request('/v1/operations/kill-switch', { method: 'POST', headers: { ...operator, Authorization: 'Bearer test_admin_key' }, body: JSON.stringify({ channel: 'telegram', active: false }) });
  delete process.env.TELEGRAM_BOT_TOKEN;
});
afterAll(async () => {
  process.env = saved;
  await db.destroy();
});

const chatId = () => 60_000_000 + Math.floor(Math.random() * 9_000_000);
const updateBase = () => 1_000_000_000 + Math.floor(Math.random() * 900_000_000);
/** A fresh bot per test: the offset is per bot, and every run shares the test database. */
const useFreshBot = () => {
  const botId = String(700_000_000 + Math.floor(Math.random() * 99_999_999));
  process.env.TELEGRAM_BOT_TOKEN = [botId, ['fixture', 'bot', 'secret'].join('_')].join(':');
  return new PostgresTelegramPollState(db, { tenantId, userId: operatorUserId }, telegramBotKey(process.env.TELEGRAM_BOT_TOKEN));
};

const brief = (updateId: number, chat: number) => ({
  update_id: updateId,
  message: { message_id: updateId % 100000, from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' }, date: 1790000000, text: 'KAAE members evening\n---\nDecember 4, 2026\nErbil' },
});
const photo = (updateId: number, chat: number) => ({
  update_id: updateId,
  message: {
    message_id: updateId % 100000, from: { id: 5550001, is_bot: false, first_name: 'Requester' }, chat: { id: chat, type: 'private' }, date: 1790000000,
    caption: 'KAAE poster, secret words\n---\nMay 5, 2027', photo: [{ file_id: 'p1', file_unique_id: 'u1', width: 800, height: 800 }],
  },
});

/**
 * Telegram's Bot API as the bridge sees it: getUpdates serves `pending` from the requested offset
 * (or ignores it, as a Telegram that hands an update back does), getFile fails until a picture is
 * available, sendMessage succeeds. Anything else goes to the real fetch, as in the other suites.
 */
function fakeTelegram(pending: any[], opts: { ignoreOffset?: boolean } = {}) {
  const realFetch = globalThis.fetch;
  const offsets: number[] = [];
  const sent: Array<{ chat_id: string | number; text: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
    if (url.includes('/getUpdates')) {
      const offset = Number(new URL(url).searchParams.get('offset'));
      offsets.push(offset);
      return Response.json({ ok: true, result: opts.ignoreOffset ? pending : pending.filter((u) => u.update_id >= offset) });
    }
    if (url.includes('/getFile')) return new Response('Bad Gateway', { status: 502 });
    if (url.includes('/sendMessage')) {
      const body = JSON.parse(String(init?.body || '{}'));
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: 1 + sent.length, chat: { id: body.chat_id } } });
    }
    return Response.json({ ok: true, result: true });
  });
  return { offsets, sent, getUpdatesCalls: () => offsets.length };
}

const tasksInChat = async (chat: number) =>
  (await withRlsContext(db, scope, (trx) =>
    trx.selectFrom('outbox_commands').select(['aggregate_id', 'payload']).where('command_type', '=', 'task.created').execute()
  )).filter((r: any) => String(r.payload?.sourceChannelId) === String(chat));

/**
 * Core's own poller, until stage 2 of ADR-135 deletes it. Since ADR-135 no configuration starts it and
 * "poll now" is refused (lifecycle-only-telegram.test.ts), so these tests drive the bridge Core wires
 * the handler, offset store and kill switch into, one poll at a time, as the loop did.
 */
const bridges = new WeakMap<object, TelegramBridgeDaemon>();
const pollingCore = () => {
  const bridge = new TelegramBridgeDaemon({ botToken: process.env.TELEGRAM_BOT_TOKEN,
    secretToken: process.env.TELEGRAM_WEBHOOK_SECRET || '', allowedUserIds: [String(OFFICE)] });
  const app = createApp({ db, telegramBridge: bridge } as any);
  bridges.set(app, bridge);
  return app;
};
const pollNow = async (app: any) => ({ body: { updatesProcessed: await bridges.get(app)!.pollOnce() } });

describe('the getUpdates offset (Postgres, per bot)', () => {
  it('a 5xx on one update never advances past it; after five attempts, across a restart, it is dead-lettered by id, the office alerted, and the queue moves on', async () => {
    const state = useFreshBot();
    const base = updateBase();
    const [chatA, chatB, chatC] = [chatId(), chatId(), chatId()];
    const telegram = fakeTelegram([brief(base, chatA), photo(base + 1, chatB), brief(base + 2, chatC)]);

    const first = pollingCore();
    expect((await pollNow(first)).body.updatesProcessed).toBe(1);
    expect(await tasksInChat(chatA)).toHaveLength(1);
    expect(await state.getOffset()).toBe(base);
    await pollNow(first);
    expect(await state.getOffset()).toBe(base);
    expect(await tasksInChat(chatC)).toHaveLength(0);
    expect(await state.failing()).toMatchObject({ updateId: base + 1, attempts: 2 });

    // Core restarts: the new process asks Telegram from the stored offset and keeps counting.
    const restarted = pollingCore();
    for (let attempt = 3; attempt < POLLED_UPDATE_MAX_ATTEMPTS; attempt++) {
      expect((await pollNow(restarted)).body.updatesProcessed).toBe(0);
      expect(await state.getOffset()).toBe(base);
      expect(await tasksInChat(chatC)).toHaveLength(0);
    }
    expect(await state.failing()).toMatchObject({ updateId: base + 1, attempts: POLLED_UPDATE_MAX_ATTEMPTS - 1 });
    expect(telegram.offsets).toEqual([1, ...Array(POLLED_UPDATE_MAX_ATTEMPTS - 2).fill(base + 1)]);

    // The last attempt: dead-lettered, then the update behind it is handled in the same poll.
    expect((await pollNow(restarted)).body.updatesProcessed).toBe(2);
    expect(await state.getOffset()).toBe(base + 2);
    expect(await state.failing()).toBeNull();
    expect(await tasksInChat(chatC)).toHaveLength(1);

    const parked = await withRlsContext(db, scope, async (trx) =>
      (await sql<any>`SELECT payload, processing_error FROM hawa.inbox_events
        WHERE source_account_id = 'telegram' AND source_event_id = ${`parked-update-${base + 1}`}`.execute(trx)).rows);
    expect(parked).toHaveLength(1);
    expect(parked[0].payload).toEqual({ update_id: base + 1, kind: 'message' });
    expect(parked[0].processing_error).toMatch(/HTTP 503 after 5 attempts/);

    const alerts = await withRlsContext(db, scope, async (trx) =>
      (await sql<any>`SELECT payload FROM hawa.outbox_commands
        WHERE command_type = 'notify.telegram' AND idempotency_key = ${`notify.office:telegram-update-parked:${base + 1}`}`.execute(trx)).rows);
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0].payload.chatId)).toBe(String(OFFICE));
    expect(alerts[0].payload.message.text).toContain(`Update ${base + 1} (message) from chat ${chatB}`);
    expect(JSON.stringify(alerts[0].payload)).not.toContain('secret words');
    expect(telegram.sent.filter((m) => String(m.chat_id) === String(chatB)).map((m) => m.text)).toContain(PARKED_UPDATE_NOTICE);
  });

  it('the same update delivered twice creates one task, and a restart asks Telegram from after it', async () => {
    const state = useFreshBot();
    const base = updateBase();
    const chat = chatId();
    const telegram = fakeTelegram([brief(base, chat)], { ignoreOffset: true });

    const app = pollingCore();
    expect((await pollNow(app)).body.updatesProcessed).toBe(1);
    // Telegram hands the same update back (it ignores the offset here).
    expect((await pollNow(app)).body.updatesProcessed).toBe(1);
    const restarted = pollingCore();
    expect((await pollNow(restarted)).body.updatesProcessed).toBe(1);

    expect(await tasksInChat(chat)).toHaveLength(1);
    expect(await state.getOffset()).toBe(base);
    expect(telegram.offsets).toEqual([1, base + 1, base + 1]);
  });
});

describe('the Telegram kill switch stops intake', () => {
  const killSwitch = (app: any, active: boolean) =>
    app.request('/v1/operations/kill-switch', { method: 'POST', headers: { ...operator, Authorization: 'Bearer test_admin_key' }, body: JSON.stringify({ channel: 'telegram', active }) });

  it('at the poller: nothing is asked of Telegram until it is switched off', async () => {
    useFreshBot();
    const chat = chatId();
    const telegram = fakeTelegram([brief(updateBase(), chat)]);
    const app = pollingCore();
    expect((await killSwitch(app, true)).status).toBe(200);

    const manual = await pollNow(app);
    expect(manual.body.updatesProcessed).toBe(0);
    expect(telegram.getUpdatesCalls()).toBe(0);
    expect(await tasksInChat(chat)).toHaveLength(0);

    expect((await killSwitch(app, false)).status).toBe(200);
    expect((await pollNow(app)).body.updatesProcessed).toBe(1);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('at the webhook: refused with 503, as the WhatsApp kill switch refuses, and nothing is started', async () => {
    const chat = chatId();
    const app = createApp({ db } as any);
    await killSwitch(app, true);
    const post = () => app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! },
      body: JSON.stringify(brief(updateBase(), chat)),
    });
    const refused = await post();
    expect(refused.status).toBe(503);
    expect((await refused.json()).title).toBe('Service Unavailable');
    expect(await tasksInChat(chat)).toHaveLength(0);

    await killSwitch(app, false);
    expect((await post()).status).toBe(201);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });
});

describe('handlers that act on a task read its status from Postgres', () => {
  const request = async (title: string) =>
    (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: String(chatId()),
        clientId: kaae,
        title,
        rawText: 'KAAE members evening\n---\nDecember 4, 2026\nErbil',
        designInstructions: '',
        exactCopy: [{ id: 'copy_0', role: 'headline', text: 'KAAE members evening' }],
        autoGenerate: false,
      } as any)
    ).task.id as string;

  /** A Canva draft as the bridge records it: a revision and a passing QC run. */
  const draft = async (taskId: string, headline = 'KAAE members evening') => {
    const checked = await checkedCanvaExportFixture(headline);
    return withRlsContext(db, scope, async (trx) => {
      const revision = await new RevisionRepository(db).createRevision(
        {
          tenantId, taskId, studio: 'canva',
          neutralManifest: { documentId: `DAGsafe${taskId.slice(0, 6)}`, studio: 'canva', width: 1200, height: 1697, nodes: [{ id: 'headline', type: 'text', text: headline }] },
          authorType: 'model', authorId: 'canva_generator', status: 'review',
        } as any,
        trx
      );
      const qc = evaluateCanvaExportQc({
        sha256: createHash('sha256').update(checked.bytes).digest('hex'), format: 'pptx',
        content: checked.bytes, content_check: checked.contentCheck,
      });
      await trx.insertInto('qc_runs').values({
        tenant_id: tenantId, task_id: taskId, design_revision_id: revision.id, qc_profile_id: await resolveQcProfileId(trx, tenantId),
        status: qc.status, critical_pass: qc.criticalPass, report: qc.qaReport as any,
        report_sha256: createHash('sha256').update(JSON.stringify(qc.qaReport)).digest('hex'),
      }).execute();
      return revision.id as string;
    });
  };

  const decide = (app: any, taskId: string, revisionId: string, body: Record<string, unknown>) =>
    app.request(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, { method: 'POST', headers: artDirector, body: JSON.stringify(body) });
  const sendBack = (app: any, taskId: string, revisionId: string) =>
    decide(app, taskId, revisionId, { action: 'revision_requested', revisionRequest: { comment: 'The date is wrong' } });
  const dbTask = async (taskId: string) =>
    withRlsContext(db, scope, async (trx) => (await sql<any>`SELECT state, version FROM hawa.tasks WHERE id = ${taskId}::uuid`.execute(trx)).rows[0]);

  it('publish: a task another process sent back for changes is not delivered by the Core that approved it', async () => {
    const taskId = await request('KAAE: stale status (publish)');
    const revisionId = await draft(taskId);
    const exports = memoryExportStore();
    const coreA = createApp({ db, deliverableStore: exports.store } as any);
    const coreB = createApp({ db, deliverableStore: exports.store } as any);
    expect((await decide(coreA, taskId, revisionId, { action: 'approve', pinnedExportIds: [exports.add(taskId)] })).status).toBe(201);
    expect((await sendBack(coreB, taskId, revisionId)).status).toBe(201);
    expect((await dbTask(taskId)).state).toBe('revision_requested');

    const res = await coreA.request(`/v1/tasks/${taskId}/publish`, { method: 'POST', headers: operator, body: JSON.stringify({}) });
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.title).toBe('Cannot Publish Unapproved Task');
    expect(body.detail).toContain("'revision_requested'");
  });

  it('approve: a draft recorded behind Core\'s back is the current one, and the one checked', async () => {
    const taskId = await request('KAAE: stale status (approve)');
    const first = await draft(taskId);
    const exports = memoryExportStore();
    const core = createApp({ db, deliverableStore: exports.store } as any);
    // Core reads the task (an answer it refuses still loads it into Core's memory).
    expect((await decide(core, taskId, first, { action: 'nonsense' })).status).toBe(400);
    // The worker records the next draft in Postgres; Core's copy still names the first.
    const second = await draft(taskId, 'KAAE members evening, corrected');

    const approved = await decide(core, taskId, second, { action: 'approve', pinnedExportIds: [exports.add(taskId)] });
    const body = await approved.json();
    expect(`${approved.status} ${body.detail || ''}`).not.toMatch(/Cannot approve stale revision/);
    expect(approved.status).toBe(201);
    expect((await dbTask(taskId)).state).toBe('approved');
    // And the first draft, which Postgres knows is no longer current, is refused as stale.
    const stale = await decide(core, taskId, first, { action: 'approve' });
    expect(stale.status).toBe(409);
  });

  it('delivery: with Postgres unreachable, delivery refuses instead of acting on the status in memory', async () => {
    const taskId = await request('KAAE: stale status (delivery)');
    const revisionId = await draft(taskId);
    const exports = memoryExportStore();
    const exportId = exports.add(taskId, 'png', new TextEncoder().encode('approved KAAE export'));
    const coreDb = createDb(process.env.TEST_DATABASE_URL!);
    const core = createApp({ db: coreDb, deliverableStore: exports.store } as any);
    expect((await decide(core, taskId, revisionId, { action: 'approve', pinnedExportIds: [exportId] })).status).toBe(201);
    const read = vi.spyOn(exports.store, 'read');
    await coreDb.destroy();

    // A signed WhatsApp approve-and-publish reads the task from Postgres before it acts (Core keeps
    // no copy of it since the cleanup step of the app.ts split), so that read refuses first.
    const sig = computeActionSignature(taskId, 'approve');
    const res = await core.request(`/api/webhooks/whatsapp/actions?taskId=${taskId}&action=approve&sig=${sig}&publish=true`);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.detail).toMatch(/could not be read from the database/);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('delivery ignores an approval that exists only in Core\'s memory', () => {
  it('a memory-only approval cannot trigger delivery', async () => {
    const taskId = (
      await persistChatIntake(db, {
        platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: String(chatId()), clientId: kaae,
        title: 'KAAE: memory-only approval', rawText: 'KAAE members evening\n---\nDecember 4, 2026\nErbil', designInstructions: '',
        exactCopy: [{ id: 'copy_0', role: 'headline', text: 'KAAE members evening' }], autoGenerate: false,
      } as any)
    ).task.id as string;
    const checked = await checkedCanvaExportFixture('KAAE members evening');
    const revisionId = await withRlsContext(db, scope, async (trx) => {
      const revision = await new RevisionRepository(db).createRevision({
        tenantId, taskId, studio: 'canva',
        neutralManifest: { documentId: `DAGmem${taskId.slice(0, 6)}`, studio: 'canva', width: 1200, height: 1697, nodes: [{ id: 'headline', type: 'text', text: 'KAAE members evening' }] },
        authorType: 'model', authorId: 'canva_generator', status: 'review',
      } as any, trx);
      const qc = evaluateCanvaExportQc({ sha256: createHash('sha256').update(checked.bytes).digest('hex'), format: 'pptx', content: checked.bytes, content_check: checked.contentCheck });
      await trx.insertInto('qc_runs').values({
        tenant_id: tenantId, task_id: taskId, design_revision_id: revision.id, qc_profile_id: await resolveQcProfileId(trx, tenantId),
        status: qc.status, critical_pass: qc.criticalPass, report: qc.qaReport as any,
        report_sha256: createHash('sha256').update(JSON.stringify(qc.qaReport)).digest('hex'),
      }).execute();
      return revision.id as string;
    });
    const exports = memoryExportStore();
    const exportId = exports.add(taskId, 'png', new TextEncoder().encode('approved KAAE export'));
    const core = createApp({ db, deliverableStore: exports.store } as any);
    const approved = await core.request(`/v1/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST', headers: artDirector, body: JSON.stringify({ action: 'approve', pinnedExportIds: [exportId] }),
    });
    expect(approved.status).toBe(201);

    // The approval Postgres holds is taken away, as if its write had never committed; Core's memory
    // still has it. (The table is append-only, so the owner lifts its triggers for this one statement.)
    const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
    try {
      const removed = await owner.transaction().execute(async (trx) => {
        await sql`SET LOCAL session_replication_role = 'replica'`.execute(trx);
        return sql`DELETE FROM hawa.approvals WHERE task_id = ${taskId}::uuid`.execute(trx);
      });
      expect(Number(removed.numAffectedRows)).toBe(1);
    } finally {
      await owner.destroy();
    }
    const read = vi.spyOn(exports.store, 'read');

    const res = await core.request(`/v1/tasks/${taskId}/publish`, { method: 'POST', headers: operator, body: JSON.stringify({}) });
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.detail).toBe('Nothing to deliver: the task has no approval. Approve in the Desk with the captured export selected.');
    expect(read).not.toHaveBeenCalled();
  });
});
