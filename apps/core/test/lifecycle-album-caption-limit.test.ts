/**
 * ADR-160: Telegram keeps only the first 1024 UTF-16 units of a caption from a standard account. The
 * owner's six-photo album of 2026-09-29 had a caption of exactly 1024 characters, cut mid-sentence, and
 * the design shipped the cut sentence as its subtitle. A caption at the limit is never the whole brief:
 * the album waits for the rest, asked once in plain words, and the sender's next message joins it.
 *
 * The adversarial review of the first version (audit 2026-09-30 item 22) is kept here as regression
 * tests: what counts as the rest (F1), the wait (F2), which captions are cut (F4), what opens when the
 * rest never comes (F5), group chats (F6), the join (F7), a photo sent as the rest (F8), the wording
 * (F9), the task list's title (F10) and the wait against the worker's settle limit (F11); with the
 * intake audit's album sets (F8-albums), group media (F6-groups, item 14) and a stranger's video (S5).
 *
 * Worker intake route against the per-file database; the worker's durable settle is modelled by calling
 * intake again with `settle: true` (as lifecycle-album-settle.test.ts does).
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { ACCESS_MESSAGES, ALBUM_MESSAGES, TELEGRAM_CAPTION_LIMIT, say } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { titleAsHeadline } from '../src/routes/tasks.routes.js';
import { CUT_CAPTION_WAIT_MS, captionMayBeCut, captionTail, joinCutCaption, overdueSettles, readCutReply,
  withoutCutSentence } from '../src/services/lifecycle-album.js';
import { MAX_SETTLE_DELAY_MS } from '../../worker/src/lifecycle/core-client.js';

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

/** A caption of exactly `length` UTF-16 units whose last line is complete (`finished`: it ends a sentence). */
function captionOf(length: number, finished = false): string {
  const tail = `\n\n${INTRODUCER}\n\n${TITLE}\n${SUBTITLE}\n\n${SUPPORTING}${finished ? '.' : ''}`;
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
    if (/\p{L}$/u.test(cut) && /^\p{Ll}/u.test(full.slice(TELEGRAM_CAPTION_LIMIT))) return { cut, rest: full.slice(TELEGRAM_CAPTION_LIMIT) };
  }
  throw new Error('no mid-word cut found');
}

const SENDER = 91000031;
const MEMBER = 91000032;
const BOT = '@hawa_design_bot';

