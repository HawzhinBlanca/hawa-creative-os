/**
 * ADR-240: the nightly live canary, played end to end against this checkout's real Telegram path.
 *
 * scripts/live_canary_lib.ts's `runCanary` drives a CanaryWorld backed by the conversation harness
 * (fixtures/conversation-harness.ts): every line goes through the worker's ChatInbox, Core's intake on
 * the test database, RequestLifecycle and the worker's own TelegramSender, configured as production
 * configures it (HAWA_CANARY_CHAT_ID). What the sink recorded is read from the marks it wrote; anything
 * the fake Telegram was asked to send is a message that left, and is reported as sent.
 *
 * Fails before ADR-240: without the sink every reply to the canary chat is sent, and the canary stops at
 * its first check; office alerts about its requests reach the office members.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql } from '@hawa/db';
import { ConversationHarness, KAAE, type Person } from './fixtures/conversation-harness.js';
import { runCanary, type BotMessage, type CanaryConfig, type CanaryWorld } from '../../../scripts/live_canary_lib.js';
import { canaryAutomaticDesignsPerWeek } from '../src/services/chat-intake.js';
import { parkTelegramUpdate } from '../src/services/polled-update-dispatch.js';

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const WORKER = ['live', 'canary', 'worker', 'fixture'].join('_');
const KAAE_TENANT = '00000000-0000-4000-a000-000000000001';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await db.destroy(); await owner.destroy(); });

let seed = 4_503_599_700_000_000 + Math.floor(Math.random() * 90_000) * 10;
const config = (chatId: string): CanaryConfig => ({ chatId, clientId: KAAE, clientName: 'KAAE', maxUsd: 0.5,
  replyTimeoutMs: 30_000, quietMs: 3000, draftTimeoutMs: 10 * 60_000 });

/** The harness as the canary's world. Virtual time; a started design gets its draft a minute later. */
function harnessWorld(h: ConversationHarness, chatId: string, canary: Person, office: Person[]): { world: CanaryWorld; sent: () => BotMessage[] } {
  let now = Date.UTC(2026, 9, 2, 0, 30);
  const stamped = new Map<string, BotMessage>();
  // This conversation's chats only: the database is shared by the file's tests.
  const ours = new Set([chatId, ...office.map((p) => String(p.id))]);
  const drafted = new Set<string>();
  const designClock = new Map<string, number>();
  const collect = async (): Promise<BotMessage[]> => {
    const rows = (await sql<{ id: string; source_event_id: string; payload: Record<string, any> }>`SELECT id::text, source_event_id, payload
      FROM hawa.inbox_events WHERE source_account_id = 'telegram_delivery' AND event_kind LIKE 'telegram_%_canary_sink' ORDER BY id`
      .execute(owner)).rows;
    for (const row of rows) {
      const id = `sink:${row.id}`;
      if (stamped.has(id) || !ours.has(String(row.payload.chatId))) continue;
      stamped.set(id, { invocationId: id, chatId: String(row.payload.chatId), createdAtMs: now, key: String(row.payload.commandId).replace(/^lc:/, ''),
        kind: String(row.payload.kind), text: String(row.payload.text ?? row.payload.caption ?? ''), outcome: 'canary_sink',
        ...(row.payload.canaryFor ? { canaryFor: String(row.payload.canaryFor) } : {}) });
    }
    h.t.sent.forEach((s, i) => {
      const id = `sent:${i}`;
      if (!stamped.has(id)) stamped.set(id, { invocationId: id, chatId: s.chatId, createdAtMs: now, key: s.key, kind: s.kind, text: s.text, outcome: 'sent' });
    });
    return [...stamped.values()];
  };
  /** Stands in for the DesignRun: a minute after a round starts its draft is ready (harness draftReady). */
  const designs = async () => {
    for (const d of h.t.designs) {
      if (d.refused || drafted.has(d.taskId)) continue;
      const started = designClock.get(d.taskId) ?? now;
      designClock.set(d.taskId, started);
      const current = (await h.requests(chatId)).find((r) => r.requestId === d.requestId);
      if (current?.stage !== 'designing' || current.taskId !== d.taskId) { drafted.add(d.taskId); continue; }
      if (now - started >= 60_000) { drafted.add(d.taskId); await h.draftReady(d.requestId, 1000); }
    }
  };
  const world: CanaryWorld = {
    now: () => now,
    // Restate's delayed calls (a held brief's settle, ADR-143) fall due as the harness's clock moves.
    sleep: async (ms) => { now += ms; await h.wait(ms); await designs(); },
    health: async () => null,
    send: async (_updateId, _messageId, text) => { now += 1000; await h.post(chatId, canary, 'text', { text }, 1000); await collect(); },
    inboxDone: async () => true,
    botMessages: async (since) => (await collect()).filter((m) => m.createdAtMs >= since),
    canaryRequests: async () => (await h.requests(chatId)).map((r) => ({ ...r, chatId })),
    openDraft: async (requestId) => {
      const d = h.t.opened.find((o) => o.requestId === requestId)?.draft;
      return d ? { clientId: d.clientId ?? null, title: String(d.title), rawText: String(d.rawText), exactCopy: d.exactCopy ?? [],
        ...(d.headlineEn ? { headlineEn: d.headlineEn } : {}) } : null;
    },
    designSpend: async () => 0.07,
  };
  return { world, sent: () => [...stamped.values()].filter((m) => m.outcome === 'sent') };
}

