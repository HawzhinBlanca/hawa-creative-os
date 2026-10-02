import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { INTAKE_LIMIT_MESSAGES, MEDIA_MESSAGES } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { pendingLateChanges } from '../src/services/lifecycle-chat-target.js';
import { editsADesignOnTheWay, reconsiderNewBrief } from '../src/services/brief-or-change.js';
import { planTurn, readIntentByRules, type ChatRequestView } from '../src/services/requester-turn.js';

/**
 * ADR-250: requester intake routing found by bug hunt 2 (2026-10-02, production 1e0616f0), as regression
 * tests against the per-file test database as hawa_app (row-level security as in production).
 *
 * L19 (live, owner chat 7191500129, both a requester and an office member): "can you take KAAE's out of
 * the title? just Quality Assurance Workshop", sent while the poster waited for office approval, was held
 * as a brief (settle-later, kind brief) and opened a second request and a second paid round.
 * Friction 3: a captionless photo, then a change kept for the office, dropped the photo.
 * Friction 4: a brief for too many designs, or an unsupported size, got no answer and no office alert.
 * Friction 6: cancel words the intake router read as a change were kept as a change for the office.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const OFFICE = 91000251;
const OWNER = 91000252;
const REQUESTER = 91000253;
const WORKER = ['worker', 'adr250', 'fixture', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const LIVE_BRIEF = "Can you make a poster for KAAE's Quality Assurance Workshop for university deans. It's on 15 October 2026 at 9:30 AM in the Rotana Hotel, Erbil. Registration is free.";
const LIVE_CHANGE = "can you take KAAE's out of the title? just Quality Assurance Workshop";
const LIVE_TITLE = "KAAE's Quality Assurance Workshop";

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const saved = { ...process.env };
beforeAll(() => {
  // The owner is an office member and a requester; OFFICE is the office's other member.
  process.env.TELEGRAM_ALLOWED_USERS = `${OFFICE},${OWNER}`;
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { process.env = saved; await Promise.all([db.destroy(), owner.destroy()]); });

const chatId = () => 67_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_400_000_000 + Math.floor(Math.random() * 600_000_000);
type Msg = Record<string, unknown>;
const message = (chat: number, fields: Msg, from = REQUESTER) => {
  const id = updateId();
  return { update_id: id, message: { message_id: id % 1_000_000, date: 1790000000,
    from: { id: from, is_bot: false, first_name: 'Hawzhin' }, chat: { id: chat, type: 'private' }, ...fields } as Msg };
};
const text = (chat: number, words: string, from = REQUESTER) => message(chat, { text: words }, from);
const photo = (chat: number, from = REQUESTER) => message(chat, { photo: [{ file_id: `photo-${randomUUID()}`, width: 900, height: 900 }] }, from);

function app(extra: Record<string, unknown> = {}) {
  vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
  const bridge = { downloadFile: vi.fn(async () => PNG), dispatchOutboundMessage: vi.fn(async () => ({ success: true })),
    answerCallbackQuery: vi.fn(async () => true) };
  return createApp({ db, telegramBridge: bridge, requesterIntentModel: null, ...extra } as any);
}
/** As ChatInbox calls Core: briefs are held for photos (`briefHold`). */
const intake = async (a: any, update: unknown, body: Record<string, unknown> = {}) => {
  const res = await a.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker,
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true, briefHold: true, ...body }) });
  return (await res.json()) as Record<string, any>;
};
const settle = (a: any, update: unknown) => intake(a, update, { settle: true });

/** A lifecycle request of the chat at a stage, from a brief its requester sent. */
async function seed(chat: number, stage: string, rev: number, title: string, from = REQUESTER, words = title) {
  const requestId = randomUUID();
  const brief = { update_id: updateId(), message: { message_id: 500 + Math.floor(Math.random() * 1000),
    from: { id: from, is_bot: false, first_name: 'Hawzhin' }, chat: { id: chat, type: 'private' }, date: 1790000000, text: words } };
  const created = await persistChatIntake(db, { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: String(chat),
    rawJson: brief, rawText: words, title, clientId, designInstructions: 'Make the event design',
    exactCopy: [{ text: '15 October 2026' }], autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 },
    studioOptions: { tier: 'quality' } }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id)
      VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, null, 'restate', ${stage}, ${rev}, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  return { requestId, taskId };
}
const opened = async (chat: number) => (await withRlsContext(db, scope, (trx) => sql<{ n: string }>`SELECT count(*) AS n
  FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_open'
    AND payload->>'chatId' = ${String(chat)}`.execute(trx))).rows[0].n;
