/**
 * A small world for RequestLifecycle handler tests: Restate's delivery of sends (one-way, delayed,
 * deduplicated by idempotency key), a fake Core projection with Core's rules (a key answers from its
 * record, a revision that is not the expected one is refused), a TelegramSender that reports
 * `onSent` messages back, and design runs the test finishes by hand. Every RequestLifecycle
 * invocation runs on a FakeObjectContext (packages/testkit), so a test can crash any invocation
 * after any journal entry and replay it.
 */
import * as restate from '@restatedev/restate-sdk';
import type {
  CanvaStatusReport,
  LifecycleEventType,
  LifecycleMessage,
  LifecycleStage,
  LifecycleStateV1,
  ProjectionOp,
  ProjectionOpResult,
  ProjectionRequest,
  ProjectionResponse,
} from '@hawa/contracts';
import { upgrade } from '@hawa/domain';
import { FakeCrash, FakeObjectContext, type FakeSend } from '../../../packages/testkit/src/fake-restate-context.js';
import { handleLifecycleEvent, type LifecycleConfig, type LifecycleDeps } from '../src/lifecycle/request-lifecycle.js';
import type { ProjectionAnswer, ProjectionCore } from '../src/lifecycle/projection-client.js';

export const TENANT = '00000000-0000-4000-a000-000000000001';
export const OFFICE = '9000001';
export const CLIENT = 'c1000000-0000-4000-8000-000000000002';
/** Sunday 2026-09-27 10:00 in Erbil: inside office hours. */
export const START = Date.UTC(2026, 8, 27, 7, 0, 0);
export const DAY = 86_400_000;

/** Core's projection endpoint, as part A built it, answering from a script of op results. */
export class FakeProjectionCore implements ProjectionCore {
  readonly pgRev = new Map<string, number>();
  readonly records = new Map<string, { ops: string; response: ProjectionResponse }>();
  /** Every projection Core applied (not replays), in order. */
  readonly applied: ProjectionRequest[] = [];
  calls = 0;
  /** Makes Core not answer (the step keeps failing) while true. */
  down = false;
  /** Overrides the answer for a projection key. */
  override?: (body: ProjectionRequest) => ProjectionAnswer | null;

  async project(requestId: string, body: ProjectionRequest): Promise<ProjectionAnswer> {
    this.calls++;
    if (this.down) throw new Error('Core did not answer: connection refused');
    const forced = this.override?.(body);
    if (forced) return forced;
    const ops = JSON.stringify(body.ops);
    const rec = this.records.get(body.key);
    if (rec) {
      if (rec.ops !== ops) return { kind: 'conflict', conflict: { code: 'KEY_REUSED', pgRev: this.pgRev.get(requestId) ?? 0, expectedRev: body.expectedRev, rev: body.rev } };
      return { kind: 'projected', response: { ...rec.response, status: 'replayed' } };
    }
    const pg = this.pgRev.get(requestId) ?? 0;
    if (pg !== body.expectedRev) {
      return { kind: 'conflict', conflict: { code: pg > body.expectedRev ? 'AHEAD' : 'STALE_REVISION', pgRev: pg, expectedRev: body.expectedRev, rev: body.rev } };
    }
    let stage: LifecycleStage | undefined = body.stage;
    const results = body.ops.map((op) => {
      const r = this.result(requestId, body, op);
      if ('stage' in r && r.stage) stage = r.stage;
      if (op.op === 'createRound') stage = 'designing';
      return r;
    });
    const response: ProjectionResponse = { v: 1, status: 'applied', rev: body.rev, stage: stage ?? 'designing', results };
    this.pgRev.set(requestId, body.rev);
    this.records.set(body.key, { ops, response });
    this.applied.push(structuredClone(body));
    return { kind: 'projected', response };
  }

  private msg(requestId: string, body: ProjectionRequest, text: string, extra: Partial<LifecycleMessage> = {}): LifecycleMessage {
    return { v: 1, key: `${requestId}:${body.rev}:msg:0`, chatId: CHAT_OF.get(requestId) ?? '0', kind: 'text', text, class: 'critical', ...extra };
  }

