import { describe, expect, it } from 'vitest';
import { newStudioBudget, studioBudgetUsage, assertStudioBudgetAdmission } from '../src/studio-budget.js';

describe('Studio budget policy', () => {
  it.each([NaN, Infinity, Number.MAX_SAFE_INTEGER, -1, 0, null, '', '2usd'])('refuses invalid USD limits: %s', value => {
    expect(() => newStudioBudget(value)).toThrow();
  });
  it.each([NaN, Infinity, -1, 0, 1.5, null, '', '24calls', Number.MAX_SAFE_INTEGER + 1])('refuses invalid call limits: %s', value => {
    expect(() => newStudioBudget(2, value)).toThrow();
  });
  it('defaults only absent values and accepts exact numeric environment settings', () => {
    expect(newStudioBudget()).toEqual({ maxUsd: 2, maxCalls: 24, spentUsd: 0, calls: 0 });
    expect(newStudioBudget('3.5', '30')).toMatchObject({ maxUsd: 3.5, maxCalls: 30 });
  });
  it('keeps original unknown costs separate and counts settlement once, even after a late receipt', () => {
    const b = newStudioBudget(2, 3);
    expect(studioBudgetUsage(b, [{ status: 'uncertain', estimatedUsd: 0, settledUsd: null }]))
      .toMatchObject({ admittedCalls: 1, knownUsdEstimate: 0, unresolvedCalls: 1 });
    expect(studioBudgetUsage(b, [{ status: 'uncertain', estimatedUsd: 0, settledUsd: 0.5 }]))
      .toMatchObject({ knownUsdEstimate: 0, attestedAdditionalUsd: 0.5, accountedUsd: 0.5, unresolvedCalls: 0 });
    for (const estimate of [0.25, 0.5, 0.75]) {
      expect(studioBudgetUsage(b, [{ status: 'ok', estimatedUsd: estimate, settledUsd: 0.5 }]).accountedUsd)
        .toBe(Math.max(0.5, estimate));
    }
  });
  it('counts failed and non-accepted attempts towards the call cap', () => {
    const usage = studioBudgetUsage(newStudioBudget(2, 2), [
      { status: 'error', estimatedUsd: 0, settledUsd: null },
      { status: 'uncertain', estimatedUsd: 0, settledUsd: 0 },
    ]);
    expect(usage).toMatchObject({ admittedCalls: 2, accountedUsd: 0, blocker: 'BUDGET_EXHAUSTED' });
    expect(() => assertStudioBudgetAdmission(usage)).toThrow();
  });
  it('retains a recorded partial charge even when the final outcome is uncertain or settled lower', () => {
    for (const settledUsd of [null, 0, 0.5]) {
      const usage = studioBudgetUsage(newStudioBudget(0.75), [{ status: 'uncertain', estimatedUsd: 0.75, settledUsd }]);
      expect(usage).toMatchObject({ knownUsdEstimate: 0.75, accountedUsd: 0.75, blocker: 'BUDGET_EXHAUSTED' });
    }
  });
  it('does not turn malformed persisted settings or estimates into permission to spend', () => {
    for (const snapshot of [null, '{', {}, { ...newStudioBudget(), maxUsd: null }]) {
      expect(studioBudgetUsage(snapshot, []).blocker).toBe('STUDIO_BUDGET_INVALID');
    }
    for (const estimatedUsd of [NaN, Infinity, -0.1]) {
      expect(studioBudgetUsage(newStudioBudget(), [{ status: 'ok', estimatedUsd, settledUsd: null }]).blocker)
        .toBe('STUDIO_BUDGET_INVALID');
    }
  });
  it('accepts reordered floating-point sums without allowing genuinely missing spend', () => {
    const calls = [0.1, 0.2].map(estimatedUsd => ({ status: 'ok' as const, estimatedUsd, settledUsd: null }));
    expect(studioBudgetUsage({ ...newStudioBudget(), spentUsd: 0.1 + 0.2, calls: 2 }, calls).blocker).toBeNull();
    expect(studioBudgetUsage({ ...newStudioBudget(), spentUsd: 0.300001, calls: 2 }, calls).blocker)
      .toBe('STUDIO_BUDGET_HISTORY_INCOMPLETE');
  });
  it('releases unused funds only with usage, definite rejection or exact settlement', () => {
    const call = { status: 'ok' as const, estimatedUsd: 0.1, settledUsd: null, reservedUsd: 0.5 };
    for (const costBasis of ['estimate', 'unavailable', null] as const) {
      expect(studioBudgetUsage(newStudioBudget(1), [{ ...call, costBasis }]))
        .toMatchObject({ reservedAdditionalUsd: 0.4, committedUsd: 0.5, remainingUsd: 0.5 });
    }
    expect(studioBudgetUsage(newStudioBudget(1), [{ ...call, costBasis: 'usage' }]))
      .toMatchObject({ reservedAdditionalUsd: 0, committedUsd: 0.1, remainingUsd: 0.9 });
    expect(studioBudgetUsage(newStudioBudget(1), [{ ...call, status: 'error', estimatedUsd: 0, costBasis: 'not_accepted' }]))
      .toMatchObject({ committedUsd: 0, remainingUsd: 1 });
    expect(studioBudgetUsage(newStudioBudget(1), [{ ...call, status: 'uncertain', settledUsd: 0.2 }]))
      .toMatchObject({ accountedUsd: 0.2, committedUsd: 0.2, reservedAdditionalUsd: 0 });
  });
  it('does not let a partial usage observation release an uncertain request', () => {
    expect(studioBudgetUsage(newStudioBudget(1), [{ status: 'uncertain', estimatedUsd: 0.1,
      costBasis: 'usage', reservedUsd: 0.5, settledUsd: null }]))
      .toMatchObject({ reservedAdditionalUsd: 0.4, committedUsd: 0.5 });
  });
  it('retains an overrun and refuses further requests even if the run has spare money', () => {
    const usage = studioBudgetUsage(newStudioBudget(10), [{ status: 'ok', estimatedUsd: 0.6,
      reservedUsd: 0.5, costBasis: 'usage', settledUsd: null }]);
    expect(usage).toMatchObject({ accountedUsd: 0.6, blocker: 'STUDIO_BUDGET_RESERVATION_EXCEEDED' });
    expect(() => assertStudioBudgetAdmission(usage, 0.1)).toThrow(/exceeded/);
  });
  it('does not grant a micro-dollar beyond remaining funds', () => {
    const usage = studioBudgetUsage(newStudioBudget(0.3), [{ status: 'ok', estimatedUsd: 0.1,
      reservedUsd: 0.2, costBasis: 'usage', settledUsd: null }]);
    expect(() => assertStudioBudgetAdmission(usage, 0.2)).not.toThrow();
    expect(() => assertStudioBudgetAdmission(usage, 0.200001)).toThrow();
  });
});
