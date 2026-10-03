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

/** ADR-288: the owner's north-star numbers as Core reports them in the funnel (`northStar`), or null. */
export interface NorthStar {
  days: number; deliveredDesigns: number; approvals: number; approvedFirstDraft: number;
  firstDraftApprovalRate: number | null; medianBriefToDeliveryHours: number | null; briefToDeliverySamples: number;
}
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const hoursOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

export function parseNorthStar(value: unknown): NorthStar | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!['days', 'deliveredDesigns', 'approvals', 'approvedFirstDraft', 'briefToDeliverySamples'].every((k) => whole(v[k])) ||
      !hoursOrNull(v.medianBriefToDeliveryHours) ||
      !(v.firstDraftApprovalRate === null || (typeof v.firstDraftApprovalRate === 'number' && v.firstDraftApprovalRate >= 0 && v.firstDraftApprovalRate <= 1)) ||
      (v.approvedFirstDraft as number) > (v.approvals as number)) return null;
  return v as unknown as NorthStar;
}

/** One line: delivered designs, first-draft approvals, and the median brief → delivery time. */
export function northStarSummary(n: NorthStar): string {
  const rate = n.firstDraftApprovalRate === null ? 'no approvals yet'
    : `${Math.round(n.firstDraftApprovalRate * 100)}% approved on the first draft (${n.approvedFirstDraft} of ${n.approvals})`;
  const median = n.medianBriefToDeliveryHours === null ? 'no delivery to time'
    : `median brief → delivery ${formatElapsedHours(n.medianBriefToDeliveryHours)} (${n.briefToDeliverySamples} delivered)`;
  return `Last ${n.days} days: ${n.deliveredDesigns} designs delivered · ${rate} · ${median}`;
}

/** Requests that ended before a draft, by who ended them, or null when there were none or no data. */
export function cancelledBeforeDraftSummary(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (!['total', 'requesterWithdrew', 'officeCancelled', 'systemFailed', 'other'].every((k) => whole(c[k])) || c.total === 0) return null;
  const parts = [[c.requesterWithdrew, 'withdrawn by the requester'], [c.officeCancelled, 'cancelled by the office'],
    [c.systemFailed, 'ended without a draft (system)'], [c.other, 'closed for another reason']]
    .filter(([n]) => (n as number) > 0).map(([n, what]) => `${n} ${what}`);
  return `Ended before a draft: ${c.total} (${parts.join(', ')})`;
}
