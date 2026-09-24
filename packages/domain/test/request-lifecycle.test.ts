import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DraftIntake,
  LifecycleEvent,
  LifecycleMessage,
  LifecycleStateV1,
  ProjectionOp,
  ProjectionOpResult,
} from '@hawa/contracts';
import {
  EXPIRE_AFTER_MS,
  LifecycleEventUnreadableError,
  LifecycleProjectionUnavailableError,
  LifecycleStateTooNewError,
  LifecycleStateUnreadableError,
  apply,
  nextOfficeMoment,
  plan,
  projectionRequestFor,
  reconcileAhead,
  recordRunInvocation,
  requestIdFor,
  sizeRequestId,
  upgrade,
  uuidFromKey,
  viewOf,
  type Applied,
  type LifecycleEffect,
  type Plan,
} from '../src/index.js';

/**
 * The RequestLifecycle state machine (PHASE2_DESIGN.md section 2.3): one test per row of the table,
 * and one per case where an event must do nothing (a stale run, a stale question, a stale stage
 * epoch, a draft that is not the current one). A fake Core answers each projection the way the
 * design says Core's ops answer.
 */

const T0 = Date.parse('2026-09-24T10:00:00+03:00');
const TENANT = '00000000-0000-4000-a000-000000000001';
const CLIENT = 'c1000000-0000-4000-8000-000000000002';
const CHAT = '9300101';
const REQ = requestIdFor(CHAT, 700001, 0);
const TASK0 = '11111111-1111-4111-8111-111111111111';
const TASK1 = '33333333-3333-4333-8333-333333333333';
const REV0 = '22222222-2222-4222-8222-222222222222';
const REV1 = '44444444-4444-4444-8444-444444444444';
const APPROVAL = '55555555-5555-4555-8555-555555555555';
const OPERATOR = { userId: '00000000-0000-4000-b000-000000000001', role: 'operator' };

const msg = (key: string, extra: Partial<LifecycleMessage> = {}): LifecycleMessage => ({ v: 1, key, chatId: CHAT, kind: 'text', text: key, class: 'critical', ...extra });

/** What Core answers for each op, unless a test says otherwise. */
type Answers = Partial<{ [K in ProjectionOp['op']]: Partial<Extract<ProjectionOpResult, { op: K }>> }>;
function coreAnswers(ops: ProjectionOp[], answers: Answers): ProjectionOpResult[] {
  return ops.map((op): ProjectionOpResult => {
    const a = (answers as Record<string, Record<string, unknown> | undefined>)[op.op] ?? {};
    switch (op.op) {
      case 'createRequest': return { op: 'createRequest', taskId: TASK0, autoGenerate: op.draft.autoGenerate, stage: 'designing', messages: [msg('ack')], ...a } as ProjectionOpResult;
      case 'createRound': return { op: 'createRound', taskId: TASK1, autoGenerate: true, messages: [msg('round-ack')], ...a } as ProjectionOpResult;
      case 'recordOutcome': return { op: 'recordOutcome', hasDraft: true, revisionId: REV0, designId: 'DAF_1', stage: 'in_review', messages: [msg('draft', { onSent: { requestId: REQ, what: 'draft', taskId: op.taskId } })], ...a } as ProjectionOpResult;
      case 'recordRequesterAction': return { op: 'recordRequesterAction', messages: [msg(`rq-${op.action}`)], ...a } as ProjectionOpResult;
      case 'composeReminder': return { op: 'composeReminder', skip: false, messages: [msg(`reminder-${op.kind}-${op.day}`)], ...a } as ProjectionOpResult;
      case 'recordApproval': return { op: 'recordApproval', approvalId: APPROVAL, ...a } as ProjectionOpResult;
      case 'bridgeCapturedRevision': return { op: 'bridgeCapturedRevision', revisionId: REV1, messages: [], ...a } as ProjectionOpResult;
      case 'transition': return { op: 'transition', taskId: op.taskId, fromState: null, toState: op.toState ?? null, changed: Boolean(op.toState), version: 2, messages: [], ...a } as ProjectionOpResult;
      case 'recordDelivery': return { op: 'recordDelivery', messages: [], ...a } as ProjectionOpResult;
      case 'closeQuestion': return { op: 'closeQuestion', changed: true };
      default: return { op: op.op } as ProjectionOpResult;
    }
  });
}

interface Step { applied: Accepted; ops: ProjectionOp[]; key: string; expectedRev: number }

type Accepted = Extract<Applied, { ignored: false }>;
type Projecting = Extract<Plan, { ignored: false }>;
type Ignoring = Extract<Plan, { ignored: true }>;

/** An apply that must have moved the request (the test tsconfig is not strict, so no narrowing). */
function accepted(a: Applied): Accepted {
  if (a.ignored) throw new Error(`apply ignored the event: ${(a as Ignoring).reason}`);
  return a as Accepted;
}

/** One accepted event: plan, project through the fake Core, apply. */
function step(s: LifecycleStateV1 | undefined, ev: LifecycleEvent, answers: Answers = {}, now = T0, reminderScale?: number): Step {
  const planned = plan(s, ev, now);
  if (planned.ignored) throw new Error(`expected ${ev.type} to be accepted, but it was ignored: ${(planned as Ignoring).reason}`);
  const p = planned as Projecting;
  const req = projectionRequestFor(s, ev, p);
  const results = coreAnswers(req.ops, answers);
  const a = accepted(apply(s, ev, { v: 1, status: 'applied', rev: req.rev, stage: p.stage ?? 'designing', results }, now, { reminderScale }));
  return { applied: a, ops: req.ops, key: req.key, expectedRev: req.expectedRev };
}

function ignored(s: LifecycleStateV1 | undefined, ev: LifecycleEvent, now = T0): { reason: string; reply?: unknown } {
  const p = plan(s, ev, now);
  if (!p.ignored) throw new Error(`expected ${ev.type} to be ignored, but it projects ${(p as Projecting).ops.map((o) => o.op).join(', ')}`);
  return p as Ignoring;
}

const effectsOf = <T extends LifecycleEffect['type']>(a: { effects: LifecycleEffect[] }, type: T) => a.effects.filter((e): e is Extract<LifecycleEffect, { type: T }> => e.type === type);

// Event builders ------------------------------------------------------------------------------

