import type { DeliverableStore } from '../../src/services/pinned-deliverables.js';

/**
 * Delivery fixtures with hand-seeded Canva exports have no remote Canva account.
 * Their publication tests supply the unchanged-version observation explicitly;
 * canva-desk-check-capture.test.ts exercises the real live-read guard.
 */
export function syntheticUnchangedCanvaVersion(store: DeliverableStore): DeliverableStore {
  return {
    ...store,
    async verifyCurrentSource() {
      return { ok: true, capturedVersion: '200', observedVersion: '200' };
    },
  };
}