const taskFiles = async (taskId: string) => (await sql<{ sha256: string; role: string }>`SELECT sha256, role FROM hawa.task_files
  WHERE task_id = ${taskId}::uuid`.execute(owner)).rows;

describe('L19: a change to a draft awaiting office approval is a change, never a new request (ADR-250)', () => {
  it('the live words, in the owner\'s own chat (office member and requester): kept for the office on that draft', async () => {
    const a = app();
    const chat = OWNER;
    // The live chat also had an older, closed request (ChatInbox's stale pointer named it).
    const old = await seed(chat, 'manual', 1, 'KAAE K-12 Pilot Study', OWNER);
    await sql`UPDATE hawa.requests SET stage = 'cancelled', rev = rev + 1 WHERE request_id = ${old.requestId}::uuid`.execute(owner);
    const live = await seed(chat, 'in_review', 2, LIVE_TITLE, OWNER, LIVE_BRIEF);
    const before = await opened(chat);
    const change = text(chat, LIVE_CHANGE, OWNER);
    const answer = await intake(a, change);
    expect(answer.lifecycleAction).not.toBe('settle-later');
    expect(answer).toMatchObject({ intakeStatus: 409, code: 'LATE_REQUESTER_CHANGE', lifecycleAction: 'late-change', requestId: live.requestId });
    expect(await opened(chat)).toBe(before);
    const kept = await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, live.requestId));
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept[0])).toContain("take KAAE's out of the title");
    // A replay (or the settle ChatInbox would have scheduled) gives the same answer and opens nothing.
    expect(await intake(a, change)).toMatchObject({ lifecycleAction: 'late-change', requestId: live.requestId });
    expect(await settle(a, change)).not.toMatchObject({ lifecycleAction: 'open-request' });
    expect(await opened(chat)).toBe(before);
  });

  it('the live words from a requester who is not in the office: the same', async () => {
    const a = app();
    const chat = chatId();
    const live = await seed(chat, 'in_review', 2, LIVE_TITLE, REQUESTER, LIVE_BRIEF);
    const answer = await intake(a, text(chat, LIVE_CHANGE));
    expect(answer).toMatchObject({ lifecycleAction: 'late-change', requestId: live.requestId });
    expect(answer.officeAlert?.chatId).toBe(String(OFFICE));
    expect(await opened(chat)).toBe('0');
  });

  it.each([
    'the title should just be Quality Assurance Workshop for university deans',
    'Quality Assurance Workshop for university deans, without KAAE in the title',
    'please drop KAAE from the headline of the Quality Assurance Workshop poster',
  ])('"%s" is a change to the draft in review', async (words) => {
    const a = app();
    const chat = chatId();
    const live = await seed(chat, 'in_review', 2, LIVE_TITLE, REQUESTER, LIVE_BRIEF);
    expect(await intake(a, text(chat, words))).toMatchObject({ lifecycleAction: 'late-change', requestId: live.requestId });
    expect(await opened(chat)).toBe('0');
  });

  it('a design waiting for the requester\'s changes: the same words start its round', async () => {
    const a = app();
    const chat = chatId();
    const waiting = await seed(chat, 'awaiting_answer', 2, LIVE_TITLE, REQUESTER, LIVE_BRIEF);
    await sql`UPDATE hawa.requests SET stage = 'manual', rev = 3 WHERE request_id = ${waiting.requestId}::uuid`.execute(owner);
    expect(await intake(a, text(chat, LIVE_CHANGE))).toMatchObject({ lifecycleAction: 'requester-revision', requestId: waiting.requestId });
  });

  it('a genuinely new brief while the draft waits still opens: a new event, its date and its venue', async () => {
    const a = app();
    const chat = chatId();
    await seed(chat, 'in_review', 2, LIVE_TITLE, REQUESTER, LIVE_BRIEF);
    const asked = await intake(a, text(chat, 'Can you make a poster for the Research Ethics Workshop for postgraduate students? 20 October 2026 at 10 AM in the University Hall.'));
    expect(asked).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'brief' } });
    // Without the words that ask for a design, in a chat of its own (read now, not held for photos).
    const other = chatId();
    await seed(other, 'in_review', 2, LIVE_TITLE, REQUESTER, LIVE_BRIEF);
    const plain = text(other, 'Research ethics workshop for postgraduate students at the university hall, 20 October 2026 at 10 AM');
    expect(await intake(a, plain, { briefHold: false })).toMatchObject({ lifecycleAction: 'open-request' });
  });

  it('the draft\'s own name with new copy may be its correction or a new edition: the requester is asked', async () => {
    const a = app();
    const chat = chatId();
    await seed(chat, 'in_review', 2, LIVE_TITLE, REQUESTER, LIVE_BRIEF);
    const asked = await intake(a, text(chat, 'Quality Assurance Workshop for university deans. 16 October 2026 at 9:30 AM in the Rotana Hotel, Erbil.'));
    expect(asked).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true });
    expect(asked.chatAnswer.text).toContain('Quality Assurance Workshop');
    expect(await opened(chat)).toBe('0');
  });

  it('with nothing on the way, the same words are read as before', async () => {
    const view = (stage: ChatRequestView['stage']): ChatRequestView => ({ requestId: 'r-a', stage, rev: 2, currentTaskId: 't-a', clientId: null,
      title: LIVE_TITLE, activeAt: new Date().toISOString(), createdAt: new Date().toISOString(), question: null, requesterId: '1' });
    const input = { text: LIVE_CHANGE, reading: readIntentByRules(LIVE_CHANGE), bound: [], unboundReply: false, senderId: '1', officeIds: ['9'],
      group: false, addressed: true, pendingAsk: null, now: Date.now() };
    expect(reconsiderNewBrief({ ...input, requests: [] }, planTurn({ ...input, requests: [] }))).toBeNull();
    const inReview = { ...input, requests: [view('in_review')] };
    // Since the follow-up to ADR-250 the rules read the live words as a change themselves ("take … out of the
    // title"); either way the plan is a change kept on the design in review.
    const planned = planTurn(inReview);
    expect(reconsiderNewBrief(inReview, planned)?.plan ?? planned).toEqual({ kind: 'note', note: 'change', requestId: 'r-a', words: LIVE_CHANGE });
    expect(editsADesignOnTheWay('Graduation ceremony for the class of 2026 at the Rotana Hotel, Erbil on 12 November at 6 pm.', [view('in_review')])).toBeNull();
  });
});

