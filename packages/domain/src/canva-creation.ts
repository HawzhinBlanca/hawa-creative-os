/** Positive evidence that a previous creation cannot leave a design to duplicate. */
export type CanvaCreationFailureEvidence =
  | { kind: 'not_accepted' }
  | { kind: 'provider_failed'; remoteJobId: string };

/** Legacy `failed` by itself is not evidence of an absent remote effect. */
export function canRetryCanvaCreation(operation: {
  status: string;
  design_id?: string | null;
  remote_job_id?: string | null;
  metadata?: { failureEvidence?: CanvaCreationFailureEvidence } | null;
}): boolean {
  if (operation.status !== 'failed' || operation.design_id) return false;
  const evidence = operation.metadata?.failureEvidence;
  if (evidence?.kind === 'not_accepted') return !operation.remote_job_id;
  return evidence?.kind === 'provider_failed' && Boolean(operation.remote_job_id)
    && evidence.remoteJobId === operation.remote_job_id;
}
