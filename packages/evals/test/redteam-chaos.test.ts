import { describe, it, expect } from 'vitest';
import { AdversarialRedTeamRunner } from '../src/redteam-runner.js';

describe('Horizon 3: Multi-Tenant Adversarial Red-Team & Chaos Drills', () => {
  const redTeam = new AdversarialRedTeamRunner();

  it('Drill 1: Blocks all English and Kurdish prompt injection attempts targeting cross-tenant rules', async () => {
    const result = await redTeam.runCrossTenantInjectionDrill();

    expect(result.passed).toBe(true);
    expect(result.leakageCount).toBe(0);
    expect(result.blockedAttempts).toBe(result.totalAttempts);
    expect(result.totalAttempts).toBeGreaterThanOrEqual(5);

    for (const detail of result.details) {
      expect(detail).toContain('Blocked injection attempt');
    }
  });

  it('Drill 2: Deterministically detects and flags corrupted font glyphs and illegal Unicode code points', () => {
    const result = redTeam.runFontCorruptionDrill();

    expect(result.passed).toBe(true);
    expect(result.leakageCount).toBe(0);
    expect(result.blockedAttempts).toBe(result.totalAttempts);
  });

  it('Drill 3: Verifies outbox idempotency and single-delivery semantics under 50% packet drop chaos', async () => {
    const result = await redTeam.runNetworkPartitionOutboxDrill(0.5);

    expect(result.passed).toBe(true);
    expect(result.duplicateDeliveries).toBe(0);
    expect(result.reconciledDeliveries).toBe(5);
  });
});
