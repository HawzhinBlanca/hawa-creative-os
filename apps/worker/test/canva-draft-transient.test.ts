import { describe, it, expect, vi, afterEach } from 'vitest';
import { runCanvaDraft } from '../src/canva-draft-workflow.js';
import { DurableStepJournal } from '../src/durable-context.js';

const input = { taskId: '00000000-0000-4000-c000-0000000000aa', tenantId: 'tenant', clientId: 'client', rawText: '', sourcePlatform: 'telegram', idempotencyKey: 'key', canvaAutoGenerate: true };
afterEach(() => { vi.unstubAllEnvs(); });

/**
 * Bug hunt 2026-09-24: Core answers 409 CANVA_RECONNECT_REQUIRED to any Canva call that arrives while
 * another call is rotating the shared token (canva-connect-service authorizedClient). The worker
 * treats every 4xx but 408/429 as final, so a design that exists in Canva is reported with a failed
 * check, and Core records a failed QC run that nothing can ever replace.
 */
describe('HUNT: a Canva token refresh collision during the draft\'s exports', () => {
  it('retries the export instead of ending the draft as CANVA_PREVIEW_FAILED', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const responses = [
      Response.json({ tenantId: 'tenant', clientId: 'client' }),
      Response.json({ status: 'retrieved', designId: 'DA_hunt' }),
      Response.json({ binding: { designId: 'DA_hunt', version: 1 } }),
      // The preview export lands while the other studio run's poll is refreshing the token.
      Response.json({ title: 'CANVA_RECONNECT_REQUIRED' }, { status: 409 }),
    ];
    const remote = vi.fn<typeof fetch>(async () => responses.shift() ?? Response.json({ ok: true }));
    const outcome = await runCanvaDraft(input, new DurableStepJournal(), remote).then(
      (r) => r.status,
      (e) => `retried: ${String(e?.message || e)}`
    );
    const report = remote.mock.calls.find((c) => String(c[0]).includes('/notifications/canva-status'));
    expect({ outcome, reported: report ? JSON.parse((report[1] as any).body) : null }).toMatchObject({ outcome: expect.stringMatching(/^retried/), reported: null });
  });
});
