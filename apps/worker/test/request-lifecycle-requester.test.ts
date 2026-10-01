import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { recordRequesterDecision, type AutomaticLifecycleState, type AutomaticOpenContext,
  type RequesterDecisionEvent } from '../src/lifecycle/request-lifecycle.js';

describe('requester revision after Core intake', () => {
  it('adopts the committed intake receipt once and starts the bound revision run', async () => {
    const requestId = randomUUID();
    const priorTaskId = randomUUID();
    const newTaskId = randomUUID();
    const tenantId = '00000000-0000-4000-a000-000000000001';
    let state: AutomaticLifecycleState = {
      v: 1, requestId, tenantId, chatId: '73000001', owner: 'restate', stage: 'manual', rev: 3,
      taskId: priorTaskId, openEventId: `open:${requestId}`, openSha256: 'a'.repeat(64),
      runId: `dr-${priorTaskId}`, designInput: { v: 1, taskId: priorTaskId, tenantId,
        clientId: randomUUID(), rawText: 'Original design', sourcePlatform: 'telegram',
        idempotencyKey: `lifecycle:${requestId}:${priorTaskId}`, canvaAutoGenerate: true,
        lifecycle: { requestId, round: 0, runId: `dr-${priorTaskId}` } },
    };
    const started: unknown[] = [];
    const ctx: AutomaticOpenContext = { key: requestId, get: async () => state,
      run: async (_name, action) => action(), set: (_name, value) => { state = value as AutomaticLifecycleState; },
      send: () => { throw new Error('no message expected'); }, startDesign: (input) => { started.push(input); } };
    const event: RequesterDecisionEvent & { newTaskId: string } = {
      v: 1, eventId: 'chatinbox:revision:12345', requestId, round: 1,
      directive: 'Move the venue to Erbil', priorTaskId, newTaskId,
    };
    const core = { post: vi.fn().mockResolvedValue({ v: 1, requestId, priorTaskId, newTaskId,
      round: 1, rev: 4, stage: 'designing', runId: `dr-${newTaskId}`, directive: event.directive }) };
    expect(await recordRequesterDecision(ctx, core, event)).toMatchObject({ accepted: true,
      newTaskId, rev: 4, stage: 'designing' });
    expect(core.post).toHaveBeenCalledWith(
      `/internal/lifecycle/${requestId}/requester-revision-intake`,
      { v: 1, updateId: 12345, expectedRev: 3, priorTaskId, newTaskId,
        round: 1, directive: event.directive });
    expect(state).toMatchObject({ stage: 'designing', taskId: newTaskId, rev: 4 });
    expect(started).toMatchObject([{ taskId: newTaskId, rawText: event.directive,
      lifecycle: { requestId, round: 1, runId: `dr-${newTaskId}` } }]);
    await recordRequesterDecision(ctx, core, event);
    expect(core.post).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(2);
    await expect(recordRequesterDecision(ctx, core, { ...event, directive: 'Changed under same ID' }))
      .rejects.toThrow('different content');
  });

  it('adopts an answer only for the current question and starts one new design round', async () => {
    const requestId = randomUUID();
    const priorTaskId = randomUUID();
    const newTaskId = randomUUID();
    const questionId = randomUUID();
    const tenantId = '00000000-0000-4000-a000-000000000001';
    let state: AutomaticLifecycleState = {
      v: 1, requestId, tenantId, chatId: '73000002', owner: 'restate',
      stage: 'awaiting_answer', rev: 5, taskId: priorTaskId,
      openEventId: `open:${requestId}`, openSha256: 'a'.repeat(64),
      runId: `dr-${priorTaskId}`, round: 1,
      question: { id: questionId, text: 'Bigger headline?', options: ['Yes', 'No'],
        taskId: priorTaskId, rev: 5 },
      designInput: { v: 1, taskId: priorTaskId, tenantId,
        clientId: randomUUID(), rawText: 'Original design', sourcePlatform: 'telegram',
        idempotencyKey: `lifecycle:${requestId}:${priorTaskId}`, canvaAutoGenerate: true,
        lifecycle: { requestId, round: 1, runId: `dr-${priorTaskId}` } },
    };
    const started: unknown[] = [];
    const ctx: AutomaticOpenContext = { key: requestId, get: async () => state,
      run: async (_name, action) => action(), set: (_name, value) => { state = value as AutomaticLifecycleState; },
      send: () => { throw new Error('no notice expected'); },
      startDesign: (input) => { started.push(input); } };
    const event: RequesterDecisionEvent & { newTaskId: string } = {
      v: 1, eventId: 'chatinbox:revision:12346', requestId, round: 2,
      directive: 'Yes, make it larger', priorTaskId, newTaskId, questionId,
    };
    const core = { post: vi.fn().mockResolvedValue({ v: 1, requestId, priorTaskId,
      newTaskId, round: 2, rev: 6, stage: 'designing', runId: `dr-${newTaskId}`,
      directive: event.directive, questionId }) };
    expect(await recordRequesterDecision(ctx, core, { ...event, questionId: randomUUID() }))
      .toMatchObject({ accepted: false, code: 'WRONG_STAGE' });
    expect(core.post).not.toHaveBeenCalled();
    await expect(recordRequesterDecision(ctx, core, { ...event, eventId: 'manual-answer' }))
      .rejects.toThrow('persisted Telegram update identity');
    expect(core.post).not.toHaveBeenCalled();
    expect(await recordRequesterDecision(ctx, core, event)).toMatchObject({ accepted: true,
      newTaskId, rev: 6, stage: 'designing' });
    expect(core.post).toHaveBeenCalledWith(`/internal/lifecycle/${requestId}/requester-revision-intake`,
      { v: 1, updateId: 12346, expectedRev: 5, priorTaskId, newTaskId,
        round: 2, directive: event.directive, questionId });
    expect(state).toMatchObject({ stage: 'designing', rev: 6, taskId: newTaskId });
    expect(state.question).toBeUndefined();
    expect(started).toMatchObject([{ taskId: newTaskId, lifecycle: { round: 2 } }]);
    await recordRequesterDecision(ctx, core, event);
    expect(core.post).toHaveBeenCalledTimes(1);
  });

  // ADR-200 addendum (incident 2026-10-01 12:33Z): "do a better design thats similar to earlier ones"
  // after delivery. Core admits a new round of the delivered request from the requester's update.
  it('reopens a delivered design for a round admitted from the requester\'s own update, once', async () => {
    const requestId = randomUUID();
    const priorTaskId = randomUUID();
    const newTaskId = randomUUID();
    const tenantId = '00000000-0000-4000-a000-000000000001';
    const delivered = (): AutomaticLifecycleState => ({
      v: 1, requestId, tenantId, chatId: '73000003', owner: 'restate', stage: 'delivered', rev: 6,
      taskId: priorTaskId, openEventId: `open:${requestId}`, openSha256: 'a'.repeat(64),
      runId: `dr-${priorTaskId}`, designInput: { v: 1, taskId: priorTaskId, tenantId,
        clientId: randomUUID(), rawText: 'KAAE K-12 Pilot Study', sourcePlatform: 'telegram',
        idempotencyKey: `lifecycle:${requestId}:${priorTaskId}`, canvaAutoGenerate: true,
        lifecycle: { requestId, round: 0, runId: `dr-${priorTaskId}` } },
      officeRevision: { eventId: 'desk:a', sha256: 'b'.repeat(64), actionId: randomUUID(), revisionId: randomUUID(),
        approvalId: randomUUID(), kind: 'approve' },
      delivery: { startEventId: 'desk:d', startSha256: 'c'.repeat(64), actionId: randomUUID(),
        input: { deliveryId: 'dl-1' } as never, finishEventId: 'delivery:dl-1' },
    });
    let state = delivered();
    const started: unknown[] = [];
    const ctx: AutomaticOpenContext = { key: requestId, get: async () => state,
      run: async (_name, action) => action(), set: (_name, value) => { state = value as AutomaticLifecycleState; },
      send: () => { throw new Error('no message expected'); }, startDesign: (input) => { started.push(input); } };
    const event: RequesterDecisionEvent & { newTaskId: string } = {
      v: 1, eventId: 'chatinbox:revision:22345', requestId, round: 2,
      directive: 'do a better design thats similar to earlier ones', priorTaskId, newTaskId,
    };
    const core = { post: vi.fn().mockResolvedValue({ v: 1, requestId, priorTaskId, newTaskId,
      round: 2, rev: 7, stage: 'designing', runId: `dr-${newTaskId}`, directive: event.directive }) };
    // Only a round Core admitted from a Telegram update reopens it; never a question's answer.
    expect(await recordRequesterDecision(ctx, core, { ...event, questionId: randomUUID() }))
      .toMatchObject({ accepted: false, code: 'WRONG_STAGE' });
    expect(await recordRequesterDecision(ctx, core, { ...event, eventId: 'desk:redo' }))
      .toMatchObject({ accepted: false, code: 'WRONG_STAGE' });
    expect(core.post).not.toHaveBeenCalled();
    expect(await recordRequesterDecision(ctx, core, event)).toMatchObject({ accepted: true, newTaskId, rev: 7, stage: 'designing' });
    expect(core.post).toHaveBeenCalledWith(`/internal/lifecycle/${requestId}/requester-revision-intake`,
      { v: 1, updateId: 22345, expectedRev: 6, priorTaskId, newTaskId, round: 2, directive: event.directive });
    expect(state).toMatchObject({ stage: 'designing', rev: 7, taskId: newTaskId });
    // The finished delivery and approval belong to the round before: the next approval delivers anew.
    expect(state.delivery).toBeUndefined();
    expect(state.officeRevision).toBeUndefined();
    expect(started).toMatchObject([{ taskId: newTaskId, rawText: event.directive, lifecycle: { round: 2 } }]);
    await recordRequesterDecision(ctx, core, event);
    expect(core.post).toHaveBeenCalledTimes(1);
  });

  it('never reopens a delivered design that a designer made by hand', async () => {
    const requestId = randomUUID();
    const tenantId = '00000000-0000-4000-a000-000000000001';
    const state = { v: 1, requestId, tenantId, chatId: '73000004', owner: 'restate', stage: 'delivered', rev: 5,
      taskId: randomUUID(), openEventId: `open:${requestId}`, openSha256: 'a'.repeat(64), origin: 'manual' };
    const ctx = { key: requestId, get: async () => state, run: async (_n: string, a: () => unknown) => a(),
      set: () => { throw new Error('no state change expected'); }, send: () => undefined, startDesign: () => undefined } as unknown as AutomaticOpenContext;
    const core = { post: vi.fn() };
    expect(await recordRequesterDecision(ctx, core, { v: 1, eventId: 'chatinbox:revision:22346', requestId, round: 2,
      directive: 'try again', priorTaskId: state.taskId, newTaskId: randomUUID() } as RequesterDecisionEvent & { newTaskId: string }))
      .toMatchObject({ accepted: false, code: 'WRONG_STAGE' });
    expect(core.post).not.toHaveBeenCalled();
  });
});
