/**
 * ADR-233 (live test 2026-10-01, L13): the requester hears that a round started only once Core has
 * admitted its design. The owner heard "I'll redo …" from ChatInbox and, the same second, "A designer
 * will make this change … by hand" from the refused round's outcome.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboundMessage } from '@hawa/contracts';
import { DurableStepJournal } from '../src/durable-context.js';
import { runOwnedDesign, validStartNotice, type DesignRunInput } from '../src/lifecycle/design-run.js';
import { recordRequesterDecision, type AutomaticLifecycleState, type AutomaticOpenContext } from '../src/lifecycle/request-lifecycle.js';

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
afterEach(() => vi.unstubAllEnvs());

function studioRun(): { input: DesignRunInput; requestId: string; taskId: string } {
  vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
  vi.stubEnv('HAWA_WORKER_TOKEN', ['start', 'notice', 'fixture'].join('_'));
  const taskId = randomUUID(); const requestId = randomUUID();
  return { requestId, taskId, input: { v: 1, lifecycle: { requestId, round: 1, runId: `dr-${taskId}` }, taskId, tenantId, clientId,
    rawText: 'do a better design', sourcePlatform: 'telegram', idempotencyKey: `lifecycle:${requestId}:${taskId}`,
    canvaAutoGenerate: true, designStudio: true,
    startNotice: { key: 'chatinbox:change-taken:1700000001', chatId: '555', text: "I'll redo <b>Poster</b>", parseMode: 'HTML' } } };
}

describe('a round\'s start notice waits for Core\'s admission (ADR-233)', () => {
  it('a round Core refuses at admission is never announced: only its outcome is reported', async () => {
    const { input, requestId } = studioRun();
    const remote = vi.fn(async (url: string) => String(url).endsWith('/canva/studio')
      ? Response.json({ title: 'NATIVE_REVISION_HANDOFF_REQUIRED', code: 'NATIVE_REVISION_HANDOFF_REQUIRED' }, { status: 422 })
      : Response.json({ tenantId, clientId, requestId }));
    const order: string[] = [];
    const result = await runOwnedDesign(input, input.lifecycle.runId, new DurableStepJournal(),
      (outcome) => order.push(`report:${outcome.status}:${outcome.code}`), remote as unknown as typeof fetch, () => order.push('started'));
    expect(result.status).toBe('DESIGN_REJECTED');
    expect(order).toEqual(['report:DESIGN_REJECTED:NATIVE_REVISION_HANDOFF_REQUIRED']);
  });

  it('an admitted run is announced once, before its outcome', async () => {
    const { input, requestId } = studioRun();
    const runId = randomUUID();
    const remote = vi.fn(async (url: string) => String(url).endsWith('/canva/studio')
      ? Response.json({ runId, status: 'failed', diagnostic: 'synthetic' })
      : Response.json({ tenantId, clientId, requestId }));
    const order: string[] = [];
    await runOwnedDesign(input, input.lifecycle.runId, new DurableStepJournal(),
      (outcome) => order.push(`report:${outcome.status}`), remote as unknown as typeof fetch, () => order.push('started'));
    expect(order).toEqual(['started', 'report:DESIGN_FAILED']);
  });

  it('RequestLifecycle carries the notice to the round\'s run only, and refuses one for another chat', async () => {
    const requestId = randomUUID(); const priorTaskId = randomUUID(); const newTaskId = randomUUID();
    const designInput: DesignRunInput = { v: 1, lifecycle: { requestId, round: 0, runId: `dr-${priorTaskId}` }, taskId: priorTaskId, tenantId,
      clientId, rawText: 'brief', sourcePlatform: 'telegram', idempotencyKey: `lifecycle:${requestId}:${priorTaskId}`, canvaAutoGenerate: true,
      startNotice: { key: 'old-round:notice', chatId: '555', text: 'an earlier round' } };
    let state: AutomaticLifecycleState = { v: 1, requestId, tenantId, chatId: '555', owner: 'restate', stage: 'delivered', rev: 6,
      taskId: priorTaskId, openEventId: `open:${requestId}`, openSha256: 'a'.repeat(64), runId: `dr-${priorTaskId}`, designInput };
    const started: DesignRunInput[] = []; const sent: OutboundMessage[] = [];
    const ctx: AutomaticOpenContext = { key: requestId, get: async () => state, run: async (_n, action) => action(),
      set: (_n, value) => { state = value as AutomaticLifecycleState; }, send: (m) => { sent.push(m); }, startDesign: (i) => { started.push(i); } };
    const core = { post: async <T>(): Promise<T> => ({ v: 1, requestId, priorTaskId, newTaskId, round: 1, rev: 7, stage: 'designing',
      runId: `dr-${newTaskId}`, directive: 'do a better design' }) as T };
    const event = { v: 1 as const, eventId: 'chatinbox:revision:1700000001', requestId, round: 1, directive: 'do a better design',
      priorTaskId, newTaskId };
    await expect(recordRequesterDecision(ctx, core, { ...event, startNotice: { key: 'chatinbox:change-taken:1700000001', chatId: '999', text: 'x' } }))
      .rejects.toThrow('invalid start notice');
    const notice = { key: 'chatinbox:change-taken:1700000001', chatId: '555', text: "I'll redo <b>Poster</b>", parseMode: 'HTML' as const };
    await recordRequesterDecision(ctx, core, { ...event, startNotice: notice });
    expect(started.at(-1)?.startNotice).toEqual(notice);
    expect(sent).toEqual([]);
    // A decision without words of its own never repeats an earlier round's.
    expect(validStartNotice({ ...notice, extra: 1 }, '555')).toBe(false);
    expect(validStartNotice(notice, '555')).toBe(true);
  });
});
