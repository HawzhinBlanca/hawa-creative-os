import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { createApp } from '../src/app.js';
import { createChannelKillSwitchStore, KILL_SWITCH_ROW_NAME } from '../src/services/channel-kill-switches.js';

/**
 * The office's intake kill switches live in Postgres (architecture programme 1.3, G8; PHASE2_DESIGN.md
 * slice 2.1), against hawa-test-postgres as hawa_app. They were a plain object in Core's memory, so a
 * restart (a deploy included) switched Telegram and WhatsApp intake back on. "A restart" here is a
 * second app built on the same database, which is what a new Core process is.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const operatorUserId = '00000000-0000-4000-b000-000000000001';
const operator = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
const admin = { 'Content-Type': 'application/json', Authorization: 'Bearer test_admin_key' };

const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.WAHA_KILL_SWITCH = 'false';
  delete process.env.WAHA_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_BOT_TOKEN;
});
afterEach(async () => {
  // Release both switches for the next test, through the route an operator uses.
  const app = createApp({ db } as any);
  for (const channel of ['telegram', 'waha']) {
    await app.request(`/v1/ingress/channels/${channel}/toggle`, { method: 'POST', headers: operator, body: JSON.stringify({ enabled: true }) });
  }
  process.env.WAHA_KILL_SWITCH = 'false';
});
afterAll(async () => {
  process.env = saved;
  await db.destroy();
});

const channels = async (app: ReturnType<typeof createApp>) =>
  (await (await app.request('/v1/ingress/status', { headers: operator })).json()).channels;
const toggle = (app: ReturnType<typeof createApp>, channel: 'telegram' | 'waha', enabled: boolean) =>
  app.request(`/v1/ingress/channels/${channel}/toggle`, { method: 'POST', headers: operator, body: JSON.stringify({ enabled }) });
const switchRow = async (channel: 'telegram' | 'waha') =>
  withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) =>
    (await sql<{ state: string; detail: { killSwitch?: { active: boolean } } }>`SELECT h.state, h.detail FROM hawa.integration_health h
      JOIN hawa.integrations i ON i.id = h.integration_id
      WHERE i.tenant_id = ${tenantId}::uuid AND i.kind = ${channel} AND i.name = ${KILL_SWITCH_ROW_NAME}`.execute(trx)).rows[0]);
const telegramWebhook = (app: ReturnType<typeof createApp>) =>
  app.request('/api/webhooks/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET! },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: 1, is_bot: false, first_name: 'A' }, chat: { id: 1, type: 'private' }, date: 1790000000, text: 'hello' } }),
  });

describe('the kill switches survive a restart', () => {
  it('Telegram, thrown with the ingress toggle: a new Core reports it, refuses the webhook and pauses the poller', async () => {
    const before = createApp({ db } as any);
    const thrown = await toggle(before, 'telegram', false);
    expect(thrown.status).toBe(200);
    expect(await thrown.json()).toMatchObject({ channel: 'telegram', enabled: false, killSwitchActive: true });
    expect((await switchRow('telegram'))?.state).toBe('disabled');

    const restarted = createApp({ db } as any);
    expect(await channels(restarted)).toEqual({ telegram: false, waha: true });
    expect((await telegramWebhook(restarted)).status).toBe(503);
    const bridge = (await (await restarted.request('/v1/adapters/telegram/status', { headers: operator })).json()).bridge;
    expect(bridge.intakePaused).toBe(true);
    const health = await (await restarted.request('/v1/health', { headers: operator })).json();
    expect(health.dependencies.telegram).toBe('kill_switch_active');
  });

  it('Telegram, thrown with POST /operations/kill-switch: a Core built right after the answer still sees it', async () => {
    const before = createApp({ db } as any);
    const thrown = await before.request('/v1/operations/kill-switch', { method: 'POST', headers: operator, body: JSON.stringify({ channel: 'telegram', active: true }) });
    expect(thrown.status).toBe(200);
    const restarted = createApp({ db } as any);
    expect(await channels(restarted)).toEqual({ telegram: false, waha: true });
  });

  it('released: a new Core takes intake back', async () => {
    const before = createApp({ db } as any);
    await toggle(before, 'telegram', false);
    expect((await toggle(before, 'telegram', true)).status).toBe(200);
    expect((await switchRow('telegram'))?.state).not.toBe('disabled');
    const restarted = createApp({ db } as any);
    expect(await channels(restarted)).toEqual({ telegram: true, waha: true });
    const bridge = (await (await restarted.request('/v1/adapters/telegram/status', { headers: operator })).json()).bridge;
    expect(bridge.intakePaused).toBe(false);
  });

  it('WhatsApp, thrown with POST /waha/kill-switch: a new Core refuses WhatsApp intake although its environment says on', async () => {
    const before = createApp({ db } as any);
    const thrown = await before.request('/v1/waha/kill-switch', { method: 'POST', headers: admin, body: JSON.stringify({ enabled: false }) });
    expect(thrown.status).toBe(200);
    expect((await switchRow('waha'))?.state).toBe('disabled');

    process.env.WAHA_KILL_SWITCH = 'false'; // a new process starts from its environment
    const restarted = createApp({ db } as any);
    expect(await channels(restarted)).toEqual({ telegram: true, waha: false });
    const refused = await restarted.request('/v1/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'message', payload: { body: 'hello' } }) });
    expect(refused.status).toBe(503);

    expect((await restarted.request('/v1/waha/kill-switch', { method: 'POST', headers: admin, body: JSON.stringify({ enabled: true }) })).status).toBe(200);
    expect(await channels(createApp({ db } as any))).toEqual({ telegram: true, waha: true });
  });

  it('"poll now" asked of a new Core at once waits for its read of Postgres and asks Telegram nothing', async () => {
    await toggle(createApp({ db } as any), 'telegram', false);
    const realFetch = globalThis.fetch;
    let getUpdates = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
      if (url.includes('/getUpdates')) getUpdates += 1;
      return Response.json({ ok: true, result: [] });
    });
    process.env.TELEGRAM_BOT_TOKEN = [String(700_000_000 + Math.floor(Math.random() * 99_999_999)), ['fixture', 'bot', 'secret'].join('_')].join(':');
    try {
      const restarted = createApp({ db } as any);
      // Asked before anything else has read the switches in this app.
      const polled = await restarted.request('/v1/adapters/telegram/poll-now', { method: 'POST', headers: admin });
      expect(polled.status).toBe(200);
      expect((await polled.json()).updatesProcessed).toBe(0);
      expect(getUpdates).toBe(0);
    } finally {
      spy.mockRestore();
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it('a switch thrown by one running Core is reported by another', async () => {
    const a = createApp({ db } as any);
    const b = createApp({ db } as any);
    expect(await channels(b)).toEqual({ telegram: true, waha: true });
    await toggle(a, 'waha', false);
    expect(await channels(b)).toEqual({ telegram: true, waha: false });
  });
});

describe('while Postgres cannot be read', () => {
  it('the store is not loaded (so the poller stays paused) and loads the thrown switch once Postgres answers', async () => {
    await toggle(createApp({ db } as any), 'telegram', false);
    let failures = 0;
    // The first read fails as a database that is not up yet would; the retry reaches the real one.
    const flaky = new Proxy(db, {
      get(target, prop) {
        if (prop === 'transaction' && failures === 0) {
          failures += 1;
          return () => ({ execute: () => Promise.reject(new Error('connect ECONNREFUSED (fixture)')) });
        }
        // Kysely keeps private fields, so its methods must run on the real object.
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Kysely<Database>;
    const store = createChannelKillSwitchStore(flaky);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.isLoaded()).toBe(false);
    expect(failures).toBe(1);
    await store.loaded;
    expect(store.isLoaded()).toBe(true);
    expect(store.switches.telegram).toBe(true);
  }, 20_000);
});
