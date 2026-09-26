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
  stateReads: string[] = [];
  inRun = false;
  lifecycleDecisions: Array<{ requestId: string; event: unknown }> = [];
  lifecycleOpens: Array<{ requestId: string; event: unknown }> = [];
  notices: unknown[] = [];
  failDecisionOnce = false;
  failOpenOnce = false;
  constructor(readonly key = '555') {}
  async get<T>(name: string): Promise<T | null> {
    if (this.inRun) throw new Error('Restate state access must not be nested in a run action');
    this.stateReads.push(name);
    return (this.state.get(name) as T) ?? null;
  }
  async run<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (this.journal.has(name)) return this.journal.get(name) as T;
    this.runs.push(name);
    this.inRun = true;
    let value: T;
    try { value = await action(); } finally { this.inRun = false; }
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
  async sendLifecycleDecision(requestId: string, event: unknown) {
    if (this.failDecisionOnce) {
      this.failDecisionOnce = false;
      throw new Error('decision dispatch interrupted');
    }
    this.lifecycleDecisions.push({ requestId, event });
  }
  async sendLifecycleOpen(requestId: string, event: any) {
    if (this.failOpenOnce) {
      this.failOpenOnce = false;
      throw new Error('open dispatch interrupted');
    }
    this.lifecycleOpens.push({ requestId, event });
  }
  sendNotice(message: unknown) { this.notices.push(message); }
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
  it('dispatches a prepared first brief under a stable open key and recovers after send interruption', async () => {
    const ctx = new FakeContext();
    ctx.failOpenOnce = true;
    const requestId = '43d3fca4-7ce2-5afe-9ae4-b9530874d618';
    const draft = { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`,
      sourceChannelId: '555', rawText: 'KAAE event', title: 'KAAE event',
      designInstructions: '', exactCopy: [{ text: 'KAAE event' }],
      clientId: 'c1000000-0000-4000-8000-000000000002', autoGenerate: true };
    const c = core([async () => ({ kind: 'done', intakeStatus: 200,
      lifecycleAction: 'open-request', requestId, chatId: '555', draft })]);
    expect(await untilSettled(ctx, () => handleUpdate(ctx, input, c))).toMatchObject({ outcome: 'handled' });
    expect(c.intake).toHaveBeenCalledTimes(1);
    expect(ctx.lifecycleOpens).toMatchObject([{ requestId, event: {
      eventId: `open:${requestId}`, requestId, chatId: '555', draft } }]);
    expect(ctx.state.get('inbox')).toMatchObject({ mode: 'lifecycle', requestId });
  });

  it('hands the update to intake once and is done', async () => {
    const ctx = new FakeContext();
    const c = core([async () => ({ kind: 'done', intakeStatus: 201 })]);
    expect(await handleUpdate(ctx, input, c)).toMatchObject({ outcome: 'handled', intakeStatus: 201 });
    expect(c.intake).toHaveBeenCalledTimes(1);
    expect(c.intake.mock.calls[0]).toEqual([update, 'legacy', undefined]);
    expect(c.park).not.toHaveBeenCalled();
    expect(ctx.stateReads).toEqual(['inbox']);
    expect(ctx.runs).toEqual(['intake-0']);
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

  it('passes Core’s request-choice action through to the fenced chat notice', async () => {
    const c = client(async () => Response.json({ v: 1, kind: 'handled', intakeStatus: 409,
      lifecycleAction: 'request-choice-required', code: 'AMBIGUOUS_REQUEST', chatId: '555' }));
    expect(await c.intake(update, 'lifecycle', 'old-pointer')).toMatchObject({
      kind: 'done', lifecycleAction: 'request-choice-required', code: 'AMBIGUOUS_REQUEST', chatId: '555' });
  });

  it('passes a blocked revision through as an actionable final refusal', async () => {
    const c = client(async () => Response.json({ v: 1, kind: 'handled', intakeStatus: 409,
      lifecycleAction: 'revision-blocked', code: 'PARENT_BRIEF_MISSING', chatId: '555' }));
    expect(await c.intake(update, 'lifecycle')).toMatchObject({
      kind: 'done', lifecycleAction: 'revision-blocked', code: 'PARENT_BRIEF_MISSING', chatId: '555' });
  });

  it('passes a verified clarification answer to the same request', async () => {
    const c = client(async () => Response.json({ v: 1, kind: 'handled', intakeStatus: 200,
      lifecycleAction: 'requester-answer', requestId: 'req-x', newTaskId: 'task-new',
      priorTaskId: 'task-old', round: 2, directive: 'Yes', questionId: 'question-x', chatId: '555' }));
    expect(await c.intake(update, 'lifecycle')).toMatchObject({ kind: 'done',
      lifecycleAction: 'requester-answer', questionId: 'question-x' });
    const ctx = new FakeContext();
    ctx.state.set('inbox', { v: 1, lastUpdateId: 0, lastOutcome: 'handled', at: 0,
      mode: 'lifecycle', requestId: 'old-pointer' } satisfies ChatInboxView);
    await handleUpdate(ctx, input, c);
    expect(ctx.lifecycleDecisions).toMatchObject([{ requestId: 'req-x',
      event: { questionId: 'question-x', round: 2, newTaskId: 'task-new' } }]);
    expect(ctx.notices).toMatchObject([{ key: `chatinbox:answer-accepted:${update.update_id}`,
      chatId: '555', class: 'critical', text: expect.stringContaining('same design') }]);
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

// ─── setMode and per-chat mode cutover ───────────────────────────────────────
import { setMode, type SetModeContext, type ChatInboxView } from '../src/lifecycle/chat-inbox.js';

describe('ChatInbox.setMode', () => {
  function fakeCtx(initial?: ChatInboxView): SetModeContext & { stored: ChatInboxView | null } {
    let stored: ChatInboxView | null = initial ?? null;
    return {
      get stored() { return stored; },
      async get<T>(name: string): Promise<T | null> { return name === 'inbox' ? stored as unknown as T : null; },
      set(_name: string, value: unknown) { stored = value as ChatInboxView; },
    };
  }

  it('sets mode to lifecycle on a fresh chat with no prior inbox', async () => {
    const ctx = fakeCtx();
    const result = await setMode(ctx, 'req-1');
    expect(result).toEqual({ mode: 'lifecycle', requestId: 'req-1' });
    expect(ctx.stored).toMatchObject({ mode: 'lifecycle', v: 1 });
  });

  it('is idempotent: calling it twice returns lifecycle and does not change the stored view', async () => {
    const ctx = fakeCtx({ v: 1, lastUpdateId: 42, lastOutcome: 'handled', at: 100, mode: 'lifecycle' });
    const result = await setMode(ctx, 'req-2');
    expect(result).toEqual({ mode: 'lifecycle', requestId: 'req-2' });
    // stored view is unchanged (the early-return path skips set)
    expect(ctx.stored).toMatchObject({ lastUpdateId: 42, at: 100 });
  });

  it('preserves prior inbox fields when upgrading a legacy chat', async () => {
    const ctx = fakeCtx({ v: 1, lastUpdateId: 7, lastOutcome: 'handled', lastIntakeStatus: 201, at: 999 });
    await setMode(ctx, 'req-3');
    expect(ctx.stored).toMatchObject({ v: 1, lastUpdateId: 7, lastIntakeStatus: 201, at: 999, mode: 'lifecycle' });
  });

  it('handleUpdate reads lifecycle mode from stored ChatInboxView on a new invocation', async () => {
    const ctx = new FakeContext();
    // Simulate: a prior setMode stored 'lifecycle' in the inbox state
    ctx.state.set('inbox', { v: 1, lastUpdateId: 0, lastOutcome: 'handled', at: 0, mode: 'lifecycle', requestId: 'req-x' } satisfies ChatInboxView);
    const c = core([async () => ({ kind: 'done', intakeStatus: 201 })]);
    await handleUpdate(ctx, input, c);
    // Restate journals the direct state read without nesting it in a run action.
    expect(ctx.stateReads).toEqual(['inbox']);
    expect(ctx.runs).toEqual(['intake-0']);
    // Core's intake should have been called with mode='lifecycle'
    expect(c.intake.mock.calls[0][1]).toBe('lifecycle');
    expect(ctx.state.get('inbox')).toMatchObject({ mode: 'lifecycle', requestId: 'req-x' });
  });

  it('keeps lifecycle routing across updates and retries a decision send from the journaled intake answer', async () => {
    const ctx = new FakeContext();
    ctx.state.set('inbox', { v: 1, lastUpdateId: 0, lastOutcome: 'handled', at: 0,
      mode: 'lifecycle', requestId: 'req-x' } satisfies ChatInboxView);
    const answer = { kind: 'done' as const, intakeStatus: 200, lifecycleAction: 'requester-revision' as const,
      requestId: 'req-x', newTaskId: 'task-new', round: 1, directive: 'Move the venue',
      priorTaskId: 'task-old' };
    const c = core([async () => answer, async () => ({ kind: 'done', intakeStatus: 200 })]);
    ctx.failDecisionOnce = true;
    await expect(handleUpdate(ctx, input, c)).rejects.toThrow('decision dispatch interrupted');
    expect(c.intake).toHaveBeenCalledTimes(1);
    expect(ctx.state.get('inbox')).toMatchObject({ mode: 'lifecycle', requestId: 'req-x', lastUpdateId: 0 });
    await handleUpdate(ctx, input, c);
    expect(c.intake).toHaveBeenCalledTimes(1);
    expect(ctx.lifecycleDecisions).toMatchObject([{ requestId: 'req-x',
      event: { eventId: `chatinbox:revision:${update.update_id}`, newTaskId: 'task-new' } }]);
    expect(ctx.state.get('inbox')).toMatchObject({ mode: 'lifecycle', requestId: 'req-x', lastUpdateId: update.update_id });

    // A new Restate invocation gets a fresh journal but the same persisted chat state.
    ctx.journal.clear();
    const next = { v: 1 as const, update: { ...update, update_id: update.update_id + 1 } };
    await handleUpdate(ctx, next, c);
    expect(c.intake.mock.calls[1]).toEqual([next.update, 'lifecycle', 'req-x']);
    expect(ctx.state.get('inbox')).toMatchObject({ mode: 'lifecycle', requestId: 'req-x', lastUpdateId: next.update.update_id });
  });

  it('keeps lifecycle mode when an update is parked', async () => {
    const ctx = new FakeContext();
    ctx.state.set('inbox', { v: 1, lastUpdateId: 0, lastOutcome: 'handled', at: 0,
      mode: 'lifecycle', requestId: 'req-x' } satisfies ChatInboxView);
    const c = core(Array.from({ length: INTAKE_ATTEMPTS }, () => async () => ({ kind: 'retry', reason: 'Core busy' })));
    expect(await handleUpdate(ctx, input, c)).toMatchObject({ outcome: 'parked' });
    expect(ctx.state.get('inbox')).toMatchObject({ mode: 'lifecycle', requestId: 'req-x', lastOutcome: 'parked' });
  });

  it('asks for a specific reply when more than one request is waiting', async () => {
    const ctx = new FakeContext();
    ctx.state.set('inbox', { v: 1, lastUpdateId: 0, lastOutcome: 'handled', at: 0,
      mode: 'lifecycle', requestId: 'old-pointer' } satisfies ChatInboxView);
    const c = core([async () => ({ kind: 'done', intakeStatus: 409,
      lifecycleAction: 'request-choice-required', chatId: '555', code: 'AMBIGUOUS_REQUEST' })]);
    await handleUpdate(ctx, input, c);
    expect(ctx.lifecycleDecisions).toHaveLength(0);
    expect(ctx.notices).toMatchObject([{ key: `chatinbox:request-choice:${update.update_id}`,
      chatId: '555', class: 'critical', text: expect.stringContaining('reply directly') }]);
  });

  it('tells the sender when a revision cannot start under the daily limit', async () => {
    const ctx = new FakeContext();
    ctx.state.set('inbox', { v: 1, lastUpdateId: 0, lastOutcome: 'handled', at: 0,
      mode: 'lifecycle', requestId: 'req-x' } satisfies ChatInboxView);
    const c = core([async () => ({ kind: 'done', intakeStatus: 409,
      lifecycleAction: 'revision-blocked', chatId: '555', code: 'DAILY_CAP_REACHED' })]);
    await handleUpdate(ctx, input, c);
    expect(ctx.lifecycleDecisions).toHaveLength(0);
    expect(ctx.notices).toMatchObject([{ key: `chatinbox:revision-blocked:${update.update_id}`,
      chatId: '555', class: 'critical', text: expect.stringContaining('No revision started') }]);
  });
});
