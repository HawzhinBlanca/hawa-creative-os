import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { CONVERSATION_MESSAGES, MEDIA_MESSAGES, ROUTING_MESSAGES } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { undoesWithdrawal, UNDO_WINDOW_MS } from '../src/services/lifecycle-chat-answers.js';
import { asksToUndoCancel, classifyWithHeuristics, isAcknowledgement, isNegativeReaction, readsAsUndo } from '../src/services/telegram-classifier.js';

/**
 * ADR-252: requester replies from bug hunt 2 (2026-10-02, production 1e0616f0). Each test names its
 * friction item; the phrases are the hunt's own.
 *
 *  - 7: after a withdrawal, "undo that", "bring it back", "actually continue" got the new-design greeting.
 *  - 8: "👎", "😡", "❌" were answered "🙏 Thank you."
 *  - 9: after a draft, "no", "hmm", "continue" got the new-design greeting.
 *  - 11 (edit part): an edit's "your design" stayed English inside a Sorani answer.
 *  - 13: an edited approval became a change that held Deliver; an edit to a delivered design's words
 *    said the new words were "used".
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const OFFICE = 91000252;
const REQUESTER = 92000252;
const WORKER = ['worker', 'replies', 'fixture', 'token'].join('_');
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

const chatId = () => 65_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_200_000_000 + Math.floor(Math.random() * 800_000_000);
type Msg = Record<string, unknown>;
const message = (chat: number, text: string) => {
  const id = updateId();
  return { update_id: id, message: { message_id: id % 1_000_000, date: 1790000000, chat: { id: chat, type: 'private' },
    from: { id: REQUESTER, is_bot: false, first_name: 'Shno' }, text } as Msg } as { update_id: number; message: Msg };
};
const edited = (original: { update_id: number; message: Msg }, text: string) =>
  ({ update_id: updateId(), edited_message: { ...original.message, edit_date: 1790000100, text } });

function app() {
  vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
  return createApp({ db } as any);
}
const intake = async (a: any, update: unknown) => {
  const res = await a.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker,
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) });
  return (await res.json()) as Record<string, any>;
};

/** A lifecycle request of this chat at `stage`, last moved `minutesAgo` minutes ago. */
async function seedRequest(chat: number, stage: string, opts: { title?: string; minutesAgo?: number } = {}) {
  const requestId = randomUUID();
  const title = opts.title ?? 'KAAE members evening';
  const created = await persistChatIntake(db, { platform: 'telegram', sourceEventId: `lc-seed-${requestId}`, sourceChannelId: String(chat),
    rawText: title, title, clientId, designInstructions: 'Make the event design',
    exactCopy: [{ text: 'December 4, 2026' }], autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 } },
  { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id)
      VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, null, 'restate', ${stage}, 3, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  if (opts.minutesAgo) {
    await sql`UPDATE hawa.requests SET created_at = now() - make_interval(mins => ${opts.minutesAgo + 1}),
      updated_at = now() - make_interval(mins => ${opts.minutesAgo}) WHERE request_id = ${requestId}::uuid`.execute(owner);
  }
  return { requestId, taskId };
}
const lateChanges = async (requestId: string) => (await sql<{ n: string }>`SELECT count(*)::text AS n FROM hawa.inbox_events
  WHERE tenant_id = ${tenantId}::uuid AND payload->'late'->>'requestId' = ${requestId}`.execute(owner)).rows[0].n;

const greeting = CONVERSATION_MESSAGES.greeting.en;

describe('friction 9: short words after a draft', () => {
  it.each(['no', 'hmm', 'continue', 'nope'])('"%s" after a draft hears where it is, never the greeting', async (words) => {
    const a = app();
    const chat = chatId();
    await seedRequest(chat, 'in_review');
    const said = await intake(a, message(chat, words));
    expect(said).toMatchObject({ lifecycleAction: 'chat-answer' });
    expect(said.chatAnswer.text).not.toBe(greeting);
    expect(said.chatAnswer.text).toContain('<b>KAAE members evening</b> is with the office for a final check');
    expect(said.chatAnswer.text).toContain(ROUTING_MESSAGES.tellWhatToChange.en);
  });

  it('"I like it" after a draft is thanks', async () => {
    const a = app();
    const chat = chatId();
    await seedRequest(chat, 'in_review');
    const said = await intake(a, message(chat, 'I like it'));
    expect(said.chatAnswer.text).toContain('🙏 Thank you.');
    expect(said.chatAnswer.text).not.toContain('What would you like designed');
  });

  it('a design delivered today is a recent draft too', async () => {
    const a = app();
    const chat = chatId();
    await seedRequest(chat, 'delivered', { minutesAgo: 30 });
    const said = await intake(a, message(chat, 'hmm'));
    expect(said.chatAnswer.text).toContain('<b>KAAE members evening</b> has been delivered.');
  });

  it('a chat with nothing going on is still greeted', async () => {
    const a = app();
    const said = await intake(a, message(chatId(), 'hmm'));
    expect(said.chatAnswer.text).toBe(greeting);
  });
});

