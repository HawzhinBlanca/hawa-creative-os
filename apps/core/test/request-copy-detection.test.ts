import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '@hawa/db';
import { createApp } from '../src/app.js';
import type { ChatIntake } from '../src/services/chat-intake.js';
import { copyTitle, extractRequestCopy, type CopyExtractionModel, type ProposedCopy } from '../src/services/request-copy-extraction.js';

/**
 * ADR-232 addendum (live L15, 2026-10-01): "Could you design a KAAE poster for our Teacher Appreciation
 * Day? …" was not recognised as a request (a client name stood between the article and "poster"), so
 * the whole sentence was printed again. A request is now recognised wherever its opener stands in a
 * sentence, with words between the article and the design noun, and a final check never lets copy
 * that still asks the bot for something be printed. Every case here printed the request before.
 */
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const L15 = 'Could you design a KAAE poster for our Teacher Appreciation Day? It\'s on 20 October 2026 at 2:00 PM in the Rotana Hotel ballroom, Erbil. All teachers are welcome.';

const texts = (draft: ChatIntake) => (draft.exactCopy as Array<{ text: string }>).map((b) => b.text);
const prepared = (text: string, extra: Partial<ChatIntake> = {}): ChatIntake => ({ platform: 'telegram', sourceEventId: 'lc-x-r0',
  sourceChannelId: '64000001', rawText: text, title: 'KAAE: request', clientId: KAAE, designInstructions: '',
  exactCopy: [{ id: 'copy_0', role: 'headline', text }], autoGenerate: true, ...extra });
