import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import type { ChatIntake } from '../src/services/chat-intake.js';
import { capitalFirst, extractRequestCopy, groundLine } from '../src/services/request-copy-extraction.js';

/**
 * ADR-235 (owner decisions, 2026-10-01).
 * 1. "Capitalize first letters": a line taken from a request sentence starts with a capital when its first
 *    character is a lower-case Latin letter; nothing else changes.
 * 2. "Ask who it's for": a brief from a chat bound to no organisation, whose words name none, is kept and
 *    its sender is asked who it is for (organisations listed only in an office member's own chat). The
 *    answer opens the kept brief for that organisation, or for the office to choose; never guessed, never
 *    opened twice. Live: "Could you design a poster for our Teacher Appreciation Day? …" opened silently
 *    for a designer ("Got it. A designer will make Teacher Appreciation Day…").
 * Intake runs against the per-file test database as hawa_app (row-level security as in production).
 */
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const TEACHER = 'Could you design a poster for our Teacher Appreciation Day? It\'s on 20 October 2026 at 2:00 PM in the Rotana Hotel ballroom, Erbil. All teachers are welcome.';
const texts = (draft: { exactCopy: unknown[] }) => (draft.exactCopy as Array<{ text: string }>).map((b) => b.text);
const prepared = (text: string, extra: Partial<ChatIntake> = {}): ChatIntake => ({ platform: 'telegram', sourceEventId: 'lc-x-r0',
  sourceChannelId: '64000001', rawText: text, title: 'KAAE: request', clientId: KAAE, designInstructions: '',
  exactCopy: [{ id: 'copy_0', role: 'headline', text }], autoGenerate: true, ...extra });
const ctx = { model: null, tenantId: 't', updateId: 1, senderName: 'Requester' };

describe('first letters are capitals; nothing else changes (ADR-235)', () => {
  it('a lower-case Latin first letter only: Sorani, digits, capitals and the rest of the line as typed', () => {
    expect(capitalFirst('for school principals')).toBe('For school principals');
    expect(capitalFirst('final on 30 October 2026 at 5 PM')).toBe('Final on 30 October 2026 at 5 PM');
    expect(capitalFirst('iPhone workshop')).toBe('IPhone workshop');
    for (const kept of ['KAAE hall, Erbil', '15 October 2026 · 10:00 AM', 'هۆڵی KAAE، هەولێر', '٢٠ی تشرینی یەکەم', '(free entry)', ''])
      expect(capitalFirst(kept)).toBe(kept);
  });

  it('extracted lines start with a capital, the receipt names them, and the guard still accepts them', async () => {
    const words = 'can u make a quick KAAE post for the staff football tournament? final on 30 October 2026 at 5 PM';
    const draft = await extractRequestCopy(prepared(words), ctx);
    expect(texts(draft)).toEqual(['Staff football tournament', 'Final on 30 October 2026 at 5 PM']);
    expect(draft).toMatchObject({ title: 'KAAE: Staff football tournament',
      copyExtraction: { capitalised: ['staff football tournament', 'final on 30 October 2026 at 5 PM'] } });
    for (const line of texts(draft)) expect(groundLine(words, line)).toMatchObject({ ok: true });
  });

  it('quoted copy and copy the requester laid out are never changed', async () => {
    const quoted = await extractRequestCopy(prepared('Could you design a flyer that says "grand opening sale" and "50% off"?'), ctx);
    expect(texts(quoted)).toEqual(['grand opening sale', '50% off']);
    expect(quoted.copyExtraction).not.toHaveProperty('capitalised');
    const laidOut = prepared('assessment literacy workshop', { exactCopy: [{ text: 'assessment literacy workshop' }, { text: 'for school principals' }] });
    expect(await extractRequestCopy(laidOut, ctx)).toBe(laidOut);
  });
});

// --- who a design is for -------------------------------------------------------------------------------

const tenantId = '00000000-0000-4000-a000-000000000001';
const operatorUserId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
const OWNER = 91000007;
const OUTSIDER = 91000555;
const WORKER = ['worker', 'client', 'fixture', 'token'].join('_');
const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OWNER);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { process.env = saved; await db.destroy(); });

