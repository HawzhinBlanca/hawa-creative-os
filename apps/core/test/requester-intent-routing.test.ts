import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { resolveModel } from '@hawa/domain';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { pendingLateChanges } from '../src/services/lifecycle-chat-target.js';
import { createRequesterIntentModel, intentRequestBody, type RequesterIntentModel } from '../src/services/requester-intent-model.js';
import { parseChoice, planTurn, readIntentByRules, type ChatRequestView, type TurnInput } from '../src/services/requester-turn.js';

/**
 * ADR-144: what a requester's message means in the context of the chat's requests, decided once per
 * update before anything is bound or opened. Pure rules first (English, Sorani, mixed), then the
 * intake route against the per-file test database as hawa_app (row-level security as in
 * production): thanks, status, corrections, approvals, cancels, deadlines, the "which design?"
 * question and its natural answers, group chats, replays, and the intake router's paid-call ledger.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const operatorUserId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
const OFFICE = 91000007;
const REQUESTER = 91000100;
const COLLEAGUE = 91000200;
const WORKER = ['worker', 'intent', 'fixture', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const saved = { ...process.env };
it('ADR-148 preserves low reasoning for Sol intake while Mini has no unsupported reasoning parameter', () => {
  expect(JSON.parse(intentRequestBody('gpt-6.1-sol', 'Please change the title', [])))
    .toMatchObject({ reasoning_effort: 'low', max_completion_tokens: 400, service_tier: 'default' });
  expect(JSON.parse(intentRequestBody('gpt-4.1-mini', 'Please change the title', [])))
    .not.toHaveProperty('reasoning_effort');
});
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  process.env = saved;
  await Promise.all([db.destroy(), owner.destroy()]);
});

const chatId = () => 64_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_100_000_000 + Math.floor(Math.random() * 800_000_000);
type Msg = Record<string, unknown>;
const message = (chat: number, text: string, fields: Msg = {}, chatType = 'private', from = REQUESTER) => {
  const id = updateId();
  return { update_id: id, message: { message_id: id % 100000, from: { id: from, is_bot: false, first_name: 'Requester' },
    chat: { id: chat, type: chatType }, date: 1790000000, text, ...fields } as Msg };
};
const botReply = (messageId: number) => ({ reply_to_message: { message_id: messageId, from: { id: 7000001, is_bot: true, first_name: 'Hawa' } } });

function app(extra: Record<string, unknown> = {}) {
  vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
  return createApp({ db, requesterIntentModel: null, ...extra } as any);
}
const intake = async (a: any, update: unknown) => {
  const res = await a.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker,
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) });
  return (await res.json()) as Record<string, any>;
};

/** A lifecycle request of the chat, with its brief's sender and message, and a bot message about it. */
async function seed(chat: number, stage: string, rev: number, options: { title?: string; sent?: { key: string; messageId: string };
  requester?: number; client?: string; minutesAgo?: number } = {}) {
  const requestId = randomUUID();
  const brief = { update_id: updateId(), message: { message_id: 500 + Math.floor(Math.random() * 1000),
    from: { id: options.requester ?? REQUESTER, is_bot: false, first_name: 'Requester' }, chat: { id: chat, type: 'private' },
    date: 1790000000, text: options.title ?? 'KAAE members evening' } };
  const created = await persistChatIntake(db, {
    platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: String(chat), rawJson: brief,
    rawText: options.title ?? 'KAAE members evening', title: options.title ?? 'KAAE members evening',
    clientId: options.client ?? clientId,
    designInstructions: 'Make the approved event design', exactCopy: [{ text: 'December 4, 2026' }],
    autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 }, studioOptions: { tier: 'quality' },
  }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  const at = new Date(Date.now() - (options.minutesAgo ?? 0) * 60_000).toISOString();
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id,
      parent_request_id, owner, stage, rev, chat_id, created_at, updated_at)
    VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid,
      null, 'restate', ${stage}, ${rev}, ${String(chat)}, ${at}::timestamptz, ${at}::timestamptz)`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid
      WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
    if (options.sent) {
      await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id,
          event_kind, payload, payload_hash, verified)
        VALUES (${tenantId}::uuid, 'telegram_delivery', ${`lc:${requestId}:${options.sent.key}:send`},
          'telegram_message_sent', ${JSON.stringify({ messageId: options.sent.messageId })}::jsonb,
          ${`intent-sent-${requestId}`}, true)`.execute(trx);
    }
  });
  return { requestId, taskId, briefMessageId: brief.message.message_id };
}

const tasksInChat = async (chat: number) =>
  (await withRlsContext(db, scope, (trx) =>
    trx.selectFrom('outbox_commands').select(['aggregate_id', 'payload']).where('command_type', '=', 'task.created').execute()
  )).filter((r: any) => String(r.payload?.sourceChannelId) === String(chat));
const requestRow = async (requestId: string) => (await withRlsContext(db, scope, (trx) => sql<{ rev: string; stage: string }>`
  SELECT rev, stage FROM hawa.requests WHERE request_id = ${requestId}::uuid`.execute(trx))).rows[0];
const routingReceipts = async (id: number) => (await withRlsContext(db, scope, (trx) => sql<{ payload: Record<string, any> }>`
  SELECT payload FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid
    AND source_account_id = 'lifecycle_chat_routing' AND source_event_id = ${String(id)}`.execute(trx))).rows;

