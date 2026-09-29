/**
 * ADR-142: RequestLifecycle.officeRetry designs the current task again after its automatic design
 * ended without a draft; the DesignRun of an attempt runs under its own key.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { recordDesignFinished, recordOfficeRetry, type AutomaticLifecycleState, type AutomaticOpenContext,
  type LifecycleState, type OfficeRetryEvent } from '../src/lifecycle/request-lifecycle.js';
import { designRunKeyMatches, validDesignRun, type DesignRunInput } from '../src/lifecycle/design-run.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';

class Context implements AutomaticOpenContext {
  journal = new Map<string, unknown>();
  started: DesignRunInput[] = [];
  constructor(readonly key: string, public state: LifecycleState) {}
  async get() { return this.state; }
  async run<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (this.journal.has(name)) return this.journal.get(name) as T;
    const result = await action();
    this.journal.set(name, result);
    return result;
  }
  set(_name: string, value: LifecycleState) { this.state = value; }
  send(): void { throw new Error('an office retry sends the requester nothing'); }
  startDesign(input: DesignRunInput) { this.started.push(input); }
}

function failed(overrides: Partial<AutomaticLifecycleState> = {}) {
  const requestId = randomUUID(), taskId = randomUUID(), actionId = randomUUID(), runId = `dr-${taskId}`;
  const state: AutomaticLifecycleState = { v: 1, requestId, tenantId, chatId: '73000002', owner: 'restate', stage: 'manual', rev: 2,
    taskId, openEventId: `open:${requestId}`, openSha256: 'a'.repeat(64), runId,
    designInput: { v: 1, taskId, tenantId, clientId, rawText: 'Report cover', sourcePlatform: 'telegram',
      idempotencyKey: `lifecycle:${requestId}:${taskId}`, canvaAutoGenerate: true, designStudio: true, lifecycle: { requestId, round: 0, runId } },
    outcome: { eventId: `dr-finished:${runId}`, sha256: 'b'.repeat(64), status: 'DESIGN_FAILED' }, ...overrides };
  const event: OfficeRetryEvent = { v: 1, kind: 'retry', eventId: `desk:${actionId}`, requestId, taskId, actionId, expectedRev: 2,
    actor: { userId: randomUUID(), role: 'operator' }, reason: 'Retry after the run-limit fix' };
  const core = { post: vi.fn(async (path: string, body: any) => {
    const attempt = 1;
    return { v: 1, requestId, taskId, actionId: body.ops[0].actionId, rev: body.rev, stage: 'designing',
      runId: `dr-${taskId}-a${attempt}`, attempt, taskState: 'received', path };
  }) };
  return { ctx: new Context(requestId, state), event, core, requestId, taskId };
}

describe('RequestLifecycle.officeRetry (ADR-142)', () => {
  it('projects the retry in Core, then starts the same task under an attempt run with its own Studio key', async () => {
    const { ctx, event, core, requestId, taskId } = failed();
    const reply = await recordOfficeRetry(ctx, core as any, event);
    expect(reply).toEqual({ accepted: true, requestId, taskId, actionId: event.actionId, runId: `dr-${taskId}-a1`, attempt: 1, stage: 'designing', rev: 3 });
    expect(core.post).toHaveBeenCalledTimes(1);
    expect(core.post.mock.calls[0][0]).toBe(`/internal/lifecycle/${requestId}/office-retry`);
    expect(core.post.mock.calls[0][1]).toEqual({ v: 1, expectedRev: 2, rev: 3,
      key: `${requestId}:3:officeRetry:desk:${event.actionId}`,
      ops: [{ kind: 'retryDesign', taskId, actionId: event.actionId, actor: event.actor, reason: event.reason }] });
    expect(ctx.started).toHaveLength(1);
    expect(ctx.started[0]).toMatchObject({ taskId, redriveAttempt: 1, lifecycle: { requestId, round: 0, runId: `dr-${taskId}-a1` } });
    expect(validDesignRun(ctx.started[0], `dr-${taskId}-a1`)).toBe(true);
    expect(ctx.state).toMatchObject({ stage: 'designing', rev: 3, runId: `dr-${taskId}-a1`, outcome: undefined,
      officeRetry: { eventId: event.eventId, attempt: 1, runId: `dr-${taskId}-a1`, rev: 3 } });

    // A replay after a crash answers the same and starts the same workflow key again (it runs once).
    expect(await recordOfficeRetry(ctx, core as any, event)).toEqual(reply);
    expect(core.post).toHaveBeenCalledTimes(1);
    expect(ctx.started.map((i) => i.lifecycle.runId)).toEqual([`dr-${taskId}-a1`, `dr-${taskId}-a1`]);
    await expect(recordOfficeRetry(ctx, core as any, { ...event, reason: 'different words' })).rejects.toThrow(/different content/);

    // The attempt's report is taken as the current run's; the first run's late report is ignored.
    const outcomeCore = { post: vi.fn(async (_p: string, body: any) => ({ v: 1, requestId, taskId, rev: body.rev, stage: 'manual', status: 'DESIGN_FAILED' })) };
    const ignored = await recordDesignFinished({ ...ctx, get: ctx.get.bind(ctx), set: ctx.set.bind(ctx), run: ctx.run.bind(ctx), send: () => {} } as any,
      outcomeCore as any, { v: 1, eventId: `dr-finished:dr-${taskId}`, requestId, runId: `dr-${taskId}`, round: 0, taskId, report: { status: 'DESIGN_FAILED' } });
    expect(ignored).toEqual({ ignored: true });
    const taken = await recordDesignFinished({ ...ctx, get: ctx.get.bind(ctx), set: ctx.set.bind(ctx), run: ctx.run.bind(ctx), send: () => {} } as any,
      outcomeCore as any, { v: 1, eventId: `dr-finished:dr-${taskId}-a1`, requestId, runId: `dr-${taskId}-a1`, round: 0, taskId, report: { status: 'DESIGN_FAILED' } });
    expect(taken).toMatchObject({ ignored: false, stage: 'manual', rev: 4 });
    expect(outcomeCore.post.mock.calls[0][1]).toMatchObject({ key: `${requestId}:4:designFinished:dr-${taskId}-a1` });
  });

  it('retries only a design that ended without a draft, a question or an office decision', async () => {
    const cases: Array<Partial<AutomaticLifecycleState>> = [
      { stage: 'in_review' }, { stage: 'designing' }, { rev: 4 },
      { outcome: { eventId: 'e', sha256: 'c'.repeat(64), status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', revisionId: randomUUID() } },
      { officeRevision: { eventId: 'e', sha256: 'c'.repeat(64), actionId: randomUUID(), revisionId: randomUUID(), approvalId: randomUUID(), kind: 'revise' } },
      { question: { id: randomUUID(), text: 'Which?', options: ['A', 'B'], taskId: randomUUID(), rev: 2 } },
    ];
    for (const overrides of cases) {
      const { ctx, event, core } = failed(overrides);
      expect(await recordOfficeRetry(ctx, core as any, event)).toEqual({ accepted: false, code: 'WRONG_STAGE' });
      expect(core.post).not.toHaveBeenCalled();
      expect(ctx.started).toEqual([]);
    }
    const { ctx, event, core } = failed();
    for (const bad of [{ ...event, actor: { ...event.actor, role: 'designer' } }, { ...event, eventId: 'desk:other' }, { ...event, reason: ' ' }]) {
      await expect(recordOfficeRetry(ctx, core as any, bad as OfficeRetryEvent)).rejects.toThrow(/LIFECYCLE_OPEN_REFUSED/);
    }
    expect(await recordOfficeRetry(ctx, core as any, { ...event, taskId: randomUUID() })).toEqual({ accepted: false, code: 'NOT_CURRENT_DRAFT' });
  });

  it('a DesignRun key names its attempt, and the attempt names its Studio key', () => {
    const taskId = randomUUID();
    expect(designRunKeyMatches({ taskId }, `dr-${taskId}`)).toBe(true);
    expect(designRunKeyMatches({ taskId, redriveAttempt: 1 }, `dr-${taskId}`)).toBe(false);
    expect(designRunKeyMatches({ taskId, redriveAttempt: 2 }, `dr-${taskId}-a2`)).toBe(true);
    expect(designRunKeyMatches({ taskId, redriveAttempt: 1 }, `dr-${taskId}-a2`)).toBe(false);
    expect(designRunKeyMatches({ taskId }, `dr-${taskId}-a0`)).toBe(false);
    expect(designRunKeyMatches({ taskId, redriveAttempt: 1 }, `dr-${randomUUID()}-a1`)).toBe(false);
  });
});
