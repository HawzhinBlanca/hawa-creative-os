import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createDb, sql, withRlsContext, DesignStudioRepository } from '@hawa/db';
import { renderMotifPng } from '@hawa/creative';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { StudioCallSettlementService } from '../src/services/studio-call-settlement.js';

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

  it.each(['text', 'art-vision'])('does not repeat %s work accepted before Core was killed', async kind => {
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
    if (kind === 'art-vision') await new DesignStudioRepository(db).updateRunStatus(run.id, scope.tenantId, 'laying_out');
    const expectedCalls = kind === 'art-vision' ? 2 : 1;

    let acceptedCount = 0;
    let resolveAccepted!: () => void;
    let rejectAccepted!: (error: Error) => void;
    const accepted = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const provider = createServer((request, response) => {
      void (async () => {
        for await (const _chunk of request) { /* Read all bytes before reporting acceptance. */ }
        acceptedCount++;
        if (kind === 'art-vision' && request.url === '/v1/images/generations') {
          response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'synthetic-image' });
          response.end(JSON.stringify({ model: 'gpt-image-2.5-sunburst',
            data: [{ b64_json: renderMotifPng('gradient-wash', { width: 16, height: 16, palette: ['#1E3A5F'], seed: 1 }).toString('base64') }],
            usage: { input_tokens: 400, output_tokens: 1000, input_tokens_details: { text_tokens: 400 } } }));
          return;
        }
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
        HAWA_STUDIO_DRILL_KIND: kind,
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
      expect(acceptedCount).toBe(expectedCalls);
      child.kill('SIGKILL');
      expect((await exited).signal).toBe('SIGKILL');

      const calls = await withRlsContext(db, scope, (tx) =>
        sql<{ status: string; usd_estimate: string; call_ordinal: number; logical_call_sha256: string; reservation: { usd: number; requestSha256: string } }>`
          SELECT status,usd_estimate,call_ordinal,logical_call_sha256,reservation
          FROM hawa.design_studio_calls WHERE run_id=${run.id}::uuid ORDER BY call_ordinal`.execute(tx));
      expect(calls.rows).toHaveLength(expectedCalls);
      expect(calls.rows.at(-1)).toMatchObject({ status: 'uncertain', call_ordinal: expectedCalls });
      expect(calls.rows.at(-1)?.logical_call_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(calls.rows.at(-1)?.reservation.usd).toBeGreaterThan(0);
      expect(calls.rows.at(-1)?.reservation.requestSha256).toMatch(/^[0-9a-f]{64}$/);
      const durableUsage = await new DesignStudioRepository(db).getBudgetUsage(run.id, scope.tenantId);
      expect(durableUsage?.reservedAdditionalUsd).toBeCloseTo(calls.rows.at(-1)!.reservation.usd, 6);

      if (kind === 'art-vision') {
        expect(calls.rows[0].status).toBe('ok');
        expect(Number(calls.rows[0].usd_estimate)).toBeCloseTo(0.032, 6);
        expect(await new DesignStudioRepository(db).getBudgetUsage(run.id, scope.tenantId))
          .toMatchObject({ admittedCalls: 2, unresolvedCalls: 1, accountedUsd: 0.032 });
      }

      const freshDb = createDb(databaseUrl!);
      try {
        const replayFetch = vi.fn();
        const fresh = new DesignStudioService(freshDb, undefined, { apiKey: 'x', fetcher: replayFetch as typeof fetch, staleRunMinutes: 0 });
        await expect(fresh.resume(scope, taskId, run.id)).rejects.toMatchObject({ code: 'MODEL_CALL_UNCERTAIN' });
        await expect(fresh.createOrGetRun(scope, taskId, `replace-killed-${randomUUID()}`,
          { width: 1080, height: 1350, tier: 'standard' })).rejects.toMatchObject({ code: 'MODEL_CALL_UNCERTAIN' });
        await fresh.abandon(scope, taskId, run.id, 'Interrupted provider request');
        await expect(fresh.createOrGetRun(scope, taskId, `replace-abandoned-${randomUUID()}`,
          { width: 1080, height: 1350, tier: 'standard' })).rejects.toMatchObject({ code: 'MODEL_CALL_UNCERTAIN' });
        const userId=randomUUID(),sessionHash=createHash('sha256').update(randomUUID()).digest('hex');
        await sql`INSERT INTO hawa.users(id,email,display_name,external_subject)
          VALUES(${userId}::uuid,${userId+'@example.test'},'Synthetic recovery administrator',${userId})`.execute(freshDb);
        await sql`INSERT INTO hawa.tenant_memberships(tenant_id,user_id,role)
          VALUES(${scope.tenantId}::uuid,${userId}::uuid,'administrator')`.execute(freshDb);
        await sql`INSERT INTO hawa.desk_sessions(token_hash,tenant_id,user_id,actor_id,role,display_name,expires_at,auth_method)
          VALUES(${sessionHash},${scope.tenantId}::uuid,${userId}::uuid,'oidc:drill','administrator','Synthetic recovery administrator',now()+interval '1 hour','google_oidc')`.execute(freshDb);
        const recoveryScope={tenantId:scope.tenantId,userId,role:'administrator',sessionHash};
        const recovery=new StudioCallSettlementService(freshDb),detail=await recovery.get(recoveryScope,taskId,run.id);
        const evidence={expectedSnapshot:detail.snapshotHash,reason:'Synthetic provider terminal evidence after process kill',calls:detail.calls.filter(c=>c.status==='uncertain').map(c=>({
          callId:c.id,conclusion:'provider_finished',reportedCostUsd:0.125,evidenceReference:'synthetic-provider-terminal',evidenceSha256:'c'.repeat(64)}))};
        const action=randomUUID(),settled=await recovery.settle(recoveryScope,taskId,run.id,action,evidence);
        expect(await new StudioCallSettlementService(freshDb).settle(recoveryScope,taskId,run.id,action,evidence))
          .toMatchObject({replayed:true,settlement:settled.settlement});
        expect((await recovery.get(recoveryScope,taskId,run.id)).calls.find(c=>c.status==='uncertain')).toMatchObject({status:'uncertain',estimatedCostUsd:null});
        const replacement = await fresh.createOrGetRun(scope,taskId,`explicit-after-settlement-${randomUUID()}`,
          {width:1080,height:1350,tier:'standard'});
        expect(replacement).toMatchObject({created:true});
        await fresh.abandon(scope,taskId,replacement.run.id,'Completed synthetic admission drill');
        expect(replayFetch).not.toHaveBeenCalled();
        expect(acceptedCount).toBe(expectedCalls);
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
    const replyContent = JSON.stringify({
      occasion: 'Announcement', audience: 'Public', formality: 4,
      toneWords: ['clear'], readingOrder: [0, 1],
      roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'body', importance: 3 }],
      must: [], mustNot: [], imageryStrategy: 'none', imageryRationale: 'Typography only',
      kurdishLeads: false, riskFlags: [],
    });
    const provider = createServer((request, response) => {
      void (async () => {
        for await (const _chunk of request) { /* Wait for complete request before answering. */ }
        acceptedCount++;
        response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_paid_reply_kill' });
        response.end(JSON.stringify({
          id: 'resp_paid_reply_kill', model: 'gpt-6-astra-snapshot', stop_reason: 'end_turn',
          choices: [{ message: { content: replyContent } }],
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
      type CallRow = {
        status: string; usd_estimate: string; model: string; served_model: string | null;
        response_id: string | null; provider_request_id: string | null;
        response_sha256: string | null; latency_ms: number | null; attempts: number | null;
      };
      let call: CallRow | undefined;
      while (Date.now() < deadline) {
        const rows = await withRlsContext(db, scope, (tx) =>
          sql<CallRow>`
            SELECT status,usd_estimate,model,served_model,response_id,provider_request_id,
              response_sha256,latency_ms,attempts
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
      expect(call).toMatchObject({
        response_id: 'resp_paid_reply_kill',
        served_model: 'gpt-6-astra-snapshot',
        provider_request_id: 'req_paid_reply_kill',
        response_sha256: createHash('sha256').update(replyContent).digest('hex'),
        attempts: 1,
      });
      expect(call?.latency_ms).toBeGreaterThanOrEqual(0);
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
