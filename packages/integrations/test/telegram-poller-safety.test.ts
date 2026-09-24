import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramBridgeDaemon, type TelegramUpdate } from '../src/telegram-bridge.js';
import { MemoryTelegramOffsetStorage } from '../src/telegram-security.js';

/**
 * The getUpdates poller (architecture programme 0.4, 2026-09-24): one poll at a time, an offset that
 * never moves past an update intake did not accept, the stored offset used after a restart, and the
 * office kill switch honoured before anything is fetched.
 */
afterEach(() => vi.restoreAllMocks());

const token = ['123456', 'poller', 'fixture'].join(':');
const updates = (...ids: number[]): TelegramUpdate[] => ids.map((id) => ({ update_id: id }) as TelegramUpdate);

/** A fake Telegram that serves `pending` from the requested offset, as getUpdates does. */
function fakeTelegram(pending: TelegramUpdate[], opts: { holdMs?: number } = {}) {
  const offsets: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = String(input);
    if (!url.includes('/getUpdates')) return Response.json({ ok: true, result: { message_id: 1, chat: { id: 1 } } });
    const offset = Number(new URL(url).searchParams.get('offset'));
    offsets.push(offset);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (opts.holdMs) await new Promise((r) => setTimeout(r, opts.holdMs));
      return Response.json({ ok: true, result: pending.filter((u) => u.update_id >= offset) });
    } finally {
      inFlight--;
    }
  });
  return { fetch, offsets, maxInFlight: () => maxInFlight };
}

describe('an update intake did not accept is never skipped', () => {
  it('a 5xx on one update keeps the offset before it, and nothing behind it is handled first', async () => {
    const telegram = fakeTelegram(updates(101, 102, 103));
    const storage = new MemoryTelegramOffsetStorage();
    const bridge = new TelegramBridgeDaemon({ botToken: token, offsetStorage: storage });
    const handled: number[] = [];
    let intakeUp = false;
    const handler = async (u: TelegramUpdate) => {
      if (u.update_id === 102 && !intakeUp) throw new Error('intake answered HTTP 503');
      handled.push(u.update_id);
    };

    expect(await bridge.pollOnce(handler)).toBe(1);
    expect(handled).toEqual([101]);
    expect(await storage.getOffset()).toBe(101);
    expect(bridge.getStatus().lastError?.code).toBe('TELEGRAM_UPDATE_NOT_ACCEPTED');

    // Still failing: asked for again from 102, and 103 waits behind it.
    await bridge.pollOnce(handler);
    expect(handled).toEqual([101]);
    expect(await storage.getOffset()).toBe(101);
    expect(telegram.offsets).toEqual([1, 102]);

    intakeUp = true;
    expect(await bridge.pollOnce(handler)).toBe(2);
    expect(handled).toEqual([101, 102, 103]);
    expect(await storage.getOffset()).toBe(103);
    expect(bridge.getStatus().lastError).toBeUndefined();
  });

  it('backs off further for an update that keeps failing, although getUpdates itself succeeds', async () => {
    fakeTelegram(updates(7));
    const bridge = new TelegramBridgeDaemon({ botToken: token });
    const failing = async () => { throw new Error('intake answered HTTP 500'); };
    await bridge.pollOnce(failing);
    await bridge.pollOnce(failing);
    expect(bridge.getStatus().degraded).toBe(false);
    await bridge.pollOnce(failing);
    // Three failures in a row: the error count was not reset by the successful fetch in between.
    expect(bridge.getStatus().degraded).toBe(true);
  });

  it('does not advance past an update whose offset could not be stored', async () => {
    fakeTelegram(updates(55));
    const storage = { getOffset: async () => 54, setOffset: vi.fn(async () => { throw new Error('database is down'); }) };
    const bridge = new TelegramBridgeDaemon({ botToken: token, offsetStorage: storage });
    expect(await bridge.pollOnce(async () => {})).toBe(0);
    expect(bridge.getStatus().lastUpdateId).toBe(54);
    expect(bridge.getStatus().lastError?.code).toBe('TELEGRAM_OFFSET_NOT_SAVED');
  });
});