function setup(chatType: 'private' | 'group' = 'private') {
  const chat = ++id;
  vi.stubEnv('HAWA_WORKER_TOKEN', token);
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '100000');
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '10000');
  const download = vi.fn(async (file: string) => photo(Number(file)));
  const bridge = { downloadFile: download, dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
  const app = createApp({ db, telegramBridge: bridge } as any);
  const from = { id: SENDER, first_name: 'Requester' };
  const member = { id: MEMBER, first_name: 'Member' };
  let group = `caption-limit-${chat}`;
  /** In a group, words that start with the bot's name are addressed to it (a mention entity). */
  const mention = (words: string | undefined, key: 'entities' | 'caption_entities') =>
    words?.startsWith(BOT) ? { [key]: [{ type: 'mention', offset: 0, length: BOT.length }] } : {};
  const part = (messageId: number, file: number, caption?: string) => ({
    update_id: ++id, message: { message_id: messageId, date: 1790000000, from, chat: { id: chat, type: chatType },
      media_group_id: group, photo: [{ file_id: String(file) }], ...(caption ? { caption } : {}), ...mention(caption, 'caption_entities') },
  });
  const text = (words: string, who = from) => ({ update_id: ++id, message: { message_id: ++id, date: 1790000000, from: who,
    chat: { id: chat, type: chatType }, text: words, ...mention(words, 'entities') } });
  const captioned = (file: number, caption: string, who = from) => ({ update_id: ++id, message: { message_id: ++id, date: 1790000000,
    from: who, chat: { id: chat, type: chatType }, photo: [{ file_id: String(file) }], caption, ...mention(caption, 'caption_entities') } });
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
  const swept = async () => (await withRlsContext(db, scope, (trx) => overdueSettles(trx, tenantId)))
    .filter((d) => d.chatId === String(chat)).map((d) => d.update.update_id);
  /** Six photos (or `count`), the first carrying the caption; each answered as a saved photo is. */
  const album = async (caption: string | undefined, count = 6, first = 1) => {
    const parts = Array.from({ length: count }, (_, i) => part(200 + first + i, first + i, i === 0 ? caption : undefined));
    const answers: any[] = [];
    for (const p of parts) answers.push(await intake(p, { briefHold: true }));
    return { parts, answers };
  };
  /** A second album right after the first (Telegram splits more than ten photos). */
  const nextGroup = () => { group = `${group}-next`; };
  return { chat, part, text, captioned, intake, settle, tasks, opens, app, download, age, swept, album, nextGroup, member };
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
const question = (cut: string, lang: 'en' | 'ckb' = 'en') => say(ALBUM_MESSAGES.captionCut, lang, { tail: captionTail(cut) });

describe('a caption Telegram cut at its limit (ADR-160)', () => {
  it('holds a six-photo album whose caption is 1024 characters: no draft, one plain question quoting where the text stops', async () => {
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
      settle: { kind: 'album', delayMs: CUT_CAPTION_WAIT_MS }, notice: { text: question(cut) } });
    expect(asked.draft).toBeUndefined();
    const said = answers.flatMap(saidTo);
    expect(said).toEqual([question(cut)]);
    // F9: the last words that arrived are quoted back, and the whole text may be sent again.
    const tail = captionTail(cut);
    expect(tail.split(' ').length).toBeGreaterThanOrEqual(3);
    expect(cut.endsWith(tail)).toBe(true);
    expect(said[0]).toContain(`"…${tail}"`);
    expect(said[0]).toMatch(/the rest, or the whole text again/);
    expect(said[0]).not.toMatch(/\/\w|reply to|caption|1024/i);
    expect(await f.opens()).toBe(0);
    expect(await f.tasks()).toHaveLength(0);
    // The delayed settle comes back inside the wait: still waiting, and the question is the same
    // update's notice (ChatInbox sends a notice once per update), not a second message.
    const again = await f.settle(parts[5]);
    expect(again).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'album' }, notice: { text: question(cut) } });
    expect(again.settle.delayMs).toBeLessThanOrEqual(CUT_CAPTION_WAIT_MS);
    expect(await f.opens()).toBe(0);
    expect(f.download).toHaveBeenCalledTimes(6);
  });

  it('joins the next plain message where Telegram cut it: a word cut in two is whole again, and the headline is the title line', async () => {
    const f = setup();
    const { cut, rest } = cutCaption();
    const { parts } = await f.album(cut);
    await f.settle(parts[5]);
    const followUp = f.text(rest);
    const opened = await f.intake(followUp, { briefHold: true });
    // F7: no line break inside the cut word.
    expect(opened).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', chatId: String(f.chat), draft: {
      rawText: `${cut}${rest}`,
      lifecycleAlbum: { updateId: followUp.update_id, images: [1, 2, 3, 4, 5, 6].map((n) => ({ sha256: sha(photo(n)) })) } } });
    expect(opened.draft.rawText).toContain(SUPPORTING);
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

  it('takes the rest sent before the album settled, and the resent end of the text without doubling it', async () => {
    const f = setup();
    const { cut, rest } = cutCaption();
    const { parts } = await f.album(cut);
    // F7: the requester sends the last line again, whole, before the bot asked anything.
    const resent = `${SUPPORTING}\n\nDate: 5 October 2026`;
    expect(cut.endsWith(SUPPORTING.slice(0, SUPPORTING.length - rest.length))).toBe(true);
    const opened = await f.intake(f.text(resent), { briefHold: true });
    expect(opened).toMatchObject({ lifecycleAction: 'open-request' });
    expect(opened.draft.rawText).toBe(`${cut.slice(0, cut.lastIndexOf('\n') + 1)}${resent}`);
    expect(opened.draft.rawText.split(SUPPORTING.slice(0, 20)).length).toBe(2);
    expect(await f.settle(parts[5])).toMatchObject({ settle: 'skipped' });
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

  it('F9: asks again after an OK in fewer, different words; then, with no rest, opens without the unfinished sentence', async () => {
    const f = setup();
    const { cut } = cutCaption();
    const { parts } = await f.album(cut);
    await f.settle(parts[5]);
    const ok = await f.intake(f.text('ok'), { briefHold: true });
    const again = say(ALBUM_MESSAGES.captionCutAgain, 'en', { tail: captionTail(cut) });
    expect(ok).toMatchObject({ intakeStatus: 202, lifecycleAction: 'album-message', albumMessage: again });
    expect(again).not.toBe(question(cut));
    expect(again.length).toBeLessThan(question(cut).length);
    expect(await f.opens()).toBe(0);
    // No rest came within the wait: the poller's sweep lists the album, and its settle opens it
    // without the unfinished sentence (never copy), since what is left is still a brief.
    await f.age('11 minutes');
    expect(await f.swept()).toEqual([parts[5].update_id]);
    const opened = await f.settle(parts[5]);
    const kept = withoutCutSentence(cut);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: kept, lifecycleAlbum: { updateId: parts[5].update_id } } });
    const cutLine = cut.slice(cut.lastIndexOf('\n') + 1);
    expect(cutLine.length).toBeGreaterThan(10);
    expect(JSON.stringify(opened.draft)).not.toContain(cutLine);
    expect(headlineOf(opened.draft)).toBe(TITLE);
    expect(await f.settle(parts[5])).toMatchObject({ duplicate: true, requestId: opened.requestId });
    expect(await f.swept()).toEqual([]);
    expect(await f.opens()).toBe(1);
  });
});

