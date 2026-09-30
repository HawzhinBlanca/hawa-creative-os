/**
 * ADR-160 addendum: a photo burst. On 2026-09-30 at 12:16 UTC the owner sent the KAAE report-cover
 * request again, and Telegram delivered it as six separate photo messages with no media_group_id (photos
 * picked together with "group" off), about a second apart: five with no words (updates 641865931-935),
 * then one whose caption was exactly 1024 UTF-16 units, cut mid-sentence (641865936). The five were each
 * answered "Got the photo. Send me the text…" and never attached; the sixth opened a request with one
 * photo and the cut words, and a paid design started from it.
 *
 * Photos a sender sends outside an album within the album quiet period are one set, settled as an album
 * is (ADR-143/160): one answer at most, the caption from any photo, ADR-160's hold for a cut caption, the
 * held brief, the group gate. A burst of one photo is still ADR-145's lone photo; one whose caption was
 * cut is held too. Worker intake route against the per-file database; the worker's durable settle is
 * modelled by calling intake again with `settle: true` (as lifecycle-album-caption-limit.test.ts does).
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { ALBUM_MESSAGES, MEDIA_MESSAGES, TELEGRAM_CAPTION_LIMIT, say } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { CUT_CAPTION_WAIT_MS, captionTail, overdueSettles } from '../src/services/lifecycle-album.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const userId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId, role: 'operator' as const };
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const token = ['photo', 'burst', 'fixture', 'token'].join('_');
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
let id = 641_865_900;
const png = (n: number) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'), Buffer.from([n])]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await db.destroy(); await owner.destroy(); });

// The shape of the owner's caption, built from parts (no real person's words), as ADR-160's tests build it.
const INSTRUCTION = 'Design a formal report cover for KAAE with the supplied photos in a clean collage, navy and yellow brand colours, the logo near the top. ';
const TAIL = '\n\nHere is the text and the photos:\n\nKAAE K-12 Pilot Study\nField Visit Report\n\nInsights from school field visits and next steps toward better learning for every pupil';
/** The first 1024 units of a longer caption, cut mid-word, and the rest Telegram dropped. */
function cutCaption(): { cut: string; rest: string } {
  for (let extra = 30; extra < 80; extra++) {
    const length = TELEGRAM_CAPTION_LIMIT + extra;
    const room = length - TAIL.length;
    let head = INSTRUCTION.repeat(Math.ceil(room / INSTRUCTION.length) + 1).slice(0, room);
    if (head.endsWith(' ')) head = `${head.slice(0, -1)}.`;
    const full = head + TAIL;
    const cut = full.slice(0, TELEGRAM_CAPTION_LIMIT);
    if (/\p{L}$/u.test(cut) && /^\p{Ll}/u.test(full.slice(TELEGRAM_CAPTION_LIMIT))) return { cut, rest: full.slice(TELEGRAM_CAPTION_LIMIT) };
  }
  throw new Error('no mid-word cut found');
}
const BRIEF = 'KAAE members evening\n---\nDecember 4, 2026\nErbil';
const SENDER = 91000041;

