import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { createApp } from '../src/app.js';
import { createChatCampaignIntake } from '../src/services/chat-campaign-intake.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

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
const KAAE = 'c1000000-0000-4000-8000-000000000002';
const FASTPAY = 'c1000000-0000-4000-8000-000000000004';

const expectNothingInvented = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const invented of INVENTED) expect(text).not.toContain(invented);
};

/**
 * ADR-135 stage 2: a new Telegram request is the draft prepareChatCampaignDraft builds for the
 * lifecycle (lifecycle-internal.routes.ts), persisted by its projection through persistChatIntake.
 */
function telegramDraft(text: string) {
  const chatId = `no-copy-${randomUUID()}`;
  return createChatCampaignIntake({ telegramBridge: {} } as any).prepareChatCampaignDraft({
    platform: 'telegram', sourceEventId: `no-copy-${randomUUID()}`, sourceChannelId: chatId, senderName: 'Office',
    rawText: text, rawJson: { message: { message_id: 1, chat: { id: chatId }, text } }, autoGenerate: true, isInstructionOnly: false,
  });
}

/**
 * The inline preview, its COPY_REQUIRED refusal, and a task held in this process are reached only
 * through ingestChatCampaignTask, which WhatsApp intake still uses. WAHA names KAAE by "کەی ئەی"
 * itself; FastPay is left to the shared intake, so both reach the same routing as Telegram did.
 */
function whatsapp(app: any, text: string, query = '') {
  const phone = `9647${Math.floor(Math.random() * 1e9)}`;
  return app.request(`/api/webhooks/whatsapp${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'message',
      payload: { id: `no-copy-${randomUUID()}`, from: `${phone}@c.us`, pushname: 'Office', body: text, timestamp: Math.floor(Date.now() / 1000) },
    }),
  });
}

describe('Kurdish Telegram intake with no copy', () => {
  it('leaves the Kurdish copy empty and names the gap in the title', async () => {
    const draft = await telegramDraft(KAAE_NO_COPY);

    expect(draft.clientId).toBe(KAAE);
    expect(draft.headlineCkb).toBe('');
    expect(draft.copyCkb).toBe('');
    expect(draft.exactCopy).toEqual([]);
    expect(draft.title).toBe('KAAE: no copy sent');
    expectNothingInvented(draft);
  });

  it('leaves a brand request with no copy empty as well', async () => {
    const draft = await telegramDraft(FASTPAY_NO_COPY);

    expect(draft.clientId).toBe(FASTPAY);
    expect(draft.headlineCkb).toBe('');
    expect(draft.copyCkb).toBe('');
    expect(draft.exactCopy).toEqual([]);
    expect(draft.title).toBe('Office: no copy sent');
    expectNothingInvented(draft);
  });

  it('keeps a one-line Kurdish request as its headline and invents no body', async () => {
    const draft = await telegramDraft('کۆنفرانسی نیشتمانی کەی ئەی ئەی');

    expect(draft.headlineCkb).toBe('کۆنفرانسی نیشتمانی کەی ئەی ئەی');
    expect(draft.copyCkb).toBe('');
    expectNothingInvented(draft);
  });
});

describe('Kurdish chat intake with no copy, inline preview (WhatsApp)', () => {
  it('refuses the KAAE design and draws nothing', async () => {
    const app = createApp({ telegramBridge: {} } as any);
    const res = await whatsapp(app, KAAE_NO_COPY, '?generate=true');
    expect(res.status).toBe(201);
    const { task } = await res.json();

    expect(task.clientId).toBe(KAAE);
    expect(task.title).toBe('KAAE: no copy sent');
    expect(task.brief.exactCopy).toEqual([]);
    expect(task.generatedOps).toEqual([]);
    expect(task.designRefusal).toBe('COPY_REQUIRED');
    expectNothingInvented(task);
  });

  it('refuses the brand template, which would otherwise draw its own sample text', async () => {
    const app = createApp({ telegramBridge: {} } as any);
    const { task } = await (await whatsapp(app, FASTPAY_NO_COPY, '?generate=true')).json();

    expect(task.clientId).toBe('client-fastpay');
    expect(task.headlineCkb).toBe('');
    expect(task.copyCkb).toBe('');
    expect(task.title).toBe('Office: no copy sent');
    expect(task.generatedOps).toEqual([]);
    expect(task.designRefusal).toBe('COPY_REQUIRED');
    expectNothingInvented(task);
  });

  it('refuses to design or send for review a task that has no copy', async () => {
    const app = createApp({ telegramBridge: {} } as any);
    const bearer = { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}`, 'Content-Type': 'application/json' };
    for (const text of [KAAE_NO_COPY, FASTPAY_NO_COPY]) {
      const { task } = await (await whatsapp(app, text)).json();

      const generate = await app.request(`/v1/tasks/${task.id}/generate`, { method: 'POST', headers: bearer });
      expect(generate.status).toBe(422);
      expect((await generate.json()).title).toBe('COPY_REQUIRED');

      const review = await app.request(`/v1/campaigns/${task.id}/dispatch-review`, { method: 'POST', headers: bearer, body: '{}' });
      expect(review.status).toBe(422);
      expect((await review.json()).title).toBe('COPY_REQUIRED');
    }
  });
});