describe('friction 3: a photo sent just before a change goes with it (ADR-250)', () => {
  it('a design being made: the photo becomes its material, the requester hears so, and the photo\'s settle says nothing more', async () => {
    const a = app();
    const chat = chatId();
    const making = await seed(chat, 'designing', 1, 'KAAE members evening');
    const shot = photo(chat);
    expect(await intake(a, shot, { briefHold: false })).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'photo' } });
    const change = text(chat, 'make the background blue like this photo');
    const kept = await intake(a, change);
    expect(kept).toMatchObject({ lifecycleAction: 'late-change', requestId: making.requestId,
      notice: { text: MEDIA_MESSAGES.photoAdded.en.replace('{title}', '<b>KAAE members evening</b>') } });
    expect(await taskFiles(making.taskId)).toEqual([{ sha256: sha(PNG), role: 'reference_image' }]);
    expect(await settle(a, shot)).toMatchObject({ settle: 'skipped', photo: 'joined' });
    expect(await intake(a, change)).toMatchObject({ lifecycleAction: 'late-change', requestId: making.requestId });
    expect(await taskFiles(making.taskId)).toHaveLength(1);
  });

  it('a design with the office: the photo is passed on with the words, and no later brief takes it', async () => {
    const a = app();
    const chat = chatId();
    const review = await seed(chat, 'in_review', 2, 'KAAE members evening');
    const shot = photo(chat);
    await intake(a, shot, { briefHold: false });
    const kept = await intake(a, text(chat, 'please make the background blue like this photo'));
    expect(kept).toMatchObject({ lifecycleAction: 'late-change', requestId: review.requestId });
    expect(kept.notice?.text).toContain('passed the photo to the office');
    const notes = await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, review.requestId));
    expect(JSON.stringify(notes)).toContain('sent a photo just before these words');
    expect(await taskFiles(review.taskId)).toHaveLength(0);
    expect(await settle(a, shot)).toMatchObject({ settle: 'skipped', photo: 'passed' });
  });
});

