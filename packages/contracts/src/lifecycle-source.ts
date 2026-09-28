/** Only identities cross the durable-worker boundary; original files and extraction stay in Core. */
export interface LifecycleSourceRef { sourceUpdateId: number; confirmationUpdateId: number }
export function parseLifecycleSourceRef(value: unknown): LifecycleSourceRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ref = value as Record<string, unknown>;
  return Number.isSafeInteger(ref.sourceUpdateId) && Number(ref.sourceUpdateId) > 0 &&
    Number.isSafeInteger(ref.confirmationUpdateId) && Number(ref.confirmationUpdateId) > 0
    ? { sourceUpdateId: Number(ref.sourceUpdateId), confirmationUpdateId: Number(ref.confirmationUpdateId) } : null;
}
export interface ReviewedSourceEvidence {
  kind: 'pdf' | 'voice'; sourceSha256: string; extractionSha256: string;
  sourceUpdateId: number; confirmationUpdateId: number; confirmedBy: string;
  confirmation: 'request_copy_reviewed'; copySha256: string; clientId: string;
  documentId?: string; extractorVersion: string;
}
