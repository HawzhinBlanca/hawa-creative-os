import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

const databaseUrl = process.env.HAWA_ISOLATED_TEST_DB;
if (databaseUrl && !/^\/hawa_(repair|tr_)/.test(new URL(databaseUrl).pathname)) {
  throw new Error('Studio kill drill requires an isolated test database.');
}

describe.skipIf(!databaseUrl)('Studio paid-call process-kill recovery', () => {
  const db = createDb(databaseUrl || 'postgres://localhost/hawa_repair');
  const scope = {
    tenantId: '00000000-0000-4000-a000-000000000001',
    actorId: '00000000-0000-4000-b000-000000000001',
  };
  const clientId = 'c1000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    await sql`INSERT INTO hawa.users(id,email,display_name)
      VALUES(${scope.actorId}::uuid,'studio-kill-drill@example.test','Studio Kill Drill')
      ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name)
      VALUES(${clientId}::uuid,${scope.tenantId}::uuid,'kaae','KAAE')
      ON CONFLICT DO NOTHING`.execute(db);
  });
  afterAll(async () => { await db.destroy(); });

  it('does not repeat a call accepted by a fake provider before Core was killed', async () => {
    const intake = await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(),
      sourceChannelId: `studio-kill-${randomUUID().slice(0, 8)}`,
      clientId, title: '[TEST] Studio paid-call kill drill',
      rawText: 'Keep the exact title.\n---\nEXACT TITLE\n\nExact body.',
      designInstructions: 'Keep the exact title.', exactCopy: [],
    });
    const taskId = intake.task.id;
    const service = new DesignStudioService(db, undefined, { apiKey: 'x' });
    const { run } = await service.createOrGetRun(scope, taskId, `studio-kill-${randomUUID()}`,
      { width: 1080, height: 1350, tier: 'standard' });

    let acceptedCount = 0;
    let resolveAccepted!: () => void;
    let rejectAccepted!: (error: Error) => void;
    const accepted = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const provider = createServer((request, _response) => {
      void (async () => {
        for await (const _chunk of request) { /* Read all bytes before reporting acceptance. */ }
        acceptedCount++;
        resolveAccepted();
        // Deliberately withhold the response until after the caller has been killed.
      })().catch((error) => rejectAccepted(error as Error));
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Fake model endpoint has no port.');

    const childFile = fileURLToPath(new URL('./fixtures/studio-model-kill-child.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', childFile], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HAWA_STUDIO_DRILL_DATABASE_URL: databaseUrl!,
        HAWA_STUDIO_DRILL_PORT: String(address.port),
        HAWA_STUDIO_DRILL_TENANT_ID: scope.tenantId,
        HAWA_STUDIO_DRILL_ACTOR_ID: scope.actorId,
        HAWA_STUDIO_DRILL_TASK_ID: taskId,
        HAWA_STUDIO_DRILL_RUN_ID: run.id,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let childError = '';
    child.stderr.on('data', (chunk) => { childError += String(chunk).slice(0, 2000); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error('Child did not reach the fake model endpoint.')), 20_000);
      timeoutTimer.unref();
    });

    try {
      await Promise.race([
        accepted,
        exited.then(({ code, signal }) => { throw new Error(`Studio child exited ${code}/${signal}: ${childError}`); }),
        timeout,
      ]);
      expect(acceptedCount).toBe(1);
      child.kill('SIGKILL');
      expect((await exited).signal).toBe('SIGKILL');

      const calls = await withRlsContext(db, scope, (tx) =>
        sql<{ status: string; usd_estimate: string; call_ordinal: number; logical_call_sha256: string }>`
          SELECT status,usd_estimate,call_ordinal,logical_call_sha256
          FROM hawa.design_studio_calls WHERE run_id=${run.id}::uuid`.execute(tx));
      expect(calls.rows).toHaveLength(1);
      expect(calls.rows[0]).toMatchObject({ status: 'uncertain', call_ordinal: 1 });
      expect(calls.rows[0].logical_call_sha256).toMatch(/^[0-9a-f]{64}$/);

      const freshDb = createDb(databaseUrl!);
      try {
        const replayFetch = vi.fn();
        const fresh = new DesignStudioService(freshDb, undefined, { apiKey: 'x', fetcher: replayFetch as typeof fetch });
        await expect(fresh.resume(scope, taskId, run.id)).rejects.toMatchObject({ code: 'MODEL_CALL_UNCERTAIN' });
        expect(replayFetch).not.toHaveBeenCalled();
        expect(acceptedCount).toBe(1);
      } finally {
        await freshDb.destroy();
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }, 30_000);

  it('does not repeat a recorded paid reply when Core dies before the stage advances', async () => {
    const intake = await persistChatIntake(db, {
      platform: 'telegram', sourceEventId: randomUUID(),
      sourceChannelId: `studio-reply-kill-${randomUUID().slice(0, 8)}`,
      clientId, title: '[TEST] Studio reply kill drill',
      rawText: 'Keep the exact title.\n---\nEXACT TITLE\n\nExact body.',
      designInstructions: 'Keep the exact title.', exactCopy: [],
    });
    const taskId = intake.task.id;
    const service = new DesignStudioService(db, undefined, { apiKey: 'x' });
    const { run } = await service.createOrGetRun(scope, taskId, `studio-reply-kill-${randomUUID()}`,
      { width: 1080, height: 1350, tier: 'standard' });

    let unlockRun!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const releaseLock = new Promise<void>((resolve) => { unlockRun = resolve; });
    const lockTask = withRlsContext(db, scope, async (tx) => {
      // The weaker row lock permits the call's FK check while holding the later budget write.
      await sql`SELECT id FROM hawa.design_studio_runs WHERE id=${run.id}::uuid FOR NO KEY UPDATE`.execute(tx);
      signalLocked();
      await releaseLock;
    });
    await locked;

    let acceptedCount = 0;
    const provider = createServer((request, response) => {
      void (async () => {
        for await (const _chunk of request) { /* Wait for complete request before answering. */ }
        acceptedCount++;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: 'resp_paid_reply_kill', model: 'gpt-6-astra', stop_reason: 'end_turn',
          choices: [{ message: { content: JSON.stringify({
            occasion: 'Announcement', audience: 'Public', formality: 4,
            toneWords: ['clear'], readingOrder: [0, 1],
            roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'body', importance: 3 }],
            must: [], mustNot: [], imageryStrategy: 'none', imageryRationale: 'Typography only',
            kurdishLeads: false, riskFlags: [],
          }) } }],
          usage: { prompt_tokens: 500, completion_tokens: 300, input_tokens: 500, output_tokens: 300 },
        }));
      })().catch(() => response.destroy());
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Fake model endpoint has no port.');

    const childFile = fileURLToPath(new URL('./fixtures/studio-model-kill-child.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', childFile], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HAWA_STUDIO_DRILL_DATABASE_URL: databaseUrl!,
        HAWA_STUDIO_DRILL_PORT: String(address.port),
        HAWA_STUDIO_DRILL_TENANT_ID: scope.tenantId,
        HAWA_STUDIO_DRILL_ACTOR_ID: scope.actorId,
        HAWA_STUDIO_DRILL_TASK_ID: taskId,
        HAWA_STUDIO_DRILL_RUN_ID: run.id,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let childError = '';
    child.stderr.on('data', (chunk) => { childError += String(chunk).slice(0, 2000); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    try {
      const deadline = Date.now() + 20_000;
      let call: { status: string; usd_estimate: string } | undefined;
      while (Date.now() < deadline) {
        const rows = await withRlsContext(db, scope, (tx) =>
          sql<{ status: string; usd_estimate: string }>`SELECT status,usd_estimate
            FROM hawa.design_studio_calls WHERE run_id=${run.id}::uuid`.execute(tx));
        call = rows.rows[0];
        if (call?.status === 'ok') break;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Studio child exited before paid reply was recorded: ${childError}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(call?.status).toBe('ok');
      expect(Number(call?.usd_estimate)).toBeGreaterThan(0);
      expect(acceptedCount).toBe(1);
      child.kill('SIGKILL');
      expect((await exited).signal).toBe('SIGKILL');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      unlockRun();
      await lockTask;
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }

    const freshDb = createDb(databaseUrl!);
    try {
      const replayFetch = vi.fn();
      const fresh = new DesignStudioService(freshDb, undefined, { apiKey: 'x', fetcher: replayFetch as typeof fetch });
      await expect(fresh.resume(scope, taskId, run.id)).rejects.toMatchObject({ code: 'MODEL_STAGE_REPLAY_UNSAFE' });
      expect(replayFetch).not.toHaveBeenCalled();
      expect(acceptedCount).toBe(1);
    } finally {
      await freshDb.destroy();
    }
  }, 30_000);
});
