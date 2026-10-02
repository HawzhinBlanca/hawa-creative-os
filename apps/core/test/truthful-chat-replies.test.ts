/**
 * ADR-231: what the bot says matches what happens (live Telegram test, production b83c9f1d, 2026-10-01).
 *
 * The findings (LIVE_TEST_2026-10-01.md) this file pins, each with the live words:
 *  - L2: "do a better design that's similar to the earlier ones, use more of the photos…" was bound to a
 *    request opened by mistake for a designer (no draft) instead of the K-12 design delivered that morning.
 *  - L4: the requester heard "I'll redo …" while the office heard the words were "not applied to any
 *    design"; "I'll redo" is said only when a round starts.
 *  - L5: status said "being sent to you now" for a delivery confirmed hours before, and named two designs
 *    "KAAE K-12 Pilot Study…" with nothing between them.
 *  - L6: titles with a right-to-left mark, the client named twice, the instruction phrase as the name.
 *  - L7: office alerts read "The requester in chat 7191500129 …" and "Task …, request …".
 *  - L11: "can you also make videos?" was kept as a change, told "I've passed your change", and held Deliver.
 * L10 (the office's "which draft?") is in office-telegram-approval.test.ts. Sorani lines carry their
 * meaning in a comment. Database tests run against the per-file test database as hawa_app.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { requesterTitleName, trimTitleMarks } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { lateChangeOfficeAlert, type LateRequesterChange } from '../src/services/lifecycle-chat-target.js';
import { requestTitle, spokenTitle } from '../src/services/request-title.js';
import { askText, asksWhatTheOfficeMakes, distinctNames, forwardOfficeAlert, noteText, planTurn, questionOfficeAlert,
  readIntentByRules, redoText, requesterName, shortTitle, statusText, tellOfficeAlert, whoWrote,
  type ChatRequestView, type TurnInput } from '../src/services/requester-turn.js';
import { composeDeliveredCaption, composeDeliveredMessage } from '../../worker/src/delivery-notification.js';

const LIVE_REDO = "do a better design that's similar to the earlier ones, use more of the photos";
const ACCIDENT_TITLE = 'do a better design thats similar to earlier o…';
const K12 = 'KAAE: ‏KAAE K-12 Pilot Study…';
const RLM = '‏';
const NOW = Date.parse('2026-10-01T13:10:00Z');
const H = 60 * 60_000;
const ME = '7191500129';

function view(over: Partial<ChatRequestView> = {}): ChatRequestView {
  return { requestId: randomUUID(), stage: 'delivered', rev: 6, currentTaskId: randomUUID(), clientId: 'c1', title: K12,
    activeAt: new Date(NOW - 4.5 * H).toISOString(), createdAt: new Date(NOW - 6 * H).toISOString(), question: null,
    requesterId: ME, ...over };
}
/** The live chat at 13:10Z: the K-12 design sent at 08:44, and the request opened by mistake at 12:33. */
const liveChat = (k12Stage: 'delivering' | 'delivered') => ({
  k12: view({ stage: k12Stage, activeAt: '2026-10-01T08:44:12Z', createdAt: '2026-10-01T06:10:00Z', ...(k12Stage === 'delivering' ? { sentToChat: true } : {}) }),
  accident: view({ stage: 'manual', rev: 1, title: ACCIDENT_TITLE, activeAt: '2026-10-01T12:33:00Z', createdAt: '2026-10-01T12:33:00Z' }),
});
const turn = (text: string, requests: ChatRequestView[], over: Partial<TurnInput> = {}): TurnInput => ({ text,
  reading: readIntentByRules(text), requests, bound: [], unboundReply: false, senderId: ME, officeIds: [], group: false,
  addressed: true, pendingAsk: null, now: NOW, ...over });