describe('friction 8: an unhappy emoji', () => {
  it.each(['👎', '😡', '❌', '👎🏽'])('"%s" is not thanks', (emoji) => {
    expect(isAcknowledgement(emoji)).toBe(false);
    expect(isNegativeReaction(emoji)).toBe(true);
    expect(classifyWithHeuristics(emoji, true, true).reason).not.toBe('Acknowledgement');
  });
  it.each(['👍', '👍🏻', '🙏', '❤️'])('"%s" is still thanks', (emoji) => {
    expect(isAcknowledgement(emoji)).toBe(true);
    expect(isNegativeReaction(emoji)).toBe(false);
  });

  it.each(['👎', '😡', '❌'])('"%s" after a draft goes to the office, and nothing is changed', async (emoji) => {
    const a = app();
    const chat = chatId();
    const { requestId } = await seedRequest(chat, 'in_review');
    const update = message(chat, emoji);
    const said = await intake(a, update);
    expect(said).toMatchObject({ lifecycleAction: 'chat-answer', chatAnswer: { text: ROUTING_MESSAGES.unhappyPassed.en } });
    expect(said.chatAnswer.text).not.toContain('Thank you');
    expect(said.officeAlert).toMatchObject({ chatId: String(OFFICE) });
    expect(said.officeAlert.text).toContain('Shno sent an emoji that says they are not happy, after "KAAE members evening"');
    expect(said.officeAlert.text).toContain(emoji);
    expect(await lateChanges(requestId)).toBe('0');
    // A repeated update says the same, and still tells the office.
    expect(await intake(a, update)).toMatchObject({ chatAnswer: { text: ROUTING_MESSAGES.unhappyPassed.en },
      officeAlert: { chatId: String(OFFICE) } });
  });

  it('with no design open, the office still hears it', async () => {
    const a = app();
    const said = await intake(a, message(chatId(), '👎'));
    expect(said.chatAnswer.text).toBe(ROUTING_MESSAGES.unhappyPassed.en);
    expect(said.officeAlert.text).toContain('with no design open in the chat');
  });
});

describe('friction 7: taking back a cancel', () => {
  it.each(['actually continue', 'undo that', 'bring it back', 'continue please', 'بەردەوام بە'])(
    'reads "%s" as taking back a cancel only right after one', (words) => {
      expect(readsAsUndo(words)).toBe(true);
      const now = Date.now();
      const withdrawn = { requestId: 'r', taskId: 't', title: 'Nawroz poster', at: new Date(now - 60_000).toISOString() };
      const older = [{ activeAt: new Date(now - 10 * 60_000).toISOString() }] as any;
      const newer = [{ activeAt: new Date(now - 10_000).toISOString() }] as any;
      expect(undoesWithdrawal(words, withdrawn, older, now)).toBe(true);
      // A design that moved after the cancel is what short words are about.
      expect(undoesWithdrawal(words, withdrawn, newer, now)).toBe(false);
      expect(undoesWithdrawal(words, { ...withdrawn, at: new Date(now - UNDO_WINDOW_MS - 1000).toISOString() }, [], now)).toBe(false);
      expect(undoesWithdrawal(words, null, [], now)).toBe(false);
    });
  it('words that name the cancel take it back even after another design moved', () => {
    const now = Date.now();
    const withdrawn = { requestId: 'r', taskId: 't', title: 'Nawroz poster', at: new Date(now - 60_000).toISOString() };
    expect(asksToUndoCancel('sorry I cancelled by mistake, please continue')).toBe(true);
    expect(undoesWithdrawal('sorry I cancelled by mistake, please continue', withdrawn,
      [{ activeAt: new Date(now).toISOString() }] as any, now)).toBe(true);
  });
  it.each(['cancel it, I sent it by mistake', 'please cancel the poster, it was by mistake', 'undo the last change',
    'bring back the old logo', 'no', 'hmm'])('"%s" does not take back a cancel', (words) => {
    expect(asksToUndoCancel(words)).toBe(false);
    if (words !== 'undo the last change' && words !== 'bring back the old logo') expect(readsAsUndo(words)).toBe(false);
  });

  // Live 2026-10-02 07:05Z (canary chat): the only design had just been cancelled, and "oops, bring it back"
  // was read as a new brief and asked who the design was for.
  it.each(['oops, bring it back', 'actually continue', 'ok undo that'])('"%s" when the only design was just cancelled is about that design, never a new brief', async (words) => {
    const a = app();
    const chat = chatId();
    const cancelled = await seedRequest(chat, 'cancelled', { title: 'Nawroz poster', minutesAgo: 1 });
    const said = await intake(a, message(chat, words));
    expect(said).toMatchObject({ lifecycleAction: 'chat-answer', requestId: cancelled.requestId });
    expect(said.chatAnswer.text).toBe(ROUTING_MESSAGES.undoPassed.en.replace('{title}', '<b>Nawroz poster</b>'));
  });

  it.each(['actually continue', 'undo that', 'bring it back'])('"%s" just after a cancel is told the truth, and the office hears it', async (words) => {
    const a = app();
    const chat = chatId();
    const open = await seedRequest(chat, 'in_review', { title: 'KAAE graduation flyer', minutesAgo: 20 });
    const cancelled = await seedRequest(chat, 'cancelled', { title: 'Nawroz poster', minutesAgo: 2 });
    const said = await intake(a, message(chat, words));
    expect(said).toMatchObject({ lifecycleAction: 'chat-answer', requestId: cancelled.requestId });
    expect(said.chatAnswer.text).toBe(ROUTING_MESSAGES.undoPassed.en.replace('{title}', '<b>Nawroz poster</b>'));
    expect(said.chatAnswer.text).not.toBe(greeting);
    expect(said.officeAlert.text).toContain('Shno asked to go ahead with "Nawroz poster" after all; it was cancelled 2 minutes ago.');
    expect(said.officeAlert.text).toContain('nothing was restarted and no other design was changed');
    expect(await lateChanges(open.requestId)).toBe('0');
  });

  it('a cancel longer ago than the window is not what "continue" is about', async () => {
    const a = app();
    const chat = chatId();
    await seedRequest(chat, 'in_review', { title: 'KAAE graduation flyer', minutesAgo: 90 });
    await seedRequest(chat, 'cancelled', { title: 'Nawroz poster', minutesAgo: 45 });
    const said = await intake(a, message(chat, 'continue'));
    expect(said.chatAnswer.text).toContain('<b>KAAE graduation flyer</b> is with the office');
    expect(said.officeAlert).toBeUndefined();
  });

  // The words name a mistake, so the requester rules (requester-turn.ts, readIntentByRules) read them as a
  // change and keep them on the open flyer before this answer is asked. ADR-252 hands the reading over:
  // readIntentByRules must read `asksToUndoCancel(core)` as conversation before its change rules. When it
  // does, this starts failing: make it a plain `it`.
  it('"sorry I cancelled by mistake, please continue" is never kept on another open design', async () => {
    const a = app();
    const chat = chatId();
    const open = await seedRequest(chat, 'in_review', { title: 'KAAE graduation flyer', minutesAgo: 20 });
    await seedRequest(chat, 'cancelled', { title: 'Nawroz poster', minutesAgo: 2 });
    const said = await intake(a, message(chat, 'sorry I cancelled by mistake, please continue'));
    expect(await lateChanges(open.requestId)).toBe('0');
    expect(said.chatAnswer.text).toBe(ROUTING_MESSAGES.undoPassed.en.replace('{title}', '<b>Nawroz poster</b>'));
  });
});