describe('the rules read a message the same way in English, Sorani and both', () => {
  it.each([
    ['thanks', 'acknowledgement'], ['ok 👍', 'acknowledgement'], ['سوپاس', 'acknowledgement'], ['Thanks, received!', 'acknowledgement'],
    ['looks good, send it', 'approval'], ['Perfect! You can send it', 'approval'], ['باشە بینێرە', 'approval'], ['keep it as is', 'approval'],
    ['cancel that', 'cancel'], ['please cancel the poster', 'cancel'], ['forget it', 'cancel'], ['we don\'t need it anymore', 'cancel'],
    ['هەڵیبوەشێنەوە', 'cancel'], ['تکایە پۆستەرەکە هەڵبوەشێنەوە', 'cancel'],
    ['when will it be ready?', 'status'], ['any update?', 'status'], ['is it done yet?', 'status'], ['کەی ئامادە دەبێت؟', 'status'],
    ['we need it by tomorrow', 'deadline'], ['urgent please', 'deadline'], ['تا سبەی پێویستمانە', 'deadline'],
    ['the date should be 5 October not 4', 'change'], ['make the title bigger', 'change'], ['also add the phone number 0750 123 4567', 'change'],
    ['Sorry, the date is 5 October', 'change'], ['ڕەنگی باگراوندەکە بگۆڕە', 'change'], ['Thanks! but make the logo bigger', 'change'],
    ['looks good but change the date', 'change'],
    ['Hi, can you make a poster for our Nawroz party?', 'new_brief'], ['Can you make a poster for Nawroz?', 'new_brief'],
    ['سڵاو، پۆستەرێک بۆ نەورۆز دروست بکە', 'new_brief'], ['New poster please for the graduation ceremony\n\nDate: 12 October 2026', 'new_brief'],
    ['hello', 'conversation'], ['what fonts can you use?', 'conversation'], ['From now on, always put the logo bottom-right', 'conversation'],
    ['/start', 'conversation'],
  ] as const)('"%s" reads as %s', (words, intent) => {
    expect(readIntentByRules(words).intent).toBe(intent);
  });

  it('a request that opens with a greeting has no copy yet, so it opens for a person and never as a paid draft', () => {
    expect(readIntentByRules('Hi, can you make a poster for our Nawroz party?')).toMatchObject({ intent: 'new_brief', explicitNew: true, instructionOnly: true });
    expect(readIntentByRules('New poster please for the graduation ceremony\n\nDate: 12 October 2026\nVenue: Erbil International Hotel'))
      .toMatchObject({ intent: 'new_brief', instructionOnly: false, substantial: true });
  });

  it('answers to "which design?" are read by number, ordinal, name, "new" or "yes", in both languages', () => {
    const two = { options: [{ requestId: 'a', title: 'Nawroz poster' }, { requestId: 'b', title: 'Graduation flyer' }], allowNew: true };
    expect(parseChoice('2', two)).toEqual({ option: 1 });
    expect(parseChoice('٢', two)).toEqual({ option: 1 });
    expect(parseChoice('the second one', two)).toEqual({ option: 1 });
    expect(parseChoice('دووەم', two)).toEqual({ option: 1 });
    expect(parseChoice('the graduation one', two)).toEqual({ option: 1 });
    expect(parseChoice('Nawroz', two)).toEqual({ option: 0 });
    expect(parseChoice('3', two)).toEqual({ new: true });
    expect(parseChoice('a new one', two)).toEqual({ new: true });
    expect(parseChoice('نوێ', two)).toEqual({ new: true });
    expect(parseChoice('last', two)).toEqual({ option: 1 });
    // Words that are not an answer are read on their own.
    expect(parseChoice('Make this one blue', two)).toBeNull();
    expect(parseChoice('New poster for the Nawroz party at the Rotana hotel on Friday evening', two)).toBeNull();
    const one = { options: [{ requestId: 'a', title: 'Nawroz poster' }], allowNew: true };
    expect(parseChoice('change', one)).toEqual({ option: 0 });
    expect(parseChoice('بەڵێ', one)).toEqual({ option: 0 });
    expect(parseChoice('new', one)).toEqual({ new: true });
    // "OK" answers "is this for …?", but not "change or new?".
    expect(parseChoice('ok', { ...one, allowNew: false })).toEqual({ option: 0 });
    expect(parseChoice('باشە', { ...one, allowNew: false })).toEqual({ option: 0 });
    expect(parseChoice('ok', one)).toBeNull();
  });
});

