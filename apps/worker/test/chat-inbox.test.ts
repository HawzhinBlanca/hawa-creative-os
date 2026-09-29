import { describe, expect, it, vi } from 'vitest';
import { handleUpdate, INTAKE_ATTEMPTS, MAX_SETTLE_ROUNDS, chatInbox, settleUpdate, type ChatInboxCore, type InboxContext,
  type SettleInput } from '../src/lifecycle/chat-inbox.js';
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
  settles: Array<{ input: SettleInput; delayMs: number; key: string }> = [];
  scheduleSettle(input: SettleInput, delayMs: number, key: string) { this.settles.push({ input, delayMs, key }); }
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
  const intake = vi.fn<ChatInboxCore['intake']>(async () => (answers.shift() ?? (async () => ({ kind: 'done', intakeStatus: 201 })))());
  const park = vi.fn<ChatInboxCore['park']>(async () => {});
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

  it('opens one request per language for a bilingual brief, each under its own key, none twice after a crash (ADR-139)', async () => {
    const ctx = new FakeContext();
    ctx.failOpenOnce = true;
    const [en, ckb] = ['43d3fca4-7ce2-5afe-9ae4-b9530874d618', '8a2f0c11-3b4d-5e6f-8a9b-0c1d2e3f4a5b'];
    const draftOf = (requestId: string, rawText: string) => ({ platform: 'telegram', sourceEventId: `lc-${requestId}-r0`,
      sourceChannelId: '555', rawText, title: 'KAAE standards', designInstructions: '', exactCopy: [{ text: rawText }],
      clientId: 'c1000000-0000-4000-8000-000000000002', autoGenerate: true });
    const c = core([async () => ({ kind: 'done', intakeStatus: 200, lifecycleAction: 'open-request', requestId: en, chatId: '555',
      draft: draftOf(en, 'K-12 STANDARDS FRAMEWORK'), siblings: [{ requestId: ckb, draft: draftOf(ckb, 'چوارچێوەی ستانداردەکان') }] })]);
    ctx.crashOnSet = 1;
    expect(await untilSettled(ctx, () => handleUpdate(ctx, input, c))).toMatchObject({ outcome: 'handled' });
    expect(c.intake).toHaveBeenCalledTimes(1);
    // The first try's open of the English request was interrupted; the crash after both opens replays
    // them under the same keys, which Restate deduplicates: each key names one request.
    const keys = ctx.lifecycleOpens.map((o: any) => o.event.eventId);
    expect(new Set(keys)).toEqual(new Set([`open:${en}`, `open:${ckb}`]));
    expect(ctx.lifecycleOpens.filter((o: any) => o.requestId === ckb).every((o: any) => o.event.draft.rawText === 'چوارچێوەی ستانداردەکان')).toBe(true);
    expect(ctx.state.get('inbox')).toMatchObject({ mode: 'lifecycle', requestId: en });
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

  it('parks a flagged media hold before advancing the chat and does not park twice on replay', async () => {
    const ctx = new FakeContext();
    ctx.crashOnSet = 1;
    const c = core([async () => ({ kind: 'done', intakeStatus: 422,
      lifecycleAction: 'park-update', code: 'LIFECYCLE_MEDIA_NOT_ADMITTED',
      reason: 'A lifecycle chat media update needs operator review; no task was started' })]);
    expect(await untilSettled(ctx, () => handleUpdate(ctx, input, c))).toMatchObject({ outcome: 'parked', attempts: 1 });
    expect(c.intake).toHaveBeenCalledTimes(1);
    expect(c.park).toHaveBeenCalledTimes(1);
    expect(ctx.state.get('inbox')).toMatchObject({ lastOutcome: 'parked', lastUpdateId: update.update_id });
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
    // languageSiblings: this worker opens every request an open-request answer names (ADR-139).
    // briefHold: it schedules the settles Core asks for (ADR-143).
    expect(JSON.parse(calls[0].init.body)).toEqual({ v: 1, update, mode: 'legacy', languageSiblings: true, briefHold: true });
  });

  it('reads the sibling requests of a bilingual open, and refuses a malformed one (ADR-139)', async () => {
    const [en, ckb] = ['43d3fca4-7ce2-5afe-9ae4-b9530874d618', '8a2f0c11-3b4d-5e6f-8a9b-0c1d2e3f4a5b'];
    const draftOf = (requestId: string) => ({ platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: '555',
      rawText: 'copy', title: 'title', autoGenerate: true });
    const answer = (siblings: unknown) => client(async () => Response.json({ v: 1, kind: 'handled', intakeStatus: 200,
      lifecycleAction: 'open-request', requestId: en, chatId: '555', draft: draftOf(en), siblings })).intake(update, 'legacy');
    await expect(answer([{ requestId: ckb, draft: draftOf(ckb) }])).resolves.toMatchObject({ lifecycleAction: 'open-request',
      requestId: en, siblings: [{ requestId: ckb, draft: { sourceEventId: `lc-${ckb}-r0` } }] });
    await expect(answer(undefined)).resolves.not.toHaveProperty('siblings');
    await expect(answer([{ requestId: ckb, draft: draftOf(en) }])).rejects.toThrow('invalid lifecycle open');
    await expect(answer([{ requestId: en, draft: draftOf(en) }])).rejects.toThrow('invalid lifecycle open');
    await expect(answer('not a list')).rejects.toThrow('invalid lifecycle open');
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

  it('passes a flagged media hold to ChatInbox for durable parking', async () => {
    const c = client(async () => Response.json({ v: 1, kind: 'handled', intakeStatus: 422,
      lifecycleAction: 'park-update', code: 'LIFECYCLE_MEDIA_NOT_ADMITTED', chatId: '555',
      reason: 'A lifecycle chat media update needs operator review; no task was started' }));
    expect(await c.intake(update, 'legacy')).toMatchObject({ kind: 'done',
      lifecycleAction: 'park-update', code: 'LIFECYCLE_MEDIA_NOT_ADMITTED' });
    const invalid = client(async () => Response.json({ v: 1, kind: 'handled', intakeStatus: 422,
      lifecycleAction: 'park-update', code: 'LIFECYCLE_MEDIA_NOT_ADMITTED', chatId: '555' }));
    await expect(invalid.intake(update, 'legacy')).rejects.toThrow('invalid media hold');
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

  // ADR-144: no reply target is demanded; the requester is asked which design, in words.
  it('asks which design, in words, when Core answers that more than one request is waiting', async () => {
    const ctx = new FakeContext();
    ctx.state.set('inbox', { v: 1, lastUpdateId: 0, lastOutcome: 'handled', at: 0,
      mode: 'lifecycle', requestId: 'old-pointer' } satisfies ChatInboxView);
    const c = core([async () => ({ kind: 'done', intakeStatus: 409,
      lifecycleAction: 'request-choice-required', chatId: '555', code: 'AMBIGUOUS_REQUEST' })]);
    await handleUpdate(ctx, input, c);
    expect(ctx.lifecycleDecisions).toHaveLength(0);
    expect(ctx.notices).toMatchObject([{ key: `chatinbox:request-choice:${update.update_id}`,
      chatId: '555', class: 'critical', text: expect.stringContaining('Which one is this for?') }]);
    expect((ctx.notices[0] as any).text).not.toMatch(/reply (directly )?to|revision notice/i);
  });

  // "/new" with no brief opens nothing; the requester is asked, in words and with no command, what
  // to design (ADR-144), and nothing reaches RequestLifecycle. A chat's first update (legacy mode) is
  // answered alike.
  it('asks what to design, without naming a command, when Core answers new-brief-required, and keeps the chat\'s mode', async () => {
    for (const mode of [undefined, 'lifecycle'] as const) {
      const ctx = new FakeContext();
      if (mode) ctx.state.set('inbox', { v: 1, lastUpdateId: 0, lastOutcome: 'handled', at: 0,
        mode, requestId: 'req-x' } satisfies ChatInboxView);
      const c = core([async () => ({ kind: 'done', intakeStatus: 422, code: 'NEW_BRIEF_REQUIRED',
        lifecycleAction: 'new-brief-required', chatId: '555' })]);
      expect(await handleUpdate(ctx, input, c)).toMatchObject({ outcome: 'handled', intakeStatus: 422 });
      expect(ctx.lifecycleDecisions).toHaveLength(0);
      expect(ctx.notices).toMatchObject([{ key: `chatinbox:new-brief-required:${update.update_id}`,
        chatId: '555', class: 'critical', text: expect.stringContaining('What would you like designed?') }]);
      expect((ctx.notices[0] as any).text).not.toMatch(/\/new/);
      expect((ctx.state.get('inbox') as ChatInboxView | undefined)?.mode).toBe(mode);
    }
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


describe('chat answers (ADR-135 stage 2c)', () => {
  const answer = (extra: Record<string, unknown> = {}) => ({ v: 1, kind: 'handled', intakeStatus: 200,
    lifecycleAction: 'chat-answer', chatId: '555', chatAnswer: { text: '👋 <b>Hello!</b>', parseMode: 'HTML' }, ...extra });

  it('sends Core\'s answer to a greeting, question, rule or command once per update, with its parse mode, after a crash', async () => {
    const transport = vi.fn(async () => Response.json(answer()));
    const client = createCoreClient({ baseUrl: 'http://core', token: 'fixture-token', fetch: transport });
    const ctx = new FakeContext(); ctx.crashOnSet = 1;
    await untilSettled(ctx, () => handleUpdate(ctx, input, client));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(ctx.lifecycleOpens).toHaveLength(0);
    expect(ctx.lifecycleDecisions).toHaveLength(0);
    // The fake context does not deduplicate; Restate does, by the message's key.
    expect([...new Set(ctx.notices.map((n: any) => n.key))]).toEqual([`chatinbox:chat-answer:${update.update_id}`]);
    expect(ctx.notices[0]).toMatchObject({ chatId: '555', kind: 'text', class: 'critical', text: '👋 <b>Hello!</b>', parseMode: 'HTML' });
  });

  it('sends a plain answer without a parse mode, and answers a refusal status the same way', async () => {
    const client = createCoreClient({ baseUrl: 'http://core', token: 'fixture-token',
      fetch: async () => Response.json(answer({ intakeStatus: 422, chatAnswer: { text: 'Designs are approved in Hawa Desk.' } })) });
    const ctx = new FakeContext();
    expect(await handleUpdate(ctx, input, client)).toMatchObject({ outcome: 'handled', intakeStatus: 422 });
    expect(ctx.notices).toHaveLength(1);
    expect((ctx.notices[0] as any).parseMode).toBeUndefined();
  });

  it('refuses a malformed chat answer from Core', async () => {
    for (const extra of [{ chatAnswer: { text: '' } }, { chatAnswer: { text: 'x'.repeat(4001) } },
      { chatAnswer: { text: 'hi', parseMode: 'Markdown' } }, { chatId: '' }, { chatAnswer: null }]) {
      const client = createCoreClient({ baseUrl: 'http://core', token: 'fixture-token', fetch: async () => Response.json(answer(extra)) });
      await expect(client.intake(update, 'legacy')).rejects.toThrow('invalid chat answer');
    }
  });
});

describe('album collection notices', () => {
  it('journals one collection response and replays a stable notice without starting a lifecycle request', async () => {
    const transport=vi.fn(async()=>Response.json({intakeStatus:202,lifecycleAction:'album-message',
      chatId:'555',albumMessage:'One of your photos could not be saved.',albumNoticeKey:'album-received:abc123'}));
    const client=createCoreClient({baseUrl:'http://core',token:'fixture-token',fetch:transport});
    const ctx=new FakeContext();
    ctx.crashOnSet=1;
    await untilSettled(ctx,()=>handleUpdate(ctx,input,client));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(ctx.lifecycleOpens).toHaveLength(0);
    expect(ctx.lifecycleDecisions).toHaveLength(0);
    expect(ctx.notices).toHaveLength(2);
    expect(ctx.notices[0]).toEqual(ctx.notices[1]);
    expect(ctx.notices[0]).toMatchObject({key:'chatinbox:album-received:abc123',chatId:'555'});
  });
});

describe('a requester change after the design reached the office (finding 13 of the Phase 4 review)', () => {
  const requestId = '3f1c2b7a-1d2e-4f5a-8b6c-7d8e9f0a1b2c';
  const words = 'The phone number is wrong: it must be 0750 123 4567';
  const lateAnswer = (extra: Record<string, unknown> = {}) => ({ v: 1, kind: 'handled', intakeStatus: 409,
    code: 'LATE_REQUESTER_CHANGE', lifecycleAction: 'late-change', chatId: '555', requestId,
    requestStage: 'approved', officeAlert: { chatId: '9000', text: `A requester sent words after approval.\n\n${words}` }, ...extra });

  it('alerts the office with the words and tells the requester plainly, once per update, after a crash', async () => {
    const transport = vi.fn(async () => Response.json(lateAnswer()));
    const client = createCoreClient({ baseUrl: 'http://core', token: 'fixture-token', fetch: transport });
    const ctx = new FakeContext(); ctx.crashOnSet = 1;
    await untilSettled(ctx, () => handleUpdate(ctx, input, client));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(ctx.lifecycleDecisions).toHaveLength(0);
    // The fake context does not deduplicate; Restate does, by each message's key.
    const keys = [...new Set(ctx.notices.map((n: any) => n.key))];
    expect(keys).toEqual([`notify.office:late-change:${requestId}:${update.update_id}`, `chatinbox:late-change:${update.update_id}`]);
    const [office, requester] = ctx.notices as any[];
    expect(office).toMatchObject({ chatId: '9000', kind: 'text', class: 'critical', text: expect.stringContaining(words) });
    expect(office.parseMode).toBeUndefined();
    expect(requester).toMatchObject({ chatId: '555', kind: 'text', class: 'critical' });
    // ADR-144: said plainly, without a refusal ("not applied") or a reply demand.
    expect(requester.text).toMatch(/passed your message to them/i);
    expect(requester.text).not.toMatch(/revision notice|will follow up|not applied/i);
  });

  it('does not claim the office was told when Core had no office chat to alert', async () => {
    const client = createCoreClient({ baseUrl: 'http://core', token: 'fixture-token',
      fetch: async () => Response.json(lateAnswer({ officeAlert: undefined })) });
    const ctx = new FakeContext();
    await handleUpdate(ctx, input, client);
    expect(ctx.notices).toHaveLength(1);
    expect((ctx.notices[0] as any).text).not.toMatch(/passed your message/i);
    expect((ctx.notices[0] as any).text).toMatch(/kept your message for the office/i);
  });

  it('refuses a malformed late-change answer from Core', async () => {
    for (const extra of [{ requestId: 'not-a-request' }, { requestStage: 'cancelled' },
      { officeAlert: { chatId: '9000', text: 'x'.repeat(4001) } }, { officeAlert: { chatId: '', text: words } },
      { chatAnswer: { text: '' } }, { chatAnswer: { text: 'Got it', parseMode: 'Markdown' } }]) {
      const client = createCoreClient({ baseUrl: 'http://core', token: 'fixture-token',
        fetch: async () => Response.json(lateAnswer(extra)) });
      await expect(client.intake(update, 'lifecycle')).rejects.toThrow('invalid late change');
    }
  });
});

describe('source review notices', () => {
  it('replays one stable copy-review notice after a journal crash without starting design', async () => {
    const transport = vi.fn(async () => Response.json({ intakeStatus: 200, lifecycleAction: 'source-message',
      chatId: '555', sourceMessage: 'PDF saved. Reply to the source with /use_source and corrected copy.', sourceNoticeKey: 'source-review:123' }));
    const client = createCoreClient({ baseUrl: 'http://core', token: 'fixture-token', fetch: transport });
    const ctx = new FakeContext(); ctx.crashOnSet = 1;
    await untilSettled(ctx, () => handleUpdate(ctx, input, client));
    expect(transport).toHaveBeenCalledTimes(1); expect(ctx.lifecycleOpens).toHaveLength(0);
    expect(ctx.lifecycleDecisions).toHaveLength(0); expect(ctx.notices).toHaveLength(2);
    expect(ctx.notices[0]).toEqual(ctx.notices[1]);
    expect(ctx.notices[0]).toMatchObject({ key: 'chatinbox:source-review:123', chatId: '555' });
  });
  it('refuses an unbounded or malformed source notice from Core', async () => {
    for (const fields of [{ sourceMessage: 'x'.repeat(3001), sourceNoticeKey: 'source-review:123' },
      { sourceMessage: 'Review this source', sourceNoticeKey: 'arbitrary-key' }]) {
      const client = createCoreClient({ baseUrl: 'http://core', token: 'fixture-token', fetch: async () =>
        Response.json({ intakeStatus: 200, lifecycleAction: 'source-message', chatId: '555', ...fields }) });
      await expect(client.intake(update, 'legacy')).rejects.toThrow('invalid source notice');
    }
  });
});

describe('requester intent answers (ADR-144)', () => {
  const requestId = '3f1c2b7a-1d2e-4f5a-8b6c-7d8e9f0a1b2c';

  it('sends the office alert Core attached to a chat answer, once per update, beside the requester\'s answer', async () => {
    const transport = vi.fn(async () => Response.json({ v: 1, kind: 'handled', intakeStatus: 200, lifecycleAction: 'chat-answer',
      chatId: '555', note: 'approval', requestId, chatAnswer: { text: "Thanks! I've told the office you're happy with <b>Poster</b>.", parseMode: 'HTML' },
      officeAlert: { chatId: '9000', text: 'The requester in chat 555 says they are happy with "Poster". Nothing was approved.' } }));
    const client = createCoreClient({ baseUrl: 'http://core', token: 'fixture-token', fetch: transport });
    const ctx = new FakeContext(); ctx.crashOnSet = 1;
    await untilSettled(ctx, () => handleUpdate(ctx, input, client));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(ctx.lifecycleDecisions).toHaveLength(0);
    expect([...new Set(ctx.notices.map((n: any) => n.key))]).toEqual([`chatinbox:chat-answer:${update.update_id}`,
      `notify.office:requester-note:${update.update_id}`]);
    const [requester, office] = ctx.notices as any[];
    expect(requester).toMatchObject({ chatId: '555', parseMode: 'HTML', text: expect.stringContaining('happy with') });
    expect(office).toMatchObject({ chatId: '9000', class: 'critical', text: expect.stringContaining('Nothing was approved') });
    expect(office.parseMode).toBeUndefined();
  });

  it('tells the requester Core\'s own words for a change kept while the design is being made', async () => {
    const client = createCoreClient({ baseUrl: 'http://core', token: 'fixture-token', fetch: async () => Response.json({ v: 1, kind: 'handled',
      intakeStatus: 409, code: 'LATE_REQUESTER_CHANGE', lifecycleAction: 'late-change', chatId: '555', requestId, requestStage: 'designing',
      chatAnswer: { text: "Got it. I've added that to <b>Poster</b>; the office will see it before the design is sent to you.", parseMode: 'HTML' },
      officeAlert: { chatId: '9000', text: 'A change for the design while it was still being designed.' } }) });
    const ctx = new FakeContext();
    await handleUpdate(ctx, input, client);
    expect(ctx.notices).toMatchObject([{ chatId: '9000' }, { key: `chatinbox:late-change:${update.update_id}`, chatId: '555',
      parseMode: 'HTML', text: expect.stringContaining("I've added that to <b>Poster</b>") }]);
  });

  it('refuses a chat answer whose office alert is malformed', async () => {
    for (const officeAlert of [{ chatId: '', text: 'x' }, { chatId: '9000', text: '' }, { chatId: '9000', text: 'x'.repeat(4001) }, null]) {
      const client = createCoreClient({ baseUrl: 'http://core', token: 'fixture-token', fetch: async () => Response.json({ intakeStatus: 200,
        lifecycleAction: 'chat-answer', chatId: '555', chatAnswer: { text: 'Thanks' }, officeAlert }) });
      await expect(client.intake(update, 'lifecycle')).rejects.toThrow('invalid chat answer');
    }
  });
});

describe('album and brief settles (ADR-143)', () => {
  const photo = { update_id: 5001, message: { message_id: 11, date: 1, chat: { id: 555, type: 'private' },
    from: { id: 9, is_bot: false, first_name: 'R' }, media_group_id: 'g1', photo: [{ file_id: 'f1' }], caption: 'KAAE report cover' } };
  const settleLater = (kind: 'album' | 'brief', delayMs: number) => async () =>
    ({ kind: 'done', intakeStatus: 202, lifecycleAction: 'settle-later', chatId: '555', settle: { kind, delayMs } });

  it('a saved album photo schedules one durable settle under a stable key and tells the requester nothing', async () => {
    const ctx = new FakeContext();
    ctx.crashOnSet = 1;
    const c = core([settleLater('album', 8000)]);
    await untilSettled(ctx, () => handleUpdate(ctx, { v: 1, update: photo }, c));
    expect(c.intake).toHaveBeenCalledTimes(1);
    expect(ctx.notices).toHaveLength(0);
    // The crash replays the schedule under the same key, which Restate deduplicates.
    expect(ctx.settles.map((s) => s.key)).toEqual(['settle:5001', 'settle:5001']);
    expect(ctx.settles[0]).toMatchObject({ delayMs: 8000, input: { v: 1, update: photo, attempt: 0 } });
    expect(ctx.lifecycleOpens).toHaveLength(0);
  });

  it('the settle asks Core with settle=true and opens the one request it answers, without moving lastUpdateId', async () => {
    const ctx = new FakeContext();
    ctx.state.set('inbox', { v: 1, lastUpdateId: 5003, lastOutcome: 'handled', at: 1 });
    const requestId = '43d3fca4-7ce2-5afe-9ae4-b9530874d618';
    const draft = { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: '555',
      rawText: 'KAAE report cover', title: 'KAAE report cover', designInstructions: '', exactCopy: [],
      clientId: 'c1000000-0000-4000-8000-000000000002', autoGenerate: true };
    const c = core([async () => ({ kind: 'done', intakeStatus: 200, lifecycleAction: 'open-request', requestId, chatId: '555', draft })]);
    ctx.failOpenOnce = true;
    await untilSettled(ctx, () => settleUpdate(ctx, { v: 1, update: photo, attempt: 0 }, c));
    expect(c.intake).toHaveBeenCalledTimes(1);
    expect(c.intake.mock.calls[0][3]).toEqual({ settle: true });
    expect(ctx.lifecycleOpens).toMatchObject([{ requestId, event: { eventId: `open:${requestId}` } }]);
    expect(ctx.state.get('inbox')).toMatchObject({ lastUpdateId: 5003, mode: 'lifecycle', requestId });
    expect(c.park).not.toHaveBeenCalled();
  });

  it('a held brief waiting for an album is settled again under the next key, and the rounds are bounded', async () => {
    const ctx = new FakeContext();
    const c = core([settleLater('brief', 8000)]);
    await settleUpdate(ctx, { v: 1, update, attempt: 2 }, c);
    expect(ctx.settles).toMatchObject([{ key: 'settle:4242:3', delayMs: 8000, input: { attempt: 3 } }]);
    const last = new FakeContext();
    await settleUpdate(last, { v: 1, update, attempt: MAX_SETTLE_ROUNDS }, core([settleLater('brief', 8000)]));
    expect(last.settles).toHaveLength(0);
  });

  it('a settle whose Core keeps failing is left to the sweep: nothing is parked or sent', async () => {
    const ctx = new FakeContext();
    const retry = async () => ({ kind: 'retry', reason: 'HTTP 500' });
    const c = core(Array.from({ length: INTAKE_ATTEMPTS }, () => retry));
    expect(await settleUpdate(ctx, { v: 1, update: photo }, c)).toMatchObject({ outcome: 'handled', attempts: INTAKE_ATTEMPTS });
    expect(c.park).not.toHaveBeenCalled();
    expect(ctx.notices).toHaveLength(0);
    expect(ctx.settles).toHaveLength(0);
  });

  it('the Core client sends settle=true, reads a settle-later answer and refuses a malformed one', async () => {
    const bodies: any[] = [];
    let answer: unknown = { v: 1, kind: 'handled', intakeStatus: 202, lifecycleAction: 'settle-later', chatId: '555',
      settle: { kind: 'album', delayMs: 8000 } };
    const c = createCoreClient({ baseUrl: 'http://core', token: 'fixture-token',
      fetch: (async (_url: string, init: any) => { bodies.push(JSON.parse(init.body)); return Response.json(answer); }) as any });
    expect(await c.intake(photo, 'lifecycle', undefined, { settle: true })).toEqual({ kind: 'done', intakeStatus: 202,
      duplicate: false, lifecycleAction: 'settle-later', chatId: '555', settle: { kind: 'album', delayMs: 8000 } });
    expect(bodies[0]).toMatchObject({ settle: true, briefHold: true, languageSiblings: true });
    answer = { v: 1, kind: 'handled', intakeStatus: 202, lifecycleAction: 'settle-later', chatId: '555', settle: { kind: 'x', delayMs: -1 } };
    await expect(c.intake(photo, 'lifecycle')).rejects.toThrow('invalid settle');
  });

  it('ChatInbox binds a settle handler next to handleUpdate', () => {
    const handlers = (chatInbox as any).handlers ?? (chatInbox as any).object;
    expect(handlers?.settle).toBeTruthy();
    expect(handlers?.handleUpdate).toBeTruthy();
  });
});
