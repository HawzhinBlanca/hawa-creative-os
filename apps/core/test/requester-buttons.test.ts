import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { composeCanvaStatusMessage } from '../src/services/canva-status-message.js';
import { parseRequesterAction, requesterButtons, composeDesignerHandoff, composeChangePrompt } from '../src/services/requester-actions.js';

/**
 * The requester stays with a design until they are happy with it (ADR-032 §2.4): under every draft,
 * Approve, Change something, Ask a designer. None of them approves the design itself; the art
 * director's approval in Hawa Desk still delivers (ADR-022).
 */
const taskId = '00000000-0000-4000-c000-000000000001';

describe('the requester buttons', () => {
  it('ride on a ready draft only, with the Canva link above them', () => {
    const ready = composeCanvaStatusMessage({ taskId, status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', canvaUrl: 'https://www.canva.com/design/DA_x/edit' });
    const rows = ready.reply_markup!.inline_keyboard;
    expect(rows[0][0]).toMatchObject({ url: 'https://www.canva.com/design/DA_x/edit' });
    expect(rows.slice(1).flat().map((b) => ('callback_data' in b ? b.callback_data : ''))).toEqual([`rq:ok:${taskId}`, `rq:chg:${taskId}`, `rq:dsg:${taskId}`]);
    for (const status of ['DESIGN_FAILED', 'CANVA_COPY_MISMATCH', 'MANUAL_DESIGN_REQUIRED']) {
      const msg = composeCanvaStatusMessage({ taskId, status, canvaUrl: 'https://www.canva.com/design/DA_x/edit' });
      expect(JSON.stringify(msg.reply_markup || {})).not.toContain('rq:');
    }
  });

  it('carry data that fits Telegram and parses back, and nothing else parses', () => {
    for (const b of requesterButtons(taskId).flat()) expect(Buffer.byteLength('callback_data' in b ? b.callback_data : '')).toBeLessThanOrEqual(64);
    expect(parseRequesterAction(`rq:dsg:${taskId}`)).toEqual({ action: 'dsg', taskId });
    for (const bad of ['rq:ok:not-a-task', 'act:approve:x', `rq:del:${taskId}`, '', undefined]) expect(parseRequesterAction(bad)).toBeNull();
  });

  it('ask for a change as a reply that carries the task, and hand the office the history in plain words', () => {
    const prompt = composeChangePrompt(taskId);
    expect(prompt.reply_markup).toMatchObject({ force_reply: true });
    expect(prompt.text).toContain(taskId);
    const handoff = composeDesignerHandoff({ taskId, title: 'KAAE <x>', asks: [{ ask: 'cut the panelists out', status: 'done' }, { ask: 'change the date', status: 'not_possible', reason: 'the text is fixed' }], rounds: 3, why: 'rounds' });
    expect(handoff.text).toContain('Round 3 of changes');
    expect(handoff.text).toContain('✅ cut the panelists out');
    expect(handoff.text).toContain('❌ change the date (the text is fixed)');
    expect(handoff.text).toContain('KAAE &lt;x&gt;');
  });
});

const url = process.env.HAWA_ISOLATED_TEST_DB;

describe.skipIf(!url)('pressing a requester button (webhook, PostgreSQL)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const operator = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' } as const;
  const secret = ['requester', 'buttons', 'fixture'].join('_');
  const OFFICE = 91000003;
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
    delete process.env.OPENAI_API_KEY;
  });
  afterAll(async () => {
    process.env = saved;
    await db.destroy();
  });

  const setup = async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const answer = vi.fn().mockResolvedValue(true);
    const bridge = {
      dispatchOutboundMessage: dispatch,
      dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }),
      answerCallbackQuery: answer,
      downloadFile: vi.fn(),
      handleCommand: vi.fn().mockReturnValue(null),
      formatTaskPreviewCard: vi.fn().mockReturnValue({}),
    };
    const app = createApp({ db, telegramBridge: bridge as any } as any);
    const chat = 70000000 + Math.floor(Math.random() * 9000000);
    const post = async (body: unknown) => {
      const res = await app.request('/api/webhooks/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    };
    const created = await post({
      update_id: randomUUID(),
      message: { message_id: 1, from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' }, text: 'KAAE members evening\n---\nDecember 4, 2026\nErbil' },
    });
    expect(created.status).toBe(201);
    const task = String(created.body.task?.id || created.body.taskId);
    const press = (data: string, inChat = chat) =>
      post({ update_id: randomUUID(), callback_query: { id: randomUUID(), from: { id: OFFICE, is_bot: false }, message: { message_id: 5, chat: { id: inChat, type: 'private' } }, data } });
    const officeAlerts = async () =>
      (await withRlsContext(db, operator, async (trx) =>
        (await sql<{ key: string; chat: string }>`SELECT idempotency_key AS key, payload->>'chatId' AS chat FROM hawa.outbox_commands
          WHERE aggregate_id = ${task}::uuid AND idempotency_key LIKE 'notify.office:%'`.execute(trx)).rows));
    return { chat, task, press, dispatch, answer, officeAlerts, post };
  };

  it('Approve thanks the requester and tells the office, once; it approves nothing', async () => {
    const { task, press, dispatch, officeAlerts } = await setup();
    const first = await press(`rq:ok:${task}`);
    expect(first.body).toMatchObject({ ok: true, requesterAction: 'ok', taskId: task });
    expect(String(dispatch.mock.calls.at(-1)?.[1]?.text)).toContain('you approved this design');
    expect(await officeAlerts()).toEqual([{ key: `notify.office:requester-approved:${task}`, chat: String(OFFICE) }]);
    const again = await press(`rq:ok:${task}`);
    expect(again.body).toMatchObject({ already: true });
    expect((await officeAlerts()).length).toBe(1);
    const state = await withRlsContext(db, operator, async (trx) => (await sql<{ state: string }>`SELECT state FROM hawa.tasks WHERE id = ${task}::uuid`.execute(trx)).rows[0].state);
    expect(state).not.toBe('approved');
  });

  it('Change something asks for the change as a reply that reaches this design', async () => {
    const { task, press, dispatch } = await setup();
    const res = await press(`rq:chg:${task}`);
    expect(res.body).toMatchObject({ requesterAction: 'chg' });
    const sent = dispatch.mock.calls.at(-1)?.[1];
    expect(sent.reply_markup).toMatchObject({ force_reply: true });
    expect(sent.text).toContain(task);
  });

  it('Ask a designer tells the requester who has it and hands the office the design', async () => {
    const { task, press, dispatch, officeAlerts } = await setup();
    const res = await press(`rq:dsg:${task}`);
    expect(res.body).toMatchObject({ requesterAction: 'dsg' });
    expect(String(dispatch.mock.calls.at(-1)?.[1]?.text)).toContain('A designer from the office takes over');
    expect((await officeAlerts()).map((a) => a.key)).toEqual([`notify.office:designer-asked:${task}`]);
  });

  it('a button pressed in another chat, or on a replaced draft, does nothing to the design', async () => {
    const { task, press, dispatch, chat, post } = await setup();
    const elsewhere = await press(`rq:ok:${task}`, chat + 1);
    expect(elsewhere.body).toMatchObject({ ok: false, reason: 'NOT_THIS_CHAT' });
    // A newer version: a second request in the chat made a revision of this one.
    const second = await post({
      update_id: randomUUID(),
      message: { message_id: 2, from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' }, text: 'KAAE members evening, revised\n---\nDecember 5, 2026\nErbil' },
    });
    const child = String(second.body.task?.id || second.body.taskId);
    await withRlsContext(db, operator, (trx) =>
      sql`UPDATE hawa.outbox_commands SET payload = jsonb_set(payload, '{studioOptions}', COALESCE(payload->'studioOptions', '{}'::jsonb) || jsonb_build_object('parentTaskId', ${task}::text))
        WHERE aggregate_id = ${child}::uuid AND command_type = 'task.created'`.execute(trx));
    const replaced = await press(`rq:ok:${task}`);
    expect(replaced.body).toMatchObject({ replacedBy: child });
    expect(String(dispatch.mock.calls.at(-1)?.[1]?.text)).toContain('A newer version of this design exists');
  });
});