describe('a message while designs are open', () => {
  it('thanks while a design waits for changes is thanked, with a reminder, and starts nothing', async () => {
    const chat = chatId();
    const waiting = await seed(chat, 'manual', 3, { title: 'Nawroz poster' });
    const answer = await intake(app(), message(chat, 'thanks!'));
    expect(answer).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', intent: 'acknowledgement',
      chatAnswer: { text: expect.stringContaining('Whenever you\'re ready, just tell me what to change on <b>Nawroz poster</b>') } });
    expect(await requestRow(waiting.requestId)).toMatchObject({ rev: '3', stage: 'manual' });
    expect(await tasksInChat(chat)).toHaveLength(1);
    const sorani = await intake(app(), message(chat, 'زۆر سوپاس'));
    expect(sorani.chatAnswer.text).toMatch(/^🙏 سوپاس\./);
  });

  it.each([
    ['designing', 2, /is being designed right now/],
    ['manual', 3, /is waiting for your changes/],
    ['in_review', 2, /is with the office for a final check/],
    ['delivered', 7, /has been delivered/],
  ] as const)('a status question while the design is %s is answered from its stage', async (stage, rev, expected) => {
    const chat = chatId();
    await seed(chat, stage, rev, { title: 'Graduation flyer' });
    const answer = await intake(app(), message(chat, 'any update?'));
    expect(answer).toMatchObject({ lifecycleAction: 'chat-answer', intent: 'status' });
    expect(answer.chatAnswer.text).toMatch(expected);
    expect(answer.chatAnswer.text).toContain('<b>Graduation flyer</b>');
    const kurdish = await intake(app(), message(chat, 'کەی ئامادە دەبێت؟'));
    expect(kurdish.chatAnswer.text).toMatch(/[؀-ۿ]/);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('a correction while the design is being made is kept on it for the office, and Deliver waits for it', async () => {
    const chat = chatId();
    const designing = await seed(chat, 'designing', 2, { title: 'KAAE members evening' });
    const update = message(chat, 'the date should be 5 October not 4');
    const answer = await intake(app(), update);
    expect(answer).toMatchObject({ intakeStatus: 409, code: 'LATE_REQUESTER_CHANGE', lifecycleAction: 'late-change',
      requestId: designing.requestId, requestStage: 'designing',
      chatAnswer: { text: "Got it. I'll add that to <b>KAAE members evening</b> once the current draft is done, or pass it to the office if I can't." },
      officeAlert: { chatId: String(OFFICE), text: expect.stringContaining('the date should be 5 October not 4') } });
    expect(answer.officeAlert.text).toMatch(/while it was still being designed/);
    expect(await tasksInChat(chat)).toHaveLength(1);
    const pending = await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, designing.requestId));
    expect(pending).toEqual([expect.objectContaining({ updateId: String(update.update_id), stage: 'designing',
      text: 'the date should be 5 October not 4' })]);
    // A replay (the worker asking again) gets the same words back and stores nothing more.
    expect(await intake(app(), update)).toEqual(answer);
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, designing.requestId))).toHaveLength(1);
  });

  it('a correction sent right after the brief waits for its request to open, then is kept on it', async () => {
    const chat = chatId();
    const a = app();
    const opened = await intake(a, message(chat, 'KAAE members evening\n---\nDecember 4, 2026\nErbil'));
    expect(opened).toMatchObject({ lifecycleAction: 'open-request' });
    const correction = message(chat, 'the date should be 5 October not 4');
    // RequestLifecycle has not projected the open yet: the worker tries again (a counted retry).
    expect(await intake(a, correction)).toMatchObject({ intakeStatus: 503, code: 'REQUEST_OPENING' });
    expect(await intake(a, message(chat, 'thanks'))).toMatchObject({ intent: 'acknowledgement' });
    const projected = await a.request(`/v1/internal/lifecycle/${opened.requestId}/project`, { method: 'POST', headers: worker,
      body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${opened.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: opened.draft }] }) });
    expect(projected.status).toBe(200);
    expect(await intake(a, correction)).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestId: opened.requestId,
      requestStage: 'designing' });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  // ADR-230 (changed deliberately): a cancel used to be a note for the office that closed nothing. While
  // nothing is approved, intake now decides a withdraw (RequestLifecycle closes the request, after Core
  // checks this decision); once approved, the cancel is kept for the office and the requester is told the truth.
  it('"cancel the poster" in review is decided as a withdraw; once approved it is kept for the office, told truthfully', async () => {
    const chat = chatId();
    const request = await seed(chat, 'in_review', 2, { title: 'Nawroz poster' });
    const answer = await intake(app(), message(chat, 'please cancel the poster'));
    expect(answer).toMatchObject({ lifecycleAction: 'withdraw', requestId: request.requestId, requestStage: 'in_review', intent: 'cancel' });
    expect(answer.chatAnswer).toBeUndefined();
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, request.requestId))).toHaveLength(0);
    // Intake decides; the request object closes it.
    expect(await requestRow(request.requestId)).toMatchObject({ stage: 'in_review' });
    const approvedChat = chatId();
    const approved = await seed(approvedChat, 'approved', 3, { title: 'Nawroz poster' });
    const late = await intake(app(), message(approvedChat, 'please cancel the poster'));
    expect(late).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestStage: 'approved', intent: 'cancel',
      chatAnswer: { text: "<b>Nawroz poster</b> was already approved, so I can't cancel it myself. I've told the office." } });
    expect(late.officeAlert.text).toMatch(/asked to cancel the design "Nawroz poster", but it was already approved/);
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, approved.requestId))).toHaveLength(1);
    const sorani = await intake(app(), message(approvedChat, 'هەڵیبوەشێنەوە'));
    expect(sorani.chatAnswer.text).toContain('پەسەند کرابوو');
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('approval words tell the office the requester is happy; nothing is approved and Deliver is not held', async () => {
    const chat = chatId();
    const request = await seed(chat, 'in_review', 2, { title: 'Nawroz poster', sent: { key: '2:design-outcome', messageId: '9101' } });
    const update = message(chat, 'looks good, send it', { reply_to_message: { message_id: 9101 } });
    const answer = await intake(app(), update);
    expect(answer).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', note: 'approval', requestId: request.requestId,
      chatAnswer: { text: expect.stringContaining("I've told the office you're happy with <b>Nawroz poster</b>") },
      officeAlert: { chatId: String(OFFICE), text: expect.stringContaining('Nothing was approved') } });
    expect(await routingReceipts(update.update_id)).toHaveLength(0);
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, request.requestId))).toHaveLength(0);
    expect(await requestRow(request.requestId)).toMatchObject({ stage: 'in_review' });
    const sorani = await intake(app(), message(chat, 'باشە بینێرە'));
    expect(sorani).toMatchObject({ note: 'approval' });
    expect(sorani.chatAnswer.text).toMatch(/[؀-ۿ]/);
  });

  it('a deadline is passed to the office for the request it concerns', async () => {
    const chat = chatId();
    await seed(chat, 'designing', 2, { title: 'Graduation flyer' });
    const answer = await intake(app(), message(chat, 'we need it by tomorrow'));
    expect(answer).toMatchObject({ lifecycleAction: 'chat-answer', note: 'deadline',
      chatAnswer: { text: "Noted. I've told the office about the timing for <b>Graduation flyer</b>." },
      officeAlert: { text: expect.stringContaining('we need it by tomorrow') } });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('a greeting with a Sorani request opens a request for a person, never a paid draft', async () => {
    const chat = chatId();
    const answer = await intake(app(), message(chat, 'سڵاو، پۆستەرێک بۆ نەورۆز دروست بکە'));
    expect(answer).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request',
      draft: { autoGenerate: false, rawText: 'سڵاو، پۆستەرێک بۆ نەورۆز دروست بکە' } });
  });
});

