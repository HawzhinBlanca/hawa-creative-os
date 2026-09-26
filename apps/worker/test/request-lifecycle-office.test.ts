import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { signLifecycleOfficeEvent } from '@hawa/integrations';
import { recordOfficeRevision, recordReminderTick, type AutomaticLifecycleState, type AutomaticOpenContext,
  type ManualLifecycleState, type OfficeRevisionEvent } from '../src/lifecycle/request-lifecycle.js';
import { checkSignedOfficeDecision } from '../src/lifecycle/office-decision-gateway.js';

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
  sent: unknown[] = [];
  send(msg: unknown): void { this.sent.push(msg); }
  reminders: Array<{ requestId: string; rev: number; delayMs: number }> = [];
  scheduleReminder(requestId: string, rev: number, delayMs: number): void {
    this.reminders.push({ requestId, rev, delayMs });
  }
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
    actor: { userId: randomUUID(), role: 'art_director' }, reason: 'Correct the venue',
    revisionRequest: { scope: 'copy', category: 'factual_error', targetNodes: ['venue'],
      priority: 'high', isReusableFeedback: false, comment: 'Correct the venue' } };
  return { ctx: new Context(requestId, state), event };
}

describe('RequestLifecycle office revision', () => {
  it('admits only an intact, signed office event at the public gateway', () => {
    const { event } = setup();
    const secret = ['office', 'gateway', 'fixture'].join('-');
    const signed = { v: 1 as const, event, signature: signLifecycleOfficeEvent(secret, event) };
    expect(checkSignedOfficeDecision(signed, secret)).toBe('ok');
    expect(checkSignedOfficeDecision({ ...signed, event: { ...event, reason: 'Tampered',
      revisionRequest: { ...event.revisionRequest!, comment: 'Tampered' } } }, secret)).toBe('unauthorized');
    expect(checkSignedOfficeDecision({ ...signed, event: { ...event,
      revisionRequest: { ...event.revisionRequest!, priority: 'critical' } } }, secret)).toBe('unauthorized');
    expect(checkSignedOfficeDecision(signed, 'other-secret')).toBe('unauthorized');
    expect(checkSignedOfficeDecision({ ...signed, event: { ...event, eventId: 'wrong' } }, secret)).toBe('invalid');
    const malformed = { ...event, revisionRequest: { ...event.revisionRequest!, targetNodes: [] } };
    expect(checkSignedOfficeDecision({ v: 1, event: malformed,
      signature: signLifecycleOfficeEvent(secret, malformed) }, secret)).toBe('invalid');
    expect(checkSignedOfficeDecision(signed, '')).toBe('unauthorized');
  });
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
    expect(ctx.sent).toMatchObject([{ key: `${event.requestId}:3:office-revision-notify`,
      chatId: ctx.state.chatId, class: 'critical' }]);
    expect(ctx.reminders).toEqual([{ requestId: event.requestId, rev: 3, delayMs: 24 * 60 * 60_000 }]);
    await recordOfficeRevision(ctx, core, event);
    expect(ctx.sent).toHaveLength(2);
    expect(ctx.sent[0]).toEqual(ctx.sent[1]);
    expect(ctx.reminders).toHaveLength(2);
    expect(core.post).toHaveBeenCalledTimes(2);
    expect(core.post.mock.calls[0]).toEqual(core.post.mock.calls[1]);
    expect(core.post.mock.calls[0][0]).toBe(`/internal/lifecycle/${event.requestId}/office-decision`);
    expect(core.post.mock.calls[0][1]).toMatchObject({ ops: [{ revisionRequest: event.revisionRequest }] });
    await expect(recordOfficeRevision(ctx, core, { ...event, reason: 'Different reason' }))
      .rejects.toThrow('invalid office revision');
    await expect(recordOfficeRevision(ctx, core, { ...event,
      revisionRequest: { ...event.revisionRequest!, priority: 'critical' } }))
      .rejects.toThrow('different content');
  });

  it('sends office comments as literal text and suppresses stale reminders', async () => {
    const { ctx, event } = setup();
    const comment = '<b>Keep this literal</b> & correct the venue';
    const revised = { ...event, reason: comment,
      revisionRequest: { ...event.revisionRequest!, comment } };
    const core = { post: vi.fn().mockResolvedValue({ v: 1, requestId: event.requestId,
      taskId: event.taskId, revisionId: event.revisionId, actionId: event.actionId,
      approvalId: randomUUID(), taskState: 'revision_requested', rev: 3, stage: 'manual' }) };
    await recordOfficeRevision(ctx, core, revised);
    expect(ctx.sent[0]).toMatchObject({ text: expect.stringContaining(comment), class: 'critical' });
    expect(ctx.sent[0]).not.toHaveProperty('parseMode');
    expect(await recordReminderTick(ctx, { v: 1, requestId: event.requestId, expectedRev: 3 }))
      .toEqual({ reminded: true });
    expect(ctx.sent[1]).toMatchObject({ key: `${event.requestId}:3:revision-reminder`, class: 'critical' });
    ctx.state = { ...ctx.state, stage: 'designing', rev: 4 };
    expect(await recordReminderTick(ctx, { v: 1, requestId: event.requestId, expectedRev: 3 }))
      .toEqual({ skipped: true });
    expect(ctx.sent).toHaveLength(2);
    await expect(recordReminderTick(ctx, { v: 1, requestId: randomUUID(), expectedRev: 3 }))
      .rejects.toThrow('invalid revision reminder identity');
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

  it('binds a signed approval to its QA/export proof and replays after the object state save', async () => {
    const { ctx, event: revision } = setup();
    const proof = { qcRunId: randomUUID(), qcReportHash: 'a'.repeat(64),
      pinnedExports: [{ artifactId: randomUUID(), format: 'pptx' as const,
        sha256: 'b'.repeat(64), byteSize: 72 }] };
    const event: OfficeRevisionEvent = { ...revision, kind: 'approve', revisionRequest: undefined,
      reason: 'Approved after checking the export', approvalProof: proof,
      deskRequestFingerprint: 'c'.repeat(64) };
    const secret = ['office', 'approval', 'fixture'].join('-');
    const signed = { v: 1 as const, event, signature: signLifecycleOfficeEvent(secret, event) };
    expect(checkSignedOfficeDecision(signed, secret)).toBe('ok');
    expect(checkSignedOfficeDecision({ ...signed, event: { ...event,
      approvalProof: { ...proof, pinnedExports: [{ ...proof.pinnedExports[0], sha256: 'd'.repeat(64) }] } } }, secret))
      .toBe('unauthorized');
    expect(checkSignedOfficeDecision({ ...signed, event: { ...event,
      approvalProof: { ...proof, pinnedExports: [] } } }, secret)).toBe('invalid');
    const approvalId = randomUUID();
    const result = { v: 1, requestId: event.requestId, taskId: event.taskId,
      revisionId: event.revisionId, actionId: event.actionId, approvalId,
      taskState: 'approved', rev: 3, stage: 'approved' };
    const core = { post: vi.fn().mockResolvedValue(result) };
    ctx.crashAfterSet = true;
    await expect(recordOfficeRevision(ctx, core, event)).rejects.toThrow('worker stopped');
    expect(ctx.state).toMatchObject({ stage: 'approved', rev: 3,
      officeRevision: { approvalId, actionId: event.actionId, kind: 'approve' } });
    expect(await recordOfficeRevision(ctx, core, event)).toMatchObject({
      accepted: true, approvalId, stage: 'approved', rev: 3 });
    expect(core.post).toHaveBeenCalledTimes(1);
    expect(core.post.mock.calls[0][1]).toMatchObject({ ops: [{ kind: 'recordOfficeApproval',
      approvalProof: proof, deskRequestFingerprint: event.deskRequestFingerprint }] });
    await expect(recordOfficeRevision(ctx, core, { ...event, approvalProof: {
      ...proof, pinnedExports: [{ ...proof.pinnedExports[0], sha256: 'd'.repeat(64) }],
    } })).rejects.toThrow('different content');
  });
});
