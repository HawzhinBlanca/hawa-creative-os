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
});