function setup(chatType: 'private' | 'group' = 'private') {
  const chat = ++id;
  vi.stubEnv('HAWA_WORKER_TOKEN', token);
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '100000');
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '10000');
  const download = vi.fn(async (file: string) => png(Number(file)));
  const app = createApp({ db, telegramBridge: { downloadFile: download, dispatchOutboundMessage: vi.fn(async () => ({ success: true })) } } as any);
  const from = { id: SENDER, first_name: 'Requester' };
  /** A photo outside an album (no media_group_id), as Telegram delivers a burst: one message per photo. */
  const photo = (file: number, caption?: string) => ({ update_id: ++id, message: { message_id: ++id, date: 1790000000, from,
    chat: { id: chat, type: chatType }, photo: [{ file_id: String(file), width: 1280, height: 960 }], ...(caption ? { caption } : {}) } });
  const text = (words: string) => ({ update_id: ++id, message: { message_id: ++id, date: 1790000001, from,
    chat: { id: chat, type: chatType }, text: words } });
  const intake = async (update: unknown, extra: { settle?: boolean; briefHold?: boolean } = {}) => {
    const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers,
      body: JSON.stringify({ v: 1, mode: 'lifecycle', update, languageSiblings: true, ...extra }) });
    expect(res.status).toBe(200);
    return await res.json();
  };
  /** The production worker: every update says it schedules settles (`briefHold`). */
  const send = (update: unknown) => intake(update, { briefHold: true });
  const settle = (update: unknown) => intake(update, { settle: true, briefHold: true });
  /** The photos arrive 0.1 s apart, as the burst did; then each photo's delayed settle runs, oldest first. */
  const burst = async (updates: Array<{ update_id: number }>) => {
    const answers: any[] = [];
    for (const u of updates) { answers.push(await send(u)); await pause(100); }
    for (const u of updates) answers.push(await settle(u));
    return answers;
  };
  const opens = () => withRlsContext(db, scope, async (trx) => (await sql<{ n: string }>`SELECT count(*) AS n
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_open'
      AND payload->>'chatId' = ${String(chat)}`.execute(trx)).rows[0].n).then(Number);
  const tasks = () => withRlsContext(db, scope, async (trx) => (await sql<{ task_id: string }>`
    SELECT aggregate_id::text AS task_id FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid
      AND command_type = 'task.created' AND payload->>'sourceChannelId' = ${String(chat)}`.execute(trx)).rows);
  /** Moves everything this chat's photos left behind back in time, as if sent `interval` earlier. */
  const age = (interval: string) => sql`UPDATE hawa.inbox_events SET received_at = received_at - ${interval}::interval
    WHERE tenant_id = ${tenantId}::uuid AND payload->>'chatId' = ${String(chat)}
      AND source_account_id IN ('lifecycle_album_part', 'lifecycle_album_pending', 'lifecycle_photo_held')`.execute(owner);
  return { chat, photo, text, intake, send, settle, burst, opens, tasks, age, app, download };
}

