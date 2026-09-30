/**
 * When a person must have re-checked the prices the Studio's spending reservations use (ADR-159).
 * The rates (spending-reservation.ts, which names the policy version) were checked by hand on
 * 2026-09-27 against the providers' published prices; the GPT-5.6 Sol price the gateway policy
 * relies on was published "through at least 2026-11-21" (ADR-093). Before `reviewBy` a person
 * re-checks the prices and sets a new date here in the same change (runbooks/SPENDING_POLICY.md,
 * "Renewing the price policy"). From that instant the Canva planner sends nothing, and /v1/health
 * warns from 14 days before. The date is never moved without that check.
 */
export const STUDIO_SPENDING_POLICY = { id: 'studio-reservations', pricesCheckedOn: '2026-09-27', reviewBy: '2026-11-22T00:00:00Z' } as const;