  private result(requestId: string, body: ProjectionRequest, op: ProjectionOp): ProjectionOpResult {
    switch (op.op) {
      case 'createRequest': {
        CHAT_OF.set(requestId, op.chatId ?? '0');
        return { op: 'createRequest', taskId: `${requestId}-t0`, autoGenerate: op.draft.autoGenerate, stage: op.draft.autoGenerate && op.draft.clientId ? 'designing' : 'manual', messages: [this.msg(requestId, body, 'Got it: your request is in.', { class: 'courtesy' })] };
      }
      case 'createRound':
        return { op: 'createRound', taskId: `${requestId}-t${op.round}`, autoGenerate: true, messages: [this.msg(requestId, body, 'Got it: the change is being made.', { class: 'courtesy' })] };
      case 'recordOutcome': {
        if (op.report.status === 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW') {
          return {
            op: 'recordOutcome', hasDraft: true, revisionId: `rev-${op.taskId}`, designId: String(op.report.designId ?? 'DAF'), stage: 'in_review',
            messages: [this.msg(requestId, body, 'Your draft is ready.', { taskId: op.taskId, onSent: { requestId, what: 'draft', taskId: op.taskId } })],
          };
        }
        if (op.report.status === 'NEEDS_CLARIFICATION') {
          return {
            op: 'recordOutcome', hasDraft: false, question: { id: `q-${op.taskId}`, question: 'Which logo?', options: ['Old', 'New'] }, stage: 'awaiting_answer',
            messages: [this.msg(requestId, body, 'Which logo?', { taskId: op.taskId, onSent: { requestId, what: 'question', taskId: op.taskId } })],
          };
        }
        return { op: 'recordOutcome', hasDraft: false, stage: 'manual', messages: [this.msg(requestId, body, 'The office will make it by hand.')] };
      }
      case 'composeReminder':
        return { op: 'composeReminder', skip: false, messages: [this.msg(requestId, body, `Reminder, day ${op.day}: your ${op.kind} is waiting.`, { taskId: op.taskId })] };
      case 'recordDraftSent': return { op: 'recordDraftSent' };
      case 'recordQuestionSent': return { op: 'recordQuestionSent' };
      case 'closeQuestion': return { op: 'closeQuestion', changed: true };
      case 'recordRequesterAction': return { op: 'recordRequesterAction', messages: [] };
      case 'transition': return { op: 'transition', taskId: op.taskId, fromState: 'x', toState: op.toState ?? 'x', changed: Boolean(op.toState), version: 1, messages: [] };
      case 'recordApproval': return { op: 'recordApproval', approvalId: `ap-${op.taskId}` };
      case 'prepareRedrive': return { op: 'prepareRedrive' };
      case 'bridgeCapturedRevision': return { op: 'bridgeCapturedRevision', revisionId: `rev-captured-${op.taskId}`, messages: [] };
      case 'recordDelivery': return { op: 'recordDelivery', messages: [] };
    }
  }
}

const CHAT_OF = new Map<string, string>();

/** A crash to arm on the n-th RequestLifecycle invocation (0-based, in the order they run). */
export interface CrashPlan {
  invocation: number;
  afterEntry?: number;
  inStep?: string;
}

interface Pending {
  seq: number;
  dueAt: number;
  send: FakeSend;
}

export class LifecycleWorld {
  clock = START;
  readonly core = new FakeProjectionCore();
  readonly states = new Map<string, Map<string, unknown>>();
  /** Every send any invocation journaled, once each, in order: what Restate was asked to deliver. */
  readonly rawSends: FakeSend[] = [];
  /** Messages the fake TelegramSender took, once per key. */
  readonly telegram: LifecycleMessage[] = [];
  /** Design runs started, once per workflow key. */
  readonly runs: Array<{ runId: string; input: Record<string, unknown> }> = [];
  /** Journal length of every RequestLifecycle invocation, in the order they ran. */
  readonly journals: Array<{ handler: string; entries: number; steps: string[] }> = [];
  /** Answers of RequestLifecycle invocations, in order. */
  readonly replies: unknown[] = [];
  readonly failures: Array<{ handler: string; error: unknown }> = [];
  config: LifecycleConfig = { reminderScale: 1, officeChatId: OFFICE };
  private queue: Pending[] = [];
  private seq = 0;
  private accepted = new Set<string>();
  private invocations = 0;

  constructor(private readonly crash: CrashPlan | null = null) {}

  deps(): LifecycleDeps {
    return { core: () => this.core, config: () => this.config };
  }

  stateOf(requestId: string): LifecycleStateV1 | undefined {
    return upgrade(this.states.get(requestId)?.get('lc'));
  }

