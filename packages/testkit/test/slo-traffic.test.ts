import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyntheticTrafficDaemon, SYNTHETIC_SCENARIOS } from '../src/index.js';

describe('SyntheticTrafficDaemon & SLO Heartbeat Engine', () => {
  let daemon: SyntheticTrafficDaemon;

  beforeEach(() => {
    daemon = new SyntheticTrafficDaemon(10); // 10 seed probes
  });

  it('runs complete Nawroz Spring synthetic campaign with 100% invariant adherence', async () => {
    const result = await daemon.runProbe('nawroz_spring');

    expect(result.success).toBe(true);
    expect(result.scenario).toBe('nawroz_spring');
    expect(result.totalDurationMs).toBeGreaterThan(0);
    expect(result.taskId).toBeDefined();
    expect(result.documentId).toBeDefined();
    expect(result.publicationId).toBeDefined();

    // Verify all 7 stage latencies are tracked
    expect(result.stages.ingressMs).toBeGreaterThanOrEqual(1);
    expect(result.stages.routingMs).toBeGreaterThanOrEqual(1);
    expect(result.stages.briefMs).toBeGreaterThanOrEqual(1);
    expect(result.stages.composingMs).toBeGreaterThanOrEqual(1);
    expect(result.stages.qaMs).toBeGreaterThanOrEqual(1);
    expect(result.stages.approvalMs).toBeGreaterThanOrEqual(1);
    expect(result.stages.publishMs).toBeGreaterThanOrEqual(1);

    // Verify all 6 Master Spec invariants
    expect(result.invariantsVerified.deskCanonical).toBe(true);
    expect(result.invariantsVerified.clientScopeLocked).toBe(true);
    expect(result.invariantsVerified.protectedTokensPreserved).toBe(true);
    expect(result.invariantsVerified.editableDocumentMaintained).toBe(true);
    expect(result.invariantsVerified.deterministicQaPassed).toBe(true);
    expect(result.invariantsVerified.idempotentPublication).toBe(true);
  });

  it('executes Grand Opening and VIP Ramadan campaign profiles', async () => {
    const r1 = await daemon.runProbe('grand_opening');
    expect(r1.success).toBe(true);
    expect(r1.invariantsVerified.protectedTokensPreserved).toBe(true);

    const r2 = await daemon.runProbe('vip_ramadan');
    expect(r2.success).toBe(true);
    expect(r2.invariantsVerified.protectedTokensPreserved).toBe(true);
  });

  it('calculates P50, P95, and P99 latency percentiles and error budget accurately', async () => {
    // Run 5 additional diverse probes
    await daemon.runProbe('nawroz_spring');
    await daemon.runProbe('grand_opening');
    await daemon.runProbe('vip_ramadan');
    await daemon.runProbe('nawroz_spring');
    await daemon.runProbe('grand_opening');

    const summary = daemon.getSummary();
    expect(summary.totalProbes).toBe(15);
    expect(summary.successfulProbes).toBe(15);
    expect(summary.failedProbes).toBe(0);
    expect(summary.successRate).toBe(100);
    expect(summary.errorBudgetRemaining).toBe(100);

    if (summary.p50DurationMs === null || summary.p95DurationMs === null || summary.p99DurationMs === null) throw new Error('Measured fixture latencies missing');
    // Percentile ordering invariant: P50 <= P95 <= P99
    expect(summary.p50DurationMs).toBeGreaterThan(0);
    expect(summary.p95DurationMs).toBeGreaterThanOrEqual(summary.p50DurationMs);
    expect(summary.p99DurationMs).toBeGreaterThanOrEqual(summary.p95DurationMs);
    expect(summary.p99DurationMs).toBeLessThan(summary.targetP99Ms);
    expect(summary.sloCompliant).toBe(true);
  });

  it('reports live circuit breaker snapshots for all model providers', () => {
    const summary = daemon.getSummary();
    expect(summary.circuitBreakers.length).toBe(4);

    const providers = summary.circuitBreakers.map((cb) => cb.name);
    expect(providers).toContain('google');
    expect(providers).toContain('anthropic');
    expect(providers).toContain('openai');
    expect(providers).toContain('local');

    summary.circuitBreakers.forEach((cb) => {
      expect(cb.state).toBe('CLOSED');
      expect(cb.consecutiveFailures).toBe(0);
    });
  });

  it('retrieves recent probe history in reverse chronological order', async () => {
    await daemon.runProbe('nawroz_spring');
    const recent = daemon.getRecentProbes(5);
    expect(recent.length).toBe(5);
    expect(recent[0].scenario).toBe('nawroz_spring');
  });
});

it('does not manufacture latency, success or compliance without synthetic samples',()=>{
 const summary=new SyntheticTrafficDaemon(0).getSummary();
 expect(summary).toMatchObject({totalProbes:0,successRate:null,errorBudgetRemaining:null,p50DurationMs:null,p95DurationMs:null,p99DurationMs:null,sloCompliant:null});
});

it('exhausts its fixture error budget at one failure in one hundred observations',async()=>{
 const daemon=new SyntheticTrafficDaemon(99);
 const failure=vi.spyOn(daemon.modelGateway,'resolve').mockRejectedValue(new Error('Synthetic failure'));
 try {
  expect((await daemon.runProbe()).success).toBe(false);
  expect(daemon.getSummary()).toMatchObject({totalProbes:100,successRate:99,errorBudgetRemaining:0});
 } finally { failure.mockRestore(); }
});