describe('L2: redo words are about a design the requester has seen', () => {
  it('the live words go to the K-12 design, never to the request opened for a designer an hour later', () => {
    // After the chat-only delivery fix the K-12 request is delivered: a new round of it.
    const after = liveChat('delivered');
    expect(planTurn(turn(LIVE_REDO, [after.k12, after.accident]))).toEqual({ kind: 'redo', requestId: after.k12.requestId, directive: LIVE_REDO });
    // As production stood (stuck in `delivering`): kept on the K-12 design for the office, never on the accident.
    const live = liveChat('delivering');
    expect(planTurn(turn(LIVE_REDO, [live.k12, live.accident]))).toMatchObject({ kind: 'note', requestId: live.k12.requestId, redo: true });
  });

  it('a design still being made for the first time is not the "earlier one" either', () => {
    const k12 = view();
    const fresh = view({ stage: 'designing', rev: 1, title: 'KAAE: Teachers day card…', activeAt: new Date(NOW - 60_000).toISOString() });
    expect(planTurn(turn('similar to the earlier ones please', [k12, fresh]))).toMatchObject({ kind: 'redo', requestId: k12.requestId });
    expect(planTurn(turn('make it better', [k12, fresh]))).toMatchObject({ kind: 'redo', requestId: k12.requestId });
  });

  it('with no design that has a draft, the words stay with the open one; a reply still names its design', () => {
    const { accident } = liveChat('delivered');
    expect(planTurn(turn('try again', [accident]))).toMatchObject({ kind: 'note', requestId: accident.requestId });
    const { k12, accident: other } = liveChat('delivered');
    expect(planTurn(turn('redo it', [k12, other], { bound: [other.requestId] }))).toMatchObject({ requestId: other.requestId });
  });
});