function setUp(canaryChat: string) {
  seed += 10;
  const office: Person[] = [{ id: 93_000_000 + (seed % 1_000_000), name: 'Office A' }, { id: 94_000_000 + (seed % 1_000_000), name: 'Office B' }];
  const h = new ConversationHarness({ db, owner, office, workerToken: WORKER });
  const canary: Person = { id: Number(canaryChat), name: 'Canary' };
  const chatId = h.chat('private', Number(canaryChat));
  return { h, office, canary, chatId, ...harnessWorld(h, chatId, canary, office) };
}

describe('the nightly live canary through the real Telegram path (ADR-240)', () => {
  it('a night without a paid round: every turn is judged, nothing is sent, nothing reaches the office, every request ends withdrawn', async () => {
    const chat = String(seed);
    const { h, office, chatId, world, sent } = setUp(chat);
    vi.stubEnv('HAWA_CANARY_CHAT_ID', chat);
    await h.emptyOfficeQueue();
    const result = await runCanary(world, config(chat));
    const failed = result.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(result).toMatchObject({ status: 'passed', mode: 'stub', spentUsd: null });
    // Nothing went to Telegram: not the canary's replies, not a single office alert.
    expect(sent()).toEqual([]);
    for (const member of office) expect(h.said(String(member.id))).toEqual([]);
    // No design round was started, so nothing could be paid for.
    expect(h.t.designs).toEqual([]);
    // Three requests tonight, each withdrawn; the third was opened by the answer to "who is this for?".
    const requests = await h.requests(chatId);
    expect(requests.map((r) => r.stage)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(result.requests.every((r) => r.openedThisRun && r.stage === 'cancelled')).toBe(true);
    // ADR-240's marker: the tasks are the canary's, so the Desk and reports can leave them out.
    const marked = (await sql<{ canary: boolean | null }>`SELECT (o.payload->>'canary')::boolean AS canary FROM hawa.outbox_commands o
      JOIN hawa.tasks t ON t.id = o.aggregate_id AND o.command_type = 'task.created' JOIN hawa.requests r ON r.root_task_id = t.id
      WHERE r.chat_id = ${chatId}`.execute(owner)).rows;
    expect(marked.map((m) => m.canary)).toEqual([true, true, true]);
  });

  it('a paid night: one real round, the change waits for the office instead of a second round, and the draft is withdrawn', async () => {
    const chat = String(seed + 3);
    const { h, chatId, world, sent } = setUp(chat);
    vi.stubEnv('HAWA_CANARY_CHAT_ID', chat);
    vi.stubEnv('HAWA_CANARY_AUTOMATIC_DESIGNS_PER_WEEK', '1');
    await h.emptyOfficeQueue();
    const result = await runCanary(world, config(chat));
    const failed = result.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(result).toMatchObject({ status: 'passed', mode: 'paid', spentUsd: 0.07 });
    // Exactly one design round in the whole night, and it was the first brief's.
    expect(h.t.designs).toHaveLength(1);
    const [first] = await h.requests(chatId);
    expect(h.t.designs[0].requestId).toBe(first.requestId);
    expect(sent()).toEqual([]);
    expect((await h.requests(chatId)).every((r) => r.stage === 'cancelled')).toBe(true);
  });

  it('without the sink configured, the canary stops after "hi" and opens nothing', async () => {
    const chat = String(seed + 5);
    const { h, chatId, world, sent } = setUp(chat);
    const result = await runCanary(world, config(chat));
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/replies to the canary chat are recorded, never sent/);
    expect(sent().map((m) => m.chatId)).toEqual([chatId]);
    expect(await h.requests(chatId)).toEqual([]);
  });

  it('a real chat id as HAWA_CANARY_CHAT_ID configures no sink: the owner\'s chat can never be sunk', async () => {
    const chat = String(seed + 7);
    const { world, sent } = setUp(chat);
    vi.stubEnv('HAWA_CANARY_CHAT_ID', '7191500129');
    const result = await runCanary(world, config(chat));
    expect(result.status).toBe('failed');
    expect(sent().length).toBeGreaterThan(0);
    expect(sent().every((m) => m.outcome === 'sent')).toBe(true);
  });
});

