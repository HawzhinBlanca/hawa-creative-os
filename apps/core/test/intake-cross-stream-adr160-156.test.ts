/**
 * Items the caption-limit stream (ADR-160) and the natural-language intake stream (ADR-156) handed to
 * each other, and the intake office alerts ADR-155 handed off, as regression tests on the merged intake:
 *
 * - F11 (ADR-156 P3): a JPEG sent as a file labelled `image/jpg` is a picture;
 * - a brief Telegram split into several messages, followed by an album, opens one request with all of
 *   its copy (ADR-156 #10 joined parts, taken by ADR-143's album settle);
 * - F8 remainder (ADR-160): a voice note sent as the rest of a caption Telegram cut joins that album once
 *   its words are confirmed, instead of opening a second request;
 * - ADR-155 section 6 at intake: an office alert reaches every office member, also when the first member
 *   is the requester.
 *
 * Worker intake route against the per-file database, as lifecycle-album-caption-limit.test.ts and
 * lifecycle-voice.test.ts run it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { TELEGRAM_CAPTION_LIMIT } from '@hawa/integrations';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { lifecycleStillImageFile } from '../src/services/lifecycle-photo.js';
import { overdueSettles } from '../src/services/lifecycle-album.js';
import { parkTelegramUpdate } from '../src/services/polled-update-dispatch.js';
import { officeChatsFor, withOfficeAlerts } from '../src/services/office-chats.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const userId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId, role: 'operator' as const };
const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const token = ['cross', 'stream', 'fixture', 'token'].join('_');
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
const audio = await readFile(new URL('../../../packages/testkit/fixtures/voice/silence-one-second.ogg', import.meta.url));
const photo = (n: number) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'), Buffer.from([n])]);
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
let id = 880_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await db.destroy(); await owner.destroy(); });
beforeEach(() => {
  vi.stubEnv('HAWA_WORKER_TOKEN', token);
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_GLOBAL', '100000');
  vi.stubEnv('AUTO_GENERATE_DAILY_CAP_PER_SENDER', '10000');
});

const SENDER = 91000071;

function setup(chat = ++id) {
  const download = vi.fn(async (file: string) => file.startsWith('voice') ? audio : photo(Number(file)));
  const bridge = { downloadFile: download, dispatchOutboundMessage: vi.fn(async () => ({ success: true })) };
  const app = createApp({ db, telegramBridge: bridge, requesterIntentModel: null } as any);
  const from = { id: SENDER, is_bot: false, first_name: 'Requester' };
  const group = `cross-stream-${chat}`;
  const part = (file: number, caption?: string) => ({ update_id: ++id, message: { message_id: ++id, date: 1790000000, from,
    chat: { id: chat, type: 'private' }, media_group_id: group, photo: [{ file_id: String(file) }], ...(caption ? { caption } : {}) } });
  const text = (words: string, fields: Record<string, unknown> = {}) => ({ update_id: ++id, message: { message_id: ++id, date: 1790000000,
    from, chat: { id: chat, type: 'private' }, text: words, ...fields } });
  const intake = async (update: unknown, extra: { settle?: boolean; briefHold?: boolean } = {}) => {
    const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers,
      body: JSON.stringify({ v: 1, mode: 'lifecycle', update, languageSiblings: true, ...extra }) });
    expect(res.status, await res.clone().text()).toBe(200);
    return await res.json() as Record<string, any>;
  };
  /** Photos of one album (the first with `caption`), each saved; the newest's settle acts. */
  const album = async (caption: string | undefined, count = 3) => {
    const parts = Array.from({ length: count }, (_, i) => part(i + 1, i === 0 ? caption : undefined));
    for (const p of parts) expect(await intake(p, { briefHold: true })).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'album' } });
    return parts;
  };
  const opens = async () => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'lifecycle_chat_open' AND payload->>'chatId' = ${String(chat)}`
    .execute(owner)).rows[0].n);
  return { chat, from, app, part, text, intake, album, opens, download };
}

describe('F11: a JPEG labelled image/jpg is a picture (ADR-156 P3)', () => {
  it('a document labelled image/jpg is selected like image/jpeg; other types stay refused', () => {
    const document = (mime: string) => ({ document: { file_id: `file-${mime}`, file_name: 'photo.jpg', mime_type: mime, file_size: 2048 } });
    expect(lifecycleStillImageFile(document('image/jpg'))).toBe('file-image/jpg');
    expect(lifecycleStillImageFile(document('IMAGE/JPG'))).toBe('file-IMAGE/JPG');
    expect(lifecycleStillImageFile(document('image/jpeg'))).toBe('file-image/jpeg');
    expect(lifecycleStillImageFile(document('image/gif'))).toBeNull();
    expect(lifecycleStillImageFile(document('application/pdf'))).toBeNull();
  });
});

describe('a split brief followed by an album (ADR-156 #10 with ADR-143)', () => {
  const BRIEF = ['Annual Engineering Conference 2026', '', 'Date: 12 November 2026, 9:00 am', 'Venue: Erbil International Hotel', '',
    'Programme:', ...Array.from({ length: 60 }, (_, i) => `Session ${i + 1}: a talk on renewable energy policy and water resources in the region`)].join('\n');
  const TAIL = 'Speakers:\nDr. A, keynote on renewable energy policy\nDr. B, panel on water resources\n\nContact: info@example.org';

  it('the album takes the held brief with every part Telegram split off: one request with all of the copy', async () => {
    const f = setup();
    expect(BRIEF.length).toBeGreaterThan(3000);
    const first = f.text(BRIEF);
    expect(await f.intake(first, { briefHold: true })).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'brief' } });
    expect(await f.intake(f.text(TAIL, { date: 1790000001 }), { briefHold: true })).toMatchObject({ briefPart: true });
    const parts = await f.album(undefined, 2);
    const opened = await f.intake(parts[1], { settle: true, briefHold: true });
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: `${BRIEF}\n${TAIL}`,
      lifecycleAlbum: { images: [1, 2].map((n) => ({ sha256: hash(photo(n)) })) } } });
    // The brief's own settle finds it taken by the album; nothing else opens.
    expect(await f.intake(first, { settle: true, briefHold: true })).toMatchObject({ settle: 'skipped' });
    expect(await f.opens()).toBe(1);
  });
});

describe('F8 remainder: a voice note sent as the rest of a caption Telegram cut (ADR-160)', () => {
  const INSTRUCTION = 'Design a formal report cover for KAAE with the supplied photos in a clean collage, navy and yellow brand colours. ';
  const TAIL = '\n\nHere is the text and the photos:\n\nKAAE K-12 Pilot Study\nField Visit Report\n\nInsights from school field visits and next steps tow';
  const cut = (INSTRUCTION.repeat(20).slice(0, TELEGRAM_CAPTION_LIMIT - TAIL.length) + TAIL);
  const HEARD = 'ard better learning for every pupil in the region.';

  beforeEach(async () => {
    vi.stubEnv('OPENAI_API_KEY', randomUUID());
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ text: HEARD })));
    await sql`DELETE FROM hawa.model_deployments WHERE tenant_id = ${tenantId}::uuid AND role = 'voice_transcriber'`.execute(owner);
    await sql`INSERT INTO hawa.model_deployments(tenant_id, role, provider, exact_model_id, deployment_version, admission, policy_profile)
      VALUES (${tenantId}::uuid, 'voice_transcriber', 'openai', 'whisper-1', 'synthetic-fixture-v1', 'canary',
        '{"usdPerMinute":0.006,"maxUsdPerCall":0.1,"dailyUsdBudget":1,"maxCallsPerDay":100}'::jsonb)`.execute(owner);
  });

  /** An organisation whose words may be transcribed, a cut album asked for the rest, and the voice note. */
  async function cutAlbumThenVoice() {
    const clientId = randomUUID();
    const code = `cross-${randomUUID().slice(0, 8)}`;
    await sql`INSERT INTO hawa.clients(id, tenant_id, code, name) VALUES (${clientId}::uuid, ${tenantId}::uuid, ${code}, ${code})`.execute(owner);
    const dna = { privacy: { modelEgressMode: 'approved_providers', allowedProviders: ['openai'] } };
    await sql`INSERT INTO hawa.client_dna_versions(tenant_id, client_id, version, status, dna, content_hash, approved_by)
      VALUES (${tenantId}::uuid, ${clientId}::uuid, 1, 'active', ${JSON.stringify(dna)}::jsonb, ${hash(JSON.stringify(dna))}, ${userId}::uuid)`.execute(owner);
    const f = setup();
    expect(cut.length).toBe(TELEGRAM_CAPTION_LIMIT);
    const parts = await f.album(cut, 3);
    expect(await f.intake(parts[2], { settle: true, briefHold: true })).toMatchObject({ lifecycleAction: 'settle-later',
      notice: { text: expect.stringContaining('Telegram cut your text short') } });
    const voice = { update_id: ++id, message: { message_id: ++id, date: 1790000000, from: f.from, chat: { id: f.chat, type: 'private' },
      caption: `Client: ${code}`, voice: { file_id: 'voice-rest', mime_type: 'audio/ogg', file_size: audio.length, duration: 1 } } };
    const heard = await f.intake(voice, { briefHold: true });
    expect(heard).toMatchObject({ lifecycleAction: 'source-message' });
    expect(heard.sourceMessage).toContain(HEARD);
    return { f, parts, voice };
  }

  it('its confirmed words join the cut caption: one request with the album, not a second one', async () => {
    const { f, parts } = await cutAlbumThenVoice();
    const yes = f.text('yes');
    const opened = await f.intake(yes, { briefHold: true });
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: `${cut}${HEARD}`,
      lifecycleAlbum: { updateId: yes.update_id, images: [1, 2, 3].map((n) => ({ sha256: hash(photo(n)) })) } } });
    // The draft contract refuses a source reference beside an album: the words travel as the album's.
    expect(opened.draft.lifecycleSource).toBeUndefined();
    // A replay gives the same request; the album's settle finds it started.
    expect(await f.intake(yes, { briefHold: true })).toMatchObject({ duplicate: true, requestId: opened.requestId });
    expect(await f.intake(parts[2], { settle: true, briefHold: true })).toMatchObject({ settle: 'skipped' });
    expect(await f.opens()).toBe(1);
    const project = await f.app.request(`/v1/internal/lifecycle/${opened.requestId}/project`, { method: 'POST', headers,
      body: JSON.stringify({ v: 1, expectedRev: 0, rev: 1, key: `${opened.requestId}:1:open`, ops: [{ kind: 'createRequest', draft: opened.draft }] }) });
    expect(project.status).toBe(200);
  });

  it('the album keeps waiting past its ten minutes while those words wait for their "yes", and is not swept meanwhile', async () => {
    const { f, parts, voice } = await cutAlbumThenVoice();
    // Eleven minutes pass with the words shown and not yet confirmed.
    await sql`UPDATE hawa.inbox_events SET received_at = received_at - interval '11 minutes'
      WHERE tenant_id = ${tenantId}::uuid AND ((payload->>'chatId' = ${String(f.chat)}
          AND source_account_id IN ('lifecycle_album_part', 'lifecycle_album_pending', 'lifecycle_album_cut'))
        OR (source_account_id LIKE 'lifecycle_source_%' AND source_event_id = ${String(voice.update_id)}))`.execute(owner);
    const settled = await f.intake(parts[2], { settle: true, briefHold: true });
    expect(settled).toMatchObject({ lifecycleAction: 'settle-later', settle: { kind: 'album' } });
    expect(settled.notice).toBeUndefined();
    const swept = (await withRlsContext(db, scope, (trx) => overdueSettles(trx, tenantId))).filter((d) => d.chatId === String(f.chat));
    expect(swept).toEqual([]);
    const opened = await f.intake(f.text('yes'), { briefHold: true });
    expect(opened).toMatchObject({ lifecycleAction: 'open-request', draft: { rawText: `${cut}${HEARD}`, lifecycleAlbum: { images: [{}, {}, {}] } } });
    expect(await f.opens()).toBe(1);
  });
});

describe('ADR-155 section 6 at intake: every office member hears the alert', () => {
  const OFFICE_A = 91000081;
  const OFFICE_B = 91000082;
  const REQUESTER = 91000083;
  const clientId = 'c1000000-0000-4000-8000-000000000002';

  /** A delivered request in `chat`, from a brief its requester sent. */
  async function delivered(chat: number, requester: number) {
    const requestId = randomUUID();
    const brief = { update_id: ++id, message: { message_id: ++id, from: { id: requester, is_bot: false, first_name: 'R' },
      chat: { id: chat, type: 'private' }, date: 1790000000, text: 'Nawroz poster' } };
    const created = await persistChatIntake(db, { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: String(chat),
      rawJson: brief, rawText: 'Nawroz poster', title: 'Nawroz poster', clientId, designInstructions: 'Make the approved event design',
      exactCopy: [{ text: '21 March 2027' }], autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 },
      studioOptions: { tier: 'quality' } }, { outboxState: 'recorded' });
    const taskId = String(created.task.id);
    await withRlsContext(db, scope, async (trx) => {
      await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id)
        VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, null, 'restate', 'delivered', 7, ${String(chat)})`.execute(trx);
      await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
    });
    return requestId;
  }
  const ask = (chat: number, from: number) => ({ update_id: ++id, message: { message_id: ++id, date: 1790000000,
    from: { id: from, is_bot: false, first_name: 'R' }, chat: { id: chat, type: 'private' }, text: 'Please send it again, it did not arrive' } });

  it('the first office member asking about their own design: the others are alerted (nobody was before)', async () => {
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', `${OFFICE_A}, ${OFFICE_B}`);
    const f = setup(OFFICE_A);
    await delivered(OFFICE_A, OFFICE_A);
    const answer = await f.intake(ask(OFFICE_A, OFFICE_A));
    expect(answer).toMatchObject({ lifecycleAction: 'chat-answer', note: 'delivery',
      chatAnswer: { text: expect.stringContaining('to the office') },
      officeAlert: { chatId: String(OFFICE_B), text: expect.stringContaining('Please send it again') } });
    expect(answer.officeAlerts).toEqual([answer.officeAlert]);
  });

  it('a requester outside the office: every member is alerted, the first as before', async () => {
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', `${OFFICE_A},${OFFICE_B},${OFFICE_A}`);
    const chat = ++id;
    const f = setup(chat);
    await delivered(chat, REQUESTER);
    const update = ask(chat, REQUESTER);
    const answer = await f.intake(update);
    expect(answer.officeAlert).toMatchObject({ chatId: String(OFFICE_A) });
    expect(answer.officeAlerts.map((a: any) => a.chatId)).toEqual([String(OFFICE_A), String(OFFICE_B)]);
    expect(new Set(answer.officeAlerts.map((a: any) => a.text))).toEqual(new Set([answer.officeAlert.text]));
    // The recorded answer replays to the same members.
    expect(await f.intake(update)).toMatchObject({ duplicate: true, officeAlerts: answer.officeAlerts });
  });

  it('the helpers: members without repeats, the sender\'s own chat left out, an answer with no alert unchanged', () => {
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', ' 1, 2 ,1,,3');
    expect(officeChatsFor(null)).toEqual(['1', '2', '3']);
    expect(officeChatsFor('2')).toEqual(['1', '3']);
    expect(withOfficeAlerts({ chatId: '9' })).toEqual({ chatId: '9' });
    expect(withOfficeAlerts({ chatId: '1', officeAlert: { chatId: '2', text: 't' } }).officeAlerts)
      .toEqual([{ chatId: '2', text: 't' }, { chatId: '3', text: 't' }]);
  });

  it('a parked update alerts every member but the sender\'s chat, each once', async () => {
    const parked = { update_id: 900_000_000 + Math.floor(Math.random() * 1e8), message: { chat: { id: OFFICE_A }, text: 'x' } };
    const identity = { tenantId, userId };
    for (let i = 0; i < 2; i++) {
      await parkTelegramUpdate(db, identity, parked, 'intake answered HTTP 500 after 5 attempts',
        { officeChatIds: [String(OFFICE_A), String(OFFICE_B), '91000084'] });
    }
    const alerts = await withRlsContext(db, scope, async (trx) => (await sql<{ idempotency_key: string; payload: { chatId: string } }>`
      SELECT idempotency_key, payload FROM hawa.outbox_commands WHERE idempotency_key LIKE ${`notify.office:telegram-update-parked:${parked.update_id}%`}
      ORDER BY idempotency_key`.execute(trx)).rows);
    expect(alerts.map((a) => [a.idempotency_key, a.payload.chatId])).toEqual([
      [`notify.office:telegram-update-parked:${parked.update_id}`, String(OFFICE_B)],
      [`notify.office:telegram-update-parked:${parked.update_id}:91000084`, '91000084']]);
  });
});