describe('two designs open: the natural pick', () => {
  it('asks which design, keeps the words, and applies them to the one named by "the second one"', async () => {
    const chat = chatId();
    const nawroz = await seed(chat, 'manual', 3, { title: 'Nawroz poster' });
    const graduation = await seed(chat, 'manual', 3, { title: 'Graduation flyer' });
    const change = message(chat, 'make the title gold');
    const asked = await intake(app(), change);
    expect(asked).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', choiceRequired: true,
      chatAnswer: { text: 'Which design is this for?\n1. <b>Nawroz poster</b>\n2. <b>Graduation flyer</b>' } });
    expect(await tasksInChat(chat)).toHaveLength(2);

    const pick = message(chat, 'the second one');
    const revised = await intake(app(), pick);
    expect(revised).toMatchObject({ intakeStatus: 200, lifecycleAction: 'requester-revision', duplicate: false,
      requestId: graduation.requestId, priorTaskId: graduation.taskId, directive: 'make the title gold', rawText: 'make the title gold' });
    expect(await requestRow(nawroz.requestId)).toMatchObject({ rev: '3', stage: 'manual' });
    expect(await requestRow(graduation.requestId)).toMatchObject({ rev: '4', stage: 'designing' });
    expect(await tasksInChat(chat)).toHaveLength(3);

    // Replays: the answer again is the same round, never a second one; the question again is the same
    // question, never a revision.
    expect(await intake(app(), pick)).toMatchObject({ duplicate: true, lifecycleAction: 'requester-revision',
      newTaskId: revised.newTaskId, directive: 'make the title gold' });
    expect(await intake(app(), change)).toMatchObject({ duplicate: true, lifecycleAction: 'chat-answer',
      choiceRequired: true, chatAnswer: asked.chatAnswer });
    expect(await tasksInChat(chat)).toHaveLength(3);
    // The same update ID with other words is refused, whichever decision it carries.
    expect(await intake(app(), { ...pick, message: { ...pick.message, text: 'the first one' } }))
      .toMatchObject({ intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('a pick by name or in Sorani works as well, and a message that is not an answer is read on its own', async () => {
    const chat = chatId();
    const nawroz = await seed(chat, 'manual', 3, { title: 'Nawroz poster' });
    await seed(chat, 'manual', 3, { title: 'Graduation flyer' });
    await intake(app(), message(chat, 'use a darker blue'));
    const byName = await intake(app(), message(chat, 'the nawroz one'));
    expect(byName).toMatchObject({ lifecycleAction: 'requester-revision', requestId: nawroz.requestId, directive: 'use a darker blue' });

    const other = chatId();
    await seed(other, 'manual', 3, { title: 'Nawroz poster' });
    const second = await seed(other, 'manual', 3, { title: 'Graduation flyer' });
    await intake(app(), message(other, 'ڕەنگی باگراوندەکە بگۆڕە'));
    expect(await intake(app(), message(other, 'دووەم'))).toMatchObject({ lifecycleAction: 'requester-revision',
      requestId: second.requestId, directive: 'ڕەنگی باگراوندەکە بگۆڕە' });

    const third = chatId();
    await seed(third, 'manual', 3, { title: 'Nawroz poster' });
    await seed(third, 'manual', 3, { title: 'Graduation flyer' });
    await intake(app(), message(third, 'make the title gold'));
    // Thanks is not an answer: it is thanked, and the question stays asked of the next message.
    expect(await intake(app(), message(third, 'thanks'))).toMatchObject({ intent: 'acknowledgement' });
    expect(await tasksInChat(third)).toHaveLength(2);
  });

  it('a short message that could be new or a change asks, and "new" opens it with the first words', async () => {
    const chat = chatId();
    await seed(chat, 'in_review', 2, { title: 'KAAE members evening' });
    const first = message(chat, 'Eid greeting card for staff');
    expect(await intake(app(), first)).toMatchObject({ choiceRequired: true,
      chatAnswer: { text: 'Is this a change to <b>KAAE members evening</b>, or a new design?' } });
    const answer = message(chat, 'new');
    const opened = await intake(app(), answer);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: 'Eid greeting card for staff', autoGenerate: false } });
    expect(await intake(app(), answer)).toMatchObject({ duplicate: true, lifecycleAction: 'open-request', requestId: opened.requestId });
  });

  it('a reply to one design\'s message is about that design, even with a question open', async () => {
    const chat = chatId();
    await seed(chat, 'manual', 3, { title: 'Nawroz poster' });
    const graduation = await seed(chat, 'manual', 3, { title: 'Graduation flyer', sent: { key: '3:office-revision-notify', messageId: '9201' } });
    await intake(app(), message(chat, 'make the title gold'));
    const reply = await intake(app(), message(chat, 'Make this one blue', { reply_to_message: { message_id: 9201 } }));
    expect(reply).toMatchObject({ lifecycleAction: 'requester-revision', requestId: graduation.requestId, directive: 'Make this one blue' });
  });
});

