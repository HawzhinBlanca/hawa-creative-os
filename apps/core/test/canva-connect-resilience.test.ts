import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { CanvaConnectService, canvaRateLimitWaitMs } from '../src/services/canva-connect-service.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && !/^\/hawa_(repair|tr_)/.test(new URL(url).pathname)) throw new Error('Disposable hawa_repair database (or a per-file copy of it) required');
const key = 'c3'.repeat(32);

/**
 * Bug hunt 2026-09-24: how the Canva service behaves when Canva has a bad few seconds. Mocked
 * provider transport, isolated PostgreSQL; no real Canva call.
 */
describe.skipIf(!url)('HUNT: Canva Connect under transient provider failures', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenant = '00000000-0000-4000-a000-000000000001';
  const actor = '00000000-0000-4000-b000-000000000001';
  const clientId = randomUUID();
  const scope = { tenantId: tenant, actorId: actor };
  let taskId: string;
  let designId: string;
  let importStatus: 'in_progress' | 'success' | 'failed';
  let importStatusHttp: number;
  let tokenHttp: number;
  let tokenBody: string;
  let refreshDelayMs: number;
  let importCreates: number;
  let refreshCalls: number;
  /** Export jobs Canva made (POSTs it accepted). */
  let exportCreates: number;
  /** Every POST /exports, accepted or refused. */
  let exportPosts: number;
  let exportCreateHttp: number;
  /** Retry-After Canva sends with a refused POST /imports or /exports; null sends none. */
  let createRetryAfter: string | null;
  /** POST /imports loses its connection after it was sent (Canva may have made the design). */
  let importConnectionLost: boolean;
  /** Refusals Canva answers to POST /exports before exportCreateHttp applies (chaos R1.K9). */
  let exportCreateFaults: number[];
  /** What Canva answers POST /imports with; 200 creates the import job. */
  let importCreateHttp: number;
  let service: CanvaConnectService;
  const remote = vi.fn(async (input: any, init: any = {}) => {
    const u = String(input);
    if (u.endsWith('/oauth/token')) {
      const body = new URLSearchParams(init.body);
      if (body.get('grant_type') === 'refresh_token') {
        refreshCalls++;
        await new Promise((r) => setTimeout(r, refreshDelayMs));
        if (tokenHttp !== 200) return new Response(tokenBody, { status: tokenHttp });
      }
      return Response.json({ access_token: 'token-' + randomUUID(), refresh_token: 'refresh-' + randomUUID(), expires_in: 3600 });
    }
    if (u.endsWith('/imports') && init.method === 'POST') {
      importCreates++;
      if (importConnectionLost) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      if (importCreateHttp !== 200) {
        return new Response('{"code":"internal_error"}', { status: importCreateHttp, headers: createRetryAfter === null ? {} : { 'Retry-After': createRetryAfter } });
      }
      return Response.json({ job: { id: 'import_' + taskId + '_' + importCreates, status: 'in_progress' } });
    }
    if (u.includes('/imports/')) {
      if (importStatusHttp !== 200) return new Response('{}', { status: importStatusHttp });
      return Response.json({ job: { id: u.split('/imports/')[1], status: importStatus, ...(importStatus === 'success' ? { result: { designs: [{ id: designId, urls: { edit_url: 'https://www.canva.com/d/x', view_url: 'https://www.canva.com/d/y' } }] } } : {}) } });
    }
    if (u.endsWith('/exports') && init.method === 'POST') {
      exportPosts++;
      const fault = exportCreateFaults.shift();
      if (fault) return new Response('{"code":"internal_error"}', { status: fault, headers: fault === 429 ? { 'Retry-After': '0' } : {} });
      if (exportCreateHttp !== 200) {
        return new Response('{"code":"too_many_requests"}', { status: exportCreateHttp, headers: createRetryAfter === null ? {} : { 'Retry-After': createRetryAfter } });
      }
      exportCreates++;
      return Response.json({ job: { id: 'export_' + taskId + '_' + exportCreates, status: 'in_progress' } });
    }
    if (u.includes('/exports/')) return Response.json({ job: { id: u.split('/exports/')[1], status: 'in_progress' } });
    if (u.includes('/designs/')) {
      return Response.json({ design: { id: designId, created_at: 100, updated_at: 200, page_count: 1, urls: { edit_url: 'https://www.canva.com/api/design/x/edit', view_url: 'https://www.canva.com/d/y' } } });
    }
    throw new Error('Unexpected provider path ' + u);
  }) as typeof fetch;
  const options = { clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'http://localhost:8772/v1/integrations/canva/callback', encryptionKey: key, fetcher: remote,
    retryDelaysMs: { read: [1, 1], create: [1, 1, 1, 1] } };
  const source = () => {
    const bytes = Buffer.from('Hunt-only editable PPTX source bytes, long enough for the transport check.');
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), manifest: { copy: ['Exact hunt copy'] } };
  };
  const expireToken = () => sql`UPDATE hawa.canva_connections SET expires_at = now() - interval '1 second' WHERE tenant_id = ${tenant}::uuid AND actor_id = ${actor}`.execute(db);

  beforeAll(async () => {
    await sql`INSERT INTO hawa.tenants(id,name,slug) VALUES (${tenant}::uuid,'Canva isolated fixture','canva-test') ON CONFLICT DO NOTHING`.execute(db);
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES (${clientId}::uuid,${tenant}::uuid,${clientId},'Hunt client')`.execute(db);
  });
  beforeEach(async () => {
    taskId = randomUUID();
    designId = 'DA' + randomUUID().replaceAll('-', '');
    importStatus = 'in_progress';
    importStatusHttp = 200;
    tokenHttp = 200;
    tokenBody = '{"error":"temporarily_unavailable"}';
    refreshDelayMs = 0;
    importCreates = 0;
    refreshCalls = 0;
    exportCreates = 0;
    exportPosts = 0;
    exportCreateHttp = 200;
    createRetryAfter = null;
    importConnectionLost = false;
    exportCreateFaults = [];
    importCreateHttp = 200;
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES (${taskId}::uuid,${tenant}::uuid,${clientId}::uuid,'Hunt Canva task')`.execute(db);
    service = new CanvaConnectService(db, options);
    const auth = await service.startAuthorization(scope);
    await service.finishAuthorization(auth.state, auth.state, 'test-code');
  });
  afterAll(() => db.destroy());

  it('a Canva 503 while polling an import leaves it resumable, and the retry does not import a second design', async () => {
    // The studio's transfer stage: import under its plan key, then poll.
    const first = await service.importEditableDesign(scope, taskId, 'studio-plan-aaaa', source());
    expect(first.status).toBe('submitted');
    // Canva answers the status read with 503 for a few seconds (readWithRetry: 3 tries over 4 s).
    importStatusHttp = 503;
    const polled = await service.resumeImport(scope, taskId, first.operationId);

    // Canva recovers and finishes the import. The studio run re-runs its transfer stage with a
    // fresh plan id, as design-studio-service does ('studio-' + randomUUID()).
    importStatusHttp = 200;
    importStatus = 'success';
    await service.importEditableDesign(scope, taskId, 'studio-plan-bbbb', source()).catch(() => undefined);
    // The import may well finish at Canva: a failed status read is not a failed import, and the
    // retry must find the first import rather than send the deck to Canva again.
    expect({ afterStatus503: polled.status, importsSentToCanva: importCreates }).toEqual({ afterStatus503: 'submitted', importsSentToCanva: 1 });
  }, 20000);

  it('a Canva 503 on the token endpoint does not demand a manual reconnect', async () => {
    await expireToken();
    tokenHttp = 503;
    await expect(service.authorizedClient(scope)).rejects.toThrow();
    // Canva is back a minute later; the refresh token was never consumed (Canva answered 503).
    tokenHttp = 200;
    await expireToken();
    await expect(service.authorizedClient(scope)).resolves.toBeDefined();
  });

  it('an art director can follow the import another actor made, read with the connection that made it', async () => {
    const first = await service.importEditableDesign(scope, taskId, 'studio-plan-dddd', source());
    importStatus = 'success';
    // Another person, with no Canva connection of their own. The override checked the role 'admin',
    // which no principal has, and read with the caller's connection (2026-09-24).
    const other = { tenantId: tenant, actorId: '00000000-0000-4000-b000-0000000000ad', role: 'art_director' };
    const done = await service.resumeImport(other, taskId, first.operationId);
    expect({ status: done.status, designId: done.designId }).toEqual({ status: 'retrieved', designId });
    await expect(service.resumeImport({ ...other, role: 'designer' }, taskId, first.operationId)).rejects.toMatchObject({ code: 'CANVA_IMPORT_NOT_FOUND' });
  });

  it('a refused grant (invalid_grant) still demands a reconnect: the refresh token is no good', async () => {
    await expireToken();
    tokenHttp = 400;
    tokenBody = '{"error":"invalid_grant"}';
    await expect(service.authorizedClient(scope)).rejects.toMatchObject({ code: 'CANVA_RECONNECT_REQUIRED' });
    tokenHttp = 200;
    await expect(service.authorizedClient(scope)).rejects.toMatchObject({ code: 'CANVA_RECONNECT_REQUIRED' });
    expect((await service.status(scope)).status).toBe('reconnect_required');
  });

  it('a 429 from Canva on POST /exports is a named wait, not an uncertain export that blocks the format', async () => {
    const binding = await service.importEditableDesign(scope, taskId, 'studio-plan-cccc', source());
    importStatus = 'success';
    await service.resumeImport(scope, taskId, binding.operationId);
    // Canva's rate limit refuses the preview export on every one of the client's tries: an HTTP
    // answer, so no job was created.
    exportCreateHttp = 429;
    const refused = await service.startExport(scope, taskId, 'workflow-preview-hunt', 'png', 1).then(() => null, (e) => e);
    expect({ status: refused?.status, code: refused?.code, retryAfterMs: refused?.retryAfterMs }).toEqual({ status: 429, code: 'CANVA_RATE_LIMITED', retryAfterMs: 30000 });
    // A minute later the office asks again under a new key: the refusal holds nothing pending.
    exportCreateHttp = 200;
    const again = await service.startExport(scope, taskId, 'desk-capture-hunt', 'png', 1).then((r) => r.status, (e) => String(e?.code));
    expect(again).toBe('submitted');
  });

  it('an export Canva refused with 429 is sent again under the same key once Canva accepts: one operation, one job', async () => {
    const binding = await service.importEditableDesign(scope, taskId, 'studio-plan-rl01', source());
    importStatus = 'success';
    await service.resumeImport(scope, taskId, binding.operationId);
    exportCreateHttp = 429;
    createRetryAfter = '45';
    const refused = await service.startExport(scope, taskId, 'workflow-preview-rl01', 'png', 1).then(() => null, (e) => e);
    // Canva asked for longer than the client waits: one POST, and Core names a bounded wait.
    expect({ code: refused?.code, retryAfterMs: refused?.retryAfterMs, posts: exportPosts }).toEqual({ code: 'CANVA_RATE_LIMITED', retryAfterMs: 30000, posts: 1 });

    exportCreateHttp = 200;
    const retried = await service.startExport(scope, taskId, 'workflow-preview-rl01', 'png', 1);
    const repeated = await service.startExport(scope, taskId, 'workflow-preview-rl01', 'png', 1);
    const rows = (await sql<{ id: string; status: string; request_key: string }>`SELECT id, status, request_key FROM hawa.canva_remote_operations
      WHERE task_id=${taskId}::uuid AND kind='export'`.execute(db)).rows;
    expect({ retried: retried.status, sameOperation: retried.operationId === repeated.operationId, jobsCreated: exportCreates, rows: rows.map((r) => [r.request_key, r.status]) })
      .toEqual({ retried: 'submitted', sameOperation: true, jobsCreated: 1, rows: [['workflow-preview-rl01', 'submitted']] });
  });

  it('an export refused for another reason stays final under the same key', async () => {
    const binding = await service.importEditableDesign(scope, taskId, 'studio-plan-rl02', source());
    importStatus = 'success';
    await service.resumeImport(scope, taskId, binding.operationId);
    exportCreateHttp = 400;
    createRetryAfter = '5';
    const refused = await service.startExport(scope, taskId, 'workflow-preview-rl02', 'png', 1);
    exportCreateHttp = 200;
    const again = await service.startExport(scope, taskId, 'workflow-preview-rl02', 'png', 1);
    expect({ refused: refused.status, again: again.status, posts: exportPosts, jobsCreated: exportCreates }).toEqual({ refused: 'failed', again: 'failed', posts: 1, jobsCreated: 0 });
  });

  it('a Canva 503 three times and a 429 on POST /exports are asked again: one export job, submitted (chaos R1.K9)', async () => {
    const binding = await service.importEditableDesign(scope, taskId, 'studio-plan-eeee', source());
    importStatus = 'success';
    await service.resumeImport(scope, taskId, binding.operationId);
    exportCreateFaults = [503, 503, 503, 429];
    const preview = await service.startExport(scope, taskId, 'workflow-preview-k9', 'png', 1);
    expect({ status: preview.status, faultsLeft: exportCreateFaults.length, jobsCreated: exportCreates }).toEqual({ status: 'submitted', faultsLeft: 0, jobsCreated: 1 });
  });

  it('a Canva 5xx on POST /imports leaves the import uncertain: a gateway may answer after Canva made the design', async () => {
    importCreateHttp = 502;
    const first = await service.importEditableDesign(scope, taskId, 'studio-plan-ffff', source());
    // The client does not repeat a 5xx on an import (a duplicate is a second design in the owner's
    // account), so the service must not tell the operator that nothing was created either.
    importCreateHttp = 200;
    const again = await service.importEditableDesign(scope, taskId, 'studio-plan-gggg', source()).then((r) => r.status, (e) => String(e?.code));
    expect({ first: first.status, again, importsSentToCanva: importCreates }).toEqual({ first: 'uncertain', again: 'CANVA_CREATE_CONFLICT', importsSentToCanva: 1 });
  });

  it('a Canva 4xx on POST /imports is a refusal: nothing was created, and it may be sent again', async () => {
    importCreateHttp = 400;
    const first = await service.importEditableDesign(scope, taskId, 'studio-plan-hhhh', source());
    importCreateHttp = 200;
    const again = await service.importEditableDesign(scope, taskId, 'studio-plan-iiii', source());
    expect({ first: first.status, again: again.status, importsSentToCanva: importCreates }).toEqual({ first: 'failed', again: 'submitted', importsSentToCanva: 2 });
  });

  it('an import Canva refused with 429 is a named wait, and the same key sends it again once Canva accepts: one design', async () => {
    importCreateHttp = 429;
    createRetryAfter = '120';
    const refused = await service.importEditableDesign(scope, taskId, 'plan-rate-aaaa', source()).then(() => null, (e) => e);
    // Canva asked for two minutes, longer than the client waits: one POST, and Core names its bound.
    expect({ status: refused?.status, code: refused?.code, retryAfterMs: refused?.retryAfterMs, posts: importCreates })
      .toEqual({ status: 429, code: 'CANVA_RATE_LIMITED', retryAfterMs: 30000, posts: 1 });
    const [held] = (await sql<{ status: string; metadata: Record<string, unknown> }>`SELECT status, metadata FROM hawa.canva_remote_operations WHERE task_id=${taskId}::uuid`.execute(db)).rows;
    expect({ status: held.status, method: held.metadata.method, rateLimited: held.metadata.rateLimited }).toEqual({ status: 'failed', method: 'pptx_import', rateLimited: true });

    importCreateHttp = 200;
    const retried = await service.importEditableDesign(scope, taskId, 'plan-rate-aaaa', source());
    const followed = await service.importEditableDesign(scope, taskId, 'plan-rate-aaaa', source());
    const rows = (await sql<{ status: string; request_key: string; remote_job_id: string | null }>`SELECT status, request_key, remote_job_id FROM hawa.canva_remote_operations WHERE task_id=${taskId}::uuid`.execute(db)).rows;
    expect({ retried: retried.status, followed: followed.status, sameOperation: retried.operationId === followed.operationId, importsSentToCanva: importCreates, rows: rows.map((r) => [r.request_key, r.status, Boolean(r.remote_job_id)]) })
      .toEqual({ retried: 'submitted', followed: 'submitted', sameOperation: true, importsSentToCanva: 2, rows: [['plan-rate-aaaa', 'submitted', true]] });
  });

  it('two retries of a rate-limited import at once send it to Canva once', async () => {
    importCreateHttp = 429;
    createRetryAfter = '120';
    await service.importEditableDesign(scope, taskId, 'plan-rate-bbbb', source()).catch(() => undefined);
    importCreateHttp = 200;
    await Promise.all([
      service.importEditableDesign(scope, taskId, 'plan-rate-bbbb', source()),
      new CanvaConnectService(db, options).importEditableDesign(scope, taskId, 'plan-rate-bbbb', source()),
    ]);
    expect(importCreates).toBe(2);
  });

  it('an import whose outcome is unknown (5xx or a lost connection) is never sent again under the same key', async () => {
    importCreateHttp = 502;
    const gateway = await service.importEditableDesign(scope, taskId, 'plan-unknown-01', source());
    importCreateHttp = 200;
    const gatewayAgain = await service.importEditableDesign(scope, taskId, 'plan-unknown-01', source());
    expect({ first: gateway.status, again: gatewayAgain.status, importsSentToCanva: importCreates }).toEqual({ first: 'uncertain', again: 'uncertain', importsSentToCanva: 1 });

    const otherTask = randomUUID();
    await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title) VALUES (${otherTask}::uuid,${tenant}::uuid,${clientId}::uuid,'Hunt Canva task, lost connection')`.execute(db);
    importConnectionLost = true;
    const lost = await service.importEditableDesign(scope, otherTask, 'plan-unknown-02', source());
    importConnectionLost = false;
    const lostAgain = await service.importEditableDesign(scope, otherTask, 'plan-unknown-02', source());
    expect({ first: lost.status, again: lostAgain.status, importsSentToCanva: importCreates }).toEqual({ first: 'uncertain', again: 'uncertain', importsSentToCanva: 2 });
  });

  it('an import refused for another reason stays final under the same key', async () => {
    importCreateHttp = 403;
    createRetryAfter = '5';
    const refused = await service.importEditableDesign(scope, taskId, 'plan-refused-01', source());
    importCreateHttp = 200;
    const again = await service.importEditableDesign(scope, taskId, 'plan-refused-01', source());
    expect({ refused: refused.status, again: again.status, importsSentToCanva: importCreates }).toEqual({ refused: 'failed', again: 'failed', importsSentToCanva: 1 });
  });

  it('a second Canva call during a token refresh is served, not refused as CANVA_RECONNECT_REQUIRED', async () => {
    await expireToken();
    refreshDelayMs = 300;
    const first = service.authorizedClient(scope);
    await new Promise((r) => setTimeout(r, 100));
    // Another task's export poll (the worker runs two studio designs at once) arrives mid-refresh.
    const second = new CanvaConnectService(db, options).authorizedClient(scope);
    const results = await Promise.allSettled([first, second]);
    expect(results.map((r) => r.status === 'fulfilled' ? 'ok' : String((r as PromiseRejectedResult).reason?.code))).toEqual(['ok', 'ok']);
    expect(refreshCalls).toBe(1);
  });
});

describe('the wait Core names when Canva is still refusing with 429', () => {
  it('is Canva\'s own Retry-After, bounded to 1 to 30 seconds; 30 s when Canva named none', () => {
    expect([canvaRateLimitWaitMs(7000), canvaRateLimitWaitMs(120000), canvaRateLimitWaitMs(0), canvaRateLimitWaitMs(undefined)]).toEqual([7000, 30000, 1000, 30000]);
  });
});
