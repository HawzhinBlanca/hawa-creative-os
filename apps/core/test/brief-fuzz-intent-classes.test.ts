import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '@hawa/db';
import { createApp } from '../src/app.js';
import { readIntentByRules } from '../src/services/requester-turn.js';
import { requestTitle, titleName } from '../src/services/request-title.js';

/**
 * Brief phrasing fuzz (2026-10-03, output/research/2026-10-03-brief-fuzz/REPORT.md): the intent, routing and title
 * classes, through the real route `/v1/internal/telegram/intake` (per-file test database, no model call).
 *
 *  Class 5: a real brief read as instruction-only (no copy, no automatic draft, and with no client named no "who is
 *           this for?"): a greeting before the request, a question mark, a numeric, relative or abbreviated date, a
 *           last line of a city and a year. A request with no client and no copy is still asked who it is for.
 *  Class 8: KAAE's full English name routes to KAAE, with or without "the", as a whole name only.
 *  Class 4: the title of "<Event> is on <date>. Make a poster for it." is the event, never "Our Open Day Is".
 *  Residue: a title never starts with a list mark or is "With these details".
 *  Controls: a status question, a change, "thanks" alone and a greeting alone stay what they are.
 */
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const WORKER = ['worker', 'intent', 'classes', 'token'].join('_');
const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
const MEMBER0 = 93_400_000;
let member = MEMBER0;
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = Array.from({ length: 200 }, (_, i) => String(MEMBER0 + i)).join(',');
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { process.env = saved; await db.destroy(); });

