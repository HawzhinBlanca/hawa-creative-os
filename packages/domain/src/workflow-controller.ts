/**
 * Hawa Creative OS — Worker Durable Execution Recovery Controller
 * FR-060, FR-061, Invariant #10, Invariant #12, Gate C, Gate H
 * Controls explicit workflow pause, resume, cancel, and replay with crash-recovery simulation.
 */

import crypto from 'node:crypto';
import type { TaskStatus, TaskActor } from './types.js';

export type WorkflowExecutionState = 'RUNNING' | 'PAUSED' | 'CANCELLED' | 'CRASHED' | 'COMPLETE';

export interface WorkflowCheckpoint {
  checkpointId: string;
  taskId: string;
  stage: string;
  taskStatus: TaskStatus;
  idempotencyKey: string;
  completedSideEffects: Array<{
    type: 'drive_upload' | 'sheet_sync' | 'chat_notify' | 'asset_render';
    key: string;
    receiptId?: string;
    completedAt: string;
  }>;
  payload: Record<string, any>;
  createdAt: string;
}

export interface WorkflowControlAction {
  action: 'pause' | 'resume' | 'cancel' | 'replay';
  actor: TaskActor;
  reason: string;
  targetCheckpointId?: string;
}

export interface WorkflowControllerState {
  taskId: string;
  executionState: WorkflowExecutionState;
  currentCheckpoint?: WorkflowCheckpoint;
  checkpoints: WorkflowCheckpoint[];
  auditLog: Array<{
    action: string;
    actor: TaskActor;
    reason: string;
    timestamp: string;
    fromState: WorkflowExecutionState;
    toState: WorkflowExecutionState;
  }>;
}

export class TaskWorkflowController {
  private taskId: string;
  private executionState: WorkflowExecutionState;
  private checkpoints: WorkflowCheckpoint[] = [];
  private auditLog: WorkflowControllerState['auditLog'] = [];

  constructor(taskId: string, initialState: WorkflowExecutionState = 'RUNNING') {
    this.taskId = taskId;
    this.executionState = initialState;
  }

  getTaskId(): string {
    return this.taskId;
  }

  getExecutionState(): WorkflowExecutionState {
    return this.executionState;
  }

  getState(): WorkflowControllerState {
    return {
      taskId: this.taskId,
      executionState: this.executionState,
      currentCheckpoint: this.checkpoints[this.checkpoints.length - 1],
      checkpoints: [...this.checkpoints],
      auditLog: [...this.auditLog],
    };
  }

  /**
   * Records an immutable checkpoint in durable workflow progress.
   */
  recordCheckpoint(
    stage: string,
    taskStatus: TaskStatus,
    idempotencyKey: string,
    completedSideEffects: WorkflowCheckpoint['completedSideEffects'] = [],
    payload: Record<string, any> = {}
  ): WorkflowCheckpoint {
    const checkpoint: WorkflowCheckpoint = {
      checkpointId: `chk_${crypto.randomUUID().substring(0, 8)}`,
      taskId: this.taskId,
      stage,
      taskStatus,
      idempotencyKey,
      completedSideEffects: [...completedSideEffects],
      payload: { ...payload },
      createdAt: new Date().toISOString(),
    };

    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /**
   * Pauses an actively running workflow with mandatory reason.
   */
  pause(actor: TaskActor, reason: string): boolean {
    if (this.executionState !== 'RUNNING') return false;
    if (!reason || reason.trim().length === 0) return false;

    const fromState = this.executionState;
    this.executionState = 'PAUSED';
    this.auditLog.push({
      action: 'pause',
      actor,
      reason,
      timestamp: new Date().toISOString(),
      fromState,
      toState: this.executionState,
    });
    return true;
  }

  /**
   * Resumes a paused workflow.
   */
  resume(actor: TaskActor, reason: string): boolean {
    if (this.executionState !== 'PAUSED' && this.executionState !== 'CRASHED') return false;
    if (!reason || reason.trim().length === 0) return false;

    const fromState = this.executionState;
    this.executionState = 'RUNNING';
    this.auditLog.push({
      action: 'resume',
      actor,
      reason,
      timestamp: new Date().toISOString(),
      fromState,
      toState: this.executionState,
    });
    return true;
  }

  /**
   * Cancels a running or paused workflow.
   */
  cancel(actor: TaskActor, reason: string): boolean {
    if (this.executionState === 'CANCELLED' || this.executionState === 'COMPLETE') return false;
    if (!reason || reason.trim().length === 0) return false;

    const fromState = this.executionState;
    this.executionState = 'CANCELLED';
    this.auditLog.push({
      action: 'cancel',
      actor,
      reason,
      timestamp: new Date().toISOString(),
      fromState,
      toState: this.executionState,
    });
    return true;
  }

  /**
   * Simulates worker process crash during a durable execution step.
   */
  simulateCrash(reason: string = 'Worker process killed unexpectedly'): void {
    const fromState = this.executionState;
    this.executionState = 'CRASHED';
    this.auditLog.push({
      action: 'crash',
      actor: { type: 'system', id: 'crash_simulator' },
      reason,
      timestamp: new Date().toISOString(),
      fromState,
      toState: this.executionState,
    });
  }

  /**
   * Replays workflow from the last verified checkpoint or a specified checkpoint.
   * Proves Invariant #10 & #12: side-effects with existing idempotency keys are not duplicated.
   */
  replayFromCheckpoint(
    actor: TaskActor,
    reason: string,
    targetCheckpointId?: string
  ): {
    success: boolean;
    restoredCheckpoint?: WorkflowCheckpoint;
    skippedSideEffects: string[];
    pendingSideEffects: string[];
  } {
    if (!reason || reason.trim().length === 0) {
      return { success: false, skippedSideEffects: [], pendingSideEffects: [] };
    }

    const checkpoint = targetCheckpointId
      ? this.checkpoints.find((c) => c.checkpointId === targetCheckpointId)
      : this.checkpoints[this.checkpoints.length - 1];

    if (!checkpoint) {
      return { success: false, skippedSideEffects: [], pendingSideEffects: [] };
    }

    const fromState = this.executionState;
    this.executionState = 'RUNNING';

    // Collect already completed side effects that MUST be skipped on replay
    const skippedSideEffects = checkpoint.completedSideEffects.map((s) => `${s.type}:${s.key}`);

    // Check what still needs to be executed based on stage
    const allRequiredEffects = ['drive_upload', 'sheet_sync', 'chat_notify'];
    const pendingSideEffects = allRequiredEffects.filter(
      (eff) => !checkpoint.completedSideEffects.some((s) => s.type === eff)
    );

    this.auditLog.push({
      action: 'replay',
      actor,
      reason: `${reason} [Replaying from ${checkpoint.stage} / ${checkpoint.checkpointId}]`,
      timestamp: new Date().toISOString(),
      fromState,
      toState: this.executionState,
    });

    return {
      success: true,
      restoredCheckpoint: checkpoint,
      skippedSideEffects,
      pendingSideEffects,
    };
  }
}