describe('what counts as the rest (F1)', () => {
  it('"cancel" and "never mind, …" drop the held album and say so; nothing opens and nothing is swept', async () => {
    for (const words of ['cancel', 'never mind, wrong photos']) {
      const f = setup();
      const { cut, rest } = cutCaption();
      const { parts } = await f.album(cut);
      await f.settle(parts[5]);
      const cancelled = await f.intake(f.text(words), { briefHold: true });
      expect(cancelled).toMatchObject({ lifecycleAction: 'album-message', albumMessage: ALBUM_MESSAGES.captionCutCancelled.en });
      expect(cancelled.draft).toBeUndefined();
      // The album is closed: its settle does nothing, the sweep does not list it, the rest binds nothing.
      expect(await f.settle(parts[5])).toMatchObject({ settle: 'skipped' });
      await f.age('11 minutes');
      expect(await f.swept()).toEqual([]);
      const late = await f.intake(f.text(rest), { briefHold: true });
      expect(late.draft?.lifecycleAlbum).toBeUndefined();
      expect(await f.opens()).toBe(0);
    }
  });

  it('a greeting, a question, thanks or a status question is answered as usual and never joined; the rest still is', async () => {
    const f = setup();
    const { cut, rest } = cutCaption();
    const { parts } = await f.album(cut);
    await f.settle(parts[5]);
    for (const words of ['hello', 'what do you mean?', 'thanks', 'when will it be ready?']) {
      const answer = await f.intake(f.text(words), { briefHold: true });
      expect(answer.lifecycleAction).not.toBe('open-request');
      expect(answer.draft).toBeUndefined();
      expect(answer.albumMessage).toBeUndefined();
    }
    expect(await f.opens()).toBe(0);
    const opened = await f.intake(f.text(rest), { briefHold: true });
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: `${cut}${rest}` } });
  });

  it('"that\'s the whole text" opens the caption as it arrived', async () => {
    const f = setup();
    const caption = captionOf(TELEGRAM_CAPTION_LIMIT, true);
    const { parts } = await f.album(caption);
    expect(await f.settle(parts[5])).toMatchObject({ lifecycleAction: 'settle-later', notice: { text: question(caption) } });
    const opened = await f.intake(f.text("That's the whole text, nothing else"), { briefHold: true });
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: caption } });
  });

  it('reads the words by the requester-turn rules', () => {
    expect(readCutReply('cancel')).toBe('cancel');
    expect(readCutReply('never mind, wrong photos')).toBe('cancel');
    expect(readCutReply('ok')).toBe('ok');
    expect(readCutReply('go ahead')).toBe('ok');
    expect(readCutReply('hello')).toBe('other');
    expect(readCutReply('what do you mean?')).toBe('other');
    expect(readCutReply('thanks')).toBe('other');
    expect(readCutReply('when will it be ready?')).toBe('other');
    expect(readCutReply("That's the whole text, nothing else")).toBe('complete');
    expect(readCutReply('ard better learning for every pupil')).toBe('rest');
    expect(readCutReply('and next steps toward better learning for every pupil')).toBe('rest');
    expect(readCutReply(SUBTITLE)).toBe('rest');
  });
});

