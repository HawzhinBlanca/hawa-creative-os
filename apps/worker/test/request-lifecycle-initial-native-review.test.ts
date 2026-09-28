import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { signLifecycleOfficeEvent } from '@hawa/integrations';
import { parseNativeReviewSubmission, type NativeReviewSubmission } from '@hawa/domain';
import { checkSignedNativeReview } from '../src/lifecycle/office-decision-gateway.js';
import type { CoreInternal } from '../src/lifecycle/delivery.js';
import {
  recordNativeReview, recordOfficeRevision, recordOfficeDeliveryStart, recordDeliveryFinished,
  recordDesignFinished, recordRequesterDecision, type AutomaticOpenContext, type ManualLifecycleState,
} from '../src/lifecycle/request-lifecycle.js';

type OwnerState = Awaited<ReturnType<AutomaticOpenContext['get']>>;

/** ADR-126: RequestLifecycle.open saved this state for a manual request; no design run exists. */
function setup() {
  const requestId = randomUUID(), taskId = randomUUID(), actionId = randomUUID(), tenantId = randomUUID();
  const event: NativeReviewSubmission = { v: 1, kind: 'native_review', eventId: `desk:${actionId}`, actionId, requestId, taskId,
    expectedRev: 1, expectedTaskVersion: 2, artifactId: randomUUID(), confirmationEventId: randomUUID(),
    actor: { userId: randomUUID(), role: 'designer' } };
  const opened: ManualLifecycleState = { v: 1, requestId, tenantId, chatId: '73007000', owner: 'restate', stage: 'manual', rev: 1,
    taskId, openEventId: `open:${requestId}`, openSha256: 'b'.repeat(64) };
  let state: OwnerState = opened;
  const journal = new Map<string, unknown>(), sent: unknown[] = [], designs: unknown[] = [], deliveries: unknown[] = [];
  const ctx: AutomaticOpenContext = { key: requestId, get: async () => state,
    run: async <T>(name: string, action: () => Promise<T>) => {
      if (journal.has(name)) return journal.get(name) as T;
      const value = await action(); journal.set(name, value); return value;
    },
    set: (_name, value) => { state = value; }, send: (message) => { sent.push(message); },
    startDesign: (input) => { designs.push(input); }, startDelivery: (input) => { deliveries.push(input); } };
  const reply = { accepted: true as const, requestId, taskId, actionId, revisionId: randomUUID(), rev: 2, stage: 'in_review' as const, qaPassed: true };
  return { event, ctx, reply, state: () => state, sent, designs, deliveries, requestId, taskId };
}

