/** Display precision belongs at the UI boundary; Core retains fractional hours. */
export function formatElapsedHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return '—';
  const seconds = hours * 3600;
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60) ? ` ${Math.floor(seconds % 60)}s` : ''}`;
  return `${Math.floor(hours)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
export function stageLabel(stage: string): string {
  return ({ briefToDraft: 'Brief → draft', draftToApproval: 'Draft → approval', approvalToDelivery: 'Approval → delivery' } as Record<string, string>)[stage] || stage;
}
