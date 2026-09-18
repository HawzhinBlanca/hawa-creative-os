import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { createApp } from '../src/app.js';

// What Telegram intake used to put on a Kurdish task in place of copy the client never sent.
const INVENTED = [
  'دەستپێکردنی باوەڕپێدانی زانکۆکان بۆ ٢٠٢٦',
  'دەستەی متمانەبەخشی بە پرۆگرامەکان و دامەزراوەکانی پەروەردە و خوێندنی باڵا',
  'ئۆفەری فەرمی',
  'پۆستی تایبەت لە ئۆفیس',
];
// A request with a copy header and nothing under it: the instruction line is not copy.
const KAAE_NO_COPY = 'تکایە پۆستێک بۆ کەی ئەی ئەی دروست بکە\nدەق:';
const FASTPAY_NO_COPY = 'تکایە پۆستێک بۆ فاستپەی دروست بکە\nدەق:';

const expectNothingInvented = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const invented of INVENTED) expect(text).not.toContain(invented);
};

function telegram(app: any, text: string, query = '') {
  const chatId = `no-copy-${randomUUID()}`;
  return app.request(`/api/webhooks/telegram${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! },
    body: JSON.stringify({
      update_id: `no-copy-${randomUUID()}`,
      message: { message_id: 1, from: { id: 7, first_name: 'Office' }, chat: { id: chatId }, text },
    }),
  });
}

describe('Kurdish Telegram intake with no copy', () => {
  it('leaves the Kurdish copy empty, names the gap in the title and refuses the KAAE design', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const app = createApp({ telegramBridge: { dispatchOutboundMessage: dispatch } as any });

    const res = await telegram(app, KAAE_NO_COPY, '?generate=true');
    expect(res.status).toBe(201);
    const { task } = await res.json();

    expect(task.clientId).toBe('c1000000-0000-4000-8000-000000000002');
    expect(task.headlineCkb).toBe('');
    expect(task.copyCkb).toBe('');
    expect(task.brief.exactCopy).toEqual([]);
    expect(task.title).toBe('KAAE: no copy sent');
    expect(task.generatedOps).toEqual([]);
    expect(task.designRefusal).toBe('COPY_REQUIRED');
    expectNothingInvented(task);

    // The acknowledgement the sender receives carries the title, not an invented headline.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][1].text).toContain('KAAE: no copy sent');
    expectNothingInvented(dispatch.mock.calls);
  });

  it('refuses the brand template, which would otherwise draw its own sample text', async () => {
    const app = createApp({ telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }) } as any });
    const { task } = await (await telegram(app, FASTPAY_NO_COPY, '?generate=true')).json();

    expect(task.clientId).toBe('client-fastpay');
    expect(task.headlineCkb).toBe('');
    expect(task.copyCkb).toBe('');
    expect(task.title).toBe('Office: no copy sent');
    expect(task.generatedOps).toEqual([]);
    expect(task.designRefusal).toBe('COPY_REQUIRED');
    expectNothingInvented(task);
  });

  it('refuses to design or send for review a task that has no copy', async () => {
    const app = createApp({ telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }) } as any });
    const bearer = { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}`, 'Content-Type': 'application/json' };
    for (const text of [KAAE_NO_COPY, FASTPAY_NO_COPY]) {
      const { task } = await (await telegram(app, text)).json();

      const generate = await app.request(`/v1/tasks/${task.id}/generate`, { method: 'POST', headers: bearer });
      expect(generate.status).toBe(422);
      expect((await generate.json()).title).toBe('COPY_REQUIRED');

      const review = await app.request(`/v1/campaigns/${task.id}/dispatch-review`, { method: 'POST', headers: bearer, body: '{}' });
      expect(review.status).toBe(422);
      expect((await review.json()).title).toBe('COPY_REQUIRED');
    }
  });

  it('keeps a one-line Kurdish request as its headline and invents no body', async () => {
    const app = createApp({ telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }) } as any });
    const { task } = await (await telegram(app, 'کۆنفرانسی نیشتمانی کەی ئەی ئەی')).json();

    expect(task.headlineCkb).toBe('کۆنفرانسی نیشتمانی کەی ئەی ئەی');
    expect(task.copyCkb).toBe('');
    expectNothingInvented(task);
  });
});

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && new URL(url).pathname !== '/hawa_repair') throw new Error('Only disposable hawa_repair database admitted');
describe.skipIf(!url)('Kurdish Telegram intake with no copy, persisted', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const bearer = { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
  beforeAll(async () => {
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES ('00000000-0000-4000-b000-000000000001','isolated-operator@example.test','Isolated operator') ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES ('c1000000-0000-4000-8000-000000000002'::uuid,'00000000-0000-4000-a000-000000000001'::uuid,'kaae','KAAE') ON CONFLICT DO NOTHING`.execute(db);
  });
  afterAll(async () => { await db.destroy(); });

  it('stores no Kurdish copy, and the Desk reads none back', async () => {
    const app = createApp({ db, telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }) } as any });
    const res = await telegram(app, KAAE_NO_COPY);
    expect(res.status).toBe(201);
    const { task } = await res.json();

    const created = await db.selectFrom('task_events').select('data').where('task_id', '=', task.id).where('event_type', '=', 'task.created').executeTakeFirstOrThrow();
    const payload = (created.data as any).payload;
    expect(payload.headlineCkb).toBeNull();
    expect(payload.copyCkb).toBeNull();
    expect(payload.exactCopy).toEqual([]);
    expectNothingInvented(created.data);

    const read = await app.request(`/v1/tasks/${task.id}`, { headers: bearer });
    expect(read.status).toBe(200);
    const detail = await read.json();
    expect(detail.title).toBe('KAAE: no copy sent');
    expect(detail.headlineCkb).toBeNull();
    expect(detail.copyCkb).toBeNull();
    expectNothingInvented(detail);

    const list = await (await app.request('/v1/tasks', { headers: bearer })).json();
    const listed = list.items.find((item: any) => item.id === task.id);
    expect(listed.headlineCkb).toBeNull();
    expect(listed.copyCkb).toBeNull();
    expectNothingInvented(listed);
  });
});
