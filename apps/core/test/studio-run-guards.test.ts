import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, DesignStudioRepository } from '@hawa/db';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;

/**
 * The run-level guards that need the database: what a new run may spend, whether a design is still
 * being made, and which pictures from a busy chat reach a request.
 */
describe.skipIf(!url)('studio run guards', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const clientId = 'c1000000-0000-4000-8000-000000000002';
  const scope = { tenantId: '00000000-0000-4000-a000-000000000001', actorId: '00000000-0000-4000-b000-000000000001' };
  const noCalls = (async () => {
    throw new Error('no model calls in this test');
  }) as unknown as typeof fetch;
  // A stale window of 0 keeps other suites' runs from counting against the tenant's two slots.
  const service = (options: { staleRunMinutes?: number } = { staleRunMinutes: 0 }) =>
    new DesignStudioService(db, undefined, { apiKey: 'test-key', fetcher: noCalls, ...options });
  const saved = { usd: process.env.DESIGN_STUDIO_MAX_USD, calls: process.env.DESIGN_STUDIO_MAX_CALLS };

  const task = async () =>
    (
      await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId: randomUUID(),
        sourceChannelId: `guards-${randomUUID().slice(0, 8)}`,
        clientId,
        title: '[TEST] Studio guards',
        rawText: 'Keep it simple.\n---\nEXACT TITLE\n\nExact body text.',
        designInstructions: 'Keep it simple.',
        exactCopy: [],
      })
    ).task.id as string;

  beforeAll(async () => {
    delete process.env.DESIGN_STUDIO_MAX_USD;
    delete process.env.DESIGN_STUDIO_MAX_CALLS;
    await sql`INSERT INTO hawa.users(id, email, display_name)
      VALUES(${scope.actorId}::uuid, 'isolated-operator@example.test', 'Test') ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO hawa.clients(id, tenant_id, code, name)
      VALUES(${clientId}::uuid, ${scope.tenantId}::uuid, 'kaae', 'KAAE') ON CONFLICT DO NOTHING`.execute(db);
  });
  afterAll(async () => {
    for (const [key, value] of [['DESIGN_STUDIO_MAX_USD', saved.usd], ['DESIGN_STUDIO_MAX_CALLS', saved.calls]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await db.destroy();
  });

  it('a new run may spend $2 in 24 calls unless the environment says otherwise', async () => {
    // A finished design costs $0.33-0.78 in at most 10 calls (2026-09-23); the cap was $6 and 40.
    const taskId = await task();
    const { run } = await service().createOrGetRun(scope, taskId, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350 });
    const budget = typeof run.budget === 'string' ? JSON.parse(run.budget) : run.budget;
    expect(budget).toMatchObject({ maxUsd: 2, maxCalls: 24, spentUsd: 0, calls: 0 });
    await service().abandon(scope, taskId, run.id, 'test cleanup');

    process.env.DESIGN_STUDIO_MAX_USD = '3.5';
    process.env.DESIGN_STUDIO_MAX_CALLS = '30';
    try {
      const other = await task();
      const { run: overridden } = await service().createOrGetRun(scope, other, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350 });
      const b = typeof overridden.budget === 'string' ? JSON.parse(overridden.budget) : overridden.budget;
      expect(b).toMatchObject({ maxUsd: 3.5, maxCalls: 30 });
      await service().abandon(scope, other, overridden.id, 'test cleanup');
    } finally {
      delete process.env.DESIGN_STUDIO_MAX_USD;
      delete process.env.DESIGN_STUDIO_MAX_CALLS;
    }
  });

  it.each(['complete', 'cancelled', 'rejected', 'paused', 'approved', 'publishing'])('refuses new Studio work on a %s task but preserves its existing run', async state => {
    const taskId = await task();
    const svc = service();
    const key = `closed-${randomUUID()}`;
    const input = { width: 1080, height: 1350 };
    const { run } = await svc.createOrGetRun(scope, taskId, key, input);
    await sql`UPDATE hawa.tasks SET state=${state}::hawa.task_state WHERE id=${taskId}::uuid`.execute(db);
    await expect(svc.createOrGetRun(scope, taskId, key, input)).resolves.toMatchObject({ created: false, run: { id: run.id } });
    await expect(svc.createOrGetRun(scope, taskId, `new-${randomUUID()}`, input))
      .rejects.toMatchObject({ code: 'TASK_GENERATION_BLOCKED', status: 409 });
    await expect(svc.resume(scope, taskId, run.id))
      .rejects.toMatchObject({ code: 'TASK_GENERATION_BLOCKED', status: 409 });
    const saved = (await sql<{status:string}>`SELECT status FROM hawa.design_studio_runs WHERE id=${run.id}::uuid`.execute(db)).rows[0];
    expect(saved.status).toBe('briefing');
    await svc.abandon(scope, taskId, run.id, 'test cleanup');
    await expect(svc.resume(scope, taskId, run.id)).resolves.toMatchObject({ status: 'abandoned' });
  });

  it('refuses dispatch when cancellation commits after stage context was built', async () => {
    const taskId = await task(), fetcher = vi.fn();
    const svc = new DesignStudioService(db, undefined, { apiKey: 'test-key', fetcher, staleRunMinutes: 0 });
    const { run } = await svc.createOrGetRun(scope, taskId, `race-${randomUUID()}`, { width: 1080, height: 1350 });
    const budget = { maxUsd: 2, maxCalls: 24, spentUsd: 0, calls: 0 };
    const ctx = await (svc as any).createStageContext(scope, run, 'briefing', budget, async () => {});
    await sql`UPDATE hawa.tasks SET state='cancelled' WHERE id=${taskId}::uuid`.execute(db);
    await expect(ctx.client.completeJson({ prompt: 'synthetic request', schema: { type: 'object' } }))
      .rejects.toMatchObject({ code: 'TASK_GENERATION_BLOCKED' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(budget.calls).toBe(0);
    expect((await sql`SELECT id FROM hawa.design_studio_calls WHERE run_id=${run.id}::uuid`.execute(db)).rows).toHaveLength(0);
    await svc.abandon(scope, taskId, run.id, 'test cleanup');
  });

  it('preserves candidate selection evidence when the task has closed', async () => {
    const taskId = await task(), svc = service(), repo = new DesignStudioRepository(db), candidateId = randomUUID();
    const { run } = await svc.createOrGetRun(scope, taskId, `select-${randomUUID()}`, { width: 1080, height: 1350 });
    await repo.insertCandidate({ id: candidateId, runId: run.id, tenantId: scope.tenantId, ordinal: 0, concept: { name: 'Synthetic' } });
    await repo.updateRunStatus(run.id, scope.tenantId, 'awaiting_selection');
    await sql`UPDATE hawa.tasks SET state='cancelled' WHERE id=${taskId}::uuid`.execute(db);
    await expect(svc.selectCandidate(scope, taskId, run.id, candidateId))
      .rejects.toMatchObject({ code: 'TASK_GENERATION_BLOCKED', status: 409 });
    expect(await repo.getRunById(run.id, scope.tenantId)).toMatchObject({ status: 'awaiting_selection', winner_candidate_id: null });
    expect(await repo.getCandidatesForRun(run.id, scope.tenantId)).toHaveLength(1);
    await svc.abandon(scope, taskId, run.id, 'test cleanup');
  });

  it('does not let a second actor or task inherit an in-flight resume authorization', async () => {
    const taskId = await task(), svc = service();
    const { run } = await svc.createOrGetRun(scope, taskId, `scope-${randomUUID()}`, { width: 1080, height: 1350 });
    let reached!: () => void, stop!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const held = new Promise<void>(resolve => { stop = resolve; });
    vi.spyOn(svc as any, 'createStageContext').mockImplementation(async () => {
      reached(); await held; throw new Error('Synthetic context stop');
    });
    const first = svc.resume(scope, taskId, run.id).catch(error => error);
    await entered;
    try {
      await expect(svc.resume({ ...scope, actorId: randomUUID(), role: 'operator' }, taskId, run.id))
        .rejects.toMatchObject({ code: 'ACTOR_SCOPE_MISMATCH' });
      await expect(svc.resume(scope, randomUUID(), run.id)).rejects.toMatchObject({ code: 'TASK_SCOPE_MISMATCH' });
    } finally { stop(); await first; }
  });

  it("counts a task's unfinished run as still being made, and not once it is abandoned", async () => {
    const taskId = await task();
    const { run } = await service().createOrGetRun(scope, taskId, `key-${randomUUID().slice(0, 16)}`, { width: 1080, height: 1350 });
    const live = service({});
    expect(await (live as any).activeRunsOfTask(scope, taskId)).toBe(1);
    await expect((live as any).refuseWhileParentRuns(scope, taskId)).rejects.toMatchObject({ status: 409, code: 'PARENT_STILL_RUNNING' });
    await live.abandon(scope, taskId, run.id, 'test cleanup');
    expect(await (live as any).activeRunsOfTask(scope, taskId)).toBe(0);
    await expect((live as any).refuseWhileParentRuns(scope, taskId)).resolves.toBeUndefined();
  });

  it('keeps the pictures nearest the request when a busy chat has more than the limit', async () => {
    const channel = `busy-${randomUUID().slice(0, 8)}`;
    const picture = (n: number) => `data:image/png;base64,${Buffer.from(`busy chat picture ${n}`).toString('base64')}`;
    for (let n = 0; n < 42; n++) {
      await persistChatIntake(db, {
        platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: channel, clientId: null,
        title: 'Sewa: reference image (awaiting request)', rawText: 'reference', designInstructions: '', exactCopy: [],
        isInstructionOnly: true, autoGenerate: false, studioOptions: { referenceImageBase64: picture(n) },
      });
    }
    const taskId = (
      await persistChatIntake(db, {
        platform: 'telegram', sourceEventId: randomUUID(), sourceChannelId: channel, clientId,
        title: 'KAAE: busy chat', rawText: 'BUSY CHAT\n---\nSeptember 25, 2026', designInstructions: 'a graphic with these pictures', exactCopy: [],
      })
    ).task.id as string;
    const images: string[] = await (service() as any).requestImages(scope, taskId);
    // Oldest first, the limit kept pictures 0..39 and cut off the two sent just before the request.
    expect(images).toHaveLength(40);
    expect(images).toContain(picture(41));
    expect(images).toContain(picture(40));
    expect(images).not.toContain(picture(0));
    expect(images.at(-1)).toBe(picture(41));
  });
});
