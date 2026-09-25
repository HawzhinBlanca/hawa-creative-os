import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { recordOfficeRevision, type AutomaticLifecycleState, type AutomaticOpenContext,
  type ManualLifecycleState, type OfficeRevisionEvent } from '../src/lifecycle/request-lifecycle.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';

class Context implements AutomaticOpenContext {
  journal = new Map<string, unknown>();
  crashAfterSet = false;
  constructor(readonly key: string, public state: AutomaticLifecycleState) {}
  async get(): Promise<AutomaticLifecycleState> { return this.state; }
  async run<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (this.journal.has(name)) return this.journal.get(name) as T;
    const result = await action();
    this.journal.set(name, result);
    return result;
  }
  set(_name: string, value: ManualLifecycleState | AutomaticLifecycleState): void {
    this.state = value as AutomaticLifecycleState;
    if (this.crashAfterSet) { this.crashAfterSet = false; throw new Error('worker stopped after state save'); }
  }
  send(): void { throw new Error('office revision sends no message'); }
  startDesign(): void { throw new Error('office revision starts no design'); }
}

function setup() {
  const requestId = randomUUID();
  const taskId = randomUUID();
  const revisionId = randomUUID();
  const actionId = randomUUID();
  const runId = `dr-${taskId}`;
  const state: AutomaticLifecycleState = {
    v: 1, requestId, tenantId, chatId: '73000001', owner: 'restate', stage: 'in_review', rev: 2,
    taskId, openEventId: `open:${requestId}`, openSha256: 'a'.repeat(64), runId,
    designInput: { v: 1, taskId, tenantId, clientId, rawText: 'Autumn workshop',
      sourcePlatform: 'telegram', idempotencyKey: `lifecycle:${requestId}:${taskId}`,
      canvaAutoGenerate: true, lifecycle: { requestId, round: 0, runId } },
    outcome: { eventId: `dr-finished:${runId}`, sha256: 'b'.repeat(64),
      status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', revisionId },
  };
  const event: OfficeRevisionEvent = { v: 1, eventId: `desk:${actionId}`, requestId,
    taskId, revisionId, actionId, expectedRev: 2, kind: 'revise',
    actor: { userId: randomUUID(), role: 'art_director' }, reason: 'Correct the venue' };
  return { ctx: new Context(requestId, state), event };
}

describe('RequestLifecycle office revision', () => {
  it('reuses the same revision receipt after a lost Core answer and a crash after state save', async () => {
    const { ctx, event } = setup();
    const approvalId = randomUUID();
    const result = { v: 1, requestId: event.requestId, taskId: event.taskId,
      revisionId: event.revisionId, actionId: event.actionId, approvalId,
      taskState: 'revision_requested', rev: 3, stage: 'manual' };
    const core = { post: vi.fn().mockRejectedValueOnce(new Error('response lost after commit'))
      .mockResolvedValue(result) };
    await expect(recordOfficeRevision(ctx, core, event)).rejects.toThrow('response lost');
    expect(ctx.state.rev).toBe(2);
    ctx.crashAfterSet = true;
    await expect(recordOfficeRevision(ctx, core, event)).rejects.toThrow('worker stopped');
    expect(ctx.state).toMatchObject({ stage: 'manual', rev: 3,
      officeRevision: { approvalId, actionId: event.actionId } });
    expect(await recordOfficeRevision(ctx, core, event)).toMatchObject({
      accepted: true, approvalId, stage: 'manual', rev: 3 });
    expect(core.post).toHaveBeenCalledTimes(2);
    expect(core.post.mock.calls[0]).toEqual(core.post.mock.calls[1]);
    expect(core.post.mock.calls[0][0]).toBe(`/internal/lifecycle/${event.requestId}/office-decision`);
    await expect(recordOfficeRevision(ctx, core, { ...event, reason: 'Different reason' }))
      .rejects.toThrow('different content');
  });

  it('refuses a stale draft or untrusted reviewer before a Core effect', async () => {
    const { ctx, event } = setup();
    const core = { post: vi.fn() };
    expect(await recordOfficeRevision(ctx, core, { ...event, revisionId: randomUUID() }))
      .toEqual({ accepted: false, code: 'NOT_CURRENT_DRAFT' });
    await expect(recordOfficeRevision(ctx, core, { ...event,
      actor: { userId: event.actor.userId, role: 'operator' } })).rejects.toThrow('invalid office revision');
    expect(core.post).not.toHaveBeenCalled();
  });
});
