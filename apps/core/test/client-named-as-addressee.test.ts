import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '@hawa/db';
import { createApp } from '../src/app.js';
import type { ChatIntake } from '../src/services/chat-intake.js';
import { extractRequestCopy, type CopyExtractionModel } from '../src/services/request-copy-extraction.js';

/**
 * ADR-284 addendum ("client named as the addressee", 2026-10-03). Naming who a design is for at the start of
 * the request ("For KAAE, could you design …", "KAAE - could you …", "KAAE: …") or right after the design
 * ("a poster for KAAE for our Quality Week …") printed the client's name as copy and titled the design
 * "KAAE: For KAAE". The client reference is never copy and never the title: the result is the same copy and the
 * same title as the brief without it, and the request is still the client's. A name that is part of the copy
 * ("KAAE Open Day", quoted words, laid-out lines) stays.
 *
 * Route level, as the owner's office chat sends it: `/v1/internal/telegram/intake` against the per-file test
 * database. The brief without the client reference is opened through the client question ("KAAE" as answer),
 * so both are read by the same intake and copy reader for the same client.
 */
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const OWNER = 91000007;
const OUTSIDER = 91000555;
const WORKER = ['worker', 'client', 'fixture', 'token'].join('_');
const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OWNER);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { process.env = saved; await db.destroy(); });

