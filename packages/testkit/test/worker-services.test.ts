import { describe, expect, it } from 'vitest';
import { WORKER_SERVICES } from '../../../scripts/restate-bluegreen.js';
import { WORKER_SERVICE_NAMES } from '../../../apps/worker/src/services.js';
import { chatInbox } from '../../../apps/worker/src/lifecycle/chat-inbox.js';
import { createRequestLifecycle } from '../../../apps/worker/src/lifecycle/request-lifecycle.js';
import { DesignRunApi } from '../../../apps/worker/src/lifecycle/design-run.js';

/**
 * A service is never removed from the worker build (ADR-034; PHASE2_DESIGN.md section 4 rule 3): the
 * blue/green registration checks that the new colour serves every name in WORKER_SERVICES, and the
 * worker refuses to start when what it binds differs from WORKER_SERVICE_NAMES. These keep the two
 * lists one list, so a service added to the worker is also one the deploy checks.
 */
describe('the services a worker build hosts', () => {
  it('are the services the blue/green deploy checks', () => {
    expect([...WORKER_SERVICES].sort()).toEqual([...WORKER_SERVICE_NAMES].sort());
  });

  it('include ChatInbox (Phase 2.1), under that name', () => {
    expect(WORKER_SERVICE_NAMES).toContain('ChatInbox');
    expect(chatInbox.name).toBe('ChatInbox');
  });

  it('keeps RequestLifecycle in every future worker deployment', () => {
    expect(WORKER_SERVICE_NAMES).toContain('RequestLifecycle');
    expect(createRequestLifecycle({ post: async () => ({}) } as any).name).toBe('RequestLifecycle');
  });

  it('keeps DesignRun in every future worker deployment', () => {
    expect(WORKER_SERVICE_NAMES).toContain('DesignRun');
    expect(DesignRunApi.name).toBe('DesignRun');
  });
});
