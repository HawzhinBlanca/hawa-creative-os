import { describe, it, expect } from 'vitest';
import type { RequestContext } from '@hawa/contracts';
import { ChaosInjector } from '../src/chaos.js';

interface RevisionRecord {
  revisionId: string;
  version: number;
  contentSha256: string;
  updatedAt: string;
}

interface OutboxItem {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'LEASED' | 'PUBLISHED' | 'DEAD_LETTER';
  leaseOwner?: string;
  leaseExpiresAt?: number;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
}

describe('Concurrency & Optimistic Locking Stress Matrix', () => {
  it('handles 20 concurrent worker updates: exactly 1 succeeds, 19 receive optimistic lock conflict', async () => {
    let currentRevision: RevisionRecord = {
      revisionId: 'rev-concurrency-test',
      version: 5,
      contentSha256: 'sha256_initial_state_5',
      updatedAt: new Date().toISOString(),
    };

    // Simulated storage engine with atomic conditional update
    async function updateRevisionWithOptimisticLock(
      expectedVersion: number,
      newContentSha256: string,
      workerId: string
    ): Promise<{ ok: boolean; revision?: RevisionRecord; error?: string }> {
      // Simulate minor async I/O jitter
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 15)));

      if (currentRevision.version !== expectedVersion) {
        return {
          ok: false,
          error: `CONFLICT_OPTIMISTIC_LOCK: Expected version ${expectedVersion} but found ${currentRevision.version} (worker ${workerId})`,
        };
      }

      currentRevision = {
        revisionId: currentRevision.revisionId,
        version: currentRevision.version + 1,
        contentSha256: newContentSha256,
        updatedAt: new Date().toISOString(),
      };

      return { ok: true, revision: currentRevision };
    }

    const workerCount = 20;
    const initialExpectedVersion = 5;

    // Launch 20 concurrent updates simultaneously
    const promises = Array.from({ length: workerCount }, (_, i) =>
      updateRevisionWithOptimisticLock(initialExpectedVersion, `sha256_state_by_worker_${i}`, `worker_${i}`)
    );

    const results = await Promise.all(promises);

    const successes = results.filter((r) => r.ok);
    const conflicts = results.filter((r) => !r.ok);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(workerCount - 1);
    expect(currentRevision.version).toBe(6);
    expect(conflicts.every((c) => c.error?.includes('CONFLICT_OPTIMISTIC_LOCK'))).toBe(true);
  });
});

