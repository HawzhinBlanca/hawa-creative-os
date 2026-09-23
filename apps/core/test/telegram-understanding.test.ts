import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, withRlsContext, ClientRulesRepository } from '@hawa/db';
import { createApp } from '../src/app.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * What the bot does with what the office actually sends, end to end through the webhook against
 * PostgreSQL. Each case was a failure found on 2026-09-23: a standing rule became a design brief,
 * "thanks" under a draft started a paid redesign, an edited message vanished, a PDF of brand
 * guidelines was answered "no text or media", an album's photos each asked for the request again,
 * a typed /approve got no reply, and a clarification question dropped the message it asked about.
 */
describe.skipIf(!url)('the bot understands what the office sends', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  const operator = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const secret = ['understanding', 'fixture', 'secret'].join('_');
  // An office member (TELEGRAM_ALLOWED_USERS): a client they name is taken as named.
  const OFFICE = 91000001;
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
    // The test database keeps every run's tasks of the day, so the office-wide daily cap on automatic
    // drafts (200) is reached by the tests themselves; it is not what these tests are about.
    process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
    delete process.env.OPENAI_API_KEY;
  });
  afterAll(async () => {
    process.env = saved;
    await db.destroy();
  });

  const setup = (extra: Record<string, unknown> = {}, sender = OFFICE) => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const bridge = {
      dispatchOutboundMessage: dispatch,
      dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      downloadFile: vi.fn(),
      handleCommand: vi.fn().mockReturnValue(null),
      formatTaskPreviewCard: vi.fn().mockReturnValue({}),
    };
    const app = createApp({ db, telegramBridge: bridge as any, ...extra } as any);
    const chat = 70000000 + Math.floor(Math.random() * 9000000);
    const send = async (message: Record<string, unknown>, top: Record<string, unknown> = {}) => {
      const res = await app.request('/api/webhooks/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify({
          update_id: randomUUID(),
          ...(Object.keys(top).length ? top : { message: { message_id: Math.floor(Math.random() * 1e6), from: { id: sender, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' }, ...message } }),
        }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const replies = () => dispatch.mock.calls.map((c) => String(c[1]?.text ?? '')).join('\n---\n');
    return { app, chat, send, replies, dispatch, bridge };
  };

  const activeRules = () => withRlsContext(db, operator, (trx) => new ClientRulesRepository(trx).listActive(tenantId, kaae));
  const tasksInChat = async (chat: number) =>
    (await withRlsContext(db, operator, (trx) =>
      trx.selectFrom('outbox_commands').select(['aggregate_id', 'payload']).where('command_type', '=', 'task.created').execute()
    )).filter((r: any) => String(r.payload?.sourceChannelId) === String(chat));

  it('a standing rule is saved for the client, listed by /rules, removed by /forget, and makes no design', async () => {
    const { chat, send, replies } = setup();
    const words = `From now on, always put the KAAE logo bottom-right ${randomUUID().slice(0, 6)}`;
    const res = await send({ text: words });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RULE_SAVED');
    expect(replies()).toMatch(/Saved as a standing rule for KAAE/);
    expect((await activeRules()).some((r) => r.humanRule === words)).toBe(true);
    expect(await tasksInChat(chat)).toHaveLength(0);

    await send({ text: '/rules' });
    const list = replies().split('\n---\n').pop()!;
    expect(list).toMatch(/Standing rules for KAAE/);
    const n = list.split('\n').find((l) => l.includes(words.slice(-6)))!.match(/^(\d+)\./)![1];
    await send({ text: `/forget ${n}` });
    expect(replies()).toMatch(/No longer applied to KAAE designs/);
    expect((await activeRules()).some((r) => r.humanRule === words)).toBe(false);
  });

  it('outside the office, naming a client the chat never asked for does not reach its rules', async () => {
    const { send, replies } = setup({}, 91000999);
    const res = await send({ text: '/forget 1 KAAE' });
    expect(res.status).toBe(200);
    expect(replies()).toMatch(/Which client is this command for/);
  });

  it('a rule with no client named, in a chat with no requests, asks which client', async () => {
    const { send, replies } = setup();
    const res = await send({ text: 'From now on always use a gold button for the call to action' });
    expect(res.body.status).toBe('RULE_CLIENT_UNKNOWN');
    expect(replies()).toMatch(/Which client is this rule for/);
  });

  it('"thanks" in reply to a draft starts nothing; a change in reply to it is a revision of that design', async () => {
    const { chat, send, replies } = setup();
    const brief = await send({ text: 'KAAE accreditation ceremony\n---\nOctober 12, 2026\nErbil' });
    expect(brief.status).toBe(201);
    const taskId = brief.body.task.id;
    const draft = { message_id: 99, from: { id: 1, is_bot: true, first_name: 'Hawa' }, chat: { id: chat, type: 'private' }, text: `🎨 Your Canva draft is ready\nTask ID: ${taskId}` };
    const before = (await tasksInChat(chat)).length;

    const thanks = await send({ text: 'thanks 🙏', reply_to_message: draft });
    expect(thanks.body.kind).toBe('other');
    expect(replies()).toMatch(/Thank you/);
    expect((await tasksInChat(chat)).length).toBe(before);

    const change = await send({ text: 'make the title gold', reply_to_message: draft });
    expect(change.body.status).toBe('REVISION_QUEUED');
    expect(change.body.taskId).toBe(taskId);
    expect((await tasksInChat(chat)).length).toBe(before + 1);
    // No preview from the legacy templates, and no buttons that every press refused.
    expect(replies()).not.toMatch(/Local layout preview/);

    // A change that is also a lasting preference revises this design and is saved for the next ones.
    // (Another design: a second change to one whose first change is still being made starts nothing.)
    const other = await send({ text: 'KAAE accreditation dinner\n---\nOctober 13, 2026\nErbil' });
    const otherDraft = { ...draft, text: `🎨 Your Canva draft is ready\nTask ID: ${other.body.task.id}` };
    const both = await send({ text: `from now on always make KAAE titles gold ${randomUUID().slice(0, 4)}`, reply_to_message: otherDraft });
    expect(both.body.status).toBe('REVISION_QUEUED');
    expect(replies()).toMatch(/Also saved as a standing rule/);
    const rule = (await activeRules()).find((r) => r.humanRule.startsWith('from now on always make KAAE titles gold'));
    expect(rule).toBeDefined();
    await withRlsContext(db, operator, (trx) => new ClientRulesRepository(trx).deactivate(tenantId, kaae, rule!.id));
  });

  it('/status lists this chat’s latest requests and where each one is', async () => {
    const { send, replies } = setup();
    expect((await send({ text: 'KAAE open day\n---\nNovember 20, 2026\nErbil' })).status).toBe(201);
    const res = await send({ text: '/status' });
    expect(res.body.status).toBe(1);
    expect(replies()).toMatch(/Your latest requests/);
    expect(replies()).toMatch(/being designed|draft ready|needs the office/);
  });

  it('an edited message is answered, not silently dropped', async () => {
    const { chat, send, replies } = setup();
    const res = await send({}, { edited_message: { message_id: 5, from: { id: chat, is_bot: false }, chat: { id: chat, type: 'private' }, text: 'corrected date' } });
    expect(res.body.reason).toBe('EDITED_MESSAGE');
    expect(replies()).toMatch(/Edits to a message already sent are not picked up/);
  });

  it('a typed /approve is answered with where approval happens', async () => {
    const { send, replies } = setup();
    const res = await send({ text: `/approve ${randomUUID()}` });
    expect(res.status).toBe(422);
    expect(replies()).toMatch(/approved in Hawa Desk/);
  });

  it('a PDF of brand guidelines is read into KAAE rules and listed back; another file type is refused', async () => {
    const model = {
      completeJson: vi.fn(async () => ({
        data: {
          isBrandGuidelines: true,
          brandName: 'KAAE',
          summary: 'KAAE brand guidelines.',
          rules: [
            { category: 'colour', rule: `Use Kurdistan Sun Gold #F7B500 for accents ${randomUUID().slice(0, 4)}`, fontFamily: '', script: 'any', colourHex: '#F7B500' },
            { category: 'typography', rule: `Set Kurdish text in Rabar ${randomUUID().slice(0, 4)}`, fontFamily: 'Rabar_022', script: 'arabic', colourHex: '' },
          ],
        },
      })),
    };
    const { app, send, replies, bridge } = setup({ guidelinesModel: model });
    bridge.downloadFile.mockResolvedValue(Buffer.from('%PDF-1.7 guidelines'));
    const res = await send({ caption: 'KAAE new brand guidelines', document: { file_id: 'f1', file_unique_id: `u-${randomUUID()}`, file_name: 'KAAE Brand Guidelines.pdf', mime_type: 'application/pdf', file_size: 1000 } });
    expect(res.body.guidelines).toBe('reading');
    await Promise.all([...(app as any).guidelineReadings]);
    expect(replies()).toMatch(/Reading KAAE Brand Guidelines\.pdf/);
    expect(replies()).toMatch(/KAAE brand guidelines read/);
    expect(replies()).toMatch(/Rabar_022 is not installed in the studio/);
    const rules = await activeRules();
    const mine = rules.filter((r) => /Kurdistan Sun Gold|Set Kurdish text in Rabar/.test(r.humanRule));
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine.find((r) => r.category === 'colour')?.machineRule).toMatchObject({ colourHex: '#F7B500', source: 'brand_guidelines' });
    await withRlsContext(db, operator, async (trx) => {
      for (const r of mine) await new ClientRulesRepository(trx).deactivate(tenantId, kaae, r.id);
    });

    const other = await send({ document: { file_id: 'f2', file_name: 'brief.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } });
    expect(other.body.reason).toBe('UNSUPPORTED_DOCUMENT');
    expect(replies()).toMatch(/brief\.docx cannot be read here/);
  });

  it("an album's other photos join the captioned request, with one answer", async () => {
    const { chat, send, replies, bridge, dispatch } = setup();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    bridge.downloadFile.mockResolvedValue(png);
    const album = `album-${randomUUID().slice(0, 8)}`;
    const first = await send({ media_group_id: album, photo: [{ file_id: 'p1' }], caption: 'KAAE panel discussion\n---\nSeptember 25, 2026\nErbil' });
    expect(first.status).toBe(201);
    const requestId = first.body.task.id;
    const repliesAfterRequest = dispatch.mock.calls.length;
    const second = await send({ media_group_id: album, photo: [{ file_id: 'p2' }] });
    const third = await send({ media_group_id: album, photo: [{ file_id: 'p3' }] });
    expect(second.body.referenceFor).toBe(requestId);
    expect(third.body.referenceFor).toBe(requestId);
    expect(dispatch.mock.calls.length).toBe(repliesAfterRequest);
    expect(replies()).not.toMatch(/Send the request text now/);
    // The request's own photo keeps its format.
    const own = (await tasksInChat(chat)).find((r: any) => r.aggregate_id === requestId) as any;
    expect(String(own.payload.studioOptions.referenceImageBase64)).toMatch(/^data:image\/png;base64,/);
  });

  it('an album sent in reply to a draft is one revision, with one answer', async () => {
    const { chat, send, bridge, dispatch } = setup();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    bridge.downloadFile.mockResolvedValue(png);
    const brief = await send({ text: 'KAAE panel night\n---\nDecember 1, 2026\nErbil' });
    const draft = { message_id: 98, from: { id: 1, is_bot: true, first_name: 'Hawa' }, chat: { id: chat, type: 'private' }, text: `🎨 Your Canva draft is ready\nTask ID: ${brief.body.task.id}` };
    const album = `reply-album-${randomUUID().slice(0, 8)}`;
    const first = await send({ media_group_id: album, photo: [{ file_id: 'r1' }], caption: 'use these two photos of the panelists', reply_to_message: draft });
    expect(first.body.status).toBe('REVISION_QUEUED');
    const answered = dispatch.mock.calls.length;
    const second = await send({ media_group_id: album, photo: [{ file_id: 'r2' }], reply_to_message: draft });
    expect(second.body.referenceFor).toBe(first.body.revisionTaskId);
    expect(dispatch.mock.calls.length).toBe(answered);
  });

  it('a short new message is not mistaken for the answer to an earlier question', async () => {
    const { send } = setup();
    expect((await send({ text: 'KAAE forum\n---\nJanuary 5, 2027\nDuhok' })).status).toBe(201);
    const original = fetch;
    process.env.OPENAI_API_KEY = ['classifier', 'fixture'].join('-');
    let answer = { kind: 'new_brief', confidence: 0.55 };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...answer, reason: 'r', isInstructionOnly: false, documentKind: 'design_piece', directive: '', standingRule: '' }) } }] }), { status: 200 })) as any;
    try {
      expect((await send({ text: 'Quality week' })).body.status).toBe('CLARIFICATION_REQUIRED');
      answer = { kind: 'new_brief', confidence: 0.95 };
      const next = await send({ text: 'Another poster: Eid Mubarak' });
      expect(next.status).toBe(201);
      expect(JSON.stringify(next.body.task)).toMatch(/Eid Mubarak/);
      expect(JSON.stringify(next.body.task)).not.toMatch(/Quality week/);
    } finally {
      globalThis.fetch = original;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('a clarification answer completes the message it was asked about', async () => {
    const { chat, send, replies } = setup();
    const brief = await send({ text: 'KAAE workshop\n---\nNovember 3, 2026\nSulaymaniyah' });
    expect(brief.status).toBe(201);
    const original = fetch;
    process.env.OPENAI_API_KEY = ['classifier', 'fixture'].join('-');
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'new_brief', confidence: 0.55, reason: 'unsure', isInstructionOnly: false, documentKind: 'design_piece', directive: '', standingRule: '' }) } }] }), { status: 200 })) as any;
    try {
      const unsure = await send({ text: 'Accreditation results day' });
      expect(unsure.body.status).toBe('CLARIFICATION_REQUIRED');
      expect(replies()).toMatch(/Clarification needed/);
      const answered = await send({ text: 'new' });
      expect(answered.status).toBe(201);
      expect(JSON.stringify(answered.body.task.brief?.exactCopy || answered.body.task)).toMatch(/Accreditation results day/);
    } finally {
      globalThis.fetch = original;
      delete process.env.OPENAI_API_KEY;
    }
    expect((await tasksInChat(chat)).length).toBe(2);
  });
});