describe('L4: the requester hears what really happens', () => {
  it('"I\'ll redo" only when a round starts; kept words say they went to the office, and why', () => {
    expect(redoText('delivered', K12, 'en', true)).toMatch(/^I'll redo <b>KAAE K-12 Pilot Study<\/b>/);
    const kept: Array<[string, RegExp]> = [
      ['designing', /still being made, so I can't start it again yet\. I've kept what you said with it for the office/],
      ['awaiting_answer', /still being made/],
      ['in_review', /is with the office for a final check, so I haven't started a new version/],
      ['approved', /is already approved, so I haven't started a new version\. I've passed what you said to the office/],
      ['delivering', /is already approved, so I haven't started a new version/],
      ['delivered', /^I can't start a new version of <b>KAAE K-12 Pilot Study<\/b> by myself, so I've passed what you said to the office/],
      ['manual', /^A designer at the office is working on <b>KAAE K-12 Pilot Study<\/b>, so I've passed what you said to them/],
    ];
    for (const [stage, words] of kept) {
      expect(redoText(stage, K12, 'en')).toMatch(words);
      expect(redoText(stage, K12, 'en')).not.toMatch(/I'll redo|new version follows/);
      expect(noteText('change', stage, K12, 'en', false, true)).toBe(redoText(stage, K12, 'en'));
      // Sorani: never "I'll redo it" (دووبارە دەکەمەوە) when nothing started.
      expect(redoText(stage, K12, 'ckb')).not.toMatch(/دووبارە دەکەمەوە/);
    }
  });

  // ADR-230 section 6 (merged after ADR-231): a change kept while a draft is being made starts a new round
  // when that draft finishes, so the requester hears it will be added then, and the office is told the same.
  // ADR-239 follow-up (changed deliberately): it promised the change "as soon as the current draft is done"
  // before the day's allowance or the round limit was known; now it says the office gets it if it can't be added.
  it('a change kept while the draft is being made is added when that draft is done, as the office is told', () => {
    expect(noteText('change', 'designing', K12, 'en')).toBe(
      "Got it. I'll add that to <b>KAAE K-12 Pilot Study</b> once the current draft is done, or pass it to the office if I can't.");
    const alert = lateChangeOfficeAlert({ requestId: randomUUID(), taskId: randomUUID(), requestRev: 1, requestStage: 'designing',
      text: 'also please add that seats are limited', title: 'KAAE K-12 Pilot Study…' }, ME, '93000001', 'Hawzhin Blanca')!.text;
    expect(alert).toMatch(/It will be added automatically in a new round when the current draft finishes; if a round can't start, the draft alert will list it\./);
    expect(alert).not.toMatch(/It is not in the draft being made|applied to any design/);
  });

  it('a change kept while a designer has it, or while it waits for an answer, is still "kept for the office"', () => {
    for (const stage of ['manual', 'awaiting_answer'] as const) {
      expect(noteText('change', stage, K12, 'en')).toBe(
        "Got it. I've kept that with <b>KAAE K-12 Pilot Study</b> for the office; they'll see it before the design is sent to you.");
      const alert = lateChangeOfficeAlert({ requestId: randomUUID(), taskId: randomUUID(), requestRev: 1, requestStage: stage,
        text: 'also please add that seats are limited', title: 'KAAE K-12 Pilot Study…' }, ME, '93000001', 'Hawzhin Blanca')!.text;
      expect(alert).toMatch(/It is not in the draft being made; add it in the next round or at review/);
    }
  });
});

describe('L5: every status line is true for its stage', () => {
  it('a delivery confirmed in the chat is "delivered", never "being sent to you now"', () => {
    const { k12 } = liveChat('delivering');
    expect(statusText([k12], 'en', new Set(), NOW)).toBe('<b>KAAE K-12 Pilot Study</b> has been delivered.');
    expect(statusText([{ ...k12, sentToChat: false }], 'en', new Set(), NOW)).toBe('<b>KAAE K-12 Pilot Study</b> is being sent to you now.');
  });

  it('two designs with one name are told apart by when each was asked for, or by their order', () => {
    const morning = view({ stage: 'in_review', rev: 2, createdAt: '2026-10-01T05:44:00Z' });
    const yesterday = view({ stage: 'delivered', createdAt: '2026-09-30T12:18:00Z' });
    const text = statusText([yesterday, morning], 'en', new Set(), NOW);
    expect(text).toBe('<b>KAAE K-12 Pilot Study</b> (asked for yesterday at 15:18) has been delivered.\n\n' +
      '<b>KAAE K-12 Pilot Study</b> (asked for today at 08:44) is with the office for a final check. It will be sent here once they approve it.');
    // Sorani: "asked for yesterday at 15:18"
    expect(statusText([yesterday, morning], 'ckb', new Set(), NOW)).toContain('(دوێنێ کاتژمێر 15:18 داواکرا)');
    const sameMinute = [view({ createdAt: '2026-10-01T05:44:10Z' }), view({ createdAt: '2026-10-01T05:44:40Z' })];
    expect([...distinctNames(sameMinute.map((r) => ({ ...r, askedAt: r.createdAt })), 'en', NOW).values()])
      .toEqual(['<b>KAAE K-12 Pilot Study</b> (version 1)', '<b>KAAE K-12 Pilot Study</b> (version 2)']);
  });

  it('the "which design?" choice tells them apart too', () => {
    const a = view({ stage: 'in_review', createdAt: '2026-09-29T21:58:00Z' });
    const b = view({ stage: 'in_review', createdAt: '2026-10-01T05:44:00Z' });
    const asked = planTurn(turn('the date should be 14 October', [a, b]));
    expect(asked).toMatchObject({ kind: 'ask' });
    expect(askText(asked as Extract<ReturnType<typeof planTurn>, { kind: 'ask' }>, 'en', NOW)).toBe('Which design is this for?\n' +
      '1. <b>KAAE K-12 Pilot Study</b> (asked for yesterday at 00:58)\n2. <b>KAAE K-12 Pilot Study</b> (asked for today at 08:44)');
  });

  // ADR-230 addendum (L16, changed deliberately): a request named by its sentence is no longer "your design"
  // but the one sent then, with the start of its words.
  it('a closed request is not listed as being worked on; one named by its sentence is named by when and its words', () => {
    const closed = { ...view(), stage: 'rejected' } as unknown as ChatRequestView;
    expect(statusText([closed], 'en', new Set(), NOW)).toBe("I don't have a design in progress in this chat right now. Tell me what you'd like designed.");
    const { accident } = liveChat('delivered');
    expect(statusText([accident], 'en', new Set(), NOW)).toMatch(/^A designer at the office is working on the one you sent [^(]+ \(“do a better design thats similar…”\)\. It will be sent here when it is ready\.$/);
  });
});

describe('L6: a design\'s name, made and shown', () => {
  const LIVE_BRIEF = "Can you make an Instagram post announcing our Assessment Literacy Workshop for school principals? It's on 15 October 2026 at 10:00 AM in the KAAE hall, Erbil. Registration is free.";

  it('the 13:58Z words are named by their subject, not the instruction', () => {
    expect(spokenTitle(LIVE_BRIEF)).toBe('Assessment Literacy Workshop');
    expect(requestTitle({ headline: LIVE_BRIEF, label: 'KAAE', rawText: LIVE_BRIEF })).toBe('KAAE: Assessment Literacy Workshop');
    expect(spokenTitle('Please design a flyer promoting our Spring Book Fair at the library')).toBe('Spring Book Fair');
    expect(spokenTitle('a poster about the new parking rules for staff')).toBe('New parking rules for staff');
    // As before: a subject after "for the" keeps its words; a line with no request keeps them all.
    expect(spokenTitle('Hi, we need a poster for the graduation ceremony')).toBe('Poster for the graduation ceremony');
    expect(spokenTitle('Another poster please: KAAE staff football tournament')).toBe('KAAE staff football tournament');
    expect(spokenTitle('Poster on 5 October at the hall')).toBe('Poster on 5 October at the hall');
  });

  it('no direction mark at either edge, and the client named once', () => {
    expect(requestTitle({ headline: `${RLM}KAAE K-12 Pilot Study`, label: 'KAAE' })).toBe('KAAE K-12 Pilot Study');
    expect(requestTitle({ headline: `Nawroz poster${RLM}`, label: `${RLM}KAAE` })).toBe('KAAE: Nawroz poster');
    expect(trimTitleMarks(`KAAE: ${RLM}KAAE K-12 Pilot Study…${RLM}`)).toBe('KAAE: KAAE K-12 Pilot Study…');
    expect(requesterTitleName(`KAAE: ${RLM}KAAE K-12 Pilot Study…`)).toBe('KAAE K-12 Pilot Study');
    expect(requesterTitleName('KAAE: New design request from Sewa')).toBe('');
  });

  it('the delivered files\' caption and notice name the design without the mark (live caption "‏KAAE K-12 Pilot Study…, final")', () => {
    expect(composeDeliveredCaption(K12, 'k12.png', 'en')).toBe('KAAE K-12 Pilot Study, final');
    expect(composeDeliveredMessage({ title: K12 }, { filesSent: 2, lang: 'en' })).not.toContain(RLM);
  });

  it('a title stored from words with no copy is shown as "your design"', () => {
    expect(shortTitle(ACCIDENT_TITLE)).toBe('your design');
    expect(shortTitle(K12)).toBe('KAAE K-12 Pilot Study');
  });
});

describe('L7: office alerts name the requester and the design, in plain sentences', () => {
  const late = (over: Partial<LateRequesterChange> = {}): LateRequesterChange => ({ requestId: '3a4c6ac4-0000-4000-8000-000000000001',
    taskId: '030996c1-0000-4000-8000-000000000001', requestRev: 6, requestStage: 'delivering', text: LIVE_REDO, kind: 'change',
    title: 'KAAE K-12 Pilot Study…', ...over });

  it('the requester\'s name from Telegram, never the chat id; ids only on the last line', () => {
    expect(requesterName({ id: 7191500129, first_name: 'Hawzhin', last_name: 'Blanca' })).toBe('Hawzhin Blanca');
    expect(requesterName({ id: 1, username: 'sewa_k' })).toBe('@sewa_k');
    expect(requesterName({ id: 1 })).toBeNull();
    expect(whoWrote(null)).toBe('A requester');
    const alert = lateChangeOfficeAlert(late(), ME, '93000001', 'Hawzhin Blanca')!.text;
    expect(alert).toBe([
      'Hawzhin Blanca wrote about the design "KAAE K-12 Pilot Study…" after it was being delivered. Nothing was changed; please read their words and answer them in the chat.',
      'It was already approved and being sent to them; the sending was not stopped.',
      '', 'Their words:', LIVE_REDO, '', 'Desk search: 030996c1'].join('\n'));
    for (const text of [alert, lateChangeOfficeAlert(late({ requestStage: 'manual' }), ME, '93000001', 'Hawzhin Blanca')!.text,
      lateChangeOfficeAlert(late({ kind: 'hold', held: true, requestStage: 'designing' }), ME, '93000001', null)!.text,
      tellOfficeAlert('approval', { who: 'Hawzhin Blanca', taskId: late().taskId, title: K12, words: 'looks good' }),
      forwardOfficeAlert('Hawzhin Blanca', 'thanks for the old one'), questionOfficeAlert('Hawzhin Blanca', 'can you also make videos?')]) {
      expect(text).not.toMatch(/in chat \d|request [0-9a-f]{8}-|Task [0-9a-f]{8}-|acknowledge these words/);
      expect(text.split('\n')[0]).toMatch(/^(?:Hawzhin Blanca|A requester) /);
    }
  });

  it('the requester\'s words are quoted exactly as sent', () => {
    const words = 'Sorry!\n  the date is *5 October* <not 4>';
    expect(lateChangeOfficeAlert(late({ text: words }), ME, '93000001', 'Sewa')!.text).toContain(`Their words:\n${words}\n`);
  });
});

describe('L11: a question about what the office makes is a question', () => {
  it.each(['can you also make videos?', 'can you make videos?', 'do you design logos?', 'Could you print banners too?',
    'hi, can you also make videos for us?',
    // Sorani: "do you also make videos?"
    'ڤیدیۆش دروست دەکەن؟'])('"%s" asks the office, holds nothing', (words) => {
    expect(asksWhatTheOfficeMakes(words)).toBe(true);
    expect(readIntentByRules(words)).toMatchObject({ intent: 'conversation', question: true });
    const inReview = view({ stage: 'in_review', rev: 2 });
    expect(planTurn(turn(words, [inReview]))).toEqual({ kind: 'forward', words, question: true });
  });

  it.each(['can you make the title bigger?', 'can you make it in A4?', 'can you also add the logo?', 'can you make our logo bigger?',
    'can you do it again?',
    // Sorani: "can you make the title bigger?"
    'دەتوانن ناونیشانەکە گەورەتر بکەن؟'])('"%s" is still about their design', (words) => {
    expect(asksWhatTheOfficeMakes(words)).toBe(false);
    expect(readIntentByRules(words).intent).toBe('change');
  });

  it('a request for a design is still a new brief', () => {
    expect(readIntentByRules('can you make a poster for Nawroz?')).toMatchObject({ intent: 'new_brief' });
  });
});

// ---------------------------------------------------------------------------------------------
// The live sequences, through Core's intake (the route ChatInbox calls), against the database.
// ---------------------------------------------------------------------------------------------

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const OFFICE = 91_000_231;
const WORKER = ['worker', 'truthful', 'fixture', 'token'].join('_');
const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  process.env = saved;
  await db.destroy();
});

const chatId = () => 63_000_000 + Math.floor(Math.random() * 9_000_000);
let nextUpdate = 1_300_000_000 + Math.floor(Math.random() * 500_000_000);
const says = (chat: number, text: string, extra: Record<string, unknown> = {}) => {
  const id = nextUpdate++;
  return { update_id: id, message: { message_id: id % 100_000, from: { id: chat, is_bot: false, first_name: 'Hawzhin', last_name: 'Blanca' },
    chat: { id: chat, type: 'private' }, date: 1_790_000_000, text, ...extra } };
};
const intake = async (app: ReturnType<typeof createApp>, update: unknown) => {
  const res = await app.request('/v1/internal/telegram/intake', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` },
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle' }) });
  return (await res.json()) as Record<string, any>;
};

/** A request-owned request of this chat, as RequestLifecycle leaves it, opened and last moved minutes ago. */
async function seed(chat: number, o: { stage: string; rev: number; title: string; createdAgo: number; activeAgo: number }) {
  const requestId = randomUUID();
  const created = await persistChatIntake(db, {
    platform: 'telegram', sourceEventId: `lc-seed-${requestId}`, sourceChannelId: String(chat),
    rawText: o.title, title: o.title, clientId, designInstructions: 'Make the design', exactCopy: [{ text: 'KAAE K-12 Pilot Study' }],
    autoGenerate: true, designStudio: true, variant: { width: 1080, height: 1350 }, studioOptions: { tier: 'quality' },
  }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id,
        created_at, updated_at)
      VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, null, 'restate', ${o.stage}, ${o.rev}, ${String(chat)},
        now() - ${o.createdAgo} * interval '1 minute', now() - ${o.activeAgo} * interval '1 minute')`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  return { requestId, taskId };
}

/** Delivery's confirmed final notice for a task (TelegramSender's mark), as Telegram message `messageId`. */
async function noticeSent(chat: number, taskId: string, messageId: string) {
  const key = `lc:dl-${taskId}-${randomUUID()}:notice:send`;
  await withRlsContext(db, scope, (trx) => sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind,
      payload, payload_hash, verified)
    VALUES (${tenantId}::uuid, 'telegram_delivery', ${key}, 'telegram_message_sent',
      ${JSON.stringify({ step: 'send', outcome: 'sent', messageId, chatId: String(chat) })}::jsonb, ${`${key}:sent`}, true)`.execute(trx));
}

const lateChanges = async (requestId: string) => (await withRlsContext(db, scope, (trx) => sql<{ n: string }>`SELECT count(*)::text AS n
  FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_routing'
    AND event_kind = 'lifecycle_late_requester_change' AND payload->>'requestId' = ${requestId}`.execute(trx))).rows[0].n;

/** The live chat: K-12 sent at 08:44 (still `delivering`, its notice confirmed), the accident opened at 12:33. */
async function liveState(chat: number) {
  const k12 = await seed(chat, { stage: 'delivering', rev: 6, title: K12, createdAgo: 7 * 60, activeAgo: 4.5 * 60 });
  await noticeSent(chat, k12.taskId, '678');
  const accident = await seed(chat, { stage: 'manual', rev: 1, title: ACCIDENT_TITLE, createdAgo: 37, activeAgo: 37 });
  return { k12, accident };
}

describe('the live sequences through intake', () => {
  it('L2/L4/L7: the 13:05Z redo words go to K-12, the reply says what happened, and the office alert agrees', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const app = createApp({ db, requesterIntentModel: null } as any);
    const chat = chatId();
    const { k12, accident } = await liveState(chat);
    const answer = await intake(app, says(chat, LIVE_REDO));
    expect(answer).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestId: k12.requestId });
    expect(answer.chatAnswer.text).toBe("I can't start a new version of <b>KAAE K-12 Pilot Study</b> by myself, so I've passed what you said to the office; they'll follow up here.");
    expect(answer.officeAlert).toEqual({ chatId: String(OFFICE), text: [
      'Hawzhin Blanca wrote about the design "KAAE K-12 Pilot Study" after it was being delivered. Nothing was changed; please read their words and answer them in the chat.',
      'It was already approved and being sent to them; the sending was not stopped.',
      '', 'Their words:', LIVE_REDO, '', `Desk search: ${k12.taskId.slice(0, 8)}`].join('\n') });
    expect(await lateChanges(k12.requestId)).toBe('1');
    expect(await lateChanges(accident.requestId)).toBe('0');
  });

  it('L3(a)/L4: a redo replying to the final message (678) is never answered "I\'ll redo"', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const app = createApp({ db, requesterIntentModel: null } as any);
    const chat = chatId();
    const { k12 } = await liveState(chat);
    const answer = await intake(app, says(chat, 'not good, do it again', { reply_to_message: { message_id: 678, from: { id: 7_000_001, is_bot: true } } }));
    expect(answer).toMatchObject({ code: 'LATE_REQUESTER_CHANGE', requestId: k12.requestId });
    expect(answer.chatAnswer.text).not.toMatch(/I'll redo/);
    expect(answer.chatAnswer.text).toMatch(/passed what you said to the office/);
  });

  it('L4: a delivered design that cannot be reopened (made with no automatic design) is passed on, never "I\'ll redo"', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const app = createApp({ db, requesterIntentModel: null } as any);
    const chat = chatId();
    const k12 = await seed(chat, { stage: 'delivered', rev: 6, title: K12, createdAgo: 7 * 60, activeAgo: 4.5 * 60 });
    await seed(chat, { stage: 'manual', rev: 1, title: ACCIDENT_TITLE, createdAgo: 37, activeAgo: 37 });
    const answer = await intake(app, says(chat, LIVE_REDO));
    expect(answer.chatAnswer.text).toBe("I can't start a new version of <b>KAAE K-12 Pilot Study</b> by myself, so I've passed what you said to the office; they'll follow up here.");
    expect(answer.officeAlert.text).toMatch(/^Hawzhin Blanca wrote about the design "KAAE K-12 Pilot Study" after it was delivered\. Nothing was changed/);
    expect(await lateChanges(k12.requestId)).toBe('1');
    // Before ADR-231 this answered IDEMPOTENCY_CONFLICT (the redo plan's receipt had no answer), and the
    // requester heard nothing. A replay of the same update answers the same words.
    const update = says(chat, 'try again');
    const first = await intake(app, update);
    expect(first.chatAnswer.text).toMatch(/^I can't start a new version of <b>KAAE K-12 Pilot Study<\/b> by myself/);
    expect((await intake(app, update)).chatAnswer).toEqual(first.chatAnswer);
  });

  it('L5: "what\'s the status of my designs?" is true line by line, and tells the two K-12 designs apart', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const app = createApp({ db, requesterIntentModel: null } as any);
    const chat = chatId();
    await liveState(chat);
    await seed(chat, { stage: 'in_review', rev: 2, title: K12, createdAgo: 20 * 60, activeAgo: 30 });
    await seed(chat, { stage: 'rejected', rev: 3, title: 'KAAE: Old flyer…', createdAgo: 60, activeAgo: 5 });
    const answer = await intake(app, says(chat, "what's the status of my designs?"));
    const text = String(answer.chatAnswer.text);
    expect(text).not.toMatch(/being sent to you now|Old flyer/);
    // ADR-230 addendum (L16, changed deliberately): named by when it was sent and the start of its words, quoted.
    expect(text).toMatch(/A designer at the office is working on the one you sent [^(]+ \(“do a better design thats similar…”\)\./);
    const k12Lines = text.split('\n\n').filter((l) => l.includes('KAAE K-12 Pilot Study'));
    expect(k12Lines).toHaveLength(2);
    expect(k12Lines.some((l) => /\(asked for [^)]+\) has been delivered\.$/.test(l))).toBe(true);
    expect(k12Lines.some((l) => /\(asked for [^)]+\) is with the office for a final check/.test(l))).toBe(true);
    expect(new Set(k12Lines.map((l) => l.replace(/ (?:has been|is with).*/, ''))).size).toBe(2);
    expect(text).not.toContain(RLM);
  });

  it('L11: "can you also make videos?" while a design is with the office: a question, passed on, holding nothing', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const app = createApp({ db, requesterIntentModel: null } as any);
    const chat = chatId();
    const post = await seed(chat, { stage: 'in_review', rev: 2, title: 'KAAE: Assessment Literacy Workshop…', createdAgo: 6, activeAgo: 3 });
    const answer = await intake(app, says(chat, 'can you also make videos?'));
    expect(answer.chatAnswer.text).toBe("I can't answer that myself, so I've passed your question to the office; they'll reply here.");
    expect(answer.officeAlert.text).toBe(['Hawzhin Blanca asked a question the bot cannot answer. Nothing was changed and no design is held back; please answer them in the chat.',
      '', 'Their question:', 'can you also make videos?'].join('\n'));
    expect(answer.code).toBeUndefined();
    expect(await lateChanges(post.requestId)).toBe('0');
  });
});
