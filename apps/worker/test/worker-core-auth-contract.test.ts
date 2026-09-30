import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@hawa/db';
import { createApp } from '../../core/src/app.js';
import { projectLifecycleOpen } from '../../core/src/services/lifecycle-projection.js';
import { DurableStepJournal } from '../src/durable-context.js';
import { runOwnedDesign, type DesignRunInput } from '../src/lifecycle/design-run.js';

/**
 * T1 (2026-09-30 audit #21, ADR-155): the worker's real DesignRun against Core's real createApp, with
 * no testAuth, in both office access modes. Every other worker test answered with a fake fetch, which
 * is how ADR-146 reached production: in trusted_office mode Core ignored the worker's HAWA_BEARER_TOKEN
 * (the call comes from core:3001 inside the Docker network, not from the office origin) and answered
 * 401 to every design's first step. The run must get past `canva-verify-task-scope` with Core's own
 * answer. The calls after it are stopped here: they plan with paid models and import into Canva.
 */
const db = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => db.destroy());
afterEach(() => vi.unstubAllEnvs());

const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const OFFICE_ORIGIN = 'http://127.0.0.1:8080';

describe.each([
  ['required', {}],
  ['trusted_office', { HAWA_TRUSTED_OFFICE_ORIGIN: OFFICE_ORIGIN }],
] as const)('worker → Core with real auth (HAWA_DESK_AUTH_MODE=%s)', (mode, extra) => {
  it('passes canva-verify-task-scope with the worker credential, from inside the network', async () => {
    vi.stubEnv('HAWA_DESK_AUTH_MODE', mode);
    for (const [key, value] of Object.entries(extra)) vi.stubEnv(key, value);
    vi.stubEnv('HAWA_BEARER_TOKEN', ['contract', 'service', 'bearer'].join('_'));
    vi.stubEnv('HAWA_WORKER_TOKEN', ['contract', 'worker', 'internal'].join('_'));
    vi.stubEnv('HAWA_CORE_INTERNAL_URL', 'http://core:3001');
    const chat = String(63_000_000 + Math.floor(Math.random() * 8_000_000));
    vi.stubEnv('TELEGRAM_ALLOWED_USERS', chat);

    const requestId = randomUUID();
    const opened = await projectLifecycleOpen(db, {
      requestId, tenantId, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
      draft: { platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chat,
        rawText: 'Contract poster', title: 'Contract poster', designInstructions: 'Use the exact copy',
        exactCopy: ['Contract poster'], clientId, autoGenerate: true, designStudio: false },
    });
    expect(opened.stage).toBe('designing');
    const taskId = opened.taskId;
    const runId = `dr-${taskId}`;
    const input: DesignRunInput = { v: 1, lifecycle: { requestId, round: 0, runId }, taskId, tenantId, clientId,
      rawText: 'Contract poster', sourcePlatform: 'telegram', idempotencyKey: `lifecycle:${requestId}:${taskId}`,
      canvaAutoGenerate: true };

    const app = createApp({ db });
    const answers: Array<{ method: string; url: string; status: number }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      const method = init?.method || 'GET';
      if (method === 'GET' && target === `http://core:3001/v1/tasks/${taskId}`) {
        const response = await app.request(target, init);
        answers.push({ method, url: target, status: response.status });
        return response;
      }
      // Past the step under test: stop before planning (paid) or Canva, as Core would refuse a request.
      answers.push({ method, url: target, status: 422 });
      return Response.json({ title: 'CONTRACT_TEST_STOP' }, { status: 422 });
    }) as typeof fetch;

    const journal = new DurableStepJournal(runId);
    const reports: Array<{ status: string; code?: string }> = [];
    const outcome = await runOwnedDesign(input, runId, journal, (report) => reports.push(report), fetcher);

    expect(answers[0]).toEqual({ method: 'GET', url: `http://core:3001/v1/tasks/${taskId}`, status: 200 });
    expect(journal.getStepResult<{ id: string; requestId: string; clientId: string }>('canva-verify-task-scope'))
      .toMatchObject({ id: taskId, requestId, clientId });
    // The run went on to the next step (stopped by this test), not ended by an auth refusal.
    expect(reports).toEqual([expect.objectContaining({ status: 'DESIGN_REJECTED', code: 'CONTRACT_TEST_STOP' })]);
    expect(outcome.status).toBe('DESIGN_REJECTED');
  });
});
