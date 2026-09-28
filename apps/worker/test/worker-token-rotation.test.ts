import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeliveryInput } from '@hawa/contracts';
import { deliveryWorkflowId } from '@hawa/contracts';
import { signLifecycleDeliveryClaim, signLifecycleOfficeEvent } from '@hawa/integrations';
import { runDelivery, type CoreInternal, type DeliveryContext } from '../src/lifecycle/delivery.js';
import { checkSignedOfficeDecision } from '../src/lifecycle/office-decision-gateway.js';
import { acceptedWorkerSecrets } from '../src/lifecycle/worker-secrets.js';
import type { OfficeRevisionEvent } from '../src/lifecycle/request-lifecycle.js';

/**
 * Phase 4 operations finding 4 (ADR-129), the worker's side. During a rotation Core signs with
 * HAWA_WORKER_TOKEN_PREVIOUS (the value a colour still draining holds), and a claim Core signed before
 * the rotation can be replayed later. A colour started during the rotation therefore verifies with
 * either value; it still calls Core with its current one.
 */
const CURRENT = ['worker', 'rotation', 'current', 'fixture'].join('_');
const PREVIOUS = ['worker', 'rotation', 'previous', 'fixture'].join('_');
const saved = { current: process.env.HAWA_WORKER_TOKEN, previous: process.env.HAWA_WORKER_TOKEN_PREVIOUS };

function restore(name: 'HAWA_WORKER_TOKEN' | 'HAWA_WORKER_TOKEN_PREVIOUS', value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

function lifecycleInput(secret: string): DeliveryInput {
  const taskId = randomUUID(); const approvalId = randomUUID();
  const unsigned: DeliveryInput = { v: 1, requestId: randomUUID(), deliveryId: deliveryWorkflowId(taskId, approvalId), tenantId: '00000000-0000-4000-a000-000000000001',
    taskId, approvalId, revisionId: randomUUID(), chatId: '7200009', officeChatId: '9000009', reportTo: 'lifecycle', requestRev: 4, run: 1 };
  return { ...unsigned, claimSignature: signLifecycleDeliveryClaim(secret, unsigned) };
}

/** Stops the workflow at its first Core call, which comes only after the claim was verified. */
function stoppedAtPrepare() {
  const ctx: DeliveryContext = { run: (_name, action) => action(), send: async () => ({ outcome: 'sent', messageId: '1' }), reportLifecycle: async () => ({}) as any };
  const core: CoreInternal = { async post<T>(): Promise<T> { throw new Error('REACHED_PREPARE'); } };
  return { ctx, core };
}

describe('the worker during a HAWA_WORKER_TOKEN rotation', () => {
  afterEach(() => { restore('HAWA_WORKER_TOKEN', saved.current); restore('HAWA_WORKER_TOKEN_PREVIOUS', saved.previous); });

  it('acceptedWorkerSecrets lists the current value, then the previous one when it is set and differs', () => {
    expect(acceptedWorkerSecrets({ HAWA_WORKER_TOKEN: CURRENT, HAWA_WORKER_TOKEN_PREVIOUS: PREVIOUS })).toEqual([CURRENT, PREVIOUS]);
    expect(acceptedWorkerSecrets({ HAWA_WORKER_TOKEN: CURRENT, HAWA_WORKER_TOKEN_PREVIOUS: CURRENT })).toEqual([CURRENT]);
    expect(acceptedWorkerSecrets({ HAWA_WORKER_TOKEN: CURRENT, HAWA_WORKER_TOKEN_PREVIOUS: 'short' })).toEqual([CURRENT]);
    expect(acceptedWorkerSecrets({})).toEqual([]);
  });

  it('a delivery claim Core signed with the previous value is accepted, and one signed with neither is refused', async () => {
    process.env.HAWA_WORKER_TOKEN = CURRENT;
    process.env.HAWA_WORKER_TOKEN_PREVIOUS = PREVIOUS;
    const h = stoppedAtPrepare();
    await expect(runDelivery(h.ctx, h.core, lifecycleInput(PREVIOUS))).rejects.toThrow('REACHED_PREPARE');
    await expect(runDelivery(h.ctx, h.core, lifecycleInput(CURRENT))).rejects.toThrow('REACHED_PREPARE');
    await expect(runDelivery(h.ctx, h.core, lifecycleInput(['unrelated', 'claim', 'secret', 'value'].join('_')))).rejects.toThrow(/INVALID_LIFECYCLE_DELIVERY_CLAIM/);
    delete process.env.HAWA_WORKER_TOKEN_PREVIOUS;
    await expect(runDelivery(h.ctx, h.core, lifecycleInput(PREVIOUS))).rejects.toThrow(/INVALID_LIFECYCLE_DELIVERY_CLAIM/);
  });

  it('the office decision gateway verifies with either value', () => {
    const requestId = randomUUID(); const taskId = randomUUID(); const revisionId = randomUUID(); const actionId = randomUUID();
    const event: OfficeRevisionEvent = { v: 1, eventId: `desk:${actionId}`, requestId, taskId, revisionId, actionId, expectedRev: 2, kind: 'revise',
      actor: { userId: randomUUID(), role: 'art_director' }, reason: 'Correct the venue',
      revisionRequest: { scope: 'copy', category: 'factual_error', targetNodes: ['venue'], priority: 'high', isReusableFeedback: false, comment: 'Correct the venue' } };
    const signedWith = (secret: string) => ({ v: 1 as const, event, signature: signLifecycleOfficeEvent(secret, event) });
    expect(checkSignedOfficeDecision(signedWith(PREVIOUS), [CURRENT, PREVIOUS])).toBe('ok');
    expect(checkSignedOfficeDecision(signedWith(CURRENT), [CURRENT, PREVIOUS])).toBe('ok');
    expect(checkSignedOfficeDecision(signedWith(PREVIOUS), [CURRENT])).toBe('unauthorized');
    expect(checkSignedOfficeDecision(signedWith(CURRENT), CURRENT)).toBe('ok');
  });
});
