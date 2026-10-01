/** Generation replay accounting only; every preflight stays in the ledger, with no free-cost claim. */
export function isDesignGenerationResponse(entry: { status: number; route: string }): boolean {
  return entry.status === 200 && entry.route !== 'billing-probe' && entry.route !== 'input-token-count';
}