describe('the wait and what happens after it (F2, F5)', () => {
  it('F2: the rest sent after the wait is not joined; the settle opens what is left of the caption', async () => {
    const f = setup();
    const { cut, rest } = cutCaption();
    const { parts } = await f.album(cut);
    await f.settle(parts[5]);
    await f.age('11 minutes');
    const late = await f.intake(f.text(rest), { briefHold: true });
    expect(late.draft?.lifecycleAlbum).toBeUndefined();
    const opened = await f.settle(parts[5]);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: withoutCutSentence(cut) } });
  });

  it('F2/F5: a caption with no finished sentence lapses at the end of the wait, says so, and an unrelated brief later opens alone', async () => {
    const f = setup();
    const LINE = 'We need a formal report cover with the photos in a clean collage and navy and yellow brand colours please and thank you ';
    const caption = LINE.repeat(20).slice(0, 1024);
    const { parts } = await f.album(caption);
    await f.settle(parts[5]);
    await f.age('11 minutes');
    expect(await f.swept()).toEqual([parts[5].update_id]);
    const lapsed = await f.settle(parts[5]);
    expect(lapsed).toMatchObject({ lifecycleAction: 'album-message', albumMessage: ALBUM_MESSAGES.captionCutLapsed.en });
    expect(await f.settle(parts[5])).toMatchObject({ albumMessage: ALBUM_MESSAGES.captionCutLapsed.en });
    expect(await f.swept()).toEqual([]);
    await f.age('20 minutes');
    const brief = f.text('Please design an Instagram post for our Friday open day at the Erbil office, 4pm, with our logo');
    // The brief waits for photos sent right after it (ADR-143), then opens alone.
    let opened = await f.intake(brief, { briefHold: true });
    if (opened.lifecycleAction === 'settle-later') opened = await f.settle(brief);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: brief.message.text } });
    const decisions = await withRlsContext(db, scope, async (trx) => (await sql<{ draft: any }>`SELECT payload->'draft' AS draft
      FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_open'
        AND payload->>'chatId' = ${String(f.chat)}`.execute(trx)).rows);
    for (const { draft } of decisions) {
      expect(draft.lifecycleAlbum).toBeUndefined();
      expect(draft.rawText.startsWith(caption)).toBe(false);
    }
  });

  it('F5: a short line then an unfinished paragraph is not a brief: the album lapses instead of opening with the line alone', async () => {
    const f = setup();
    const LINE = 'We need a formal report cover with the photos in a clean collage and navy and yellow brand colours please and thank you ';
    const caption = `KAAE\n${LINE.repeat(20)}`.slice(0, 1024);
    expect(withoutCutSentence(caption)).toBe('KAAE');
    const { parts } = await f.album(caption);
    await f.settle(parts[5]);
    await f.age('11 minutes');
    expect(await f.settle(parts[5])).toMatchObject({ lifecycleAction: 'album-message', albumMessage: ALBUM_MESSAGES.captionCutLapsed.en });
    expect(await f.opens()).toBe(0);
  });
});

describe('which captions were cut (F4)', () => {
  it('drafts a whole Premium caption over 1024 at once; holds one of exactly 4096, and one a few units short that stops mid-sentence', async () => {
    for (const [length, finished, held] of [[1500, false, false], [1019, false, false], [1023, true, false], [1022, false, true], [4096, false, true]] as const) {
      const f = setup();
      const caption = captionOf(length, finished);
      const { parts } = await f.album(caption, 2);
      const settled = await f.settle(parts[1]);
      if (held) expect(settled).toMatchObject({ lifecycleAction: 'settle-later', notice: { text: question(caption) } });
      else expect(settled).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: caption } });
    }
  });

  it('counts the caption as Telegram does, in UTF-16 units', () => {
    expect(captionMayBeCut('a'.repeat(1024))).toBe(true);
    expect(captionMayBeCut('a'.repeat(1025))).toBe(false);
    expect(captionMayBeCut(`${'a'.repeat(1499)}.`)).toBe(false);
    expect(captionMayBeCut('a'.repeat(4096))).toBe(true);
    expect(captionMayBeCut('a'.repeat(1023))).toBe(true);
    expect(captionMayBeCut(`${'a'.repeat(1022)}.`)).toBe(false);
    expect(captionMayBeCut('a'.repeat(1019))).toBe(false);
    // An emoji outside the basic plane is two units: 1022 letters and one emoji reach the limit.
    expect(captionMayBeCut(`${'a'.repeat(1022)}\u{1F4F7}`)).toBe(true);
    expect(captionMayBeCut(`${'ب'.repeat(1010)}.`)).toBe(false);
    expect(captionMayBeCut(undefined)).toBe(false);
  });
});