describe('group chats (F8)', () => {
  const group = () => -(1_000_000_000_000 + Math.floor(Math.random() * 1_000_000));
  const inGroup = (chat: number, text: string, fields: Msg = {}, from = REQUESTER) => message(chat, text, fields, 'supergroup', from);

  it('conversation not addressed to the bot stays passive, whatever it says', async () => {
    const chat = group();
    await seed(chat, 'manual', 3, { title: 'Nawroz poster' });
    for (const words of ['thanks everyone', 'make the title bigger', 'when is the dinner?']) {
      const answer = await intake(app(), inGroup(chat, words));
      expect(answer, words).toMatchObject({ intakeStatus: 200, status: 'MESSAGE_ONLY' });
      expect(answer.lifecycleAction, words).toBeUndefined();
    }
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('a change sent to the bot is taken from the request\'s requester or the office, not from another member', async () => {
    const chat = group();
    const request = await seed(chat, 'designing', 2, { title: 'Nawroz poster', sent: { key: '1:ack', messageId: '9301' } });
    const colleague = await intake(app(), inGroup(chat, 'make the logo bigger', botReply(9301), COLLEAGUE));
    expect(colleague).toMatchObject({ status: 'MESSAGE_ONLY' });
    const requester = await intake(app(), inGroup(chat, 'make the logo bigger', botReply(9301), REQUESTER));
    expect(requester).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestId: request.requestId });
    const office = await intake(app(), inGroup(chat, 'also add the date', botReply(9301), OFFICE));
    expect(office).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestId: request.requestId });
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, request.requestId))).toHaveLength(2);
  });

  it('a request addressed to the bot by mention opens one', async () => {
    const chat = group();
    const text = '@hawa_design_bot can you make a poster for the Nawroz party?';
    const answer = await intake(app(), inGroup(chat, text, { entities: [{ type: 'mention', offset: 0, length: 16 }] }));
    expect(answer).toMatchObject({ lifecycleAction: 'open-request', draft: { autoGenerate: false } });
  });
});