// The FastPay, Aster and Drustee templates used to fill every empty slot with their own sample
// lines, so a Kurdish request came back with an English headline and body nobody sent.
describe('Brand designs at intake', () => {
  const textsOf = (ops: any[]) => ops.filter((op) => op.op === 'addText').map((op) => op.text.replace(/[⁧⁩]/g, ''));

  it('draws only the Kurdish copy of a Kurdish FastPay request', async () => {
    const app = createApp({ telegramBridge: {} } as any);
    const { task } = await (await whatsapp(app, 'تکایە پۆستێک بۆ فاستپەی دروست بکە\nدەق:\nپارە بنێرە بە چەند چرکەیەک\nبێ کرێ بۆ هەموو گواستنەوەیەک', '?generate=true')).json();

    expect(task.clientId).toBe('client-fastpay');
    expect(task.designRefusal).toBeUndefined();
    expect(textsOf(task.generatedOps)).toEqual(['پارە بنێرە بە چەند چرکەیەک', 'بێ کرێ بۆ هەموو گواستنەوەیەک']);
  });

  it('draws only the English copy of an English FastPay request', async () => {
    const app = createApp({ telegramBridge: {} } as any);
    const { task } = await (await whatsapp(app, 'Please create a FastPay post\nCopy:\nSend money in seconds\nNo fees on personal transfers', '?generate=true')).json();

    expect(task.clientId).toBe('client-fastpay');
    expect(task.designRefusal).toBeUndefined();
    expect(textsOf(task.generatedOps)).toEqual(['Send money in seconds', 'No fees on personal transfers']);
  });
});

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && !/^\/hawa_(repair|tr_)/.test(new URL(url).pathname)) throw new Error('Only disposable hawa_repair database admitted');
describe.skipIf(!url)('Kurdish Telegram intake with no copy, persisted', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const bearer = { Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
  beforeAll(async () => {
    await sql`INSERT INTO hawa.users(id,email,display_name) VALUES ('00000000-0000-4000-b000-000000000001','isolated-operator@example.test','Isolated operator') ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES ('c1000000-0000-4000-8000-000000000002'::uuid,'00000000-0000-4000-a000-000000000001'::uuid,'kaae','KAAE') ON CONFLICT DO NOTHING`.execute(db);
  });
  afterAll(async () => { await db.destroy(); });

  it('stores no Kurdish copy, and the Desk reads none back', async () => {
    const app = createApp({ db });
    const { task } = await persistChatIntake(db, await telegramDraft(KAAE_NO_COPY));

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
