import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';

/**
 * What a production sender is told after revision feedback. With a database and a real client the
 * handler queues a durable revision and returns from that branch, so anything said only in the
 * fallback acknowledgement (which the database-less tests exercise) never reaches a real user.
 * Two lines had been living there: whether the message was applied once or proposed as a standing
 * rule, and (through a flag read off the wrong object) the daily-cap notice, so a capped sender
 * was promised a draft that no worker would produce.
 */

const KAAE = 'c1000000-0000-4000-8000-000000000002';
const TENANT = '00000000-0000-4000-a000-000000000001';

describe('revision feedback messages, with a database', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const telegramSecret = ['revision', 'messages', 'fixture', 'secret'].join('_');
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = telegramSecret;
    delete process.env.TELEGRAM_ALLOWED_USERS; // nobody is a director here, so the cap applies
    await withRlsContext(db, { tenantId: TENANT, userId: '00000000-0000-4000-b000-000000000001', role: 'administrator' }, async (trx) => {
      await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${KAAE}::uuid,${TENANT}::uuid,'kaae','KAAE') ON CONFLICT DO NOTHING`.execute(trx);
    });
  });
  afterAll(async () => {
    process.env = saved;
    await db.destroy();
  });

  const chat = () => 700000 + Math.floor(Math.random() * 100000);
  const post = (app: any, chatId: number, text: string) =>
    app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': telegramSecret },
      body: JSON.stringify({
        update_id: randomUUID(),
        message: { message_id: 1, from: { id: chatId, is_bot: false, first_name: 'Office' }, chat: { id: chatId, type: 'private' }, text },
      }),
    });
  const texts = (dispatch: ReturnType<typeof vi.fn>) => dispatch.mock.calls.map((c) => String(c[1]?.text ?? ''));

  it('the revision message tells the sender whether a standing rule was proposed', async () => {
    process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '50';
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const app = createApp({ db, testAuth: { principal: { role: 'operator' }, roleHeader: true }, telegramBridge: { dispatchOutboundMessage: dispatch } as any });
    const chatId = chat();
    const intake = await post(app, chatId, 'KAAE Annual Research Conference 2026\nدەق: کۆنفرانسی ساڵانەی توێژینەوە');
    expect(intake.status).toBe(201);
    const { task } = await intake.json();

    const once = await post(app, chatId, `revise task ${task.id}: use Amiri for the Kurdish text`);
    expect(once.status).toBe(200);
    expect((await once.json()).status).toBe('REVISION_QUEUED');
    const onceTexts = texts(dispatch);
    const revisionMsg = onceTexts.find((t) => /Revision instruction received/.test(t));
    expect(revisionMsg).toBeDefined();
    expect(revisionMsg).toMatch(/Applied to this design only/);
    expect(revisionMsg).not.toMatch(/standing rule for this client/);

    dispatch.mockClear();
    const standing = await post(app, chatId, `revise task ${task.id}: from now on use Amiri for all Kurdish text`);
    expect((await standing.json()).status).toBe('REVISION_QUEUED');
    const standingMsg = texts(dispatch).find((t) => /Revision instruction received/.test(t));
    expect(standingMsg).toMatch(/Proposed as a standing rule for this client/);
    expect(standingMsg).toMatch(/approves it in Hawa Desk/);
  });

  it('a sender over the daily cap is told so, not promised a draft', async () => {
    process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1';
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const app = createApp({ db, testAuth: { principal: { role: 'operator' }, roleHeader: true }, telegramBridge: { dispatchOutboundMessage: dispatch } as any });
    const chatId = chat();
    const { task } = await (await post(app, chatId, 'KAAE Curriculum Framework\nدەق: چوارچێوەی پرۆگرام')).json();
    dispatch.mockClear();

    const res = await post(app, chatId, `revise task ${task.id}: make the title larger`);
    expect(res.status).toBe(200);
    const all = texts(dispatch).join('\n');
    expect(all).toMatch(/daily limit for automatic drafts has been reached/);
    expect(all).not.toMatch(/You will receive the editable Canva link/);

    // The revision task was saved without automatic generation, which is what the worker will refuse to run.
    const body = await res.json();
    expect(body.revisionTaskId).toBeTruthy();
    const created = await withRlsContext(db, { tenantId: TENANT, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' }, (trx) =>
      trx.selectFrom('task_events').select('data').where('task_id', '=', body.revisionTaskId).where('event_type', '=', 'task.created').executeTakeFirstOrThrow());
    expect((created.data as any).payload.autoGenerate).not.toBe(true);
    expect((created.data as any).payload.autoGenerateDeclined).toBe('SENDER_DAILY_CAP');
  });
});