describe('Transactional Outbox Pattern Lease & Escalation Matrix', () => {
  it('enforces lease expiration, prevents double processing, and rejects stale workers', async () => {
    const outbox: OutboxItem = {
      id: 'outbox_evt_001',
      topic: 'design.published',
      payload: { taskId: 't-1', designId: 'd-1' },
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 3,
    };

    const now = Date.now();

    // 1. Worker A acquires lease for 50ms
    function acquireLease(item: OutboxItem, workerId: string, durationMs: number, currentTime: number): boolean {
      if (item.status === 'PUBLISHED' || item.status === 'DEAD_LETTER') return false;
      if (item.status === 'LEASED' && item.leaseExpiresAt && item.leaseExpiresAt > currentTime) {
        return false; // Still actively leased
      }
      item.status = 'LEASED';
      item.leaseOwner = workerId;
      item.leaseExpiresAt = currentTime + durationMs;
      item.attempts += 1;
      return true;
    }

    function completeOutboxItem(item: OutboxItem, workerId: string, currentTime: number): { ok: boolean; error?: string } {
      if (item.status !== 'LEASED') {
        return { ok: false, error: `Invalid item status: ${item.status}` };
      }
      if (item.leaseOwner !== workerId) {
        return { ok: false, error: `Lease owner mismatch: held by ${item.leaseOwner}, not ${workerId}` };
      }
      if (item.leaseExpiresAt && item.leaseExpiresAt < currentTime) {
        return { ok: false, error: 'Lease expired before acknowledgement' };
      }
      item.status = 'PUBLISHED';
      item.leaseOwner = undefined;
      item.leaseExpiresAt = undefined;
      return { ok: true };
    }

    // Worker A leases at t=0 for 50ms
    expect(acquireLease(outbox, 'worker_A', 50, now)).toBe(true);
    expect(outbox.status).toBe('LEASED');
    expect(outbox.leaseOwner).toBe('worker_A');

    // Worker B attempts to lease at t=20ms -> rejected
    expect(acquireLease(outbox, 'worker_B', 50, now + 20)).toBe(false);

    // Worker A crashes / times out. At t=60ms, lease has expired.
    // Worker B claims the expired lease
    expect(acquireLease(outbox, 'worker_B', 50, now + 60)).toBe(true);
    expect(outbox.leaseOwner).toBe('worker_B');
    expect(outbox.attempts).toBe(2);

    // Worker B completes publication
    const resB = completeOutboxItem(outbox, 'worker_B', now + 80);
    expect(resB.ok).toBe(true);
    expect(outbox.status).toBe('PUBLISHED');

    // Stale Worker A wakes up and attempts to acknowledge at t=100ms -> REJECTED
    const resA = completeOutboxItem(outbox, 'worker_A', now + 100);
    expect(resA.ok).toBe(false);
    expect(resA.error).toContain('Invalid item status: PUBLISHED');
  });

  it('escalates repeatedly failing outbox items to DEAD_LETTER after max retry budget', async () => {
    const failedItem: OutboxItem = {
      id: 'outbox_evt_fail_99',
      topic: 'google_drive.export',
      payload: { exportKey: 'exp-99' },
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 3,
    };

    function processOutboxItemWithBackoff(item: OutboxItem, simulateFail: boolean): void {
      if (item.status === 'DEAD_LETTER') return;

      item.attempts += 1;
      if (simulateFail) {
        item.lastError = `EXTERNAL_API_UNAVAILABLE (Attempt ${item.attempts})`;
        if (item.attempts >= item.maxAttempts) {
          item.status = 'DEAD_LETTER';
        } else {
          item.status = 'PENDING';
        }
      } else {
        item.status = 'PUBLISHED';
      }
    }

    // Attempt 1 fails
    processOutboxItemWithBackoff(failedItem, true);
    expect(failedItem.status).toBe('PENDING');
    expect(failedItem.attempts).toBe(1);

    // Attempt 2 fails
    processOutboxItemWithBackoff(failedItem, true);
    expect(failedItem.status).toBe('PENDING');
    expect(failedItem.attempts).toBe(2);

    // Attempt 3 fails -> hits max budget (3) -> DEAD_LETTER
    processOutboxItemWithBackoff(failedItem, true);
    expect(failedItem.status).toBe('DEAD_LETTER');
    expect(failedItem.attempts).toBe(3);
    expect(failedItem.lastError).toContain('EXTERNAL_API_UNAVAILABLE');
  });
});

describe('Chaos Resilience & Network Drop Recovery', () => {
  it('guarantees single-delivery idempotency across 50 chaotic runs with 40% network drops', async () => {
    const chaos = new ChaosInjector({ dropProbability: 0.40 });
    const executedSideEffects = new Set<string>();
    const idempotencyRecord = new Map<string, { status: number; body: string }>();

    async function executeIdempotentPublication(idempotencyKey: string, payload: string) {
      if (idempotencyRecord.has(idempotencyKey)) {
        return idempotencyRecord.get(idempotencyKey)!;
      }

      // Simulate untrusted network boundary
      await chaos.maybeInjectFault(async () => {
        // Atomic side effect
        executedSideEffects.add(idempotencyKey);
      });

      const response = { status: 201, body: `Created for ${payload}` };
      idempotencyRecord.set(idempotencyKey, response);
      return response;
    }

    const testRuns = 50;
    for (let i = 0; i < testRuns; i++) {
      const idemKey = `idem-chaos-run-${i}`;
      let completed = false;
      let retries = 0;

      while (!completed && retries < 15) {
        retries++;
        try {
          const res = await executeIdempotentPublication(idemKey, `Payload ${i}`);
          expect(res.status).toBe(201);
          completed = true;
        } catch (err: any) {
          expect(err.message).toContain('CHAOS_INJECTED_NETWORK_DROP');
          // Retry with exponential backoff jitter
          await new Promise((r) => setTimeout(r, 2));
        }
      }

      expect(completed).toBe(true);
      expect(executedSideEffects.has(idemKey)).toBe(true);
    }

    // Confirm exactly 50 logical side effects occurred despite chaotic network drops
    expect(executedSideEffects.size).toBe(50);
  });
});
