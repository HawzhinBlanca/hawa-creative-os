/**
 * ADR-230: a request is withdrawn by its requester's cancel or the office's Cancel in the Desk.
 *
 * Live test 2026-10-01 (L1): request 3a4c6ac4 was opened by mistake. "cancel the last request" got "OK.
 * I've asked the office to cancel …" and closed nothing; the Desk's Cancel answered 409 LIFECYCLE_OWNED;
 * RequestLifecycle had no transition to close it. Nobody could close the request, and later words
 * bound to it.
 *
 * The whole chain runs here as production runs it, against the per-file test database as hawa_app:
 * Core's intake decides, RequestLifecycle's `withdraw` (the worker's own code) calls Core's projection
 * through its internal route, and its notices are what TelegramSender would send. The Desk's Cancel goes
 * through the signed office gateway's check to the same object.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import type { OutboundMessage } from '@hawa/contracts';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { pendingLateChanges } from '../src/services/lifecycle-chat-target.js';
import { checkSignedOfficeWithdraw } from '../../worker/src/lifecycle/office-decision-gateway.js';
import { recordDesignFinished, recordWithdraw, type AutomaticLifecycleState, type AutomaticOpenContext,
  type LifecycleState, type ManualLifecycleState, type WithdrawEvent } from '../../worker/src/lifecycle/request-lifecycle.js';
import type { DesignRunInput } from '../../worker/src/lifecycle/design-run.js';
import { coreInternalFromEnv } from '../../worker/src/lifecycle/delivery.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const operatorUserId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
const OFFICE = 91000017;
const REQUESTER = 91000117;
const WORKER = ['worker', 'withdraw', 'fixture', 'token'].join('_');
const ingress = 'http://restate.withdraw-fixture:8080';
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.HAWA_WORKER_TOKEN = WORKER;
  process.env.RESTATE_INGRESS_URL = ingress;
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { process.env = saved; await db.destroy(); });

const chatId = () => 66_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_300_000_000 + Math.floor(Math.random() * 600_000_000);
const message = (chat: number, text: string, fields: Record<string, unknown> = {}) => {
  const id = updateId();
  return { update_id: id, message: { message_id: id % 100000, from: { id: REQUESTER, is_bot: false, first_name: 'Sewa' },
    chat: { id: chat, type: 'private' }, date: 1790000000, text, ...fields } };
};
const app = () => createApp({ db, requesterIntentModel: null } as any);
const intake = async (update: unknown) => {
  const res = await app().request('/v1/internal/telegram/intake', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` },
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) });
  return (await res.json()) as Record<string, any>;
};

/** A lifecycle request of the chat at a stage, as Core holds it, and RequestLifecycle's state for it. */
async function seed(chat: number, stage: string, rev: number, title = 'KAAE members evening', auto = true) {
  const requestId = randomUUID();
  const brief = { update_id: updateId(), message: { message_id: 500 + Math.floor(Math.random() * 1000),
    from: { id: REQUESTER, is_bot: false, first_name: 'Sewa' }, chat: { id: chat, type: 'private' }, date: 1790000000, text: title } };
  const created = await persistChatIntake(db, {
    platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: String(chat), rawJson: brief,
    rawText: title, title, clientId, designInstructions: 'Make the event design', exactCopy: [{ text: 'December 4, 2026' }],
    autoGenerate: auto, designStudio: auto,
  }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id)
      VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, null, 'restate', ${stage}, ${rev}, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  const base = { v: 1 as const, requestId, tenantId, chatId: String(chat), owner: 'restate' as const, taskId,
    openEventId: `open:${requestId}`, openSha256: 'a'.repeat(64), lang: 'en' as const, title };
  const runId = `dr-${taskId}`;
  const designInput: DesignRunInput = { v: 1, lifecycle: { requestId, round: 0, runId }, taskId, tenantId, clientId,
    rawText: title, sourcePlatform: 'telegram', idempotencyKey: `lifecycle:${requestId}:${taskId}`, canvaAutoGenerate: true, designStudio: true };
  const state: LifecycleState = auto
    ? { ...base, stage: stage as AutomaticLifecycleState['stage'], rev, runId, designInput } as AutomaticLifecycleState
    : { ...base, stage: 'manual', rev } as ManualLifecycleState;
  return { requestId, taskId, state };
}

