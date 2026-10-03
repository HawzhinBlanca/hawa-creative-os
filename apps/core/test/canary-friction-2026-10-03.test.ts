import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '@hawa/db';
import { CLIENT_QUESTION_MESSAGES, ROUTING_MESSAGES } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { requestTitle, titleName } from '../src/services/request-title.js';
import { copyTitle } from '../src/services/request-copy-extraction.js';
import { planTurn, readIntentByRules, type ChatRequestView, type TurnPlan } from '../src/services/requester-turn.js';

/**
 * ADR-284 addendum (live canary 2026-10-03, release 8e8425dc). The canary sent, from a chat bound to no
 * organisation: "Hi! Could you make a poster announcing our staff workshop on Thursday 9 October at 10am in the
 * main hall? Thanks so much", answered "Who is this design for?" with "not sure", and later wrote "the poster
 * looks cheap". Three frictions, each pinned through Core's intake route against the test database:
 *  F2: two messages back to back ("No problem. I've passed it to the office…" and "Got it. A designer will make …");
 *  F3: the design was named "Staff workshop on Thursday 9 October at 10am in the main…" everywhere;
 *  F4: "the poster looks cheap", with no draft yet, was asked "Is this a change to …, or a new design?".
 */
const OFFICE = 91000007;
const OUTSIDER = 91000555;
const WORKER = ['worker', 'canary', 'friction', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };
const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { process.env = saved; await db.destroy(); });

const CANARY = 'Hi! Could you make a poster announcing our staff workshop on Thursday 9 October at 10am in the main hall? Thanks so much';
let next = 1_200_000_000 + Math.floor(Math.random() * 700_000_000);
const chatOf = () => 69_000_000 + Math.floor(Math.random() * 9_000_000);
const message = (chat: number, text: string) => {
  const id = ++next;
  return { update_id: id, message: { message_id: id % 100000, from: { id: OUTSIDER, is_bot: false, first_name: 'Sewa' },
    chat: { id: chat, type: 'private' }, date: 1790000000, text } };
};
const app = () => { vi.stubEnv('HAWA_WORKER_TOKEN', WORKER); return createApp({ db, requesterIntentModel: null } as any); };
const intake = async (update: unknown, extra: Record<string, unknown> = {}) => (await (await app().request('/v1/internal/telegram/intake', {
  method: 'POST', headers: worker, body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true, ...extra }) })).json()) as Record<string, any>;
/** RequestLifecycle's first projection of an open, as the worker sends it. */
const project = async (open: Record<string, any>) => {
  const res = await app().request(`/v1/internal/lifecycle/${open.requestId}/project`, { method: 'POST', headers: worker,
    body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${open.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: open.draft }] }) });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
};
/** A brief from a chat bound to no organisation, opened by the answer to "who is this design for?". */
async function openedFor(answer: string | null, brief = CANARY) {
  const chat = chatOf();
  const first = await intake(message(chat, brief));
  const opened = first.clientQuestion && answer !== null ? await intake(message(chat, answer)) : first;
  return { chat, opened };
}

// ---------------------------------------------------------------------------------------------------------
// F2: one message when the office chooses the organisation
// ---------------------------------------------------------------------------------------------------------