describe('initial manual request native review (no design run)', () => {
  it('admits the exact signed typed submission at request revision 1 only', () => {
    const { event } = setup(), secret = randomUUID();
    expect(parseNativeReviewSubmission(event)).toEqual(event);
    const signed = { v: 1 as const, event, signature: signLifecycleOfficeEvent(secret, event) };
    expect(checkSignedNativeReview(signed, secret)).toBe('ok');
    for (const patch of [{ expectedRev: 0 }, { expectedRev: 1.5 }, { actor: { ...event.actor, role: 'service' } }])
      expect(parseNativeReviewSubmission({ ...event, ...patch })).toBeUndefined();
  });

  it('adopts one Core projection through lost replies and a state-save failure, without a run', async () => {
    const { event, ctx, reply, state, sent, designs } = setup();
    const core = { post: vi.fn().mockRejectedValueOnce(new Error('Core answer lost')).mockResolvedValue(reply) };
    await expect(recordNativeReview(ctx, core, event)).rejects.toThrow('answer lost');
    expect(state()?.stage).toBe('manual');
    const original = ctx.set; let crash = true;
    ctx.set = (name, value) => { original(name, value); if (crash) { crash = false; throw new Error('Stopped after state save'); } };
    await expect(recordNativeReview(ctx, core, event)).rejects.toThrow('after state save');
    expect(state()).toMatchObject({ stage: 'in_review', rev: 2, origin: 'manual', outcome: { revisionId: reply.revisionId } });
    expect(state()).not.toHaveProperty('runId');expect(state()).not.toHaveProperty('designInput');
    expect(await recordNativeReview(ctx, core, event)).toEqual(reply);
    expect(core.post).toHaveBeenCalledTimes(2);
    expect(core.post).toHaveBeenLastCalledWith(`/internal/lifecycle/${event.requestId}/native-review`, event);
    await expect(recordNativeReview(ctx, core, { ...event, artifactId: randomUUID() })).rejects.toThrow('different content');
    expect(sent).toHaveLength(0);expect(designs).toHaveLength(0);
  });

  it('refuses stale or other-task submissions and malformed Core proof without advancing', async () => {
    const { event, ctx, reply, state } = setup();
    const core = { post: vi.fn().mockResolvedValue({ ...reply, rev: 3 }) };
    expect(await recordNativeReview(ctx, core, { ...event, expectedRev: 2 })).toEqual({ accepted: false, code: 'WRONG_STAGE' });
    expect(await recordNativeReview(ctx, core, { ...event, taskId: randomUUID() })).toEqual({ accepted: false, code: 'WRONG_STAGE' });
    expect(core.post).not.toHaveBeenCalled();
    await expect(recordNativeReview(ctx, core, event)).rejects.toThrow('valid native review projection');
    expect(state()).toMatchObject({ stage: 'manual', rev: 1 });expect(state()).not.toHaveProperty('origin');
  });

  it('approves and delivers the reviewed manual draft, refuses revision rounds and never rewinds', async () => {
    const { event, ctx, reply, state, sent, designs, deliveries, requestId, taskId } = setup();
    const approvalId = randomUUID(), deliveryId = randomUUID();
    const handle = vi.fn(async (path: string, raw: unknown): Promise<unknown> => {
      const body = raw as { ops: Array<{ actionId: string }> };
      if (path.endsWith('/native-review')) return reply;
      if (path.endsWith('/office-decision')) return { v: 1, requestId, taskId, revisionId: reply.revisionId, actionId: body.ops[0].actionId,
        approvalId, taskState: 'approved', rev: 3, stage: 'approved' };
      if (path.endsWith('/delivery-start')) return { v: 1, requestId, taskId, approvalId, actionId: body.ops[0].actionId, stage: 'delivering', rev: 4,
        delivery: { requestId, taskId, approvalId, revisionId: reply.revisionId, deliveryId, reportTo: 'lifecycle', requestRev: 4, run: 1 } };
      if (path.endsWith('/delivery-finished')) return { v: 1, requestId, taskId, approvalId, deliveryId, stage: 'delivered', taskState: 'complete', rev: 5 };
      throw new Error(`Unexpected Core path ${path}`);
    });
    const core: CoreInternal = { post: <T>(path: string, body: unknown) => handle(path, body) as Promise<T> };
    await recordNativeReview(ctx, core, event);
    const actor = { userId: randomUUID(), role: 'art_director' };
    const revise = { v: 1 as const, eventId: '', requestId, taskId, revisionId: reply.revisionId, actionId: randomUUID(), expectedRev: 2,
      kind: 'revise' as const, actor, reason: 'Move the date lower.' };
    revise.eventId = `desk:${revise.actionId}`;
    expect(await recordOfficeRevision(ctx, core, revise)).toEqual({ accepted: false, code: 'WRONG_STAGE' });
    expect(handle).toHaveBeenCalledTimes(1);expect(state()?.stage).toBe('in_review');
    const approveId = randomUUID();
    const approve = { ...revise, kind: 'approve' as const, actionId: approveId, eventId: `desk:${approveId}`, reason: 'Checked.',
      approvalProof: { qcRunId: randomUUID(), qcReportHash: 'd'.repeat(64), pinnedExports: [{ artifactId: randomUUID(), sha256: 'e'.repeat(64), format: 'png' as const, byteSize: 64 }] },
      deskRequestFingerprint: 'f'.repeat(64) };
    const approved = await recordOfficeRevision(ctx, core, approve);
    expect(approved).toMatchObject({ accepted: true, stage: 'approved', rev: 3, approvalId });
    expect(state()).toMatchObject({ stage: 'approved', rev: 3, origin: 'manual' });
    // An exact old native submission replays its receipt; it cannot move the request back to review.
    expect(await recordNativeReview(ctx, core, event)).toEqual(reply);
    expect(state()).toMatchObject({ stage: 'approved', rev: 3 });
    const deliverId = randomUUID();
    const deliver = { v: 1 as const, kind: 'deliver' as const, eventId: `desk:${deliverId}`, requestId, taskId, revisionId: reply.revisionId,
      approvalId, actionId: deliverId, expectedRev: 3, actor, reason: 'Deliver the approved design.' };
    expect(await recordOfficeDeliveryStart(ctx, core, deliver)).toMatchObject({ accepted: true, stage: 'delivering', rev: 4, deliveryId });
    expect(deliveries).toHaveLength(1);
    const finished = await recordDeliveryFinished(ctx, core, { v: 1, eventId: `delivery:${deliveryId}`, requestId, taskId, approvalId,
      deliveryId, run: 1, expectedRev: 4, outcome: { outcome: 'delivered', uncertain: [], sheetsConfirmed: true, archived: true, filesSent: 1 } });
    expect(finished).toMatchObject({ stage: 'delivered', rev: 5 });
    expect(state()).toMatchObject({ stage: 'delivered', rev: 5, origin: 'manual' });
    expect(await recordNativeReview(ctx, core, event)).toEqual(reply);
    expect(state()).toMatchObject({ stage: 'delivered', rev: 5 });
    expect(sent).toHaveLength(0);expect(designs).toHaveLength(0);
  });

  it('never starts or adopts a design run for the manual origin', async () => {
    const { event, ctx, reply, state, designs, requestId, taskId } = setup();
    const core = { post: vi.fn().mockResolvedValue(reply) };
    await recordNativeReview(ctx, core, event);
    expect(await recordDesignFinished(ctx, core, { v: 1, eventId: `dr-finished:dr-${taskId}`, requestId, runId: `dr-${taskId}`, round: 0, taskId,
      report: { status: 'DRAFT_READY' } })).toEqual({ ignored: true });
    const decision = { v: 1 as const, eventId: 'chatinbox:revision:7', requestId, round: 1, directive: 'New date',
      priorTaskId: taskId, newTaskId: randomUUID() };
    expect(await recordRequesterDecision(ctx, core, decision)).toEqual({ accepted: false, code: 'WRONG_STAGE' });
    expect(core.post).toHaveBeenCalledTimes(1);expect(designs).toHaveLength(0);expect(state()?.stage).toBe('in_review');
  });
});
