import { describe, expect, it, vi } from 'vitest';
import {
  TelegramPoller,
  chatKey,
  pollerConfigFromEnv,
  runPoller,
  type PollerOffsets,
} from '../src/lifecycle/telegram-poller.js';
import { LiveColourGate } from '../src/live-colour.js';

/**
 * Phase 2.1 (PHASE2_DESIGN.md section 2.2): the worker polls Telegram and hands each update to the
 * chat's ChatInbox through Restate's ingress, with idempotency key tg-<update_id>, and moves the
 * stored offset past an update only once Restate has accepted it. A fake Telegram and a fake ingress
 * stand in for both; the ingress deduplicates by key as Restate does.
 */
const BOT = ['7000001', 'poller_fixture'].join(':');
const INGRESS = 'http://restate:8080';

const text = (id: number, chat: number, words = 'a brief') => ({ update_id: id, message: { message_id: id, date: 1, from: { id: 9100001, is_bot: false, first_name: 'R' }, chat: { id: chat, type: 'private' }, text: words } });

class Fakes {
  queue: any[] = [];
  getUpdates: Array<{ offset: number; timeout: number }> = [];
  enqueued: Array<{ url: string; key: string | null; body: any }> = [];
  /** Idempotency keys Restate has accepted: a second send with one is answered as before, not run again. */
  invocations = new Map<string, number>();
  ingressStatus: (n: number) => number = () => 202;
  telegramAnswer: ((offset: number) => Response) | null = null;
  fetch = vi.fn(async (url: string, init: any = {}): Promise<Response> => {
    const u = new URL(url);
    if (u.hostname === 'api.telegram.org') {
      const offset = Number(u.searchParams.get('offset'));
      this.getUpdates.push({ offset, timeout: Number(u.searchParams.get('timeout')) });
      if (this.telegramAnswer) return this.telegramAnswer(offset);
      this.queue = this.queue.filter((x) => x.update_id >= offset);
      return Response.json({ ok: true, result: this.queue });
    }
    if (url.startsWith(INGRESS)) {
      const body = JSON.parse(init.body);
      const key = init.headers?.['idempotency-key'] ?? null;
      this.enqueued.push({ url, key, body });
      const status = this.ingressStatus(this.enqueued.length);
      if (status < 300 && key && !this.invocations.has(key)) this.invocations.set(key, this.invocations.size + 1);
      return Response.json({ invocationId: `inv-${key}` }, { status });
    }
    throw new TypeError(`fetch failed: ${url}`);
  });
}

function offsets(start = 0): PollerOffsets & { value: number; failNext: number; sets: number[] } {
  const o = {
    value: start,
    failNext: 0,
    sets: [] as number[],
    async getOffset() { return o.value; },
    async setOffset(n: number) {
      if (o.failNext > 0) { o.failNext--; throw new Error('database is down'); }
      o.sets.push(n);
      o.value = Math.max(o.value, n);
    },
  };
  return o;
}

function poller(fakes: Fakes, store = offsets(), killSwitch: () => Promise<boolean> = async () => false) {
  return new TelegramPoller({ botToken: BOT, ingressUrl: INGRESS, offsets: store, killSwitch, fetch: fakes.fetch as any, killSwitchCacheMs: 0, log: { info() {}, warn() {}, error() {} } });
}

describe('chatKey: which ChatInbox an update goes to', () => {
  it('is the chat of the message, edited message, channel post or button, else the sender, else misc', () => {
    expect(chatKey(text(1, 555))).toBe('555');
    expect(chatKey({ update_id: 2, edited_message: { chat: { id: -100123 } } })).toBe('-100123');
    expect(chatKey({ update_id: 3, channel_post: { chat: { id: -100777 } } })).toBe('-100777');
    expect(chatKey({ update_id: 4, callback_query: { from: { id: 42 }, message: { chat: { id: 888 } } } })).toBe('888');
    expect(chatKey({ update_id: 5, callback_query: { from: { id: 42 } } })).toBe('42');
    expect(chatKey({ update_id: 6, my_chat_member: {} })).toBe('misc');
  });
});