let next = 1_100_000_000 + Math.floor(Math.random() * 700_000_000);
const freshChat = () => 68_000_000 + Math.floor(Math.random() * 9_000_000);
const message = (chat: number, from: number, text: string) => {
  const id = ++next;
  return { update_id: id, message: { message_id: id % 100000, from: { id: from, is_bot: false, first_name: 'Sewa' },
    chat: { id: chat, type: 'private' }, date: 1790000000, text } };
};
const app = () => { vi.stubEnv('HAWA_WORKER_TOKEN', WORKER); return createApp({ db, requesterIntentModel: null } as any); };
const intake = async (update: unknown) => (await (await app().request('/v1/internal/telegram/intake', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` },
  body: JSON.stringify({ v: 1, update, mode: 'lifecycle', languageSiblings: true }) })).json()) as Record<string, any>;
const texts = (draft: { exactCopy: unknown[] }) => (draft.exactCopy as Array<{ text: string }>).map((b) => b.text);

/**
 * A brief opened for KAAE: directly when its words name KAAE (sent by the office owner), else through the
 * client question (an outside requester answering "KAAE").
 */
async function openFor(words: string, from: 'owner' | 'outsider') {
  // A chat of its own for each brief: an earlier brief still open in the same chat would make the next one a
  // possible change to it (ADR-284), which is not what is tested here.
  const chat = freshChat();
  const sender = from === 'owner' ? OWNER : OUTSIDER;
  const first = await intake(message(chat, sender, words));
  const opened = first.lifecycleAction === 'open-request' ? first : await intake(message(chat, sender, 'KAAE'));
  expect(opened, words).toMatchObject({ lifecycleAction: 'open-request', draft: { clientId: KAAE, rawText: words } });
  return opened.draft as { title: string; exactCopy: unknown[]; clientId: string; copyExtraction?: Record<string, unknown> };
}

const QUALITY_WEEK = 'a poster for our Quality Week on 12 November at the Rotana Hotel?';
const TEACHER_CKB = 'پۆستەرێک بۆ ڕۆژی ڕێزلێنان لە مامۆستایان دروست بکە. لە ٢٠ی تشرینی یەکەمی ٢٠٢٦ کاتژمێر ٢:٠٠ لە هۆڵی هۆتێل ڕۆتانا، هەولێر.';

describe('the client named as the addressee is never copy, never the title (ADR-284 addendum)', () => {
  it.each([
    // The four seen on 2026-10-03.
    ['"For KAAE," before the ask', `For KAAE, could you design ${QUALITY_WEEK}`, `Could you design ${QUALITY_WEEK}`],
    ['"For KAAE:" before the ask', 'For KAAE: please make a poster announcing the Assessment Literacy Workshop on 5 November.',
      'Please make a poster announcing the Assessment Literacy Workshop on 5 November.'],
    ['"KAAE -" before the ask', 'KAAE - could you design an Instagram post for our Open Day on 20 October?',
      'Could you design an Instagram post for our Open Day on 20 October?'],
    ['"for KAAE" after the design, then "for our"', 'Could you design a poster for KAAE for our Quality Week on 12 November?',
      'Could you design a poster for our Quality Week on 12 November?'],
    // More of the same, as the office writes.
    ['"To KAAE," with "we need"', 'To KAAE, we need a flyer about the Accreditation Info Session on 6 November 2026 at 11 am.',
      'We need a flyer about the Accreditation Info Session on 6 November 2026 at 11 am.'],
    ['"KAAE:" and a second sentence', 'KAAE: can you make a banner for the Teacher Appreciation Day? It\'s on 20 October 2026 at 2:00 PM in the Rotana Hotel ballroom, Erbil.',
      'Can you make a banner for the Teacher Appreciation Day? It\'s on 20 October 2026 at 2:00 PM in the Rotana Hotel ballroom, Erbil.'],
    ['a greeting, then "for KAAE,"', 'Hi team, for KAAE, could you design a poster for our Book Fair on 5 November?',
      'Hi team, could you design a poster for our Book Fair on 5 November?'],
    ['the full name with "the"', `For the Kurdistan Accrediting Association for Education, could you design ${QUALITY_WEEK}`,
      `Could you design ${QUALITY_WEEK}`],
    ['"for KAAE" then "announcing"', 'Could you make a poster for KAAE announcing the Science Fair on 14 November 2026 at 9:00 AM?',
      'Could you make a poster announcing the Science Fair on 14 November 2026 at 9:00 AM?'],
    ['"for KAAE," with a comma, then "about"', 'We\'d like an Instagram story for KAAE, about the Open Day on 20 October 2026 at the campus.',
      'We\'d like an Instagram story about the Open Day on 20 October 2026 at the campus.'],
    ['"For KAAE:" on a line of its own', `For KAAE:\nCould you design ${QUALITY_WEEK}`, `Could you design ${QUALITY_WEEK}`],
    // Sorani: "For KAAE, please make a poster for the Day of Honouring Teachers. On 20 October 2026 at 2:00 in the Rotana Hotel hall, Erbil."
    ['Sorani, "for KAAE," before the ask', `بۆ KAAE، تکایە ${TEACHER_CKB}`, `تکایە ${TEACHER_CKB}`],
    // Sorani: "Please make a poster for KAAE for the Day of Honouring Teachers. …"
    ['Sorani, "for KAAE" after the design', 'تکایە پۆستەرێک بۆ KAAE بۆ ڕۆژی ڕێزلێنان لە مامۆستایان دروست بکە. لە ٢٠ی تشرینی یەکەمی ٢٠٢٦ کاتژمێر ٢:٠٠ لە هۆڵی هۆتێل ڕۆتانا، هەولێر.',
      `تکایە ${TEACHER_CKB}`],
    // Sorani: "Please make a poster for KAAE, for the Day of Honouring Teachers, …" with the verb before "for".
    ['Sorani, "for KAAE" then the verb, then "for"', 'تکایە پۆستەرێک بۆ KAAE دروست بکە بۆ ڕۆژی ڕێزلێنان لە مامۆستایان. لە ٢٠ی تشرینی یەکەمی ٢٠٢٦ کاتژمێر ٢:٠٠ لە هۆڵی هۆتێل ڕۆتانا، هەولێر.',
      'تکایە پۆستەرێک دروست بکە بۆ ڕۆژی ڕێزلێنان لە مامۆستایان. لە ٢٠ی تشرینی یەکەمی ٢٠٢٦ کاتژمێر ٢:٠٠ لە هۆڵی هۆتێل ڕۆتانا، هەولێر.'],
  ])('%s', async (_name, named, without) => {
    const draft = await openFor(named, 'owner');
    const control = await openFor(without, 'outsider');
    expect(texts(control).length, without).toBeGreaterThan(0);
    expect(texts(draft)).toEqual(texts(control));
    expect(draft.title).toBe(control.title);
    expect(draft.title.startsWith('KAAE: ') || draft.title.startsWith('KAAE ')).toBe(true);
    for (const line of texts(draft)) expect(line).not.toMatch(/^(?:for|to)\s+(?:the\s+)?KAAE\b|^KAAE$|^بۆ\s+KAAE/iu);
    expect(draft.title).not.toMatch(/For KAAE|KAAE: KAAE|KAAE for/iu);
  });

  it('the four seen on 2026-10-03, exactly', async () => {
    expect(await openFor(`For KAAE, could you design ${QUALITY_WEEK}`, 'owner'))
      .toMatchObject({ title: 'KAAE: Quality Week', exactCopy: [{ text: 'Quality Week on 12 November at the Rotana Hotel' }] });
    expect(await openFor('For KAAE: please make a poster announcing the Assessment Literacy Workshop on 5 November.', 'owner'))
      .toMatchObject({ title: 'KAAE: Assessment Literacy Workshop', exactCopy: [{ text: 'Assessment Literacy Workshop on 5 November' }] });
    expect(await openFor('KAAE - could you design an Instagram post for our Open Day on 20 October?', 'owner'))
      .toMatchObject({ title: 'KAAE: Open Day', exactCopy: [{ text: 'Open Day on 20 October' }] });
    expect(await openFor('Could you design a poster for KAAE for our Quality Week on 12 November?', 'owner'))
      .toMatchObject({ title: 'KAAE: Quality Week', exactCopy: [{ text: 'Quality Week on 12 November' }] });
  });
});

describe('a client name that is part of the copy stays (ADR-284 addendum)', () => {
  it.each([
    ['quoted words', 'Could you design a poster that says "KAAE welcomes you" for the Open Day on 20 October?', 'KAAE welcomes you'],
    ['an event named after the client', 'Could you design a poster for the KAAE Open Day on 20 October?', 'KAAE Open Day on 20 October'],
    ['an event named after the client, no article', 'Could you design a poster for KAAE Open Day on 20 October?', 'KAAE Open Day on 20 October'],
    ['the client\'s members as the audience', 'For KAAE members, could you design a poster for the Annual Dinner on 30 October?', 'For KAAE members'],
    ['a place named after the client', 'Could you design a poster for our Book Fair on 5 November at the KAAE library?', 'Book Fair on 5 November at the KAAE library'],
  ])('%s', async (_name, words, kept) => {
    const draft = await openFor(words, 'owner');
    expect(texts(draft)).toContain(kept);
  });

  it('copy the requester laid out is used exactly as given', async () => {
    const words = 'KAAE Open Day\n20 October 2026\nCampus, 10 am';
    const draft = await openFor(words, 'owner');
    expect(texts(draft).join('\n')).toContain('KAAE Open Day');
    expect(draft.copyExtraction).toBeUndefined();
  });

  it('a request that names only the client carries no copy and opens for a designer, never printing the name', async () => {
    const words = 'Could you design a poster for KAAE?';
    const draft = await openFor(words, 'owner');
    expect(texts(draft)).not.toContain('KAAE');
  });
});

describe('a model reading cannot print the addressee either (ADR-284 addendum)', () => {
  it('lines that name the client as the addressee are refused by the guard; the event\'s own lines are kept', async () => {
    const words = `For KAAE, could you design ${QUALITY_WEEK}`;
    const draft: ChatIntake = { platform: 'telegram', sourceEventId: 'lc-x-r0', sourceChannelId: '64000001', rawText: words,
      title: 'KAAE: request', clientId: KAAE, designInstructions: '', exactCopy: [{ id: 'copy_0', role: 'headline', text: words }], autoGenerate: true };
    const model = { read: vi.fn<CopyExtractionModel['read']>(async () => ({ headline: 'Quality Week',
      lines: ['For KAAE', 'KAAE', '12 November', 'Rotana Hotel'] })) };
    const read = await extractRequestCopy(draft, { model, tenantId: 't', updateId: 2_345_679, senderName: 'Requester' });
    expect(model.read).toHaveBeenCalledTimes(1);
    expect(texts(read)).toEqual(['Quality Week', '12 November', 'Rotana Hotel']);
    expect(read.title).toBe('KAAE: Quality Week');
    expect(read.copyExtraction?.refused?.map((r) => r.text)).toEqual(['For KAAE', 'KAAE']);
    // A model whose headline is the addressee falls back to the rules, which leave it out.
    const named = { read: vi.fn<CopyExtractionModel['read']>(async () => ({ headline: 'For KAAE', lines: [] })) };
    const rules = await extractRequestCopy(draft, { model: named, tenantId: 't', updateId: 2_345_680, senderName: 'Requester' });
    expect(texts(rules)).toEqual(['Quality Week on 12 November at the Rotana Hotel']);
    expect(rules.copyExtraction).toMatchObject({ method: 'rules', request: 'For KAAE, could you design a poster for our' });
  });
});
