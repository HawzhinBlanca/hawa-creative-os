import { vi } from 'vitest';
import { coreInternalFromEnv } from '../src/lifecycle/delivery.js';

/** Keep the generic HTTP boundary intact while returning a synthetic JSON receipt. */
export function coreInternalFixture(receipt: unknown) {
  vi.stubEnv('HAWA_WORKER_TOKEN', 'test-only-core-fixture');
  const remote = vi.fn<typeof fetch>(async () => Response.json(receipt));
  const client = coreInternalFromEnv(remote);
  return Object.assign(client, { postSpy: vi.spyOn(client, 'post'), remote });
}
