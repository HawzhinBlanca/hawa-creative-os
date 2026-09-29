/**
 * ADR-148: Telegram keeps only the first 1024 UTF-16 units of a caption from a standard account. The
 * owner's six-photo album of 2026-09-29 had a caption of exactly 1024 characters, cut mid-sentence, and
 * the design shipped the cut sentence as its subtitle. A caption at the limit is never the whole brief:
 * the album waits for the rest, asked once in plain words, and the sender's next message joins it.
 * Worker intake route against the per-file database; the worker's durable settle is modelled by calling
 * intake again with `settle: true` (as lifecycle-album-settle.test.ts does).
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { ALBUM_MESSAGES, TELEGRAM_CAPTION_LIMIT } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { titleAsHeadline } from '../src/routes/tasks.routes.js';
import { CUT_CAPTION_WAIT_MS, captionMayBeCut, joinCutCaption, overdueSettles, withoutCutLine } from '../src/services/lifecycle-album.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const userId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId, role: 'operator' as const };
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const token = ['caption', 'limit', 'fixture', 'token'].join('_');
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
let id = 870_000_000;
const photo = (n: number) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'), Buffer.from([n])]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await db.destroy(); await owner.destroy(); });

// The shape of the owner's caption, built from parts (no real person's words): instructions, a line
// that introduces the text, then the title, the subtitle and a supporting line, one per line.
const INSTRUCTION = 'Design a formal report cover for KAAE with the supplied photos in a clean collage, navy and yellow brand colours, the logo near the top. ';
const INTRODUCER = 'Here is the text and the photos:';
const TITLE = 'KAAE K-12 Pilot Study';
const SUBTITLE = 'Field Visit Report';
const SUPPORTING = 'Insights from school field visits and next steps toward better learning for every pupil';

/** A caption of exactly `length` UTF-16 units whose last line is complete. */
function captionOf(length: number): string {
  const tail = `\n\n${INTRODUCER}\n\n${TITLE}\n${SUBTITLE}\n\n${SUPPORTING}`;
  const room = length - tail.length;
  let instructions = INSTRUCTION.repeat(Math.ceil(room / INSTRUCTION.length) + 1).slice(0, room);
  if (instructions.endsWith(' ')) instructions = `${instructions.slice(0, -1)}.`;
  const caption = instructions + tail;
  expect(caption.length).toBe(length);
  return caption;
}
/** The caption Telegram delivers when the requester wrote more: the first 1024 units, cut mid-word. */
function cutCaption(): { cut: string; rest: string } {
  for (let extra = 30; extra < 80; extra++) {
    const full = captionOf(TELEGRAM_CAPTION_LIMIT + extra);
    const cut = full.slice(0, TELEGRAM_CAPTION_LIMIT);
    if (/\p{L}$/u.test(cut) && /^\p{L}/u.test(full.slice(TELEGRAM_CAPTION_LIMIT))) return { cut, rest: full.slice(TELEGRAM_CAPTION_LIMIT) };
  }
  throw new Error('no mid-word cut found');
}

const SENDER = 91000031;

function setup() {
  const chat = ++id;
  vi.stubEnv('HAWA_WORKER_TOKEN', token);
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '100000');
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '10000');
  const download = vi.fn(async (file: string) => photo(Number(file)));
  const bridge = { downloadFile: download, dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
  const app = createApp({ db, telegramBridge: bridge } as any);
  const from = { id: SENDER, first_name: 'Requester' };
  const group = `caption-limit-${chat}`;
  const part = (messageId: number, file: number, caption?: string) => ({
    update_id: ++id, message: { message_id: messageId, date: 1790000000, from, chat: { id: chat, type: 'private' },
      media_group_id: group, photo: [{ file_id: String(file) }], ...(caption ? { caption } : {}) },
  });
  const text = (words: string) => ({ update_id: ++id, message: { message_id: ++id, date: 1790000000, from,
    chat: { id: chat, type: 'private' }, text: words } });
  const intake = async (update: unknown, extra: { settle?: boolean; briefHold?: boolean } = {}) => {
    const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers,
      body: JSON.stringify({ v: 1, mode: 'legacy', update, languageSiblings: true, ...extra }) });
    expect(res.status).toBe(200);
    return await res.json();
  };
  const settle = (update: unknown) => intake(update, { settle: true, briefHold: true });
  const tasks = () => withRlsContext(db, scope, async (trx) => (await sql<{ task_id: string }>`
    SELECT aggregate_id::text AS task_id FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid
      AND command_type = 'task.created' AND payload->>'sourceChannelId' = ${String(chat)}`.execute(trx)).rows);
  const opens = () => withRlsContext(db, scope, async (trx) => (await sql<{ n: string }>`SELECT count(*) AS n
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_open'
      AND payload->>'chatId' = ${String(chat)}`.execute(trx)).rows[0].n).then(Number);
  /** Moves the album and its question back in time, as if the requester had said nothing since. */
  const age = (interval: string) => sql`UPDATE hawa.inbox_events SET received_at = received_at - ${interval}::interval
    WHERE tenant_id = ${tenantId}::uuid AND payload->>'chatId' = ${String(chat)}
      AND source_account_id IN ('lifecycle_album_part', 'lifecycle_album_pending', 'lifecycle_album_cut')`.execute(owner);
  const album = async (caption: string) => {
    const parts = [1, 2, 3, 4, 5, 6].map((n) => part(200 + n, n, n === 1 ? caption : undefined));
    const answers: any[] = [];
    for (const p of parts) answers.push(await intake(p, { briefHold: true }));
    return { parts, answers };
  };
  return { chat, part, text, intake, settle, tasks, opens, app, download, age, album };
}

