import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { reconsiderNewBrief } from '../src/services/brief-or-change.js';
import { planTurn, readIntentByRules, type ChatRequestView, type TurnInput, type TurnPlan } from '../src/services/requester-turn.js';

/**
 * Bug hunt 3 (2026-10-03), requester Telegram intake and conversation. Each block names the bug it pins;
 * every test failed before its fix.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const OFFICE = 91000301;
const REQUESTER = 91000303;
const WORKER = ['worker', 'hunt3', 'intake', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = `${OFFICE}`;
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { process.env = saved; await Promise.all([db.destroy(), owner.destroy()]); });

const chatId = () => 68_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_400_000_000 + Math.floor(Math.random() * 600_000_000);
const text = (chat: number, words: string, from = REQUESTER) => {
  const id = updateId();
  return { update_id: id, message: { message_id: id % 1_000_000, date: 1790000000,
    from: { id: from, is_bot: false, first_name: 'Hawzhin' }, chat: { id: chat, type: 'private' }, text: words } };
};
function app(extra: Record<string, unknown> = {}) {
  vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
  const bridge = { downloadFile: vi.fn(async () => Buffer.alloc(0)), dispatchOutboundMessage: vi.fn(async () => ({ success: true })),
    answerCallbackQuery: vi.fn(async () => true) };
  return createApp({ db, telegramBridge: bridge, requesterIntentModel: null, ...extra } as any);
}
const intake = async (a: any, update: unknown, body: Record<string, unknown> = {}) => {
  const res = await a.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker,
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true, briefHold: false, ...body }) });
  return (await res.json()) as Record<string, any>;
};
const opened = async (chat: number) => (await withRlsContext(db, scope, (trx) => sql<{ n: string }>`SELECT count(*) AS n
  FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_open'
    AND payload->>'chatId' = ${String(chat)}`.execute(trx))).rows[0].n;

/** A delivered request, older than the three days words other than redo words still mean it. */
async function seedDelivered(chat: number, title: string, daysAgo: number) {
  const requestId = randomUUID();
  const brief = { update_id: updateId(), message: { message_id: 700, from: { id: REQUESTER, is_bot: false, first_name: 'Hawzhin' },
    chat: { id: chat, type: 'private' }, date: 1790000000, text: title } };
  const created = await persistChatIntake(db, { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: String(chat),
    rawJson: brief, rawText: title, title, clientId, designInstructions: 'Make the event design',
    exactCopy: [{ text: title }], autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 },
    studioOptions: { tier: 'quality' } }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id)
      VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, null, 'restate', 'delivered', 6, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  await sql`UPDATE hawa.requests SET updated_at = now() - make_interval(days => ${daysAgo}) WHERE request_id = ${requestId}::uuid`.execute(owner);
  return { requestId, taskId };
}

// ---------------------------------------------------------------------------------------------------------
// The planner, as intake runs it (rules, planTurn, ADR-250's reconsiderNewBrief)
// ---------------------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-10-03T09:00:00Z');
const view = (requestId: string, stage: ChatRequestView['stage'], title: string): ChatRequestView => ({ requestId, stage, rev: 2,
  currentTaskId: `${requestId}-task`, clientId: 'kaae', title, activeAt: new Date(NOW - 5 * 60_000).toISOString(),
  createdAt: new Date(NOW - 6 * 60_000).toISOString(), question: null, requesterId: '1' });
function plan(words: string, requests: ChatRequestView[] = []): TurnPlan {
  const input: TurnInput = { text: words, reading: readIntentByRules(words), requests, bound: [], unboundReply: false, senderId: '1',
    officeIds: [], group: false, addressed: true, pendingAsk: null, now: NOW };
  const planned = planTurn(input);
  return reconsiderNewBrief(input, planned)?.plan ?? planned;
}

describe('hunt 3 / F1: with nothing on the way, words that are no brief never open a design', () => {
  // Said about a design delivered days ago (or about nothing): the rules cannot place them, and the heuristics
  // called them a brief, so they opened a request that drafted automatically, with the words as its copy.
  const NO_BRIEF = ['the event was cancelled', 'I don\'t like it', 'the poster looks cheap', 'bad', 'not bad',
    'amazing work thank you so much', 'looks good to me', 'can you show me other options', 'send me the poster',
    'it\'s ugly', 'the deadline is tomorrow', 'I need it for print', 'دیزاینەکە ناشیرینە'];
  it.each(NO_BRIEF)('"%s" opens nothing', (words) => {
    expect(plan(words)).not.toMatchObject({ kind: 'open' });
  });

  it('words with a subject of their own but no copy open for a person, never a paid draft', () => {
    for (const words of ['the KAAE alumni thing', 'something about Nawroz maybe']) {
      const p = plan(words);
      if (p.kind === 'open') expect(p.instructionOnly, words).toBe(true);
    }
  });

  it('a short brief with its copy still opens as before, and drafts', () => {
    expect(plan('Quality Assurance Workshop, 22 October')).toEqual({ kind: 'open', text: 'Quality Assurance Workshop, 22 October', instructionOnly: false });
    expect(plan('Erbil Book Fair 2026, 9 November at 10 am, Family Mall')).toMatchObject({ kind: 'open', instructionOnly: false });
  });

  it('through intake: a design delivered four days ago, then "the poster looks cheap": no request, no draft', async () => {
    const a = app();
    const chat = chatId();
    await seedDelivered(chat, 'KAAE: Quality Assurance Workshop', 4);
    const answer = await intake(a, text(chat, 'the KAAE poster looks cheap'));
    expect(answer.lifecycleAction).not.toBe('open-request');
    expect(answer.clientQuestion).toBeUndefined();
    expect(await opened(chat)).toBe('0');
    const cancelled = await intake(a, text(chat, 'the event was cancelled'));
    expect(cancelled.lifecycleAction).not.toBe('open-request');
    expect(cancelled.clientQuestion).toBeUndefined();
    expect(await opened(chat)).toBe('0');
  });
});