describe('the canary\'s allowance and its office alerts in Core (ADR-240)', () => {
  it('HAWA_CANARY_AUTOMATIC_DESIGNS_PER_WEEK is a whole number from 0 to 7; anything else is 0 (no paid round)', () => {
    expect(canaryAutomaticDesignsPerWeek({})).toBe(0);
    expect(canaryAutomaticDesignsPerWeek({ HAWA_CANARY_AUTOMATIC_DESIGNS_PER_WEEK: '' })).toBe(0);
    expect(canaryAutomaticDesignsPerWeek({ HAWA_CANARY_AUTOMATIC_DESIGNS_PER_WEEK: ' 1 ' })).toBe(1);
    expect(canaryAutomaticDesignsPerWeek({ HAWA_CANARY_AUTOMATIC_DESIGNS_PER_WEEK: '7' })).toBe(7);
    for (const bad of ['8', '-1', '1.5', 'one', '1 a week']) expect(canaryAutomaticDesignsPerWeek({ HAWA_CANARY_AUTOMATIC_DESIGNS_PER_WEEK: bad })).toBe(0);
  });

  it('an update of the canary chat that intake could not take is parked with no office alert; any other chat\'s alerts the office', async () => {
    const identity = { tenantId: KAAE_TENANT, userId: '00000000-0000-4000-b000-000000000001' };
    const update = (chat: number, id: number) => ({ update_id: id, message: { message_id: 1, date: 1, chat: { id: chat, type: 'private' }, from: { id: chat }, text: 'hi' } });
    const canaryUpdate = 9_000_000_000_000 + Math.floor(Math.random() * 1_000_000);
    await parkTelegramUpdate(db, identity, update(Number(String(seed + 9)), canaryUpdate) as any, 'test', { officeChatIds: ['9000001'] });
    await parkTelegramUpdate(db, identity, update(71_000_001, canaryUpdate + 1) as any, 'test', { officeChatIds: ['9000001'] });
    const alerts = (await sql<{ idempotency_key: string }>`SELECT idempotency_key FROM hawa.outbox_commands
      WHERE idempotency_key LIKE ${'notify.office:telegram-update-parked:%'} AND idempotency_key LIKE ${`%${String(canaryUpdate).slice(0, 10)}%`}`.execute(owner)).rows;
    expect(alerts.map((a) => a.idempotency_key)).toEqual([`notify.office:telegram-update-parked:${canaryUpdate + 1}`]);
  });
});
