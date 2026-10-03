import type { SpendingRole } from './spending-policy.js';

/** Sanitized accounting transport. Original provider bodies never belong here. */
export type CallCostKind = 'studio' | 'evaluation' | 'voice' | 'health_probe' | 'canva_planner' | 'intake_router';
/**
 * ADR-289: the intake router's readings (requester, office and copy readers, ADR-144/200/232) are
 * listed with every other paid call, but they take no attestation: the office day charges one its
 * usage, or its whole reservation when the outcome is unknown, so none is ever left awaiting evidence.
 */
export type AttestableCallCostKind = Exclude<CallCostKind, 'intake_router'>;
export interface CallCostAttestation {
  id: string; revision: number; actorUserId: string; recordedAt: string; reason: string;
  evidenceType?: 'administrator_attestation' | 'trusted_office_attestation' | 'reservation_expiry'; actorLabel?: string | null;
  conclusion: 'provider_finished' | 'provider_not_accepted' | 'reservation_charged'; reportedCostUsd: number;
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
  /** Intake router rows only: which reader asked (ADR-144 requester, ADR-200 office, ADR-232 copy). */
  reader?: 'requester' | 'office' | 'copy';
  /** Intake router rows only: the Telegram chat the reading was for. */
  chatId?: string;
}
export interface CallCostDetail extends CallCostEvidence { canRecord: boolean }
export interface CallCostPage { items: CallCostEvidence[]; nextCursor: string | null }

/** One role's paid calls in one office day, or over the whole window (ADR-289). */
export interface SpendingRoleTotal {
  role: SpendingRole; calls: number;
  /** The same per-call figure the call list shows ("cost counted toward limits"), summed. */
  accountedUsd: number;
  /** Calls whose cost is not final yet: their unused reservation is still held by the office day. */
  awaitingEvidence: number;
  /**
   * What those calls still hold beyond their counted cost (reservation minus counted, never below 0).
   * A voice transcription reports no cost, so its whole reservation shows here until it is attested.
   */
  heldUsd: number;
}
/** Every paid model call of the office, by office day (Asia/Baghdad) and budget role (ADR-289). */
export interface SpendingSummary {
  timezone: 'Asia/Baghdad'; from: string; to: string;
  days: Array<{ day: string; calls: number; accountedUsd: number; roles: SpendingRoleTotal[] }>;
  roles: SpendingRoleTotal[]; calls: number; accountedUsd: number;
}