const openEv = (draft: Partial<DraftIntake> = {}): LifecycleEvent => ({
  type: 'open', v: 1, eventId: `open:${REQ}`, requestId: REQ, tenantId: TENANT, chatId: CHAT,
  origin: { kind: 'telegram', chatId: CHAT, updateId: 700001 },
  draft: { title: 'Staff meeting', rawText: 'Staff meeting Sunday 10:00', clientId: CLIENT, designInstructions: '', exactCopy: [], autoGenerate: true, ...draft },
});
const finished = (runId: string, taskId = TASK0, report: Record<string, unknown> = { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAF_1' }, round = 0): LifecycleEvent => ({
  type: 'designFinished', v: 1, eventId: `dr-finished:${runId}`, runId, round, taskId, report: report as { status: string },
});
const sent = (what: 'draft' | 'question', taskId: string, at: number, key = `${what}-key`): LifecycleEvent => ({ type: 'messageSent', v: 1, eventId: `sent:${key}`, key, what, taskId, at });
const requester = (kind: 'ok' | 'chg' | 'dsg' | 'size' | 'change', taskId: string, extra: Record<string, unknown> = {}): LifecycleEvent => ({
  type: 'requesterDecision', v: 1, eventId: `rq:${kind}:${taskId}:${JSON.stringify(extra)}`, taskId, kind, actorId: 'telegram:42', ...extra,
});
const office = (kind: string, taskId: string, extra: Record<string, unknown> = {}): LifecycleEvent => ({
  type: 'officeDecision', v: 1, eventId: `desk:${kind}-${JSON.stringify(extra)}`, actionId: `${kind}-action`, actor: OPERATOR, kind: kind as 'approve', taskId, ...extra,
});
const remind = (kind: 'draft' | 'question', day: 1 | 5, taskId: string, stageEpoch: number): LifecycleEvent => ({
  type: 'remind', v: 1, eventId: `remind:${REQ}:${kind}:${day}:${taskId}`, kind, day, stageEpoch, taskId,
});

// States reached by stepping from the start ---------------------------------------------------

const opened = () => step(undefined, openEv()).applied.next;
const inReview = () => step(opened(), finished(`dr-${TASK0}`)).applied.next;
const draftSent = () => step(inReview(), sent('draft', TASK0, T0 + 60_000)).applied.next;
const question = { id: 'q-1', question: 'Which logo should lead?', options: ['Blue', 'Red'] };
const awaiting = () => step(opened(), finished(`dr-${TASK0}`, TASK0, { status: 'CANVA_NEEDS_CLARIFICATION', code: 'NEEDS_CLARIFICATION' }), {
  recordOutcome: { hasDraft: false, revisionId: undefined, designId: undefined, question, stage: 'awaiting_answer', messages: [msg('question', { onSent: { requestId: REQ, what: 'question', taskId: TASK0 } })] },
}).applied.next;
const approved = () => step(draftSent(), office('approve', TASK0, { revisionId: REV0 })).applied.next;
const delivering = () => step(approved(), office('deliver', TASK0, { approvalId: APPROVAL })).applied.next;
const deliveryId = `dl-${REQ}-${APPROVAL}`;