describe('group chats (F6, audit item 14)', () => {
  it('only the sender\'s own later request supersedes a cut album; the lapsed or superseded album is not swept again', async () => {
    // Another member's request after the album: the album still opens at the end of the wait.
    const f = setup('group');
    const { cut } = cutCaption();
    const addressed = `${BOT} ${cut}`.slice(0, 1024);
    const { parts } = await f.album(addressed);
    expect(await f.settle(parts[5])).toMatchObject({ lifecycleAction: 'settle-later', notice: { text: question(addressed) } });
    await f.age('11 minutes');
    const otherBrief = f.text(`${BOT} Please design a poster for the science fair on 12 October 2026 at the Erbil hall`, f.member);
    let other = await f.intake(otherBrief, { briefHold: true });
    if (other.lifecycleAction === 'settle-later') other = await f.settle(otherBrief);
    expect(other).toMatchObject({ lifecycleAction: 'open-request' });
    expect(other.draft.lifecycleAlbum).toBeUndefined();
    expect((await project(f.app, other)).status).toBe(200);
    const opened = await f.settle(parts[5]);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { lifecycleAlbum: { updateId: parts[5].update_id } } });

    // The sender's own request after the album: superseded, closed, and no longer swept.
    const g = setup('group');
    const second = await g.album(`${BOT} ${cut}`.slice(0, 1024));
    await g.settle(second.parts[5]);
    await g.age('11 minutes');
    const brief = g.text(`${BOT} Please design a poster for the science fair on 12 October 2026 at the Erbil hall`);
    let own = await g.intake(brief, { briefHold: true });
    if (own.lifecycleAction === 'settle-later') own = await g.settle(brief);
    expect(own).toMatchObject({ lifecycleAction: 'open-request' });
    expect(own.draft.lifecycleAlbum).toBeUndefined();
    expect((await project(g.app, own)).status).toBe(200);
    expect(await g.settle(second.parts[5])).toMatchObject({ settle: 'skipped' });
    expect(await g.swept()).toEqual([]);
    expect(await g.opens()).toBe(1);
  });

  it('F6-groups: an album, a photo with words, a voice note and a photo with no words that are not addressed to the bot start nothing and say nothing', async () => {
    const f = setup('group');
    const { parts } = await f.album(undefined, 3);
    const quiet = await f.settle(parts[2]);
    expect(quiet).toMatchObject({ settle: 'skipped' });
    expect(saidTo(quiet)).toEqual([]);
    // The sender's conversation not addressed to the bot binds nothing; words addressed to it bind the album.
    const unaddressed = await f.intake(f.text('these came out well, the hall looked great on the day'), { briefHold: true });
    expect(unaddressed.draft).toBeUndefined();
    expect(saidTo(unaddressed)).toEqual([]);
    const addressed = f.text(`${BOT} use these for the science fair poster, 12 October 2026 at the Erbil hall`);
    const bound = await f.intake(addressed, { briefHold: true });
    expect(bound).toMatchObject({ lifecycleAction: 'open-request', draft: { lifecycleAlbum: { updateId: addressed.update_id } } });

    const g = setup('group');
    const downloads = g.download.mock.calls.length;
    const photoWithWords = await g.intake(g.captioned(40, 'the hall looked great on the day'), { briefHold: true });
    expect(photoWithWords).toMatchObject({ intakeStatus: 200, status: 'MESSAGE_ONLY' });
    expect(saidTo(photoWithWords)).toEqual([]);
    const voice = await g.intake({ update_id: ++id, message: { message_id: ++id, date: 1790000000, from: { id: SENDER, first_name: 'R' },
      chat: { id: g.chat, type: 'group' }, voice: { file_id: 'voice-1', duration: 3, mime_type: 'audio/ogg' } } }, { briefHold: true });
    expect(voice).toMatchObject({ intakeStatus: 200, status: 'MESSAGE_ONLY' });
    expect(saidTo(voice)).toEqual([]);
    expect(g.download.mock.calls.length).toBe(downloads);
    // A photo with no words is kept quietly for its sender's words to the bot; its settle says nothing.
    const bare = { update_id: ++id, message: { message_id: ++id, date: 1790000000, from: { id: SENDER, first_name: 'R' },
      chat: { id: g.chat, type: 'group' }, photo: [{ file_id: '41' }] } };
    expect(await g.intake(bare, { briefHold: true })).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'photo' } });
    const settledBare = await g.settle(bare);
    expect(saidTo(settledBare)).toEqual([]);
    expect(settledBare.lifecycleAction).toBeUndefined();
    expect(await g.opens()).toBe(0);
  });
});

