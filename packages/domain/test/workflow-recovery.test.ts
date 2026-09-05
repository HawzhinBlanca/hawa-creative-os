import { describe, it, expect } from 'vitest';
import {
  TaskWorkflowController,
  type WorkflowCheckpoint,
} from '../src/workflow-controller.js';

describe('Worker Durable Execution Recovery Controller (FR-060, FR-061, Invariant #10, Gate C, Gate H)', () => {
  it('manages workflow pause, resume, and cancel with mandatory audit logging', () => {
    const controller = new TaskWorkflowController('task-wf-101');
    expect(controller.getExecutionState()).toBe('RUNNING');

    // Reject pause with empty reason
    const invalidPause = controller.pause({ type: 'user', id: 'operator_1' }, '');
    expect(invalidPause).toBe(false);
    expect(controller.getExecutionState()).toBe('RUNNING');

    // Valid pause with reason
    const paused = controller.pause(
      { type: 'user', id: 'operator_1' },
      'Awaiting client phone confirmation for Drustee campaign'
    );
    expect(paused).toBe(true);
    expect(controller.getExecutionState()).toBe('PAUSED');

    // Resume workflow
    const resumed = controller.resume(
      { type: 'user', id: 'operator_1' },
      'Phone confirmation received, proceeding with render'
    );
    expect(resumed).toBe(true);
    expect(controller.getExecutionState()).toBe('RUNNING');

    // Cancel workflow
    const cancelled = controller.cancel(
      { type: 'user', id: 'operator_1' },
      'Client requested campaign cancellation'
    );
    expect(cancelled).toBe(true);
    expect(controller.getExecutionState()).toBe('CANCELLED');

    const state = controller.getState();
    expect(state.auditLog.length).toBe(3);
    expect(state.auditLog[0].action).toBe('pause');
    expect(state.auditLog[1].action).toBe('resume');
    expect(state.auditLog[2].action).toBe('cancel');
  });

  it('proves Invariants #10 & #12: simulates crash during publication and recovers without duplicate side effects', () => {
    const controller = new TaskWorkflowController('task-crash-test');

    // 1. Checkpoint before publication starts
    controller.recordCheckpoint(
      'publishing_prep',
      'APPROVED',
      'idem_pub_task_crash_test_1',
      [],
      { totalFiles: 12 }
    );

    // 2. Drive upload succeeds, checkpoint recorded
    controller.recordCheckpoint(
      'drive_upload_complete',
      'PUBLISHING',
      'idem_pub_task_crash_test_2',
      [
        {
          type: 'drive_upload',
          key: 'drive_folder_101',
          receiptId: 'receipt_drv_987',
          completedAt: new Date().toISOString(),
        },
      ],
      { uploadedCount: 12 }
    );

    // 3. Worker process crashes unexpectedly before Google Sheet sync finishes
    controller.simulateCrash('Worker SIGKILL / out of memory during sheet append');
    expect(controller.getExecutionState()).toBe('CRASHED');

    // 4. Recovery drill: replay from last checkpoint
    const replayResult = controller.replayFromCheckpoint(
      { type: 'workflow', id: 'restate_recovery_runner' },
      'Automated durable replay after crash'
    );

    expect(replayResult.success).toBe(true);
    expect(controller.getExecutionState()).toBe('RUNNING');

    // Must identify drive_upload as already done -> MUST SKIP to prevent duplicate Drive files
    expect(replayResult.skippedSideEffects).toContain('drive_upload:drive_folder_101');

    // Must identify sheet_sync and chat_notify as pending execution
    expect(replayResult.pendingSideEffects).toContain('sheet_sync');
    expect(replayResult.pendingSideEffects).toContain('chat_notify');
  });
});