describe('the decision is made once', () => {
  it('a replay after the request moved on gives the first answer word for word', async () => {
    const chat = chatId();
    const request = await seed(chat, 'manual', 3, { title: 'Nawroz poster' });
    const thanks = message(chat, 'ok thanks');
    const first = await intake(app(), thanks);
    await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.requests SET stage = 'in_review', rev = 6
      WHERE request_id = ${request.requestId}::uuid`.execute(trx));
    const again = await intake(app(), thanks);
    expect(again).toEqual({ ...first, duplicate: true });
    expect(await intake(app(), { ...thanks, message: { ...thanks.message, text: 'cancel it' } }))
      .toMatchObject({ intakeStatus: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('the intake router is asked once per update, and its pick never starts a round by itself (ADR-286)', async () => {
    const chat = chatId();
    const kaae = await seed(chat, 'manual', 3, { title: 'KAAE members evening' });
    await seed(chat, 'manual', 3, { title: 'Graduation flyer' });
    const read = vi.fn<RequesterIntentModel['read']>(async (input) => ({ intent: 'change', reason: 'fixture', source: 'model',
      requestId: input.requests.find((r) => r.title.startsWith('KAAE'))!.requestId, confidence: 0.97 }));
    const words = message(chat, 'KAAE members evening, 5 October');
    // A sure pick names the design the requester is asked about; it starts nothing.
    const asked = await intake(app({ requesterIntentModel: { read } }), words);
    expect(read).toHaveBeenCalledTimes(1);
    expect(asked).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true,
      chatAnswer: { text: 'Is this a change to <b>KAAE members evening</b>, or a new design?' } });
    expect(await tasksInChat(chat)).toHaveLength(2);
    expect(await intake(app({ requesterIntentModel: { read } }), words)).toMatchObject({ duplicate: true, choiceRequired: true });
    expect(read).toHaveBeenCalledTimes(1);
    // The requester's own answer starts the round.
    const revised = await intake(app({ requesterIntentModel: { read } }), message(chat, 'change'));
    expect(revised).toMatchObject({ lifecycleAction: 'requester-revision', requestId: kaae.requestId, directive: 'KAAE members evening, 5 October' });
    expect(await tasksInChat(chat)).toHaveLength(3);
    expect(read).toHaveBeenCalledTimes(1);

    const unsure = vi.fn<RequesterIntentModel['read']>(async (input) => ({ intent: 'change', reason: 'fixture', source: 'model',
      requestId: input.requests[0].requestId, confidence: 0.7 }));
    const other = chatId();
    await seed(other, 'manual', 3, { title: 'KAAE members evening' });
    await seed(other, 'manual', 3, { title: 'KAAE workshop' });
    expect(await intake(app({ requesterIntentModel: { read: unsure } }), message(other, 'KAAE members evening, 5 October')))
      .toMatchObject({ choiceRequired: true });
  });

  it('a redo the router is sure of is asked about, never redone on its word (ADR-286, NLU eval en-unclear-05)', async () => {
    const chat = chatId();
    await seed(chat, 'delivered', 2, { title: 'Quality Assurance Workshop' });
    const read = vi.fn<RequesterIntentModel['read']>(async (input) => ({ intent: 'change', reason: 'fixture', source: 'model',
      requestId: input.requests[0].requestId, confidence: 0.94 }));
    const before = (await tasksInChat(chat)).length;
    const asked = await intake(app({ requesterIntentModel: { read } }), message(chat, 'do a better design for the conference'));
    expect(read).toHaveBeenCalledTimes(1);
    expect(asked).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true });
    expect(asked.lifecycleAction).not.toBe('requester-revision');
    expect(await tasksInChat(chat)).toHaveLength(before);
  });

  it('a fragment the router reads as a change is asked about, not kept as a change (ADR-286, NLU eval en-unclear-03)', async () => {
    const chat = chatId();
    await seed(chat, 'in_review', 2, { title: 'KAAE: Quality Assurance Workshop' });
    const read = vi.fn<RequesterIntentModel['read']>(async (input) => ({ intent: 'change', reason: 'fixture', source: 'model',
      requestId: input.requests[0].requestId, confidence: 0.87 }));
    const asked = await intake(app({ requesterIntentModel: { read } }), message(chat, 'for the deans'));
    expect(read).toHaveBeenCalledTimes(1);
    expect(asked).toMatchObject({ lifecycleAction: 'chat-answer', choiceRequired: true,
      chatAnswer: { text: 'Is this a change to <b>Quality Assurance Workshop</b>, or a new design?' } });
  });
});

describe('the intake router\'s paid call (migration 068)', () => {
  async function client(policy: 'approved_providers' | 'local_only' = 'approved_providers') {
    const id = randomUUID(), code = `intent-${randomUUID().slice(0, 8)}`;
    await sql`INSERT INTO hawa.clients(id, tenant_id, code, name, model_egress_policy)
      VALUES (${id}::uuid, ${tenantId}::uuid, ${code}, ${code}, ${JSON.stringify({ mode: policy, allowedProviders: ['openai'] })}::jsonb)`.execute(owner);
    const dna = { privacy: { modelEgressMode: policy, allowedProviders: ['openai'] } };
    await sql`INSERT INTO hawa.client_dna_versions(tenant_id, client_id, version, status, dna, content_hash, approved_by)
      VALUES (${tenantId}::uuid, ${id}::uuid, 1, 'active', ${JSON.stringify(dna)}::jsonb,
        ${createHash('sha256').update(JSON.stringify(dna)).digest('hex')}, ${operatorUserId}::uuid)`.execute(owner);
    return id;
  }
  const view = (requestId: string, client: string): ChatRequestView => ({ requestId, stage: 'manual', rev: 3, currentTaskId: randomUUID(),
    clientId: client, title: 'KAAE members evening', activeAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    question: null, requesterId: null });
  const completion = (decision: Record<string, unknown>) => new Response(JSON.stringify({ id: 'chatcmpl-intent-1', model: resolveModel('text'),
    usage: { prompt_tokens: 420, completion_tokens: 30, total_tokens: 450 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] }), { headers: { 'x-request-id': 'req_intent_1' } });
  const key = () => ['sk', 'intent', 'fixture'].join('-');
  const calls = async (update: number) => (await sql<{ status: string; cost_usd: string | null; decision: unknown; spending_policy_version: number }>`
    SELECT status, cost_usd, decision, spending_policy_version FROM hawa.requester_intent_calls
    WHERE tenant_id = ${tenantId}::uuid AND update_id = ${update}`.execute(owner)).rows;

  it('admits one call per update inside the shared allowance, records its cost and decision, and never calls again', async () => {
    const id = await client();
    const requestId = randomUUID();
    const fetcher = vi.fn(async () => completion({ kind: 'change', design: 1, confidence: 0.92 }));
    const model = createRequesterIntentModel(db, { fetcher: fetcher as any, apiKey: key });
    const update = updateId();
    const input = { tenantId, updateId: update, chatId: String(chatId()), text: 'KAAE members evening, 5 October', requests: [view(requestId, id)], lang: 'en' as const };
    expect(await model.read(input)).toMatchObject({ intent: 'change', source: 'model', requestId, confidence: 0.92 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [row] = await calls(update);
    expect(row).toMatchObject({ status: 'completed', decision: { kind: 'change', design: 1, confidence: 0.92 } });
    expect(Number(row.cost_usd)).toBeGreaterThan(0);
    expect(row.spending_policy_version).toBeGreaterThan(0);
    // The office's budget counts it under the intake router's role.
    const budget = (await withRlsContext(owner, scope, (trx) => sql<{ b: any }>`SELECT hawa.studio_scope_budget_internal(${tenantId}::uuid, ${id}::uuid) AS b`.execute(trx))).rows[0].b;
    const role = budget.scopes.find((s: any) => s.scope === 'role' && s.subject === 'intake_router');
    expect(Number(role.spentUsd)).toBeGreaterThanOrEqual(Number(row.cost_usd));
    // A replay of the same update: the stored decision, no second call.
    expect(await model.read(input)).toMatchObject({ intent: 'change', requestId });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('ADR-286: whatever the router\'s confidence, its reading alone plans a question, never a paid round or a kept change', async () => {
    const id = await client();
    const waiting = view(randomUUID(), id);
    const planWith = async (text: string, requests: ChatRequestView[], decision: Record<string, unknown>) => {
      const model = createRequesterIntentModel(db, { fetcher: (async () => completion(decision)) as any, apiKey: key });
      const reading = await model.read({ tenantId, updateId: updateId(), chatId: String(chatId()), text, requests, lang: 'en' });
      expect(reading).toMatchObject({ source: 'model', intent: 'change' });
      const rules = readIntentByRules(text);
      return planTurn({ text, reading: { ...reading!, ...(rules.redo ? { redo: rules.redo } : {}) }, requests, bound: [], unboundReply: false,
        senderId: '1', officeIds: [], group: false, addressed: true, pendingAsk: null, now: Date.now() });
    };
    // A design waiting for the requester's changes, named by a sure router: asked, not revised.
    expect(await planWith('KAAE members evening, 5 October', [waiting], { kind: 'change', design: 1, confidence: 0.99 }))
      .toMatchObject({ kind: 'ask', intent: 'unclear', allowNew: true, options: [{ requestId: waiting.requestId }] });
    // A delivered design and redo-or-new words: "redo it, or a new design?", never a redo round.
    const delivered = { ...view(randomUUID(), id), stage: 'delivered' as const, sentToChat: true };
    expect(await planWith('do a better design for the conference', [delivered], { kind: 'change', design: 1, confidence: 0.94 }))
      .toMatchObject({ kind: 'ask', intent: 'unclear', redo: 'or-new', options: [{ requestId: delivered.requestId }] });
    // A design in review: a fragment is not kept as a change on the router's word.
    const review = { ...view(randomUUID(), id), stage: 'in_review' as const, rev: 2 };
    expect(await planWith('for the deans', [review], { kind: 'change', design: 1, confidence: 0.87 }))
      .toMatchObject({ kind: 'ask', intent: 'unclear', allowNew: true });
    // The rules' own change is planned as before.
    expect(planTurn({ text: 'make the title gold', reading: readIntentByRules('make the title gold'), requests: [waiting], bound: [],
      unboundReply: false, senderId: '1', officeIds: [], group: false, addressed: true, pendingAsk: null, now: Date.now() }))
      .toMatchObject({ kind: 'revise', requestId: waiting.requestId });
  });

  it('an answer it cannot read, or an unsure one, is no decision (the requester is asked)', async () => {
    const id = await client();
    for (const reply of [completion({ kind: 'unsure', design: 0, confidence: 0.4 }), new Response('{"id":"x"}', { status: 500 })]) {
      const update = updateId();
      const model = createRequesterIntentModel(db, { fetcher: (async () => reply) as any, apiKey: key });
      expect(await model.read({ tenantId, updateId: update, chatId: String(chatId()), text: 'Eid card', requests: [view(randomUUID(), id)], lang: 'en' })).toBeNull();
      expect((await calls(update))[0]).toMatchObject({ status: 'completed' });
    }
  });

  it('sends nothing without the client\'s consent, without a key, or without allowance', async () => {
    const fetcher = vi.fn(async () => completion({ kind: 'change', design: 1, confidence: 0.9 }));
    const local = await client('local_only');
    const read = (client: string, apiKey: () => string | undefined = key, update = updateId()) => createRequesterIntentModel(db, { fetcher: fetcher as any, apiKey })
      .read({ tenantId, updateId: update, chatId: String(chatId()), text: 'Eid card', requests: [view(randomUUID(), client)], lang: 'en' });
    expect(await read(local)).toBeNull();
    expect(await read(await client(), () => undefined)).toBeNull();
    expect(await read(await client(), () => 'mock-key')).toBeNull();
    const stopped = await client();
    await withRlsContext(owner, scope, (tx) => sql`INSERT INTO hawa.studio_spending_policies(tenant_id, version, reason, limits)
      SELECT ${tenantId}::uuid, coalesce(max(version), 0) + 1, 'Synthetic intake router stop',
        jsonb_build_object('officeUsd', 1000, 'clientUsd', 1000, 'roleUsd', 1000, 'clients', '{}'::jsonb,
          'roles', jsonb_build_object('intake_router', 0))
      FROM hawa.studio_spending_policies WHERE tenant_id = ${tenantId}::uuid`.execute(tx));
    const refused = updateId();
    expect(await read(stopped, key, refused)).toBeNull();
    expect(await calls(refused)).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

/**
 * ADR-040 addendum (incident 2026-10-01): "the design is not approved, …" read as approval because
 * "approved" is an approval phrase. A requester's refusal ("not approved", "don't send it") is never
 * happiness: with feedback it is the change, kept for the office; alone, the office hears the requester
 * is not happy, and no paid round starts. Kept words of a question are read again when it is answered.
 */
describe('a requester who refuses is never read as happy (ADR-040 addendum, 2026-10-01)', () => {
  const INCIDENT_WORDS = 'the design is not approved, the images cut with no content awareness, should have more images organized creatively, not just straight image on same old bg';

  it.each([
    [INCIDENT_WORDS, 'change', undefined], ['not approved, the photos are cropped badly', 'change', undefined],
    ['the design is not approved', 'change', true], ["don't send it", 'change', true], ['please do not send it yet', 'change', true],
    ["don't send it again", 'change', true], ["we can't approve this", 'change', true], ['not ready to print', 'change', true],
    // "Not approved", "don't send it"
    ['پەسەند نییە', 'change', true], ['مەینێرە', 'change', true],
  ] as const)('"%s" reads as %s (refusal only: %s)', (words, intent, refusalOnly) => {
    const reading = readIntentByRules(words);
    expect(reading.intent).toBe(intent);
    expect(reading.refusalOnly).toBe(refusalOnly);
  });

  it.each(['looks good, send it', 'send it', 'approved', 'no changes', 'باشە بینێرە'])('"%s" still reads as approval', (words) => {
    expect(readIntentByRules(words).intent).toBe('approval');
  });

  const view = (requestId: string, stage: ChatRequestView['stage'], rev: number, title: string): ChatRequestView => ({
    requestId, stage, rev, currentTaskId: `t-${requestId}`, clientId: null, title, activeAt: '2026-10-01T07:00:00Z',
    createdAt: '2026-10-01T06:00:00Z', question: null, requesterId: null });
  const input = (text: string, requests: ChatRequestView[], extra: Partial<TurnInput> = {}): TurnInput => ({
    text, reading: readIntentByRules(text), requests, bound: [], unboundReply: false, senderId: String(REQUESTER),
    officeIds: [String(OFFICE)], group: false, addressed: true, pendingAsk: null, now: Date.parse('2026-10-01T08:44:00Z'), ...extra });

  it('a question that kept refusing words as approval is answered with them read again: a change for the office, never happiness', () => {
    const requests = [view('a', 'in_review', 2, 'Field visit report'), view('b', 'in_review', 2, 'Pilot study')];
    const plan = planTurn(input('2', requests, { pendingAsk: { updateId: 41, intent: 'approval', words: INCIDENT_WORDS,
      options: requests.map((r) => ({ requestId: r.requestId, title: r.title })), allowNew: false } }));
    expect(plan).toEqual({ kind: 'note', note: 'change', requestId: 'b', words: INCIDENT_WORDS, resolves: 41 });
    // Genuine approval words kept with the question still tell the office the requester is happy.
    expect(planTurn(input('2', requests, { pendingAsk: { updateId: 42, intent: 'approval', words: 'looks good, send it',
      options: requests.map((r) => ({ requestId: r.requestId, title: r.title })), allowNew: false } })))
      .toEqual({ kind: 'tell', note: 'approval', requestId: 'b', words: 'looks good, send it', resolves: 42 });
  });

  it('a refusal alone never starts a paid round: with a design waiting for changes, the office hears it', () => {
    expect(planTurn(input("don't send it", [view('w', 'manual', 3, 'Nawroz poster')]))).toEqual({ kind: 'forward', words: "don't send it" });
    expect(planTurn(input('not approved', [view('r', 'in_review', 2, 'Nawroz poster')])))
      .toEqual({ kind: 'note', note: 'change', requestId: 'r', words: 'not approved' });
    expect(planTurn(input("don't send it", []))).toEqual({ kind: 'forward', words: "don't send it" });
  });

  it('the incident sentence on a design in review is kept for the office as a change; nothing is told as happiness', async () => {
    const chat = chatId();
    const request = await seed(chat, 'in_review', 2, { title: 'Pilot study poster', sent: { key: '2:design-outcome', messageId: '9301' } });
    const update = message(chat, INCIDENT_WORDS, { reply_to_message: { message_id: 9301 } });
    const answer = await intake(app(), update);
    expect(answer).toMatchObject({ intakeStatus: 409, code: 'LATE_REQUESTER_CHANGE', requestId: request.requestId,
      requestStage: 'in_review', intent: 'change' });
    expect(answer.note).toBeUndefined();
    expect(answer.officeAlert.text).not.toContain('happy');
    const pending = await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, request.requestId));
    expect(pending).toEqual([expect.objectContaining({ text: INCIDENT_WORDS })]);
    const refusal = await intake(app(), message(chat, "don't send it"));
    expect(refusal).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestId: request.requestId, intent: 'change' });
    expect(await requestRow(request.requestId)).toMatchObject({ stage: 'in_review' });
  });
});
