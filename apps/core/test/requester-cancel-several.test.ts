/**
 * ADR-255: a requester cancels several designs at once, and "both" answers "which design?".
 *
 * Live 2026-10-02 ~07:34Z (production 48337099, canary chat). The chat had two designs with a designer,
 * opened from one message: "Harvest Fair… (1/2)" and "Chess Club… (2/2)".
 *  1. "please cancel both of them, we don't need them" was asked "Which design is this for? 1. … 2. … 3. A new design".
 *  2. The answer "both" got a status line about one design.
 *  3. "and cancel the Chess Club flyer too" was asked "Do you want me to cancel Chess Club… (2/2)?".
 *  4. Every title ended in "…", cut or not.
 *
 * The unit tests read the planner with the live words; the chat tests run Core's intake and the worker's
 * RequestLifecycle withdraw against the per-file test database, as request-withdraw.test.ts does. Sorani
 * lines carry their meaning in a comment.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import type { OutboundMessage } from '@hawa/contracts';
import { requesterTitleName } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { pendingLateChanges } from '../src/services/lifecycle-chat-target.js';
import { requestTitle } from '../src/services/request-title.js';
import { askText, parseChoice, planTurn, readIntentByRules, shortTitle, type ChatRequestView, type PendingAsk,
  type TurnInput } from '../src/services/requester-turn.js';
import { recordWithdraw, type AutomaticOpenContext, type LifecycleState, type ManualLifecycleState,
  type WithdrawEvent } from '../../worker/src/lifecycle/request-lifecycle.js';
import { coreInternalFromEnv } from '../../worker/src/lifecycle/delivery.js';

const LIVE_BOTH = "please cancel both of them, we don't need them";
const LIVE_TOO = 'and cancel the Chess Club flyer too';
const HARVEST_TITLE = 'KAAE: Harvest Fair… (1/2)';
const CHESS_TITLE = 'KAAE: Chess Club… (2/2)';

// ---------------------------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-10-02T07:34:00Z');
const view = (requestId: string, stage: ChatRequestView['stage'], title: string, minutesAgo = 5, rev = 1): ChatRequestView => ({
  requestId, stage, rev, currentTaskId: `${requestId}-task`, clientId: 'c', title,
  activeAt: new Date(NOW - minutesAgo * 60_000).toISOString(), createdAt: new Date(NOW - (minutesAgo + 1) * 60_000).toISOString(),
  question: null, requesterId: '1',
});
const input = (text: string, requests: ChatRequestView[], extra: Partial<TurnInput> = {}): TurnInput => ({
  text, reading: readIntentByRules(text), requests, bound: [], unboundReply: false, senderId: '1', officeIds: [],
  group: false, addressed: true, pendingAsk: null, now: NOW, ...extra,
});
const HARVEST = view('A', 'manual', HARVEST_TITLE, 6);
const CHESS = view('B', 'manual', CHESS_TITLE, 5);
const TWO = [HARVEST, CHESS];

// Conversation fuzz (2026-10-03, J2): a cancel that names its designs together is asked about once, naming them all
// ("Do you want me to cancel both … and …?"); "yes" cancels them all. Before, it withdrew them at once.
const bothAsked = (words: string, every: 'both' | 'all', ids: string[]) =>
  ({ kind: 'ask', intent: 'cancel', words, allowNew: false, every, options: ids.map((requestId) => ({ requestId })) });
const yesTo = (words: string, ids: string[], every: 'both' | 'all' = 'both'): PendingAsk => ({ updateId: 21, intent: 'cancel', words, allowNew: false, every,
  options: ids.map((requestId) => ({ requestId, title: requestId === 'A' ? HARVEST_TITLE : requestId === 'B' ? CHESS_TITLE : 'KAAE: Book Week' })) });

describe('item 1: cancel words that name the designs together cancel them all', () => {
  it('the live words are a cancel of both, never "A new design"', () => {
    expect(readIntentByRules(LIVE_BOTH)).toMatchObject({ intent: 'cancel', every: 'both' });
    expect(readIntentByRules(LIVE_BOTH).bareCancel).toBeUndefined();
    expect(planTurn(input(LIVE_BOTH, TWO))).toMatchObject(bothAsked(LIVE_BOTH, 'both', ['A', 'B']));
    expect(planTurn(input('yes', TWO, { pendingAsk: yesTo(LIVE_BOTH, ['A', 'B']) })))
      .toEqual({ kind: 'cancel-all', requestIds: ['A', 'B'], words: LIVE_BOTH, resolves: 21 });
  });

  it.each([
    ['cancel both', 'both'], ['cancel both designs', 'both'], ['cancel the two of them', 'both'], ['please cancel both posters', 'both'],
    ['cancel them both, thanks', 'both'], ['cancel all of them', 'all'], ['cancel them all', 'all'], ['cancel all the designs', 'all'],
    ['never mind, cancel all of them', 'all'], ['we want to cancel both', 'both'],
    // "cancel both of them" (Sorani)
    ['هەردووکیان هەڵبوەشێنەوە', 'both'],
    // "cancel both of them, we don't need them" (Sorani)
    ['هەردووکیان هەڵبوەشێنەوە، پێویستمان نییە', 'both'],
    // "cancel all of them" (Sorani)
    ['هەموویان هەڵبوەشێنەوە', 'all'],
  ] as const)('"%s" cancels every design it names (%s)', (words, every) => {
    expect(readIntentByRules(words)).toMatchObject({ intent: 'cancel', every });
    expect(planTurn(input(words, TWO))).toMatchObject(bothAsked(words, every, ['A', 'B']));
    expect(planTurn(input('yes', TWO, { pendingAsk: yesTo(words, ['A', 'B'], every) }))).toMatchObject({ kind: 'cancel-all', requestIds: ['A', 'B'], resolves: 21 });
  });

  it('said as a reply to one design\'s message, "both" still means both', () => {
    expect(planTurn(input(LIVE_BOTH, TWO, { bound: ['B'] }))).toMatchObject(bothAsked(LIVE_BOTH, 'both', ['A', 'B']));
  });

  it('"all of them" is every open design; "both" of three is asked about, without "A new design"', () => {
    const three = [...TWO, view('C', 'designing', 'KAAE: Book Week', 4)];
    expect(planTurn(input('cancel all of them', three))).toMatchObject(bothAsked('cancel all of them', 'all', ['A', 'B', 'C']));
    expect(planTurn(input('yes', three, { pendingAsk: yesTo('cancel all of them', ['A', 'B', 'C'], 'all') })))
      .toMatchObject({ kind: 'cancel-all', requestIds: ['A', 'B', 'C'], resolves: 21 });
    const asked = planTurn(input(LIVE_BOTH, three));
    expect(asked).toMatchObject({ kind: 'ask', intent: 'cancel', allowNew: false });
    if (asked.kind !== 'ask') throw new Error('expected a question');
    expect(askText(asked, 'en', NOW)).not.toContain('A new design');
  });

  it('one design approved: both are named; the request objects withdraw one and tell the other too late', () => {
    const approved = [HARVEST, view('B', 'approved', CHESS_TITLE, 5, 3)];
    expect(planTurn(input(LIVE_BOTH, approved))).toMatchObject(bothAsked(LIVE_BOTH, 'both', ['A', 'B']));
    expect(planTurn(input('yes', approved, { pendingAsk: yesTo(LIVE_BOTH, ['A', 'B']) }))).toMatchObject({ kind: 'cancel-all', requestIds: ['A', 'B'] });
  });

  it('with only one design in the chat, "cancel both of them" is asked about that one, as any cancel is', () => {
    expect(planTurn(input(LIVE_BOTH, [HARVEST]))).toMatchObject({ kind: 'ask', intent: 'cancel', options: [{ requestId: 'A' }] });
  });

  it('words the rules cannot place ask one question naming both; "yes" cancels both, "no" keeps them', () => {
    const words = 'hey could you cancel both please';
    expect(readIntentByRules(words)).toMatchObject({ intent: 'unclear', cancelWords: true, every: 'both' });
    const asked = planTurn(input(words, TWO));
    expect(asked).toMatchObject({ kind: 'ask', intent: 'cancel', allowNew: false, every: 'both', options: [{ requestId: 'A' }, { requestId: 'B' }] });
    if (asked.kind !== 'ask') throw new Error('expected a question');
    expect(askText(asked, 'en', NOW)).toBe('Do you want me to cancel both <b>Harvest Fair (1/2)</b> and <b>Chess Club (2/2)</b>?');
    expect(askText(asked, 'ckb', NOW)).toBe('دەتەوێت هەردووکیان هەڵبوەشێنمەوە، <b>Harvest Fair (1/2)</b> و <b>Chess Club (2/2)</b>؟');
    const pending: PendingAsk = { updateId: 9, intent: 'cancel', words, options: asked.options, allowNew: false, every: 'both' };
    for (const yes of ['yes', 'yes please', 'yeah cancel them', 'ok', 'بەڵێ']) {
      expect(planTurn(input(yes, TWO, { pendingAsk: pending }))).toEqual({ kind: 'cancel-all', requestIds: ['A', 'B'], words, resolves: 9 });
    }
    expect(planTurn(input('no', TWO, { pendingAsk: pending }))).toEqual({ kind: 'reply', what: 'status', requestIds: ['A', 'B'] });
    // One named: only that one.
    expect(planTurn(input('just the chess club one', TWO, { pendingAsk: pending }))).toMatchObject({ kind: 'note', note: 'cancel', requestId: 'B' });
  });

  it('a question asked because of cancel words never offers "A new design"', () => {
    const plan = planTurn(input('please cancel the poster', TWO));
    expect(plan).toMatchObject({ kind: 'ask', intent: 'cancel', allowNew: false });
    if (plan.kind !== 'ask') throw new Error('expected a question');
    expect(askText(plan, 'en', NOW)).toBe('Which design is this for?\n1. <b>Harvest Fair (1/2)</b>\n2. <b>Chess Club (2/2)</b>');
    // Even one stored with "a new design" allowed.
    expect(askText({ ...plan, allowNew: true }, 'en', NOW)).not.toContain('A new design');
    const words = 'can you cancel the thing for me';
    expect(readIntentByRules(words)).toMatchObject({ intent: 'unclear', cancelWords: true });
    expect(planTurn(input(words, TWO))).toMatchObject({ kind: 'ask', intent: 'cancel', allowNew: false });
  });
});

describe('item 2: "both" and "all of them" answer "which design?"', () => {
  const cancelAsk: PendingAsk = { updateId: 11, intent: 'cancel', words: 'please cancel the poster', allowNew: false,
    options: [{ requestId: 'A', title: HARVEST_TITLE }, { requestId: 'B', title: CHESS_TITLE }] };
  it.each(['both', 'Both!', 'both of them', 'the two of them', 'both designs', 'yes both', 'all', 'all of them', 'them all',
    'all the designs', 'both please',
    // "both of them" (Sorani)
    'هەردووکیان',
    // "both designs" (Sorani)
    'هەردوو دیزاینەکە',
    // "all of them" (Sorani)
    'هەموویان',
  ])('"%s" to a cancel question cancels both', (words) => {
    expect(parseChoice(words, cancelAsk)).toEqual({ every: true });
    expect(planTurn(input(words, TWO, { pendingAsk: cancelAsk }))).toEqual({ kind: 'cancel-all', requestIds: ['A', 'B'],
      words: 'please cancel the poster', resolves: 11 });
  });

  it('the live question (asked before ADR-255 as "change or new") still cancels both when its words cancelled', () => {
    const live: PendingAsk = { ...cancelAsk, intent: 'unclear', words: LIVE_BOTH, allowNew: true };
    expect(planTurn(input('both', TWO, { pendingAsk: live }))).toEqual({ kind: 'cancel-all', requestIds: ['A', 'B'], words: LIVE_BOTH, resolves: 11 });
    // A design chosen by number from it is cancelled, not kept as a change.
    expect(planTurn(input('2', TWO, { pendingAsk: live }))).toMatchObject({ kind: 'note', note: 'cancel', requestId: 'B', resolves: 11 });
  });

  it('"all good" and "thanks all" answer nothing', () => {
    expect(parseChoice('all good', cancelAsk)).toBeNull();
    expect(parseChoice('ok', cancelAsk)).toBeNull();
  });

  it('"both" to a change goes to one design at a time: asked naturally which first, then applied to the one chosen', () => {
    const changeAsk: PendingAsk = { updateId: 12, intent: 'change', words: 'make the date bigger', allowNew: false, options: cancelAsk.options };
    const plan = planTurn(input('both', TWO, { pendingAsk: changeAsk }));
    expect(plan).toMatchObject({ kind: 'ask', intent: 'change', words: 'make the date bigger', allowNew: false, oneAtATime: true });
    if (plan.kind !== 'ask') throw new Error('expected a question');
    expect(askText(plan, 'en', NOW)).toBe('I can only take this for one design at a time. Which one should it go to first?\n' +
      '1. <b>Harvest Fair (1/2)</b>\n2. <b>Chess Club (2/2)</b>\nAfter that, send it again for the other one.');
    expect(askText(plan, 'ckb', NOW)).toContain('لە یەک کاتدا');
    const again: PendingAsk = { updateId: 13, intent: plan.intent, words: plan.words, options: plan.options, allowNew: false };
    expect(planTurn(input('the first one', TWO, { pendingAsk: again }))).toEqual({ kind: 'note', note: 'change', requestId: 'A',
      words: 'make the date bigger', resolves: 13 });
    // "Change or new?" with two designs, answered "both": the same.
    const orNew: PendingAsk = { ...changeAsk, intent: 'unclear', allowNew: true };
    expect(planTurn(input('both of them', TWO, { pendingAsk: orNew }))).toMatchObject({ kind: 'ask', oneAtATime: true, allowNew: false });
  });
});

describe('item 3: "and … too" does not make a named cancel uncertain', () => {
  it.each([LIVE_TOO, 'also cancel the Chess Club flyer as well', 'cancel the Chess Club flyer too please', 'and also cancel the chess club one too'])(
    '"%s" names Chess Club, and is asked about it alone (J2)', (words) => {
      const reading = readIntentByRules(words);
      expect(reading).toMatchObject({ intent: 'cancel' });
      expect(reading.bareCancel).toBeUndefined();
      expect(planTurn(input(words, TWO))).toMatchObject({ kind: 'ask', intent: 'cancel', allowNew: false, options: [{ requestId: 'B' }] });
    });

  it.each(['and never mind', 'also stop', 'stop too'])('"%s" names nothing, and is still asked about (ADR-251)', (words) => {
    expect(readIntentByRules(words)).toMatchObject({ intent: 'cancel', bareCancel: true });
    expect(planTurn(input(words, [CHESS]))).toMatchObject({ kind: 'ask', intent: 'cancel' });
  });
});

describe('item 4: "…" only where the name was cut', () => {
  it('a whole name has no "…"; a cut one keeps it', () => {
    expect(requestTitle({ headline: 'Harvest Fair', label: 'KAAE' })).toBe('KAAE: Harvest Fair');
    const long = 'The Annual Kurdistan Harvest Fair and Farmers Market of Erbil';
    expect(requestTitle({ headline: long, label: 'Shno' })).toBe(`Shno: ${long.slice(0, 45).trimEnd()}…`);
  });
  it('titles stored with a decorative "…" are shown without it; "(1/2)" stays; a cut name keeps its "…"', () => {
    expect(shortTitle(HARVEST_TITLE)).toBe('Harvest Fair (1/2)');
    expect(shortTitle('KAAE: Chess Club…')).toBe('Chess Club');
    const cut = 'The Annual Kurdistan Harvest Fair and Farmers…';
    expect(Array.from(cut.replace('…', '')).length).toBe(45);
    expect(shortTitle(`KAAE: ${cut} (2/2)`)).toBe(`${cut} (2/2)`);
    expect(requesterTitleName(HARVEST_TITLE)).toBe('Harvest Fair (1/2)');
    expect(requesterTitleName(`KAAE: ${cut}`)).toBe(cut);
  });
});

// ---------------------------------------------------------------------------------------------
// The chat: Core's intake decides, each request's own RequestLifecycle withdraws it
// ---------------------------------------------------------------------------------------------

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const OFFICE = 91000255;
const REQUESTER = 91000256;
const WORKER = ['worker', 'several', 'fixture', 'token'].join('_');
const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.HAWA_WORKER_TOKEN = WORKER;
  process.env.RESTATE_INGRESS_URL = 'http://restate.several-fixture:8080';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { process.env = saved; await db.destroy(); });

const chatId = () => 67_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_400_000_000 + Math.floor(Math.random() * 600_000_000);
const message = (chat: number, text: string) => {
  const id = updateId();
  return { update_id: id, message: { message_id: id % 100000, from: { id: REQUESTER, is_bot: false, first_name: 'Sewa' },
    chat: { id: chat, type: 'private' }, date: 1790000000, text } };
};
/** The requester's next message, sent right after `prev` (a later update). */
const after = (prev: { update_id: number; message: { chat: { id: number } } }, text: string) => {
  const id = prev.update_id + 1;
  return { update_id: id, message: { message_id: id % 100000, from: { id: REQUESTER, is_bot: false, first_name: 'Sewa' },
    chat: { id: prev.message.chat.id, type: 'private' }, date: 1790000000, text } };
};
const app = () => createApp({ db, requesterIntentModel: null } as any);
const intake = async (update: unknown) => {
  const res = await app().request('/v1/internal/telegram/intake', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` },
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) });
  return (await res.json()) as Record<string, any>;
};

/** A request with a designer (or at `stage`), as Core holds it, and its RequestLifecycle state. */
async function seed(chat: number, title: string, stage = 'manual', rev = 1) {
  const requestId = randomUUID();
  const created = await persistChatIntake(db, {
    platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: String(chat), rawText: title, title, clientId,
    designInstructions: 'Make the event design', exactCopy: [{ text: 'October 2026' }], autoGenerate: false, designStudio: false,
  }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id)
      VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, null, 'restate', ${stage}, ${rev}, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  const state = { v: 1, requestId, tenantId, chatId: String(chat), owner: 'restate', taskId, openEventId: `open:${requestId}`,
    openSha256: 'a'.repeat(64), lang: 'en', title, stage, rev } as unknown as ManualLifecycleState;
  return { requestId, taskId, state: state as LifecycleState };
}

function requestObject(initial: LifecycleState) {
  let state: LifecycleState | null = initial;
  const sent: OutboundMessage[] = [];
  const journal = new Map<string, unknown>();
  const a = app();
  const core = coreInternalFromEnv((async (url: string, init: RequestInit) => a.request(url, init)) as unknown as typeof fetch);
  const ctx: AutomaticOpenContext = {
    key: initial.requestId, get: async () => state,
    run: async (name, action) => {
      if (journal.has(name)) return journal.get(name) as any;
      const value = await action(); journal.set(name, value); return value;
    },
    set: (_n, value) => { state = value; }, send: (m) => { sent.push(m); },
    startDesign: () => { throw new Error('no design may start'); },
  };
  return { ctx, core, sent, state: () => state };
}
const withdraw = (requestId: string, update: number): WithdrawEvent =>
  ({ v: 1, kind: 'withdraw', eventId: `chatinbox:withdraw:${update}`, requestId, updateId: update });
const stageOf = async (requestId: string) => (await withRlsContext(db, scope, (trx) => trx.selectFrom('requests').select(['stage'])
  .where('request_id', '=', requestId).executeTakeFirstOrThrow())).stage;

describe('the live chat, as the requester wrote it', () => {
  it('"please cancel both of them, we don\'t need them" asks once about both; "yes" withdraws both, each told plainly', async () => {
    const chat = chatId();
    const harvest = await seed(chat, HARVEST_TITLE);
    const chess = await seed(chat, CHESS_TITLE);
    // Conversation fuzz (2026-10-03, J2): asked first, naming both; nothing is withdrawn on the cancel words.
    const words = message(chat, LIVE_BOTH);
    const asked = await intake(words);
    expect(asked).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true });
    expect(asked.chatAnswer.text).toBe('Do you want me to cancel both <b>Harvest Fair (1/2)</b> and <b>Chess Club (2/2)</b>?');
    expect([await stageOf(harvest.requestId), await stageOf(chess.requestId)]).toEqual(['manual', 'manual']);
    const cancel = after(words, 'yes');
    const decided = await intake(cancel);
    // The intent is the reading of "yes" (an answer); the plan it resolves is the cancel.
    expect(decided).toMatchObject({ lifecycleAction: 'withdraw', requestIds: [harvest.requestId, chess.requestId] });
    expect(decided.requestId).toBe(harvest.requestId);
    expect(decided.chatAnswer).toBeUndefined();
    const told: string[] = [];
    for (const one of [harvest, chess]) {
      const object = requestObject(one.state);
      expect(await recordWithdraw(object.ctx, object.core, withdraw(one.requestId, cancel.update_id))).toMatchObject({ accepted: true, stage: 'cancelled' });
      told.push(...object.sent.filter((m) => m.chatId === String(chat)).map((m) => String(m.text)));
    }
    expect(told).toEqual(['Cancelled <b>Harvest Fair (1/2)</b>. Nothing more will be made for it.',
      'Cancelled <b>Chess Club (2/2)</b>. Nothing more will be made for it.']);
    expect([await stageOf(harvest.requestId), await stageOf(chess.requestId)]).toEqual(['cancelled', 'cancelled']);
    // The same update answers the same decision; a request it did not name cannot be closed with it.
    expect(await intake(cancel)).toMatchObject({ requestIds: [harvest.requestId, chess.requestId] });
    const other = await seed(chat, 'KAAE: Book Week');
    const object = requestObject(other.state);
    await expect(recordWithdraw(object.ctx, object.core, withdraw(other.requestId, cancel.update_id))).rejects.toThrow(/UNAUTHORIZED_ACTOR/);
    expect(await stageOf(other.requestId)).toBe('manual');
  });

  it('"both" said to "which design?" withdraws both; the question offered no new design', async () => {
    const chat = chatId();
    const harvest = await seed(chat, HARVEST_TITLE);
    const chess = await seed(chat, CHESS_TITLE);
    const asked = await intake(message(chat, 'please cancel the poster'));
    expect(asked).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true });
    expect(asked.chatAnswer.text).toBe('Which design is this for?\n1. <b>Harvest Fair (1/2)</b>\n2. <b>Chess Club (2/2)</b>');
    const both = message(chat, 'both');
    expect(await intake(both)).toMatchObject({ lifecycleAction: 'withdraw', requestIds: [harvest.requestId, chess.requestId] });
    for (const one of [harvest, chess]) {
      const object = requestObject(one.state);
      expect(await recordWithdraw(object.ctx, object.core, withdraw(one.requestId, both.update_id))).toMatchObject({ accepted: true });
    }
  });

  it('"and cancel the Chess Club flyer too" asks about Chess Club; "yes" withdraws it, and only it', async () => {
    const chat = chatId();
    const harvest = await seed(chat, HARVEST_TITLE);
    const chess = await seed(chat, CHESS_TITLE);
    const words = message(chat, LIVE_TOO);
    const asked = await intake(words);
    expect(asked.chatAnswer.text).toBe('Do you want me to cancel <b>Chess Club (2/2)</b>?');
    const cancel = after(words, 'yes');
    const decided = await intake(cancel);
    expect(decided).toMatchObject({ lifecycleAction: 'withdraw', requestId: chess.requestId });
    expect(decided.requestIds).toBeUndefined();
    const object = requestObject(chess.state);
    expect(await recordWithdraw(object.ctx, object.core, withdraw(chess.requestId, cancel.update_id))).toMatchObject({ accepted: true });
    expect(await stageOf(harvest.requestId)).toBe('manual');
  });

  it('one already approved: the other is withdrawn, and the approved one is kept for the office and told too late', async () => {
    const chat = chatId();
    const harvest = await seed(chat, HARVEST_TITLE);
    const chess = await seed(chat, CHESS_TITLE, 'approved', 3);
    const words = message(chat, 'cancel both of them');
    expect(await intake(words)).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true });
    const cancel = after(words, 'yes');
    expect(await intake(cancel)).toMatchObject({ lifecycleAction: 'withdraw', requestIds: [harvest.requestId, chess.requestId] });
    const first = requestObject(harvest.state);
    expect(await recordWithdraw(first.ctx, first.core, withdraw(harvest.requestId, cancel.update_id))).toMatchObject({ accepted: true });
    const late = requestObject(chess.state);
    expect(await recordWithdraw(late.ctx, late.core, withdraw(chess.requestId, cancel.update_id)))
      .toEqual({ accepted: false, code: 'TOO_LATE', stage: 'approved' });
    expect(late.sent.find((m) => m.chatId === String(chat))?.text)
      .toBe("<b>Chess Club (2/2)</b> was already approved, so I can't cancel it myself. I've told the office.");
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, chess.requestId)))
      .toMatchObject([{ updateId: `${cancel.update_id}:${chess.requestId}` }]);
    expect(await stageOf(chess.requestId)).toBe('approved');
  });
});
