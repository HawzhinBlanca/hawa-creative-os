import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createStreamTicketStore, STREAM_TICKET_TTL_MS, MAX_TICKETS_PER_CREDENTIAL } from '../src/services/stream-tickets.js';

/**
 * Architecture programme 1.5 (ADR-037, 2026-09-24): the session token leaves the stream's address.
 *
 * The Desk opened `/v1/events/stream?access_token=<24-hour session token>`, because EventSource cannot
 * send a header; the token then sat in every access log and proxy between the browser and Core. Now it
 * asks `POST /v1/auth/stream-ticket` with its bearer header for a ticket that opens one stream, once,
 * within 60 s, and that no other route accepts. No database: sessions are the in-memory ones.
 */

const json = { 'Content-Type': 'application/json' };

async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request('/v1/auth/session', { method: 'POST', headers: json, body: JSON.stringify({ key: process.env.HAWA_DEV_TOKEN }) });
  expect(res.status).toBe(201);
  return (await res.json()).token;
}

async function ticketFor(app: ReturnType<typeof createApp>, token: string) {
  const res = await app.request('/v1/auth/stream-ticket', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, cacheControl: res.headers.get('cache-control'), body: await res.json() };
}

/** Opens the stream and closes it again at once; the status and content type are all this needs. */
async function openStream(app: ReturnType<typeof createApp>, query: string, headers: Record<string, string> = {}) {
  const res = await app.request(`/v1/events/stream${query}`, { headers });
  const type = res.headers.get('content-type') || '';
  await res.body?.cancel().catch(() => undefined);
  return { status: res.status, type };
}

