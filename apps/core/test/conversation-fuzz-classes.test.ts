import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { pendingLateChanges } from '../src/services/lifecycle-chat-target.js';
import { clientQuestionTimeout } from '../src/services/lifecycle-client-question.js';

/**
 * The conversation fuzz's violation classes (QA, 2026-10-03; apps/core/test/conversation-fuzz.test.ts, report
 * output/research/2026-10-03-conversation-fuzz/REPORT.md), each pinned through Core's real intake route against the
 * per-file test database, with the requester intent model off. Every test here failed before its fix. Sorani and
 * Arabic lines carry their meaning in a comment; the Sorani ones are already in this repository's tests.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const OFFICE = 91_000_411;
const REQUESTER = 91_000_412;
const WORKER = ['worker', 'convfuzz', 'classes', 'token'].join('_');

const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = `${OFFICE}`;
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { process.env = saved; await db.destroy(); });

const chatId = () => 69_000_000 + Math.floor(Math.random() * 9_000_000);
let nextUpdate = 1_600_000_000 + Math.floor(Math.random() * 100_000_000);
/** The requester's messages, in order (each a later update than the one before). */
const text = (chat: number, words: string) => {
  const id = ++nextUpdate;
  return { update_id: id, message: { message_id: id % 1_000_000, date: 1790000000,
    from: { id: REQUESTER, is_bot: false, first_name: 'Sewa' }, chat: { id: chat, type: 'private' }, text: words } };
};
function app() {
  vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
  const bridge = { downloadFile: vi.fn(async () => Buffer.alloc(0)), dispatchOutboundMessage: vi.fn(async () => ({ success: true })),
    answerCallbackQuery: vi.fn(async () => true) };
  return createApp({ db, telegramBridge: bridge, requesterIntentModel: null } as any);
}
const intake = async (chat: number, words: string) => {
  const res = await app().request('/v1/internal/telegram/intake', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` },
    body: JSON.stringify({ v: 1, update: text(chat, words), mode: 'lifecycle', languageSiblings: true, briefHold: false }) });
  return (await res.json()) as Record<string, any>;
};
const opened = async (chat: number) => Number((await withRlsContext(db, scope, (trx) => sql<{ n: string }>`SELECT count(*) AS n
  FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_open'
    AND payload->>'chatId' = ${String(chat)}`.execute(trx))).rows[0].n);
const stageOf = async (requestId: string) => (await withRlsContext(db, scope, (trx) => trx.selectFrom('requests').select(['stage'])
  .where('request_id', '=', requestId).executeTakeFirstOrThrow())).stage;

/** A request of this chat at `stage`, as Core holds it. */
async function seed(chat: number, title: string, stage: string, rev = 2) {
  const requestId = randomUUID();
  const created = await persistChatIntake(db, { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: String(chat),
    rawText: title, title, clientId, designInstructions: 'Make the event design', exactCopy: [{ text: title.replace(/^KAAE: /, '') }],
    autoGenerate: stage !== 'manual', designStudio: stage !== 'manual', variant: { width: 1200, height: 1697 }, studioOptions: { tier: 'quality' } },
  { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id)
      VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, null, 'restate', ${stage}, ${rev}, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  return { requestId, taskId };
}
const NO_CLIENT_BRIEF = 'Please make a poster for the Nawroz Celebration on 20 March 2027 at Rotana Hotel, Erbil.';

describe('class 1 (J2): a cancel that names its design is asked about first; only "yes" withdraws it', () => {
  it.each(['cancel it', "we don't need it anymore", 'please cancel the poster',
    // "cancel it" (Sorani)
    'هەڵیبوەشێنەوە'])('"%s" asks, withdraws nothing; "yes" withdraws', async (words) => {
    const chat = chatId();
    const { requestId } = await seed(chat, 'KAAE: Book Fair', 'designing');
    const asked = await intake(chat, words);
    expect(asked).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true });
    expect(asked.chatAnswer.text).toMatch(/Do you want me to cancel <b>Book Fair<\/b>\?|<b>Book Fair<\/b> هەڵبوەشێنمەوە؟/);
    expect(await stageOf(requestId)).toBe('designing');
    expect(await intake(chat, words.match(/\p{Script=Arabic}/u) ? 'بەڵێ' : 'yes')).toMatchObject({ lifecycleAction: 'withdraw', requestId });
  });

  it('"no" keeps the design', async () => {
    const chat = chatId();
    const { requestId } = await seed(chat, 'KAAE: Book Fair', 'in_review');
    await intake(chat, 'please cancel the poster');
    const kept = await intake(chat, 'no');
    expect(kept.lifecycleAction).toBe('chat-answer');
    expect(kept.chatAnswer.text).toMatch(/Book Fair/);
    expect(await stageOf(requestId)).toBe('in_review');
  });

  it('"cancel both of them" asks once, naming both; "yes" withdraws both', async () => {
    const chat = chatId();
    const a = await seed(chat, 'KAAE: Book Fair', 'designing');
    const b = await seed(chat, 'KAAE: Open Day', 'designing');
    const asked = await intake(chat, 'cancel both of them');
    expect(asked.chatAnswer.text).toMatch(/^Do you want me to cancel both <b>.+<\/b> and <b>.+<\/b>\?$/);
    const yes = await intake(chat, 'yes');
    expect(yes).toMatchObject({ lifecycleAction: 'withdraw' });
    expect([...yes.requestIds].sort()).toEqual([a.requestId, b.requestId].sort());
  });
});

describe('class 2 (J1/J3): a change with nothing on the way never opens a request', () => {
  it.each(['make the text bold', 'change the date to 5 November', 'can you make the background darker'])(
    '"%s" after the chat\'s design was cancelled goes to the office, opens nothing', async (words) => {
      const chat = chatId();
      await seed(chat, 'KAAE: Book Fair', 'cancelled', 4);
      const answer = await intake(chat, words);
      expect(answer.lifecycleAction).not.toBe('open-request');
      expect(answer.chatAnswer?.text).toBe("I've passed your message to the office; they'll follow up here.");
      expect(answer.officeAlert?.text).toContain(words);
      expect(await opened(chat)).toBe(0);
    });

  it('"use blue instead" while the bot waits to hear who a brief is for opens nothing', async () => {
    const chat = chatId();
    expect(await intake(chat, NO_CLIENT_BRIEF)).toMatchObject({ clientQuestion: true });
    const answer = await intake(chat, 'use blue instead');
    expect(answer.lifecycleAction).not.toBe('open-request');
    expect(await opened(chat)).toBe(0);
  });
});

describe('class 3 (J1): status words never answer "who is this design for?"', () => {
  it.each(['any update?', 'any news on the poster?'])('"%s" leaves the brief waiting, and says so; the answer still opens it', async (words) => {
    const chat = chatId();
    expect(await intake(chat, NO_CLIENT_BRIEF)).toMatchObject({ clientQuestion: true });
    const answer = await intake(chat, words);
    expect(answer.lifecycleAction).not.toBe('open-request');
    expect(answer.chatAnswer.text).toBe("<b>Nawroz Celebration</b> is waiting for your answer to one question: Who is this design for? Tell me the organisation's name.");
    expect(await opened(chat)).toBe(0);
    expect(await intake(chat, 'KAAE')).toMatchObject({ lifecycleAction: 'open-request' });
  });

  it('"anyone" alone still lets the office choose', async () => {
    const chat = chatId();
    await intake(chat, NO_CLIENT_BRIEF);
    expect(await intake(chat, 'anyone')).toMatchObject({ lifecycleAction: 'open-request' });
  });
});

describe('class 4 (J2): a cancel while the brief waits for "who is it for?" is asked, and "yes" drops the brief', () => {
  it('"cancel it", then "yes": the kept brief never opens, not even when the question times out', async () => {
    const chat = chatId();
    await intake(chat, NO_CLIENT_BRIEF);
    const brief = nextUpdate;
    // Before: "There's nothing open for me to cancel right now.", and the brief opened for the office 30 minutes later.
    const asked = await intake(chat, 'cancel it');
    expect(asked).toMatchObject({ choiceRequired: true, chatAnswer: { text: 'Do you want me to cancel <b>Nawroz Celebration</b>?' } });
    const yes = await intake(chat, 'yes');
    expect(yes.chatAnswer.text).toBe('Cancelled <b>Nawroz Celebration</b>. Nothing more will be made for it.');
    expect(await withRlsContext(db, scope, (trx) => clientQuestionTimeout(trx, tenantId, brief, Date.now() + 31 * 60_000)))
      .toEqual({ kind: 'skip' });
    expect(await opened(chat)).toBe(0);
  });

  it('"no" keeps it waiting for the answer', async () => {
    const chat = chatId();
    await intake(chat, NO_CLIENT_BRIEF);
    await intake(chat, 'never mind');
    const no = await intake(chat, 'no');
    expect(no.chatAnswer.text).toMatch(/is waiting for your answer to one question: Who is this design for\?/);
    expect(await intake(chat, 'KAAE')).toMatchObject({ lifecycleAction: 'open-request' });
  });
});

describe('class 5 (J2): Arabic cancel words are asked about as a cancel, never "a change or a new design?"', () => {
  it.each([
    // "Cancel the design please" (Arabic)
    'ألغِ التصميم من فضلك',
    // "We don't need it any more" (Arabic)
    'لا نحتاجه بعد الآن',
  ])('"%s"', async (words) => {
    const chat = chatId();
    const { requestId } = await seed(chat, 'KAAE: Book Fair', 'designing');
    const asked = await intake(chat, words);
    expect(asked.choiceRequired).toBe(true);
    // "Do you want me to cancel <b>Book Fair</b>?" (Sorani: Arabic script is answered in Sorani)
    expect(asked.chatAnswer.text).toBe('دەتەوێت <b>Book Fair</b> هەڵبوەشێنمەوە؟');
    expect(await stageOf(requestId)).toBe('designing');
  });
});

describe('class 6 (J3): "less text" and "lose the subtitle" are changes, kept with the design', () => {
  it.each(['less text please', 'can we lose the subtitle'])('"%s"', async (words) => {
    const chat = chatId();
    const { requestId } = await seed(chat, 'KAAE: Book Fair', 'in_review');
    const answer = await intake(chat, words);
    expect(answer).toMatchObject({ lifecycleAction: 'late-change', requestId });
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, requestId))).toHaveLength(1);
  });
});

describe('class 7 (J6/J1): words that only say the requester is unhappy go to the office; never thanks, a question or a round', () => {
  it.each(["I don't like it", 'looks cheap', 'not quite', 'hmm not what I expected', 'meh', 'too busy',
    // "The design is ugly" (Sorani)
    'دیزاینەکە ناشیرینە'])('"%s"', async (words) => {
    const chat = chatId();
    const { requestId } = await seed(chat, 'KAAE: Book Fair', 'in_review');
    const answer = await intake(chat, words);
    expect(answer.lifecycleAction).toBe('chat-answer');
    expect(answer.choiceRequired).toBeUndefined();
    expect(answer.chatAnswer.text).not.toMatch(/thank|سوپاس|a new design|دیزاینێکی نوێ/i);
    expect(answer.officeAlert?.text).toMatch(/not happy/);
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, requestId))).toHaveLength(0);
  });

  it('"not approved" while the design is still being made is passed to the office, never kept for the next round', async () => {
    const chat = chatId();
    const { requestId } = await seed(chat, 'KAAE: Book Fair', 'designing');
    // "Not approved" (Sorani)
    const answer = await intake(chat, 'پەسەند نییە');
    expect(answer.lifecycleAction).toBe('chat-answer');
    expect(answer.officeAlert?.text).toContain('پەسەند نییە');
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, requestId))).toHaveLength(0);
  });
});

describe('class 8 (J5): praise and closing wishes are thanks, never "a change or a new design?"', () => {
  it.each(['my boss is happy with it', 'the client loves it', 'have a nice day', 'not bad'])('"%s"', async (words) => {
    const chat = chatId();
    await seed(chat, 'KAAE: Book Fair', 'in_review');
    const answer = await intake(chat, words);
    expect(answer.choiceRequired).toBeUndefined();
    expect(answer.chatAnswer.text).toMatch(/^🙏 Thank you\./);
  });
});

/** The draft a kept brief opened with (its open decision's, as Core holds it). */
const openedDrafts = async (chat: number) => (await withRlsContext(db, scope, (trx) => sql<{ draft: Record<string, any> }>`SELECT payload->'draft' AS draft
  FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_open'
    AND payload->>'chatId' = ${String(chat)}`.execute(trx))).rows.map((r) => r.draft);

describe('class 9 (J1): a change while the brief waits for "who is it for?" is kept with the brief, never "no longer open"', () => {
  it('"make the title bigger": noted, the question again; it opens with the brief', async () => {
    const chat = chatId();
    expect(await intake(chat, NO_CLIENT_BRIEF)).toMatchObject({ clientQuestion: true });
    // Before: "I've passed your message to the office", and an office alert that the design "is no longer open".
    const answer = await intake(chat, 'make the title bigger');
    expect(answer.lifecycleAction).toBe('chat-answer');
    expect(answer.officeAlert).toBeUndefined();
    expect(answer.chatAnswer.text).toBe("Got it. I've kept that with <b>Nawroz Celebration</b>. Who is this design for? Tell me the organisation's name.");
    expect(await opened(chat)).toBe(0);
    expect(await intake(chat, 'KAAE')).toMatchObject({ lifecycleAction: 'open-request' });
    const [draft] = await openedDrafts(chat);
    expect(draft.rawText).toContain('make the title bigger');
    expect(draft.designInstructions).toContain('make the title bigger');
    expect(JSON.stringify([draft.title, draft.exactCopy])).not.toContain('bigger');
  });

  it('the kept change opens with the brief when the question times out too', async () => {
    const chat = chatId();
    await intake(chat, NO_CLIENT_BRIEF);
    const brief = nextUpdate;
    await intake(chat, 'can you make the logo larger');
    const due = await withRlsContext(db, scope, (trx) => clientQuestionTimeout(trx, tenantId, brief, Date.now() + 31 * 60_000));
    expect(due).toMatchObject({ kind: 'open' });
    const { clientQuestionNotes } = await import('../src/services/lifecycle-client-question.js');
    expect((await withRlsContext(db, scope, (trx) => clientQuestionNotes(trx, tenantId, brief))).map((n) => n.words))
      .toEqual(['can you make the logo larger']);
  });
});

describe('class 10 (J1): a deadline while the brief waits is kept with the brief; its words are never lost', () => {
  it('"need it by tomorrow": "Noted — by tomorrow." and the question; it opens with the brief', async () => {
    const chat = chatId();
    await intake(chat, NO_CLIENT_BRIEF);
    // Before: the waiting question came back, and "need it by tomorrow" reached nobody.
    const answer = await intake(chat, 'need it by tomorrow');
    expect(answer.lifecycleAction).toBe('chat-answer');
    expect(answer.chatAnswer.text).toBe("Noted — by tomorrow. Who is this design for? Tell me the organisation's name.");
    expect(await opened(chat)).toBe(0);
    expect(await intake(chat, 'KAAE')).toMatchObject({ lifecycleAction: 'open-request' });
    const [draft] = await openedDrafts(chat);
    expect(draft.rawText).toContain('need it by tomorrow');
    expect(JSON.stringify([draft.title, draft.exactCopy])).not.toMatch(/tomorrow|Need It/);
  });

  it('"it\'s urgent": noted with the brief', async () => {
    const chat = chatId();
    await intake(chat, NO_CLIENT_BRIEF);
    const answer = await intake(chat, "it's urgent");
    expect(answer.chatAnswer.text).toMatch(/^Noted\. I've kept the timing with <b>Nawroz Celebration<\/b>\. Who is this design for\?/);
    expect(await opened(chat)).toBe(0);
  });
});

describe('class 11 (J1): a bare organisation name with nothing open asks what to design for it; it opens nothing', () => {
  it.each([['Erbil Chess Club', 'Erbil Chess Club'], ['Erbil Chess Club.', 'Erbil Chess Club'], ['for Erbil Chess Club', 'Erbil Chess Club'],
    ["It's for the Erbil Chess Club", 'Erbil Chess Club'], ['Kurdistan Engineers Union', 'Kurdistan Engineers Union'], ['KAAE', 'KAAE']])('"%s"', async (words, name) => {
    const chat = chatId();
    // Before: "KAAE" and "for Erbil Chess Club" opened a request for a designer; "It's for the Erbil Chess Club" went to
    // the office as words about a design "no longer open"; "Erbil Chess Club" was greeted as if nothing was said.
    const answer = await intake(chat, words);
    expect(answer.lifecycleAction).toBe('chat-answer');
    expect(answer.officeAlert).toBeUndefined();
    expect(answer.chatAnswer.text).toBe(`What would you like designed for <b>${name}</b>? Tell me in your own words, with the text that should go on it.`);
    expect(await opened(chat)).toBe(0);
  });

  it('the brief that follows is for that organisation: never asked "who is this design for?"', async () => {
    const chat = chatId();
    await intake(chat, 'KAAE');
    expect(await intake(chat, NO_CLIENT_BRIEF)).toMatchObject({ lifecycleAction: 'open-request' });
    const other = chatId();
    await intake(other, 'Erbil Chess Club');
    const answer = await intake(other, NO_CLIENT_BRIEF);
    expect(answer.clientQuestion).toBeUndefined();
    expect(answer.lifecycleAction).toBe('open-request');
  });

  it('a brief that names the organisation still opens as before', async () => {
    const chat = chatId();
    const answer = await intake(chat, 'Logo for Erbil Chess Club');
    expect(answer.chatAnswer?.text ?? '').not.toMatch(/^What would you like designed for/);
  });
});

describe('class 12 (J3): a visual complaint that names a part of the design is a change to it, never "change or new?"', () => {
  it.each(['the logo looks squashed', 'the title is too small', 'the photo is blurry', 'text is cut off', 'the font looks stretched',
    'background is too dark'])('"%s"', async (words) => {
    const chat = chatId();
    const { requestId } = await seed(chat, 'KAAE: Book Fair', 'in_review');
    const answer = await intake(chat, words);
    expect(answer.choiceRequired).toBeUndefined();
    expect(answer).toMatchObject({ lifecycleAction: 'late-change', requestId });
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, requestId))).toHaveLength(1);
  });
});