  /** Runs one RequestLifecycle invocation to completion (crashing and replaying it when planned). */
  async invoke(handler: LifecycleEventType, key: string, payload: unknown): Promise<unknown> {
    const n = this.invocations++;
    const store = this.states.get(key) ?? new Map<string, unknown>();
    this.states.set(key, store);
    const ctx = new FakeObjectContext({ key, state: store, clock: () => this.clock, terminalError: (m) => new restate.TerminalError(m) });
    const plan = this.crash && this.crash.invocation === n ? this.crash : null;
    if (plan?.afterEntry) ctx.crashAfter(plan.afterEntry);
    if (plan?.inStep) ctx.crashInStep(plan.inStep);
    const run = () => handleLifecycleEvent(ctx as unknown as restate.ObjectContext, handler, payload, this.deps());
    let reply: unknown;
    try {
      try {
        reply = await run();
      } catch (err) {
        if (!(err instanceof FakeCrash)) throw err;
        ctx.replay();
        reply = await run();
      }
      ctx.commit();
      this.replies.push(reply);
    } catch (err) {
      this.failures.push({ handler, error: err });
      throw err;
    } finally {
      this.journals.push({ handler, entries: ctx.journal.length, steps: ctx.journal.filter((e) => e.kind === 'run').map((e) => (e as { name: string }).name) });
      for (const send of ctx.sends) this.enqueue(send);
    }
    return reply;
  }

  private enqueue(send: FakeSend): void {
    this.rawSends.push(send);
    this.queue.push({ seq: this.seq++, dueAt: this.clock + send.delayMs, send });
  }

  /** Delivers every send due by now, earliest first, as Restate would (deduplicated by idempotency key). */
  async deliver(): Promise<void> {
    for (;;) {
      const due = this.queue.filter((p) => p.dueAt <= this.clock).sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq)[0];
      if (!due) return;
      this.queue = this.queue.filter((p) => p !== due);
      const s = due.send;
      const dedupe = s.idempotencyKey ? `${s.service}/${s.key}/${s.handler}/${s.idempotencyKey}` : s.target === 'workflow' ? `${s.service}/${s.key}` : null;
      if (dedupe) {
        if (this.accepted.has(dedupe)) continue;
        this.accepted.add(dedupe);
      }
      if (s.service === 'TelegramSender') {
        const m = s.arg as LifecycleMessage;
        this.telegram.push(m);
        if (m.onSent) {
          const eventId = `sent:${m.key}`;
          this.enqueue({ service: 'RequestLifecycle', key: m.onSent.requestId, handler: 'messageSent', target: 'object', delayMs: 0, idempotencyKey: eventId, invocationId: `inv_sent_${m.key}`,
            arg: { v: 1, eventId, key: m.key, what: m.onSent.what, taskId: m.onSent.taskId, at: this.clock } });
        }
      } else if (s.service === 'DesignRun') {
        this.runs.push({ runId: String(s.key), input: s.arg as Record<string, unknown> });
      } else if (s.service === 'RequestLifecycle') {
        await this.invoke(s.handler as LifecycleEventType, String(s.key), s.arg);
      }
    }
  }

  /** Moves the clock and delivers what fell due, in order. */
  async advance(ms: number): Promise<void> {
    const until = this.clock + ms;
    for (;;) {
      const next = this.queue.filter((p) => p.dueAt <= until).sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq)[0];
      if (!next) break;
      this.clock = Math.max(this.clock, next.dueAt);
      await this.deliver();
    }
    this.clock = until;
    await this.deliver();
  }

  /** A design run reports, as DesignRun's `report` does (one-way, keyed dr-finished:<runId>). */
  async finishRun(requestId: string, runId: string, round: number, taskId: string, report: CanvaStatusReport): Promise<void> {
    const eventId = `dr-finished:${runId}`;
    this.enqueue({ service: 'RequestLifecycle', key: requestId, handler: 'designFinished', target: 'object', delayMs: 0, idempotencyKey: eventId, invocationId: `inv_${eventId}`,
      arg: { v: 1, eventId, runId, round, taskId, report } });
    await this.deliver();
  }

  /** What an uninterrupted and a crashed-and-replayed run must agree on. */
  snapshot(requestId: string) {
    return {
      applied: this.core.applied.map((p) => `${p.key} ${p.ops.map((o) => o.op).join('+')}`),
      rawSends: this.rawSends.map((s) => `${s.service}/${s.key}/${s.handler} +${s.delayMs} ${s.idempotencyKey ?? ''}`),
      telegram: this.telegram.map((m) => `${m.chatId} ${m.key} ${m.text}`),
      runs: this.runs.map((r) => r.runId),
      state: this.stateOf(requestId),
      pending: this.queue.map((p) => `${p.dueAt - START} ${p.send.service}/${p.send.handler} ${p.send.idempotencyKey ?? ''}`).sort(),
      replies: this.replies,
    };
  }
}