describe('the worker poller', () => {
  it('sends each update to its chat\'s ChatInbox with key tg-<update_id> and advances the offset only after Restate accepted it', async () => {
    const fakes = new Fakes();
    fakes.queue = [text(101, 555), text(102, 666)];
    const store = offsets(100);
    const result = await poller(fakes, store).pollOnce();
    expect(result).toMatchObject({ polled: 2, enqueued: 2 });
    expect(fakes.getUpdates[0]).toEqual({ offset: 101, timeout: 25 });
    expect(fakes.enqueued.map((e) => [e.url, e.key])).toEqual([
      [`${INGRESS}/ChatInbox/555/handleUpdate/send`, 'tg-101'],
      [`${INGRESS}/ChatInbox/666/handleUpdate/send`, 'tg-102'],
    ]);
    expect(fakes.enqueued[0].body).toMatchObject({ v: 1, update: { update_id: 101 } });
    expect(store.sets).toEqual([101, 102]);
  });

  it('stops the batch at an update Restate did not accept, without moving past it', async () => {
    const fakes = new Fakes();
    fakes.queue = [text(201, 1), text(202, 2), text(203, 3)];
    fakes.ingressStatus = (n) => (n === 2 ? 503 : 202);
    const store = offsets(200);
    const p = poller(fakes, store);
    const first = await p.pollOnce();
    expect(first.enqueued).toBe(1);
    expect(first.error).toMatch(/503/);
    expect(store.sets).toEqual([201]);
    // The next poll asks again from 202, and nothing behind it went first.
    await p.pollOnce();
    expect(fakes.getUpdates[1].offset).toBe(202);
    expect(fakes.enqueued.map((e) => e.key)).toEqual(['tg-201', 'tg-202', 'tg-202', 'tg-203']);
  });

  it('the same update enqueued twice (its offset could not be stored) is one invocation', async () => {
    const fakes = new Fakes();
    fakes.queue = [text(301, 9)];
    const store = offsets(300);
    store.failNext = 1;
    const p = poller(fakes, store);
    expect((await p.pollOnce()).error).toMatch(/offset/i);
    expect(store.value).toBe(300);
    expect((await p.pollOnce()).enqueued).toBe(1);
    expect(fakes.enqueued.map((e) => e.key)).toEqual(['tg-301', 'tg-301']);
    expect(fakes.invocations.size).toBe(1);
    expect(store.value).toBe(301);
  });

  it('asks Telegram for nothing while the office kill switch is thrown, or while it cannot be read', async () => {
    const fakes = new Fakes();
    fakes.queue = [text(401, 1)];
    expect((await poller(fakes, offsets(400), async () => true).pollOnce()).paused).toBe('kill_switch');
    expect((await poller(fakes, offsets(400), async () => { throw new Error('database is down'); }).pollOnce()).paused).toBe('kill_switch_unknown');
    expect(fakes.getUpdates).toEqual([]);
    expect(fakes.enqueued).toEqual([]);
  });

  it('stops handing on a batch when the switch is thrown in the middle of it', async () => {
    const fakes = new Fakes();
    fakes.queue = [text(451, 1), text(452, 2)];
    let thrown = false;
    const store = offsets(450);
    const p = poller(fakes, store, async () => thrown);
    fakes.ingressStatus = () => { thrown = true; return 202; };
    const result = await p.pollOnce();
    expect(result).toMatchObject({ enqueued: 1, paused: 'kill_switch' });
    expect(store.value).toBe(451);
  });

  it('waits Telegram\'s retry_after on a 429 from getUpdates', async () => {
    const fakes = new Fakes();
    fakes.telegramAnswer = () => Response.json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }, { status: 429 });
    expect(await poller(fakes).pollOnce()).toMatchObject({ polled: 0, retryAfterMs: 7000 });
  });

  it('starts from the stored offset, so a colour taking over never asks for what the other one handed on', async () => {
    const fakes = new Fakes();
    const store = offsets(500);
    const p = poller(fakes, store);
    await p.pollOnce();
    store.value = 520; // the other colour moved it on
    await p.pollOnce();
    expect(fakes.getUpdates.map((g) => g.offset)).toEqual([501, 521]);
  });

  it('does not poll without the stored offset', async () => {
    const fakes = new Fakes();
    const store = offsets(0);
    store.getOffset = async () => { throw new Error('database is down'); };
    expect((await poller(fakes, store).pollOnce()).error).toMatch(/offset/i);
    expect(fakes.getUpdates).toEqual([]);
  });
});