let next = 1_600_000_000 + Math.floor(Math.random() * 400_000_000);
const message = (chat: number, text: string) => {
  const id = ++next;
  return { update_id: id, message: { message_id: id % 100000, from: { id: chat, is_bot: false, first_name: 'Sewa' },
    chat: { id: chat, type: 'private' }, date: 1790000000, text } };
};
const intake = async (update: unknown) => {
  vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
  const app = createApp({ db, requesterIntentModel: null } as any);
  const res = await app.request('/v1/internal/telegram/intake', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` },
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) });
  return (await res.json()) as Record<string, any>;
};
/** One brief from its own office member in a private chat; "who is this for?" is answered "KAAE" when asked. */
async function send(text: string) {
  const chat = member++;
  const first = await intake(message(chat, text));
  const asked = first.clientQuestion === true;
  const opened = asked ? await intake(message(chat, 'KAAE')) : first;
  const draft = opened.lifecycleAction === 'open-request' ? opened.draft : null;
  const copy = ((draft?.exactCopy ?? []) as Array<{ text: string }>).map((c) => c.text);
  return { first, asked, draft, copy, title: (draft?.title ?? null) as string | null, clientId: (draft?.clientId ?? null) as string | null };
}
/** A brief opened with its own copy, to be drafted by itself: not instruction-only, the event on a line. */
function drafted(r: Awaited<ReturnType<typeof send>>, event: string) {
  expect(r.draft, 'opened').toBeTruthy();
  expect(r.draft.isInstructionOnly ?? false, 'instruction-only').toBe(false);
  expect(r.copy.some((line) => line.toLowerCase().includes(event.toLowerCase())), `"${event}" on a copy line: ${JSON.stringify(r.copy)}`).toBe(true);
}

describe('class 5: real briefs are briefs, whatever comes before or after the request', () => {
  it.each([
    ['a greeting before "pls make" (en-111)', 'Hi pls make an Instagram story for the Science Camp 20 March 2027 Thanks a lot', 'Science Camp', true],
    ['"Hello We\'d like" (en-029)', "Hello We'd like a social media post for KAAE nawroz celebration. It's on 15 October 2026 at 9:30.", 'nawroz celebration', false],
    ['a numeric date after a greeting (en-251)', 'Hi there! can u do a KAAE Instagram post for our nawroz celebration 15/10/2026 Thanks!', 'nawroz celebration', false],
    ['a relative date (en-265)', 'Hello everyone! pls make a certificate for KAAE to announce the Book Fair next Thursday Thanks a lot', 'Book Fair', false],
    ['"Oct. 20" (en-279)', "pls make an Instagram post for KAAE's career fair Oct. 20 thank you", 'career fair', false],
    ['an abbreviated month on a laid-out line (en-135)', 'Hi there!\nCan you create a KAAE poster for this:\nSpring Concert\nOct. 20', 'Spring Concert', false],
    ['the event first and a question (en-327)', 'Salam,\nOur Teacher Appreciation Day is on 15/10/2026. For KAAE, can u make a story for it?', 'Teacher Appreciation Day', false],
    ['a relative date, no client (en-222)', 'The Book Fair is on next Thursday at Sami Abdulrahman Park. Could you design a certificate for it?', 'Book Fair', true],
  ])('%s', async (_name, text, event, asks) => {
    const r = await send(text);
    expect(r.asked, 'asked who it is for').toBe(asks);
    expect(r.clientId).toBe(KAAE);
    drafted(r, event);
  });

  it('a last line of only a city and a year (Sorani, from the fuzz: ckb-07) is a brief with copy', async () => {
    const r = await send('تکایە پۆستەرێک دروست بکە بۆ KAAE\nکۆنفرانسی نیشتمانی متمانەبەخشین\nهەولێر، ٢٠٢٦\nسوپاس');
    expect(r.asked).toBe(false);
    drafted(r, 'کۆنفرانسی نیشتمانی متمانەبەخشین');
  });

  it('a brief with no client and no copy is still asked who it is for, and opens for a designer for that client', async () => {
    const r = await send('Hi, could you make a poster for us please?');
    expect(r.asked).toBe(true);
    expect(r.clientId).toBe(KAAE);
    expect(r.draft.isInstructionOnly).toBe(true);
    expect(r.copy).toEqual([]);
  });

  it('the rules read the brief as complete: the heuristics\' greeting or question is not the reading', () => {
    for (const text of ['Hi pls make an Instagram story for the Science Camp 20 March 2027 Thanks a lot',
      'Salam,\nOur Teacher Appreciation Day is on 15/10/2026. For KAAE, can u make a story for it?',
      'we need a KAAE flyer for the Parents Meeting Oct. 20 pls']) {
      expect(readIntentByRules(text), text).toMatchObject({ intent: 'new_brief', substantial: true, instructionOnly: false });
    }
    // A request with nothing of its own to print is still for a designer.
    for (const text of ['Hi, could you make a poster for us please?', 'can you make a poster for 2026?', 'Hello, we need a story'])
      expect(readIntentByRules(text), text).toMatchObject({ intent: 'new_brief', instructionOnly: true });
  });
});

describe('class 8: the client\'s full English name routes to it, as a whole name', () => {
  it.each([
    ['with "the"', 'Could you design a poster for our Book Fair on 5 November? It is for the Kurdistan Accrediting Association for Education.'],
    ['without "the"', 'Please make a flyer for the Research Day on 15 October 2026 for Kurdistan Accrediting Association for Education'],
    ['in lower case, split over a line', 'we need a banner for the open day on 3rd of December\nkurdistan accrediting\nassociation for education'],
  ])('%s', async (_name, text) => {
    const r = await send(text);
    expect(r.asked).toBe(false);
    expect(r.clientId).toBe(KAAE);
  });

  it('a part of the name is not the name: the requester is asked', async () => {
    const r = await send('Could you design a poster for the Kurdistan Association of Engineers dinner on 5 November at Rotana Hotel?');
    expect(r.asked).toBe(true);
  });
});

describe('class 4 and residue: titles name the event', () => {
  it('"<Event> is on <date>. Make a poster for it." is titled by the event (route)', async () => {
    const a = await send("KAAE's Research Day is on 15 October 2026 at Rotana Hotel. Please design a poster for it.");
    expect(a.title).toBe('KAAE: Research Day');
    const b = await send('Dear team, Our Graduation Ceremony is on 3rd of December in the KAAE hall, Erbil. Can you make a poster for it?');
    expect(b.title).toBe('KAAE: Graduation Ceremony');
  });

  it('titleName cuts before the copula and its date, time or place, and drops "our"/"the" and a greeting', () => {
    expect(titleName('Our Open Day is on 5 November')).toBe('Open Day');
    expect(titleName('Our Open Day Is on 5 November')).toBe('Open Day');
    expect(titleName('The Book Fair is on next Thursday at Sami Abdulrahman Park')).toBe('Book Fair');
    expect(titleName('KAAE parents meeting is on October 15 in the KAAE hall, Erbil')).toBe('KAAE Parents Meeting');
    expect(titleName('our annual conference will be held at Rotana Hotel')).toBe('Annual Conference');
    expect(titleName('The Spring Concert takes place in the main campus')).toBe('Spring Concert');
    expect(titleName('Hello Our Parents Meeting is on 20 March 2027')).toBe('Parents Meeting');
    // Not a name before the copula: kept as it was.
    expect(titleName('This is on 5 November')).toBe('This is on 5 November');
    expect(titleName('What we need is on the poster')).toBe('What we need is on the poster');
    // A name with "is" inside it, and no date, time or place after it, keeps its words.
    expect(titleName('Art Is Life Exhibition')).toBe('Art Is Life Exhibition');
  });

  it('a title never starts with a list mark, nor is it the words that introduce the copy', () => {
    expect(titleName('* Graduation Ceremony')).toBe('Graduation Ceremony');
    expect(titleName('- Leadership Training Course')).toBe('Leadership Training Course');
    expect(titleName('• annual conference')).toBe('annual conference');
    expect(titleName('With these details')).toBe('');
    expect(titleName('with this text: Career Fair')).toBe('Career Fair');
    expect(requestTitle({ headline: '* Graduation Ceremony', label: 'KAAE', clientLabel: true })).toBe('KAAE: Graduation Ceremony');
    expect(requestTitle({ headline: 'With these details', label: 'KAAE', clientLabel: true })).toBe('KAAE: no copy sent');
    // Class 10's title half: a bare "need a …" is a request, not the name.
    expect(requestTitle({ headline: 'need a flyer for our Teacher Appreciation Day 15/10/2026 pls', label: 'KAAE', clientLabel: true }))
      .toBe('KAAE: Teacher Appreciation Day');
    expect(requestTitle({ headline: 'Hi need a KAAE banner for our Staff Football Tournament next Thursday', label: 'KAAE', clientLabel: true }))
      .toBe('KAAE: Staff Football Tournament');
    expect(requestTitle({ headline: 'need a nice poster for our Quality Assurance Workshop Oct. 20 pls', label: 'KAAE', clientLabel: true }))
      .toBe('KAAE: Quality Assurance Workshop');
    expect(requestTitle({ headline: 'need a social media post for the Leadership Training Course 15/10/2026', label: 'KAAE', clientLabel: true }))
      .toBe('KAAE: Leadership Training Course');
    expect(requestTitle({ headline: 'need a post for the upcoming Parents Meeting 15 October 2026', label: 'KAAE', clientLabel: true }))
      .toBe('KAAE: Parents Meeting');
    expect(requestTitle({ headline: "Can I have an Instagram post for KAAE's Assessment Literacy Workshop for parents and students on Monday 12 November?",
      label: 'KAAE', clientLabel: true })).toBe('KAAE: Assessment Literacy Workshop');
    // A date line is not a list mark.
    expect(titleName('15/10/2026 Book Fair')).toBe('15/10/2026 Book Fair');
  });
});

describe('controls: what is not a new brief stays what it is', () => {
  it.each([
    ['a status question', 'when will the poster be ready?'],
    ['a change', 'can you make the logo bigger?'],
    ['thanks alone', 'thanks'],
    ['a greeting alone', 'Hi there!'],
  ])('%s opens nothing and asks no "who is this for?"', async (_name, text) => {
    const r = await send(text);
    expect(r.first.clientQuestion ?? false).toBe(false);
    if (r.first.lifecycleAction === 'open-request') expect(r.first.draft.isInstructionOnly).toBe(true);
    expect(r.copy).toEqual([]);
  });

  it('the rules\' readings of the controls are unchanged', () => {
    expect(readIntentByRules('when will the poster be ready?').intent).toBe('status');
    expect(readIntentByRules('can you make the logo bigger?').intent).toBe('change');
    expect(readIntentByRules('thanks').intent).toBe('acknowledgement');
    expect(readIntentByRules('Hi there!').intent).toBe('conversation');
    expect(readIntentByRules('please cancel the book fair poster').intent).toBe('cancel');
  });
});