let next = 1_100_000_000 + Math.floor(Math.random() * 700_000_000);
const outsiderChat = () => 68_000_000 + Math.floor(Math.random() * 9_000_000);
const message = (chat: number, from: number, text: string, extra: Record<string, unknown> = {}) => {
  const id = ++next;
  return { update_id: id, message: { message_id: id % 100000, from: { id: from, is_bot: false, first_name: 'Sewa' },
    chat: { id: chat, type: 'private' }, date: 1790000000, text, ...extra } };
};
const app = () => { vi.stubEnv('HAWA_WORKER_TOKEN', WORKER); return createApp({ db, requesterIntentModel: null } as any); };
const intake = async (update: unknown) => (await (await app().request('/v1/internal/telegram/intake', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` },
  body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) })).json()) as Record<string, any>;
/** The bot's answer to an update was sent as this Telegram message (ChatInbox records it so). */
const sentAnswer = (updateId: number, messageId: number) => withRlsContext(db, scope, (trx) => sql`INSERT INTO hawa.inbox_events
  (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
  VALUES (${tenantId}::uuid, 'telegram_delivery', ${`lc:chatinbox:${updateId}:send`}, 'telegram_message_sent',
    ${JSON.stringify({ messageId: String(messageId) })}::jsonb, ${`client-question-${updateId}`}, true)`.execute(trx));
const replyTo = (messageId: number) => ({ reply_to_message: { message_id: messageId, from: { id: 7000001, is_bot: true, first_name: 'Hawa' } } });
const ASK_EN = "Who is this design for? Tell me the organisation's name.";
/**
 * ADR-284 addendum (live canary 2026-10-03): when the office chooses the organisation, Core says nothing beside the
 * open; RequestLifecycle's first answer says it, with "a designer will make …", in one message. Core's first
 * projection of the request tells it how the question ended (`clientChoice`).
 */
const clientChoiceOf = async (open: Record<string, any>) => {
  const res = await app().request(`/v1/internal/lifecycle/${open.requestId}/project`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` },
    body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${open.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: open.draft }] }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { clientChoice?: unknown }).clientChoice;
};

