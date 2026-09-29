import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { classifyWithHeuristics } from '../src/services/telegram-classifier.js';

/**
 * NATURAL-LANGUAGE FRICTION AUDIT (2026-09-29), plans/lean-design-implementation-2026-09-28/
 * NATURAL_LANGUAGE_FRICTION_AUDIT.md.
 *
 * Owner rule: requesters write naturally (English, Sorani, mixed, photos, voice, PDFs, replies,
 * forwards). No slash commands, keywords, exact formats or "reply to message X" tricks, and a
 * natural message is never refused, silently dropped or misread.
 *
 * Every test here is `it.fails`: it asserts the NATURAL behaviour, and passes today only because the
 * product does not behave that way yet. Each one names its finding (F-number in the report). When a
 * fix lands, the matching `it.fails` starts failing: turn it into a plain `it` in the fix's commit.
 * Nothing here changes product code; the fixtures are those of lifecycle-internal-intake.test.ts.
 */
/**
 * `bug` is `it.fails`. Run with AUDIT_SHOW_FAILURES=1 to make every audit test a plain `it` and see
 * the assertion each one fails on today (a check that it fails for the stated reason, not a setup error).
 */
const bug = process.env.AUDIT_SHOW_FAILURES === '1' ? it : it.fails;

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const operatorUserId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
const OFFICE = 91000007;
const WORKER = ['worker', 'intake', 'fixture', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };

const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
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
  await db.destroy();
});

const chatId = () => 63_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_100_000_000 + Math.floor(Math.random() * 800_000_000);
type Msg = Record<string, unknown>;
const message = (chat: number, fields: Msg, chatType = 'private') => {
  const id = updateId();
  return { update_id: id, message: { message_id: id % 100000, from: { id: OFFICE, is_bot: false, first_name: 'Requester' },
    chat: { id: chat, type: chatType }, date: 1790000000, ...fields } as Msg };
};

/** Telegram's sendMessage, recorded; anything else goes to the real fetch. */
function fakeTelegram() {
  const realFetch = globalThis.fetch;
  const sent: Array<{ chat_id: string | number; text: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
    if (url.includes('/sendMessage')) {
      const body = JSON.parse(String(init?.body || '{}'));
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: 1 + sent.length, chat: { id: body.chat_id } } });
    }
    return Response.json({ ok: true, result: true });
  });
  return { sent };
}

