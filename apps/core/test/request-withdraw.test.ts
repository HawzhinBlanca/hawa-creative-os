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
    // ADR-231 (merged): a stored title that names no design is "your design" to the requester.
    expect(toRequester.map((m) => m.text)).toEqual(['Cancelled <b>your design</b>. Nothing more will be made for it.']);
    const toOffice = object.sent.filter((m) => m.chatId === String(OFFICE));
    expect(toOffice).toHaveLength(1);
    // ADR-231 (merged): office alerts name the design by `shortTitle`, which calls a sentence title "your design".
    expect(toOffice[0].text).toMatch(/^Sewa cancelled "your design" in the chat while it was /);
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
      // ADR-231 (merged): a stored title that names no design is "your design" to the requester.
      'The office has cancelled <b>your design</b>, so nothing more will be made for it. Tell me whenever you need a new design.']]);
    const again = await desk(taskId, { reason: 'Opened by mistake from a redo message.', expectedVersion }, key);
    expect(again).toMatchObject({ status: 200, body: { status: 'CANCELLED', replayed: true, rev: 2 } });
    expect(calls).toHaveLength(1);
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
