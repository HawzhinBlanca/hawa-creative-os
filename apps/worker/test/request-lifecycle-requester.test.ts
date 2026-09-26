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
});
