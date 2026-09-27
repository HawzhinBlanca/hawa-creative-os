export type SpendingRole = 'creative_director' | 'visual_judge' | 'asset_photoreal' |
  'intake_router' | 'brief_builder' | 'feedback_classifier' | 'rule_miner' |
  'embedding_multimodal' | 'reranker_multimodal' | 'voice_transcriber';

export interface SpendingLimits {
  officeUsd: number; clientUsd: number; roleUsd: number;
  clients: Record<string, number>; roles: Partial<Record<SpendingRole, number>>;
}
export interface SpendingPolicyChange {
  expectedVersion: number; expectedLimitsSha256: string; reason: string; limits: SpendingLimits;
}
export interface SpendingPolicyRevision {
  version: number; limits: SpendingLimits; limitsSha256: string; reason: string;
  actionId: string; actorUserId: string | null; recordedBy: string; recordedAt: string;
}
export interface SpendingPolicyResult { replayed: boolean; receipt: SpendingPolicyRevision }
export interface SpendingPolicyDetail {
  tenantId: string; userId: string; canEdit: boolean; current: SpendingPolicyRevision;
  history: SpendingPolicyRevision[]; nextBeforeVersion: number | null;
  clients: Array<{ id: string; name: string }>;
  daily: { day: string; timezone: 'Asia/Baghdad'; policyVersion: number;
    scopes: Array<{ scope: 'office' | 'client' | 'role'; subject: string; maxUsd: number;
      spentUsd: number; heldUsd: number; remainingUsd: number; historyIncomplete: boolean }> };
}