describe('F2: "not sure" gets one answer that says both things', () => {
  it('the live words: Core says nothing beside the open; the first answer says it went to the office and a designer will make it', async () => {
    const { opened } = await openedFor('not sure');
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: null, autoGenerate: false } });
    // Before: notice "No problem. I've passed it to the office, and they'll choose the organisation." beside the open,
    // and then RequestLifecycle's "Got it. A designer will make … and send it to you here.": two messages.
    expect(opened).not.toHaveProperty('notice');
    const projected = await project(opened);
    expect(projected).toMatchObject({ stage: 'manual', clientChoice: { outcome: 'office', lang: 'en' } });
    // The office alert stays as it was.
    expect(projected.officeAlerts?.[0]?.text).toMatch(/^A new request needs a designer: /);
    expect(CLIENT_QUESTION_MESSAGES.passedToOfficeDesigner.en).toBe(
      "No problem. I've passed it to the office, and they'll choose the organisation. A designer will make {title} and send it to you here.");
  });

  it('in the answer\'s language: an English brief answered "I don\'t know" in Sorani', async () => {
    const { opened } = await openedFor('نازانم');
    expect(opened).not.toHaveProperty('notice');
    expect(await project(opened)).toMatchObject({ clientChoice: { outcome: 'office', lang: 'ckb' } });
  });

  it('an organisation nobody knows, and an answer after thirty minutes, are one message too', async () => {
    const unknown = await openedFor("It's for the Erbil Chess Club");
    expect(unknown.opened).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: null } });
    expect(unknown.opened).not.toHaveProperty('notice');
    expect(await project(unknown.opened)).toMatchObject({ clientChoice: { outcome: 'unmatched', lang: 'en' } });

    const chat = chatOf();
    await intake(message(chat, CANARY));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    const late = await intake(message(chat, 'not sure'));
    expect(late).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: null } });
    expect(late).not.toHaveProperty('notice');
    expect(await project(late)).toMatchObject({ clientChoice: { outcome: 'expired', lang: 'en' } });
  });

  it('nobody answers: the timeout\'s open says it once, in the first answer, and a replay says nothing more', async () => {
    const chat = chatOf();
    const brief = message(chat, CANARY);
    await intake(brief);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    const opened = await intake(brief, { briefHold: true, settle: true });
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: null } });
    expect(opened).not.toHaveProperty('notice');
    expect(await project(opened)).toMatchObject({ clientChoice: { outcome: 'timeout', lang: 'en' } });
    const again = await intake(brief, { briefHold: true, settle: true });
    expect(again).toMatchObject({ duplicate: true, requestId: opened.requestId });
    expect(again).not.toHaveProperty('notice');
  });

  it('a named organisation, or a chat bound to one, opens as before: no client choice on the first answer', async () => {
    const { opened } = await openedFor('KAAE');
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: 'c1000000-0000-4000-8000-000000000002' } });
    expect(await project(opened)).not.toHaveProperty('clientChoice');
  });
});

// ---------------------------------------------------------------------------------------------------------
// F3: a title names the thing
// ---------------------------------------------------------------------------------------------------------

/**
 * Realistic office briefs (the live canary, the labelled NLU set's briefs, and a few more), opened through intake
 * ("not sure" answers the question where one is asked). Before → after:
 *   Sewa: Staff workshop on Thursday 9 October at 10am in the main…  → Sewa: Staff Workshop
 *   KAAE Nawroz party on 20 March 2027 at Sami Abdulrahman Park     → KAAE Nawroz Party
 *   … (the full table is in the ADR-284 addendum).
 */
