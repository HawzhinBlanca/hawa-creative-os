import { describe, expect, it } from 'vitest';
import * as restate from '@restatedev/restate-sdk';
import type { OpenEvent } from '@hawa/contracts';
import { designRunId } from '@hawa/contracts';
import { requestIdFor } from '@hawa/domain';
import { FakeObjectContext } from '../../../packages/testkit/src/fake-restate-context.js';
import { handleLifecycleEvent, lifecycleConfigFromEnv, reminderScaleFrom } from '../src/lifecycle/request-lifecycle.js';
import { CLIENT, DAY, LifecycleWorld, OFFICE, START, TENANT, type CrashPlan } from './lifecycle-harness.js';

/**
 * The RequestLifecycle object's shell (architecture programme Phase 2, slice 2.3 part B;
 * PHASE2_DESIGN.md 2.3, 2.7 and section 3 "Handler"): the handlers run on a fake Restate context
 * that journals what they do, against a fake Core with Core's projection rules. A request goes from
 * its brief to a draft, reminders and its expiry; then every invocation of that life is crashed after
 * every journal entry (and inside every projection step, after Core took it) and replayed, and the
 * outcome must be the uninterrupted one: the same projections, each applied once; the same sends,
 * each journaled once; the same messages; the same state.
 */
const CHAT = '9300101';
const HOUR = 3_600_000;

function openEvent(chat: string, update: number, overrides: Partial<OpenEvent> = {}): OpenEvent {
  const requestId = requestIdFor(chat, update);
  return {
    v: 1, eventId: `open:${requestId}`, requestId, tenantId: TENANT, chatId: chat,
    origin: { kind: 'telegram', chatId: chat, updateId: update },
    draft: { title: 'Staff meeting', rawText: 'Staff meeting Sunday 10:00', clientId: CLIENT, designInstructions: '', exactCopy: [], autoGenerate: true },
    ...overrides,
  };
}