async function project(app: ReturnType<typeof createApp>, decision: any) {
  return app.request(`/v1/internal/lifecycle/${decision.requestId}/project`, { method: 'POST', headers,
    body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${decision.requestId}:1:open`,
      ops: [{ kind: 'createRequest', draft: decision.draft }] }) });
}

/** What the requester would be sent for an answer: its album notice, chat answer or words beside it. */
const saidTo = (answer: any): string[] =>
  [answer?.albumMessage, answer?.chatAnswer?.text, answer?.notice?.text, answer?.sourceMessage].filter((t): t is string => typeof t === 'string' && t.length > 0);
const question = (cut: string) => say(ALBUM_MESSAGES.captionCut, 'en', { tail: captionTail(cut) });
const images = (files: number[]) => files.map((n) => ({ sha256: sha(png(n)) }));

describe('the 2026-09-30 incident: six photos outside an album, the last with a caption cut at 1024 units', () => {
  it('gives one question quoting where the text stops, opens nothing, then one request with all six photos and the whole text', async () => {
    const f = setup();
    const { cut, rest } = cutCaption();
    expect(cut.length).toBe(1024);
    const photos = [1, 2, 3, 4, 5].map((n) => f.photo(n));
    photos.push(f.photo(6, cut));
    const answers = await f.burst(photos);
    // One outgoing message for the whole burst: ADR-160's question, quoting the last words received.
    expect(answers.flatMap(saidTo)).toEqual([question(cut)]);
    expect(question(cut)).toContain(`"…${captionTail(cut)}"`);
    expect(answers.some((a) => a.lifecycleAction === 'open-request' || a.draft)).toBe(false);
    expect(answers.flatMap(saidTo)).not.toContain(MEDIA_MESSAGES.photoHeld.en);
    expect(await f.opens()).toBe(0);
    expect(await f.tasks()).toHaveLength(0);
    // The question rides on the newest photo's settle, which then waits for the rest (ADR-160).
    expect(answers.at(-1)).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'album', delayMs: CUT_CAPTION_WAIT_MS } });
    // The rest, as a plain message: one request with the six photos, in the order sent, and the whole text.
    const followUp = f.text(rest);
    const opened = await f.send(followUp);
    expect(opened).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', chatId: String(f.chat), draft: {
      rawText: `${cut}${rest}`, lifecycleAlbum: { updateId: followUp.update_id, images: images([1, 2, 3, 4, 5, 6]) } } });
    expect(opened.draft.rawText).toContain('next steps toward better learning for every pupil');
    // Replays decide the same; the burst's own delayed settles do nothing more.
    expect(await f.send(followUp)).toMatchObject({ duplicate: true, requestId: opened.requestId });
    for (const p of photos) expect(saidTo(await f.settle(p))).toEqual([]);
    expect(await f.opens()).toBe(1);
    expect((await project(f.app, opened)).status).toBe(200);
    expect(await f.tasks()).toHaveLength(1);
    expect(f.download).toHaveBeenCalledTimes(6);
  });

  it('holds the burst the same way when the cut caption is on the first photo', async () => {
    const f = setup();
    const { cut, rest } = cutCaption();
    const photos = [f.photo(1, cut), ...[2, 3, 4, 5, 6].map((n) => f.photo(n))];
    const answers = await f.burst(photos);
    expect(answers.flatMap(saidTo)).toEqual([question(cut)]);
    expect(await f.opens()).toBe(0);
    const opened = await f.send(f.text(rest));
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: `${cut}${rest}`,
      lifecycleAlbum: { images: images([1, 2, 3, 4, 5, 6]) } } });
  });
});

describe('photo bursts (ADR-160 addendum)', () => {
  it('a burst of three with a short caption opens one request with the three photos once it settles', async () => {
    const f = setup();
    const photos = [f.photo(11), f.photo(12, BRIEF), f.photo(13)];
    const arrived: any[] = [];
    for (const p of photos) { arrived.push(await f.send(p)); await pause(100); }
    for (const a of arrived) expect(a).toMatchObject({ intakeStatus: 202, lifecycleAction: 'settle-later', settle: { kind: 'photo' } });
    expect(arrived.flatMap(saidTo)).toEqual([]);
    expect(await f.settle(photos[0])).toMatchObject({ settle: 'skipped' });
    expect(await f.settle(photos[1])).toMatchObject({ settle: 'skipped' });
    const opened = await f.settle(photos[2]);
    expect(opened).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', draft: {
      rawText: BRIEF, lifecycleAlbum: { updateId: photos[2].update_id, images: images([11, 12, 13]) } } });
    expect(saidTo(opened)).toEqual([]);
    expect(await f.settle(photos[2])).toMatchObject({ duplicate: true, requestId: opened.requestId });
    expect(await f.opens()).toBe(1);
  });

  it('a lone photo with no words is still asked about once, and a lone captioned photo opens with its photo', async () => {
    const f = setup();
    const shot = f.photo(21);
    expect(await f.send(shot)).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'photo' } });
    const asked = await f.settle(shot);
    expect(saidTo(asked)).toEqual([MEDIA_MESSAGES.photoHeld.en]);
    expect(saidTo(await f.settle(shot))).toEqual([MEDIA_MESSAGES.photoHeld.en]);
    // The sender's words then take the kept photo (ADR-145), as before.
    const words = f.text(BRIEF);
    const opened = await f.intake(words);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { lifecycleImage: { sha256: sha(png(21)), updateId: words.update_id } } });

    const g = setup();
    const captioned = g.photo(22, BRIEF);
    expect(await g.send(captioned)).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'photo' } });
    const photoBrief = await g.settle(captioned);
    expect(photoBrief).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: BRIEF,
      lifecycleImage: { sha256: sha(png(22)), updateId: captioned.update_id } } });
    expect(photoBrief.draft.lifecycleAlbum).toBeUndefined();
    expect(await g.settle(captioned)).toMatchObject({ duplicate: true, requestId: photoBrief.requestId });
    expect(await g.opens()).toBe(1);
  });

  it('a lone photo whose caption was cut at the limit is held and asked about, then opens with the whole text', async () => {
    const f = setup();
    const { cut, rest } = cutCaption();
    const shot = f.photo(31, cut);
    expect(saidTo(await f.send(shot))).toEqual([]);
    const asked = await f.settle(shot);
    expect(asked).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'album' } });
    expect(saidTo(asked)).toEqual([question(cut)]);
    expect(await f.opens()).toBe(0);
    const followUp = f.text(rest);
    const opened = await f.send(followUp);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: `${cut}${rest}`,
      lifecycleImage: { sha256: sha(png(31)), updateId: followUp.update_id } } });
    expect(opened.draft.lifecycleAlbum).toBeUndefined();
    expect(await f.send(followUp)).toMatchObject({ duplicate: true, requestId: opened.requestId });
    expect(await f.settle(shot)).toMatchObject({ settle: 'skipped' });
    expect(await f.opens()).toBe(1);
  });

  it('two bursts two minutes apart stay two sets: each asked about once, and words take the newer', async () => {
    const f = setup();
    const first = [f.photo(41), f.photo(42)];
    const firstAnswers = await f.burst(first);
    expect(firstAnswers.flatMap(saidTo)).toEqual([say(ALBUM_MESSAGES.question, 'en', { count: 2 })]);
    await f.age('2 minutes');
    const second = [f.photo(43), f.photo(44), f.photo(45)];
    const secondAnswers = await f.burst(second);
    expect(secondAnswers.flatMap(saidTo)).toEqual([say(ALBUM_MESSAGES.question, 'en', { count: 3 })]);
    const opened = await f.send(f.text(BRIEF));
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { lifecycleAlbum: { images: images([43, 44, 45]) } } });
    expect(await f.opens()).toBe(1);
  });

  it('a burst sent right after a brief is that design\'s material: one answer, every photo added', async () => {
    const f = setup();
    const opened = await f.intake(f.text(BRIEF));
    expect(opened).toMatchObject({ lifecycleAction: 'open-request' });
    expect((await project(f.app, opened)).status).toBe(200);
    const answers = await f.burst([f.photo(51), f.photo(52), f.photo(53)]);
    const said = answers.flatMap(saidTo);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Got the photos\. I've added them to /);
    const [task] = await f.tasks();
    const files = (await sql<{ sha256: string }>`SELECT sha256 FROM hawa.task_files WHERE task_id = ${task.task_id}::uuid`.execute(owner)).rows;
    expect(files.map((r) => r.sha256).sort()).toEqual([51, 52, 53].map((n) => sha(png(n))).sort());
    expect(await f.opens()).toBe(1);
  });

  it('a burst with change words for a design being made adds its photos and keeps the words for the office', async () => {
    const f = setup();
    const opened = await f.intake(f.text(BRIEF));
    expect((await project(f.app, opened)).status).toBe(200);
    const answers = await f.burst([f.photo(56), f.photo(57, 'use these logos')]);
    const said = answers.flatMap(saidTo);
    expect(said).toHaveLength(1);
    // Read as an album with words (ADR-156): a change for the design being made, kept for the office.
    expect(answers.at(-1)).toMatchObject({ lifecycleAction: 'late-change', intent: 'change', requestId: opened.requestId });
    const [task] = await f.tasks();
    const files = (await sql<{ sha256: string }>`SELECT sha256 FROM hawa.task_files WHERE task_id = ${task.task_id}::uuid`.execute(owner)).rows;
    expect(files.map((r) => r.sha256).sort()).toEqual([56, 57].map((n) => sha(png(n))).sort());
    expect(await f.opens()).toBe(1);
  });

  it('a brief sent just before a burst takes all of its photos', async () => {
    const f = setup();
    const brief = f.text(BRIEF);
    expect(await f.send(brief)).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'brief' } });
    const photos = [f.photo(61), f.photo(62), f.photo(63)];
    const answers = await f.burst(photos);
    const opened = answers.find((a) => a.lifecycleAction === 'open-request');
    expect(opened).toMatchObject({ draft: { rawText: BRIEF, lifecycleAlbum: { images: images([61, 62, 63]) } } });
    expect(await f.settle(brief)).toMatchObject({ settle: 'skipped' });
    expect(await f.opens()).toBe(1);
  });

  it('in a group, a burst addressed to no one says nothing and starts nothing', async () => {
    const f = setup('group');
    const answers = await f.burst([f.photo(71), f.photo(72), f.photo(73)]);
    expect(answers.flatMap(saidTo)).toEqual([]);
    expect(await f.opens()).toBe(0);
  });

  it('a burst whose settle was lost is listed by the sweep once, and settles to one question', async () => {
    const f = setup();
    const photos = [f.photo(81), f.photo(82)];
    for (const p of photos) await f.send(p);
    await f.age('3 minutes');
    const due = (await withRlsContext(db, scope, (trx) => overdueSettles(trx, tenantId)))
      .filter((d) => d.chatId === String(f.chat)).map((d) => d.update.update_id);
    expect(due).toContain(photos[1].update_id);
    const said: string[] = [];
    for (const updateId of due) said.push(...saidTo(await f.settle(photos.find((p) => p.update_id === updateId))));
    expect(said).toEqual([say(ALBUM_MESSAGES.question, 'en', { count: 2 })]);
  });
});
