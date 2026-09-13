import { describe, it, expect, beforeEach } from 'vitest';
import { CostGovernor } from '../src/cost-governor.js';

describe('Bug 56 Proof: Cost Governor Quota Bypass, Unrecorded Spend & Concurrency Leaks', () => {
  let governor: CostGovernor;

  beforeEach(() => {
    governor = new CostGovernor();
  });

  it('PROVES BUG: Unrecorded spend when operation exceeds budget cap (spentUsd frozen)', () => {
    // Client-rona has $5.00 cap and $0.00 spent
    const budgetBefore = governor.getOrCreateClientBudget('client-rona');
    expect(budgetBefore.capUsd).toBe(5.0);
    expect(budgetBefore.spentUsd).toBe(0.0);

    // An expensive generation runs costing $10.00 (e.g. video / deep reasoning)
    const receipt = governor.recordUsage({
      clientId: 'client-rona',
      taskId: 'task-expensive-run',
      role: 'multimodal_director',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      inputTokens: 2_000_000,
      outputTokens: 500_000,
      costUsd: 10.00,
    });

    // In the buggy code: receipt is QUOTA_REJECTED, BUT spentUsd is NEVER incremented!
    // The client consumed $10.00 of provider spend, but spentUsd is frozen at 0.0!
    const budgetAfter = governor.getOrCreateClientBudget('client-rona');
    
    // We assert that spentUsd MUST record the real spend ($10.00) and status MUST be EXCEEDED
    expect(budgetAfter.spentUsd).toBe(10.0);
    expect(budgetAfter.status).toBe('EXCEEDED');

    // And subsequent operations MUST be blocked
    const subsequentCheck = governor.checkBudget('client-rona', 0.01);
    expect(subsequentCheck.allowed).toBe(false);
  });

  it('PROVES BUG: Negative token / cost injection allows balance inflation', () => {
    // Record legitimate $4.00 spend
    governor.recordUsage({
      clientId: 'client-aster',
      taskId: 'task-1',
      role: 'writer',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 1000,
      costUsd: 4.0,
    });
    expect(governor.getOrCreateClientBudget('client-aster').spentUsd).toBe(4.0);

    // Attacker passes negative cost or tokens to artificially reduce spentUsd
    governor.recordUsage({
      clientId: 'client-aster',
      taskId: 'task-exploit',
      role: 'attacker',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: -1_000_000,
      outputTokens: -1_000_000,
      costUsd: -4.0,
    });

    // In the buggy code or unguarded math, spentUsd could be reduced to 0!
    // We assert spentUsd cannot decrease through malicious negative input
    expect(governor.getOrCreateClientBudget('client-aster').spentUsd).toBeGreaterThanOrEqual(4.0);
  });

  it('PROVES BUG: NaN cap allocation causes checkBudget to always allow (NaN comparison bypass)', () => {
    // Allocate NaN cap (e.g. from malformed client input)
    governor.allocateBudget('client-nova', NaN);

    const budget = governor.getOrCreateClientBudget('client-nova');
    expect(Number.isFinite(budget.capUsd)).toBe(true);
    expect(budget.capUsd).toBeGreaterThan(0);

    // If cap was NaN, (spent + cost > NaN) is false, which allowed checkBudget to approve anything
    governor.recordUsage({
      clientId: 'client-nova',
      taskId: 'task-1',
      role: 'writer',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 1000,
      costUsd: 1000.0,
    });

    const check = governor.checkBudget('client-nova', 50.0);
    expect(check.allowed).toBe(false);
  });

  it('PROVES BUG & FIX: Concurrent reservation prevents parallel overspend exceeding cap', () => {
    // Client-drustee has $10.00 cap
    expect(typeof (governor as any).reserveBudget).toBe('function');

    // Worker 1 reserves $6.00
    const res1 = (governor as any).reserveBudget({
      clientId: 'client-drustee',
      amountUsd: 6.0,
      leaseDurationMs: 5000,
    });
    expect(res1.allowed).toBe(true);
    expect(res1.reservationId).toBeDefined();

    // Worker 2 attempts to reserve $6.00 concurrently -> MUST be rejected because 6 + 6 > 10
    const res2 = (governor as any).reserveBudget({
      clientId: 'client-drustee',
      amountUsd: 6.0,
      leaseDurationMs: 5000,
    });
    expect(res2.allowed).toBe(false);

    // Worker 1 commits its execution with reservationId
    governor.recordUsage({
      clientId: 'client-drustee',
      taskId: 'task-w1',
      role: 'planner',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 5.5,
      ...({ reservationId: res1.reservationId } as any),
    });

    const budget = governor.getOrCreateClientBudget('client-drustee');
    expect(budget.spentUsd).toBe(5.5);

    // Now Worker 2 can reserve $4.0 (5.5 + 4.0 = 9.5 <= 10.0)
    const res3 = (governor as any).reserveBudget({
      clientId: 'client-drustee',
      amountUsd: 4.0,
    });
    expect(res3.allowed).toBe(true);

    // Worker 2 releases reservation without spending
    (governor as any).releaseReservation(res3.reservationId);

    // Now available budget is 10.0 - 5.5 = 4.5
    const check = governor.checkBudget('client-drustee', 4.0);
    expect(check.allowed).toBe(true);
  });
});