describe('a brief that names no organisation asks who it is for (ADR-235)', () => {
  it('the live sentence in the owner\'s office chat: kept, asked with the names; "KAAE" opens it for KAAE, once', async () => {
    const brief = message(OWNER, OWNER, TEACHER);
    const asked = await intake(brief);
    expect(asked).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', clientQuestion: true });
    expect(asked.chatAnswer.text.startsWith(ASK_EN)).toBe(true);
    expect(asked.chatAnswer.text).toContain('The ones I know:');
    expect(asked.chatAnswer.text).toMatch(/<b>[^<]*\(KAAE\)<\/b>/);
    expect(asked).not.toHaveProperty('requestId');
    // The brief replayed: the same question, nothing opened.
    expect(await intake(brief)).toMatchObject({ lifecycleAction: 'chat-answer', chatAnswer: { text: asked.chatAnswer.text } });

    const answer = message(OWNER, OWNER, 'KAAE');
    const opened = await intake(answer);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', duplicate: false,
      draft: { clientId: KAAE, autoGenerate: true, rawText: TEACHER, title: 'KAAE: Teacher Appreciation Day' } });
    expect(texts(opened.draft)).toEqual(['Teacher Appreciation Day', '20 October 2026 at 2:00 PM in the Rotana Hotel ballroom, Erbil', 'All teachers are welcome']);
    // Replays: the answer opens nothing new; the brief still only asks; "KAAE" again is not an answer.
    expect(await intake(answer)).toMatchObject({ duplicate: true, requestId: opened.requestId });
    expect(await intake(brief)).toMatchObject({ lifecycleAction: 'chat-answer', duplicate: true });
    const again = await intake(message(OWNER, OWNER, 'KAAE'));
    expect(again.draft?.rawText).not.toBe(TEACHER);
  });

  it('a chat outside the office is asked without any organisation\'s name', async () => {
    const chat = outsiderChat();
    const asked = await intake(message(chat, OUTSIDER, TEACHER));
    expect(asked).toMatchObject({ lifecycleAction: 'chat-answer', clientQuestion: true, chatAnswer: { text: ASK_EN } });
    expect(asked.chatAnswer.text).not.toMatch(/KAAE|<b>/);
  });

  it('a Sorani answer, as a reply to the question, opens it for the organisation it names', async () => {
    const chat = outsiderChat();
    const brief = message(chat, OUTSIDER, TEACHER);
    await intake(brief);
    await sentAnswer(brief.update_id, 4401);
    // "It's for the accreditation (body)"
    const opened = await intake(message(chat, OUTSIDER, 'بۆ دەستەی باوەڕپێدانە', replyTo(4401)));
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: KAAE, rawText: TEACHER } });
  });

  it('"not sure", or an organisation nobody knows, opens it for the office to choose, and says so', async () => {
    for (const [words, lang] of [['not sure', 'en'], ['نازانم', 'ckb']] as const) {
      const chat = outsiderChat();
      await intake(message(chat, OUTSIDER, TEACHER));
      const opened = await intake(message(chat, OUTSIDER, words));
      expect(opened, words).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: null, autoGenerate: false, rawText: TEACHER } });
      expect(opened, words).not.toHaveProperty('notice');
      expect(await clientChoiceOf(opened), words).toEqual({ outcome: 'office', lang });
    }
    const chat = outsiderChat();
    const brief = message(chat, OUTSIDER, TEACHER);
    await intake(brief);
    await sentAnswer(brief.update_id, 4402);
    const unknown = await intake(message(chat, OUTSIDER, 'The Erbil Teachers Union', replyTo(4402)));
    expect(unknown).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: null, autoGenerate: false } });
    expect(await clientChoiceOf(unknown)).toEqual({ outcome: 'unmatched', lang: 'en' });
  });

  it('live 2026-10-03: an organisation nobody knows, named without a reply, still answers the question', async () => {
    // The canary answered "It's for the Erbil Chess Club" without replying; it was taken as words about an
    // old design and passed to the office, and the brief was never opened.
    for (const words of ["It's for the Erbil Chess Club", 'Erbil Chess Club', 'Sulaimani Rotary', 'for my company', 'the UNDP office']) {
      const chat = outsiderChat();
      await intake(message(chat, OUTSIDER, TEACHER));
      const opened = await intake(message(chat, OUTSIDER, words));
      expect(opened, words).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: null, autoGenerate: false, rawText: TEACHER } });
      expect(await clientChoiceOf(opened), words).toEqual({ outcome: 'unmatched', lang: 'en' });
    }
    // Small talk is no organisation's name: the question stays open and the brief is not opened.
    for (const words of ['hello', 'Great', 'Good Morning', 'wait', 'Thank You', 'its for us']) {
      const chat = outsiderChat();
      await intake(message(chat, OUTSIDER, TEACHER));
      const read = await intake(message(chat, OUTSIDER, words));
      expect(read.lifecycleAction, words).not.toBe('open-request');
    }
  });

  it('an answer after thirty minutes opens the kept brief for the office, and says it was a while', async () => {
    const chat = outsiderChat();
    await intake(message(chat, OUTSIDER, TEACHER));
    const later = Date.now() + 31 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const opened = await intake(message(chat, OUTSIDER, 'KAAE'));
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: null, autoGenerate: false, rawText: TEACHER } });
    expect(opened).not.toHaveProperty('notice');
    expect(await clientChoiceOf(opened)).toEqual({ outcome: 'expired', lang: 'en' });
  });

  it('a new brief sent instead is read as a new brief, and the answer then goes to the newest question', async () => {
    const chat = outsiderChat();
    await intake(message(chat, OUTSIDER, TEACHER));
    // A full brief that names KAAE opens its own request; it is not taken as the answer.
    const named = 'Could you design a KAAE poster for our Book Fair? 5 November 2026, KAAE library.';
    const own = await intake(message(chat, OUTSIDER, named));
    expect(own).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: KAAE, rawText: named } });
    // A new brief that names nobody is asked about in turn.
    const second = 'Could you make a flyer for our Science Camp? 1 April 2027 at 9:00 AM.';
    expect(await intake(message(chat, OUTSIDER, second))).toMatchObject({ lifecycleAction: 'chat-answer', clientQuestion: true });
    const opened = await intake(message(chat, OUTSIDER, 'KAAE'));
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: KAAE, rawText: second } });
  });
});