const TITLES: Array<[string, string]> = [
  [CANARY, 'Sewa: Staff Workshop'],
  ['Please make a poster for the graduation ceremony on 20 June at 6pm at the Rotana Hotel', 'Sewa: Graduation Ceremony'],
  ['Can you design a flyer for our book fair from 9 to 12 November at the Family Mall?', 'Sewa: Book Fair'],
  ['We need a poster for the parents meeting this Thursday at 4pm in the school hall', 'Sewa: Parents Meeting'],
  ['Could you make a post for the science fair next week for all students?', 'Sewa: Post for the Science Fair'],
  ["Can you make a poster for KAAE's Quality Assurance Workshop for university deans. It's on 15 October 2026 at 9:30 AM in the Rotana Hotel, Erbil. Registration is free.",
    'KAAE: Quality Assurance Workshop for university deans'],
  ["Can you make an Instagram post announcing our Assessment Literacy Workshop for school principals? It's on 15 October 2026 at 10:00 AM in the KAAE hall, Erbil. Registration is free.",
    'KAAE: Assessment Literacy Workshop for school principals'],
  ["Could you design a KAAE poster for our Teacher Appreciation Day? It's on 20 October 2026 at 2:00 PM in the Rotana Hotel ballroom, Erbil. All teachers are welcome.",
    'KAAE: Teacher Appreciation Day'],
  ['Hi, we need a poster for our Quality Assurance Workshop for school principals on 22 October 2026 at 10:00 AM at the Divan Hotel, Erbil. Seats are limited, please register early.',
    'Sewa: Quality Assurance Workshop'],
  ['KAAE members evening\n\nDate: 4 December 2026, 7 pm\nVenue: Erbil International Hotel\nPlease make a poster.', 'KAAE members evening'],
  ['Hello, can you make a poster for the KAAE Nawroz party on 20 March 2027 at Sami Abdulrahman Park?', 'KAAE Nawroz Party'],
  ['plz mak a postr for KAAE confrence on 5 novmber at rotana hotell, 10 am', 'KAAE Confrence'],
  ['Poster for the Erbil Chess Club tournament, 8 November 2026 at 3 pm, Family Mall.', 'Sewa: Erbil Chess Club Tournament'],
  ['Please prepare an invitation card for the KAAE board dinner on 30 October 2026 at 8 pm, Divan Hotel.', 'KAAE Board Dinner'],
  ["We'd like a small flyer for the accreditation info session on 6 November 2026 at 11 am in the KAAE hall.", 'KAAE: Accreditation Info Session'],
  ['Invitation card for the graduation ceremony, 5 October 7pm, Rotana Hotel, needed by Thursday', 'Sewa: Invitation Card for the Graduation Ceremony'],
  ['Good morning! Could you please make an Instagram story for the KAAE open day on 20 October 2026 at the campus, 10 am?', 'KAAE Open Day'],
  ['Poster for the KAAE staff football tournament, 14 November 2026 at 4 pm, Franso Hariri stadium. We need it by next Thursday.', 'KAAE Staff Football Tournament'],
  ['سڵاو، دەتوانن پۆستەرێکمان بۆ دروست بکەن بۆ ئاهەنگی نەورۆزی KAAE لە ٢٠ی ئازار لە پارکی سامی عەبدولڕەحمان؟', 'KAAE: ئاهەنگی نەورۆزی KAAE'],
  ['پۆستەرێک بەم وێنانە دروست بکە بۆ دەرچوونی KAAE، ١٢ی تشرینی یەکەم، هۆتێلی ڕۆتانا', 'KAAE: دەرچوونی KAAE'],
  ['سڵاو، پۆستەرێکمان دەوێت بۆ ئاهەنگی دەرچوونی KAAE\nبەروار: ١٢/١٠/٢٠٢٦ کاتژمێر ٥ی ئێوارە\nشوێن: هۆتێلی ڕۆتانا', 'KAAE: ئاهەنگی دەرچوونی KAAE'],
  ['پۆستەرێکی نوێمان دەوێت بۆ خولی ڕاهێنانی مامۆستایان، ١٠ی تشرینی دووەم کاتژمێر ٩ی بەیانی لە هۆڵی KAAE', 'KAAE: خولی ڕاهێنانی مامۆستایان'],
  ['Hi there, we need something for our staff picnic on Friday', 'Sewa: Staff Picnic'],
  ['hey, could you do something for the science fair next week?', 'Sewa: Science Fair'],
];