/** RequestLifecycle, in memory, with Core reached through its own internal routes. */
function requestObject(initial: LifecycleState) {
  let state: LifecycleState | null = initial;
  const sent: OutboundMessage[] = [];
  const journal = new Map<string, unknown>();
  const posts: string[] = [];
  const a = app();
  // The worker's own Core client (a 4xx is a TerminalError carrying Core's code), reaching Core's routes.
  const client = coreInternalFromEnv((async (url: string, init: RequestInit) => a.request(url, init)) as unknown as typeof fetch);
  const core = { post: <T>(path: string, body: unknown): Promise<T> => { posts.push(path); return client.post<T>(path, body); } };
  const ctx: AutomaticOpenContext = {
    key: initial.requestId, get: async () => state,
    run: async (name, action) => {
      if (journal.has(name)) return journal.get(name) as any;
      const value = await action(); journal.set(name, value); return value;
    },
    set: (_n, value) => { state = value; }, send: (message) => { sent.push(message); },
    startDesign: () => { throw new Error('no design may start'); },
  };
  return { ctx, core, sent, posts, journal, state: () => state };
}

const rows = (requestId: string, taskId: string) => withRlsContext(db, scope, async (trx) => ({
  request: await trx.selectFrom('requests').select(['rev', 'stage']).where('request_id', '=', requestId).executeTakeFirstOrThrow(),
  task: await trx.selectFrom('tasks').select(['state']).where('id', '=', taskId).executeTakeFirstOrThrow(),
}));
const requesterWithdraw = (requestId: string, update: number): WithdrawEvent =>
  ({ v: 1, kind: 'withdraw', eventId: `chatinbox:withdraw:${update}`, requestId, updateId: update });