async function project(app: ReturnType<typeof createApp>, decision: any) {
  return app.request(`/v1/internal/lifecycle/${decision.requestId}/project`, { method: 'POST', headers,
    body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${decision.requestId}:1:open`,
      ops: [{ kind: 'createRequest', draft: decision.draft }] }) });
}

/** The draft's headline: its first exact-copy block, which the design sets as the headline. */
const headlineOf = (draft: any): string | undefined => {
  const first = draft.exactCopy?.[0];
  return first?.role === 'headline' ? first.text : undefined;
};

/** What the requester would be sent for an answer: its album notice, chat answer or words beside it. */
const saidTo = (answer: any): string[] =>
  [answer?.albumMessage, answer?.chatAnswer?.text, answer?.notice?.text, answer?.sourceMessage].filter((t): t is string => typeof t === 'string' && t.length > 0);

describe('a caption Telegram cut at its limit (ADR-148)', () => {
  it('holds a six-photo album whose caption is 1024 characters: no draft, one plain question for the rest', async () => {
    const f = setup();
    const { cut } = cutCaption();
    expect(cut.length).toBe(1024);
    const { parts, answers } = await f.album(cut);
    for (const a of answers) expect(a).toMatchObject({ intakeStatus: 202, lifecycleAction: 'settle-later', settle: { kind: 'album' } });
    // The older photos' settles find a newer photo; the newest photo's settle asks for the rest.
    for (const p of parts.slice(0, 5)) answers.push(await f.settle(p));
    const asked = await f.settle(parts[5]);
    answers.push(asked);
    expect(asked).toMatchObject({ intakeStatus: 202, lifecycleAction: 'settle-later', chatId: String(f.chat),
      settle: { kind: 'album', delayMs: CUT_CAPTION_WAIT_MS }, notice: { text: ALBUM_MESSAGES.captionCut.en } });
    expect(asked.draft).toBeUndefined();
    const said = answers.flatMap(saidTo);
    expect(said).toEqual([ALBUM_MESSAGES.captionCut.en]);
    expect(said[0]).not.toMatch(/\/\w|reply to|caption|1024/i);
    expect(await f.opens()).toBe(0);
    expect(await f.tasks()).toHaveLength(0);
    // The delayed settle comes back inside the window: still waiting, and the question is the same
    // update's notice (ChatInbox sends a notice once per update), not a second message.
    const again = await f.settle(parts[5]);
    expect(again).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'album' }, notice: { text: ALBUM_MESSAGES.captionCut.en } });
    expect(again.settle.delayMs).toBeLessThanOrEqual(CUT_CAPTION_WAIT_MS);
    expect(await f.opens()).toBe(0);
    expect(f.download).toHaveBeenCalledTimes(6);
  });

  it('joins the next plain message onto the caption: rawText is caption, newline, rest; the headline is the title line', async () => {
    const f = setup();
    const { cut, rest } = cutCaption();
    const { parts } = await f.album(cut);
    await f.settle(parts[5]);
    const followUp = f.text(rest);
    const opened = await f.intake(followUp, { briefHold: true });
    expect(opened).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', chatId: String(f.chat), draft: {
      rawText: `${cut}\n${rest}`,
      lifecycleAlbum: { updateId: followUp.update_id, images: [1, 2, 3, 4, 5, 6].map((n) => ({ sha256: sha(photo(n)) })) } } });
    // The headline is the title line; the line that introduced the text is an instruction (a2e9f6af).
    expect(headlineOf(opened.draft)).toBe(TITLE);
    expect(opened.draft.title.startsWith(`KAAE: ${TITLE}`)).toBe(true);
    expect(opened.draft.title).not.toContain('Here is the text');
    expect(opened.notice).toBeUndefined();
    // A replay gives the recorded decision; the album's own delayed settle then does nothing.
    expect(await f.intake(followUp, { briefHold: true })).toMatchObject({ duplicate: true, requestId: opened.requestId });
    expect(await f.settle(parts[5])).toMatchObject({ settle: 'skipped' });
    expect(await f.opens()).toBe(1);
    expect((await project(f.app, opened)).status).toBe(200);
    expect(await f.tasks()).toHaveLength(1);
  });

  it('drafts a 1023-character caption at the album settle, as before', async () => {
    const f = setup();
    const caption = captionOf(TELEGRAM_CAPTION_LIMIT - 1);
    expect(caption.length).toBe(1023);
    const { parts } = await f.album(caption);
    const opened = await f.settle(parts[5]);
    expect(opened).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', draft: {
      rawText: caption, lifecycleAlbum: { updateId: parts[5].update_id } } });
    expect(opened.notice).toBeUndefined();
    expect(headlineOf(opened.draft)).toBe(TITLE);
    expect(await f.opens()).toBe(1);
  });

  it('asks again for an OK, and opens with the complete lines only once the held-brief window has passed', async () => {
    const f = setup();
    const { cut } = cutCaption();
    const { parts } = await f.album(cut);
    await f.settle(parts[5]);
    const ok = await f.intake(f.text('ok'), { briefHold: true });
    expect(ok).toMatchObject({ intakeStatus: 202, lifecycleAction: 'album-message', albumMessage: ALBUM_MESSAGES.captionCut.en });
    expect(await f.opens()).toBe(0);
    // No rest came within the window: the poller's sweep lists the album, and its settle opens it
    // without the cut line (never copy).
    await f.age('11 minutes');
    const due = await withRlsContext(db, scope, (trx) => overdueSettles(trx, tenantId));
    expect(due.filter((d) => d.chatId === String(f.chat)).map((d) => d.update.update_id)).toEqual([parts[5].update_id]);
    const opened = await f.settle(parts[5]);
    const kept = withoutCutLine(cut);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: kept, lifecycleAlbum: { updateId: parts[5].update_id } } });
    const cutLine = cut.slice(cut.lastIndexOf('\n') + 1);
    expect(cutLine.length).toBeGreaterThan(10);
    expect(JSON.stringify(opened.draft)).not.toContain(cutLine);
    expect(headlineOf(opened.draft)).toBe(TITLE);
    expect(await f.settle(parts[5])).toMatchObject({ duplicate: true, requestId: opened.requestId });
    expect(await withRlsContext(db, scope, (trx) => overdueSettles(trx, tenantId)).then((d) => d.filter((x) => x.chatId === String(f.chat)))).toEqual([]);
    expect(await f.opens()).toBe(1);
  });

  it('takes the whole brief sent again as the brief, not the cut caption twice', async () => {
    const f = setup();
    const { cut, rest } = cutCaption();
    const { parts } = await f.album(cut);
    await f.settle(parts[5]);
    const whole = `${cut}${rest}`;
    const opened = await f.intake(f.text(whole), { briefHold: true });
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: whole } });
    expect(await f.settle(parts[5])).toMatchObject({ settle: 'skipped' });
    expect(await f.opens()).toBe(1);
  });
});

describe('caption limit helpers (ADR-148)', () => {
  it('never shows a title that quotes the line introducing the copy as the English headline', () => {
    expect(titleAsHeadline('KAAE: Here is the text and the photos:…')).toBeUndefined();
    expect(titleAsHeadline('KAAE: دەقەکە:…')).toBeUndefined();
    expect(titleAsHeadline(`KAAE: ${TITLE}…`)).toBe(`KAAE: ${TITLE}…`);
    expect(titleAsHeadline('Launch poster')).toBe('Launch poster');
  });

  it('counts the caption as Telegram does, in UTF-16 units', () => {
    expect(captionMayBeCut('a'.repeat(1023))).toBe(false);
    expect(captionMayBeCut('a'.repeat(1024))).toBe(true);
    // An emoji outside the basic plane is two units: 1022 letters and one emoji reach the limit.
    expect(captionMayBeCut(`${'a'.repeat(1022)}\u{1F4F7}`)).toBe(true);
    expect(captionMayBeCut(`${'ب'.repeat(1023)}`)).toBe(false);
    expect(captionMayBeCut(undefined)).toBe(false);
  });

  it('drops the cut last line, or the cut last sentence of a one-line caption', () => {
    expect(withoutCutLine('Poster for KAAE\nAnnual Report\nInsights from the fie')).toBe('Poster for KAAE\nAnnual Report');
    expect(withoutCutLine('Make a poster. Use navy. Put the title on to')).toBe('Make a poster. Use navy.');
    expect(withoutCutLine('one unbroken run of words with no end')).toBe('');
  });

  it('joins the rest after a newline, and replaces a cut line or caption the requester sent again', () => {
    expect(joinCutCaption('Poster\nTitle line\nNext steps tow', 'ard a better future')).toBe('Poster\nTitle line\nNext steps tow\nard a better future');
    expect(joinCutCaption('Poster\nTitle line\nNext steps toward a bet', 'Next steps toward a better future'))
      .toBe('Poster\nTitle line\nNext steps toward a better future');
  });
});