describe('stream tickets (POST /auth/stream-ticket, GET /events/stream?ticket=)', () => {
  afterEach(() => vi.useRealTimers());

  it('are issued only to a signed-in caller, short-lived and never cached', async () => {
    const app = createApp();
    expect((await app.request('/v1/auth/stream-ticket', { method: 'POST', headers: { 'x-enforce-auth': '1' } })).status).toBe(401);

    const token = await signIn(app);
    const before = Date.now();
    const issued = await ticketFor(app, token);
    expect(issued.status).toBe(201);
    expect(issued.cacheControl).toBe('no-store');
    expect(issued.body.ticket).toMatch(/^hawa_st_[A-Za-z0-9_-]{32}$/);
    expect(issued.body.ticket).not.toContain(token);
    expect(issued.body.expiresAt).toBeGreaterThanOrEqual(before + STREAM_TICKET_TTL_MS);
    expect(issued.body.expiresAt).toBeLessThanOrEqual(Date.now() + STREAM_TICKET_TTL_MS);
  });

  it('opens the stream once: the same ticket is refused the second time', async () => {
    const app = createApp();
    const { body } = await ticketFor(app, await signIn(app));
    const first = await openStream(app, `?ticket=${encodeURIComponent(body.ticket)}`, { 'x-enforce-auth': '1' });
    expect(first.status).toBe(200);
    expect(first.type).toContain('text/event-stream');
    expect((await openStream(app, `?ticket=${encodeURIComponent(body.ticket)}`, { 'x-enforce-auth': '1' })).status).toBe(401);
  });

  it('expires 60 s after it was issued, unused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T10:00:00Z'));
    const app = createApp();
    const token = await signIn(app);
    const early = (await ticketFor(app, token)).body.ticket;
    const late = (await ticketFor(app, token)).body.ticket;
    vi.setSystemTime(new Date('2026-09-24T10:00:59Z'));
    expect((await openStream(app, `?ticket=${early}`, { 'x-enforce-auth': '1' })).status).toBe(200);
    vi.setSystemTime(new Date('2026-09-24T10:01:00Z'));
    expect((await openStream(app, `?ticket=${late}`, { 'x-enforce-auth': '1' })).status).toBe(401);
  });

  it('is refused for a session that ended after the ticket was issued', async () => {
    const app = createApp();
    const token = await signIn(app);
    const { body } = await ticketFor(app, token);
    await app.request('/v1/auth/session', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect((await openStream(app, `?ticket=${body.ticket}`, { 'x-enforce-auth': '1' })).status).toBe(401);
  });

  it('is accepted by the stream only: no other route, as a query parameter or as a bearer token', async () => {
    const app = createApp();
    const token = await signIn(app);
    const ticket = (await ticketFor(app, token)).body.ticket;
    const enforce = { 'x-enforce-auth': '1' };
    expect((await app.request(`/v1/tasks?ticket=${ticket}`, { headers: enforce })).status).toBe(401);
    expect((await app.request(`/v1/auth/session?ticket=${ticket}`, { headers: enforce })).status).toBe(401);
    expect((await app.request('/v1/tasks', { headers: { Authorization: `Bearer ${ticket}` } })).status).toBe(401);
    expect((await app.request('/v1/auth/stream-ticket', { method: 'POST', headers: { Authorization: `Bearer ${ticket}` } })).status).toBe(401);
    // None of those spent it.
    expect((await openStream(app, `?ticket=${ticket}`, enforce)).status).toBe(200);
  });

  it('replaces the session token in the address: ?access_token= no longer opens the stream', async () => {
    const app = createApp();
    const token = await signIn(app);
    expect((await openStream(app, `?access_token=${encodeURIComponent(token)}`, { 'x-enforce-auth': '1' })).status).toBe(401);
    // A header still works, for clients that can send one.
    expect((await openStream(app, '', { Authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it('a made-up ticket is refused, with no fallback to whatever else the request carries', async () => {
    const app = createApp({ testAuth: { principal: { role: 'operator' } } } as any);
    expect((await openStream(app, '?ticket=hawa_st_madeup')).status).toBe(401);
    expect((await openStream(app, '?ticket=')).status).toBe(401);
  });
});

describe('a stream whose session ends', () => {
  // With ADR-037 a stream that looks open means the Desk does not poll. A stream left open after its
  // session ended would leave an idle tab with a frozen queue and no way to sign-in; ending it makes
  // the browser reconnect, meet the 401 on the next ticket and show sign-in.
  it('is closed at the next heartbeat', async () => {
    const app = createApp();
    const token = await signIn(app);
    const { body } = await ticketFor(app, token);
    const res = await app.request(`/v1/events/stream?ticket=${encodeURIComponent(body.ticket)}`, { headers: { 'x-enforce-auth': '1' } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // system:connected
    await app.request('/v1/auth/session', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    const ended = await Promise.race([
      (async () => {
        for (;;) {
          const r = await reader.read();
          if (r.done) return true;
        }
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
    ]);
    expect(ended).toBe(true);
    await reader.cancel().catch(() => undefined);
  }, 30_000);
});

describe('the ticket store', () => {
  it('redeems a ticket once, for the credential it was issued with, and not after it expires', () => {
    let now = 1_000;
    const store = createStreamTicketStore({ ttlMs: 60_000, now: () => now });
    const a = store.issue('hawa_sess_a');
    const b = store.issue('hawa_sess_b');
    expect(a.expiresAt).toBe(61_000);
    expect(store.outstanding()).toBe(2);
    expect(store.redeem(a.ticket)).toBe('hawa_sess_a');
    expect(store.redeem(a.ticket)).toBeUndefined();
    now = 61_000;
    expect(store.redeem(b.ticket)).toBeUndefined();
    expect(store.outstanding()).toBe(0);
    expect(store.redeem(undefined)).toBeUndefined();
    expect(store.redeem('hawa_sess_a')).toBeUndefined();
  });

  it('lets one session asking in a loop spend only its own tickets, never another session\'s', () => {
    const store = createStreamTicketStore();
    const other = store.issue('hawa_sess_other');
    const own = Array.from({ length: 20_000 }, () => store.issue('hawa_sess_loop').ticket);
    expect(store.outstanding()).toBe(MAX_TICKETS_PER_CREDENTIAL + 1);
    expect(store.redeem(other.ticket)).toBe('hawa_sess_other');
    // Its newest tickets still work; its oldest were dropped.
    expect(store.redeem(own[own.length - 1])).toBe('hawa_sess_loop');
    expect(store.redeem(own[0])).toBeUndefined();
  });
});