const fixed = (copy: ProposedCopy | null) => ({ read: vi.fn<CopyExtractionModel['read']>(async () => copy) });
const ctx = (model: CopyExtractionModel | null) => ({ model, tenantId: 't', updateId: 2_345_678, senderName: 'Requester' });
/** Words that ask the bot for something: never printed. */
const ASKS = /\b(?:could|can|would|will)\s+(?:you|u)\b|\bplease\s+(?:design|make|create|prepare)\b|\b(?:we|i)(?:'d|\s+would)\s+like\b|\b(?:we|i)\s+(?:need|want)\b|^(?:design|make|create|prepare)\s+(?:a|an|two)\b|تکایە|دەتوانیت|دروست\s+بکە/iu;

describe('requests the first rules missed open with their copy, never the request (rules, no model)', () => {
  it.each([
    ['the live L15 sentence', L15,
      ['Teacher Appreciation Day', '20 October 2026 at 2:00 PM in the Rotana Hotel ballroom, Erbil', 'All teachers are welcome']],
    ['two designs named, then "announcing"', 'Could you please create an Instagram story and a poster announcing the KAAE Book Fair? 5–7 November 2026, Erbil International Fair Ground. Free entry.',
      ['KAAE Book Fair', '5–7 November 2026, Erbil International Fair Ground', 'Free entry']],
    ['"We\'d like a small flyer"', 'We\'d like a small flyer for the Spring Science Camp. It runs 1–5 April 2027 at the KAAE campus. Ages 10–14.',
      ['Spring Science Camp', 'It runs 1–5 April 2027 at the KAAE campus', 'Ages 10–14']],
    ['"Hey, we need something for"', 'Hey, we need something for our Graduation Ceremony on 12 June 2027 at 4:00 PM, Erbil Rotana. Families are welcome.',
      ['Graduation Ceremony on 12 June 2027 at 4:00 PM, Erbil Rotana', 'Families are welcome']],
    ['"Please prepare an invitation card"', 'Please prepare an invitation card for the KAAE Annual Gala. 18 December 2026, 7:00 PM, Divan Hotel.',
      ['KAAE Annual Gala', '18 December 2026, 7:00 PM, Divan Hotel']],
    ['"I need a KAAE Instagram post about"', 'I need a KAAE Instagram post about the Assessment Literacy Workshop for school principals on 15 October 2026 at 10:00 AM.',
      ['Assessment Literacy Workshop for school principals on 15 October 2026 at 10:00 AM']],
    ['the opener after the event name, with a greeting', 'Hi team! For our Teacher Appreciation Day, could you design a poster? 20 October 2026 at 2:00 PM, Rotana Hotel ballroom.',
      ['Teacher Appreciation Day', '20 October 2026 at 2:00 PM, Rotana Hotel ballroom']],
    ['"Would you design two KAAE posters announcing"', 'Would you design two KAAE posters announcing the Quality Assurance Forum? 3 November 2026 at 9:00 AM, KAAE hall.',
      ['Quality Assurance Forum', '3 November 2026 at 9:00 AM, KAAE hall']],
    ['an imperative with a client name', 'Design a simple KAAE banner for the Open Day. Saturday 7 November 2026, 10:00 AM to 2:00 PM.',
      ['Open Day', 'Saturday 7 November 2026, 10:00 AM to 2:00 PM']],
    ['lower case, "can u"', 'can u make a quick KAAE post for the staff football tournament? final on 30 October 2026 at 5 PM',
      // ADR-235: the first letter of each line is a capital; the rest as typed.
      ['Staff football tournament', 'Final on 30 October 2026 at 5 PM']],
    ['"We want a big colourful poster"', 'We want a big colourful poster for the Children\'s Book Week. 9–15 November 2026 at the KAAE library.',
      ['Children\'s Book Week', '9–15 November 2026 at the KAAE library']],
    ['"Can you help us with a poster"', 'Can you help us with a poster for the KAAE Science Fair? It\'s on 14 November 2026 at 9:00 AM.',
      ['KAAE Science Fair', '14 November 2026 at 9:00 AM']],
    ['a question to the bot with no design named', 'Could you help with our Teacher Appreciation Day? 20 October 2026 at 2:00 PM, Rotana Hotel ballroom.',
      ['Teacher Appreciation Day', '20 October 2026 at 2:00 PM, Rotana Hotel ballroom']],
    // "Please make a nice KAAE poster for the Day of Honouring Teachers. On 20 October 2026 at 2:00 in the Rotana Hotel hall, Erbil. All teachers are welcome."
    ['Sorani, words between the noun and "for"', 'تکایە پۆستەرێکی جوانی KAAE بۆ ڕۆژی ڕێزلێنان لە مامۆستایان دروست بکە. لە ٢٠ی تشرینی یەکەمی ٢٠٢٦ کاتژمێر ٢:٠٠ لە هۆڵی هۆتێل ڕۆتانا، هەولێر. هەموو مامۆستایان بەخێربێن.',
      ['ڕۆژی ڕێزلێنان لە مامۆستایان', '٢٠ی تشرینی یەکەمی ٢٠٢٦ کاتژمێر ٢:٠٠ لە هۆڵی هۆتێل ڕۆتانا، هەولێر', 'هەموو مامۆستایان بەخێربێن']],
    // "Can you make a KAAE design for the assessment workshop? On 15 October 2026."
    ['Sorani, a question with a client name', 'دەتوانیت دیزاینێکی KAAE بۆ وۆرکشۆپی هەڵسەنگاندن دروست بکەیت؟ لە ١٥ی تشرینی یەکەمی ٢٠٢٦.',
      ['وۆرکشۆپی هەڵسەنگاندن', '١٥ی تشرینی یەکەمی ٢٠٢٦']],
    // "Please make a KAAE poster for Teacher Appreciation Day." then English details.
    ['mixed Sorani and English', 'تکایە پۆستەرێکی KAAE بۆ Teacher Appreciation Day دروست بکە. 20 October 2026 at 2:00 PM, Rotana Hotel ballroom.',
      ['Teacher Appreciation Day', '20 October 2026 at 2:00 PM, Rotana Hotel ballroom']],
  ])('%s', async (_name, words, expected) => {
    const draft = await extractRequestCopy(prepared(words), ctx(null));
    expect(texts(draft)).toEqual(expected);
    expect(draft.copyExtraction).toMatchObject({ method: 'rules' });
    for (const line of texts(draft)) expect(line).not.toMatch(ASKS);
    // Named by its headline, the client once ("KAAE Book Fair", not "KAAE: KAAE Book Fair").
    expect(draft.title).toBe(copyTitle(expected[0], 'KAAE'));
    expect(draft.title).not.toMatch(/[?]|could you|poster for/i);
  });
});

describe('the model reads them, and the final check holds whatever it proposes', () => {
  it('L15 is read by the model (once) and its checked copy is used', async () => {
    const model = fixed({ headline: 'Teacher Appreciation Day', lines: ['20 October 2026 · 2:00 PM', 'Rotana Hotel ballroom, Erbil', 'All teachers are welcome'] });
    const draft = await extractRequestCopy(prepared(L15), ctx(model));
    expect(model.read).toHaveBeenCalledTimes(1);
    expect(texts(draft)).toEqual(['Teacher Appreciation Day', '20 October 2026 · 2:00 PM', 'Rotana Hotel ballroom, Erbil', 'All teachers are welcome']);
    expect(draft).toMatchObject({ title: 'KAAE: Teacher Appreciation Day', copyExtraction: { method: 'model', request: 'Could you design a KAAE poster for our' } });
  });

  it('a model line that still asks the bot is never printed; a headline that does falls to the rules', async () => {
    const draft = await extractRequestCopy(prepared(L15), ctx(fixed({ headline: 'Teacher Appreciation Day',
      lines: ['Could you design a KAAE poster', 'All teachers are welcome'] })));
    expect(texts(draft)).toEqual(['Teacher Appreciation Day', 'All teachers are welcome']);
    const fallen = await extractRequestCopy(prepared(L15), ctx(fixed({ headline: 'Could you design a KAAE poster for our Teacher Appreciation Day', lines: [] })));
    expect(fallen.copyExtraction).toMatchObject({ method: 'rules' });
    expect(texts(fallen)[0]).toBe('Teacher Appreciation Day');
  });

  it('laid-out copy with a request among its lines is never printed as it stands', async () => {
    const draft = await extractRequestCopy(prepared('Assessment Literacy Workshop', { exactCopy: [
      { text: 'Assessment Literacy Workshop' }, { text: '15 October 2026, KAAE hall' }, { text: 'Could you also design a poster for this?' }] }), ctx(null));
    expect(texts(draft)).toEqual(['Assessment Literacy Workshop', '15 October 2026, KAAE hall']);
    for (const line of texts(draft)) expect(line).not.toMatch(ASKS);
  });
});

// --- through intake ---------------------------------------------------------------------------------------

const REQUESTER = 91000400;
const WORKER = ['worker', 'detect', 'fixture', 'token'].join('_');
const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = '91000007';
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { process.env = saved; await db.destroy(); });

