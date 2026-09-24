import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventStream } from '../src/services/eventStream.js';
import { clearAuthToken, setAuthToken } from '../src/services/auth.js';
import { json } from './support/desk-harness.js';

/**
 * ADR-037 (2026-09-24): the Desk's event stream no longer carries the session token in its address.
 * It asks Core for a one-use ticket with the bearer header, opens the stream with `?ticket=`, and asks
 * for a new ticket on every reconnect (Core refuses a used one: apps/core/test/stream-ticket.test.ts).
 */

class FakeEventSource {
  static opened: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.opened.push(this);
  }
  addEventListener() {}
  close() {
    this.closed = true;
  }
}

describe('the event stream opens with a ticket (services/eventStream.ts)', () => {
  afterEach(() => {
    eventStream.disconnect();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearAuthToken();
    FakeEventSource.opened = [];
  });

  it('asks for a ticket with the bearer header and puts only the ticket in the address, a new one per connection', async () => {
    vi.useFakeTimers();
    const session = ['hawa', 'sess', 'secret'].join('_');
    setAuthToken(session);
    let n = 0;
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => json({ ticket: `hawa_st_ticket${++n}`, expiresAt: Date.now() + 60_000 }, 201));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('EventSource', FakeEventSource);

    eventStream.connect();
    eventStream.connect(); // a second call while the ticket is on its way opens nothing more
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/v1/auth/stream-ticket');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${session}`);
    expect(FakeEventSource.opened.map((s) => s.url)).toEqual(['/v1/events/stream?ticket=hawa_st_ticket1']);
    expect(FakeEventSource.opened[0].url).not.toContain(session);
    expect(FakeEventSource.opened[0].url).not.toContain('access_token');

    // The stream drops: the reconnect asks for a new ticket.
    FakeEventSource.opened[0].onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.opened.map((s) => s.url)).toEqual(['/v1/events/stream?ticket=hawa_st_ticket1', '/v1/events/stream?ticket=hawa_st_ticket2']);
  });

  it('opens nothing when it is disconnected while the ticket is on its way', async () => {
    vi.useFakeTimers();
    setAuthToken(['hawa', 'sess', 'x'].join('_'));
    vi.stubGlobal('fetch', vi.fn(async () => json({ ticket: 'hawa_st_late', expiresAt: 0 }, 201)));
    vi.stubGlobal('EventSource', FakeEventSource);
    eventStream.connect();
    eventStream.disconnect();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeEventSource.opened).toEqual([]);
    expect(eventStream.getStatus()).toBe('disconnected');
  });

  it('retries with backoff when no ticket is issued (a session that ended is noticed by the session check)', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => json({ title: 'Unauthorized', detail: 'Sign in to Hawa first' }, 401));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('EventSource', FakeEventSource);
    eventStream.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(eventStream.getStatus()).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.opened).toEqual([]);
  });
});
