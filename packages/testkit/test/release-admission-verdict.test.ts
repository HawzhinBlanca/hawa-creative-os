import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ADMISSION_GATES, assessReleaseAdmission, type VerifiedGateProof } from '../../../scripts/release_admission_verdict.js';

const commit = 'a'.repeat(40);
const manifest = 'b'.repeat(64);
const receipt = 'c'.repeat(64);

describe('current-candidate release admission', () => {
  it('keeps all gates open in the actual pre-deployment CLI, despite old checked-in drill files', () => {
    const root = path.resolve(__dirname, '../../..');
    const raw = execFileSync('pnpm', ['exec', 'tsx', 'scripts/release_admission_verdict.ts', commit, manifest, '1', '1'], {
      cwd: root, encoding: 'utf8',
    });
    const verdict = JSON.parse(raw);
    expect(verdict.status).toBe('ENGINEERING_PREFLIGHT_PASSED_ADMISSION_OPEN');
    expect(verdict.admissionQualified).toBe(false);
    expect(Object.values(verdict.normativeGatesEvaluated)).toEqual(
      Array(8).fill('NOT_RUN_DEPLOYMENT_REQUIRED'),
    );
  });

  it('rejects previous candidate proof and a review workflow presented as a blind human study', () => {
    const proof: VerifiedGateProof = {
      result: 'PASS', candidateCommit: commit, sourceManifestSha256: manifest,
      deploymentReceiptSha256: receipt, evidenceKind: 'measured',
    };
    const verdict = assessReleaseAdmission({
      candidateCommit: commit, sourceManifestSha256: manifest,
      engineeringChecksPassed: true, refusalVerified: true,
      verifiedDeploymentReceiptSha256: receipt,
      verifiedGateProofs: {
        GateA_StudioProof: { ...proof, candidateCommit: 'd'.repeat(40) },
        GateF_HumanReview: proof,
      },
    });
    expect(verdict.admissionQualified).toBe(false);
    expect(verdict.normativeGatesEvaluated.GateA_StudioProof).toBe('STALE_OR_INVALID_PROOF');
    expect(verdict.normativeGatesEvaluated.GateF_HumanReview).toBe('HUMAN_STUDY_REQUIRED');
    expect(verdict.normativeGatesEvaluated.GateB_SecurityClientIsolation).toBe('NOT_RUN_CURRENT_CANDIDATE');
    expect(verdict.normativeGatesEvaluated.GateG_Publication).toBe('NOT_RUN_CURRENT_CANDIDATE');
  });

  it('requires every current-candidate gate and technical refusal check', () => {
    const proof: VerifiedGateProof = {
      result: 'PASS', candidateCommit: commit, sourceManifestSha256: manifest,
      deploymentReceiptSha256: receipt, evidenceKind: 'measured',
    };
    const verifiedGateProofs = Object.fromEntries(ADMISSION_GATES.map((gate) => [
      gate, gate === 'GateF_HumanReview' ? { ...proof, evidenceKind: 'blinded_human_study' } : proof,
    ]));
    const verdict = assessReleaseAdmission({
      candidateCommit: commit, sourceManifestSha256: manifest,
      engineeringChecksPassed: true, refusalVerified: false,
      verifiedDeploymentReceiptSha256: receipt,
      verifiedGateProofs,
    });
    expect(verdict.admissionQualified).toBe(false);
    expect(verdict.status).toBe('ENGINEERING_PREFLIGHT_PASSED_ADMISSION_OPEN');
  });
});