describe('a photo or a second album (F8, F8-albums)', () => {
  it('F8: a photo with words sent as the rest joins the caption and the album: one request with seven photos', async () => {
    const f = setup();
    const { cut, rest } = cutCaption();
    const { parts } = await f.album(cut);
    await f.settle(parts[5]);
    const extra = f.captioned(7, rest);
    const opened = await f.intake(extra, { briefHold: true });
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: `${cut}${rest}`,
      lifecycleAlbum: { updateId: extra.update_id, images: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ sha256: sha(photo(n)) })) } } });
    expect(await f.intake(extra, { briefHold: true })).toMatchObject({ duplicate: true, requestId: opened.requestId });
    expect(await f.settle(parts[5])).toMatchObject({ settle: 'skipped' });
    expect(await f.opens()).toBe(1);
    expect((await project(f.app, opened)).status).toBe(200);
    expect(await f.tasks()).toHaveLength(1);
  });

  it('F8-albums: two albums in a row are one set: asked about once, and the brief binds every photo', async () => {
    const f = setup();
    const first = await f.album(undefined, 10, 1);
    f.nextGroup();
    const second = await f.album(undefined, 3, 11);
    // The first album's settle finds the second; only the set's newest photo asks, once, for all 13.
    const early = await f.settle(first.parts[9]);
    expect(early).toMatchObject({ settle: 'skipped' });
    expect(saidTo(early)).toEqual([]);
    const asked = await f.settle(second.parts[2]);
    expect(asked).toMatchObject({ lifecycleAction: 'album-message' });
    expect(asked.albumMessage).toContain('13 photos');
    expect(await f.settle(first.parts[9])).toMatchObject({ settle: 'skipped' });
    const brief = f.text('Please design a report cover for KAAE with all these photos\n---\nKAAE K-12 Pilot Study\nField Visit Report');
    const opened = await f.intake(brief, { briefHold: true });
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { lifecycleAlbum: {
      images: Array.from({ length: 13 }, (_, i) => ({ sha256: sha(photo(i + 1)) })) } } });
    expect(await f.opens()).toBe(1);
    await f.age('2 minutes');
    expect(await f.swept()).toEqual([]);
    expect((await project(f.app, opened)).status).toBe(200);
  });
});

describe('a stranger\'s video (audit S5)', () => {
  it('is refused before anything of it is recorded', async () => {
    const f = setup();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TELEGRAM_INTAKE_ALLOWED_USERS', String(MEMBER));
    const app = createApp({ db, telegramBridge: { downloadFile: vi.fn(), dispatchOutboundMessage: vi.fn(async () => ({ success: true })) } } as any);
    const stranger = 55_100_001;
    const video = { update_id: ++id, message: { message_id: ++id, date: 1790000000, from: { id: stranger, first_name: 'S' },
      chat: { id: f.chat, type: 'private' }, video: { file_id: 'clip', duration: 4 } } };
    const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers,
      body: JSON.stringify({ v: 1, mode: 'legacy', update: video, languageSiblings: true }) });
    expect(await res.json()).toMatchObject({ intakeStatus: 403, code: 'SENDER_NOT_ALLOWED', chatAnswer: { text: ACCESS_MESSAGES.notAllowed.en } });
    const rows = (await sql<{ source_account_id: string }>`SELECT source_account_id FROM hawa.inbox_events
      WHERE tenant_id = ${tenantId}::uuid AND (payload->>'chatId' = ${String(f.chat)} OR source_event_id = ${String(video.update_id)}
        OR source_event_id LIKE ${`${f.chat}:%`})`.execute(owner)).rows;
    expect(rows.map((r) => r.source_account_id)).toEqual(['lifecycle_unlisted_reply']);
  });
});