describe('F3: a title stops before the date, time and place said after the name', () => {
  it.each(TITLES)('%s → %s', async (brief, title) => {
    const { opened } = await openedFor('not sure', brief);
    expect(opened.lifecycleAction).toBe('open-request');
    expect(opened.draft.title).toBe(title);
    // Never empty, and never a name without its event: the title's words are the requester's, in their order.
    const name = title.replace(/^[^:]{1,40}:\s*/u, '').replace(/…$/u, '');
    expect(name.trim().length).toBeGreaterThan(2);
    const flat = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    expect(flat(brief)).toContain(flat(name));
  });

  it('the copy keeps every word: only the title changed', async () => {
    const { opened } = await openedFor('not sure');
    expect(opened.draft.title).toBe('Sewa: Staff Workshop');
    expect((opened.draft.exactCopy as Array<{ text: string }>).map((b) => b.text))
      .toEqual(['Staff workshop on Thursday 9 October at 10am in the main hall']);
  });

  it('names that only look like a date or a place keep their words', () => {
    for (const name of ['Art in the Park', 'Black Friday Sale', 'Run for Hope', 'Festival of Lights', 'Erbil Book Fair 2026',
      'KAAE K-12 Pilot Study', 'Poster for the graduation ceremony', 'Teacher Appreciation Day', 'Graduation at the Rotana Hotel'])
      expect(titleName(name), name).toBe(name);
    // An audience goes when the name would not fit whole, or with the date said beside it.
    expect(titleName('Assessment Literacy Workshop for school principals', 45)).toBe('Assessment Literacy Workshop');
    expect(titleName('Assessment Literacy Workshop for school principals', 60)).toBe('Assessment Literacy Workshop for school principals');
    expect(requestTitle({ headline: 'staff workshop on Thursday 9 October at 10am in the main hall', label: 'Sewa' })).toBe('Sewa: Staff Workshop');
    expect(copyTitle('Staff workshop on Thursday 9 October at 10am in the main hall', 'Sewa')).toBe('Sewa: Staff Workshop');
  });
});

// ---------------------------------------------------------------------------------------------------------
// F4: an opinion before any draft
// ---------------------------------------------------------------------------------------------------------

describe('F4: an opinion about the design, before any draft exists, goes to the designer', () => {
  it('the live words: "the poster looks cheap" is passed to the designer, with the office\'s note alert; no question, no round', async () => {
    const { chat, opened } = await openedFor('not sure');
    await project(opened);
    const said = await intake(message(chat, 'the poster looks cheap'));
    // Before: "Is this a change to <b>Staff workshop on Thursday 9 October at 10am in the main…</b>, or a new design?"
    expect(said).not.toHaveProperty('choiceRequired');
    expect(said).toMatchObject({ lifecycleAction: 'late-change', code: 'LATE_REQUESTER_CHANGE', requestId: opened.requestId,
      requestStage: 'manual', chatAnswer: { text: ROUTING_MESSAGES.redoPassedDesigner.en.replace('{title}', '<b>Staff Workshop</b>') } });
    expect(said.chatAnswer.text).toBe("A designer at the office is working on <b>Staff Workshop</b>, so I've passed what you said to them; they'll follow up here.");
    expect(said.officeAlerts?.[0]?.text ?? said.officeAlert?.text).toContain('the poster looks cheap');
    // A Sorani opinion is answered in Sorani.
    const ckb = await intake(message(chat, 'دیزاینەکە ناشیرینە'));
    expect(ckb).toMatchObject({ lifecycleAction: 'late-change', chatAnswer: { text: expect.stringContaining('دیزاینەرێک لە ئۆفیسەکە کار لەسەر') } });
  });

  const NOW = Date.parse('2026-10-03T09:00:00Z');
  const view = (requestId: string, stage: ChatRequestView['stage'], rev: number): ChatRequestView => ({ requestId, stage, rev,
    currentTaskId: `${requestId}-task`, clientId: null, title: 'Sewa: Staff Workshop', activeAt: new Date(NOW - 60_000).toISOString(),
    createdAt: new Date(NOW - 120_000).toISOString(), question: null, requesterId: '1' });
  const plan = (words: string, requests: ChatRequestView[]): TurnPlan => planTurn({ text: words, reading: readIntentByRules(words), requests,
    bound: [], unboundReply: false, senderId: '1', officeIds: [], group: false, addressed: true, pendingAsk: null, now: NOW });

  it('only the one request, with a designer and no draft yet; anything else is asked as before', () => {
    for (const words of ['the poster looks cheap', "I don't like it", 'this design is too plain', 'دیزاینەکە ناشیرینە'])
      expect(plan(words, [view('a', 'manual', 1)]), words).toMatchObject({ kind: 'note', note: 'change', requestId: 'a', feedback: true });
    // A draft exists (the office sent it back for the requester's changes), two requests are open, or a draft is
    // being made: the question stays.
    expect(plan('the poster looks cheap', [view('a', 'manual', 3)])).toMatchObject({ kind: 'ask' });
    expect(plan('the poster looks cheap', [view('a', 'manual', 1), view('b', 'manual', 1)])).toMatchObject({ kind: 'ask' });
    expect(plan('the poster looks cheap', [view('a', 'designing', 1)])).toMatchObject({ kind: 'ask' });
    // A brief of its own, or a subject of its own, is not an opinion of this design.
    expect(plan('Book Fair poster, 9 November at 10 am', [view('a', 'manual', 1)])).not.toMatchObject({ feedback: true });
    expect(plan('the Nawroz one looks cheap', [view('a', 'manual', 1)])).not.toMatchObject({ feedback: true });
  });
});