describe('a requester\'s cancel withdraws a request nothing has been approved for (ADR-230, L1)', () => {
  it.each([
    ['manual', 1, false, 'with a designer, with no draft at all (the 12:33 incident)'],
    ['designing', 1, true, 'being designed'],
    ['awaiting_answer', 2, true, 'waiting for the requester\'s answer'],
    ['in_review', 2, true, 'with the office for review'],
    ['manual', 3, true, 'sent back by the office for changes'],
  ] as const)('%s (rev %s): closed at once, told plainly, the office told by name (%s)', async (stage, rev, auto, _why) => {
    const chat = chatId();
    const { requestId, taskId, state } = await seed(chat, stage, rev, 'do a better design thats similar to earlier ones', auto);
    const cancel = message(chat, 'cancel the last request');
    const decided = await intake(cancel);
    // Intake decides and says nothing yet: the request object closes it, then tells.
    expect(decided).toMatchObject({ lifecycleAction: 'withdraw', requestId, requestStage: stage, intent: 'cancel' });
    expect(decided.chatAnswer).toBeUndefined();
    const object = requestObject(state);
    const reply = await recordWithdraw(object.ctx, object.core, requesterWithdraw(requestId, cancel.update_id));
    expect(reply).toEqual({ accepted: true, requestId, taskId, stage: 'cancelled', rev: rev + 1, fromStage: stage });
    expect(await rows(requestId, taskId)).toEqual({ request: { rev: String(rev + 1), stage: 'cancelled' }, task: { state: 'cancelled' } });
    expect(object.state()).toMatchObject({ stage: 'cancelled', rev: rev + 1, withdrawal: { actor: 'requester', fromStage: stage } });
    const toRequester = object.sent.filter((m) => m.chatId === String(chat));
    // ADR-230 addendum (L16, changed deliberately): a title that names nothing ("your design" under ADR-231)
    // is named by when it was sent and the start of the requester's words.
    expect(toRequester).toHaveLength(1);
    expect(toRequester[0].text).toMatch(/^Cancelled the one you sent (?:just now|\d+ minutes ago|today at \d\d:\d\d) \(“do a better design thats similar…”\)\. Nothing more will be made for it\.$/);
    const toOffice = object.sent.filter((m) => m.chatId === String(OFFICE));
    expect(toOffice).toHaveLength(1);
    // ADR-230 addendum (L16, changed deliberately): the office hears which request: when, and their words.
    expect(toOffice[0].text).toMatch(/^Sewa cancelled the request they sent (?:just now|\d+ minutes ago|today at \d\d:\d\d) \(“do a better design thats similar…”\) in the chat while it was /);
    expect(toOffice[0].text).toContain('nothing more will be made for it');
    // ADR-200's office style: no chat id, no request or task UUID in the alert; the short task id last.
    expect(toOffice[0].text).not.toContain(String(chat));
    expect(toOffice[0].text).not.toMatch(UUID_IN_TEXT);
    expect(String(toOffice[0].text).split('\n').at(-1)).toBe(`Task ${taskId.slice(0, 8)}`);
    // A closed request is no longer the chat's: the next words find nothing to change.
    expect(await intake(message(chat, 'cancel it'))).toMatchObject({ lifecycleAction: 'chat-answer' });
  });

  it('is replay-safe: the same event sends the same keys and projects nothing twice; other content is refused', async () => {
    const chat = chatId();
    const { requestId, taskId, state } = await seed(chat, 'designing', 1);
    const cancel = message(chat, 'cancel that');
    await intake(cancel);
    const object = requestObject(state);
    const first = await recordWithdraw(object.ctx, object.core, requesterWithdraw(requestId, cancel.update_id));
    const keys = object.sent.map((m) => m.key);
    object.journal.clear();
    const again = await recordWithdraw(object.ctx, object.core, requesterWithdraw(requestId, cancel.update_id));
    expect(again).toEqual(first);
    expect(object.posts.filter((p) => p.endsWith('/withdraw'))).toHaveLength(1);
    expect(object.sent.map((m) => m.key)).toEqual([...keys, ...keys]);
    // Intake answering the same update again gives the same decision.
    expect(await intake(cancel)).toMatchObject({ lifecycleAction: 'withdraw', requestId });
    // A fresh object state (Restate lost nothing, Core has the receipt): the projection answers the same.
    const fresh = requestObject(state);
    expect(await recordWithdraw(fresh.ctx, fresh.core, requesterWithdraw(requestId, cancel.update_id))).toEqual(first);
    expect(await rows(requestId, taskId)).toEqual({ request: { rev: '2', stage: 'cancelled' }, task: { state: 'cancelled' } });
  });

  it('a withdraw no recorded decision asks for is refused by Core: a forged update cannot close a request', async () => {
    const chat = chatId();
    const { requestId, taskId, state } = await seed(chat, 'designing', 1);
    const thanks = message(chat, 'thanks!');
    await intake(thanks);
    const object = requestObject(state);
    await expect(recordWithdraw(object.ctx, object.core, requesterWithdraw(requestId, thanks.update_id))).rejects.toThrow(/UNAUTHORIZED_ACTOR/);
    await expect(recordWithdraw(object.ctx, object.core, requesterWithdraw(requestId, updateId()))).rejects.toThrow(/UNAUTHORIZED_ACTOR/);
    expect(await rows(requestId, taskId)).toEqual({ request: { rev: '1', stage: 'designing' }, task: { state: expect.not.stringMatching(/cancelled/) } });
  });

  it('a cancel picked only by which design moved last is asked first: "Do you want me to cancel …?"; "yes" withdraws it', async () => {
    const chat = chatId();
    const older = await seed(chat, 'in_review', 2, 'KAAE staff football tournament');
    await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.requests SET updated_at = now() - interval '2 hours'
      WHERE request_id = ${older.requestId}::uuid`.execute(trx));
    const latest = await seed(chat, 'manual', 1, 'Nawroz poster', false);
    const asked = await intake(message(chat, 'cancel the last request'));
    expect(asked).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true,
      chatAnswer: { text: 'Do you want me to cancel <b>Nawroz poster</b>?' } });
    const yes = message(chat, 'yes');
    expect(await intake(yes)).toMatchObject({ lifecycleAction: 'withdraw', requestId: latest.requestId });
    const object = requestObject(latest.state);
    expect(await recordWithdraw(object.ctx, object.core, requesterWithdraw(latest.requestId, yes.update_id)))
      .toMatchObject({ accepted: true, stage: 'cancelled' });
    expect((await rows(older.requestId, older.taskId)).request).toEqual({ rev: '2', stage: 'in_review' });
  });

  it('in Sorani, the requester hears it in Sorani', async () => {
    const chat = chatId();
    const { requestId, state } = await seed(chat, 'designing', 1);
    const cancel = message(chat, 'نا، هەڵیبوەشێنەوە');
    expect(await intake(cancel)).toMatchObject({ lifecycleAction: 'withdraw', requestId });
    const object = requestObject(state);
    await recordWithdraw(object.ctx, object.core, requesterWithdraw(requestId, cancel.update_id));
    expect(object.sent.find((m) => m.chatId === String(chat))?.text).toBe('<b>KAAE members evening</b> هەڵوەشێنرایەوە. هیچی تر بۆی دروست ناکرێت.');
  });
});

describe('approved, being delivered or delivered: too late to withdraw, and said so (ADR-230)', () => {
  it.each([
    ['approved', 3, "<b>KAAE members evening</b> was already approved, so I can't cancel it myself. I've told the office."],
    ['delivering', 4, "<b>KAAE members evening</b> is already being sent to you, so I can't stop it. I've told the office."],
  ] as const)('%s: kept for the office (Deliver waits until it is read), the requester told the truth', async (stage, rev, words) => {
    const chat = chatId();
    const { requestId, taskId } = await seed(chat, stage, rev);
    const answer = await intake(message(chat, 'please cancel it'));
    expect(answer).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestStage: stage, chatAnswer: { text: words } });
    expect(answer.officeAlert.text).toMatch(new RegExp(`but it was already ${stage === 'approved' ? 'approved' : 'being delivered'}, so it could not be cancelled`));
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, requestId))).toHaveLength(1);
    expect((await rows(requestId, taskId)).request).toEqual({ rev: String(rev), stage });
  });

  it('a request approved between the decision and the withdraw: nothing closes, the cancel is kept, the requester told so', async () => {
    const chat = chatId();
    const { requestId, taskId, state } = await seed(chat, 'in_review', 2);
    const cancel = message(chat, 'cancel it');
    expect(await intake(cancel)).toMatchObject({ lifecycleAction: 'withdraw' });
    // The office approved it before the request object took the cancel.
    await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.requests SET stage = 'approved', rev = 3
      WHERE request_id = ${requestId}::uuid`.execute(trx));
    const object = requestObject({ ...state, stage: 'approved', rev: 3 } as AutomaticLifecycleState);
    expect(await recordWithdraw(object.ctx, object.core, requesterWithdraw(requestId, cancel.update_id)))
      .toEqual({ accepted: false, code: 'TOO_LATE', stage: 'approved' });
    expect(await rows(requestId, taskId)).toMatchObject({ request: { rev: '3', stage: 'approved' } });
    expect(object.state()).toMatchObject({ stage: 'approved', rev: 3 });
    expect(object.sent.find((m) => m.chatId === String(chat))?.text)
      .toBe("<b>KAAE members evening</b> was already approved, so I can't cancel it myself. I've told the office.");
    expect(object.sent.find((m) => m.chatId === String(OFFICE))?.text).toMatch(/but it was already approved/);
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, requestId))).toHaveLength(1);
  });
});

