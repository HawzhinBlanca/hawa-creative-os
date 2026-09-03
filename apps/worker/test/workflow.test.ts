import { describe, it, expect } from 'vitest';
import { TaskWorkflowRunner } from '../src/workflow.js';

describe('Worker: Durable Task Workflow', () => {
  const runner = new TaskWorkflowRunner();

  it('runs complete workflow slice from intake to AWAITING_APPROVAL with live editable document and passing QA', async () => {
    const output = await runner.run({
      taskId: 'task-flow-1',
      tenantId: 'tenant-flow-1',
      clientId: 'client-office-1',
      rawText: 'داشکاندنی بەهارە: ٢٥٬٠٠٠ دینار بۆ ماوەی هەفتەیەک',
      sourcePlatform: 'telegram',
      idempotencyKey: 'idem-flow-1',
    });

    expect(output.taskId).toBe('task-flow-1');
    expect(output.status).toBe('AWAITING_APPROVAL');
    expect(output.documentId).toBeDefined();
    expect(output.briefId).toBeDefined();
    expect(output.qcPassed).toBe(true);
  });
});
