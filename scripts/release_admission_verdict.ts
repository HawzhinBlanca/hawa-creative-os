/**
 * The release preflight checks code and infrastructure. Product admission is a
 * separate decision about the exact deployed candidate. Historical drill files
 * are deliberately not read here; R27 must supply independently verified,
 * candidate-bound proof for every gate before any gate can pass.
 */
export const ADMISSION_GATES = [
  'GateA_StudioProof',
  'GateB_SecurityClientIsolation',
  'GateC_DurableOperation',
  'GateD_ModelRetrievalQuality',
  'GateE_DesignQA',
  'GateF_HumanReview',
  'GateG_Publication',
  'GateH_Recovery',
] as const;

export type AdmissionGate = (typeof ADMISSION_GATES)[number];

export interface VerifiedGateProof {
  result: 'PASS';
  candidateCommit: string;
  sourceManifestSha256: string;
  deploymentReceiptSha256: string;
  evidenceKind: 'measured' | 'blinded_human_study';
}

export interface AdmissionVerdict {
  status: 'QUALIFIED' | 'ENGINEERING_PREFLIGHT_PASSED_ADMISSION_OPEN' | 'UNQUALIFIED_ENGINEERING';
  admissionQualified: boolean;
  normativeGatesEvaluated: Record<AdmissionGate, string>;
}

export function assessReleaseAdmission(input: {
  candidateCommit: string;
  sourceManifestSha256: string;
  engineeringChecksPassed: boolean;
  refusalVerified: boolean;
  /** This hash must come from an independently inspected deployment receipt. */
  verifiedDeploymentReceiptSha256?: string;
  /** Only a future evidence verifier may populate this map. */
  verifiedGateProofs?: Partial<Record<AdmissionGate, VerifiedGateProof>>;
}): AdmissionVerdict {
  const gates = {} as Record<AdmissionGate, string>;
  for (const gate of ADMISSION_GATES) {
    const proof = input.verifiedGateProofs?.[gate];
    if (!input.verifiedDeploymentReceiptSha256) {
      gates[gate] = 'NOT_RUN_DEPLOYMENT_REQUIRED';
    } else if (!proof) {
      gates[gate] = 'NOT_RUN_CURRENT_CANDIDATE';
    } else if (
      proof.result !== 'PASS' ||
      proof.candidateCommit !== input.candidateCommit ||
      proof.sourceManifestSha256 !== input.sourceManifestSha256 ||
      proof.deploymentReceiptSha256 !== input.verifiedDeploymentReceiptSha256
    ) {
      gates[gate] = 'STALE_OR_INVALID_PROOF';
    } else if (gate === 'GateF_HumanReview' && proof.evidenceKind !== 'blinded_human_study') {
      gates[gate] = 'HUMAN_STUDY_REQUIRED';
    } else {
      gates[gate] = 'PASS';
    }
  }
  const admissionQualified = input.engineeringChecksPassed && input.refusalVerified &&
    ADMISSION_GATES.every((gate) => gates[gate] === 'PASS');
  return {
    status: admissionQualified ? 'QUALIFIED' : input.engineeringChecksPassed
      ? 'ENGINEERING_PREFLIGHT_PASSED_ADMISSION_OPEN' : 'UNQUALIFIED_ENGINEERING',
    admissionQualified,
    normativeGatesEvaluated: gates,
  };
}

function main(): void {
  const [commit, manifestSha, engineering, refusal] = process.argv.slice(2);
  if (!/^[0-9a-f]{40}$/.test(commit || '') || !/^[0-9a-f]{64}$/.test(manifestSha || '')) {
    throw new Error('Expected candidate commit and source manifest SHA-256');
  }
  // No deployment receipt or verified current-candidate gate proofs are available
  // to this pre-deployment gate. R27 must add a separate evidence verifier.
  console.log(JSON.stringify(assessReleaseAdmission({
    candidateCommit: commit,
    sourceManifestSha256: manifestSha,
    engineeringChecksPassed: engineering === '1',
    refusalVerified: refusal === '1',
  })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
