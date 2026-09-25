import { describe, expect, it, vi } from 'vitest';
import { handleUpdate, INTAKE_ATTEMPTS, chatInbox, type InboxContext } from '../src/lifecycle/chat-inbox.js';
import { createCoreClient } from '../src/lifecycle/core-client.js';

/**
 * ChatInbox.handleUpdate (Phase 2.1, PHASE2_DESIGN.md section 2.2) hands one update to Core's intake
 * and, when intake keeps failing, dead-letters it. The rules of polled-update-dispatch.ts, now held
 * in Restate's journal instead of a Postgres counter: a deliberate refusal (4xx) is final; five
 * retryable answers park the update; a database outage, a thrown kill switch or a Core that does not
 * answer at all never parks (nothing could be parked or saved then either).
 *
 * The context is a small journal: a step that returned is recorded and replayed, a step that threw
 * is not (Restate retries it), and a "crash" is a thrown handler that is called again on the same
 * journal, as Restate would after a worker restart.
 */
class FakeContext implements InboxContext {
  journal = new Map<string, unknown>();
  sleeps: number[] = [];
  state = new Map<string, unknown>();
  runs: string[] = [];
  constructor(readonly key = '555') {}
  async run<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (this.journal.has(name)) return this.journal.get(name) as T;
    this.runs.push(name);
    const value = await action();
    this.journal.set(name, value);
    return value;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
  }
  crashOnSet = 0;
  set(name: string, value: unknown) {
    if (this.crashOnSet-- > 0) throw new Error('killed');
    this.state.set(name, value);
  }
  async now() { return 1_790_000_000_000; }
}

const update = { update_id: 4242, message: { message_id: 1, date: 1, chat: { id: 555, type: 'private' }, from: { id: 9, is_bot: false, first_name: 'R' }, text: 'a brief' } };
const input = { v: 1 as const, update };

/** Retries a handler the way Restate does: a thrown attempt is run again on the same journal. */
async function untilSettled(ctx: FakeContext, run: () => Promise<unknown>, attempts = 20) {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await run(); } catch (err) { last = err; }
  }
  throw last;
}

function core(answers: Array<() => Promise<any>>) {
  const intake = vi.fn(async () => (answers.shift() ?? (async () => ({ kind: 'done', intakeStatus: 201 })))());
  const park = vi.fn(async () => {});
  return { intake, park };
}

describe('ChatInbox.handleUpdate', () => {
  it('hands the update to intake once and is done', async () => {
    const ctx = new FakeContext();
    const c = core([async () => ({ kind: 'done', intakeStatus: 201 })]);
    expect(await handleUpdate(ctx, input, c)).toMatchObject({ outcome: 'handled', intakeStatus: 201 });
    expect(c.intake).toHaveBeenCalledTimes(1);
    expect(c.intake.mock.calls[0]).toEqual([update, 'legacy']);
    expect(c.park).not.toHaveBeenCalled();
    // The one read of the mode is journaled, so a replay on another colour agrees with it.
    expect(ctx.journal.get('mode')).toBe('legacy');
  });

  it('a deliberate refusal (4xx) is final: no retry, no dead letter', async () => {
    const ctx = new FakeContext();
    const c = core([async () => ({ kind: 'done', intakeStatus: 403 })]);
    expect(await handleUpdate(ctx, input, c)).toMatchObject({ outcome: 'handled', intakeStatus: 403 });
    expect(c.intake).toHaveBeenCalledTimes(1);
    expect(c.park).not.toHaveBeenCalled();
  });

  it(`parks after ${INTAKE_ATTEMPTS} retryable answers, backing off 2, 4, 8 and 16 s between them`, async () => {
    const ctx = new FakeContext();
    const c = core(Array.from({ length: 9 }, () => async () => ({ kind: 'retry', reason: 'intake answered HTTP 500' })));
    expect(await handleUpdate(ctx, input, c)).toMatchObject({ outcome: 'parked' });
    expect(c.intake).toHaveBeenCalledTimes(INTAKE_ATTEMPTS);
    expect(ctx.sleeps).toEqual([2000, 4000, 8000, 16000]);
    expect(c.park).toHaveBeenCalledTimes(1);
    expect(c.park.mock.calls[0][0]).toBe(update);
    expect(String(c.park.mock.calls[0][1])).toMatch(/HTTP 500 after 5 attempts/);
  });

  it('recovers when intake answers before the last attempt', async () => {
    const ctx = new FakeContext();
    const c = core([async () => ({ kind: 'retry', reason: 'HTTP 500' }), async () => ({ kind: 'done', intakeStatus: 201 })]);
    expect(await handleUpdate(ctx, input, c)).toMatchObject({ outcome: 'handled' });
    expect(c.park).not.toHaveBeenCalled();
  });

  it('a database outage never parks: the step is retried until intake answers', async () => {
    const ctx = new FakeContext();
    const down = async () => { throw new Error('intake waits: DATABASE_UNAVAILABLE'); };
    const c = core([down, down, down, down, down, down, down, async () => ({ kind: 'done', intakeStatus: 201 })]);
    expect(await untilSettled(ctx, () => handleUpdate(ctx, input, c))).toMatchObject({ outcome: 'handled' });
    expect(c.intake).toHaveBeenCalledTimes(8);
    expect(c.park).not.toHaveBeenCalled();
    expect(ctx.sleeps).toEqual([]);
  });

  it('a worker killed after intake answered does not call intake again on replay', async () => {
    const ctx = new FakeContext();
    const c = core([async () => ({ kind: 'done', intakeStatus: 201 })]);
    ctx.crashOnSet = 1; // the process dies after the intake step was journaled
    expect(await untilSettled(ctx, () => handleUpdate(ctx, input, c))).toMatchObject({ outcome: 'handled' });
    expect(c.intake).toHaveBeenCalledTimes(1);
  });

  it('parking that fails is retried, and parks once', async () => {
    const ctx = new FakeContext();
    const c = core(Array.from({ length: 5 }, () => async () => ({ kind: 'retry', reason: 'HTTP 500' })));
    let fails = 2;
    c.park.mockImplementation(async () => { if (fails-- > 0) throw new Error('database is down'); });
    expect(await untilSettled(ctx, () => handleUpdate(ctx, input, c))).toMatchObject({ outcome: 'parked' });
    expect(c.intake).toHaveBeenCalledTimes(5);
    expect(ctx.runs.filter((r) => r === 'park')).toHaveLength(3);
  });

  it('is bound as a Virtual Object named ChatInbox, whose handleUpdate keeps idempotency keys for 7 days', () => {
    expect(chatInbox.name).toBe('ChatInbox');
    const options = (chatInbox as any).handlers?.handleUpdate ?? (chatInbox as any).object?.handleUpdate;
    expect(options).toBeTruthy();
  });
});

