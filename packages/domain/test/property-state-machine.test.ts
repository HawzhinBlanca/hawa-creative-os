import { describe, it, expect } from 'vitest';
import { TaskStateMachine, LEGAL_TRANSITIONS } from '../src/state-machine.js';
import type { TaskStatus, TaskActor } from '../src/types.js';

const ALL_STATUSES: TaskStatus[] = [
  'RECEIVED',
  'ROUTING',
  'ROUTING_REVIEW',
  'NEEDS_INFORMATION',
  'BRIEFING',
  'BRIEF_REVIEW',
  'PLANNING',
  'ASSET_GENERATION',
  'COMPOSING',
  'QA',
  'REPAIRING',
  'AWAITING_APPROVAL',
  'OPERATOR_REQUIRED',
  'REVISION_REQUESTED',
  'REJECTED',
  'APPROVED',
  'PUBLISHING',
  'COMPLETE',
  'PUBLISH_RECONCILIATION',
];

const testActor: TaskActor = {
  type: 'system',
  id: 'sys-test-runner',
  displayName: 'Automated Test Actor',
};

describe('TaskStateMachine Exhaustive State Graph Verification', () => {
  it('covers all 19 defined statuses in the transition matrix', () => {
    expect(Object.keys(LEGAL_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('enforces terminal status invariants for COMPLETE and REJECTED', () => {
    expect(LEGAL_TRANSITIONS.COMPLETE).toEqual([]);
    expect(LEGAL_TRANSITIONS.REJECTED).toEqual([]);

    for (const terminal of ['COMPLETE', 'REJECTED'] as TaskStatus[]) {
      const sm = new TaskStateMachine('00000000-0000-0000-0000-000000000001', terminal);
      for (const target of ALL_STATUSES) {
        expect(sm.canTransitionTo(target)).toBe(false);
        const res = sm.transition(target, testActor, 'Attempting exit from terminal');
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('ILLEGAL_STATE_TRANSITION');
          expect(res.error.classification).toBe('terminal_policy_failure');
        }
        expect(sm.getStatus()).toBe(terminal);
      }
    }
  });

  it('exhaustively tests all 19x19 (361) status pairs for valid and invalid transitions', () => {
    for (const fromStatus of ALL_STATUSES) {
      const allowedNext = new Set(LEGAL_TRANSITIONS[fromStatus]);

      for (const toStatus of ALL_STATUSES) {
        const sm = new TaskStateMachine('00000000-0000-0000-0000-000000000002', fromStatus);

        if (allowedNext.has(toStatus)) {
          expect(sm.canTransitionTo(toStatus)).toBe(true);
          const res = sm.transition(toStatus, testActor, `Valid transition ${fromStatus} -> ${toStatus}`);
          expect(res.ok).toBe(true);
          if (res.ok) {
            expect(res.value.fromStatus).toBe(fromStatus);
            expect(res.value.toStatus).toBe(toStatus);
            expect(res.value.actor).toEqual(testActor);
            expect(sm.getStatus()).toBe(toStatus);
          }
        } else {
          expect(sm.canTransitionTo(toStatus)).toBe(false);
          const res = sm.transition(toStatus, testActor, `Invalid transition ${fromStatus} -> ${toStatus}`);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            expect(res.error.code).toBe('ILLEGAL_STATE_TRANSITION');
            expect(res.error.classification).toBe('terminal_policy_failure');
          }
          expect(sm.getStatus()).toBe(fromStatus);
        }
      }
    }
  });
});

describe('TaskStateMachine Repair Budget Invariants (Invariant #7)', () => {
  it('allows maximum 2 repair cycles before escalating to operator review', () => {
    const taskId = '00000000-0000-0000-0000-000000000003';
    const sm = new TaskStateMachine(taskId, 'QA', 0);
    expect(sm.getRepairCount()).toBe(0);

    // Cycle 1: QA -> REPAIRING
    const r1 = sm.transition('REPAIRING', testActor, 'First autonomous repair cycle');
    expect(r1.ok).toBe(true);
    expect(sm.getStatus()).toBe('REPAIRING');
    expect(sm.getRepairCount()).toBe(1);

    // REPAIRING -> QA
    const r1Back = sm.transition('QA', testActor, 'Re-running deterministic QA');
    expect(r1Back.ok).toBe(true);
    expect(sm.getStatus()).toBe('QA');

    // Cycle 2: QA -> REPAIRING
    const r2 = sm.transition('REPAIRING', testActor, 'Second autonomous repair cycle');
    expect(r2.ok).toBe(true);
    expect(sm.getStatus()).toBe('REPAIRING');
    expect(sm.getRepairCount()).toBe(2);

    // REPAIRING -> QA
    const r2Back = sm.transition('QA', testActor, 'Re-running deterministic QA after cycle 2');
    expect(r2Back.ok).toBe(true);
    expect(sm.getStatus()).toBe('QA');

    // Cycle 3 Attempt: MUST FAIL with budget exceeded
    const r3 = sm.transition('REPAIRING', testActor, 'Third repair attempt exceeding budget');
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.error.code).toBe('MAX_REPAIR_BUDGET_EXCEEDED');
      expect(r3.error.classification).toBe('human_resolvable_ambiguity');
      expect(r3.error.safeAction).toContain('OPERATOR_REQUIRED');
    }
    // Verify status remained QA (no corrupted transition)
    expect(sm.getStatus()).toBe('QA');
    expect(sm.getRepairCount()).toBe(2);

    // Escalation to OPERATOR_REQUIRED must succeed
    const escalate = sm.transition('OPERATOR_REQUIRED', testActor, 'Escalating exhausted repair loop to human designer');
    expect(escalate.ok).toBe(true);
    expect(sm.getStatus()).toBe('OPERATOR_REQUIRED');
  });
});

