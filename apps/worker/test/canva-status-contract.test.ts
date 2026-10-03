import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCanvaDraft } from '../src/canva-draft-workflow.js';
import { DurableStepJournal } from '../src/durable-context.js';
import { OutboxConsumer } from '../src/outbox-consumer.js';
import type { WorkflowInput } from '../src/design-input.js';

/**
 * N4, the worker's half of the canva-status contract (architecture programme 1.3). Core's half is
 * apps/core/test/canva-status-contract.test.ts; both read the same recorded file, so a change to the
 * bodies the worker sends, or to the answers Core gives, fails on the side that did not change.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(fs.readFileSync(path.join(here, '../../../packages/testkit/fixtures/canva-status-contract.json'), 'utf8')) as {
  fields: string[];
  requests: Record<string, Record<string, unknown>>;
  answers: Record<string, { status: number; title?: string; body?: Record<string, unknown> }>;
};

const input: WorkflowInput = {
  taskId: '00000000-0000-4000-c000-000000000001', tenantId: 'tenant', clientId: 'client', rawText: '',
  sourcePlatform: 'telegram', idempotencyKey: 'key', canvaAutoGenerate: true,
};

/** A Core that answers the worker's calls in order and records every outcome report. */
function core(replies: Array<Response | Record<string, unknown>>, report: () => Response = () => Response.json({ ok: true })) {
  const reports: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/notifications/canva-status')) {
      reports.push(JSON.parse(String(init?.body)));
      return report();
    }
    const next = replies.shift() ?? { ok: true };
    return next instanceof Response ? next : Response.json(next);
  });
  return { fetcher: fetcher as unknown as typeof fetch, reports };
}

const answerOf = (name: string) => {
  const a = contract.answers[name];
  return () => Response.json(a.body ?? { title: a.title, status: a.status }, { status: a.status });
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the bodies the worker sends to canva-status', () => {
  const sendsOnly = (body: Record<string, unknown>) => expect(Object.keys(body).filter((k) => !contract.fields.includes(k))).toEqual([]);

  it('a draft that passed its check', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const { fetcher, reports } = core([
      { tenantId: 'tenant', clientId: 'client' }, { status: 'submitted', planId: 'plan' },
      { status: 'retrieved', planId: 'plan', designId: 'DA_test' }, { binding: { designId: 'DA_test', version: 1 } },
      { status: 'submitted', operationId: 'export' }, { status: 'retrieved', artifact: { id: 'artifact' } },
      { status: 'submitted', operationId: 'check' }, { status: 'retrieved', artifact: { content_check: { copyPass: true, fontPass: true } } },
    ]);
    await runCanvaDraft(input, new DurableStepJournal(), fetcher);
    expect(reports).toEqual([contract.requests.draftReady]);
    reports.forEach(sendsOnly);
  });

  it('no automatic draft, when intake already told the requester', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const { fetcher, reports } = core([]);
    await runCanvaDraft({ ...input, canvaAutoGenerate: false, requesterToldAtIntake: true }, new DurableStepJournal(), fetcher);
    expect(reports).toEqual([contract.requests.manualDesignToldAtIntake]);
  });

  it('a task that belongs to another client', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const { fetcher, reports } = core([{ tenantId: 'tenant', clientId: 'OTHER' }]);
    await runCanvaDraft(input, new DurableStepJournal(), fetcher);
    expect(reports).toEqual([contract.requests.scopeMismatch]);
    reports.forEach(sendsOnly);
  });

  it('a generation Core refused', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const { fetcher, reports } = core([{ tenantId: 'tenant', clientId: 'client' }, Response.json({ title: 'COPY_UNSUPPORTED' }, { status: 422 })]);
    await runCanvaDraft(input, new DurableStepJournal(), fetcher);
    expect(reports).toEqual([contract.requests.refused]);
    reports.forEach(sendsOnly);
  });

  it('an outcome replayed from the outbox is the recorded report, unchanged', async () => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    vi.stubEnv('HAWA_CORE_INTERNAL_URL', 'http://core.test');
    const { fetcher, reports } = core([]);
    const handler = (new OutboxConsumer({} as never, { coreFetcher: fetcher }) as unknown as { handlers: Map<string, (cmd: unknown, db: unknown) => Promise<void>> }).handlers.get('task.outcome')!;
    await handler({ aggregate_id: input.taskId, payload: { taskId: input.taskId, report: contract.requests.replayedFromOutbox } }, {});
    expect(reports).toEqual([contract.requests.replayedFromOutbox]);
    reports.forEach(sendsOnly);
  });
});

describe('what the worker does with each answer Core gives', () => {
  // A refusal (4xx) is final: the report is not retried and the workflow finishes. Anything else
  // Core could not do (5xx) is thrown, so the step is retried until Core takes the report.
  const FINAL = ['unauthenticated', 'invalidTaskId', 'unknownTask', 'referenceForAnotherRequest', 'recorded'];
  const RETRIED = ['noDatabase', 'enqueueFailed'];

  it('lists every recorded answer as either final or retried', () => {
    expect([...FINAL, ...RETRIED].sort()).toEqual(Object.keys(contract.answers).sort());
  });

  it.each(FINAL)('%s: the workflow finishes after one report', async (name) => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const { fetcher, reports } = core([], answerOf(name));
    const out = await runCanvaDraft({ ...input, canvaAutoGenerate: false }, new DurableStepJournal(), fetcher);
    expect(out.status).toBe('MANUAL_DESIGN_REQUIRED');
    expect(reports).toHaveLength(1);
  });

  it.each(RETRIED)('%s: the report step fails, so it is retried', async (name) => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const { fetcher } = core([], answerOf(name));
    await expect(runCanvaDraft({ ...input, canvaAutoGenerate: false }, new DurableStepJournal(), fetcher)).rejects.toThrow(`HTTP ${contract.answers[name].status}`);
  });

  it.each([...FINAL, ...RETRIED])('%s: the outbox replay treats it the same way', async (name) => {
    vi.stubEnv('HAWA_DESIGN_WORKER_TOKEN', 'test-only');
    const { fetcher } = core([], answerOf(name));
    const handler = (new OutboxConsumer({} as never, { coreFetcher: fetcher }) as unknown as { handlers: Map<string, (cmd: unknown, db: unknown) => Promise<void>> }).handlers.get('task.outcome')!;
    const outcome = await handler({ aggregate_id: input.taskId, payload: { taskId: input.taskId, report: contract.requests.replayedFromOutbox } }, {})
      .then(() => 'taken', (err: Error) => err.message);
    const { status } = contract.answers[name];
    expect(outcome).toMatch(status < 300 ? /^taken$/ : status < 500 ? /^CORE_REFUSED_OUTCOME/ : /^CORE_UNAVAILABLE/);
  });
});