describe('the stored offset survives a restart', () => {
  it('a new bridge on the same store asks Telegram from after the last accepted update', async () => {
    const telegram = fakeTelegram(updates(900, 901));
    const storage = new MemoryTelegramOffsetStorage();
    await new TelegramBridgeDaemon({ botToken: token, offsetStorage: storage }).pollOnce(async () => {});
    const handled: number[] = [];
    const restarted = new TelegramBridgeDaemon({ botToken: token });
    restarted.attachOffsetStorage(storage);
    await restarted.pollOnce(async (u) => { handled.push(u.update_id); });
    expect(telegram.offsets).toEqual([1, 902]);
    expect(handled).toEqual([]);
  });

  it('does not poll at all while the stored offset cannot be read', async () => {
    const telegram = fakeTelegram(updates(1));
    const bridge = new TelegramBridgeDaemon({
      botToken: token,
      offsetStorage: { getOffset: async () => { throw new Error('database is down'); }, setOffset: async () => {} },
    });
    expect(await bridge.pollOnce(async () => {})).toBe(0);
    expect(telegram.fetch).not.toHaveBeenCalled();
    expect(bridge.getStatus().lastError?.code).toBe('TELEGRAM_OFFSET_UNAVAILABLE');
  });
});

describe('one getUpdates at a time', () => {
  it('a manual poll during the background poll waits for it and starts from its offset', async () => {
    const telegram = fakeTelegram(updates(10, 11), { holdMs: 30 });
    const bridge = new TelegramBridgeDaemon({ botToken: token, offsetStorage: new MemoryTelegramOffsetStorage() });
    const handled: number[] = [];
    bridge.useUpdateHandler(async (u) => { handled.push(u.update_id); });
    const [background, manual] = await Promise.all([bridge.pollOnce(), bridge.pollOnce()]);
    expect(telegram.maxInFlight()).toBe(1);
    expect(telegram.offsets).toEqual([1, 12]);
    expect(background + manual).toBe(2);
    expect(handled).toEqual([10, 11]);
  });

  it('a poll that throws does not stop the next one', async () => {
    fakeTelegram(updates(3));
    const bridge = new TelegramBridgeDaemon({ botToken: token });
    const storageFailure = vi.spyOn(bridge as any, 'pollOnceExclusive').mockRejectedValueOnce(new Error('boom'));
    await expect(bridge.pollOnce(async () => {})).rejects.toThrow('boom');
    storageFailure.mockRestore();
    expect(await bridge.pollOnce(async () => {})).toBe(1);
  });
});

describe('the Telegram kill switch stops intake at the poller', () => {
  it('fetches nothing while the switch is on, and resumes from the same offset after', async () => {
    const telegram = fakeTelegram(updates(40));
    const bridge = new TelegramBridgeDaemon({ botToken: token });
    let killed = true;
    bridge.pauseIntakeWhen(() => killed);
    const handled: number[] = [];
    expect(await bridge.pollOnce(async (u) => { handled.push(u.update_id); })).toBe(0);
    expect(telegram.fetch).not.toHaveBeenCalled();
    expect(bridge.getStatus().intakePaused).toBe(true);

    killed = false;
    expect(await bridge.pollOnce(async (u) => { handled.push(u.update_id); })).toBe(1);
    expect(handled).toEqual([40]);
  });

  it('stops handing on a batch the moment the switch is thrown; the rest stays with Telegram', async () => {
    fakeTelegram(updates(60, 61, 62));
    const storage = new MemoryTelegramOffsetStorage();
    const bridge = new TelegramBridgeDaemon({ botToken: token, offsetStorage: storage });
    let killed = false;
    bridge.pauseIntakeWhen(() => killed);
    const handled: number[] = [];
    await bridge.pollOnce(async (u) => { handled.push(u.update_id); killed = true; });
    expect(handled).toEqual([60]);
    expect(await storage.getOffset()).toBe(60);
  });
});
