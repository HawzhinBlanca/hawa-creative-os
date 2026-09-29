/**
 * ADR-143: an album starts its design by itself once it has settled, a natural brief binds a waiting
 * album, and an album with no words is asked about. Worker intake route against the per-file
 * database; the worker's durable settle is modelled by calling intake again with `settle: true`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { settleAlbum, isAffirmativeOnly, isBriefText, ALBUM_TEXT } from '../src/services/lifecycle-album.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const userId = '00000000-0000-4000-b000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const scope = { tenantId, userId, role: 'operator' as const };
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const token = ['album', 'settle', 'fixture', 'token'].join('_');
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
let id = 830_000_000;
const photo = (n: number) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'), Buffer.from([n])]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await db.destroy(); await owner.destroy(); });

/** The owner's brief of 2026-09-29, in shape: a report cover with its exact copy under a divider. */
const BRIEF = 'KAAE annual report cover\n---\nAnnual Report 2026\nKurdistan Accreditation Agency for Education\nErbil';
const SENDER = 91000017;

function setup(options: { languageCode?: string } = {}) {
  const chat = ++id;
  vi.stubEnv('HAWA_WORKER_TOKEN', token);
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '100000');
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '10000');
  const download = vi.fn(async (file: string) => photo(Number(file)));
  const bridge = { downloadFile: download, dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
  const app = createApp({ db, telegramBridge: bridge } as any);
  const from = { id: SENDER, first_name: 'Requester', ...(options.languageCode ? { language_code: options.languageCode } : {}) };
  const group = `album-${chat}`;
  const part = (messageId: number, file: number, caption?: string, reply?: number) => ({
    update_id: ++id, message: { message_id: messageId, date: 1790000000, from, chat: { id: chat, type: 'private' },
      media_group_id: group, photo: [{ file_id: String(file) }],
      ...(caption ? { caption } : {}), ...(reply ? { reply_to_message: { message_id: reply } } : {}) },
  });
  const text = (words: string, reply?: number) => ({ update_id: ++id, message: { message_id: ++id, date: 1790000000, from,
    chat: { id: chat, type: 'private' }, text: words, ...(reply ? { reply_to_message: { message_id: reply } } : {}) } });
  const intake = async (update: unknown, extra: { settle?: boolean; briefHold?: boolean } = {}, target = app) => {
    const res = await target.request('/v1/internal/telegram/intake', { method: 'POST', headers,
      body: JSON.stringify({ v: 1, mode: 'legacy', update, languageSiblings: true, ...extra }) });
    expect(res.status).toBe(200);
    return await res.json();
  };
  const settle = (update: unknown, target = app) => intake(update, { settle: true, briefHold: true }, target);
  const tasks = () => withRlsContext(db, scope, async (trx) => (await sql<{ task_id: string }>`
    SELECT aggregate_id::text AS task_id FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid
      AND command_type = 'task.created' AND payload->>'sourceChannelId' = ${String(chat)}`.execute(trx)).rows);
  const opens = () => withRlsContext(db, scope, async (trx) => (await sql<{ n: string }>`SELECT count(*) AS n
    FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_open'
      AND payload->>'chatId' = ${String(chat)}`.execute(trx)).rows[0].n).then(Number);
  const backdate = (interval: string) => sql`UPDATE hawa.inbox_events SET received_at = received_at - ${interval}::interval
    WHERE tenant_id = ${tenantId}::uuid AND payload->>'chatId' = ${String(chat)}
      AND source_account_id IN ('lifecycle_album_part', 'lifecycle_album_pending', 'lifecycle_brief_held')`.execute(owner);
  return { chat, part, text, intake, settle, tasks, opens, app, download, backdate, bridge };
}