describe('Sorani (F9)', () => {
  it('asks a Sorani requester in Sorani, quoting where the text stops', async () => {
    const f = setup();
    const caption = 'تکایە بەرگێکی ڕاپۆرت بۆ کەی ئەی ئەی ئی دیزاین بکە بە وێنەکانەوە و ڕەنگی شین و زەرد. '.repeat(20).slice(0, 1024);
    const { parts } = await f.album(caption, 2);
    const asked = await f.settle(parts[1]);
    expect(asked).toMatchObject({ notice: { text: question(caption, 'ckb') } });
    expect(asked.notice.text).toContain(`«…${captionTail(caption)}»`);
  });
});

describe('caption limit helpers (ADR-160)', () => {
  it('F10: never shows a title that quotes the line introducing the copy as the English headline, with a client prefix or without', () => {
    expect(titleAsHeadline('KAAE: Here is the text and the photos:…')).toBeUndefined();
    expect(titleAsHeadline('Here is the text and the photos:…')).toBeUndefined();
    expect(titleAsHeadline('KAAE: دەقەکە:…')).toBeUndefined();
    expect(titleAsHeadline(`KAAE: ${TITLE}…`)).toBe(`KAAE: ${TITLE}…`);
    expect(titleAsHeadline('Launch poster')).toBe('Launch poster');
  });

  it('F11: the wait is the worker\'s longest settle delay, so neither changes alone', () => {
    expect(CUT_CAPTION_WAIT_MS).toBe(MAX_SETTLE_DELAY_MS);
  });

  it('F5: trims only the unfinished sentence of the last line', () => {
    expect(withoutCutSentence('Poster for KAAE\nAnnual Report\nInsights from the fie')).toBe('Poster for KAAE\nAnnual Report');
    expect(withoutCutSentence('Poster for KAAE\nMake it navy. Put the title on to')).toBe('Poster for KAAE\nMake it navy.');
    expect(withoutCutSentence('Make a poster. Use navy. Put the title on to')).toBe('Make a poster. Use navy.');
    expect(withoutCutSentence('Poster for KAAE\nAnnual Report.')).toBe('Poster for KAAE\nAnnual Report.');
    expect(withoutCutSentence('one unbroken run of words with no end')).toBe('');
  });

  it('F7: joins where Telegram cut: the overlap once, a cut word whole, a cut sentence with a space, a finished one on its own line', () => {
    const cap = 'Instructions\nKAAE Pilot\nField Visit Report\nInsights and next steps tow';
    expect(joinCutCaption(cap, 'Field Visit Report\nInsights and next steps toward better learning'))
      .toBe('Instructions\nKAAE Pilot\nField Visit Report\nInsights and next steps toward better learning');
    expect(joinCutCaption(cap, 'toward better learning')).toBe(`${cap.slice(0, -3)}toward better learning`);
    expect(joinCutCaption('Poster\nTitle line\nNext steps tow', 'ard a better future')).toBe('Poster\nTitle line\nNext steps toward a better future');
    expect(joinCutCaption('Poster\nTitle line\nNext steps toward a bet', 'Next steps toward a better future'))
      .toBe('Poster\nTitle line\nNext steps toward a better future');
    expect(joinCutCaption('Poster\nWe visited schools in', 'Erbil and Duhok')).toBe('Poster\nWe visited schools in Erbil and Duhok');
    expect(joinCutCaption('Poster\nWe visited schools.', 'Date: 5 October')).toBe('Poster\nWe visited schools.\nDate: 5 October');
  });
});