it('L15 through intake: a KAAE request is read once by the model, and opens with its checked copy', async () => {
  vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
  const model = fixed({ headline: 'Teacher Appreciation Day', lines: ['20 October 2026 · 2:00 PM', 'Rotana Hotel ballroom, Erbil', 'All teachers are welcome'] });
  const id = 1_100_000_000 + Math.floor(Math.random() * 800_000_000);
  const chat = 67_000_000 + Math.floor(Math.random() * 9_000_000);
  const update = { update_id: id, message: { message_id: id % 100000, from: { id: REQUESTER, is_bot: false, first_name: 'Sewa' },
    chat: { id: chat, type: 'private' }, date: 1790000000, text: L15 } };
  const res = await createApp({ db, requesterIntentModel: null, copyExtractionModel: model } as any).request('/v1/internal/telegram/intake', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` },
    body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) });
  const opened = await res.json() as Record<string, any>;
  expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: KAAE, autoGenerate: true,
    title: 'KAAE: Teacher Appreciation Day', copyExtraction: { method: 'model' } } });
  expect(texts(opened.draft)).toEqual(['Teacher Appreciation Day', '20 October 2026 · 2:00 PM', 'Rotana Hotel ballroom, Erbil', 'All teachers are welcome']);
  expect(model.read).toHaveBeenCalledTimes(1);
  expect(model.read.mock.calls[0][0]).toMatchObject({ clientId: KAAE, updateId: id });
});