async function project(app: ReturnType<typeof createApp>, decision: any) {
  return app.request(`/v1/internal/lifecycle/${decision.requestId}/project`, { method: 'POST', headers,
    body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${decision.requestId}:1:open`,
      ops: [{ kind: 'createRequest', draft: decision.draft }] }) });
}

/** Every answer the requester could be sent in this flow: none may name a command. */
const mentionsCommand = (answers: unknown[]) => answers.some((a) => /\/use_album|\/new/.test(JSON.stringify((a as any)?.albumMessage ?? '')));

describe('an album settles by itself (ADR-143)', () => {
  it('answers each saved photo with a settle, and only the newest photo\'s settle opens one request, once', async () => {
    const f = setup();
    const parts = [f.part(201, 1, BRIEF), f.part(202, 2), f.part(203, 3)];
    for (const p of parts) {
      expect(await f.intake(p, { briefHold: true })).toMatchObject({ intakeStatus: 202, lifecycleAction: 'settle-later',
        chatId: String(f.chat), settle: { kind: 'album', delayMs: 8000 } });
    }
    expect(await f.tasks()).toHaveLength(0);
    // The settles the first two photos scheduled find a newer photo and do nothing.
    expect(await f.settle(parts[0])).toMatchObject({ intakeStatus: 200, settle: 'skipped' });
    expect(await f.settle(parts[1])).toMatchObject({ settle: 'skipped' });
    const [a, b] = await Promise.all([f.settle(parts[2]), f.settle(parts[2])]);
    expect(a).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', draft: {
      rawText: expect.stringContaining('Annual Report 2026'),
      lifecycleAlbum: { updateId: parts[2].update_id, images: [1, 2, 3].map((n) => ({ sha256: sha(photo(n)) })) } } });
    expect(b.requestId).toBe(a.requestId);
    // A Core restarted after its answer was lost replays the stored decision.
    expect(await f.settle(parts[2], createApp({ db } as any))).toMatchObject({ duplicate: true, requestId: a.requestId, draft: a.draft });
    expect(await f.opens()).toBe(1);
    expect((await project(f.app, a)).status).toBe(200);
    expect((await project(f.app, a)).status).toBe(200);
    expect(await f.tasks()).toHaveLength(1);
    expect(f.download).toHaveBeenCalledTimes(3);
  });

  it('resumes a settle whose Core died after freezing the album and before deciding (restart during settle)', async () => {
    const f = setup();
    const parts = [f.part(201, 1, BRIEF), f.part(202, 2)];
    for (const p of parts) await f.intake(p);
    // What a Core killed at core.intake.after-album-settle leaves: the album frozen, no decision.
    const frozen = await withRlsContext(db, scope, (trx) => settleAlbum(trx, tenantId, parts[1] as any));
    expect(frozen.kind).toBe('snapshot');
    expect(await f.opens()).toBe(0);
    const decision = await f.settle(parts[1], createApp({ db } as any));
    expect(decision).toMatchObject({ lifecycleAction: 'open-request', draft: { lifecycleAlbum: { updateId: parts[1].update_id } } });
    expect(await f.settle(parts[1])).toMatchObject({ requestId: decision.requestId, duplicate: true });
    expect(await f.opens()).toBe(1);
  });

  it('keeps a photo arriving after the design started out of it and tells the requester what to do instead', async () => {
    const f = setup();
    const parts = [f.part(201, 1, BRIEF), f.part(202, 2)];
    for (const p of parts) await f.intake(p);
    const opened = await f.settle(parts[1]);
    expect((await project(f.app, opened)).status).toBe(200);
    const late = f.part(203, 3);
    const answer = await f.intake(late);
    expect(answer).toMatchObject({ intakeStatus: 422, lifecycleAction: 'album-message',
      albumMessage: ALBUM_TEXT.latePhoto.en, albumNoticeKey: `album-error:${late.update_id}` });
    expect(await f.settle(late)).toMatchObject({ settle: 'skipped' });
    expect(f.download).toHaveBeenCalledTimes(2);
    expect(await f.tasks()).toHaveLength(1);
    expect(opened.draft.lifecycleAlbum.images).toHaveLength(2);
  });

  it('asks one natural question for an album with no words; "yes" is asked again; a brief then opens with the photos', async () => {
    const f = setup();
    const parts = [f.part(201, 1), f.part(202, 2)];
    for (const p of parts) await f.intake(p, { briefHold: true });
    const question = await f.settle(parts[1]);
    expect(question).toMatchObject({ intakeStatus: 202, lifecycleAction: 'album-message',
      albumMessage: 'I have your 2 photos. What would you like me to design with them? Please tell me what it is for and the exact words to put on it.',
      albumNoticeKey: expect.stringMatching(/^album-question:[0-9a-f]{64}$/) });
    expect(await f.settle(parts[1])).toEqual(question);
    const yes = await f.intake(f.text('yes, use them'), { briefHold: true });
    expect(yes).toMatchObject({ intakeStatus: 202, lifecycleAction: 'album-message', albumMessage: ALBUM_TEXT.followUp.en });
    expect(await f.opens()).toBe(0);
    // A thanks is not a brief: intake answers it as before and the album keeps waiting.
    const thanks = await f.intake(f.text('thank you'), { briefHold: true });
    expect(thanks.lifecycleAction).not.toBe('open-request');
    const brief = f.text(BRIEF, 7777);
    const opened = await f.intake(brief, { briefHold: true });
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: expect.stringContaining('Annual Report 2026'),
      lifecycleAlbum: { updateId: brief.update_id, images: [1, 2].map((n) => ({ sha256: sha(photo(n)) })) } } });
    expect(await f.intake(brief, { briefHold: true })).toMatchObject({ duplicate: true, requestId: opened.requestId });
    expect((await project(f.app, opened)).status).toBe(200);
    expect(await f.tasks()).toHaveLength(1);
    expect(mentionsCommand([question, yes])).toBe(false);
  });

  it('asks in Sorani when the chat writes Sorani, and answers a Sorani OK in Sorani', async () => {
    const f = setup({ languageCode: 'ckb' });
    const parts = [f.part(201, 1), f.part(202, 2), f.part(203, 3)];
    for (const p of parts) await f.intake(p);
    const question = await f.settle(parts[2]);
    expect(question.albumMessage).toBe(ALBUM_TEXT.question(3, 'ckb'));
    expect(question.albumMessage.startsWith('٣ وێنەکەتم پێگەیشت.')).toBe(true);
    expect(await f.intake(f.text('بەڵێ'))).toMatchObject({ albumMessage: ALBUM_TEXT.followUp.ckb });
  });

  it('treats photos then a separate text brief as one request, and the album\'s own settle then does nothing', async () => {
    const f = setup();
    const parts = [f.part(201, 1), f.part(202, 2)];
    for (const p of parts) await f.intake(p, { briefHold: true });
    const brief = f.text(BRIEF);
    const opened = await f.intake(brief, { briefHold: true });
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { lifecycleAlbum: { updateId: brief.update_id } } });
    expect(await f.settle(parts[1])).toMatchObject({ settle: 'skipped' });
    expect(await f.opens()).toBe(1);
  });

  it('treats a text brief then photos as one request: the brief waits, the album settles with it, the brief\'s settle does nothing', async () => {
    const f = setup();
    const brief = f.text(BRIEF);
    const held = await f.intake(brief, { briefHold: true });
    expect(held).toMatchObject({ intakeStatus: 202, lifecycleAction: 'settle-later', settle: { kind: 'brief', delayMs: 15000 } });
    expect(await f.intake(brief, { briefHold: true })).toEqual(held);
    const parts = [f.part(301, 1), f.part(302, 2)];
    for (const p of parts) await f.intake(p, { briefHold: true });
    // The brief's settle comes while the album is still arriving: it waits for it.
    expect(await f.settle(brief)).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'brief' } });
    const opened = await f.settle(parts[1]);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: expect.stringContaining('Annual Report 2026'),
      lifecycleAlbum: { updateId: parts[1].update_id, images: [1, 2].map((n) => ({ sha256: sha(photo(n)) })) } } });
    expect(await f.settle(brief)).toMatchObject({ settle: 'skipped' });
    expect(await f.opens()).toBe(1);
    expect((await project(f.app, opened)).status).toBe(200);
    expect(await f.tasks()).toHaveLength(1);
  });

  it('opens a held brief with no photos after it at its settle, once', async () => {
    const f = setup();
    const brief = f.text(BRIEF);
    await f.intake(brief, { briefHold: true });
    expect(await f.opens()).toBe(0);
    const opened = await f.settle(brief);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: expect.stringContaining('Annual Report 2026') } });
    expect(opened.draft.lifecycleAlbum).toBeUndefined();
    expect(await f.settle(brief)).toMatchObject({ duplicate: true, requestId: opened.requestId });
    // A worker that does not schedule settles (briefHold absent) still gets an immediate open.
    const g = setup();
    expect(await g.intake(g.text(BRIEF))).toMatchObject({ lifecycleAction: 'open-request' });
  });

  it('keeps /use_album working without a reply to a photo, and never asks for it', async () => {
    const f = setup();
    const parts = [f.part(201, 1, BRIEF), f.part(202, 2)];
    for (const p of parts) await f.intake(p);
    const plain = f.text('/use_album');
    const opened = await f.intake(plain);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { lifecycleAlbum: { updateId: plain.update_id } } });
    expect(await f.settle(parts[1])).toMatchObject({ settle: 'skipped' });
    const again = await f.intake(f.text('/use_album'));
    expect(again).toMatchObject({ lifecycleAction: 'album-message', albumMessage: ALBUM_TEXT.noAlbum.en });
    expect(mentionsCommand([again])).toBe(false);
    expect(await f.opens()).toBe(1);
  });

  it('starts an album stored before ADR-143 (the owner\'s of 2026-09-29) from the sweep, exactly once, past its refused plain /use_album', async () => {
    const f = setup();
    const parts = [1, 2, 3, 4, 5, 6].map((n) => f.part(200 + n, n, n === 1 ? BRIEF : undefined));
    for (const p of parts) await f.intake(p);
    // The plain /use_album refused by the previous release, as it stored it.
    const oldConfirm = f.text('/use_album');
    await withRlsContext(db, scope, (trx) => sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id,
        source_event_id, event_kind, payload, payload_hash, verified)
      VALUES (${tenantId}::uuid, 'lifecycle_album_confirm', ${String(oldConfirm.update_id)}, 'lifecycle_album_confirm',
        ${JSON.stringify({ source: oldConfirm, chatId: String(f.chat), reply: { status: 422,
          message: 'Reply to a photo in the album with /use_album after all photos have finished sending.',
          noticeKey: `album-confirm:${oldConfirm.update_id}` } })}::jsonb,
        ${createHash('sha256').update(canonical(oldConfirm)).digest('hex')}, true)`.execute(trx));
    await f.backdate('3 hours');
    const sweep = async () => (await (await f.app.request('/v1/internal/telegram/settle-sweep', { method: 'POST', headers,
      body: JSON.stringify({ v: 1 }) })).json()).due.filter((d: any) => d.chatId === String(f.chat));
    const due = await sweep();
    expect(due).toEqual([{ chatId: String(f.chat), update: parts[5] }]);
    const opened = await f.settle(due[0].update);
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: expect.stringContaining('Annual Report 2026'),
      lifecycleAlbum: { images: parts.map((_, n) => ({ sha256: sha(photo(n + 1)) })) } } });
    expect(await sweep()).toEqual([]);
    expect(await f.settle(due[0].update)).toMatchObject({ duplicate: true, requestId: opened.requestId });
    // The old refusal still replays as it was answered; it starts nothing.
    expect(await f.intake(oldConfirm)).toMatchObject({ intakeStatus: 422, lifecycleAction: 'album-message' });
    expect((await project(f.app, opened)).status).toBe(200);
    expect(await f.tasks()).toHaveLength(1);
    expect(await f.opens()).toBe(1);
  });

  it('starts nothing from an overdue album once the chat has moved on, and lets an old album with no words lapse silently', async () => {
    const f = setup();
    const parts = [f.part(201, 1, BRIEF), f.part(202, 2)];
    for (const p of parts) await f.intake(p);
    await f.backdate('2 hours');
    const created = await persistChatIntake(db, { platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: String(f.chat),
      rawText: 'another brief', title: 'another brief', clientId, designInstructions: '', exactCopy: [{ text: 'x' }],
      autoGenerate: true, studioOptions: { tier: 'quality' } }, { outboxState: 'recorded' });
    await withRlsContext(db, scope, (trx) => sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id,
        current_task_id, owner, stage, rev, chat_id) VALUES (${randomUUID()}::uuid, ${tenantId}::uuid,
        ${String(created.task.id)}::uuid, ${String(created.task.id)}::uuid, 'restate', 'designing', 1, ${String(f.chat)})`.execute(trx));
    expect(await f.settle(parts[1])).toMatchObject({ settle: 'skipped' });
    expect(await f.opens()).toBe(0);
    const g = setup();
    const quiet = [g.part(201, 1), g.part(202, 2)];
    for (const p of quiet) await g.intake(p);
    await g.backdate('3 hours');
    expect(await g.settle(quiet[1])).toMatchObject({ settle: 'skipped' });
    expect(await g.intake(g.text(BRIEF), { briefHold: true })).toMatchObject({ lifecycleAction: 'settle-later' });
  });

  it('never starts twice when the settle, a brief and /use_album race for one album', async () => {
    const f = setup();
    const parts = [f.part(201, 1, BRIEF), f.part(202, 2)];
    for (const p of parts) await f.intake(p);
    const answers = await Promise.all([f.settle(parts[1]), f.intake(f.text('/use_album')), f.settle(parts[1]),
      f.intake(f.text('/use_album'))]);
    // Racing answers may each say duplicate=false for the one stored decision; they name one request.
    const opened = answers.filter((a) => a.lifecycleAction === 'open-request');
    expect(opened.length).toBeGreaterThan(0);
    expect(new Set(opened.map((a) => a.requestId)).size).toBe(1);
    expect(answers.filter((a) => a.lifecycleAction !== 'open-request').every((a) =>
      a.settle === 'skipped' || a.lifecycleAction === 'album-message')).toBe(true);
    const frozen = await withRlsContext(db, scope, async (trx) => (await sql<{ n: string }>`SELECT count(*) AS n
      FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_album_frozen'
        AND source_event_id IN (SELECT payload->>'groupKey' FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid
          AND source_account_id = 'lifecycle_album_part' AND payload->>'chatId' = ${String(f.chat)})`.execute(trx)).rows[0].n);
    expect(Number(frozen)).toBe(1);
    expect(await f.opens()).toBe(1);
  });

  it('refuses nothing it should not: the photos of a revision reply start that revision at the settle', async () => {
    const f = setup();
    const requestId = randomUUID();
    const created = await persistChatIntake(db, { platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: String(f.chat),
      rawText: 'KAAE members evening', title: 'KAAE members evening', clientId, designInstructions: 'Make the approved design',
      exactCopy: [{ text: 'December 4, 2026' }], autoGenerate: true, studioOptions: { tier: 'quality' } }, { outboxState: 'recorded' });
    const taskId = String(created.task.id);
    await withRlsContext(db, scope, async (trx) => {
      await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, owner, stage, rev, chat_id)
        VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, 'restate', 'manual', 3, ${String(f.chat)})`.execute(trx);
      await trx.updateTable('tasks').set({ request_id: requestId }).where('id', '=', taskId).execute();
      await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
        VALUES (${tenantId}::uuid, 'telegram_delivery', ${`lc:${requestId}:3:office-revision-notify:send`}, 'telegram_message_sent',
          ${JSON.stringify({ messageId: '7002' })}::jsonb, 'test-sent-mark', true)`.execute(trx);
    });
    const parts = [f.part(201, 3, undefined, 7002), f.part(202, 4, undefined, 7002)];
    for (const p of parts) await f.intake(p);
    expect(await f.settle(parts[1])).toMatchObject({ lifecycleAction: 'requester-revision', requestId, priorTaskId: taskId });
  });
});

describe('what counts as a brief next to an album', () => {
  it('reads OKs as OKs and briefs as briefs', () => {
    for (const ok of ['yes', 'Yes please', 'ok', 'go ahead', 'use them', 'use these photos', 'done', '👍', 'بەڵێ', 'باشە تکایە'])
      expect(isAffirmativeOnly(ok), ok).toBe(true);
    for (const not of ['thank you', 'hi', 'yes, make a poster for the KAAE evening on 4 December', BRIEF])
      expect(isAffirmativeOnly(not), not).toBe(false);
    expect(isBriefText(BRIEF)).toBe(true);
    expect(isBriefText('/new ' + BRIEF)).toBe(true);
    for (const not of ['yes', 'thanks', 'hello', '/use_album']) expect(isBriefText(not), not).toBe(false);
  });
});

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