describe('runPoller: only the live colour polls', () => {
  it('polls while live and stops polling when it is not', async () => {
    let live = true;
    const pollOnce = vi.fn(async () => ({ polled: 0, enqueued: 0 }));
    const sleeps: number[] = [];
    let turns = 0;
    const handle = runPoller({ pollOnce } as any, {
      gate: { isLive: async () => live },
      sleep: async (ms) => {
        sleeps.push(ms);
        if (++turns === 3) live = false;
        if (turns === 6) handle.stop();
      },
    });
    await handle.done;
    expect(pollOnce).toHaveBeenCalledTimes(3);
  });

  it('backs off after errors and honours retry_after', async () => {
    const answers = [{ polled: 0, enqueued: 0, error: 'HTTP_502' }, { polled: 0, enqueued: 0, error: 'HTTP_502' }, { polled: 0, enqueued: 0, retryAfterMs: 7000 }, { polled: 1, enqueued: 1 }];
    const sleeps: number[] = [];
    const handle = runPoller({ pollOnce: async () => answers.shift() ?? (handle.stop(), { polled: 0, enqueued: 0 }) } as any, {
      gate: { isLive: async () => true },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    await handle.done;
    expect(sleeps.slice(0, 4)).toEqual([2000, 4000, 7000, 0]);
  });

  it('the ChatInbox gate asks Restate where ChatInbox is served', async () => {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      asked.push(new URL(url).pathname);
      if (url.endsWith('/services/ChatInbox')) return Response.json({ deployment_id: 'dp_1' });
      if (url.endsWith('/deployments/dp_1')) return Response.json({ uri: 'http://worker-blue:9080/' });
      if (url.endsWith('/deployments')) return Response.json({ deployments: [{ uri: 'http://worker-blue:9080/' }] });
      return new Response('', { status: 404 });
    };
    const gate = new LiveColourGate({ adminUrl: 'http://restate:9070', selfUri: 'http://worker-blue:9080', fetcher: fetcher as any, service: 'ChatInbox', takeoverMs: 30_000 });
    expect(await gate.isLive()).toBe(true);
    expect(asked[0]).toBe('/services/ChatInbox');
  });
});

describe('pollerConfigFromEnv', () => {
  const base = { HAWA_TELEGRAM_POLLER: 'worker', TELEGRAM_BOT_TOKEN: BOT, RESTATE_INGRESS_URL: INGRESS, HAWA_WORKER_TOKEN: ['wk', 'fixture'].join('_'), DATABASE_URL: 'postgresql://x@db/hawa_test' };

  it('is off unless HAWA_TELEGRAM_POLLER=worker (Core polls by default)', () => {
    expect(pollerConfigFromEnv({}).mode).toBe('off');
    expect(pollerConfigFromEnv({ ...base, HAWA_TELEGRAM_POLLER: 'core' }).mode).toBe('off');
    expect(pollerConfigFromEnv(base)).toMatchObject({ mode: 'on', botToken: BOT, ingressUrl: INGRESS });
  });

  it('refuses to start without HAWA_WORKER_TOKEN, the bot token, the ingress or a database', () => {
    for (const missing of ['HAWA_WORKER_TOKEN', 'TELEGRAM_BOT_TOKEN', 'RESTATE_INGRESS_URL', 'DATABASE_URL'] as const) {
      const env: Record<string, string> = { ...base };
      delete env[missing];
      const config = pollerConfigFromEnv(env);
      expect(config.mode).toBe('misconfigured');
      expect((config as { reason: string }).reason).toContain(missing);
    }
    expect(pollerConfigFromEnv({ ...base, HAWA_WORKER_TOKEN: '   ' }).mode).toBe('misconfigured');
  });
});
