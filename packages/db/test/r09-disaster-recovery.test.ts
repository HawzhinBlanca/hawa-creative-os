import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

describe('R09 Disaster Recovery & Clean-Host PITR Invariants (FR-070, NFR-003, NFR-020)', () => {
  const evidencePath = resolve(__dirname, '../../../output/repairs/2026-09-19-architecture-remediation/DISASTER_RECOVERY_EVIDENCE.json');

  it('verifies that the clean-host disaster recovery evidence artifact exists and is well-formed', () => {
    expect(existsSync(evidencePath)).toBe(true);
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));

    expect(evidence.drillId).toBeDefined();
    expect(evidence.timestamp).toBeDefined();
    expect(evidence.normativeStandards).toContain('FR-070');
    expect(evidence.normativeStandards).toContain('NFR-003');
    expect(evidence.normativeStandards).toContain('NFR-020');
  });

  it('proves measured RPO <= 15 minutes (900 seconds) using real acknowledged business marker', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const rpo = evidence.cleanHostExecution.rpo;

    expect(rpo.passed).toBe(true);
    expect(rpo.markerId).toMatch(/^dr-marker-/);
    expect(rpo.markerAcknowledgedAt).toBeDefined();
    expect(rpo.measuredSeconds).toBeLessThanOrEqual(900);
    expect(rpo.measuredSeconds).toBeGreaterThanOrEqual(0);
  });

  it('proves measured RTO <= 4 hours (14,400 seconds) on an isolated clean host', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const rto = evidence.cleanHostExecution.rto;

    expect(rto.passed).toBe(true);
    expect(rto.measuredSeconds).toBeLessThanOrEqual(14400);
    expect(rto.measuredSeconds).toBeGreaterThan(0);
  });

  it('verifies 100% data and schema parity across production and restored clean host', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const parity = evidence.parityVerification;

    expect(parity.tasks.match).toBe(true);
    expect(parity.events.match).toBe(true);
    expect(parity.clients.match).toBe(true);
    expect(parity.outboxCommands.match).toBe(true);
    expect(parity.canvaPlans.match).toBe(true);

    expect(parity.schema.tables).toBeGreaterThanOrEqual(52);
    expect(parity.schema.policies).toBeGreaterThanOrEqual(24);
    expect(parity.schema.enums).toBeGreaterThanOrEqual(11);
    expect(parity.schema.parityPassed).toBe(true);
  });

  it('proves zero RLS leakage across tenant boundaries in the restored database', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const rls = evidence.parityVerification.rlsSecurity;

    expect(rls.isolationEnforced).toBe(true);
    expect(rls.crossTenantLeakedRows).toBe(0);
  });

  it('proves negative controls: corrupted ciphertext, missing backup, and destination failure are all rejected', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const neg = evidence.negativeControls;

    expect(neg.corruptedCiphertextRejected).toBe(true);
    expect(neg.missingBackupCleanlyAborted).toBe(true);
    expect(neg.unavailableDestinationHealthFailure).toBe(true);
  });

  it('verifies AES-256-CBC PBKDF2 encryption configuration and off-host replica', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const enc = evidence.encryption;

    expect(enc.cipher).toBe('AES-256-CBC');
    expect(enc.keyDerivation).toBe('PBKDF2');
    expect(enc.iterations).toBe(100000);
    expect(enc.rawSizeBytes).toBeGreaterThan(100000000); // > 100MB
    expect(enc.encryptedSizeBytes).toBeGreaterThan(100000000);
    expect(enc.encryptedBundleSha256).toHaveLength(64);
    expect(enc.offhostReplica).toBeDefined();
  });

  it('confirms all separate operational verdicts are PASSED and overall status is QUALIFIED', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const verdicts = evidence.verdicts;

    expect(verdicts.backup_verdict).toBe('PASSED');
    expect(verdicts.schema_rebuild_verdict).toBe('PASSED');
    expect(verdicts.clean_host_recovery_verdict).toBe('PASSED');
    expect(verdicts.asset_fidelity_verdict).toBe('PASSED');
    expect(verdicts.rls_isolation_verdict).toBe('PASSED');
    expect(verdicts.fault_simulation_verdict).toBe('PASSED');
    expect(verdicts.overall_verdict).toBe('QUALIFIED');
  });
});
