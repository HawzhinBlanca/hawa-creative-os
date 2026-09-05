import { describe, it, expect, beforeEach } from 'vitest';
import { CostGovernor } from '../src/cost-governor.js';

describe('CostGovernor: Token & GPU Budget Controller (B-082, FR-079)', () => {
  let governor: CostGovernor;

  beforeEach(() => {
    governor = new CostGovernor();
  });

  it('initializes with seeded client budgets and healthy status', () => {
    const drustee = governor.getOrCreateClientBudget('client-drustee');
    expect(drustee.capUsd).toBe(10.0);
    expect(drustee.spentUsd).toBe(0.0);
    expect(drustee.status).toBe('HEALTHY');

    const summaries = governor.getAllSummaries();
    expect(summaries.length).toBeGreaterThanOrEqual(5);
  });

  it('accurately computes token and GPU execution costs', () => {
    // 10,000 input tokens + 2,000 output tokens on Claude 3.5 Sonnet ($3.0 / $15.0 per 1M)
    // input = 10000 * 3 / 1M = 0.03
    // output = 2000 * 15 / 1M = 0.03
    // total = 0.06
    const claudeCost = governor.calculateEstimatedCost('anthropic', 'claude-3-5-sonnet', { input: 10_000, output: 2_000 });
    expect(claudeCost).toBeCloseTo(0.06, 4);

    // 10 seconds of ComfyUI SDXL GPU compute @ $0.0003/sec = $0.003
    const gpuCost = governor.calculateEstimatedCost('comfyui', 'sdxl-turbo', { input: 0, output: 0 }, 10);
    expect(gpuCost).toBeCloseTo(0.003, 4);
  });

  it('permits operations within budget and flags warning threshold at >= 80%', () => {
    // Client with $5.00 cap
    const check1 = governor.checkBudget('client-aster', 1.0);
    expect(check1.allowed).toBe(true);
    expect(check1.warningTriggered).toBe(false);

    // Record $4.10 spend (82% of $5.00)
    governor.recordUsage({
      clientId: 'client-aster',
      taskId: 'task-test-1',
      role: 'creative_director',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 4.10
    });

    const check2 = governor.checkBudget('client-aster', 0.5);
    expect(check2.allowed).toBe(true);
    expect(check2.warningTriggered).toBe(true);
    expect(check2.utilizationPercent).toBe(82);
  });

  it('fails closed when cumulative spend exceeds budget cap', () => {
    // Cap is $5.00
    governor.recordUsage({
      clientId: 'client-rona',
      taskId: 'task-heavy-1',
      role: 'diffusion_generator',
      provider: 'comfyui_gpu',
      model: 'sdxl-lightning',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 4.90
    });

    // Attempting an operation costing $0.20 would push total to $5.10 > $5.00
    const check = governor.checkBudget('client-rona', 0.20);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Monthly AI budget exceeded for client client-rona');

    const blockedReceipt = governor.recordUsage({
      clientId: 'client-rona',
      taskId: 'task-blocked',
      role: 'canary_eval',
      provider: 'google',
      model: 'gemini-1.5-pro',
      inputTokens: 5000,
      outputTokens: 2000,
      costUsd: 0.20
    });

    expect(blockedReceipt.status).toBe('QUOTA_REJECTED');
  });

  it('dynamically raises budget cap and restores status to HEALTHY', () => {
    // Fill quota
    governor.recordUsage({
      clientId: 'client-aster',
      taskId: 'task-fill',
      role: 'generator',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 5.0
    });

    expect(governor.getOrCreateClientBudget('client-aster').status).toBe('EXCEEDED');

    // Admin increases cap from $5.00 to $25.00
    const updated = governor.allocateBudget('client-aster', 25.0);
    expect(updated.capUsd).toBe(25.0);
    expect(updated.status).toBe('HEALTHY'); // 5.0 / 25.0 = 20% < 80%

    const newCheck = governor.checkBudget('client-aster', 2.0);
    expect(newCheck.allowed).toBe(true);
  });
});