// --- nobody answers: the timeout (ADR-144: nothing is dropped) ------------------------------------------

const settleOf = async (update: unknown) => (await (await app().request('/v1/internal/telegram/intake', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` },
  body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true, briefHold: true, settle: true }) })).json()) as Record<string, any>;
const sweep = async () => ((await (await app().request('/v1/internal/telegram/settle-sweep', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` }, body: '{}' })).json()) as { due: Array<{ update: { update_id: number } }> }).due;
const at = (minutes: number) => vi.spyOn(Date, 'now').mockReturnValue(Date.parse(new Date().toISOString()) + minutes * 60_000);

describe('a question nobody answers times out and the brief opens for the office (ADR-235)', () => {
  it('unanswered: the settle opens it once for the office and says so once; replays and the sweep open nothing more', async () => {
    const chat = outsiderChat();
    const brief = message(chat, OUTSIDER, TEACHER);
    const asked = await intake(brief);
    // ChatInbox schedules the brief's settle for the question's timeout.
    expect(asked).toMatchObject({ clientQuestion: true, clientQuestionSettle: { delayMs: 30 * 60_000 } });
    // Early (a settle the sweep sent before its time): nothing, and the sweep does not list it yet.
    expect(await settleOf(brief)).toMatchObject({ settle: 'skipped' });
    expect((await sweep()).map((d) => d.update.update_id)).not.toContain(brief.update_id);
    at(31);
    // Lost delayed call: the sweep lists the question once it is due.
    expect((await sweep()).map((d) => d.update.update_id)).toContain(brief.update_id);
    const opened = await settleOf(brief);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', duplicate: false,
      draft: { clientId: null, autoGenerate: false, rawText: TEACHER } });
    // Said once, by the request's first answer (keyed by the request), with "a designer will make …".
    expect(opened).not.toHaveProperty('notice');
    expect(await clientChoiceOf(opened)).toEqual({ outcome: 'timeout', lang: 'en' });
    // Replays (the delayed call and the sweep's) give the same open and say nothing beside it.
    const again = await settleOf(brief);
    expect(again).toMatchObject({ duplicate: true, requestId: opened.requestId });
    expect(again).not.toHaveProperty('notice');
    expect((await sweep()).map((d) => d.update.update_id)).not.toContain(brief.update_id);
    // The brief replayed opens the same request.
    expect(await intake(brief)).toMatchObject({ duplicate: true, requestId: opened.requestId });
  });

  it('an answer just before the timeout wins: the settle then opens nothing', async () => {
    const chat = outsiderChat();
    const brief = message(chat, OUTSIDER, TEACHER);
    expect((await intake(brief)).clientQuestionSettle).toEqual({ delayMs: 30 * 60_000 });
    at(29);
    const answered = await intake(message(chat, OUTSIDER, 'KAAE'));
    expect(answered).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: KAAE, rawText: TEACHER } });
    at(31);
    expect(await settleOf(brief)).toMatchObject({ settle: 'skipped' });
    expect((await sweep()).map((d) => d.update.update_id)).not.toContain(brief.update_id);
  });

  it('an answer after the timeout names the organisation for the office and opens nothing again', async () => {
    const chat = outsiderChat();
    const brief = message(chat, OUTSIDER, TEACHER);
    await intake(brief);
    at(31);
    const opened = await settleOf(brief);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: null } });
    at(40);
    const late = await intake(message(chat, OUTSIDER, 'KAAE'));
    expect(late).toMatchObject({ lifecycleAction: 'chat-answer',
      chatAnswer: { text: expect.stringContaining("I've told the office that") } });
    expect(late.chatAnswer.text).toContain('Kurdistan Accrediting Association for Education');
    expect(late.officeAlerts?.[0]?.text ?? late.officeAlert?.text).toMatch(/is for Kurdistan Accrediting Association for Education/);
    expect(late).not.toHaveProperty('draft');
  });
});