describe('a design already being made when its request was withdrawn (ADR-230)', () => {
  it('finishes into nothing: no review, no draft alert to anyone, its report kept against the closed task, once', async () => {
    const chat = chatId();
    const { requestId, taskId, state } = await seed(chat, 'designing', 1);
    const cancel = message(chat, 'cancel that');
    await intake(cancel);
    const object = requestObject(state);
    await recordWithdraw(object.ctx, object.core, requesterWithdraw(requestId, cancel.update_id));
    const before = object.sent.length;
    const runId = `dr-${taskId}`;
    const finished = { v: 1 as const, eventId: `dr-finished:${runId}`, requestId, runId, round: 0, taskId,
      report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAG123456789' } };
    expect(await recordDesignFinished(object.ctx, object.core, finished)).toEqual({ ignored: false, stage: 'cancelled', rev: 2 });
    expect(object.sent).toHaveLength(before);
    expect(object.posts.filter((p) => p.endsWith('/design-outcome'))).toHaveLength(0);
    expect(object.state()).toMatchObject({ stage: 'cancelled', withdrawal: { finishedRunEventId: finished.eventId } });
    expect(await rows(requestId, taskId)).toEqual({ request: { rev: '2', stage: 'cancelled' }, task: { state: 'cancelled' } });
    // A replay of the finish records nothing more.
    await recordDesignFinished(object.ctx, object.core, finished);
    expect(object.posts.filter((p) => p.endsWith('/withdrawn-outcome'))).toHaveLength(1);
    const kept = await withRlsContext(db, scope, (trx) => sql<{ payload: Record<string, any> }>`SELECT payload FROM hawa.inbox_events
      WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_withdrawn_outcome'
        AND source_event_id = ${`${requestId}:${finished.eventId}`}`.execute(trx));
    expect(kept.rows.map((r) => r.payload)).toEqual([{ requestId, taskId, runId, report: finished.report }]);
  });
});

describe('the office\'s Cancel in the Desk withdraws a request-owned task (ADR-230)', () => {
  /** Restate's ingress as the office gateway answers it: the signature checked, then the request object. */
  function gateway(object: ReturnType<typeof requestObject>) {
    const calls: Array<{ url: string; input: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const input = JSON.parse(String(init.body));
      calls.push({ url, input });
      const verdict = checkSignedOfficeWithdraw(input, WORKER);
      if (verdict !== 'ok') return new Response(JSON.stringify({ message: verdict }), { status: verdict === 'invalid' ? 400 : 401 });
      return new Response(JSON.stringify(await recordWithdraw(object.ctx, object.core, input.event)), { status: 200 });
    }));
    return calls;
  }
  const desk = async (taskId: string, body: Record<string, unknown>, key = randomUUID(), role = 'operator') => {
    const res = await createApp({ db, testAuth: { principal: { role, userId: operatorUserId } } } as any).request(`/v1/tasks/${taskId}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const version = async (taskId: string) => Number((await withRlsContext(db, scope, (trx) => trx.selectFrom('tasks')
    .select('version').where('id', '=', taskId).executeTakeFirstOrThrow())).version);

  it('closes the request (it answered 409 LIFECYCLE_OWNED); the requester is told; a second press is the same action', async () => {
    const chat = chatId();
    const { requestId, taskId, state } = await seed(chat, 'manual', 1, 'do a better design thats similar to earlier ones', false);
    const object = requestObject(state);
    const calls = gateway(object);
    const key = randomUUID();
    const expectedVersion = await version(taskId);
    const res = await desk(taskId, { reason: 'Opened by mistake from a redo message.', expectedVersion }, key);
    expect(res).toMatchObject({ status: 202, body: { status: 'CANCELLED', taskId, requestId, rev: 2, replayed: false,
      commandId: key, version: expectedVersion + 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ingress}/OfficeDecisionGateway/withdraw`);
    expect(calls[0].input.event).toMatchObject({ kind: 'withdraw', eventId: `desk:${key}`, requestId, taskId, expectedRev: 1,
      actor: { userId: operatorUserId, role: 'operator' }, reason: 'Opened by mistake from a redo message.' });
    expect(await rows(requestId, taskId)).toEqual({ request: { rev: '2', stage: 'cancelled' }, task: { state: 'cancelled' } });
    expect(object.state()).toMatchObject({ stage: 'cancelled', withdrawal: { actor: 'office' } });
    expect(object.sent.map((m) => [m.chatId, m.text])).toEqual([[String(chat),
      // ADR-230 addendum (L16, changed deliberately): named by when it was sent and the requester's words.
      expect.stringMatching(/^The office has cancelled the one you sent (?:just now|\d+ minutes ago|today at \d\d:\d\d) \(“do a better design thats similar…”\), so nothing more will be made for it\. Tell me whenever you need a new design\.$/)]]);
    const again = await desk(taskId, { reason: 'Opened by mistake from a redo message.', expectedVersion }, key);
    expect(again).toMatchObject({ status: 200, body: { status: 'CANCELLED', replayed: true, rev: 2 } });
    expect(calls).toHaveLength(1);
  });

  // ADR-239 follow-up (live 2026-10-01): the office cancelled a request and its redo, which share a name, and
  // the requester got the same sentence twice. Each is now named apart (ADR-231's distinctNames).
  it('names which one when the office cancels two requests of the same name (the original and its redo)', async () => {
    const chat = chatId();
    const original = await seed(chat, 'manual', 3, 'KAAE K-12 Pilot Study…', true);
    // When it was opened is the owner's to set (hawa_app may not rewrite it).
    const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
    try {
      await sql`UPDATE hawa.requests SET created_at = now() - interval '3 hours' WHERE request_id = ${original.requestId}::uuid`.execute(owner);
    } finally { await owner.destroy(); }
    const redo = await seed(chat, 'designing', 1, 'KAAE K-12 Pilot Study…');
    const told: string[] = [];
    for (const r of [redo, original]) {
      const object = requestObject(r.state);
      gateway(object);
      expect((await desk(r.taskId, { reason: 'Duplicate of the redo', expectedVersion: await version(r.taskId) })).status).toBe(202);
      told.push(...object.sent.filter((m) => m.chatId === String(chat)).map((m) => String(m.text)));
    }
    expect(told).toHaveLength(2);
    expect(told[0]).toBe('The office has cancelled <b>KAAE K-12 Pilot Study…</b> (asked for just now), so nothing more will be made for it. Tell me whenever you need a new design.');
    expect(told[1]).toMatch(/^The office has cancelled <b>KAAE K-12 Pilot Study…<\/b> \(asked for (?:today|yesterday) at \d\d:\d\d\), so nothing more will be made for it\./);
    expect(new Set(told).size).toBe(2);
  });

  it.each([
    ['approved', 3, /already approved/],
    ['delivering', 4, /being sent to the requester/],
    ['delivered', 5, /already sent to the requester/],
  ] as const)('refuses a request that is %s, and says why', async (stage, rev, why) => {
    const chat = chatId();
    const { requestId, taskId, state } = await seed(chat, stage, rev);
    const calls = gateway(requestObject(state));
    const res = await desk(taskId, { reason: 'Not needed', expectedVersion: await version(taskId) });
    expect(res).toMatchObject({ status: 409, body: { title: 'REQUEST_NOT_WITHDRAWABLE' } });
    expect(res.body.detail).toMatch(why);
    expect(calls).toHaveLength(0);
    expect((await rows(requestId, taskId)).request).toEqual({ rev: String(rev), stage });
  });

  it('needs the current task version, and an office role; the gateway admits only Core\'s signature', async () => {
    const chat = chatId();
    const { requestId, taskId, state } = await seed(chat, 'in_review', 2);
    const object = requestObject(state);
    gateway(object);
    expect(await desk(taskId, { reason: 'Not needed', expectedVersion: 99 })).toMatchObject({ status: 409, body: { title: 'TASK_VERSION_CONFLICT' } });
    expect(await desk(taskId, { reason: 'Not needed', expectedVersion: await version(taskId) }, randomUUID(), 'client_viewer'))
      .toMatchObject({ status: 403 });
    const forged = { v: 1, event: { v: 1, kind: 'withdraw', eventId: `desk:${randomUUID()}`, requestId, taskId, actionId: '',
      expectedRev: 2, actor: { userId: operatorUserId, role: 'operator' }, reason: 'x' }, signature: 'f'.repeat(64) };
    forged.event.actionId = forged.event.eventId.slice(5);
    expect(checkSignedOfficeWithdraw(forged as any, WORKER)).toBe('unauthorized');
    expect((await rows(requestId, taskId)).request).toEqual({ rev: '2', stage: 'in_review' });
  });
});