describe('the Core client ChatInbox uses', () => {
  const token = ['worker', 'fixture', 'token'].join('_');
  const client = (fetcher: (url: string, init: any) => Promise<Response>) =>
    createCoreClient({ baseUrl: 'http://core:3001', token, fetch: fetcher as any, timeoutMs: 1000 });

  it('posts to /v1/internal/telegram/intake with the worker token and the update\'s request id', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const c = client(async (url, init) => { calls.push({ url, init }); return Response.json({ v: 1, kind: 'handled', intakeStatus: 201 }); });
    expect(await c.intake(update, 'legacy')).toEqual({ kind: 'done', intakeStatus: 201, duplicate: false });
    expect(calls[0].url).toBe('http://core:3001/v1/internal/telegram/intake');
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${token}`);
    expect(calls[0].init.headers['x-request-id']).toBe('tg-4242');
    expect(JSON.parse(calls[0].init.body)).toEqual({ v: 1, update, mode: 'legacy' });
  });

  it('classifies intake\'s answers: final, retryable, and waits', async () => {
    const answer = (body: any, status = 200) => client(async () => Response.json(body, { status })).intake(update, 'legacy');
    await expect(answer({ kind: 'handled', intakeStatus: 422 })).resolves.toMatchObject({ kind: 'done', intakeStatus: 422 });
    await expect(answer({ kind: 'handled', intakeStatus: 200, duplicate: true })).resolves.toMatchObject({ kind: 'done', duplicate: true });
    for (const s of [500, 503, 429, 408]) await expect(answer({ kind: 'handled', intakeStatus: s })).resolves.toMatchObject({ kind: 'retry' });
    for (const code of ['DATABASE_UNAVAILABLE', 'INTAKE_PAUSED', 'NOT_CONFIGURED']) {
      await expect(answer({ kind: 'handled', intakeStatus: 503, code })).rejects.toThrow(code);
    }
    // Core's own failure answers: a server error is retryable; its database down waits.
    await expect(answer({ title: 'Internal Server Error' }, 500)).resolves.toMatchObject({ kind: 'retry' });
    await expect(answer({ title: 'Database Unavailable' }, 503)).rejects.toThrow(/Database Unavailable|503/);
    // A refusal of the worker itself (token, route missing from an older Core) is never the update's
    // fault: it waits for a fix instead of dead-lettering a client's message.
    for (const s of [400, 401, 403, 404]) await expect(answer({ title: 'no' }, s)).rejects.toThrow(String(s));
  });

  it('a Core that does not answer at all waits; one that answers too slowly is a retryable answer', async () => {
    await expect(client(async () => { throw new TypeError('fetch failed'); }).intake(update, 'legacy')).rejects.toThrow(/Core/);
    const slow = client(async (_url, init) => new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })))));
    await expect(slow.intake(update, 'legacy')).resolves.toMatchObject({ kind: 'retry' });
  });

  it('parks through /v1/internal/telegram/park and throws until Core has stored it', async () => {
    const calls: any[] = [];
    let ok = false;
    const c = client(async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return ok ? Response.json({ parked: true }) : Response.json({}, { status: 503 }); });
    await expect(c.park(update, 'intake answered HTTP 500 after 5 attempts')).rejects.toThrow();
    ok = true;
    await expect(c.park(update, 'intake answered HTTP 500 after 5 attempts')).resolves.toBeUndefined();
    expect(calls[1]).toEqual({ url: 'http://core:3001/v1/internal/telegram/park', body: { v: 1, update, reason: 'intake answered HTTP 500 after 5 attempts', notifySender: true } });
  });
});

/**
 * Slice 2.3 part C (PHASE2_DESIGN.md 2.2): the per-chat flag is read once, in the journaled `mode`
 * step; a lifecycle chat's state goes to intake with the update and comes back changed; a decision is
 * routed by one-way sends only, each keyed by the update, so replaying the invocation routes nothing
 * that Restate would not deduplicate.
 */
describe('ChatInbox routes intake\'s decisions (slice 2.3)', () => {
  class RoutingContext extends FakeContext {
    routed: Array<{ to: string; key: string; body: any }> = [];
    routes = {
      open: (requestId: string, event: any, key: string) => { this.routed.push({ to: `RequestLifecycle/${requestId}/open`, key, body: event }); },
      answer: (requestId: string, event: any, key: string) => { this.routed.push({ to: `RequestLifecycle/${requestId}/answer`, key, body: event }); },
      requesterDecision: (requestId: string, event: any, key: string) => { this.routed.push({ to: `RequestLifecycle/${requestId}/requesterDecision`, key, body: event }); },
      send: (m: any) => { this.routed.push({ to: `TelegramSender/${m.chatId}/send`, key: m.key, body: m }); },
    };
    async get<T>(name: string): Promise<T | null> { return (this.state.get(name) as T) ?? null; }
  }
  const flagged = { lifecycleChat: (chat: string) => chat === '555' };
  const unflagged = { lifecycleChat: () => false };
  const draft = { title: 'KAAE: evening', rawText: 'KAAE evening', clientId: 'c1000000-0000-4000-8000-000000000002', designInstructions: '', exactCopy: [], autoGenerate: true };
  const decided = (decision: any, chat?: any) => async () => ({ kind: 'done', intakeStatus: 200, decision, ...(chat ? { chat } : {}) });

  it('reads the flag once, journaled: a flagged chat runs intake in mode lifecycle with its state', async () => {
    const ctx = new RoutingContext();
    ctx.state.set('chat', { v: 1, pendingClarification: { rawText: 'make it gold', askedAt: 1_790_000_000_000 - 1000, updateId: 1 } });
    const c = core([decided({ kind: 'new_request', tenantId: '00000000-0000-4000-a000-000000000001', requests: [{ index: 0, draft }] }, {})]);
    expect(await handleUpdate(ctx, input, c, flagged)).toMatchObject({ outcome: 'routed', decision: 'new_request' });
    expect(ctx.journal.get('mode')).toBe('lifecycle');
    expect(c.intake.mock.calls[0]).toEqual([update, 'lifecycle', { pendingClarification: { rawText: 'make it gold', askedAt: 1_790_000_000_000 - 1000, updateId: 1 } }]);
    // The state intake sent back (the question answered, so cleared) is kept.
    expect(ctx.state.get('chat')).toEqual({ v: 1 });
    // An unflagged chat stays legacy, and intake is not sent its state.
    const legacy = new RoutingContext();
    const c2 = core([async () => ({ kind: 'done', intakeStatus: 201 })]);
    await handleUpdate(legacy, input, c2, unflagged);
    expect(legacy.journal.get('mode')).toBe('legacy');
    expect(c2.intake.mock.calls[0]).toEqual([update, 'legacy']);
  });

  it('a new request opens RequestLifecycle at the request id of (chat, update, index), keyed open:<id>; two graphics, two requests', async () => {
    const ctx = new RoutingContext();
    const c = core([decided({ kind: 'new_request', tenantId: '00000000-0000-4000-a000-000000000001', requests: [{ index: 0, draft }, { index: 1, draft: { ...draft, title: 'ckb' } }] }, {})]);
    await handleUpdate(ctx, input, c, flagged);
    const { requestIdFor } = await import('@hawa/domain');
    const ids = [requestIdFor('555', 4242, 0), requestIdFor('555', 4242, 1)];
    expect(ctx.routed.map((r) => [r.to, r.key])).toEqual(ids.map((id) => [`RequestLifecycle/${id}/open`, `open:${id}`]));
    expect(ctx.routed[0].body).toMatchObject({ v: 1, eventId: `open:${ids[0]}`, requestId: ids[0], chatId: '555', origin: { kind: 'telegram', chatId: '555', updateId: 4242 }, draft });
  });

  it('answers, buttons and changes go to their request, keyed by the update, in either mode', async () => {
    const cases = [
      [{ kind: 'answer', requestId: 'r-1', questionId: 'q:t-1', answer: { option: 2 }, callbackQueryId: 'cb-9' }, 'answer', { questionId: 'q:t-1', answer: { option: 2 }, callbackQueryId: 'cb-9', actorId: '9' }],
      [{ kind: 'requester', requestId: 'r-1', taskId: 't-1', action: 'ok', callbackQueryId: 'cb-9', actorId: '9' }, 'requesterDecision', { taskId: 't-1', kind: 'ok', callbackQueryId: 'cb-9' }],
      [{ kind: 'requester', requestId: 'r-1', taskId: 't-1', action: 'ssq', actorId: '9' }, 'requesterDecision', { taskId: 't-1', kind: 'size', sizeAction: 'ssq' }],
      [{ kind: 'change', requestId: 'r-1', replyToTaskId: 't-1', directive: 'make the logo bigger' }, 'requesterDecision', { taskId: 't-1', kind: 'change', directive: 'make the logo bigger', actorId: '9' }],
    ] as const;
    for (const options of [flagged, unflagged]) {
      for (const [decision, handler, body] of cases) {
        const ctx = new RoutingContext();
        await handleUpdate(ctx, input, core([decided(decision)]), options);
        expect(ctx.routed).toHaveLength(1);
        expect(ctx.routed[0]).toMatchObject({ to: `RequestLifecycle/r-1/${handler}`, key: 'tg:555:4242', body: { v: 1, eventId: 'tg:555:4242', ...body } });
      }
    }
  });

  it('a clarify decision keeps the question in the chat\'s state and sends its message; albums older than 15 minutes are forgotten', async () => {
    const ctx = new RoutingContext();
    const now = 1_790_000_000_000;
    ctx.state.set('chat', { v: 1, albumsAcked: { old: now - 16 * 60_000, fresh: now - 60_000 } });
    const remember = { rawText: 'make it gold', askedAt: now, updateId: 4242 };
    const message = { v: 1, key: 'clarify:555:4242', chatId: '555', kind: 'text', text: 'Clarification needed', class: 'courtesy' };
    const c = core([decided({ kind: 'clarify', remember, messages: [message] }, { pendingClarification: remember, albumsAcked: { old: now - 16 * 60_000, fresh: now - 60_000 } })]);
    await handleUpdate(ctx, input, c, flagged);
    // Intake was sent the state without the stale album.
    expect(c.intake.mock.calls[0][2]).toEqual({ albumsAcked: { fresh: now - 60_000 } });
    expect(ctx.state.get('chat')).toEqual({ v: 1, pendingClarification: remember, albumsAcked: { fresh: now - 60_000 } });
    expect(ctx.routed).toEqual([{ to: 'TelegramSender/555/send', key: 'clarify:555:4242', body: message }]);
  });

  it('a worker killed after intake decided routes the same sends with the same keys (Restate keeps the first)', async () => {
    const ctx = new RoutingContext();
    const c = core([decided({ kind: 'change', requestId: 'r-1', replyToTaskId: 't-1', directive: 'bigger' })]);
    ctx.crashOnSet = 1;
    await untilSettled(ctx, () => handleUpdate(ctx, input, c, flagged));
    expect(c.intake).toHaveBeenCalledTimes(1);
    expect(new Set(ctx.routed.map((r) => `${r.to}|${r.key}`)).size).toBe(1);
  });

  it('the Core client passes the chat state in lifecycle mode and reads a decision back', async () => {
    const token = ['worker', 'fixture', 'token'].join('_');
    const calls: any[] = [];
    const decision = { kind: 'answer', requestId: 'r', questionId: 'q:t', answer: { text: 'blue' } };
    const c = createCoreClient({ baseUrl: 'http://core:3001', token, timeoutMs: 1000, fetch: (async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      return Response.json({ v: 1, kind: 'decision', intakeStatus: 200, decision, chat: { albumsAcked: { a: 1 } } });
    }) as any });
    expect(await c.intake(update, 'lifecycle', { albumsAcked: { a: 1 } })).toEqual({ kind: 'done', intakeStatus: 200, decision, chat: { albumsAcked: { a: 1 } } });
    expect(calls[0]).toEqual({ v: 1, update, mode: 'lifecycle', chat: { albumsAcked: { a: 1 } } });
  });
});