const intake = async (app: any, update: unknown) => {
  const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker,
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/** A lifecycle request of this chat at `stage`/`rev`, with an optional lifecycle message the requester can reply to. */
async function seedRequest(chat: number, stage: string, rev: number, sent?: { key: string; messageId: string }) {
  const requestId = randomUUID();
  const created = await persistChatIntake(db, {
    platform: 'telegram', sourceEventId: `lc-seed-${requestId}`, sourceChannelId: String(chat),
    rawText: 'KAAE members evening', title: 'KAAE members evening', clientId,
    designInstructions: 'Make the approved event design', exactCopy: [{ text: 'December 4, 2026' }],
    autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 },
    studioOptions: { tier: 'quality' },
  }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id,
      parent_request_id, owner, stage, rev, chat_id)
    VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid,
      null, 'restate', ${stage}, ${rev}, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid
      WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
    if (sent) {
      await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id,
          event_kind, payload, payload_hash, verified)
        VALUES (${tenantId}::uuid, 'telegram_delivery', ${`lc:${requestId}:${sent.key}:send`},
          'telegram_message_sent', ${JSON.stringify({ messageId: sent.messageId })}::jsonb,
          ${`audit-sent-${requestId}`}, true)`.execute(trx);
    }
  });
  return { requestId, taskId };
}

function app(extra: Record<string, unknown> = {}) {
  vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
  // A fixture bot token so the old intake's replies reach fakeTelegram's sendMessage.
  vi.stubEnv('TELEGRAM_BOT_TOKEN', ['700000001', ['fixture', 'bot', 'audit'].join('_')].join(':'));
  return createApp({ db, ...extra } as any);
}

describe('F1: acknowledgements and chatter are read as design instructions while a design waits for changes', () => {
  bug.each(['thanks', 'ok', '👍', 'سوپاس', '/status', '/start', 'when will it be ready?'])(
    '"%s" in a chat whose design waits for changes does not start a paid revision round', async (words) => {
    fakeTelegram();
    const chat = chatId();
    await seedRequest(chat, 'manual', 3);
    const answer = await intake(app(), message(chat, { text: words }));
    // Today: lifecycleAction 'requester-revision', directive = the word, a new paid design task.
    expect(answer.body.lifecycleAction).not.toBe('requester-revision');
  });
});

describe('F2: a new, unrelated brief while one design waits for changes is swallowed as that design\'s revision', () => {
  bug('a complete new brief opens a new request (or asks), instead of revising the waiting design', async () => {
    fakeTelegram();
    const chat = chatId();
    await seedRequest(chat, 'manual', 3);
    const answer = await intake(app(), message(chat, {
      text: 'New poster please for the graduation ceremony\n\nDate: 12 October 2026\nVenue: Erbil International Hotel' }));
    // Today: lifecycleAction 'requester-revision' against the waiting design.
    expect(answer.body.lifecycleAction).toBe('open-request');
  });
});

describe('F3: two designs waiting means every natural message is refused with "reply directly to the revision notice"', () => {
  bug('"thanks" with two waiting designs is not refused as an ambiguous request', async () => {
    fakeTelegram();
    const chat = chatId();
    await seedRequest(chat, 'manual', 3);
    await seedRequest(chat, 'manual', 3);
    const answer = await intake(app(), message(chat, { text: 'thanks' }));
    // Today: 409 AMBIGUOUS_REQUEST, lifecycleAction 'request-choice-required'.
    expect(answer.body.code).not.toBe('AMBIGUOUS_REQUEST');
  });
});

describe('F4: a correction while the design is being made', () => {
  bug.each([
    'the date should be 5 October not 4',
    'make the title bigger',
    'also add the phone number 0750 123 4567',
  ])('"%s" sent as a plain message does not open a second request', async (words) => {
    fakeTelegram();
    const chat = chatId();
    await seedRequest(chat, 'designing', 2);
    const answer = await intake(app(), message(chat, { text: words }));
    // Today: lifecycleAction 'open-request': a second request (a paid one when the chat has a client).
    expect(answer.body.lifecycleAction).not.toBe('open-request');
  });

  bug('a reply to the "Request received" acknowledgement is not refused as a stale reply', async () => {
    fakeTelegram();
    const chat = chatId();
    await seedRequest(chat, 'designing', 2, { key: '1:ack', messageId: '4401' });
    const answer = await intake(app(), message(chat, { text: 'Sorry, the date is 5 October', reply_to_message: { message_id: 4401 } }));
    // Today: 409 STALE_REQUEST_REPLY, "That design is no longer waiting for changes. Please reply to the current revision notice".
    expect(answer.body.code).not.toBe('STALE_REQUEST_REPLY');
  });

  bug('a reply to the requester\'s own earlier brief is not refused as a stale reply', async () => {
    fakeTelegram();
    const chat = chatId();
    await seedRequest(chat, 'designing', 2);
    const answer = await intake(app(), message(chat, { text: 'add our logo too', reply_to_message: { message_id: 77 } }));
    expect(answer.body.code).not.toBe('STALE_REQUEST_REPLY');
  });
});

describe('F5: a split brief (photo first, words second) loses the photo', () => {
  bug('a captionless photo right after a brief is kept with it, not parked for an operator', async () => {
    fakeTelegram();
    const chat = chatId();
    const a = app({ telegramBridge: { downloadFile: vi.fn(async () => null), dispatchOutboundMessage: vi.fn(async () => ({ success: true })) } });
    const briefAnswer = await intake(a, message(chat, { text: 'KAAE members evening\n---\nDecember 4, 2026\nErbil' }));
    expect(briefAnswer.body.lifecycleAction).toBe('open-request');
    const photo = await intake(a, message(chat, { photo: [{ file_id: 'after-brief', file_size: 1000, width: 900, height: 900 }] }));
    // Today: 422 park-update LIFECYCLE_MEDIA_NOT_ADMITTED; the sender hears PARKED_UPDATE_NOTICE, the office is alerted.
    expect(photo.body.lifecycleAction).not.toBe('park-update');
  });
});

describe('F6: voice and PDF briefs demand an exact "Client:" line', () => {
  bug('a voice note (Telegram gives it no caption) in a fresh chat is not refused for a missing "Client:" line', async () => {
    fakeTelegram();
    const chat = chatId();
    const answer = await intake(app(), message(chat, { voice: { file_id: 'voice-brief', duration: 12, mime_type: 'audio/ogg' } }));
    // Today: 422 source-message "Name one active client in the source caption: Client: <client code or full name>. …"
    expect(String(answer.body.sourceMessage ?? '')).not.toMatch(/Client:/);
  });

  bug('a PDF with a natural caption is not refused for a missing "Client:" line', async () => {
    fakeTelegram();
    const chat = chatId();
    const answer = await intake(app(), message(chat, {
      document: { file_id: 'pdf-brief', mime_type: 'application/pdf', file_name: 'programme.pdf' },
      caption: 'Please make a poster from this programme for KAAE' }));
    expect(String(answer.body.sourceMessage ?? '')).not.toMatch(/Client:/);
  });

  bug('a voice note sent while a design waits for changes is not told to use /new', async () => {
    fakeTelegram();
    const chat = chatId();
    await seedRequest(chat, 'manual', 3);
    const answer = await intake(app(), message(chat, { voice: { file_id: 'voice-change', duration: 8, mime_type: 'audio/ogg' } }));
    // Today: "For a new design, start the source caption with /new and Client: <client code>. For a revision, reply to its current notice."
    expect(String(answer.body.sourceMessage ?? '')).not.toMatch(/\/new|reply to its/);
  });
});

describe('F7: replies to the draft while it is with the office', () => {
  bug.each(['thanks', 'looks good, send it'])(
    '"%s" in reply to the draft is not filed as a late change the office must acknowledge', async (words) => {
    fakeTelegram();
    const chat = chatId();
    await seedRequest(chat, 'in_review', 2, { key: '2:design-outcome', messageId: '5501' });
    const answer = await intake(app(), message(chat, { text: words, reply_to_message: { message_id: 5501 } }));
    // Today: 409 LATE_REQUESTER_CHANGE + office alert; Deliver then waits for someone to acknowledge "thanks".
    expect(answer.body.code).not.toBe('LATE_REQUESTER_CHANGE');
  });
});

describe('F8: group chats', () => {
  bug('ordinary group conversation that mentions an event does not open a design request', async () => {
    fakeTelegram();
    const chat = -(1_000_000_000_000 + Math.floor(Math.random() * 1_000_000));
    const answer = await intake(app(), message(chat, {
      text: 'Colleagues, the conference dinner is on Monday at the Rotana hotel, please be on time.' }, 'supergroup'));
    // Today: lifecycleAction 'open-request' (legacy intake treated group chatter as MESSAGE_ONLY).
    expect(answer.body.lifecycleAction).not.toBe('open-request');
  });
});

describe('F9: a request that opens with a greeting or is phrased as a question is answered with a canned reply and dropped', () => {
  bug.each([
    'Hi, can you make a poster for our Nawroz party?',
    'Can you make a poster for Nawroz?',
  ])('"%s" is taken as a request', async (words) => {
    const { sent } = fakeTelegram();
    const chat = chatId();
    const answer = await intake(app(), message(chat, { text: words }));
    // Today: no open-request; legacy finish-only answers "Hello! How can Hawa Creative OS assist you today?"
    // or "Question received … For revisions on an existing design, reply directly to the preview message."
    expect(answer.body.lifecycleAction, `bot answered: ${JSON.stringify(sent.map((m) => m.text))}`).toBe('open-request');
  });

  it('heuristics evidence: the local classifier reads these requests as chatter (documents today)', () => {
    expect(classifyWithHeuristics('Hi, can you make a poster for our Nawroz party?', false, false).kind).toBe('other');
    expect(classifyWithHeuristics('Can you make a poster for Nawroz?', false, false).kind).toBe('question');
    expect(classifyWithHeuristics('Eid Mubarak', false, false).kind).toBe('other');
    // A correction with no design keyword becomes an instruction-only NEW brief when no design "waits".
    const correction = classifyWithHeuristics('make the title bigger', false, false);
    expect(correction).toMatchObject({ kind: 'new_brief', isInstructionOnly: true });
    // …and a factual correction becomes a full new brief (automatic, paid, when the chat has a client).
    expect(classifyWithHeuristics('the date should be 5 October not 4', false, false)).toMatchObject({ kind: 'new_brief', isInstructionOnly: false });
    // Natural cancellation is not recognised at all.
    expect(classifyWithHeuristics('please cancel the poster', false, false).kind).toBe('new_brief');
  });
});

describe('F10: status questions and cancellations while a design is being made', () => {
  bug('"when will it be ready?" gets an answer about the running design, not a reply-to-the-preview instruction', async () => {
    const { sent } = fakeTelegram();
    const chat = chatId();
    await seedRequest(chat, 'designing', 2);
    await intake(app(), message(chat, { text: 'when will it be ready?' }));
    const texts = sent.filter((m) => String(m.chat_id) === String(chat)).map((m) => m.text).join('\n');
    expect(texts).toMatch(/being (made|designed)|working on/i);
    expect(texts).not.toMatch(/reply directly to the preview/i);
  });

  bug('"cancel that" is acknowledged as a cancellation request', async () => {
    const { sent } = fakeTelegram();
    const chat = chatId();
    await seedRequest(chat, 'designing', 2);
    await intake(app(), message(chat, { text: 'cancel that' }));
    const texts = sent.filter((m) => String(m.chat_id) === String(chat)).map((m) => m.text).join('\n');
    // Today: nothing about cancelling; the design keeps running (legacy answers a greeting or nothing).
    expect(texts).toMatch(/cancel|stop/i);
  });
});

describe('F13: approvals, cancellations and deadlines written as plain messages open new design requests', () => {
  bug.each([
    'looks good, send it',
    'please cancel the poster',
    'we need it by tomorrow',
  ])('"%s" while the draft is with the office does not open a new request', async (words) => {
    fakeTelegram();
    const chat = chatId();
    await seedRequest(chat, 'in_review', 2, { key: '2:design-outcome', messageId: '7701' });
    const answer = await intake(app(), message(chat, { text: words }));
    // Today: lifecycleAction 'open-request' with autoGenerate true: a second, automatic (paid when the
    // chat has a client) design whose copy is the requester's sentence.
    expect(answer.body.lifecycleAction, JSON.stringify(answer.body.draft?.autoGenerate)).not.toBe('open-request');
  });

  it('heuristics evidence (documents today)', () => {
    for (const words of ['looks good, send it', 'perfect, send it to me', 'please cancel the poster', 'we need it by tomorrow']) {
      expect(classifyWithHeuristics(words, false, false), words).toMatchObject({ kind: 'new_brief', isInstructionOnly: false });
    }
    // Sorani "Hello, make a poster for Nawroz" is read as a greeting; "OK, send it" as chatter.
    expect(classifyWithHeuristics('سڵاو، پۆستەرێک بۆ نەورۆز دروست بکە', false, false).kind).toBe('other');
    expect(classifyWithHeuristics('باشە بینێرە', false, false).kind).toBe('other');
  });
});

describe('F11: edited messages', () => {
  bug('editing the caption of a photo brief is not parked for an operator', async () => {
    fakeTelegram();
    const chat = chatId();
    const edit = message(chat, {});
    const body = edit.message;
    delete (edit as Msg).message;
    (edit as Msg).edited_message = { ...body, edit_date: 1790000100, caption: 'Poster for the KAAE evening, 4 December',
      photo: [{ file_id: 'edited-photo', file_size: 1000, width: 900, height: 900 }] };
    const answer = await intake(app(), edit);
    // Today: 422 park-update; the sender hears "could not process it automatically" and the office is alerted.
    expect(answer.body.lifecycleAction).not.toBe('park-update');
  });
});

describe('F12: a sticker in reply to a lifecycle draft', () => {
  bug('is not told to "tap ✅ Approve design" (lifecycle drafts carry no such button)', async () => {
    const { sent } = fakeTelegram();
    const chat = chatId();
    await seedRequest(chat, 'in_review', 2, { key: '2:design-outcome', messageId: '6601' });
    await intake(app(), message(chat, { sticker: { file_id: 'thumbs', emoji: '👍' }, reply_to_message: { message_id: 6601 } }));
    const texts = sent.filter((m) => String(m.chat_id) === String(chat)).map((m) => m.text).join('\n');
    expect(texts).not.toMatch(/Approve design/);
  });
});