describe('a natural cancel is read as one, and only withdrawable requests are its target (ADR-230 addendum, L12)', () => {
  const LIVE = 'also cancel the other one I opened by mistake this afternoon';
  const intakeWith = async (update: unknown, requesterIntentModel: unknown = null) => {
    const res = await createApp({ db, requesterIntentModel } as any).request('/v1/internal/telegram/intake', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` },
      body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) });
    return (await res.json()) as Record<string, any>;
  };

  it.each([
    [LIVE, 'cancel'],
    ['and please cancel the one I sent this morning', 'cancel'],
    ['ok cancel the poster I asked for by mistake', 'cancel'],
    ['please cancel the request from earlier, thanks', 'cancel'],
    ['cancel the order we made yesterday', 'cancel'],
    ['cancel that', 'cancel'],
  ] as const)('"%s" reads as %s', async (words, intent) => {
    const { readIntentByRules } = await import('../src/services/requester-turn.js');
    expect(readIntentByRules(words).intent).toBe(intent);
  });

  it.each([
    'cancel the gold border', 'remove the logo', 'also cancel the gold border on the poster I sent this morning',
    `cancel the poster I opened by mistake ${'and then also make the title much bigger and move the logo to the left '.repeat(3)}`,
  ])('"%s" is not a cancel (a part of a design, or too long)', async (words) => {
    const { readIntentByRules } = await import('../src/services/requester-turn.js');
    expect(readIntentByRules(words).intent).not.toBe('cancel');
  });

  it('the live words, with only the accidental request open and KAAE just delivered: it asks to cancel that one by name, never a note on KAAE', async () => {
    const chat = chatId();
    const accidental = await seed(chat, 'manual', 1, 'do a better design thats similar to earlier ones', false);
    const kaae = await seed(chat, 'delivered', 7, 'KAAE K-12 Pilot Study');
    const asked = await intake(message(chat, LIVE));
    expect(asked).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true, intent: 'cancel' });
    // ADR-230 addendum (L16): the accidental request is named by when it was sent and its words.
    expect(asked.chatAnswer.text).toMatch(/^Do you want me to cancel the one you sent .+ \(“do a better design thats similar…”\)\?$/);
    expect(asked.chatAnswer.text).not.toContain('KAAE');
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, kaae.requestId))).toHaveLength(0);
    const yes = message(chat, 'yes');
    expect(await intake(yes)).toMatchObject({ lifecycleAction: 'withdraw', requestId: accidental.requestId });
  });

  it('names a request for certain: withdrawn without a question, among two open ones', async () => {
    const chat = chatId();
    await seed(chat, 'in_review', 2, 'KAAE staff football tournament');
    const nawroz = await seed(chat, 'designing', 1, 'Nawroz poster');
    await seed(chat, 'delivered', 7, 'KAAE K-12 Pilot Study');
    expect(await intake(message(chat, 'please cancel the Nawroz poster I sent this morning')))
      .toMatchObject({ lifecycleAction: 'withdraw', requestId: nawroz.requestId });
  });

  it('"the one I just sent" is the newest withdrawable one, asked about by name', async () => {
    const chat = chatId();
    await seed(chat, 'in_review', 2, 'KAAE staff football tournament');
    await seed(chat, 'designing', 1, 'Nawroz poster');
    expect((await intake(message(chat, 'cancel the one I just sent'))).chatAnswer.text).toBe('Do you want me to cancel <b>Nawroz poster</b>?');
  });

  it('nothing withdrawable: says nothing open can be cancelled, naming what was delivered, and keeps no note', async () => {
    const chat = chatId();
    const kaae = await seed(chat, 'delivered', 7, 'KAAE K-12 Pilot Study');
    const answer = await intake(message(chat, LIVE));
    expect(answer).toMatchObject({ lifecycleAction: 'chat-answer', intent: 'cancel' });
    expect(answer.chatAnswer.text).toBe("There's nothing open for me to cancel right now.\n<b>KAAE K-12 Pilot Study</b> was already delivered, so there is nothing to cancel there.");
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, kaae.requestId))).toHaveLength(0);
  });

  it('cancel words the rules cannot place go to the intake router once (ADR-144), never to a note on the latest design', async () => {
    const chat = chatId();
    const accidental = await seed(chat, 'manual', 1, 'Graduation flyer', false);
    const kaae = await seed(chat, 'delivered', 7, 'KAAE K-12 Pilot Study');
    const read = vi.fn(async (input: { requests: Array<{ requestId: string }> }) => ({ intent: 'cancel' as const, reason: 'fixture',
      source: 'model' as const, requestId: input.requests.find((r) => r.requestId === accidental.requestId)!.requestId, confidence: 0.9 }));
    const answer = await intakeWith(message(chat, 'can you cancel my other request, it was a mistake'), { read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ lifecycleAction: 'withdraw', requestId: accidental.requestId });
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, kaae.requestId))).toHaveLength(0);
  });
});

describe('a cancel with a reason, closed requests never offered, and requests named by when (ADR-230 addendum, L16/L17)', () => {
  const LIVE_L17 = 'cancel the Teacher Appreciation Day poster, it was only a test';
  const LIVE_L12 = 'also cancel the other one I opened by mistake this afternoon';
  const RAW = 'do a better design thats similar to earlier ones';
  const closeRequest = (requestId: string) => withRlsContext(db, scope, (trx) => sql`UPDATE hawa.requests SET stage = 'cancelled', rev = rev + 1
    WHERE request_id = ${requestId}::uuid`.execute(trx));

  it.each([
    [LIVE_L17], ['please cancel the poster, we postponed the event'], ['cancel it - plans changed'],
    ['cancel the flyer because the event was cancelled'], ['cancel the poster, sorry, it was a mistake'],
    ["cancel that, we don't need it anymore"],
  ])('"%s" is a cancel', async (words) => {
    const { readIntentByRules } = await import('../src/services/requester-turn.js');
    expect(readIntentByRules(words).intent).toBe('cancel');
  });

  it.each([['cancel the poster, make the title bigger'], ['cancel the poster, and add a logo'], ['cancel the gold border, it was a mistake']])(
    '"%s" asks for a change too: never a cancel', async (words) => {
      const { readIntentByRules } = await import('../src/services/requester-turn.js');
      expect(readIntentByRules(words).intent).not.toBe('cancel');
    });

  it('the live words withdraw "Teacher Appreciation Day" at once; nothing closed or delivered is offered', async () => {
    const chat = chatId();
    const old = await seed(chat, 'delivered', 7, 'KAAE: Here is the text and the photos:…');
    const accidental = await seed(chat, 'manual', 1, RAW, false);
    await closeRequest(accidental.requestId);
    await seed(chat, 'in_review', 4, 'KAAE K-12 Pilot Study…');
    const teacher = await seed(chat, 'manual', 1, 'Teacher Appreciation Day', false);
    expect(old.requestId).toBeTruthy();
    expect(await intake(message(chat, LIVE_L17))).toMatchObject({ lifecycleAction: 'withdraw', requestId: teacher.requestId });
  });

  // ADR-239 follow-up (canary, 2026-10-02): a named cancel with a trailing apology or reason withdraws at
  // once, as "it was only a test" does; it was asked "Do you want me to cancel …?".
  it.each([
    ['cancel the Science Fair flyer, sorry, it was by mistake'],
    ['cancel the Science Fair flyer, it was by mistake'],
    ['cancel the Science Fair flyer, by mistake'],
    ['cancel the Science Fair flyer, it was sent by accident'],
    ['please cancel the Science Fair flyer, my mistake'],
    ['cancel the Science Fair flyer, wrong one, sorry'],
    ['cancel the Science Fair flyer, sorry'],
    ['cancel the Science Fair flyer. Sorry, I sent it by mistake'],
  ])('"%s" names the design and withdraws it at once', async (words) => {
    const chat = chatId();
    await seed(chat, 'in_review', 4, 'KAAE K-12 Pilot Study…');
    const flyer = await seed(chat, 'designing', 1, 'Science Fair flyer');
    const decided = await intake(message(chat, words));
    expect(decided).toMatchObject({ lifecycleAction: 'withdraw', requestId: flyer.requestId });
    expect(decided.chatAnswer).toBeUndefined();
  });

  it('cancel words the rules cannot place: asked among withdrawable requests only, never "A new design", never a closed one', async () => {
    const chat = chatId();
    await seed(chat, 'delivered', 7, 'KAAE: Here is the text and the photos:…');
    const accidental = await seed(chat, 'manual', 1, RAW, false);
    await closeRequest(accidental.requestId);
    await seed(chat, 'in_review', 4, 'KAAE K-12 Pilot Study…');
    await seed(chat, 'manual', 1, 'Teacher Appreciation Day', false);
    const asked = await intake(message(chat, 'can you cancel my request, it was a mistake'));
    expect(asked).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true });
    const text = String(asked.chatAnswer.text);
    expect(text).toMatch(/^Which design is this for\?/);
    expect(text).toContain('Teacher Appreciation Day');
    expect(text).toContain('KAAE K-12 Pilot Study');
    expect(text).not.toMatch(/A new design|your design|the one you sent|Here is the text/);
  });

  it('a closed request is never planned on, whatever the store returns', async () => {
    const { planTurn, readIntentByRules } = await import('../src/services/requester-turn.js');
    const at = new Date().toISOString();
    const view = (requestId: string, stage: string, title: string) => ({ requestId, stage: stage as any, rev: 2, currentTaskId: requestId, clientId: null,
      title, activeAt: at, createdAt: at, question: null, requesterId: null });
    const plan = planTurn({ text: 'a poster for the staff party', reading: { ...readIntentByRules('a poster for the staff party'), intent: 'unclear' },
      requests: [view('a', 'cancelled', 'Old one'), view('b', 'rejected', 'Rejected one'), view('c', 'in_review', 'Nawroz poster')],
      bound: [], unboundReply: false, senderId: '1', officeIds: [], group: false, addressed: true, pendingAsk: null, now: Date.now() });
    expect(JSON.stringify(plan)).not.toMatch(/"requestId":"[ab]"/);
  });

  it('a request whose title names nothing is named by when it was sent and its words, in the question, the confirmation and the office alert', async () => {
    const chat = chatId();
    const accidental = await seed(chat, 'manual', 1, RAW, false);
    await seed(chat, 'delivered', 7, 'KAAE K-12 Pilot Study…');
    const asked = await intake(message(chat, LIVE_L12));
    const NAMED = /the one you sent (?:just now|\d+ minutes ago|today at \d\d:\d\d) \(“do a better design thats similar…”\)/;
    expect(asked.chatAnswer.text).toMatch(new RegExp(`^Do you want me to cancel ${NAMED.source}\\?$`));
    const yes = message(chat, 'yes');
    expect(await intake(yes)).toMatchObject({ lifecycleAction: 'withdraw', requestId: accidental.requestId });
    const object = requestObject(accidental.state);
    await recordWithdraw(object.ctx, object.core, requesterWithdraw(accidental.requestId, yes.update_id));
    expect(object.sent.find((m) => m.chatId === String(chat))?.text).toMatch(new RegExp(`^Cancelled ${NAMED.source}\\. Nothing more will be made for it\\.$`));
    expect(object.sent.find((m) => m.chatId === String(OFFICE))?.text)
      .toMatch(/^Sewa cancelled the request they sent (?:just now|\d+ minutes ago|today at \d\d:\d\d) \(“do a better design thats similar…”\) in the chat while it was with a designer\./);
  });

  it('names a neutral title by the brief\'s own words, in English and Sorani', async () => {
    const { requestLabel } = await import('../src/services/requester-turn.js');
    const now = Date.parse('2026-10-01T15:00:00Z');
    const r = { title: 'New design request from Hawzhin', askedAt: '2026-10-01T12:33:00Z', words: RAW };
    expect(requestLabel(r, 'en', now)).toBe('the one you sent today at 15:33 (“do a better design thats similar…”)');
    expect(requestLabel(r, 'ckb', now)).toBe('ئەوەی ئەمڕۆ کاتژمێر 15:33 ناردت (“do a better design thats similar…”)');
    expect(requestLabel({ ...r, title: 'Nawroz poster' }, 'en', now)).toBe('<b>Nawroz poster</b>');
  });
});