const DRAFT_READY = { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAF_one' };

/** open → design → draft → day-1 and day-5 reminders → expiry after 14 days. */
async function draftToExpiry(w: LifecycleWorld): Promise<string> {
  const ev = openEvent(CHAT, 700001);
  await w.invoke('open', ev.requestId, ev);
  await w.deliver();
  const taskId = `${ev.requestId}-t0`;
  await w.finishRun(ev.requestId, designRunId(taskId), 0, taskId, DRAFT_READY);
  await w.advance(DAY + HOUR);
  await w.advance(4 * DAY);
  await w.advance(9 * DAY);
  return ev.requestId;
}

/** open → design → a question → the answer three days later → the next round's design starts. */
async function questionAnswered(w: LifecycleWorld): Promise<string> {
  const ev = openEvent(CHAT, 700002);
  await w.invoke('open', ev.requestId, ev);
  await w.deliver();
  const taskId = `${ev.requestId}-t0`;
  await w.finishRun(ev.requestId, designRunId(taskId), 0, taskId, { status: 'NEEDS_CLARIFICATION' });
  await w.advance(3 * DAY);
  const answer = { v: 1, eventId: `answer:${CHAT}:700050`, questionId: `q-${taskId}`, answer: { option: 2 }, callbackQueryId: 'cbq-1', actorId: 'telegram:42' };
  await w.invoke('answer', ev.requestId, answer);
  await w.deliver();
  return ev.requestId;
}

describe('RequestLifecycle: a request from its brief to a draft, reminders and expiry', () => {
  it('projects each step once, sends the draft and two reminders, and expires after 14 days', async () => {
    const w = new LifecycleWorld();
    const requestId = await draftToExpiry(w);
    const taskId = `${requestId}-t0`;

    expect(w.core.applied.map((p) => [p.key, p.expectedRev, p.ops.map((o) => o.op).join('+')])).toEqual([
      [`${requestId}:1:open`, 0, 'createRequest'],
      [`${requestId}:2:designFinished`, 1, 'recordOutcome'],
      [`${requestId}:3:messageSent`, 2, 'recordDraftSent'],
      [`${requestId}:4:remind`, 3, 'composeReminder'],
      [`${requestId}:5:remind`, 4, 'composeReminder'],
      [`${requestId}:6:expire`, 5, 'transition'],
    ]);
    expect(w.telegram.map((m) => m.text)).toEqual([
      'Got it: your request is in.',
      'Your draft is ready.',
      'Reminder, day 1: your draft is waiting.',
      'Reminder, day 5: your draft is waiting.',
    ]);
    expect(w.telegram.every((m) => m.chatId === CHAT)).toBe(true);
    expect(w.runs).toEqual([{ runId: `dr-${taskId}`, input: { v: 1, taskId, tenantId: TENANT, lifecycle: { requestId, round: 0, runId: `dr-${taskId}` } } }]);

    // Delayed self-sends: day 1 and day 5 at the next office moment, the expiry 14 days after the send.
    const delayed = w.rawSends.filter((s) => s.delayMs > 0).map((s) => [s.service, s.handler, s.delayMs, s.idempotencyKey]);
    expect(delayed).toEqual([
      ['RequestLifecycle', 'remind', DAY, `remind:${requestId}:draft:1:${taskId}`],
      ['RequestLifecycle', 'expire', 14 * DAY, `expire:${requestId}:1`],
      // Scheduled by the day-1 reminder when it ran, a day after the draft was sent.
      ['RequestLifecycle', 'remind', 4 * DAY, `remind:${requestId}:draft:5:${taskId}`],
    ]);

    const s = w.stateOf(requestId)!;
    expect(s.stage).toBe('expired');
    expect(s.rev).toBe(6);
    expect(s.reminders).toEqual([`draft:1:${taskId}`, `draft:5:${taskId}`]);
    expect(s.draft).toMatchObject({ taskId, revisionId: `rev-${taskId}`, sentAt: START });
    expect(s.rounds[0].runInvocationId).toMatch(/^inv_DesignRun_/);
    expect(w.failures).toEqual([]);
  });

  it('an answer given three days later continues the request with a new round', async () => {
    const w = new LifecycleWorld();
    const requestId = await questionAnswered(w);
    const s = w.stateOf(requestId)!;
    expect(s.stage).toBe('designing');
    expect(s.round).toBe(1);
    expect(s.question).toBeUndefined();
    expect(w.runs.map((r) => r.runId)).toEqual([`dr-${requestId}-t0`, `dr-${requestId}-t1`]);
    expect(w.core.applied.map((p) => p.ops.map((o) => o.op).join('+'))).toEqual(['createRequest', 'recordOutcome', 'recordQuestionSent', 'composeReminder', 'createRound+closeQuestion']);
    // The tapped button is answered (a courtesy send to the chat's TelegramSender).
    expect(w.telegram.filter((m) => m.kind === 'callback_answer').map((m) => [m.chatId, m.callbackQueryId, m.class])).toEqual([[CHAT, 'cbq-1', 'courtesy']]);
  });
});

describe('RequestLifecycle: crashed after any journal entry and replayed, the outcome is the same', () => {
  for (const [name, scenario] of [['draft, reminders, expiry', draftToExpiry], ['question answered days later', questionAnswered]] as const) {
    it(`${name}: every invocation, every entry, and inside every projection step`, async () => {
      const baseline = new LifecycleWorld();
      const requestId = await scenario(baseline);
      const expected = baseline.snapshot(requestId);
      expect(baseline.journals.length).toBeGreaterThan(4);

      const plans: CrashPlan[] = [];
      baseline.journals.forEach((j, invocation) => {
        for (let k = 1; k <= j.entries; k++) plans.push({ invocation, afterEntry: k });
        for (const step of j.steps.filter((n) => n.startsWith('project:'))) plans.push({ invocation, inStep: step });
      });
      expect(plans.length).toBeGreaterThan(40);

      for (const plan of plans) {
        const w = new LifecycleWorld(plan);
        await scenario(w);
        const got = w.snapshot(requestId);
        expect(got, `crash ${JSON.stringify(plan)} (${baseline.journals[plan.invocation].handler})`).toEqual(expected);
        // A projection Core took before the crash was asked for again under the same key and replayed.
        if (plan.inStep) expect(w.core.calls).toBe(baseline.core.calls + 1);
      }
    });
  }
});

describe('RequestLifecycle: delayed events after the stage moved', () => {
  it('a reminder and the expiry scheduled for a draft do nothing once a change is being made', async () => {
    const w = new LifecycleWorld();
    const ev = openEvent(CHAT, 700003);
    const requestId = ev.requestId;
    const t0 = `${requestId}-t0`;
    await w.invoke('open', requestId, ev);
    await w.deliver();
    await w.finishRun(requestId, designRunId(t0), 0, t0, DRAFT_READY);
    expect(w.stateOf(requestId)!.draft?.sentAt).toBe(START);

    // The requester replies with a change two hours later: a new round, designing.
    await w.advance(2 * HOUR);
    await w.invoke('requesterDecision', requestId, { v: 1, eventId: `rq:${CHAT}:700060`, taskId: t0, kind: 'change', directive: 'Make the logo bigger', actorId: 'telegram:42' });
    await w.deliver();
    const moved = w.stateOf(requestId)!;
    expect(moved.stage).toBe('designing');
    const appliedBefore = w.core.applied.length;
    const callsBefore = w.core.calls;
    const telegramBefore = w.telegram.length;

    // Day 1, day 5 and the expiry all come due: each is taken and does nothing.
    await w.advance(15 * DAY);
    const handled = w.journals.slice(-2).map((j) => j.handler);
    expect(handled).toEqual(['remind', 'expire']);
    expect(w.core.applied.length).toBe(appliedBefore);
    expect(w.core.calls).toBe(callsBefore);
    expect(w.telegram.length).toBe(telegramBefore);
    const after = w.stateOf(requestId)!;
    expect(after.stage).toBe('designing');
    expect(after.reminders).toEqual([]);
    // Nothing further was scheduled by the stale reminder (no day-5 send).
    expect(w.rawSends.filter((s) => s.handler === 'remind').map((s) => s.idempotencyKey)).toEqual([`remind:${requestId}:draft:1:${t0}`]);

    // The new round's draft gets reminders of its own, under the new stage epoch.
    const t1 = `${requestId}-t1`;
    await w.finishRun(requestId, designRunId(t1), 1, t1, DRAFT_READY);
    await w.advance(DAY + HOUR);
    const reminders = w.telegram.filter((m) => /Reminder/.test(m.text ?? ''));
    expect(reminders).toHaveLength(1);
    expect(w.stateOf(requestId)!.reminders).toEqual([`draft:1:${t1}`]);
  });
});

describe('RequestLifecycle: when Core cannot take a projection', () => {
  it('a design outcome Core does not take is kept, the requester and office are told once, and it is projected again later under its first key', async () => {
    const w = new LifecycleWorld();
    const ev = openEvent(CHAT, 700004);
    const requestId = ev.requestId;
    const t0 = `${requestId}-t0`;
    await w.invoke('open', requestId, ev);
    await w.deliver();
    w.core.down = true;
    await w.finishRun(requestId, designRunId(t0), 0, t0, DRAFT_READY);
    const deferred = w.stateOf(requestId)!;
    expect(deferred.stage).toBe('designing');
    expect(deferred.outcomeDeferred).toMatchObject({ runId: designRunId(t0), attempts: 1, projection: { key: `${requestId}:2:designFinished`, expectedRev: 1, rev: 2 } });
    expect(w.telegram.map((m) => [m.chatId, m.key])).toEqual([
      [CHAT, `${requestId}:1:msg:0`],
      [CHAT, `${requestId}:outcome-unrecorded:${designRunId(t0)}`],
      [OFFICE, `notify.office:outcome-unrecorded:${designRunId(t0)}`],
    ]);
    expect(w.rawSends.filter((s) => s.handler === 'retryProjection').map((s) => s.delayMs)).toEqual([10 * 60_000]);

    w.core.down = false;
    await w.advance(10 * 60_000);
    const s = w.stateOf(requestId)!;
    expect(s.stage).toBe('in_review');
    expect(s.outcomeDeferred).toBeUndefined();
    expect(w.core.applied.map((p) => p.key)).toEqual([`${requestId}:1:open`, `${requestId}:2:designFinished`, `${requestId}:3:messageSent`]);
    expect(w.telegram.filter((m) => m.text === 'Your draft is ready.')).toHaveLength(1);
  });

  it('AHEAD: takes Postgres\'s revision, tells the office once, and projects the event again', async () => {
    const w = new LifecycleWorld();
    const ev = openEvent(CHAT, 700005);
    const requestId = ev.requestId;
    const t0 = `${requestId}-t0`;
    await w.invoke('open', requestId, ev);
    await w.deliver();
    w.core.pgRev.set(requestId, 5); // as after a Restate restore: Postgres holds projections the object lost
    await w.finishRun(requestId, designRunId(t0), 0, t0, DRAFT_READY);
    const s = w.stateOf(requestId)!;
    expect(s.stage).toBe('in_review');
    expect(w.core.applied.map((p) => [p.key, p.expectedRev])).toEqual([[`${requestId}:1:open`, 0], [`${requestId}:6:designFinished`, 5], [`${requestId}:7:messageSent`, 6]]);
    expect(w.telegram.filter((m) => m.chatId === OFFICE).map((m) => m.key)).toEqual([`lc-ahead:${requestId}:5`]);
  });

  it('STALE_REVISION: tells the office once and pauses; resumed once Postgres agrees, it goes on', async () => {
    const w = new LifecycleWorld();
    const ev = openEvent(CHAT, 700006);
    const requestId = ev.requestId;
    await w.invoke('open', requestId, ev);
    w.core.pgRev.set(requestId, 0); // Postgres behind the object: a second writer or a restored database
    const store = w.states.get(requestId)!;
    const t0 = `${requestId}-t0`;
    const ctx = new FakeObjectContext({ key: requestId, state: store, clock: () => w.clock, terminalError: (m) => new restate.TerminalError(m) });
    const event = { v: 1, eventId: `dr-finished:${designRunId(t0)}`, runId: designRunId(t0), round: 0, taskId: t0, report: DRAFT_READY };
    await expect(handleLifecycleEvent(ctx as unknown as restate.ObjectContext, 'designFinished', event, w.deps())).rejects.toBeInstanceOf(restate.PauseError);
    expect(ctx.sends.map((s) => s.idempotencyKey)).toEqual([`lc-stale:${requestId}:2:designFinished`]);

    // A person puts Postgres right and resumes: the held step asks again and the event goes on.
    w.core.pgRev.set(requestId, 1);
    ctx.replay();
    await handleLifecycleEvent(ctx as unknown as restate.ObjectContext, 'designFinished', event, w.deps());
    ctx.commit();
    expect(ctx.sends.filter((s) => s.idempotencyKey === `lc-stale:${requestId}:2:designFinished`)).toHaveLength(1);
    expect(w.stateOf(requestId)!.stage).toBe('in_review');
  });

  it('AHEAD again after two reconciliations is held for a person; AHEAD for a request this object never opened is refused', async () => {
    const w = new LifecycleWorld();
    const ev = openEvent(CHAT, 700011);
    const requestId = ev.requestId;
    await w.invoke('open', requestId, ev);
    let pg = 10;
    // Something keeps writing ahead of the object: every projection finds Postgres further on.
    w.core.override = (body) => ({ kind: 'conflict', conflict: { code: 'AHEAD', pgRev: ++pg, expectedRev: body.expectedRev, rev: body.rev } });
    const store = w.states.get(requestId)!;
    const ctx = new FakeObjectContext({ key: requestId, state: store, clock: () => w.clock, terminalError: (m) => new restate.TerminalError(m) });
    const t0 = `${requestId}-t0`;
    const event = { v: 1, eventId: `dr-finished:${designRunId(t0)}`, runId: designRunId(t0), round: 0, taskId: t0, report: DRAFT_READY };
    await expect(handleLifecycleEvent(ctx as unknown as restate.ObjectContext, 'designFinished', event, w.deps())).rejects.toBeInstanceOf(restate.PauseError);
    expect(ctx.sends.map((s) => s.idempotencyKey)).toEqual([`lc-ahead:${requestId}:11`, `lc-ahead:${requestId}:12`, `lc-stale:${requestId}:13:designFinished`]);

    const lost = openEvent(CHAT, 700012);
    const w2 = new LifecycleWorld();
    w2.core.pgRev.set(lost.requestId, 4); // Postgres has the request; this object has no state for it
    await expect(w2.invoke('open', lost.requestId, lost)).rejects.toBeInstanceOf(restate.TerminalError);
    await w2.deliver();
    expect(w2.telegram.map((m) => m.key)).toEqual([`lc-refused:${lost.requestId}:1:open`]);
  });

  it('a refused projection tells the office and ends the event with a terminal error', async () => {
    const w = new LifecycleWorld();
    const ev = openEvent(CHAT, 700007);
    w.core.override = (body) => ({ kind: 'refused', status: 422, code: 'INVALID_DRAFT', message: `refused ${body.key}` });
    await expect(w.invoke('open', ev.requestId, ev)).rejects.toBeInstanceOf(restate.TerminalError);
    await w.deliver();
    expect(w.telegram.map((m) => [m.chatId, m.key])).toEqual([[OFFICE, `lc-refused:${ev.requestId}:1:open`]]);
    expect(w.stateOf(ev.requestId)).toBeUndefined();
  });
});

describe('RequestLifecycle: events it cannot read, and events seen before', () => {
  const ctxFor = (key: string, state = new Map<string, unknown>()) =>
    new FakeObjectContext({ key, state, clock: () => START, terminalError: (m) => new restate.TerminalError(m) }) as unknown as restate.ObjectContext;
  const deps = new LifecycleWorld().deps();

  it('a payload that is not an event, or has no version, is refused for good', async () => {
    await expect(handleLifecycleEvent(ctxFor('r1'), 'remind', 'x', deps)).rejects.toBeInstanceOf(restate.TerminalError);
    await expect(handleLifecycleEvent(ctxFor('r1'), 'remind', { eventId: 'e1', kind: 'draft', day: 1, stageEpoch: 0, taskId: 't' }, deps)).rejects.toBeInstanceOf(restate.TerminalError);
  });

  it('an event or a state from a newer build is retried, never set', async () => {
    const newer = handleLifecycleEvent(ctxFor('r2'), 'remind', { v: 2, eventId: 'e2', kind: 'draft', day: 1, stageEpoch: 0, taskId: 't' }, deps);
    await expect(newer).rejects.toThrow(/newer build/);
    await expect(newer).rejects.not.toBeInstanceOf(restate.TerminalError);
    const state = new Map<string, unknown>([['lc', { v: 2, stage: 'designing' }]]);
    const ctx = ctxFor('r3', state);
    await expect(handleLifecycleEvent(ctx, 'expire', { v: 1, eventId: 'e3', stageEpoch: 0 }, deps)).rejects.toThrow(/newer build/);
    expect((ctx as unknown as FakeObjectContext).journal.some((e) => e.kind === 'set')).toBe(false);
  });

  it('an event seen before changes nothing and asks Core nothing; an office decision gets its first answer again', async () => {
    const w = new LifecycleWorld();
    const ev = openEvent(CHAT, 700008);
    const requestId = ev.requestId;
    const t0 = `${requestId}-t0`;
    await w.invoke('open', requestId, ev);
    await w.deliver();
    await w.finishRun(requestId, designRunId(t0), 0, t0, DRAFT_READY);
    const approve = { v: 1, eventId: 'desk:act-1', actionId: 'act-1', actor: { userId: 'u1', role: 'operator' }, kind: 'approve', taskId: t0, revisionId: `rev-${t0}` };
    const first = await w.invoke('officeDecision', requestId, approve);
    expect(first).toEqual({ accepted: true, rev: 4, stage: 'approved' });
    const calls = w.core.calls;
    // Past Restate's own idempotency (another key): the object's `seen` answers it.
    expect(await w.invoke('officeDecision', requestId, approve)).toEqual(first);
    expect(await w.invoke('open', requestId, ev)).toEqual({ accepted: true, taskId: t0 });
    expect(w.core.calls).toBe(calls);
  });

  it('a cancelled request cancels its running design run by the invocation id it kept', async () => {
    const w = new LifecycleWorld();
    const ev = openEvent(CHAT, 700009);
    await w.invoke('open', ev.requestId, ev);
    const invocationId = w.stateOf(ev.requestId)!.rounds[0].runInvocationId;
    expect(invocationId).toMatch(/^inv_DesignRun_/);
    const store = w.states.get(ev.requestId)!;
    const ctx = new FakeObjectContext({ key: ev.requestId, state: store, clock: () => w.clock, terminalError: (m) => new restate.TerminalError(m) });
    await handleLifecycleEvent(ctx as unknown as restate.ObjectContext, 'cancel', { v: 1, eventId: 'cancel:1', by: 'requester' }, w.deps());
    ctx.commit();
    expect(ctx.journal.filter((e) => e.kind === 'cancel')).toEqual([{ kind: 'cancel', invocationId }]);
    expect(w.stateOf(ev.requestId)!.stage).toBe('cancelled');
  });
});

describe('HAWA_LIFECYCLE_REMINDER_SCALE', () => {
  it('reads a number in (0, 1], and real days otherwise', () => {
    expect(reminderScaleFrom(undefined)).toBe(1);
    expect(reminderScaleFrom('0.0001')).toBe(0.0001);
    expect(reminderScaleFrom('0')).toBe(1);
    expect(reminderScaleFrom('2')).toBe(1);
    expect(reminderScaleFrom('soon')).toBe(1);
    expect(lifecycleConfigFromEnv({ HAWA_LIFECYCLE_REMINDER_SCALE: '0.0001', TELEGRAM_ALLOWED_USERS: ` ${OFFICE}, 42` })).toEqual({ reminderScale: 0.0001, officeChatId: OFFICE });
  });

  it('shrinks reminder and expiry delays, read once per invocation in the journaled config step', async () => {
    const w = new LifecycleWorld();
    w.config = { reminderScale: 0.0001, officeChatId: OFFICE };
    const ev = openEvent(CHAT, 700010);
    const t0 = `${ev.requestId}-t0`;
    await w.invoke('open', ev.requestId, ev);
    await w.deliver();
    await w.finishRun(ev.requestId, designRunId(t0), 0, t0, DRAFT_READY);
    const delays = w.rawSends.filter((s) => s.delayMs > 0).map((s) => [s.handler, s.delayMs]);
    expect(delays).toEqual([['remind', Math.round(DAY * 0.0001)], ['expire', Math.round(14 * DAY * 0.0001)]]);
    expect(w.journals.every((j) => j.steps[0] === 'config')).toBe(true);
    await w.advance(Math.round(15 * DAY * 0.0001));
    expect(w.stateOf(ev.requestId)!.stage).toBe('expired');
  });
});
