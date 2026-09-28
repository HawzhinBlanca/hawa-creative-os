/** Child process for the isolated Studio model send-boundary drill. */
import { createDb, DesignStudioRepository } from '@hawa/db';
import { parseStudioBudget } from '@hawa/domain';
import { DesignStudioService } from '../../src/services/design-studio/design-studio-service.js';
import type { StageContext } from '../../src/services/design-studio/types.js';

const databaseUrl = process.env.HAWA_STUDIO_DRILL_DATABASE_URL;
const port = Number(process.env.HAWA_STUDIO_DRILL_PORT);
const tenantId = process.env.HAWA_STUDIO_DRILL_TENANT_ID;
const actorId = process.env.HAWA_STUDIO_DRILL_ACTOR_ID;
const taskId = process.env.HAWA_STUDIO_DRILL_TASK_ID;
const runId = process.env.HAWA_STUDIO_DRILL_RUN_ID;
if (!databaseUrl || !Number.isSafeInteger(port) || port < 1 || !tenantId || !actorId || !taskId || !runId) {
  throw new Error('Studio model kill drill needs an isolated database, local port and run scope.');
}

const db = createDb(databaseUrl);
const localProvider: typeof fetch = ((url: Parameters<typeof fetch>[0], init?: RequestInit) =>
  fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`, init)) as typeof fetch;
const service = new DesignStudioService(db, undefined, { apiKey: 'x', fetcher: localProvider });

try {
  // The parent kills this process after its local fake provider has read the HTTP request.
  if (process.env.HAWA_STUDIO_DRILL_KIND === 'art-vision') {
    const repo = new DesignStudioRepository(db), run = await repo.getRunById(runId, tenantId);
    if (!run) throw new Error('Missing art drill run.');
    const budget = parseStudioBudget(run.budget);
    // Enter the real art adapter directly so the drill controls exactly which paid boundary is killed.
    const ctx = await (service as unknown as { createStageContext(s: { tenantId: string; actorId: string; role: string },
      run: unknown, stage: string, budget: ReturnType<typeof parseStudioBudget>, update: (cost: number) => Promise<void>): Promise<StageContext> })
      .createStageContext({ tenantId, actorId, role: 'operator' }, run, 'laying_out', budget, async cost => {
        budget.spentUsd += cost;
        await repo.updateRunStatus(runId, tenantId, 'laying_out', { budget: { ...budget } });
      });
    if (!ctx.artProvider) throw new Error('Missing art provider.');
    await ctx.artProvider.generateArt({ artPrompt: 'Navy texture', palette: ['#1E3A5F'], width: 16, height: 16 });
  } else {
    await service.resume({ tenantId, actorId, role: 'operator' }, taskId, runId);
  }
  throw new Error('Studio call unexpectedly returned before the process kill.');
} finally {
  await db.destroy();
}