describe('TaskStateMachine Randomized Property-Based Path Fuzzing', () => {
  it('preserves invariants across 100 randomized transition traces', () => {
    for (let run = 0; run < 100; run++) {
      const taskId = `00000000-0000-0000-0000-${String(run).padStart(12, '0')}`;
      const sm = new TaskStateMachine(taskId, 'RECEIVED');

      let steps = 0;
      const maxSteps = 40;

      while (steps < maxSteps) {
        steps++;
        const current = sm.getStatus();
        if (current === 'COMPLETE' || current === 'REJECTED') {
          break;
        }

        const validTargets = LEGAL_TRANSITIONS[current];
        expect(validTargets.length).toBeGreaterThan(0);

        // 70% chance to test valid transition, 30% chance to test invalid injection
        const testValid = Math.random() < 0.7;

        if (testValid) {
          const target = validTargets[Math.floor(Math.random() * validTargets.length)];
          // If trying REPAIRING when repairCount is at budget 2, it should fail gracefully
          if (target === 'REPAIRING' && sm.getRepairCount() >= 2) {
            const res = sm.transition(target, testActor, 'Fuzzed over-budget repair');
            expect(res.ok).toBe(false);
            expect(sm.getStatus()).toBe(current);
          } else {
            const res = sm.transition(target, testActor, `Fuzzed valid step ${current} -> ${target}`);
            expect(res.ok).toBe(true);
            expect(sm.getStatus()).toBe(target);
          }
        } else {
          // Pick a target not in validTargets
          const invalidTargets = ALL_STATUSES.filter((s) => !validTargets.includes(s));
          if (invalidTargets.length > 0) {
            const target = invalidTargets[Math.floor(Math.random() * invalidTargets.length)];
            const res = sm.transition(target, testActor, `Fuzzed invalid step ${current} -> ${target}`);
            expect(res.ok).toBe(false);
            expect(sm.getStatus()).toBe(current);
          }
        }
      }
    }
  });
});

describe('TaskStateMachine Failure Classification Matrix', () => {
  it('correctly maps error codes to standard failure taxonomy', () => {
    const sm = new TaskStateMachine('00000000-0000-0000-0000-000000000099', 'COMPOSING');

    const netFail = sm.classifyFailure('NETWORK_SOCKET_CLOSED', 'Connection reset by peer');
    expect(netFail.classification).toBe('retryable_dependency_failure');
    expect(netFail.retryable).toBe(true);

    const ambigFail = sm.classifyFailure('AMBIGUOUS_BRAND_COLOR', 'Multiple conflicting hex codes found in brief');
    expect(ambigFail.classification).toBe('human_resolvable_ambiguity');
    expect(ambigFail.retryable).toBe(false);

    const secFail = sm.classifyFailure('INJECTION_ATTEMPT_DETECTED', 'Malicious instruction in user brief');
    expect(secFail.classification).toBe('terminal_policy_failure');
    expect(secFail.retryable).toBe(false);

    const schemaFail = sm.classifyFailure('SCHEMA_VALIDATION_ERROR', 'Field width must be greater than zero');
    expect(schemaFail.classification).toBe('deterministic_validation_failure');
    expect(schemaFail.retryable).toBe(false);
  });
});
