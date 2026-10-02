/** Pure receipt policy; directory inventories and older receipts cannot establish ownership. */
export function hasOwnedRecoveryCleanup(receipt: unknown, expected: {recoveryId: string; taskId: string}): boolean {
  const record=(value:unknown):Record<string,unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : null;
  const facts=record(receipt), cleanup=record(facts?.privateArtifactsCleanup), volumes=record(facts?.restoredVolumes);
  if (!/^[0-9a-f]{16}$/.test(expected.recoveryId) || facts?.recoveryId !== expected.recoveryId ||
      facts.taskId !== expected.taskId || cleanup?.removed !== true || cleanup.scope !== 'this_recovery' ||
      !volumes || Object.keys(volumes).length !== 3) return false;
  return ['postgres','restate','blobs'].every(kind =>
    record(volumes['chaos_'+kind])?.name === `hawa-recovery-${expected.recoveryId}-${kind}`);
}
