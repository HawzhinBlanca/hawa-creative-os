import { describe, it, expect, vi } from 'vitest';
import { TaskWorkflowRunner, WorkflowNotRunnableError } from '../src/workflow.js';

/**
 * Until 2026-09-22 this file ran a retired nine-step generator against a simulated studio and
 * called the result "the durable task workflow": a program production had not run since the
 * Canva cutover of 2026-09-13. The runner now has one path, and a dispatch that is not a Canva
 * job is refused before anything is spent.
 */
describe('TaskWorkflowRunner has one path', () => {
  const input = {
    taskId: '00000000-0000-4000-8000-000000000001',
    tenantId: '00000000-0000-4000-a000-000000000001',
    rawText: 'داشکاندنی بەهارە',
    sourcePlatform: 'telegram',
    idempotencyKey: 'idem-flow-1',
  };

  it('refuses a dispatch without a Canva job, permanently, spending nothing', async () => {
    const runner = new TaskWorkflowRunner();
    const err = await runner.run({ ...input, canvaAutoGenerate: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowNotRunnableError);
    expect((err as WorkflowNotRunnableError).category).toBe('permanent');
    // The outbox consumer dead-letters on this marker instead of retrying.
    expect((err as Error).message).toMatch(/^PERMANENT_REJECTION:/);
    expect((err as Error).message).toMatch(/nothing was spent/);
  });

  it('reports the refusal to Core before throwing it, so the task leaves RECEIVED', async () => {
    const { DurableStepJournal } = await import('../src/durable-context.js');
    const previous = process.env.HAWA_DESIGN_WORKER_TOKEN;
    process.env.HAWA_DESIGN_WORKER_TOKEN = 'test-only';
    try {
      const fetcher = vi.fn(async () => Response.json({ ok: true }));
      const runner = new TaskWorkflowRunner({ fetcher: fetcher as any });

      // Not told at intake: Core is asked to explain it to the requester.
      const err = await runner
        .run({ ...input, clientId: '00000000-0000-4000-8000-0000000000c1', canvaAutoGenerate: false, requesterToldAtIntake: false }, new DurableStepJournal())
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkflowNotRunnableError);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String((fetcher.mock.calls[0] as any)[0])).toContain(`/v1/tasks/${input.taskId}/notifications/canva-status`);
      expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body)).toMatchObject({ status: 'MANUAL_DESIGN_REQUIRED', notifyRequester: true });

      // Told at intake (daily cap, no client, instruction only): recorded, but no second message.
      await runner.run({ ...input, canvaAutoGenerate: false, requesterToldAtIntake: true }, new DurableStepJournal()).catch(() => undefined);
      expect(JSON.parse((fetcher.mock.calls[1] as any)[1].body)).toMatchObject({ status: 'CLIENT_REQUIRED', notifyRequester: false });
    } finally {
      if (previous === undefined) delete process.env.HAWA_DESIGN_WORKER_TOKEN;
      else process.env.HAWA_DESIGN_WORKER_TOKEN = previous;
    }
  });

  it('never lets a failed report hide the refusal itself', async () => {
    const { DurableStepJournal } = await import('../src/durable-context.js');
    const fetcher = vi.fn(async () => { throw new Error('core down'); });
    const err = await new TaskWorkflowRunner({ fetcher: fetcher as any })
      .run({ ...input, canvaAutoGenerate: false }, new DurableStepJournal())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowNotRunnableError);
  });

  it('a Canva job without a durable context is refused too: no journal, no paid steps', async () => {
    await expect(new TaskWorkflowRunner().run({ ...input, canvaAutoGenerate: true })).rejects.toThrow(/durable Restate context/);
  });
});

describe('a refusal is final for Restate', () => {
  it('turns WorkflowNotRunnableError into a TerminalError and leaves other errors alone', async () => {
    const { asTerminalIfNotRunnable, WorkflowNotRunnableError } = await import('../src/workflow.js');
    const restate = await import('@restatedev/restate-sdk');
    const refusal = new WorkflowNotRunnableError('00000000-0000-4000-8000-000000000001', 'not a job');
    const converted = asTerminalIfNotRunnable(refusal);
    expect(converted).toBeInstanceOf(restate.TerminalError);
    expect((converted as any).message).toMatch(/PERMANENT_REJECTION: not a job/);
    expect((converted as any).cause).toBe(refusal);
    const other = new Error('network');
    expect(asTerminalIfNotRunnable(other)).toBe(other);
  });
});
