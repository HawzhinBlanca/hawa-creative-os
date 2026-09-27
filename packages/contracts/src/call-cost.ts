/** Sanitized accounting transport. Original provider bodies never belong here. */
export type CallCostKind = 'studio' | 'evaluation' | 'voice' | 'health_probe';
export interface CallCostAttestation {
  id: string; revision: number; actorUserId: string; recordedAt: string; reason: string;
  conclusion: 'provider_finished' | 'provider_not_accepted'; reportedCostUsd: number;
  evidenceReference: string; evidenceSha256: string;
}
export interface CallCostEvidence {
  kind: CallCostKind; id: string; clientId: string | null; taskId: string | null; runId: string | null;
  provider: string | null; model: string | null; status: string; startedAt: string;
  providerRequestId: string | null; responseId?: string | null; costBasis: string | null;
  originalCostUsd: number | null; reservedUsd: number | null; settledCostUsd: number | null;
  attestedCostUsd: number | null; accountedCostUsd: number; originalAccepted: boolean;
  requiresCostEvidence: boolean; evidenceConflict: boolean; revision: number;
  attestations: CallCostAttestation[]; snapshotHash: string;
}
export interface CallCostDetail extends CallCostEvidence { canRecord: boolean }
export interface CallCostPage { items: CallCostEvidence[]; nextCursor: string | null }