describe('friction 13 and 11: edited messages', () => {
  it('an edited approval is read again, and holds nothing for the office', async () => {
    const a = app();
    const chat = chatId();
    const { requestId } = await seedRequest(chat, 'in_review');
    const approval = message(chat, 'Approved, please send it');
    expect(await intake(a, approval)).toMatchObject({ lifecycleAction: 'chat-answer', note: 'approval' });
    const said = await intake(a, edited(approval, 'Approved, thank you!'));
    expect(said.lifecycleAction).toBe('chat-answer');
    expect(said.code).not.toBe('LATE_REQUESTER_CHANGE');
    expect(said.chatAnswer.text).not.toContain('I saw your edit');
    expect(await lateChanges(requestId)).toBe('0');
  });

  it('an approval edited into a change is the change', async () => {
    const a = app();
    const chat = chatId();
    const { requestId } = await seedRequest(chat, 'in_review');
    const approval = message(chat, 'Approved, please send it');
    await intake(a, approval);
    const said = await intake(a, edited(approval, 'approved, but make the logo bigger'));
    expect(said).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestId });
  });

  it('an edit to the words of a delivered design does not say they are used', async () => {
    const a = app();
    const chat = chatId();
    const { requestId } = await seedRequest(chat, 'delivered', { minutesAgo: 10 });
    const change = message(chat, 'please change the date to 5 November');
    expect(await intake(a, change)).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestId });
    const said = await intake(a, edited(change, 'please change the date to 6 November'));
    expect(said).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestId });
    expect(said.chatAnswer.text).toBe(MEDIA_MESSAGES.editPassedDelivered.en.replace('{title}', '<b>KAAE members evening</b>'));
    expect(said.chatAnswer.text).not.toContain("so it's used");
  });

  it('a design with no name of its own is named in Sorani inside a Sorani answer', async () => {
    const a = app();
    const chat = chatId();
    const { requestId } = await seedRequest(chat, 'in_review', { title: 'New design request from Shno' });
    const change = message(chat, 'بەروارەکە بگۆڕە بۆ ٥ی تشرینی دووەم');
    expect(await intake(a, change)).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestId });
    const said = await intake(a, edited(change, 'بەروارەکە بگۆڕە بۆ ٦ی تشرینی دووەم'));
    expect(said.chatAnswer.text).toBe(MEDIA_MESSAGES.editPassed.ckb.replace('{title}', '<b>دیزاینەکەت</b>'));
    expect(said.chatAnswer.text).not.toContain('your design');
  });
});
