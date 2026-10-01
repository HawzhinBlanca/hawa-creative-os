import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { INBOX_MESSAGES, MEDIA_MESSAGES, ROUTING_MESSAGES } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { pendingLateChanges } from '../src/services/lifecycle-chat-target.js';
import { continuesBrief } from '../src/services/lifecycle-brief-parts.js';
import { plainClientAnswer, readSourceReply } from '../src/services/lifecycle-source-natural.js';
import { planTurn, readIntentByRules, type ChatRequestView } from '../src/services/requester-turn.js';

/**
 * ADR-156: the natural-language intake friction found by the audit of 2026-09-30 (items #9 to #15 and
 * the P2/P3 intake lines), as regression tests. The audit's probes (apps/core/test/audit/*.probe.ts on
 * the audit-intake worktree) are the pure tests; the route tests run against the per-file test
 * database as hawa_app (row-level security as in production).
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const OFFICE = 91000031;
const REQUESTER = 91000132;
const COLLEAGUE = 91000233;
const WORKER = ['worker', 'friction', 'adr156', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

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

const chatId = () => 64_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_100_000_000 + Math.floor(Math.random() * 800_000_000);
type Msg = Record<string, unknown>;
const message = (chat: number, fields: Msg, from = REQUESTER, chatType = 'private') => {
  const id = updateId();
  return { update_id: id, message: { message_id: id % 1_000_000, date: 1790000000,
    from: { id: from, is_bot: false, first_name: 'Requester' }, chat: { id: chat, type: chatType }, ...fields } as Msg };
};
const text = (chat: number, words: string, fields: Msg = {}, from = REQUESTER, chatType = 'private') =>
  message(chat, { text: words, ...fields }, from, chatType);
const photo = (chat: number, fields: Msg = {}, from = REQUESTER, chatType = 'private') =>
  message(chat, { photo: [{ file_id: `photo-${randomUUID()}`, width: 900, height: 900 }], ...fields }, from, chatType);

function app() {
  vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
  const bridge = { downloadFile: vi.fn(async () => PNG), dispatchOutboundMessage: vi.fn(async () => ({ success: true })),
    answerCallbackQuery: vi.fn(async () => true) };
  return { app: createApp({ db, telegramBridge: bridge, requesterIntentModel: null } as any), bridge };
}
const intake = async (a: any, update: unknown, body: Record<string, unknown> = {}) => {
  const res = await a.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker,
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true, ...body }) });
  return (await res.json()) as Record<string, any>;
};

/** A lifecycle request of the chat, from a brief its requester sent (and a bot message about it). */
async function seed(chat: number, stage: string, rev: number, options: { title?: string; requester?: number;
  sent?: { key: string; messageId: string } } = {}) {
  const requestId = randomUUID();
  const title = options.title ?? 'KAAE members evening';
  const brief = { update_id: updateId(), message: { message_id: 500 + Math.floor(Math.random() * 1000),
    from: { id: options.requester ?? REQUESTER, is_bot: false, first_name: 'Requester' }, chat: { id: chat, type: 'private' },
    date: 1790000000, text: title } };
  const created = await persistChatIntake(db, { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: String(chat),
    rawJson: brief, rawText: title, title, clientId, designInstructions: 'Make the approved event design',
    exactCopy: [{ text: 'December 4, 2026' }], autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 },
    studioOptions: { tier: 'quality' } }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id)
      VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, null, 'restate', ${stage}, ${rev}, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
    if (options.sent) {
      await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
        VALUES (${tenantId}::uuid, 'telegram_delivery', ${`lc:${requestId}:${options.sent.key}:send`}, 'telegram_message_sent',
          ${JSON.stringify({ messageId: options.sent.messageId })}::jsonb, ${`adr156-sent-${requestId}`}, true)`.execute(trx);
    }
  });
  return { requestId, taskId, briefMessageId: brief.message.message_id };
}
const requestRow = async (requestId: string) => (await withRlsContext(db, scope, (trx) => sql<{ rev: string; stage: string }>`
  SELECT rev, stage FROM hawa.requests WHERE request_id = ${requestId}::uuid`.execute(trx))).rows[0];
const tasksInChat = async (chat: number) => (await withRlsContext(db, scope, (trx) =>
  trx.selectFrom('outbox_commands').select(['aggregate_id', 'payload']).where('command_type', '=', 'task.created').execute()))
  .filter((r: any) => String(r.payload?.sourceChannelId) === String(chat));
const taskFiles = async (taskId: string) => (await sql<{ sha256: string; role: string }>`SELECT sha256, role FROM hawa.task_files
  WHERE task_id = ${taskId}::uuid`.execute(owner)).rows;

const view = (stage: ChatRequestView['stage'], extra: Partial<ChatRequestView> = {}): ChatRequestView => ({ requestId: 'r-a', stage,
  rev: 4, currentTaskId: 't-a', clientId: null, title: 'Annual conference poster', activeAt: new Date().toISOString(),
  createdAt: new Date(Date.now() - 30_000).toISOString(), question: null, requesterId: '1', ...extra });
const turn = { bound: [], unboundReply: false, senderId: '1', officeIds: ['9'], group: false, addressed: true, pendingAsk: null, now: Date.now() };
const plan = (words: string, requests: ChatRequestView[]) => planTurn({ ...turn, text: words, reading: readIntentByRules(words), requests });

describe('the audit probes, as rules (no database)', () => {
  it.each([
    'Can you send it as a PDF too?', 'Please send it again, it did not arrive', 'send it to my email please',
    'can you send the files in high resolution?', 'I never received the file', 'please resend', 'send it to info@example.org',
    'دووبارە بینێرەوە', 'بە pdf بینێرە', 'پێم نەگەیشت',
  ])('#9 "%s" asks the office about the files: never approval', (words) => {
    expect(readIntentByRules(words).intent).toBe('delivery_request');
    expect(plan(words, [view('delivered')])).toEqual({ kind: 'tell', note: 'delivery', requestId: 'r-a', words });
    expect(plan(words, [view('in_review')])).toMatchObject({ kind: 'tell', note: 'delivery' });
    // With no design this chat still lists, the office finds it: the words are passed on.
    expect(plan(words, [])).toEqual({ kind: 'forward', words });
  });

  it.each([
    ['looks good, send it', 'approval'], ['Perfect! You can send it', 'approval'], ['باشە بینێرە', 'approval'],
    ['the email should be info@example.org', 'change'], ['add my email hawre@example.org', 'change'],
    ['use a higher resolution logo', 'change'],
  ] as const)('#9 "%s" still reads as %s', (words, intent) => {
    expect(readIntentByRules(words).intent).toBe(intent);
  });

  it('#15 a short brief that states a deadline is a brief, whatever is open', () => {
    const brief = 'Invitation card for the graduation ceremony at the hotel, 5 October 7pm, needed by Thursday';
    expect(readIntentByRules(brief)).toMatchObject({ intent: 'new_brief', substantial: true });
    expect(plan(brief, [])).toMatchObject({ kind: 'open', text: brief, instructionOnly: false });
    expect(plan(brief, [view('designing', { rev: 2 })])).toMatchObject({ kind: 'open', text: brief });
    // A deadline on its own, or one that names the design it is about, is still a deadline.
    for (const words of ['we need it by tomorrow', 'urgent please', 'The poster for the conference is needed by Thursday']) {
      expect(readIntentByRules(words).intent, words).toBe('deadline');
    }
  });

  it('#13 while "is this exactly the text?" waits, only a confirmation or words like the copy answer it', () => {
    for (const words of ['Also make the background blue', 'Can you make a poster for the book fair on 3 November?',
      'what fonts do you have?', 'hello', 'send it again please']) {
      expect(readSourceReply(words, 'Nawroz celebration\n21 March 2027\nCity Park').kind, words).toBe('other');
    }
    expect(readSourceReply('yes').kind).toBe('yes');
    expect(readSourceReply('Nawroz celebrations\n21 March 2027, 5pm\nCity Park, Sulaymaniyah', 'Nawroz celebration\n21 March 2027\nCity Park'))
      .toEqual({ kind: 'copy', copy: 'Nawroz celebrations\n21 March 2027, 5pm\nCity Park, Sulaymaniyah' });
    // Copy that shares little with what was heard is still taken when it reads as copy, not as a request.
    expect(readSourceReply('KAAE Annual Dinner\n4 December 2026\nRotana Hotel, Erbil', 'something else entirely').kind).toBe('copy');
    // "Which organisation is it for?" takes a plain answer only.
    expect(plainClientAnswer('KAAE')).toBe(true);
    expect(plainClientAnswer("it's for KAAE")).toBe(true);
    expect(plainClientAnswer('Can you make a poster for KAAE for the book fair on 3 November?')).toBe(false);
    expect(plainClientAnswer('make the KAAE logo bigger')).toBe(false);
  });

  it('#10 a message continues a held brief only when Telegram split it or both were forwarded, within seconds', () => {
    const long = { text: 'x'.repeat(4096), date: 100, forwarded: false, reply: false };
    const tail = { text: 'Venue: Grand Hall', date: 101, forwarded: false, reply: false };
    expect(continuesBrief(long, tail)).toEqual({ separator: '\n' });
    expect(continuesBrief(long, { ...tail, date: 130 })).toBeNull();
    expect(continuesBrief({ ...long, text: 'short brief' }, tail)).toBeNull();
    expect(continuesBrief(long, { ...tail, reply: true })).toBeNull();
    expect(continuesBrief(long, { ...tail, text: '/status' })).toBeNull();
    const forwarded = { text: 'Nawroz celebration', date: 100, forwarded: true, reply: false };
    expect(continuesBrief(forwarded, { ...forwarded, text: 'Free entry', date: 102 })).toEqual({ separator: '\n\n' });
    expect(continuesBrief(forwarded, { ...tail, date: 102 })).toBeNull();
  });

  it('P3: "I could not make this change" never asks the requester to contact the office', () => {
    expect(INBOX_MESSAGES.changeNotStarted.en).not.toMatch(/let the office know|contact the office|tell the office|ask the office/i);
    expect(INBOX_MESSAGES.changeNotStarted.ckb).not.toContain('ئاگادار بکەرەوە');
  });
});

describe('#9: "send it again", "as a PDF", "to my email" reach the office with a truthful answer', () => {
  it('after delivery, "send it again, it did not arrive" is passed to the office, never taken as approval', async () => {
    const { app: a } = app();
    const chat = chatId();
    const delivered = await seed(chat, 'delivered', 7, { title: 'Nawroz poster' });
    const answer = await intake(a, text(chat, 'Please send it again, it did not arrive'));
    expect(answer).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', intent: 'delivery_request', note: 'delivery',
      requestId: delivered.requestId,
      chatAnswer: { text: "Got it. I've passed your request about <b>Nawroz poster</b> to the office; they'll follow up here." },
      officeAlert: { chatId: String(OFFICE), text: expect.stringContaining('Please send it again, it did not arrive') } });
    expect(answer.officeAlert.text).toMatch(/asks about the files of "Nawroz poster" \(delivered\)/);
    expect(answer.chatAnswer.text).not.toMatch(/thank|happy/i);
    expect(await requestRow(delivered.requestId)).toMatchObject({ rev: '7', stage: 'delivered' });
    expect(await tasksInChat(chat)).toHaveLength(1);
    // In Sorani, and the same answer on a replay.
    const kurdish = text(chat, 'دووبارە بینێرەوە');
    const ckb = await intake(a, kurdish);
    expect(ckb.chatAnswer.text).toContain('داواکارییەکەتم سەبارەت بە');
    expect(await intake(a, kurdish)).toMatchObject({ duplicate: true, chatAnswer: ckb.chatAnswer });
  });

  it('"can you send it as a PDF too?" while the office checks the design is passed on and holds nothing', async () => {
    const { app: a } = app();
    const chat = chatId();
    const review = await seed(chat, 'in_review', 2, { title: 'Graduation flyer' });
    const answer = await intake(a, text(chat, 'Can you send it as a PDF too?'));
    expect(answer).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', note: 'delivery',
      chatAnswer: { text: expect.stringContaining('<b>Graduation flyer</b>') } });
    // Not a change: Deliver is not held for it.
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, review.requestId))).toEqual([]);
  });
});

describe('#10: a long message Telegram split, or forwards sent together, are one brief', () => {
  const BRIEF = ['Annual Engineering Conference 2026', '', 'Date: 12 November 2026, 9:00 am', 'Venue: Erbil International Hotel', '',
    'Programme:', ...Array.from({ length: 60 }, (_, i) => `Session ${i + 1}: a talk on renewable energy policy and water resources in the region`)].join('\n');
  const TAIL = 'Speakers:\nDr. A — keynote on renewable energy policy\nDr. B — panel on water resources\n\nContact: info@example.org';

  it('the rest of a split message joins the held brief: one request, with all of its copy', async () => {
    const { app: a } = app();
    const chat = chatId();
    expect(BRIEF.length).toBeGreaterThan(3000);
    const first = text(chat, BRIEF);
    const second = text(chat, TAIL, { date: 1790000001 });
    expect(await intake(a, first, { briefHold: true })).toMatchObject({ intakeStatus: 202, lifecycleAction: 'settle-later', settle: { kind: 'brief' } });
    const joined = await intake(a, second, { briefHold: true });
    expect(joined).toMatchObject({ intakeStatus: 200, briefPart: true });
    expect(joined.lifecycleAction).toBeUndefined();
    const opened = await intake(a, first, { settle: true, briefHold: true });
    expect(opened).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request' });
    expect(opened.draft.rawText).toBe(`${BRIEF}\n${TAIL}`);
    // The part replays as joined; nothing else opens.
    expect(await intake(a, second, { briefHold: true })).toMatchObject({ intakeStatus: 200, briefPart: true });
    const opens = (await sql<{ n: string }>`SELECT count(*)::text AS n FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid
      AND source_account_id = 'lifecycle_chat_open' AND payload->>'chatId' = ${String(chat)}`.execute(owner)).rows[0].n;
    expect(opens).toBe('1');
  });

  it('forwards sent together join the first; a message of the sender\'s own is still read after the brief opens', async () => {
    const { app: a } = app();
    const chat = chatId();
    const origin = { forward_origin: { type: 'channel', chat: { id: -100123, type: 'channel', title: 'KAAE' }, message_id: 7, date: 1789990000 } };
    const first = text(chat, 'Nawroz celebration\n\n21 March 2027, 5pm\nCity Park, Sulaymaniyah\nOrganised by the KAAE youth committee', origin);
    const second = text(chat, 'Free entry for families.\nMusic, dance and traditional food until 10pm.', { ...origin, date: 1790000001 });
    const own = text(chat, 'thanks', { date: 1790000002 });
    expect(await intake(a, first, { briefHold: true })).toMatchObject({ intakeStatus: 202, settle: { kind: 'brief' } });
    expect(await intake(a, second, { briefHold: true })).toMatchObject({ intakeStatus: 200, briefPart: true });
    // Not a forward, and the brief before it was not split: set behind the brief as before (ADR-145).
    expect(await intake(a, own, { briefHold: true })).toMatchObject({ intakeStatus: 202, settle: { kind: 'brief' } });
    const opened = await intake(a, first, { settle: true, briefHold: true });
    expect(opened.draft.rawText).toBe(`${(first.message as any).text}\n\n${(second.message as any).text}`);
  });
});

describe('#11: captioned photos are read as text is', () => {
  it('a new photo brief while another design waits for changes opens a request, never a paid round of the old one', async () => {
    const { app: a, bridge } = app();
    const chat = chatId();
    const waiting = await seed(chat, 'manual', 3, { title: 'KAAE members evening' });
    const brief = photo(chat, { caption: 'New poster for the book fair\n\n3 November 2026, 10am\nErbil International Fair Grounds' });
    const opened = await intake(a, brief);
    expect(opened).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request',
      draft: { lifecycleImage: { sha256: sha(PNG), updateId: brief.update_id } } });
    expect(opened.draft.rawText).toContain('book fair');
    expect(await requestRow(waiting.requestId)).toMatchObject({ rev: '3', stage: 'manual' });
    expect(bridge.downloadFile).toHaveBeenCalledTimes(1);
  });

  it('"use this logo" with a photo while the design is being made is added to that design, and the office is told', async () => {
    const { app: a } = app();
    const chat = chatId();
    const designing = await seed(chat, 'designing', 2, { title: 'KAAE members evening' });
    const answer = await intake(a, photo(chat, { caption: 'use this logo' }));
    expect(answer).toMatchObject({ intakeStatus: 409, lifecycleAction: 'late-change', requestId: designing.requestId,
      requestStage: 'designing',
      chatAnswer: { text: "Got it. I've kept that with <b>KAAE members evening</b> for the office; they'll see it before the design is sent to you." },
      officeAlert: { chatId: String(OFFICE), text: expect.stringContaining('use this logo') } });
    expect(answer.officeAlert.text).toContain("It was added to the design's files.");
    expect(answer.chatAnswer.text).not.toMatch(/send me the text/i);
    expect(await taskFiles(designing.taskId)).toEqual([{ sha256: sha(PNG), role: 'reference_image' }]);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('in a group, a colleague\'s photo about the requester\'s design changes nothing of it', async () => {
    const { app: a } = app();
    const chat = -chatId();
    const designing = await seed(chat, 'designing', 2, { title: 'KAAE members evening' });
    const passive = await intake(a, photo(chat, { caption: 'use this logo' }, COLLEAGUE, 'supergroup'));
    expect(passive.lifecycleAction).not.toBe('late-change');
    expect(await taskFiles(designing.taskId)).toEqual([]);
    expect(await withRlsContext(db, scope, (trx) => pendingLateChanges(trx, tenantId, designing.requestId))).toEqual([]);
  });
});

describe('#11: an album with words is read as text is', () => {
  const albumApp = () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const bridge = { downloadFile: vi.fn(async (file: string) => Buffer.concat([PNG, Buffer.from([Number(file.replace(/\D/g, '')) % 256])])),
      dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
    return createApp({ db, telegramBridge: bridge, requesterIntentModel: null } as any);
  };
  const album = async (a: any, chat: number, caption: string) => {
    const group = `album-${randomUUID()}`;
    // Telegram numbers an album's photos in order; the newest photo's settle is the one that acts.
    const first = 300_000 + Math.floor(Math.random() * 100_000);
    const parts = [1, 2].map((n) => message(chat, { message_id: first + n, media_group_id: group, photo: [{ file_id: `album-${n}` }],
      ...(n === 1 ? { caption } : {}) }));
    parts[1].update_id = parts[0].update_id + 1;
    for (const part of parts) expect(await intake(a, part, { briefHold: true })).toMatchObject({ intakeStatus: 202, settle: { kind: 'album' } });
    return intake(a, parts[1], { settle: true, briefHold: true });
  };

  it('an album brief while another design waits for changes opens its own request, never a paid round of the old one', async () => {
    const a = albumApp();
    const chat = chatId();
    const waiting = await seed(chat, 'manual', 3, { title: 'Graduation flyer' });
    const opened = await album(a, chat, 'KAAE annual report cover\n---\nAnnual Report 2026\nKurdistan Accreditation Agency for Education\nErbil');
    expect(opened).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', draft: { lifecycleAlbum: { images: [{}, {}] } } });
    expect(await requestRow(waiting.requestId)).toMatchObject({ rev: '3', stage: 'manual' });
  });

  it('album words that could be a change to a waiting design go to the office, never to a paid round', async () => {
    const a = albumApp();
    const chat = chatId();
    const waiting = await seed(chat, 'manual', 3, { title: 'Graduation flyer' });
    const answer = await album(a, chat, 'Poster with these');
    expect(answer).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', chatAnswer: { text: ROUTING_MESSAGES.forwardedToOffice.en },
      officeAlert: { text: expect.stringContaining('album of photos') } });
    expect(await requestRow(waiting.requestId)).toMatchObject({ rev: '3', stage: 'manual' });
  });
});

describe('#12: a photo sent as a reply is material for the open design', () => {
  it.each(['own brief', 'the bot\'s "making a first draft" message', 'a colleague\'s message'] as const)(
    'a photo replying to %s while the design is being made is added to it, with no untrue "with the office"', async (target) => {
      const { app: a } = app();
      const chat = chatId();
      const designing = await seed(chat, 'designing', 2, { title: 'KAAE members evening', sent: { key: '1:open-ack', messageId: '4242' } });
      const reply = target === 'own brief' ? { message_id: designing.briefMessageId, from: { id: REQUESTER, is_bot: false } }
        : target === 'a colleague\'s message' ? { message_id: 999_111, from: { id: COLLEAGUE, is_bot: false } }
          : { message_id: 4242, from: { id: 7000001, is_bot: true } };
      const answer = await intake(a, photo(chat, { reply_to_message: reply }));
      expect(answer).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', media: 'photo-joined', requestId: designing.requestId,
        chatAnswer: { text: "Got the photo. I've added it to <b>KAAE members evening</b>." } });
      expect(answer.chatAnswer.text).not.toMatch(/with the office/i);
      expect(await taskFiles(designing.taskId)).toEqual([{ sha256: sha(PNG), role: 'reference_image' }]);
    });

  it('once the design has started using pictures, the photo is passed to the office, truthfully', async () => {
    const { app: a } = app();
    const chat = chatId();
    const designing = await seed(chat, 'designing', 2, { title: 'KAAE members evening' });
    const run = randomUUID();
    await sql`INSERT INTO hawa.design_studio_runs (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, request, tier, status)
      VALUES (${run}::uuid, ${tenantId}::uuid, ${designing.taskId}::uuid, ${clientId}::uuid, 'synthetic-actor', ${run}, ${sha(Buffer.from(run))},
        '{}', 'standard', 'transferred')`.execute(owner);
    const answer = await intake(a, photo(chat, { reply_to_message: { message_id: designing.briefMessageId, from: { id: REQUESTER, is_bot: false } } }));
    expect(answer).toMatchObject({ intakeStatus: 409, lifecycleAction: 'late-change',
      chatAnswer: { text: MEDIA_MESSAGES.photoPassed.en.replace('{title}', '<b>KAAE members evening</b>') } });
    expect(await taskFiles(designing.taskId)).toEqual([]);
  });
});

describe('P2/P3 intake lines', () => {
  it('"/design …" in a private chat opens the brief after the command, as in a group', async () => {
    const { app: a } = app();
    const chat = chatId();
    const opened = await intake(a, text(chat, '/design a poster for Nawroz on 21 March at the city park'));
    expect(opened).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request',
      draft: { rawText: 'a poster for Nawroz on 21 March at the city park' } });
  });

  it('a sticker is not a greeting: nothing is said, and a repeat says nothing', async () => {
    const { app: a } = app();
    const chat = chatId();
    const sticker = message(chat, { sticker: { file_id: 'sticker-1', emoji: '👍', width: 512, height: 512 } });
    const answer = await intake(a, sticker);
    expect(answer).toMatchObject({ intakeStatus: 200, status: 'NO_WORDS', sticker: true });
    expect(answer.chatAnswer).toBeUndefined();
    const again = await intake(a, sticker);
    expect(again.chatAnswer).toBeUndefined();
  });

  it('a logo sent as an SVG file goes to the office on the open design, never "send it again as a photo"', async () => {
    const { app: a, bridge } = app();
    const chat = chatId();
    const designing = await seed(chat, 'designing', 2, { title: 'KAAE members evening' });
    const svg = message(chat, { caption: 'our logo', document: { file_id: 'svg-logo', file_name: 'kaae-logo.svg', mime_type: 'image/svg+xml', file_size: 2048 } });
    const answer = await intake(a, svg);
    expect(answer).toMatchObject({ intakeStatus: 409, lifecycleAction: 'late-change', requestId: designing.requestId,
      chatAnswer: { text: MEDIA_MESSAGES.svgPassedForDesign.en.replace('{title}', '<b>KAAE members evening</b>') },
      officeAlert: { text: expect.stringContaining('kaae-logo.svg') } });
    expect(answer.chatAnswer.text).not.toMatch(/again|as a photo/i);
    expect(bridge.downloadFile).not.toHaveBeenCalled();
    expect(await intake(a, svg)).toMatchObject({ intakeStatus: 409, lifecycleAction: 'late-change', requestId: designing.requestId });
    // With no open design, the office still gets it.
    const empty = chatId();
    const alone = await intake(a, message(empty, { document: { file_id: 'svg-2', file_name: 'logo.svg', mime_type: 'image/svg+xml' } }));
    expect(alone).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', media: 'svg',
      chatAnswer: { text: MEDIA_MESSAGES.svgPassed.en }, officeAlert: { chatId: String(OFFICE) } });
  });

  it('routing words for a delivery request exist in both languages', () => {
    expect(ROUTING_MESSAGES.deliveryRequestPassed.en).toContain('{title}');
    expect(ROUTING_MESSAGES.deliveryRequestPassed.ckb).toContain('{title}');
  });
});