describe('friction 4: a brief the bot cannot start is answered, in both languages, and the office told (ADR-250)', () => {
  it('more designs than one request holds', async () => {
    const a = app();
    const chat = chatId();
    const answer = await intake(a, text(chat, 'Create 9 designs for KAAE: graduation at Erbil hall on 12 October'), { briefHold: false });
    expect(answer).toMatchObject({ intakeStatus: 422, code: 'DELIVERABLE_LIMIT', lifecycleAction: 'chat-answer', chatId: String(chat) });
    expect(answer.chatAnswer.text).toBe(INTAKE_LIMIT_MESSAGES.tooManyPassed.en.replace('{count}', '9'));
    expect(answer.chatAnswer.text).not.toMatch(/send|groups/i);
    expect(answer.officeAlert).toMatchObject({ chatId: String(OFFICE), text: expect.stringContaining('9 designs') });
    expect(await opened(chat)).toBe('0');
  });

  it('a size outside what the design path makes', async () => {
    const a = app();
    const chat = chatId();
    const answer = await intake(a, text(chat, 'Create 2 designs for KAAE:\n1) Poster for graduation\nSize: 5000x4000\n2) Story for open day'), { briefHold: false });
    expect(answer).toMatchObject({ intakeStatus: 422, code: 'UNSUPPORTED_CANVAS', lifecycleAction: 'chat-answer',
      chatAnswer: { text: INTAKE_LIMIT_MESSAGES.sizePassed.en.replace('{size}', '5000 × 4000') } });
    expect(answer.chatAnswer.text).not.toMatch(/choose|format|pixel/i);
    expect(answer.officeAlert).toMatchObject({ chatId: String(OFFICE), text: expect.stringContaining('5000 × 4000') });
  });

  it('in Sorani, the requester hears it in Sorani', async () => {
    const a = app();
    const chat = chatId();
    const answer = await intake(a, text(chat, 'Create 9 designs for KAAE: ئاهەنگی دەرچوونی قوتابیانی زانکۆ لە هۆڵی هەولێر ١٢ی تشرینی یەکەم'), { briefHold: false });
    expect(answer).toMatchObject({ code: 'DELIVERABLE_LIMIT', lifecycleAction: 'chat-answer',
      chatAnswer: { text: INTAKE_LIMIT_MESSAGES.tooManyPassed.ckb.replace('{count}', '9') } });
  });
});

describe('friction 6: cancel words the router reads as a change stay a cancel question (ADR-250)', () => {
  const words = 'can you cancel my request, it was a mistake';
  it('the router names a design: the requester is asked about that one by name; nothing is kept as a change', async () => {
    const chat = chatId();
    const teacher = await seed(chat, 'manual', 1, 'Teacher Appreciation Day');
    const kaae = await seed(chat, 'in_review', 4, 'KAAE K-12 Pilot Study');
    const read = vi.fn(async () => ({ intent: 'change' as const, reason: 'fixture', source: 'model' as const, requestId: teacher.requestId, confidence: 0.9 }));
    const answer = await intake(app({ requesterIntentModel: { read } }), text(chat, words), { briefHold: false });
    expect(read).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true });
    expect(answer.chatAnswer.text).toBe('Do you want me to cancel <b>Teacher Appreciation Day</b>?');
    for (const r of [teacher, kaae]) expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, r.requestId))).toHaveLength(0);
  });

  it('the router reads chatter: the cancel question stands, never the greeting', async () => {
    const chat = chatId();
    await seed(chat, 'manual', 1, 'Teacher Appreciation Day');
    await seed(chat, 'in_review', 4, 'KAAE K-12 Pilot Study');
    const read = vi.fn(async () => ({ intent: 'conversation' as const, reason: 'fixture', source: 'model' as const, confidence: 0.9 }));
    const answer = await intake(app({ requesterIntentModel: { read } }), text(chat, words), { briefHold: false });
    expect(answer).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true });
    expect(answer.chatAnswer.text).toMatch(/^Which design is this for\?/);
  });
});