describe('ids', () => {
  it('are stable UUID-shaped hashes of their keys', () => {
    expect(REQ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(requestIdFor(CHAT, 700001, 0)).toBe(uuidFromKey(`req:${CHAT}:700001:0`));
    expect(requestIdFor(CHAT, 700001, 1)).not.toBe(REQ);
    expect(sizeRequestId(REQ, 'sst')).toBe(uuidFromKey(`req:size:${REQ}:sst`));
  });
});

describe('open', () => {
  it('— → designing when it may be drafted and has a client: the task, the acknowledgement and the design run', () => {
    const { applied, ops, key, expectedRev } = step(undefined, openEv());
    expect(ops).toEqual([expect.objectContaining({ op: 'createRequest', requestId: REQ, chatId: CHAT })]);
    expect({ key, expectedRev }).toEqual({ key: `${REQ}:1:open`, expectedRev: 0 });
    const s = applied.next;
    expect(s).toMatchObject({ v: 1, requestId: REQ, tenantId: TENANT, owner: 'restate', rev: 1, stage: 'designing', round: 0, stageEpoch: 0 });
    expect(s.rounds).toEqual([{ round: 0, taskId: TASK0, kind: 'design', runId: `dr-${TASK0}`, runAttempt: 0 }]);
    expect(applied.effects.map((e) => e.type)).toEqual(['send', 'startDesignRun']);
    expect(effectsOf(applied, 'startDesignRun')[0]).toMatchObject({ runId: `dr-${TASK0}`, taskId: TASK0, round: 0, attempt: 0, tenantId: TENANT });
    expect(applied.reply).toEqual({ accepted: true, taskId: TASK0 });
    expect(s.seen).toEqual([`open:${REQ}`]);
  });

  it('— → manual without a client, and when the daily cap declined the automatic draft', () => {
    const noClient = step(undefined, openEv({ clientId: null })).applied;
    expect(noClient.next.stage).toBe('manual');
    expect(noClient.next.rounds[0].runId).toBeUndefined();
    expect(effectsOf(noClient, 'startDesignRun')).toEqual([]);
    const capped = step(undefined, openEv(), { createRequest: { autoGenerate: false, autoGenerateDeclined: 'SENDER_DAILY_CAP' } }).applied;
    expect(capped.next.stage).toBe('manual');
    expect(effectsOf(capped, 'startDesignRun')).toEqual([]);
  });

  it('is ignored once the request is open (another event id), and answered again for the same one', () => {
    const s = opened();
    expect(ignored(s, { ...openEv(), eventId: 'open:other' }).reply).toEqual({ accepted: true, taskId: TASK0 });
    expect(ignored(s, openEv())).toMatchObject({ reason: 'duplicate event', reply: { accepted: true, taskId: TASK0 } });
  });

  it('every other event is ignored before the request is open; an office decision is refused', () => {
    expect(ignored(undefined, finished(`dr-${TASK0}`)).reason).toMatch(/never opened/);
    expect(ignored(undefined, office('approve', TASK0)).reply).toMatchObject({ accepted: false, code: 'WRONG_STAGE' });
  });
});

describe('designFinished', () => {
  it('designing → in_review with a draft: the outcome recorded, the draft message sent with its onSent hook', () => {
    const { applied, ops, key } = step(opened(), finished(`dr-${TASK0}`));
    expect(ops).toEqual([{ op: 'recordOutcome', taskId: TASK0, runId: `dr-${TASK0}`, report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAF_1' } }]);
    expect(key).toBe(`${REQ}:2:designFinished`);
    const s = applied.next;
    expect(s).toMatchObject({ stage: 'in_review', rev: 2, stageEpoch: 1, draft: { taskId: TASK0, revisionId: REV0, designId: 'DAF_1' } });
    expect(s.rounds[0].outcome).toEqual({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAF_1', revisionId: REV0 });
    expect(effectsOf(applied, 'send').map((e) => e.message.onSent?.what)).toEqual(['draft']);
  });

  it('designing → awaiting_answer with a question (capped at three options)', () => {
    const s = step(opened(), finished(`dr-${TASK0}`, TASK0, { status: 'CANVA_NEEDS_CLARIFICATION' }), {
      recordOutcome: { hasDraft: false, revisionId: undefined, designId: undefined, question: { id: 'q-9', question: 'Which?', options: ['a', 'b', 'c', 'd'] } },
    }).applied.next;
    expect(s.stage).toBe('awaiting_answer');
    expect(s.question).toEqual({ id: 'q-9', taskId: TASK0, question: 'Which?', options: ['a', 'b', 'c'] });
    expect(s.draft).toBeUndefined();
  });

  it('designing → manual when there is neither a draft nor a question', () => {
    const s = step(opened(), finished(`dr-${TASK0}`, TASK0, { status: 'CANVA_DRAFT_FAILED' }), { recordOutcome: { hasDraft: false, revisionId: undefined, designId: undefined, messages: [] } }).applied.next;
    expect(s.stage).toBe('manual');
    expect(s.rounds[0].outcome?.status).toBe('CANVA_DRAFT_FAILED');
  });

  it('ignores a stale run, a second report of a finished run, and a report outside designing', () => {
    expect(ignored(opened(), finished(`dr-${TASK0}-a1`)).reason).toMatch(/stale run/);
    const s = inReview();
    expect(ignored(s, { ...finished(`dr-${TASK0}`), eventId: 'dr-finished:again' }).reason).toMatch(/stale run/);
  });

  it('Core down past the projection window: the outcome is kept, the requester and office told once, and offered again in 10 minutes', () => {
    const s = opened();
    const ev = finished(`dr-${TASK0}`);
    const a = accepted(apply(s, ev, { status: 'unavailable' }, T0));
    expect(a.next.stage).toBe('designing');
    expect(a.next.rev).toBe(s.rev);
    expect(a.next.outcomeDeferred).toMatchObject({ runId: `dr-${TASK0}`, since: T0, attempts: 1, report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' } });
    expect(effectsOf(a, 'outcomeUnrecorded')).toEqual([{ type: 'outcomeUnrecorded', requestId: REQ, taskId: TASK0, runId: `dr-${TASK0}`, status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', chatId: CHAT }]);
    const [retry] = effectsOf(a, 'schedule');
    expect(retry).toMatchObject({ handler: 'retryProjection', delayMs: 10 * 60_000, idempotencyKey: `retry:${REQ}:dr-${TASK0}:1` });

    // Offered again while Core is still down: no second message, a new retry key.
    const again = accepted(apply(a.next, { type: 'retryProjection', ...(retry.event as { v: 1; eventId: string; runId: string }) }, { status: 'unavailable' }, T0 + 600_000));
    expect(effectsOf(again, 'outcomeUnrecorded')).toEqual([]);
    expect(again.next.outcomeDeferred).toMatchObject({ attempts: 2, since: T0 });
    expect(effectsOf(again, 'schedule')[0].idempotencyKey).toBe(`retry:${REQ}:dr-${TASK0}:2`);

    // Core is back: the kept report is recorded.
    const back = step(again.next, { type: 'retryProjection', v: 1, eventId: 'retry:3', runId: `dr-${TASK0}` });
    expect(back.ops[0]).toMatchObject({ op: 'recordOutcome', runId: `dr-${TASK0}`, report: { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW' } });
    expect(back.applied.next).toMatchObject({ stage: 'in_review', rev: s.rev + 1 });
    expect(back.applied.next.outcomeDeferred).toBeUndefined();
  });

  it('a retried design outcome projects under the key and ops of the first attempt, so Core replays it', () => {
    const s = opened();
    const ev = finished(`dr-${TASK0}`);
    const first = projectionRequestFor(s, ev, plan(s, ev, T0) as Projecting);
    const deferred = accepted(apply(s, ev, { status: 'unavailable' }, T0));
    const retryEv: LifecycleEvent = { type: 'retryProjection', ...(effectsOf(deferred, 'schedule')[0].event as { v: 1; eventId: string; runId: string }) };
    const second = projectionRequestFor(deferred.next, retryEv, plan(deferred.next, retryEv, T0 + 600_000) as Projecting);
    expect(second).toEqual(first);

    // Offered a third time (Core still down on the second): still the first attempt's projection.
    const again = accepted(apply(deferred.next, retryEv, { status: 'unavailable' }, T0 + 600_000));
    const retry2: LifecycleEvent = { type: 'retryProjection', ...(effectsOf(again, 'schedule')[0].event as { v: 1; eventId: string; runId: string }) };
    expect(projectionRequestFor(again.next, retry2, plan(again.next, retry2, T0 + 1_200_000) as Projecting)).toEqual(first);

    // Core committed the first attempt and died before answering: it replays the stored result, and
    // the request moves on exactly as if the first answer had arrived.
    const results = coreAnswers(first.ops, {});
    const replayed = accepted(apply(again.next, retry2, { v: 1, status: 'replayed', rev: first.rev, stage: 'in_review', results }, T0 + 1_200_000));
    expect(replayed.next).toMatchObject({ stage: 'in_review', rev: first.rev, draft: { taskId: TASK0, revisionId: REV0 } });
    expect(replayed.next.outcomeDeferred).toBeUndefined();
    expect(effectsOf(replayed, 'send').map((e) => e.message.onSent?.what)).toEqual(['draft']);
  });

  it('a report too large to keep whole is still offered again byte for byte', () => {
    const s = opened();
    const big = { status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', designId: 'DAF_1', qa: 'x'.repeat(20_000) };
    const ev = finished(`dr-${TASK0}`, TASK0, big);
    const first = projectionRequestFor(s, ev, plan(s, ev, T0) as Projecting);
    const deferred = accepted(apply(s, ev, { status: 'unavailable' }, T0));
    const retryEv: LifecycleEvent = { type: 'retryProjection', ...(effectsOf(deferred, 'schedule')[0].event as { v: 1; eventId: string; runId: string }) };
    expect(projectionRequestFor(deferred.next, retryEv, plan(deferred.next, retryEv, T0) as Projecting)).toEqual(first);
  });

  it('after an AHEAD reconciliation the retry still replays the first attempt, never records the outcome a second time', () => {
    // Core committed the outcome at rev 2 unanswered; a requester button on the request then got
    // AHEAD and the shell took Postgres's revision. The retry must not project at rev 3.
    const s = opened();
    const ev = finished(`dr-${TASK0}`);
    const first = projectionRequestFor(s, ev, plan(s, ev, T0) as Projecting);
    const deferred = accepted(apply(s, ev, { status: 'unavailable' }, T0));
    const reconciled = reconcileAhead(deferred.next, first.rev);
    const retryEv: LifecycleEvent = { type: 'retryProjection', ...(effectsOf(deferred, 'schedule')[0].event as { v: 1; eventId: string; runId: string }) };
    expect(projectionRequestFor(reconciled, retryEv, plan(reconciled, retryEv, T0) as Projecting)).toEqual(first);
  });

  it('once another projection was applied at the deferred revision, the outcome was never recorded: the retry projects it afresh', () => {
    // Round 1 is designing with the round-0 draft still on the request, and the requester presses a
    // button on that old draft while Core cannot take round 1's outcome.
    let s = step(draftSent(), requester('change', TASK0, { directive: 'bigger logo' })).applied.next;
    const ev = finished(`dr-${TASK1}`, TASK1, undefined, 1);
    const first = projectionRequestFor(s, ev, plan(s, ev, T0) as Projecting);
    const deferred = accepted(apply(s, ev, { status: 'unavailable' }, T0));
    const button = step(deferred.next, requester('ok', TASK0, { n: 'old' }));
    expect(button.expectedRev).toBe(first.expectedRev);
    s = button.applied.next;
    const retryEv: LifecycleEvent = { type: 'retryProjection', ...(effectsOf(deferred, 'schedule')[0].event as { v: 1; eventId: string; runId: string }) };
    const fresh = projectionRequestFor(s, retryEv, plan(s, retryEv, T0) as Projecting);
    expect(fresh).toMatchObject({ expectedRev: first.rev, rev: first.rev + 1, key: `${REQ}:${first.rev + 1}:designFinished`, ops: first.ops });
  });

  it('retryProjection is ignored for another run or once nothing is deferred', () => {
    expect(ignored(opened(), { type: 'retryProjection', v: 1, eventId: 'r1', runId: `dr-${TASK0}` }).reason).toMatch(/nothing deferred/);
  });

  it('a projection Core would not take is retried, not skipped, for any event that cannot wait', () => {
    expect(() => apply(inReview(), requester('ok', TASK0), { status: 'unavailable' }, T0)).toThrow(LifecycleProjectionUnavailableError);
  });
});

describe('answer', () => {
  it('awaiting_answer → designing (round+1): a new round task, the question closed, the callback answered, the run started', () => {
    const s = awaiting();
    const { applied, ops } = step(s, { type: 'answer', v: 1, eventId: 'answer:1', questionId: 'q-1', answer: { option: 2 }, callbackQueryId: 'cbq-1', actorId: 'telegram:42' });
    expect(ops).toEqual([
      { op: 'createRound', kind: 'answer', round: 1, parentTaskId: TASK0, directive: 'Red', answers: TASK0, question: question.question, answer: { option: 2 } },
      { op: 'closeQuestion', taskId: TASK0, questionId: 'q-1' },
    ]);
    const next = applied.next;
    expect(next).toMatchObject({ stage: 'designing', round: 1 });
    expect(next.question).toBeUndefined();
    expect(next.rounds.at(-1)).toEqual({ round: 1, taskId: TASK1, kind: 'answer', runId: `dr-${TASK1}`, runAttempt: 0 });
    expect(applied.effects.map((e) => e.type)).toEqual(['startDesignRun', 'send', 'answerCallback']);
  });

  it('a typed answer is the directive; the daily cap sends the round to the office', () => {
    const { applied, ops } = step(awaiting(), { type: 'answer', v: 1, eventId: 'answer:2', questionId: 'q-1', answer: { text: '  the blue one ' }, actorId: 'telegram:42' }, { createRound: { autoGenerate: false } });
    expect(ops[0]).toMatchObject({ directive: 'the blue one' });
    expect(applied.next.stage).toBe('manual');
    expect(effectsOf(applied, 'startDesignRun')).toEqual([]);
  });

  it('ignores a stale question id, and an answer when no question waits', () => {
    expect(ignored(awaiting(), { type: 'answer', v: 1, eventId: 'a', questionId: 'q-old', answer: { option: 1 }, actorId: 'x' }).reason).toMatch(/stale question/);
    expect(ignored(inReview(), { type: 'answer', v: 1, eventId: 'a', questionId: 'q-1', answer: { option: 1 }, actorId: 'x' }).reason).toMatch(/no question/);
  });
});

describe('requesterDecision', () => {
  it('ok on the current draft: signed off, still in_review, the acknowledgement and office alert Core composed', () => {
    const { applied, ops } = step(draftSent(), requester('ok', TASK0, { callbackQueryId: 'cbq' }), {}, T0 + 5000);
    expect(ops).toEqual([{ op: 'recordRequesterAction', taskId: TASK0, action: 'ok', current: true, actorId: 'telegram:42', callbackQueryId: 'cbq' }]);
    expect(applied.next).toMatchObject({ stage: 'in_review', requester: { signedOff: { taskId: TASK0, at: T0 + 5000 } } });
    expect(applied.effects.map((e) => e.type)).toEqual(['send', 'answerCallback']);
  });

  it('chg on the current draft: the change prompt, stage unchanged', () => {
    const { applied, ops } = step(draftSent(), requester('chg', TASK0));
    expect(ops[0]).toMatchObject({ action: 'chg', current: true });
    expect(applied.next.stage).toBe('in_review');
    expect(applied.next.stageEpoch).toBe(draftSent().stageEpoch);
  });

  it('change (a typed reply) to the current draft: in_review → designing, round+1', () => {
    const { applied, ops } = step(draftSent(), requester('change', TASK0, { directive: ' make the logo bigger ' }));
    expect(ops).toEqual([{ op: 'createRound', kind: 'change', round: 1, parentTaskId: TASK0, directive: 'make the logo bigger' }]);
    expect(applied.next).toMatchObject({ stage: 'designing', round: 1 });
    expect(effectsOf(applied, 'startDesignRun')[0]).toMatchObject({ runId: `dr-${TASK1}`, round: 1 });
  });

  it('a button or reply on a draft that is not the current one: Core only says why', () => {
    const changing = step(draftSent(), requester('change', TASK0, { directive: 'bigger' })).applied.next;
    const { applied, ops } = step(changing, requester('ok', TASK0));
    expect(ops[0]).toMatchObject({ op: 'recordRequesterAction', action: 'ok', current: false });
    expect(applied.next.stage).toBe('designing');
    expect(applied.next.requester.signedOff).toBeUndefined();
    const other = step(draftSent(), requester('change', TASK1, { directive: 'x' }));
    expect(other.ops[0]).toMatchObject({ action: 'change', current: false });
  });

  it('dsg: in_review → manual, and from expired too', () => {
    const { applied } = step(draftSent(), requester('dsg', TASK0), {}, T0 + 1);
    expect(applied.next).toMatchObject({ stage: 'manual', requester: { designerAsked: { at: T0 + 1 } } });
    const expired = step(draftSent(), { type: 'expire', v: 1, eventId: 'exp', stageEpoch: draftSent().stageEpoch }).applied.next;
    expect(step(expired, requester('dsg', TASK0)).applied.next.stage).toBe('manual');
    expect(ignored(opened(), requester('dsg', TASK0)).reason).toMatch(/designer/);
  });

  it('size: opens one child request per size, whatever the stage of review, approval or delivery', () => {
    const child = sizeRequestId(REQ, 'sst');
    const childDraft = { title: 'Staff meeting (story)', rawText: 'x', clientId: CLIENT, designInstructions: '', exactCopy: [], autoGenerate: true };
    const { applied } = step(draftSent(), requester('size', TASK0, { sizeAction: 'sst' }), { recordRequesterAction: { messages: [], childDraft } });
    expect(applied.next.sizes).toEqual({ sst: child });
    expect(applied.next.stage).toBe('in_review');
    const [open] = effectsOf(applied, 'openChild');
    expect(open).toMatchObject({ requestId: child, event: { v: 1, eventId: `open:${child}`, requestId: child, origin: { kind: 'size', parentRequestId: REQ, action: 'sst' }, parentRequestId: REQ, parentTaskId: TASK0, draft: childDraft } });
    expect(ignored(applied.next, requester('size', TASK0, { sizeAction: 'sst', callbackQueryId: 'again' })).reason).toMatch(/asked for already/);
    // Allowed after approval and after delivery; not while designing.
    expect(plan(approved(), requester('size', TASK0, { sizeAction: 'ssq' }), T0).ignored).toBe(false);
    expect(ignored(opened(), requester('size', TASK0, { sizeAction: 'ssq' })).reason).toMatch(/size cannot/);
  });

  it('size: no child when Core cannot make that size', () => {
    const { applied } = step(draftSent(), requester('size', TASK0, { sizeAction: 'sls' }), { recordRequesterAction: { messages: [msg('not-here')] } });
    expect(applied.next.sizes).toEqual({});
    expect(effectsOf(applied, 'openChild')).toEqual([]);
    expect(effectsOf(applied, 'send')).toHaveLength(1);
  });
});

describe('messageSent and reminders', () => {
  it('draft sent: recorded, the day-1 reminder at the next office moment after 24 h, the expiry at 14 days', () => {
    const s = inReview();
    const at = Date.parse('2026-09-24T21:30:00+03:00'); // sent at night
    const { applied, ops } = step(s, sent('draft', TASK0, at), {}, at);
    expect(ops).toEqual([{ op: 'recordDraftSent', taskId: TASK0, key: 'draft-key', at }]);
    expect(applied.next.draft?.sentAt).toBe(at);
    const [day1, expire] = effectsOf(applied, 'schedule');
    expect(day1).toMatchObject({ handler: 'remind', idempotencyKey: `remind:${REQ}:draft:1:${TASK0}`, event: { kind: 'draft', day: 1, taskId: TASK0, stageEpoch: s.stageEpoch } });
    expect(at + day1.delayMs).toBe(nextOfficeMoment(at + 24 * 3600_000));
    expect(at + day1.delayMs).toBe(Date.parse('2026-09-26T09:00:00+03:00'));
    expect(expire).toMatchObject({ handler: 'expire', delayMs: EXPIRE_AFTER_MS, event: { stageEpoch: s.stageEpoch } });
  });

  it('the reminder scale shortens every reminder and expiry delay (the chaos suite runs days in seconds)', () => {
    const at = T0;
    const { applied } = step(inReview(), sent('draft', TASK0, at), {}, at, 0.0001);
    const [day1, expire] = effectsOf(applied, 'schedule');
    expect(day1.delayMs).toBe(Math.round((nextOfficeMoment(at + 24 * 3600_000) - at) * 0.0001));
    expect(expire.delayMs).toBe(Math.round(EXPIRE_AFTER_MS * 0.0001));
  });

  it('ignores a second draft-sent, a sent draft that is not the current one, and what needs no record', () => {
    expect(ignored(draftSent(), sent('draft', TASK0, T0, 'other')).reason).toMatch(/already/);
    expect(ignored(inReview(), sent('draft', TASK1, T0)).reason).toMatch(/not the current/);
    expect(ignored(inReview(), { type: 'messageSent', v: 1, eventId: 'sent:ack', key: 'ack', what: 'ack', taskId: TASK0, at: T0 }).reason).toMatch(/nothing is recorded/);
  });

  it('question sent: recorded and reminded about like a draft', () => {
    const { applied, ops } = step(awaiting(), sent('question', TASK0, T0));
    expect(ops).toEqual([{ op: 'recordQuestionSent', taskId: TASK0, questionId: 'q-1', key: 'question-key', at: T0 }]);
    expect(applied.next.question?.askedAt).toBe(T0);
    expect(effectsOf(applied, 'schedule').map((e) => e.handler)).toEqual(['remind', 'expire']);
    expect(ignored(awaiting(), sent('question', TASK1, T0)).reason).toMatch(/not the one waiting/);
  });

  it('remind day 1: the reminder Core composed, marked, and day 5 scheduled from the send time', () => {
    const s = draftSent();
    const sentAt = s.draft!.sentAt!;
    const now = sentAt + 25 * 3600_000;
    const { applied, ops } = step(s, remind('draft', 1, TASK0, s.stageEpoch), {}, now);
    expect(ops).toEqual([{ op: 'composeReminder', taskId: TASK0, kind: 'draft', day: 1, since: sentAt }]);
    expect(applied.next.reminders).toEqual([`draft:1:${TASK0}`]);
    expect(effectsOf(applied, 'send').map((e) => e.message.key)).toEqual(['reminder-draft-1']);
    const [day5] = effectsOf(applied, 'schedule');
    expect(day5).toMatchObject({ handler: 'remind', idempotencyKey: `remind:${REQ}:draft:5:${TASK0}`, event: { day: 5 } });
    expect(now + day5.delayMs).toBe(nextOfficeMoment(sentAt + 5 * 24 * 3600_000));
    // Day 5 schedules nothing further.
    const last = step(applied.next, remind('draft', 5, TASK0, s.stageEpoch), {}, now + 4 * 24 * 3600_000).applied;
    expect(effectsOf(last, 'schedule')).toEqual([]);
    expect(last.next.reminders).toEqual([`draft:1:${TASK0}`, `draft:5:${TASK0}`]);
  });

  it('remind: skipped when the requester wrote since (Core says skip), day 5 still scheduled', () => {
    const s = draftSent();
    const { applied } = step(s, remind('draft', 1, TASK0, s.stageEpoch), { composeReminder: { skip: true } });
    expect(effectsOf(applied, 'send')).toEqual([]);
    expect(effectsOf(applied, 'schedule')).toHaveLength(1);
    expect(applied.next.reminders).toEqual([`draft:1:${TASK0}`]);
  });

  it('remind: ignored from an older stage epoch, twice for one day, for another task, or after the stage moved', () => {
    const s = draftSent();
    expect(ignored(s, remind('draft', 1, TASK0, s.stageEpoch - 1)).reason).toMatch(/stale reminder/);
    const once = step(s, remind('draft', 1, TASK0, s.stageEpoch)).applied.next;
    expect(ignored(once, { ...remind('draft', 1, TASK0, s.stageEpoch), eventId: 'second-key' }).reason).toMatch(/sent already/);
    expect(ignored(s, remind('draft', 1, TASK1, s.stageEpoch)).reason).toMatch(/not the current/);
    expect(ignored(approved(), remind('draft', 1, TASK0, s.stageEpoch)).reason).toMatch(/no reminder while/);
  });

  it('expire: in_review → expired with the office alert Core composed; ignored from an older epoch', () => {
    const s = draftSent();
    const { applied, ops } = step(s, { type: 'expire', v: 1, eventId: 'exp', stageEpoch: s.stageEpoch }, { transition: { messages: [msg('office-expired')] } });
    expect(ops).toEqual([{ op: 'transition', taskId: TASK0, reason: expect.stringMatching(/14 days/) }]);
    expect(applied.next.stage).toBe('expired');
    expect(effectsOf(applied, 'send').map((e) => e.message.key)).toEqual(['office-expired']);
    expect(ignored(s, { type: 'expire', v: 1, eventId: 'exp2', stageEpoch: s.stageEpoch - 1 }).reason).toMatch(/stale expiry/);
    const asked = step(awaiting(), sent('question', TASK0, T0)).applied.next;
    expect(step(asked, { type: 'expire', v: 1, eventId: 'exp3', stageEpoch: asked.stageEpoch }).applied.next.stage).toBe('expired');
  });
});

describe('officeDecision', () => {
  it('approve the current draft: in_review → approved, the approval kept, the reply names the revision and stage', () => {
    const s = draftSent();
    const { applied, ops } = step(s, office('approve', TASK0, { revisionId: REV0, expectedRev: s.rev, approval: { note: 'fine' } }), {}, T0 + 9);
    expect(ops).toEqual([{ op: 'recordApproval', taskId: TASK0, revisionId: REV0, actionId: 'approve-action', actor: OPERATOR, approval: { note: 'fine' } }]);
    expect(applied.next.approval).toEqual({ approvalId: APPROVAL, taskId: TASK0, revisionId: REV0, actionId: 'approve-action', at: T0 + 9 });
    expect(applied.reply).toEqual({ accepted: true, rev: s.rev + 1, stage: 'approved' });
  });

  it('approve from expired', () => {
    const s = draftSent();
    const expired = step(s, { type: 'expire', v: 1, eventId: 'exp', stageEpoch: s.stageEpoch }).applied.next;
    expect(step(expired, office('approve', TASK0, { revisionId: REV0 })).applied.next.stage).toBe('approved');
  });

  it('approve is refused: an older revision (STALE_REVISION), another draft (NOT_CURRENT_DRAFT), the wrong stage, a change being made', () => {
    const s = draftSent();
    expect(ignored(s, office('approve', TASK0, { revisionId: REV0, expectedRev: s.rev - 1 })).reply).toMatchObject({ accepted: false, code: 'STALE_REVISION' });
    expect(ignored(s, office('approve', TASK0, { revisionId: REV1 })).reply).toMatchObject({ accepted: false, code: 'NOT_CURRENT_DRAFT' });
    expect(ignored(s, office('approve', TASK1, { revisionId: REV0 })).reply).toMatchObject({ accepted: false, code: 'NOT_CURRENT_DRAFT' });
    expect(ignored(opened(), office('approve', TASK0, { revisionId: REV0 })).reply).toMatchObject({ accepted: false, code: 'WRONG_STAGE' });
    // A state where the current round is an unfinished change while the old draft is under review.
    const pending: LifecycleStateV1 = { ...s, round: 1, rounds: [...s.rounds, { round: 1, taskId: TASK1, kind: 'change', runId: `dr-${TASK1}`, runAttempt: 0 }] };
    expect(ignored(pending, office('approve', TASK0, { revisionId: REV0 })).reply).toMatchObject({ accepted: false, code: 'CHANGE_PENDING' });
    // The refusal changes nothing, so the same decision can be answered again.
    expect(plan(s, office('approve', TASK0, { revisionId: REV0 }), T0).ignored).toBe(false);
  });

  it('revise the current draft: in_review → manual, the task to revision_requested', () => {
    const { applied, ops } = step(draftSent(), office('revise', TASK0, { comment: 'Tighter margins' }));
    expect(ops).toEqual([{ op: 'transition', taskId: TASK0, toState: 'revision_requested', reason: 'Tighter margins' }]);
    expect(applied.next.stage).toBe('manual');
    expect(ignored(draftSent(), office('revise', TASK1)).reply).toMatchObject({ code: 'NOT_CURRENT_DRAFT' });
  });

  it('draftCaptured in manual: the captured revision becomes the draft under review', () => {
    const manual = step(draftSent(), office('revise', TASK0)).applied.next;
    const { applied, ops } = step(manual, office('draftCaptured', TASK0));
    expect(ops).toEqual([{ op: 'bridgeCapturedRevision', taskId: TASK0 }]);
    expect(applied.next).toMatchObject({ stage: 'in_review', draft: { taskId: TASK0, revisionId: REV1 } });
    expect(ignored(manual, office('draftCaptured', TASK1)).reply).toMatchObject({ code: 'NOT_CURRENT_DRAFT' });
    expect(ignored(draftSent(), office('draftCaptured', TASK0)).reply).toMatchObject({ code: 'WRONG_STAGE' });
  });

  it('redrive in manual: designing again with the next attempt\'s run key', () => {
    const manual = step(opened(), finished(`dr-${TASK0}`, TASK0, { status: 'CANVA_DRAFT_FAILED' }), { recordOutcome: { hasDraft: false, revisionId: undefined, designId: undefined, messages: [] } }).applied.next;
    const { applied, ops } = step(manual, office('redrive', TASK0));
    expect(ops).toEqual([{ op: 'prepareRedrive', taskId: TASK0, attempt: 1 }]);
    expect(applied.next.stage).toBe('designing');
    expect(applied.next.rounds[0]).toEqual({ round: 0, taskId: TASK0, kind: 'design', runId: `dr-${TASK0}-a1`, runAttempt: 1 });
    expect(effectsOf(applied, 'startDesignRun')[0]).toMatchObject({ runId: `dr-${TASK0}-a1`, attempt: 1 });
    // The first run of a request opened without one keeps attempt 0.
    const unrun = step(undefined, openEv({ clientId: null })).applied.next;
    expect(step(unrun, office('redrive', TASK0)).ops).toEqual([{ op: 'prepareRedrive', taskId: TASK0, attempt: 0 }]);
    expect(ignored(manual, office('redrive', TASK1)).reply).toMatchObject({ code: 'NOT_CURRENT_DRAFT' });
    const live: LifecycleStateV1 = { ...manual, rounds: [{ ...manual.rounds[0], outcome: undefined }] };
    expect(ignored(live, office('redrive', TASK0)).reply).toMatchObject({ code: 'WRONG_STAGE' });
  });

  it('deliver the approval: approved → delivering, the task to publishing, the Delivery workflow started', () => {
    const s = approved();
    const { applied, ops } = step(s, office('deliver', TASK0, { approvalId: APPROVAL }), {}, T0 + 7);
    expect(ops).toEqual([{ op: 'transition', taskId: TASK0, toState: 'publishing', reason: 'The office asked for delivery' }]);
    expect(applied.next).toMatchObject({ stage: 'delivering', delivery: { deliveryId, approvalId: APPROVAL, startedAt: T0 + 7, run: 1 } });
    expect(effectsOf(applied, 'startDelivery')).toEqual([{ type: 'startDelivery', requestId: REQ, tenantId: TENANT, deliveryId, approvalId: APPROVAL, taskId: TASK0, revisionId: REV0, run: 1, chatId: CHAT }]);
    expect(ignored(s, office('deliver', TASK0, { approvalId: REV1 })).reply).toMatchObject({ code: 'NOT_CURRENT_DRAFT' });
    expect(ignored(draftSent(), office('deliver', TASK0)).reply).toMatchObject({ code: 'WRONG_STAGE' });
  });

  it('reject stays with Core until slice 2.4: refused as WRONG_STAGE', () => {
    expect(ignored(draftSent(), office('reject', TASK0)).reply).toMatchObject({ accepted: false, code: 'WRONG_STAGE' });
  });

  it('the same decision again (same event id) gets the answer it got the first time', () => {
    const s = draftSent();
    const ev = office('approve', TASK0, { revisionId: REV0 });
    const first = step(s, ev).applied;
    expect(ignored(first.next, ev)).toMatchObject({ reason: 'duplicate event', reply: first.reply });
  });
});

describe('deliveryFinished and archive retries', () => {
  it('delivering → delivered; the outcome kept', () => {
    const { applied, ops } = step(delivering(), { type: 'deliveryFinished', v: 1, eventId: `dl-finished:${deliveryId}`, deliveryId, outcome: 'chat_only', uncertain: [], sheetsConfirmed: false });
    expect(ops).toEqual([{ op: 'recordDelivery', taskId: TASK0, deliveryId, approvalId: APPROVAL, outcome: 'chat_only', sheetsConfirmed: false, uncertain: [] }]);
    expect(applied.next).toMatchObject({ stage: 'delivered', delivery: { outcome: 'chat_only', sheetsConfirmed: false } });
  });

  it('a failed delivery goes back to approved, and the next Deliver runs under a new workflow key', () => {
    const failed = step(delivering(), { type: 'deliveryFinished', v: 1, eventId: 'f', deliveryId, outcome: 'failed', uncertain: [], sheetsConfirmed: false }).applied.next;
    expect(failed.stage).toBe('approved');
    const again = step(failed, office('deliver', TASK0, { approvalId: APPROVAL, comment: 'again' }), {}, T0 + 1).applied;
    expect(effectsOf(again, 'startDelivery')[0]).toMatchObject({ run: 2, deliveryId: `${deliveryId}:archive:2` });
  });

  it('ignores a report of another delivery', () => {
    expect(ignored(delivering(), { type: 'deliveryFinished', v: 1, eventId: 'x', deliveryId: 'dl-other', outcome: 'delivered', uncertain: [], sheetsConfirmed: true }).reason).toMatch(/not the one running/);
  });

  it('retryArchive: delivered without the Sheets row → delivering again under the next run\'s key', () => {
    const delivered = step(delivering(), { type: 'deliveryFinished', v: 1, eventId: 'd', deliveryId, outcome: 'chat_only', uncertain: [], sheetsConfirmed: false }).applied.next;
    const { applied, ops } = step(delivered, office('retryArchive', TASK0));
    expect(ops).toEqual([{ op: 'transition', taskId: TASK0, reason: expect.stringMatching(/archive/) }]);
    expect(applied.next).toMatchObject({ stage: 'delivering', delivery: { run: 2, deliveryId: `${deliveryId}:archive:2` } });
    const archived = step(delivering(), { type: 'deliveryFinished', v: 1, eventId: 'd2', deliveryId, outcome: 'delivered', uncertain: [], sheetsConfirmed: true }).applied.next;
    expect(ignored(archived, office('retryArchive', TASK0)).reply).toMatchObject({ code: 'WRONG_STAGE' });
  });
});

describe('cancel', () => {
  it('while designing: cancelled, the task cancelled where its vocabulary allows, the running design cancelled', () => {
    const s = recordRunInvocation(opened(), `dr-${TASK0}`, 'inv_9');
    const { applied, ops } = step(s, { type: 'cancel', v: 1, eventId: 'c', by: 'requester' });
    expect(ops).toEqual([{ op: 'transition', taskId: TASK0, toState: 'cancelled', ifIllegal: 'keep', reason: 'The requester cancelled the request' }]);
    expect(applied.next.stage).toBe('cancelled');
    expect(effectsOf(applied, 'cancelRun')).toEqual([{ type: 'cancelRun', runId: `dr-${TASK0}`, invocationId: 'inv_9' }]);
  });

  it('in review: no run to cancel; the office can cancel through a decision; a cancelled or delivered request stays', () => {
    const { applied } = step(draftSent(), office('cancel', TASK0));
    expect(applied.next.stage).toBe('cancelled');
    expect(effectsOf(applied, 'cancelRun')).toEqual([]);
    expect(applied.reply).toMatchObject({ accepted: true, stage: 'cancelled' });
    expect(ignored(applied.next, { type: 'cancel', v: 1, eventId: 'c2', by: 'office' }).reason).toMatch(/cannot be cancelled/);
  });
});

describe('every event', () => {
  it('moves the revision by one per projection and names the projection by request, revision and event', () => {
    const s0 = opened();
    const s1 = step(s0, finished(`dr-${TASK0}`));
    expect(s1.expectedRev).toBe(1);
    expect(s1.key).toBe(`${REQ}:2:designFinished`);
    expect(s1.applied.next.rev).toBe(2);
  });

  it('a handled event id is ignored after (duplicates beyond Restate\'s retention), the last 64 kept', () => {
    const s = inReview();
    expect(ignored(s, { ...finished(`dr-${TASK0}`) }).reason).toBe('duplicate event');
    let state = draftSent();
    for (let i = 0; i < 70; i++) state = step(state, requester('chg', TASK0, { n: i })).applied.next;
    expect(state.seen).toHaveLength(64);
  });

  it('an event of a newer payload version is not guessed at', () => {
    expect(() => plan(opened(), { ...finished(`dr-${TASK0}`), v: 2 } as unknown as LifecycleEvent, T0)).toThrow(LifecycleStateTooNewError);
  });

  it('an event with no version, or one that is not a whole number, is unreadable, not newer (retrying cannot help)', () => {
    for (const v of [undefined, '1', 0, 1.5, null]) {
      let thrown: unknown;
      try {
        plan(opened(), { ...finished(`dr-${TASK0}`), v } as unknown as LifecycleEvent, T0);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string })?.code, `v=${String(v)}`).toBe('LIFECYCLE_EVENT_UNREADABLE');
      expect(thrown).toBeInstanceOf(LifecycleEventUnreadableError);
    }
  });

  it('an unknown event type is ignored', () => {
    expect(ignored(opened(), { type: 'somethingNew', v: 1, eventId: 'z' } as unknown as LifecycleEvent).reason).toMatch(/unknown event/);
  });

  it('keeps at most 12 rounds', () => {
    let s = draftSent();
    for (let i = 0; i < 14; i++) {
      const taskId = `99999999-0000-4000-8000-${String(i).padStart(12, '0')}`;
      s = step(s, requester('change', s.draft!.taskId, { directive: `change ${i}` }), { createRound: { taskId } }).applied.next;
      s = step(s, finished(`dr-${taskId}`, taskId, undefined, s.round)).applied.next;
    }
    expect(s.rounds).toHaveLength(12);
    expect(s.rounds.at(-1)?.round).toBe(14);
    expect(viewOf(s)).toMatchObject({ requestId: REQ, stage: 'in_review', round: 14, currentTaskId: s.rounds.at(-1)!.taskId });
  });

  it('AHEAD: the state takes Postgres\'s revision, never a lower one', () => {
    const s = draftSent();
    expect(reconcileAhead(s, s.rev + 3).rev).toBe(s.rev + 3);
    expect(reconcileAhead(s, s.rev - 1).rev).toBe(s.rev);
  });
});

describe('upgrade() of every stored state shape', () => {
  const dir = join(import.meta.dirname, 'fixtures', 'lifecycle-state');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

  it('has the shapes this build has written', () => {
    expect(files).toEqual(['v1-2026-09-25-deferred.json', 'v1-2026-09-25-full.json', 'v1-2026-09-25-in-review.json', 'v1-2026-09-25-opened.json']);
  });

  it('keeps a deferred outcome\'s first projection, retried under its key; one without it (written before) or not whole is projected afresh', () => {
    const raw = JSON.parse(readFileSync(join(dir, 'v1-2026-09-25-deferred.json'), 'utf8'));
    const retryEv: LifecycleEvent = { type: 'retryProjection', v: 1, eventId: 'retry:x', runId: raw.outcomeDeferred.runId };
    const kept = upgrade(raw)!;
    expect(projectionRequestFor(kept, retryEv, plan(kept, retryEv, T0) as Projecting)).toMatchObject({ key: raw.outcomeDeferred.projection.key, expectedRev: 1, rev: 2 });
    for (const projection of [undefined, { key: 'k', expectedRev: 1, rev: 5 }, { key: 7, expectedRev: 1, rev: 2 }, 'x']) {
      const s = upgrade({ ...raw, rev: 3, outcomeDeferred: { ...raw.outcomeDeferred, projection } })!;
      expect(s.outcomeDeferred?.projection, JSON.stringify(projection)).toBeUndefined();
      expect(projectionRequestFor(s, retryEv, plan(s, retryEv, T0) as Projecting)).toMatchObject({ key: `${raw.requestId}:4:designFinished`, expectedRev: 3 });
    }
  });

  for (const file of files) {
    it(`reads ${file}, and every event of today's payloads is planned on it without an error`, () => {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const s = upgrade(raw)!;
      expect(s).toMatchObject({ v: 1, requestId: raw.requestId, stage: raw.stage, rev: raw.rev });
      expect(upgrade(JSON.parse(JSON.stringify(s)))).toEqual(s);
      const events = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'lifecycle-events', 'v1-2026-09-25.json'), 'utf8')) as LifecycleEvent[];
      for (const ev of events) expect(() => plan(s, ev, T0), `${file} + ${ev.type}`).not.toThrow();
    });
  }

  it('fills what a minimal v1 left out', () => {
    const minimal = { v: 1, requestId: REQ, tenantId: TENANT, origin: { kind: 'telegram', chatId: CHAT, updateId: 1 }, rev: 0, stage: 'manual' };
    expect(upgrade(minimal)).toEqual({
      ...minimal, clientId: null, chatId: null, owner: 'restate', stageEpoch: 0, stageSince: 0, round: 0, rounds: [], requester: {}, reminders: [], sizes: {}, seen: [],
    });
  });

  it('nothing stored is no request yet', () => {
    expect(upgrade(undefined)).toBeUndefined();
    expect(upgrade(null)).toBeUndefined();
  });

  it('a newer version or stage waits for a newer build; something else is unreadable', () => {
    const base = JSON.parse(readFileSync(join(dir, 'v1-2026-09-25-opened.json'), 'utf8'));
    expect(() => upgrade({ ...base, v: 2 })).toThrow(LifecycleStateTooNewError);
    expect(() => upgrade({ ...base, stage: 'archived' })).toThrow(LifecycleStateTooNewError);
    expect(() => upgrade({ ...base, v: undefined })).toThrow(LifecycleStateUnreadableError);
    expect(() => upgrade({ ...base, requestId: undefined })).toThrow(LifecycleStateUnreadableError);
    expect(() => upgrade('lc')).toThrow(LifecycleStateUnreadableError);
    expect(() => upgrade([base])).toThrow(LifecycleStateUnreadableError);
  });
});

describe('the table', () => {
  it('every event type of the design is covered by the payload fixtures', () => {
    const events = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'lifecycle-events', 'v1-2026-09-25.json'), 'utf8')) as LifecycleEvent[];
    expect(events.map((e) => e.type).sort()).toEqual(['answer', 'cancel', 'deliveryFinished', 'designFinished', 'expire', 'messageSent', 'officeDecision', 'open', 'remind', 'requesterDecision', 'retryProjection']);
    for (const e of events) expect(e.v).toBe(1);
  });
});
