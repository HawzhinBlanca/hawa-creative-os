import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';

const url = process.env.HAWA_ISOLATED_TEST_DB;
if (url && new URL(url).pathname !== '/hawa_repair') throw new Error('Disposable hawa_repair database required');

/**
 * 2026-09-24: the office's own recovery after an automatic check timed out. The draft's revision
 * carries a failed QC run; the art director presses "Check copy & fonts" in the Desk. That export
 * failed SOURCE_REQUIRED (the source belonged to the worker's actor), and a check retrieved there
 * was never recorded as QC, so approval stayed blocked. After "Request Revision" nothing recorded
 * the changed design as a revision either, so the task could never be approved again.
 * Mocked Canva transport, isolated PostgreSQL.
 */
describe.skipIf(!url)('the Desk check of a studio design the worker imported', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const worker = { tenantId, actorId: '00000000-0000-4000-b000-000000000001' };
  const artDirector = { tenantId, actorId: '00000000-0000-4000-b000-000000000002' };
  const kaae = 'c1000000-0000-4000-8000-000000000002';
  let designId = '';
  let pptx = Buffer.alloc(0);
  const remote = vi.fn(async (input: any, init: any = {}) => {
    const u = String(input);
    if (u.endsWith('/oauth/token')) return Response.json({ access_token: 'token-' + randomUUID(), refresh_token: 'refresh-' + randomUUID(), expires_in: 3600 });
    if (u.endsWith('/imports') && init.method === 'POST') return Response.json({ job: { id: 'import_' + designId, status: 'in_progress' } });
    if (u.includes('/imports/')) return Response.json({ job: { id: 'import_' + designId, status: 'success', result: { designs: [{ id: designId, urls: { edit_url: 'https://www.canva.com/d/x', view_url: 'https://www.canva.com/d/y' } }] } } });
    if (u.includes('/designs/')) return Response.json({ design: { id: designId, created_at: 100, updated_at: 200, page_count: 1, urls: { edit_url: 'https://www.canva.com/api/design/x/edit', view_url: 'https://www.canva.com/d/y' } } });
    if (u.endsWith('/exports') && init.method === 'POST') return Response.json({ job: { id: 'export_' + designId, status: 'in_progress' } });
    if (u.includes('/exports/')) return Response.json({ job: { id: 'export_' + designId, status: 'success', urls: ['https://export-download.canva.com/check.pptx'] } });
    if (u.startsWith('https://export-download.canva.com/')) return new Response(new Uint8Array(pptx));
    throw new Error('Unexpected provider path ' + u);
  }) as typeof fetch;
  const canvaOptions = { clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'http://localhost:8772/v1/integrations/canva/callback', encryptionKey: 'd4'.repeat(32), fetcher: remote };
  const operatorHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer test_bearer' };
  const deskHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer test_art_director_bearer' };
  afterAll(() => db.destroy());

  const qcRuns = (taskId: string) => withRlsContext(db, { tenantId, userId: worker.actorId, role: 'operator' }, async (trx) =>
    (await sql<any>`SELECT design_revision_id, attempt, status, report->>'exportSha256' AS export_sha FROM hawa.qc_runs WHERE task_id = ${taskId}::uuid ORDER BY started_at`.execute(trx)).rows);
  const deck = async (fontFamily: string) => {
    const { encodeEditableTransfer } = await import('@hawa/creative');
    return encodeEditableTransfer({ width: 640, height: 640, background: '#FFFFFF', shapes: [],
      text: [{ copyIndex: 0, x: 20, y: 20, width: 600, height: 100, fontSize: 24, fontFamily, color: '#000000', align: 'left' }] }, ['Exact copy']);
  };

  /** A studio design the worker imported, whose automatic check ran out of polls: its revision has a failed QC run. */
  const draftWithTimedOutCheck = async () => {
    const taskId = randomUUID();
    designId = 'DA' + randomUUID().replaceAll('-', '');
    await withRlsContext(db, { tenantId, userId: worker.actorId, role: 'operator' }, (trx) =>
      sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${tenantId}::uuid, ${kaae}::uuid, 'Desk check capture', 'x', 'received', 3, 1, now(), now())`.execute(trx));
    const service = new CanvaConnectService(db, canvaOptions);
    for (const who of [worker, artDirector]) {
      const auth = await service.startAuthorization(who);
      await service.finishAuthorization(auth.state, auth.state, 'test-code');
    }
    // The studio's transfer, as the worker's identity.
    const source = await deck('Verdana');
    const manifest = { ...source.manifest, reference: { rules: { fontFamily: 'Verdana' } } };
    const imported = await service.importEditableDesign(worker, taskId, 'studio-' + randomUUID(), { ...source, manifest });
    expect(imported.status).toBe('retrieved');
    pptx = source.bytes;
    const app = createApp({
      db,
      canvaOptions,
      telegramBridge: { dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }), dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }) },
    } as any);
    expect((await app.request(`/tasks/${taskId}/notifications/canva-status`, {
      method: 'POST', headers: operatorHeaders, body: JSON.stringify({ status: 'CANVA_CHECK_REQUIRED', designId, notifyRequester: false }),
    })).status).toBe(200);
    return { taskId, app };
  };
  /** The art director's "Check copy & fonts" in the Desk: a PPTX export, then its retrieval. */
  const deskCheck = async (app: any, taskId: string) => {
    const started = await app.request(`/tasks/${taskId}/canva/exports`, {
      method: 'POST', headers: { ...deskHeaders, 'Idempotency-Key': 'desk-check-' + randomUUID().slice(0, 8) }, body: JSON.stringify({ format: 'pptx', expectedVersion: 1 }),
    });
    const startedBody = await started.json();
    expect({ http: started.status, status: startedBody.status }).toEqual({ http: 202, status: 'submitted' });
    return (await app.request(`/tasks/${taskId}/canva/exports/${startedBody.operationId}/resume`, { method: 'POST', headers: deskHeaders })).json();
  };
  const decide = (app: any, taskId: string, revisionId: string, decision: string) =>
    app.request(`/tasks/${taskId}/revisions/${revisionId}/decisions`, {
      method: 'POST', headers: deskHeaders,
      body: JSON.stringify({ decision, ...(decision === 'revision_requested' ? { revisionRequest: { comment: 'Make the title larger' } } : {}) }),
    });

  it('exports the worker-made source, and the retrieved check becomes the revision\'s latest QC run', async () => {
    const { taskId, app } = await draftWithTimedOutCheck();
    const resumed = await deskCheck(app, taskId);
    expect(resumed.status).toBe('retrieved');
    expect(resumed.artifact.content_check).toMatchObject({ copyPass: true, fontPass: true });

    const runs = await qcRuns(taskId);
    expect(runs.map((r: any) => ({ attempt: r.attempt, status: r.status, fromCapture: r.export_sha === resumed.artifact.sha256 })))
      .toEqual([{ attempt: 1, status: 'failed', fromCapture: false }, { attempt: 2, status: 'passed', fromCapture: true }]);
  });

  it('after "Request Revision", a checked capture of the changed design is the new revision, and it can be approved', async () => {
    const { taskId, app } = await draftWithTimedOutCheck();
    const first = (await (await app.request(`/tasks/${taskId}`, { headers: deskHeaders })).json()).latestRevisionId;
    expect((await decide(app, taskId, first, 'revision_requested')).status).toBe(201);

    // The designer changes it in Canva; the art director checks it again.
    const resumed = await deskCheck(app, taskId);
    expect(resumed.artifact.content_check).toMatchObject({ copyPass: true, fontPass: true });
    const detail = await (await app.request(`/tasks/${taskId}`, { headers: deskHeaders })).json();
    expect(detail.latestRevisionId).not.toBe(first);
    const runs = await qcRuns(taskId);
    expect(runs.at(-1)).toMatchObject({ design_revision_id: detail.latestRevisionId, attempt: 1, status: 'passed', export_sha: resumed.artifact.sha256 });

    // The changed revision is still refused; the new one is approved.
    expect((await decide(app, taskId, first, 'approved')).status).toBe(409);
    const approved = await decide(app, taskId, detail.latestRevisionId, 'approved');
    expect(approved.status).toBe(201);
  });

  it('after "Request Revision", a capture whose check fails is recorded as the new revision but cannot be approved', async () => {
    const { taskId, app } = await draftWithTimedOutCheck();
    const first = (await (await app.request(`/tasks/${taskId}`, { headers: deskHeaders })).json()).latestRevisionId;
    expect((await decide(app, taskId, first, 'revision_requested')).status).toBe(201);

    // The changed design lost the brand face.
    pptx = (await deck('Arial')).bytes;
    const resumed = await deskCheck(app, taskId);
    expect(resumed.artifact.content_check).toMatchObject({ fontPass: false });
    const detail = await (await app.request(`/tasks/${taskId}`, { headers: deskHeaders })).json();
    expect(detail.latestRevisionId).not.toBe(first);
    expect((await qcRuns(taskId)).at(-1)).toMatchObject({ design_revision_id: detail.latestRevisionId, status: 'failed' });
    expect((await decide(app, taskId, detail.latestRevisionId, 'approved')).status).toBe(412);
  });
});
