import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  STABLE_SYSTEM_PROMPT_PREFIX,
  validateStablePrefix,
  calculateCallCost,
  PipelineCostGovernorV3,
  PER_BRIEF_CAP_USD,
  OFFICE_DAILY_CAP_USD,
  getDailyOfficeSpend,
  resetDailyOfficeSpend,
} from '../src/studio/cost-architecture-v3.js';

describe('P09 — Cost Architecture & Token Discipline', () => {
  beforeEach(() => {
    // These tests record simulated spend and reset the ledger. Against the real ledger they
    // filled it with spend that never happened and could delete what did, so refuse outright
    // unless the ledger is a throwaway one (vitest.config.ts provides it).
    const dir = process.env.HAWA_SPEND_STATE_DIR;
    expect(dir && path.resolve(dir).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    resetDailyOfficeSpend();
    expect(getDailyOfficeSpend()).toBe(0);
  });

  it('enforces a byte-stable cached prefix of at least 1,024 tokens without dynamic leaks', () => {
    const check = validateStablePrefix(STABLE_SYSTEM_PROMPT_PREFIX);

    expect(check.meetsTokenThreshold).toBe(true);
    expect(check.estimatedTokens).toBeGreaterThanOrEqual(1024);
    expect(check.containsDynamicPatterns).toBe(false);
  });

  it('calculates cached token discount accurately from F11 pricing table', () => {
    // 2847 input tokens with 2844 cached tokens, 1000 output tokens
    const cost = calculateCallCost('gpt-6-astra', {
      inputTokens: 2847,
      cachedTokens: 2844,
      outputTokens: 1000,
    });

    // Gross without cache: 2847/1M * 10 = $0.02847 + 1000/1M * 50 = $0.050 -> $0.07847
    // Net with cache: 3/1M * 10 + 2844/1M * 1 + 1000/1M * 50 = $0.00003 + $0.002844 + $0.050 -> $0.052874
    expect(cost.grossCostUsd).toBeGreaterThan(cost.netCostUsd);
    expect(cost.cacheDiscountUsd).toBeGreaterThan(0.02);
    expect(cost.netCostUsd).toBeLessThan(cost.grossCostUsd);
  });

  it('cheap-path run with no art and single survivor costs strictly under USD 0.25', () => {
    const gov = new PipelineCostGovernorV3('brief_cheap_path_01');

    // Call 1: P03 Layout Generation (single call generating 3 candidates)
    // 2,847 tokens in, 2,844 cached, 3,122 out
    const call1 = gov.recordCall('P03_LAYOUT', 'gpt-6-astra', {
      inputTokens: 2847,
      cachedTokens: 2844,
      outputTokens: 3122,
    });

    // Call 2: Single candidate survives P01 -> 0 judge calls ($0.00)
    // No art generation requested -> $0.00
    const state = gov.getState();

    expect(state.ledger).toHaveLength(1);
    expect(state.accumulatedCostUsd).toBeLessThan(0.25);
    expect(call1.isWithinCap).toBe(true);
  });

  it('per-brief cap test degrades truthfully when cumulative cost reaches USD 1.00', () => {
    const gov = new PipelineCostGovernorV3('brief_cap_stress_01');

    // Simulate high token consumption rounds
    gov.recordCall('P03_LAYOUT', 'gpt-6-astra', {
      inputTokens: 2847,
      cachedTokens: 2844,
      outputTokens: 4000, // ~$0.20
    });

    gov.recordCall('P05_CRITIQUE', 'gpt-6-astra', {
      inputTokens: 2500,
      cachedTokens: 2400,
      outputTokens: 3000, // ~$0.15
    });

    gov.recordCall('P06_REFINE', 'gpt-6-astra', {
      inputTokens: 2800,
      cachedTokens: 2500,
      outputTokens: 4000, // ~$0.20
    });

    gov.recordCall('P07_JUDGE', 'gpt-6-astra', {
      inputTokens: 3000,
      cachedTokens: 2600,
      outputTokens: 5000, // ~$0.25
    });

    // Push past $1.00 cap
    const breachingCall = gov.recordCall('P07_JUDGE', 'gpt-6-astra', {
      inputTokens: 4000,
      cachedTokens: 0,
      outputTokens: 6000, // ~$0.34 -> pushes total over $1.00
    });

    const state = gov.getState();

    expect(state.accumulatedCostUsd).toBeGreaterThan(PER_BRIEF_CAP_USD);
    expect(state.isCapExceeded).toBe(true);
    expect(breachingCall.degraded).toBe(true);
    expect(state.degradationReason).toContain('CAP_EXCEEDED');
    expect(state.degradationReason).toContain('completing with best passing candidate');
  });

  it('refuses pre-flight when office daily cap is set to USD 0.01', async () => {
    const { checkOfficeDailyBudget } = await import('../src/studio/cost-architecture-v3.js');
    const originalCap = process.env.HAWA_DAILY_CAP_USD;
    try {
      process.env.HAWA_DAILY_CAP_USD = '0.01';
      // An operation estimated at $0.05 must be rejected
      const check = checkOfficeDailyBudget(0.05);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('DAILY_CAP_EXCEEDED');
      expect(check.capUsd).toBe(0.01);
      expect(check.warningTriggered).toBe(true);
    } finally {
      if (originalCap !== undefined) {
        process.env.HAWA_DAILY_CAP_USD = originalCap;
      } else {
        delete process.env.HAWA_DAILY_CAP_USD;
      }
    }
  });

  it('triggers low-balance warning when remaining budget is at or below threshold', async () => {
    const { checkOfficeDailyBudget } = await import('../src/studio/cost-architecture-v3.js');
    const originalCap = process.env.HAWA_DAILY_CAP_USD;
    const originalThreshold = process.env.HAWA_LOW_BALANCE_THRESHOLD_USD;
    try {
      process.env.HAWA_DAILY_CAP_USD = '10.00';
      process.env.HAWA_LOW_BALANCE_THRESHOLD_USD = '20.00'; // threshold higher than cap guarantees trigger
      const check = checkOfficeDailyBudget(0.00);
      expect(check.warningTriggered).toBe(true);
      expect(check.warningMessage).toContain('Low Balance Alert');
    } finally {
      if (originalCap !== undefined) process.env.HAWA_DAILY_CAP_USD = originalCap;
      else delete process.env.HAWA_DAILY_CAP_USD;
      if (originalThreshold !== undefined) process.env.HAWA_LOW_BALANCE_THRESHOLD_USD = originalThreshold;
      else delete process.env.HAWA_LOW_BALANCE_THRESHOLD_USD;
    }
  });
});
