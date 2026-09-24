import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createDb, sql } from '@hawa/db';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';

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
  let exportCreates: number;
  let exportCreateHttp: number;
  /** Refusals Canva answers to POST /exports before exportCreateHttp applies (chaos R1.K9). */
  let exportCreateFaults: number[];
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
      return Response.json({ job: { id: 'import_' + taskId + '_' + importCreates, status: 'in_progress' } });
    }
    if (u.includes('/imports/')) {
      if (importStatusHttp !== 200) return new Response('{}', { status: importStatusHttp });
      return Response.json({ job: { id: u.split('/imports/')[1], status: importStatus, ...(importStatus === 'success' ? { result: { designs: [{ id: designId, urls: { edit_url: 'https://www.canva.com/d/x', view_url: 'https://www.canva.com/d/y' } }] } } : {}) } });
    }
    if (u.endsWith('/exports') && init.method === 'POST') {
      const fault = exportCreateFaults.shift();
      if (fault) return new Response('{"code":"internal_error"}', { status: fault, headers: fault === 429 ? { 'Retry-After': '0' } : {} });
      exportCreates++;
      if (exportCreateHttp !== 200) return new Response('{"code":"too_many_requests"}', { status: exportCreateHttp });
      return Response.json({ job: { id: 'export_' + taskId + '_' + exportCreates, status: 'in_progress' } });
    }
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
    exportCreateHttp = 200;
    exportCreateFaults = [];
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

  it('a 429 from Canva on POST /exports is retryable, not an uncertain export that blocks the format', async () => {
    const binding = await service.importEditableDesign(scope, taskId, 'studio-plan-cccc', source());
    importStatus = 'success';
    await service.resumeImport(scope, taskId, binding.operationId);
    // Canva's rate limit refuses the preview export: an HTTP answer, so no job was created.
    exportCreateHttp = 429;
    const refused = await service.startExport(scope, taskId, 'workflow-preview-hunt', 'png', 1);
    // A minute later the office (or a retry) asks again under a new key.
    exportCreateHttp = 200;
    const again = await service.startExport(scope, taskId, 'desk-capture-hunt', 'png', 1).then((r) => r.status, (e) => String(e?.code));
    expect({ refused: refused.status, again }).toEqual({ refused: 'failed', again: 'submitted' });
  });

  it('a Canva 503 three times and a 429 on POST /exports are asked again: one export job, submitted (chaos R1.K9)', async () => {
    const binding = await service.importEditableDesign(scope, taskId, 'studio-plan-eeee', source());
    importStatus = 'success';
    await service.resumeImport(scope, taskId, binding.operationId);
    exportCreateFaults = [503, 503, 503, 429];
    const preview = await service.startExport(scope, taskId, 'workflow-preview-k9', 'png', 1);
    expect({ status: preview.status, faultsLeft: exportCreateFaults.length, jobsCreated: exportCreates }).toEqual({ status: 'submitted', faultsLeft: 0, jobsCreated: 1 });
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
