/** Child process for the isolated Studio model send-boundary drill. */
import { createDb } from '@hawa/db';
import { DesignStudioService } from '../../src/services/design-studio/design-studio-service.js';

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
const localProvider: typeof fetch = ((_: Parameters<typeof fetch>[0], init?: RequestInit) =>
  fetch(`http://127.0.0.1:${port}/accepted-model-request`, init)) as typeof fetch;
const service = new DesignStudioService(db, undefined, { apiKey: 'x', fetcher: localProvider });

try {
  // The parent kills this process after its local fake provider has read the HTTP request.
  await service.resume({ tenantId, actorId, role: 'operator' }, taskId, runId);
  throw new Error('Studio call unexpectedly returned before the process kill.');
} finally {
  await db.destroy();
}