describe('hunt 3 / B1: a brief that ends with "send it to me" or "go ahead" is a brief, never approval words', () => {
  const BRIEFS = ['KAAE Chess Club tournament\n8 November 2026, 3 pm, Family Mall\n\nDon\'t forget the logo, and send it to me by Thursday.',
    'KAAE Chess Club tournament, 8 November 2026, 3 pm, Family Mall. Please send it to me by Thursday.',
    'Graduation ceremony 12 October 7pm Rotana Hotel. no changes needed to the logo',
    'Teacher Appreciation Day, 20 October 2026 at 2 pm, KAAE hall. Go ahead!'];
  it.each(BRIEFS)('%s', (words) => {
    expect(readIntentByRules(words).intent).not.toBe('approval');
    // With nothing on the way it opens; it was answered "Thank you." and nothing was opened.
    expect(plan(words)).toMatchObject({ kind: 'open' });
  });

  it('approval words that only mention the event stay approval words, told to the office', () => {
    for (const words of ['looks good, send it', 'perfect, send it, the ceremony is on 12 October', 'approved, print it for the 12 October ceremony']) {
      expect(readIntentByRules(words).intent, words).toBe('approval');
      expect(plan(words, [view('A', 'in_review', 'KAAE: Graduation ceremony')]), words).toMatchObject({ kind: 'tell', note: 'approval' });
    }
  });

  it('through intake: the brief opens a request', async () => {
    const chat = chatId();
    const answer = await intake(app(), text(chat, BRIEFS[1]));
    expect(answer).toMatchObject({ lifecycleAction: 'open-request' });
    // Its closing words to the designer are instructions, never printed (chat-campaign-intake.ts).
    expect(JSON.stringify(answer.draft.exactCopy)).not.toMatch(/send it to me/i);
    expect(answer.draft.designInstructions).toMatch(/Please send it to me by Thursday/);
  });
});

describe('hunt 3 / R1: words that change nothing never start a paid round on a design sent back for changes', () => {
  // A design the office sent back for the requester's changes: a change starts a paid round on it.
  const waiting = () => [{ ...view('A', 'manual', 'KAAE: Quality Assurance Workshop'), rev: 3 }];

  it.each(['can you also make one for the Book Fair on 9 November', 'make one more for the graduation on 12 October',
    'please make another for the Book Fair', 'can you make the same for the Science Fair on 12 November',
    'can you do one for the open day too'])('a design asked for with "one", "another" or "the same": "%s" opens a request', (words) => {
    expect(readIntentByRules(words).intent).toBe('new_brief');
    expect(plan(words, waiting())).toMatchObject({ kind: 'open' });
  });

  it.each(['did you put the date?', 'have you added the logo?', 'is the font Kurdish?', 'are the photos included?'])(
    'a yes-or-no question about the design is the office\'s question, never a round: "%s"', (words) => {
      expect(plan(words, waiting())).toMatchObject({ kind: 'forward', question: true });
    });

  it.each(['can you make it by tomorrow?', 'could you finish it by Thursday?', 'can you do it before 5 pm?'])('timing: "%s"', (words) => {
    expect(plan(words, waiting())).toMatchObject({ kind: 'tell', note: 'deadline' });
  });

  it('a change said as a question is still a change', () => {
    for (const words of ['can you make the title bigger?', 'is it possible to make the logo bigger?', 'could you add the phone number?',
      'can you make it blue by tomorrow?']) {
      expect(plan(words, waiting()), words).toMatchObject({ kind: 'revise' });
    }
  });
});

describe('hunt 3 / U1: event copy said as an update of the design on the way is asked about, never opened', () => {
  const QA = 'KAAE: Quality Assurance Workshop';
  it.each(['sorry the workshop date is 16 October 2026', "it's at the Divan hotel now, 16 October at 10 am",
    'we moved the workshop to the Divan Hotel on 16 October at 10 am', 'the seminar is on 16 October at 10 am in the main hall',
    'ئاهەنگەکە دواخرا بۆ ١٦ی تشرینی یەکەم'])('"%s"', (words) => {
    for (const stage of ['designing', 'in_review', 'awaiting_answer'] as const) {
      const p = plan(words, [view('A', stage, QA)]);
      expect(p.kind, `${stage}: ${JSON.stringify(p)}`).not.toBe('open');
      expect(p.kind, stage).not.toBe('revise');
    }
  });

  it('a new brief with its own event, date and place still opens while a draft waits', () => {
    expect(plan('Research ethics workshop for postgraduate students at the university hall, 20 October 2026 at 10 AM',
      [view('A', 'in_review', QA)])).toMatchObject({ kind: 'open' });
  });
});