// ---------------------------------------------------------------------------------------------------------
// Greetings and openings are never the design's copy or its name (follow-up, 2026-10-03)
// ---------------------------------------------------------------------------------------------------------

/**
 * ADR-284 addendum (follow-up): a brief whose first line, or first words, are only a greeting ("hello", "hello
 * brother", "dear all", "good morning"; in Sorani, English and Arabic) printed the greeting as the design's headline
 * and named the design after it. English "Hi!" before a request sentence was fixed in d17bae2d; the Sorani greeting
 * and its forms of address, a greeting line above laid-out copy, and the Sorani "we want a poster for …" were not.
 * Openings the title did not know ("Hi there, we need something for …", "Could we get a flyer and …") named the
 * design after the request. The copy stays the requester's words, verbatim; only what is not copy is left out.
 */
const texts = (draft: { exactCopy: unknown[] }) => (draft.exactCopy as Array<{ text: string }>).map((b) => b.text);
const CONF = 'کۆنفرانسی ساڵانەی متمانەبەخشین';
const CONF_WHEN = '٩ی ئەیلوولی ٢٠٢٦، هۆڵی سەعد عەبدوڵا';
const ASK_KAAE = 'تکایە پۆستەرێک دروست بکە بۆ KAAE';

describe('a greeting is never copy, and never the name', () => {
  it.each([
    // "hello brother" / "hello" / "hello sirs" / "good morning", a request line, then the copy lines.
    [`سڵاو کاکە\n${ASK_KAAE}\n${CONF}\n${CONF_WHEN}`],
    [`سڵاو\n${ASK_KAAE}\n${CONF}\n${CONF_WHEN}`],
    [`سڵاو بەڕێزان\n\nتکایە پۆستەرێک بۆ KAAE دروست بکەن\n\n${CONF}\n${CONF_WHEN}`],
    [`بەیانی باش\n${ASK_KAAE}\n${CONF}\n${CONF_WHEN}`],
  ])('Sorani greeting line, request line, copy lines: %s', async (brief) => {
    const { opened } = await openedFor('not sure', brief);
    expect(opened.lifecycleAction).toBe('open-request');
    // The copy as written: a paragraph is one block, as without the greeting.
    expect(texts(opened.draft)).toEqual([`${CONF}\n${CONF_WHEN}`]);
    expect(opened.draft.title).toBe(`KAAE: ${CONF}`);
  });

  it('a Sorani greeting and form of address before the request in one sentence', async () => {
    const { opened } = await openedFor('not sure', 'سڵاو کاکە تکایە پۆستەرێکمان بۆ دروست بکەن بۆ سیمیناری ددان لە ٢٥ی مانگ لە هۆڵی سەعد عەبدوڵڵا');
    expect(texts(opened.draft)).toEqual(['سیمیناری ددان لە ٢٥ی مانگ لە هۆڵی سەعد عەبدوڵڵا']);
    expect(opened.draft.title).toBe('Sewa: سیمیناری ددان');
  });

  it('a Sorani "hello, we want a poster for …" brief: neither the greeting nor the request words are printed', async () => {
    const brief = 'سڵاو، پۆستەرێکمان دەوێت بۆ ئاهەنگی دەرچوونی KAAE\nبەروار: ١٢/١٠/٢٠٢٦ کاتژمێر ٥ی ئێوارە\nشوێن: هۆتێلی ڕۆتانا';
    const { opened } = await openedFor('not sure', brief);
    expect(texts(opened.draft)).toEqual(['ئاهەنگی دەرچوونی KAAE', 'بەروار: ١٢/١٠/٢٠٢٦ کاتژمێر ٥ی ئێوارە', 'شوێن: هۆتێلی ڕۆتانا']);
    expect(opened.draft.title).toBe('KAAE: ئاهەنگی دەرچوونی KAAE');
  });

  it.each([
    [`سڵاو\n\n${CONF}\n\n${CONF_WHEN}`, [CONF, CONF_WHEN], `Sewa: ${CONF}`],
    ['Hello\n\nAnnual Accreditation Conference\n\n9 September 2026, Saad Abdullah Hall',
      ['Annual Accreditation Conference', '9 September 2026, Saad Abdullah Hall'], 'KAAE: Annual Accreditation Conference'],
    ['السلام عليكم\n\nمؤتمر الاعتماد السنوي\n\n٩ أيلول ٢٠٢٦، قاعة سعد عبدالله', ['مؤتمر الاعتماد السنوي', '٩ أيلول ٢٠٢٦، قاعة سعد عبدالله'],
      'Sewa: مؤتمر الاعتماد السنوي'],
  ] as const)('a greeting line above laid-out copy (Sorani, English, Arabic): %s', async (brief, copy, title) => {
    const { opened } = await openedFor('not sure', brief);
    expect(texts(opened.draft)).toEqual(copy);
    expect(opened.draft.title).toBe(title);
  });

  it('English: a greeting line, a request naming the client, then the copy', async () => {
    const { opened } = await openedFor('not sure', 'Hi team,\nPlease make a poster for KAAE\nAnnual Accreditation Conference\n9 September 2026, Saad Abdullah Hall');
    expect(texts(opened.draft)).toEqual(['Annual Accreditation Conference\n9 September 2026, Saad Abdullah Hall']);
    expect(opened.draft.title).toBe('KAAE: Annual Accreditation Conference');
  });

  it('a greeting line above a request that carries the event\'s name: the name stays the headline', async () => {
    const { opened } = await openedFor('not sure',
      'Good morning everyone\nCould you design a poster for our Annual Accreditation Conference?\n9 September 2026, Saad Abdullah Hall');
    expect(texts(opened.draft)).toEqual(['Annual Accreditation Conference', '9 September 2026, Saad Abdullah Hall']);
    expect(opened.draft.title).toBe('KAAE: Annual Accreditation Conference');
  });

  it('a greeting that is part of the copy stays ("Hello Summer!")', async () => {
    const { opened } = await openedFor('not sure', 'Hello Summer!\n\nKAAE summer school\n\n1 July 2026, KAAE hall');
    expect(texts(opened.draft)[0]).toBe('Hello Summer!');
  });
});

describe('openings the title did not know', () => {
  it.each([
    ['Hi there, we need something for our staff picnic on Friday', 'Sewa: Staff Picnic'],
    ['hey, could you do something for the science fair next week?', 'Sewa: Science Fair'],
    ['Hello, we\'re hoping for something for the graduation party in June', 'Sewa: Graduation Party'],
    ['Hi! Could we get a flyer and an Instagram post for the Quality Week launch on 2 November 2026, 10 am, KAAE hall?', 'KAAE: Quality Week Launch'],
  ])('%s → %s', async (brief, title) => {
    const { opened } = await openedFor('not sure', brief);
    expect(opened.draft.title).toBe(title);
    // The request is never printed.
    expect(texts(opened.draft).join(' ')).not.toMatch(/\b(?:Hi|Hello|hey|Could we get|we're hoping|we need|could you)\b/i);
  });
});
