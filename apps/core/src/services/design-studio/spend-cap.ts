import { AsyncLocalStorage } from 'node:async_hooks';
import { studioUsdMicros } from '@hawa/domain';

/**
 * ADR-237: a hard USD cap on one kind of work inside a run, beneath the run's own budget. The visual
 * review declares it around its calls; the ledger checks each call's reservation against it before
 * admission, so a call that could take the work over its cap is never sent, and charges the call's
 * actual cost afterwards. A provider's charge never exceeds its reservation (the ledger holds the
 * run if it does), so the work's actual spend can never pass the cap.
 */
export interface StudioSpendCap {
  readonly label: string;
  readonly capUsd: number;
  /** What the work has cost so far, carried across stages by the caller. */
  spentUsd: number;
}

export class StudioSpendCapError extends Error {
  readonly code = 'STUDIO_SPEND_CAP_REACHED';
  constructor(readonly label: string, readonly capUsd: number, readonly spentUsd: number, readonly reservedUsd: number) {
    super(`The ${label} spending cap of $${capUsd.toFixed(2)} would be passed: $${spentUsd.toFixed(6)} spent, ` +
      `the next call reserves $${reservedUsd.toFixed(6)}. Nothing was sent for it.`);
    this.name = 'StudioSpendCapError';
  }
}

const scope = new AsyncLocalStorage<StudioSpendCap>();

export function inStudioSpendCap<T>(cap: StudioSpendCap, work: () => Promise<T>): Promise<T> {
  if (!Number.isFinite(cap.capUsd) || cap.capUsd <= 0 || !Number.isFinite(cap.spentUsd) || cap.spentUsd < 0) {
    throw new TypeError('A Studio spending cap needs a positive limit and a non-negative spend.');
  }
  return scope.run(cap, work);
}

/** Refuses, before admission, a call whose reservation would take the declared work over its cap. */
export function assertWithinStudioSpendCap(reservedUsd: number): void {
  const cap = scope.getStore();
  if (!cap) return;
  if (studioUsdMicros(cap.spentUsd + reservedUsd) > studioUsdMicros(cap.capUsd)) {
    throw new StudioSpendCapError(cap.label, cap.capUsd, cap.spentUsd, reservedUsd);
  }
}

/** A call's actual cost (or a retained result's original cost) counts against the declared work. */
export function chargeStudioSpendCap(costUsd: number): void {
  const cap = scope.getStore();
  if (cap && Number.isFinite(costUsd) && costUsd > 0) cap.spentUsd += costUsd;
}
