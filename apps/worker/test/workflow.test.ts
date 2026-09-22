import { describe, it, expect } from 'vitest';
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

  it('a Canva job without a durable context is refused too: no journal, no paid steps', async () => {
    await expect(new TaskWorkflowRunner().run({ ...input, canvaAutoGenerate: true })).rejects.toThrow(/durable Restate context/);
  });
});
